const fs = require('fs');
const path = require('path');

const DB_VERSION = 2;
const DEFAULT_DB_RELATIVE_PATH = path.join('data', 'blw.sqlite');
const INTERVAL_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

let sqlModulePromise = null;
let dbState = null;
let writeQueue = Promise.resolve();

function dbFilePath(projectDir) {
  return path.join(projectDir, DEFAULT_DB_RELATIVE_PATH);
}

function nowMs() {
  return Date.now();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

async function loadSqlJs() {
  if (!sqlModulePromise) {
    sqlModulePromise = (async () => {
      let initSqlJs;
      try {
        initSqlJs = require('sql.js');
      } catch (error) {
        const message = 'sql.js がまだインストールされていません。DB Phase 1 を有効にするには npm install を実行してください。';
        const err = new Error(message);
        err.cause = error;
        throw err;
      }
      const baseDir = path.dirname(require.resolve('sql.js'));
      return initSqlJs({ locateFile: (file) => path.join(baseDir, file) });
    })();
  }
  return sqlModulePromise;
}

async function openDatabase(projectDir) {
  if (dbState && dbState.projectDir === projectDir) return dbState;
  const SQL = await loadSqlJs();
  const filePath = dbFilePath(projectDir);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  let db;
  if (fs.existsSync(filePath)) {
    const bytes = await fs.promises.readFile(filePath);
    db = new SQL.Database(bytes);
  } else {
    db = new SQL.Database();
  }
  dbState = { projectDir, filePath, db };
  ensureSchema(db);
  await persistDatabase(dbState);
  return dbState;
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA user_version = ${DB_VERSION};
    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      open_time_ms INTEGER NOT NULL,
      close_time_ms INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      is_closed INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      PRIMARY KEY (symbol, interval, open_time_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_candles_symbol_interval_time
      ON candles(symbol, interval, open_time_ms);

    CREATE TABLE IF NOT EXISTS fetch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      requested_start_ms INTEGER,
      requested_end_ms INTEGER,
      actual_start_ms INTEGER,
      actual_end_ms INTEGER,
      source TEXT NOT NULL,
      fetch_type TEXT NOT NULL,
      rows_fetched INTEGER NOT NULL DEFAULT 0,
      rows_inserted INTEGER NOT NULL DEFAULT 0,
      rows_updated INTEGER NOT NULL DEFAULT 0,
      rows_duplicated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      message TEXT,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS data_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      start_time_ms INTEGER NOT NULL,
      end_time_ms INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      expected_row_count INTEGER,
      missing_count INTEGER,
      include_unclosed_candle INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      file_names_json TEXT,
      quality_label TEXT,
      notes TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_data_references_purpose_symbol_time
      ON data_references(purpose, symbol, interval, start_time_ms, end_time_ms);

    CREATE TABLE IF NOT EXISTS daily_goal_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      strategy_template TEXT,
      target_profit_jpy REAL,
      capital_jpy REAL,
      expected_success_count INTEGER,
      take_profit_pct REAL,
      min_opportunities INTEGER,
      max_opportunities INTEGER,
      stop_loss_pct REAL,
      roundtrip_cost_pct REAL,
      cancel_rates_text TEXT,
      virtual_fill_rate_pct_manual REAL,
      virtual_fill_history_enabled INTEGER NOT NULL DEFAULT 1,
      virtual_fill_reference_days INTEGER,
      virtual_fill_side TEXT,
      limit_distance_pct REAL,
      occurrence_enabled INTEGER NOT NULL DEFAULT 1,
      occurrence_reference_days INTEGER,
      occurrence_window_minutes INTEGER,
      occurrence_direction TEXT,
      input_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_daily_goal_inputs_created
      ON daily_goal_inputs(created_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_goal_inputs_symbol_created
      ON daily_goal_inputs(symbol, created_at_ms DESC);

    CREATE TABLE IF NOT EXISTS daily_goal_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input_id INTEGER NOT NULL,
      calculated_at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      target_profit_jpy REAL,
      capital_jpy REAL,
      per_trade_target_jpy REAL,
      per_trade_required_move_pct REAL,
      take_profit_pct REAL,
      take_profit_net_per_trade_jpy REAL,
      required_success_count_by_take_profit INTEGER,
      virtual_fill_rate_pct_used REAL,
      virtual_fill_history_rate_pct REAL,
      required_move_occurrence_rate_pct REAL,
      required_move_occurrence_required_pct REAL,
      virtual_needed_win_rate_pct REAL,
      needed_win_premise_label TEXT,
      overall_label TEXT,
      diagnostic_summary TEXT,
      suggestion TEXT,
      result_json TEXT,
      virtual_fill_meta_json TEXT,
      occurrence_meta_json TEXT,
      FOREIGN KEY(input_id) REFERENCES daily_goal_inputs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_daily_goal_results_calculated
      ON daily_goal_results(calculated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_goal_results_symbol_calculated
      ON daily_goal_results(symbol, calculated_at_ms DESC);
  `);
}

async function persistDatabase(state) {
  const bytes = state.db.export();
  await fs.promises.mkdir(path.dirname(state.filePath), { recursive: true });
  await fs.promises.writeFile(state.filePath, Buffer.from(bytes));
}

function runSerialized(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function selectExistingOpenTimes(db, symbol, interval, minMs, maxMs) {
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return new Set();
  const result = db.exec(
    'SELECT open_time_ms FROM candles WHERE symbol = ? AND interval = ? AND open_time_ms BETWEEN ? AND ?',
    [symbol, interval, minMs, maxMs],
  );
  const values = result?.[0]?.values || [];
  return new Set(values.map((row) => Number(row[0])));
}

function normalizeCandleRow(row, fallback = {}) {
  const openTimeMs = safeNumber(row.open_time_ms ?? row.openTimeMs ?? row.open_time, NaN);
  const closeTimeMs = safeNumber(row.close_time_ms ?? row.closeTimeMs ?? row.close_time, openTimeMs + (INTERVAL_MS[fallback.interval] || 60 * 1000) - 1);
  const now = nowMs();
  return {
    symbol: safeText(row.symbol, fallback.symbol),
    interval: safeText(row.interval, fallback.interval || '1m'),
    open_time_ms: openTimeMs,
    close_time_ms: closeTimeMs,
    open: safeNumber(row.open, NaN),
    high: safeNumber(row.high, NaN),
    low: safeNumber(row.low, NaN),
    close: safeNumber(row.close, NaN),
    volume: safeNumber(row.volume, 0),
    is_closed: row.is_closed === false || row.is_closed === 0 ? 0 : 1,
    source: safeText(row.source, fallback.source || 'binance_public_kline'),
    fetched_at_ms: safeNumber(row.fetched_at_ms, now),
  };
}

function validCandle(row) {
  return row.symbol && row.interval
    && Number.isFinite(row.open_time_ms)
    && Number.isFinite(row.close_time_ms)
    && Number.isFinite(row.open)
    && Number.isFinite(row.high)
    && Number.isFinite(row.low)
    && Number.isFinite(row.close);
}

function expectedRowsForRange(interval, startMs, endMs, includeUnclosed = false) {
  const step = INTERVAL_MS[interval];
  if (!step || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const span = Math.max(0, endMs - startMs);
  const raw = Math.floor(span / step) + (includeUnclosed ? 1 : 0);
  return Math.max(0, raw);
}

function qualityLabel(rowCount, expectedCount, missingCount) {
  if (!Number.isFinite(expectedCount) || expectedCount <= 0) return rowCount > 0 ? 'unknown' : 'empty';
  if (rowCount <= 0) return 'empty';
  const missingRatio = Math.max(0, missingCount || 0) / expectedCount;
  if (missingRatio <= 0.01) return 'good';
  if (missingRatio <= 0.05) return 'minor_gaps';
  return 'gaps';
}

function insertFetchRun(db, run) {
  db.run(`
    INSERT INTO fetch_runs (
      symbol, interval, requested_start_ms, requested_end_ms, actual_start_ms, actual_end_ms,
      source, fetch_type, rows_fetched, rows_inserted, rows_updated, rows_duplicated,
      status, message, started_at_ms, finished_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    run.symbol,
    run.interval,
    run.requested_start_ms ?? null,
    run.requested_end_ms ?? null,
    run.actual_start_ms ?? null,
    run.actual_end_ms ?? null,
    run.source || 'binance_public_kline',
    run.fetch_type || 'unknown',
    run.rows_fetched || 0,
    run.rows_inserted || 0,
    run.rows_updated || 0,
    run.rows_duplicated || 0,
    run.status || 'ok',
    run.message || '',
    run.started_at_ms || nowMs(),
    run.finished_at_ms || nowMs(),
  ]);
  const idRow = db.exec('SELECT last_insert_rowid() AS id');
  return Number(idRow?.[0]?.values?.[0]?.[0] || 0);
}

function insertDataReference(db, ref) {
  db.run(`
    INSERT INTO data_references (
      purpose, symbol, interval, start_time_ms, end_time_ms, row_count, expected_row_count,
      missing_count, include_unclosed_candle, source, file_names_json, quality_label, notes, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    ref.purpose || 'debug_check',
    ref.symbol,
    ref.interval,
    ref.start_time_ms,
    ref.end_time_ms,
    ref.row_count || 0,
    ref.expected_row_count ?? null,
    ref.missing_count ?? null,
    ref.include_unclosed_candle ? 1 : 0,
    ref.source || 'candles',
    JSON.stringify(ref.file_names || []),
    ref.quality_label || null,
    ref.notes || '',
    ref.created_at_ms || nowMs(),
  ]);
  const idRow = db.exec('SELECT last_insert_rowid() AS id');
  return Number(idRow?.[0]?.values?.[0]?.[0] || 0);
}

async function saveKlineRows(projectDir, options = {}) {
  return runSerialized(async () => {
    const rows = Array.isArray(options.rows) ? options.rows : [];
    const normalizedRows = rows
      .map((row) => normalizeCandleRow(row, {
        symbol: options.symbol,
        interval: options.interval,
        source: options.source || 'binance_public_kline',
      }))
      .filter(validCandle)
      .sort((a, b) => a.open_time_ms - b.open_time_ms);

    const state = await openDatabase(projectDir);
    const { db } = state;
    const startedAtMs = options.started_at_ms || nowMs();
    const finishedAtMs = options.finished_at_ms || nowMs();
    const actualStartMs = normalizedRows.length ? normalizedRows[0].open_time_ms : null;
    const actualEndMs = normalizedRows.length ? normalizedRows[normalizedRows.length - 1].open_time_ms : null;
    const minMs = actualStartMs;
    const maxMs = actualEndMs;
    const existing = selectExistingOpenTimes(db, options.symbol, options.interval, minMs, maxMs);
    let inserted = 0;
    let updated = 0;

    db.run('BEGIN TRANSACTION');
    try {
      const stmt = db.prepare(`
        INSERT INTO candles (
          symbol, interval, open_time_ms, close_time_ms, open, high, low, close, volume,
          is_closed, source, fetched_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, interval, open_time_ms) DO UPDATE SET
          close_time_ms = excluded.close_time_ms,
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          volume = excluded.volume,
          is_closed = excluded.is_closed,
          source = excluded.source,
          fetched_at_ms = excluded.fetched_at_ms
      `);
      normalizedRows.forEach((row) => {
        if (existing.has(row.open_time_ms)) updated += 1;
        else inserted += 1;
        stmt.run([
          row.symbol,
          row.interval,
          row.open_time_ms,
          row.close_time_ms,
          row.open,
          row.high,
          row.low,
          row.close,
          row.volume,
          row.is_closed,
          row.source,
          row.fetched_at_ms,
        ]);
      });
      stmt.free();

      const fetchRunId = insertFetchRun(db, {
        symbol: options.symbol,
        interval: options.interval,
        requested_start_ms: options.requested_start_ms ?? null,
        requested_end_ms: options.requested_end_ms ?? null,
        actual_start_ms: actualStartMs,
        actual_end_ms: actualEndMs,
        source: options.source || 'binance_public_kline',
        fetch_type: options.fetch_type || 'incremental_update',
        rows_fetched: rows.length,
        rows_inserted: inserted,
        rows_updated: updated,
        rows_duplicated: updated,
        status: options.status || 'ok',
        message: options.message || '',
        started_at_ms: startedAtMs,
        finished_at_ms: finishedAtMs,
      });

      let dataReferenceId = null;
      if (normalizedRows.length) {
        const expected = expectedRowsForRange(
          options.interval,
          actualStartMs,
          actualEndMs,
          Boolean(options.include_unclosed_candle),
        );
        const missing = Number.isFinite(expected) ? Math.max(0, expected - normalizedRows.length) : null;
        dataReferenceId = insertDataReference(db, {
          purpose: options.purpose || 'fill_rate_calc',
          symbol: options.symbol,
          interval: options.interval,
          start_time_ms: actualStartMs,
          end_time_ms: actualEndMs,
          row_count: normalizedRows.length,
          expected_row_count: expected,
          missing_count: missing,
          include_unclosed_candle: Boolean(options.include_unclosed_candle),
          source: options.reference_source || 'candles',
          file_names: options.file_names || [],
          quality_label: qualityLabel(normalizedRows.length, expected, missing),
          notes: `fetch_run_id=${fetchRunId}`,
        });
      }
      db.run('COMMIT');
      await persistDatabase(state);
      return {
        ok: true,
        enabled: true,
        db_file: state.filePath,
        fetch_run_id: fetchRunId,
        data_reference_id: dataReferenceId,
        rows_received: rows.length,
        rows_valid: normalizedRows.length,
        rows_inserted: inserted,
        rows_updated: updated,
        rows_duplicated: updated,
      };
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      throw error;
    }
  }).catch((error) => ({
    ok: false,
    enabled: false,
    error: error.message,
    db_file: dbFilePath(projectDir),
    rows_received: Array.isArray(options.rows) ? options.rows.length : 0,
    rows_valid: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_duplicated: 0,
  }));
}

function firstScalar(db, sql, params = [], fallback = null) {
  const result = db.exec(sql, params);
  return result?.[0]?.values?.[0]?.[0] ?? fallback;
}

function tableCounts(db) {
  return {
    candles: Number(firstScalar(db, 'SELECT COUNT(*) FROM candles', [], 0)),
    fetch_runs: Number(firstScalar(db, 'SELECT COUNT(*) FROM fetch_runs', [], 0)),
    data_references: Number(firstScalar(db, 'SELECT COUNT(*) FROM data_references', [], 0)),
    daily_goal_inputs: Number(firstScalar(db, 'SELECT COUNT(*) FROM daily_goal_inputs', [], 0)),
    daily_goal_results: Number(firstScalar(db, 'SELECT COUNT(*) FROM daily_goal_results', [], 0)),
  };
}

function queryRows(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result?.length) return [];
  const columns = result[0].columns;
  return result[0].values.map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
}

function jsonText(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (error) {
    return JSON.stringify({ error: 'json_stringify_failed', message: error.message });
  }
}

function boolInt(value, fallback = true) {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  return value === false || value === 0 || value === 'false' ? 0 : 1;
}

function maxScenarioNumber(result, key) {
  const rows = Array.isArray(result?.scenarios) ? result.scenarios : [];
  const values = rows.map((row) => safeNumber(row?.[key], NaN)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function insertDailyGoalInput(db, input, createdAtMs) {
  const symbol = safeText(input.symbol, 'BTCJPY');
  db.run(`
    INSERT INTO daily_goal_inputs (
      created_at_ms, symbol, strategy_template, target_profit_jpy, capital_jpy,
      expected_success_count, take_profit_pct, min_opportunities, max_opportunities,
      stop_loss_pct, roundtrip_cost_pct, cancel_rates_text, virtual_fill_rate_pct_manual,
      virtual_fill_history_enabled, virtual_fill_reference_days, virtual_fill_side,
      limit_distance_pct, occurrence_enabled, occurrence_reference_days,
      occurrence_window_minutes, occurrence_direction, input_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    createdAtMs,
    symbol,
    safeText(input.strategy_template, ''),
    safeNumber(input.target_profit_jpy, 0),
    safeNumber(input.capital_jpy, 0),
    safeNumber(input.expected_success_count, 0),
    safeNumber(input.take_profit_pct, 0),
    safeNumber(input.min_opportunities, 0),
    safeNumber(input.max_opportunities, 0),
    safeNumber(input.stop_loss_pct, 0),
    safeNumber(input.roundtrip_cost_pct, 0),
    safeText(input.cancel_rates_text, ''),
    safeNumber(input.virtual_fill_rate_pct, 0),
    boolInt(input.virtual_fill_history_enabled, true),
    safeNumber(input.virtual_fill_reference_days, null),
    safeText(input.virtual_fill_side, ''),
    safeNumber(input.limit_distance_pct, 0),
    boolInt(input.virtual_fill_rate_auto, true),
    safeNumber(input.occurrence_reference_days, null),
    safeNumber(input.occurrence_window_minutes, null),
    safeText(input.occurrence_direction, ''),
    jsonText(input),
  ]);
  const idRow = db.exec('SELECT last_insert_rowid() AS id');
  return Number(idRow?.[0]?.values?.[0]?.[0] || 0);
}

function insertDailyGoalResult(db, inputId, input, result, calculatedAtMs) {
  const symbol = safeText(input.symbol || result?.required_move_occurrence_meta?.symbol || result?.virtual_fill_history_meta?.symbol, 'BTCJPY');
  const virtualFillHistoryRate = Number.isFinite(Number(result?.virtual_fill_history_rate_pct))
    ? safeNumber(result.virtual_fill_history_rate_pct)
    : null;
  const occurrenceRate = Number.isFinite(Number(result?.required_move_occurrence_rate_pct))
    ? safeNumber(result.required_move_occurrence_rate_pct)
    : null;
  const occurrenceRequired = Number.isFinite(Number(result?.required_move_occurrence_required_pct))
    ? safeNumber(result.required_move_occurrence_required_pct)
    : null;
  const winRate = Number.isFinite(Number(result?.virtual_needed_win_rate_pct))
    ? safeNumber(result.virtual_needed_win_rate_pct)
    : maxScenarioNumber(result, 'needed_win_rate_pct');
  db.run(`
    INSERT INTO daily_goal_results (
      input_id, calculated_at_ms, symbol, target_profit_jpy, capital_jpy,
      per_trade_target_jpy, per_trade_required_move_pct, take_profit_pct,
      take_profit_net_per_trade_jpy, required_success_count_by_take_profit,
      virtual_fill_rate_pct_used, virtual_fill_history_rate_pct,
      required_move_occurrence_rate_pct, required_move_occurrence_required_pct,
      virtual_needed_win_rate_pct, needed_win_premise_label, overall_label,
      diagnostic_summary, suggestion, result_json, virtual_fill_meta_json, occurrence_meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    inputId,
    calculatedAtMs,
    symbol,
    safeNumber(result?.target_profit_jpy ?? input.target_profit_jpy, 0),
    safeNumber(input.capital_jpy, 0),
    safeNumber(result?.per_trade_target_jpy, null),
    safeNumber(result?.per_trade_required_move_pct, null),
    safeNumber(result?.take_profit_pct ?? input.take_profit_pct, null),
    safeNumber(result?.take_profit_net_per_trade_jpy, null),
    safeNumber(result?.required_success_count_by_take_profit, null),
    safeNumber(result?.virtual_fill_rate_pct_used, null),
    virtualFillHistoryRate,
    occurrenceRate,
    occurrenceRequired,
    winRate,
    safeText(result?.needed_win_premise_label, ''),
    safeText(result?.overall_label, ''),
    safeText(result?.diagnostic_summary, ''),
    safeText(result?.suggestion, ''),
    jsonText(result),
    jsonText(result?.virtual_fill_history_meta || null),
    jsonText(result?.required_move_occurrence_meta || null),
  ]);
  const idRow = db.exec('SELECT last_insert_rowid() AS id');
  return Number(idRow?.[0]?.values?.[0]?.[0] || 0);
}

async function saveDailyGoalDiagnosis(projectDir, options = {}) {
  return runSerialized(async () => {
    try {
      const input = options.input || options.body || {};
      const result = options.result || {};
      const timestamp = safeNumber(options.created_at_ms ?? options.calculated_at_ms, nowMs());
      const state = await openDatabase(projectDir);
      const { db } = state;
      db.run('BEGIN TRANSACTION');
      try {
        const inputId = insertDailyGoalInput(db, input, timestamp);
        const resultId = insertDailyGoalResult(db, inputId, input, result, timestamp);
        db.run('COMMIT');
        await persistDatabase(state);
        return {
          ok: true,
          enabled: true,
          db_file: state.filePath,
          input_id: inputId,
          result_id: resultId,
          message: `DB Phase 2: 日次目標診断を保存しました（input ${inputId}, result ${resultId}）。`,
        };
      } catch (error) {
        try { db.run('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      return {
        ok: false,
        enabled: false,
        db_file: dbFilePath(projectDir),
        input_id: null,
        result_id: null,
        error: error.message,
        message: `DB Phase 2: 日次目標診断を保存できませんでした。${error.message}`,
      };
    }
  });
}

async function getDailyGoalDiagnosisLogs(projectDir, options = {}) {
  try {
    const state = await openDatabase(projectDir);
    const { db } = state;
    const limit = Math.max(1, Math.min(300, safeNumber(options.limit, 20)));
    const rows = queryRows(db, `
      SELECT
        r.id AS result_id,
        r.input_id,
        r.calculated_at_ms,
        r.symbol,
        r.target_profit_jpy,
        r.capital_jpy,
        r.per_trade_target_jpy,
        r.per_trade_required_move_pct,
        r.take_profit_pct,
        r.take_profit_net_per_trade_jpy,
        r.required_success_count_by_take_profit,
        r.virtual_fill_rate_pct_used,
        r.virtual_fill_history_rate_pct,
        r.required_move_occurrence_rate_pct,
        r.required_move_occurrence_required_pct,
        r.virtual_needed_win_rate_pct,
        r.needed_win_premise_label,
        r.overall_label,
        i.strategy_template,
        i.expected_success_count,
        i.occurrence_reference_days,
        i.occurrence_window_minutes,
        i.virtual_fill_reference_days
      FROM daily_goal_results r
      LEFT JOIN daily_goal_inputs i ON i.id = r.input_id
      ORDER BY r.id DESC
      LIMIT ?
    `, [limit]);
    return {
      ok: true,
      enabled: true,
      db_file: state.filePath,
      count: Number(firstScalar(db, 'SELECT COUNT(*) FROM daily_goal_results', [], 0)),
      rows,
      limit,
      message: 'DB Phase 2 の日次目標診断ログを取得しました。',
    };
  } catch (error) {
    return {
      ok: false,
      enabled: false,
      db_file: dbFilePath(projectDir),
      count: 0,
      rows: [],
      limit: Math.max(1, Math.min(300, safeNumber(options.limit, 20))),
      error: error.message,
      message: error.message,
    };
  }
}

async function clearDailyGoalDiagnosisLogs(projectDir) {
  return runSerialized(async () => {
    try {
      const state = await openDatabase(projectDir);
      const { db } = state;
      db.run('BEGIN TRANSACTION');
      try {
        db.run('DELETE FROM daily_goal_results');
        db.run('DELETE FROM daily_goal_inputs');
        db.run('COMMIT');
        await persistDatabase(state);
        return { ok: true, enabled: true, db_file: state.filePath, message: 'DB Phase 2 の日次目標診断ログをクリアしました。' };
      } catch (error) {
        try { db.run('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      return { ok: false, enabled: false, db_file: dbFilePath(projectDir), error: error.message, message: error.message };
    }
  });
}

async function getDbStatus(projectDir) {
  try {
    const state = await openDatabase(projectDir);
    const { db } = state;
    const counts = tableCounts(db);
    const latestCandles = queryRows(db, `
      SELECT symbol, interval, COUNT(*) AS rows, MIN(open_time_ms) AS start_time_ms, MAX(open_time_ms) AS end_time_ms
      FROM candles
      GROUP BY symbol, interval
      ORDER BY symbol, interval
    `);
    const latestFetchRuns = queryRows(db, `
      SELECT id, symbol, interval, fetch_type, rows_fetched, rows_inserted, rows_updated, status, message, started_at_ms, finished_at_ms
      FROM fetch_runs
      ORDER BY id DESC
      LIMIT 5
    `);
    const latestReferences = queryRows(db, `
      SELECT id, purpose, symbol, interval, row_count, expected_row_count, missing_count, quality_label, created_at_ms
      FROM data_references
      ORDER BY id DESC
      LIMIT 5
    `);
    const latestDailyGoalResults = queryRows(db, `
      SELECT id, input_id, calculated_at_ms, symbol, target_profit_jpy, capital_jpy,
             per_trade_required_move_pct, virtual_fill_rate_pct_used,
             required_move_occurrence_rate_pct, virtual_needed_win_rate_pct,
             needed_win_premise_label, overall_label
      FROM daily_goal_results
      ORDER BY id DESC
      LIMIT 5
    `);
    return {
      ok: true,
      enabled: true,
      db_file: state.filePath,
      schema_version: DB_VERSION,
      counts,
      latest_candles: latestCandles,
      latest_fetch_runs: latestFetchRuns,
      latest_references: latestReferences,
      latest_daily_goal_results: latestDailyGoalResults,
      message: 'DB Phase 2 は有効です。candles / fetch_runs / data_references / daily_goal_inputs / daily_goal_results を使えます。',
    };
  } catch (error) {
    return {
      ok: false,
      enabled: false,
      db_file: dbFilePath(projectDir),
      schema_version: DB_VERSION,
      counts: { candles: 0, fetch_runs: 0, data_references: 0, daily_goal_inputs: 0, daily_goal_results: 0 },
      latest_candles: [],
      latest_fetch_runs: [],
      latest_references: [],
      latest_daily_goal_results: [],
      message: error.message,
    };
  }
}


function expectedRowsForExclusiveRange(interval, startMs, endMs) {
  const step = INTERVAL_MS[interval];
  if (!step || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / step));
}

async function getCandleRangeStatus(projectDir, options = {}) {
  try {
    const state = await openDatabase(projectDir);
    const { db } = state;
    const symbol = safeText(options.symbol, 'BTCJPY');
    const interval = safeText(options.interval, '1m');
    const startMs = safeNumber(options.start_time_ms ?? options.start_ms, NaN);
    const endMs = safeNumber(options.end_time_ms ?? options.end_ms, NaN);
    const includeUnclosed = Boolean(options.include_unclosed_candle);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error('有効な参照期間が指定されていません。');
    }
    const closedClause = includeUnclosed ? '' : ' AND is_closed = 1';
    const rows = queryRows(db, `
      SELECT COUNT(*) AS row_count, MIN(open_time_ms) AS start_time_ms, MAX(open_time_ms) AS end_time_ms
      FROM candles
      WHERE symbol = ? AND interval = ? AND open_time_ms >= ? AND open_time_ms < ?${closedClause}
    `, [symbol, interval, startMs, endMs]);
    const row = rows[0] || {};
    const expected = expectedRowsForExclusiveRange(interval, startMs, endMs);
    const rowCount = Number(row.row_count || 0);
    const missing = Math.max(0, expected - rowCount);
    const q = qualityLabel(rowCount, expected, missing);
    return {
      ok: true,
      enabled: true,
      db_file: state.filePath,
      symbol,
      interval,
      start_time_ms: startMs,
      end_time_ms: endMs,
      actual_start_time_ms: Number(row.start_time_ms || 0) || null,
      actual_end_time_ms: Number(row.end_time_ms || 0) || null,
      row_count: rowCount,
      expected_row_count: expected,
      missing_count: missing,
      coverage_rate: expected > 0 ? rowCount / expected : (rowCount > 0 ? 1 : 0),
      quality_label: q,
      enough: expected > 0 ? rowCount / expected >= 0.95 : rowCount > 0,
      include_unclosed_candle: includeUnclosed,
      source: 'sqlite_candles',
    };
  } catch (error) {
    return {
      ok: false,
      enabled: false,
      db_file: dbFilePath(projectDir),
      error: error.message,
      symbol: options.symbol || 'BTCJPY',
      interval: options.interval || '1m',
      row_count: 0,
      expected_row_count: 0,
      missing_count: 0,
      coverage_rate: 0,
      quality_label: 'disabled',
      enough: false,
      source: 'sqlite_disabled',
    };
  }
}


async function getCandleRows(projectDir, options = {}) {
  try {
    const state = await openDatabase(projectDir);
    const { db } = state;
    const symbol = safeText(options.symbol, 'BTCJPY');
    const interval = safeText(options.interval, '1m');
    const startMs = safeNumber(options.start_time_ms ?? options.start_ms, NaN);
    const endMs = safeNumber(options.end_time_ms ?? options.end_ms, NaN);
    const includeUnclosed = Boolean(options.include_unclosed_candle);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error('有効な参照期間が指定されていません。');
    }
    const closedClause = includeUnclosed ? '' : ' AND is_closed = 1';
    const rows = queryRows(db, `
      SELECT symbol, interval, open_time_ms, close_time_ms, open, high, low, close, volume, is_closed, source, fetched_at_ms
      FROM candles
      WHERE symbol = ? AND interval = ? AND open_time_ms >= ? AND open_time_ms < ?${closedClause}
      ORDER BY open_time_ms ASC
    `, [symbol, interval, startMs, endMs]);
    return {
      ok: true,
      enabled: true,
      db_file: state.filePath,
      symbol,
      interval,
      row_count: rows.length,
      rows,
      source: 'sqlite_candles',
    };
  } catch (error) {
    return {
      ok: false,
      enabled: false,
      db_file: dbFilePath(projectDir),
      error: error.message,
      rows: [],
      row_count: 0,
      source: 'sqlite_disabled',
    };
  }
}

async function pruneCandles(projectDir, options = {}) {
  return runSerialized(async () => {
    try {
      const state = await openDatabase(projectDir);
      const { db } = state;
      const symbol = options.symbol ? safeText(options.symbol) : null;
      const interval = options.interval ? safeText(options.interval) : null;
      const beforeMs = safeNumber(options.before_time_ms ?? options.before_ms, NaN);
      if (!Number.isFinite(beforeMs)) throw new Error('削除基準時刻が不正です。');
      const params = [];
      let where = 'open_time_ms < ?';
      params.push(beforeMs);
      if (symbol) { where += ' AND symbol = ?'; params.push(symbol); }
      if (interval) { where += ' AND interval = ?'; params.push(interval); }
      const before = Number(firstScalar(db, `SELECT COUNT(*) FROM candles WHERE ${where}`, params, 0));
      db.run(`DELETE FROM candles WHERE ${where}`, params);
      await persistDatabase(state);
      return { ok: true, enabled: true, deleted_rows: before, before_time_ms: beforeMs, db_file: state.filePath };
    } catch (error) {
      return { ok: false, enabled: false, deleted_rows: 0, error: error.message, db_file: dbFilePath(projectDir) };
    }
  });
}

module.exports = {
  DB_VERSION,
  dbFilePath,
  ensureSchema,
  saveKlineRows,
  getDbStatus,
  getCandleRangeStatus,
  getCandleRows,
  pruneCandles,
  saveDailyGoalDiagnosis,
  getDailyGoalDiagnosisLogs,
  clearDailyGoalDiagnosisLogs,
};
