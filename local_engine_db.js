const fs = require('fs');
const path = require('path');

const DB_VERSION = 1;
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
  };
}

function queryRows(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result?.length) return [];
  const columns = result[0].columns;
  return result[0].values.map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
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
    return {
      ok: true,
      enabled: true,
      db_file: state.filePath,
      schema_version: DB_VERSION,
      counts,
      latest_candles: latestCandles,
      latest_fetch_runs: latestFetchRuns,
      latest_references: latestReferences,
      message: 'DB Phase 1 は有効です。candles / fetch_runs / data_references を使えます。',
    };
  } catch (error) {
    return {
      ok: false,
      enabled: false,
      db_file: dbFilePath(projectDir),
      schema_version: DB_VERSION,
      counts: { candles: 0, fetch_runs: 0, data_references: 0 },
      latest_candles: [],
      latest_fetch_runs: [],
      latest_references: [],
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
};
