const fs = require('fs');
const path = require('path');
const https = require('https');
const calculations = require('./local_engine_calculations');

const VERSION = 'electron-node-engine-v0.4';
const SYMBOLS = ['BTCJPY', 'ETHJPY'];
const HISTORY_COLUMNS = ['timestamp', 'symbol', 'price_jpy'];
const LONG_DATA_COLUMNS = [
  'open_time_jst',
  'open_time_ms',
  'symbol',
  'interval',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'close_time_jst',
  'close_time_ms',
];
const BINANCE_BASE_URL = 'https://api.binance.com';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const MOCK_PRICES = {
  BTCJPY: { price: 15600000.0, prev: 15520000.0, short_base: 15480000.0 },
  ETHJPY: { price: 585000.0, prev: 582000.0, short_base: 578000.0 },
};

const API_BOUNDARY = {
  ui: 'Electron renderer handles display, input, and navigation only.',
  backend: 'Electron main process handles public market-data fetches, local CSV history, chart data, and local calculations.',
  forbidden: ['real_order', 'auto_trading', 'withdrawal', 'api_key_storage', 'secret_storage'],
  secrets: 'No API key or secret is accepted, requested, written, or persisted by this app.',
};

function projectDir() {
  return path.resolve(process.env.BLW_PROJECT_DIR || __dirname);
}

function contractFilePath() {
  return path.join(projectDir(), 'API_CONTRACT.json');
}

function historyFilePath() {
  return path.join(projectDir(), 'price_history.csv');
}

function longDataDir() {
  return path.join(projectDir(), 'long_data');
}

function alertHistoryFilePath() {
  return path.join(projectDir(), 'alert_history.json');
}

function dailyGoalReportFilePath() {
  return path.join(projectDir(), 'daily_goal_reports.csv');
}

function envFilePath() {
  return path.join(projectDir(), '.env');
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function toCsvValue(value) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function safeFloat(value, fallback = 0) {
  return calculations.safeFloat(value, fallback);
}

function safeInt(value, fallback = 0) {
  return calculations.safeInt(value, fallback);
}

function parseTimestamp(text) {
  if (!text) return null;
  const normalized = String(text).replace(' JST', '+09:00');
  const dt = new Date(normalized);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatJst(date, mode = 'full') {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const yyyy = jst.getUTCFullYear();
  const mm = pad2(jst.getUTCMonth() + 1);
  const dd = pad2(jst.getUTCDate());
  const hh = pad2(jst.getUTCHours());
  const mi = pad2(jst.getUTCMinutes());
  const ss = pad2(jst.getUTCSeconds());
  if (mode === 'time') return `${hh}:${mi}`;
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} JST`;
}

function nowJstIso() {
  const now = new Date();
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return `${jst.toISOString().slice(0, 19)}+09:00`;
}

function parseJstDateTime(dateText, hour = 0, minute = 0) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('date must be YYYY-MM-DD');
  const [, yyyy, mm, dd] = match;
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hour) - 9, Number(minute), 0, 0));
}

function compactDateLabel(dateText) {
  return String(dateText || '').replace(/-/g, '');
}

function hourLabel(hour) {
  return String(hour).padStart(2, '0');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSimpleEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  const text = fs.readFileSync(filePath, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) return;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, '');
    result[key] = value;
  });
  return result;
}

function fetchJson(apiPath, params = {}, timeoutMs = 10000) {
  const url = new URL(apiPath, BINANCE_BASE_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'BinanceLocalWatcherElectronNodeEngine/0.3' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`${res.statusCode} ${res.statusMessage}`);
          error.statusCode = res.statusCode;
          error.usedWeight = res.headers['x-mbx-used-weight-1m'] || '';
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

async function fetchJsonWithRetry(apiPath, params = {}, timeoutMs = 15000, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJson(apiPath, params, timeoutMs);
    } catch (error) {
      lastError = error;
      if (![418, 429].includes(error.statusCode) || attempt >= retries) break;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function readHistoryRows() {
  const filePath = historyFilePath();
  if (!fs.existsSync(filePath)) return { rows: [], source: 'mock' };
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return { rows: [], source: filePath };
    const headers = parseCsvLine(lines[0]);
    const rows = [];
    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      const symbol = String(row.symbol || '').trim();
      const price = safeFloat(row.price_jpy, NaN);
      const timestamp = parseTimestamp(row.timestamp);
      if (!SYMBOLS.includes(symbol) || !Number.isFinite(price) || !timestamp) continue;
      rows.push({ symbol, price, timestamp, timestamp_text: row.timestamp });
    }
    return { rows, source: filePath };
  } catch {
    return { rows: [], source: 'mock' };
  }
}

async function appendHistoryRows(newRows) {
  const filePath = historyFilePath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const existingKeys = new Set();
  if (fs.existsSync(filePath)) {
    const { rows } = await readHistoryRows();
    rows.forEach((row) => existingKeys.add(`${row.timestamp_text}|${row.symbol}`));
  }
  const exists = fs.existsSync(filePath);
  const lines = [];
  if (!exists || fs.statSync(filePath).size === 0) lines.push(HISTORY_COLUMNS.join(','));
  let added = 0;
  for (const row of newRows) {
    const key = `${row.timestamp}|${row.symbol}`;
    if (existingKeys.has(key)) continue;
    lines.push(HISTORY_COLUMNS.map((column) => toCsvValue(row[column])).join(','));
    existingKeys.add(key);
    added += 1;
  }
  if (lines.length) await fs.promises.appendFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return { added, path: filePath };
}

async function loadHistorySummary() {
  const { rows, source } = await readHistoryRows();
  if (!rows.length) return { result: null, source: 'mock' };
  const result = {};
  for (const symbol of SYMBOLS) {
    const symbolRows = rows.filter((row) => row.symbol === symbol).sort((a, b) => a.timestamp - b.timestamp);
    if (!symbolRows.length) continue;
    const latest = symbolRows[symbolRows.length - 1];
    const prev = symbolRows.length >= 2 ? symbolRows[symbolRows.length - 2] : latest;
    const shortBase = symbolRows.length >= 10 ? symbolRows[symbolRows.length - 10] : symbolRows[0];
    result[symbol] = {
      price: latest.price,
      prev: prev.price,
      short_base: shortBase.price,
      timestamp: formatJst(latest.timestamp),
    };
  }
  return { result: Object.keys(result).length ? result : null, source };
}

async function currentPriceData() {
  const { result, source } = await loadHistorySummary();
  const data = result || MOCK_PRICES;
  const symbols = calculations.buildSymbolSummaries({
    symbols: SYMBOLS,
    sourceData: data,
    mockPrices: MOCK_PRICES,
  });
  return { symbols, source };
}

async function localChartPoints(symbol, limit = 160) {
  const { rows, source } = await readHistoryRows();
  const points = rows
    .filter((row) => row.symbol === symbol)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit)
    .map((row) => ({
      timestamp: formatJst(row.timestamp, 'time'),
      timestamp_full: formatJst(row.timestamp),
      price: row.price,
      time_ms: row.timestamp.getTime(),
      source: 'local-history',
    }));
  return { points, source };
}

async function fetchKlinesForChart(symbol, interval = '1m', limit = 120) {
  const data = await fetchJson('/api/v3/klines', { symbol, interval, limit }, 15000);
  return data.map((item) => {
    const date = new Date(Number(item[0]));
    return {
      timestamp: formatJst(date, 'time'),
      timestamp_full: formatJst(date),
      price: safeFloat(item[4]),
      time_ms: Number(item[0]),
      source: 'binance-klines',
    };
  });
}

function normalizeDownloadRequest(body = {}) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : 'BTCJPY';
  const interval = ['1m', '5m', '15m', '1h'].includes(body.interval) ? body.interval : '1m';
  const date = String(body.date || '').trim();
  const startHour = Math.max(0, Math.min(23, safeInt(body.start_hour, 0)));
  const rawEndHour = body.end_hour === undefined || body.end_hour === null || body.end_hour === ''
    ? 24
    : safeInt(body.end_hour, 24);
  const endHour = Math.max(startHour + 1, Math.min(24, rawEndHour));
  const waitMs = Math.max(0, Math.min(5000, safeInt(body.wait_ms, 450)));
  const skipExisting = body.skip_existing !== false;
  return { symbol, interval, date, startHour, endHour, waitMs, skipExisting };
}

function buildKlineDownloadPlan(body = {}) {
  const request = normalizeDownloadRequest(body);
  if (!request.date) throw new Error('date is required');
  const dateLabel = compactDateLabel(request.date);
  const chunks = [];
  for (let hour = request.startHour; hour < request.endHour; hour += 1) {
    const start = parseJstDateTime(request.date, hour, 0);
    const end = hour === 23
      ? parseJstDateTime(request.date, 0, 0).getTime() + 24 * 60 * 60 * 1000
      : parseJstDateTime(request.date, hour + 1, 0).getTime();
    const fromLabel = `${hourLabel(hour)}00`;
    const toLabel = `${hourLabel(hour + 1)}00`;
    chunks.push({
      symbol: request.symbol,
      interval: request.interval,
      start_ms: start.getTime(),
      end_ms: end,
      label: `${fromLabel}_${toLabel}`,
      file: path.join(longDataDir(), `binance_${request.symbol}_${request.interval}_${dateLabel}_${fromLabel}_${toLabel}_JST.csv`),
    });
  }
  return {
    ...request,
    dateLabel,
    chunks,
    merged_file: path.join(longDataDir(), `binance_${request.symbol}_${request.interval}_${dateLabel}_${hourLabel(request.startHour)}00_${hourLabel(request.endHour)}00_merged_JST.csv`),
  };
}

function mapKlineRows(items, symbol, interval) {
  return items.map((item) => {
    const openTime = new Date(Number(item[0]));
    const closeTime = new Date(Number(item[6]));
    return {
      open_time_jst: formatJst(openTime),
      open_time_ms: Number(item[0]),
      symbol,
      interval,
      open: safeFloat(item[1]),
      high: safeFloat(item[2]),
      low: safeFloat(item[3]),
      close: safeFloat(item[4]),
      volume: safeFloat(item[5]),
      close_time_jst: formatJst(closeTime),
      close_time_ms: Number(item[6]),
    };
  });
}

async function writeCsvRows(filePath, columns, rows) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const lines = [columns.join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((column) => toCsvValue(row[column])).join(','));
  });
  await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function readLongDataRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = await fs.promises.readFile(filePath, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

async function readAlertHistory() {
  const filePath = alertHistoryFilePath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeAlertHistory(items) {
  const filePath = alertHistoryFilePath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(items, null, 2), 'utf8');
}

async function downloadedChartPoints(params = {}) {
  const plan = buildKlineDownloadPlan(params);
  const files = fs.existsSync(plan.merged_file)
    ? [plan.merged_file]
    : plan.chunks.map((chunk) => chunk.file).filter((file) => fs.existsSync(file));
  const byOpenTime = new Map();
  for (const file of files) {
    const rows = await readLongDataRows(file);
    rows.forEach((row) => {
      if (row.symbol !== plan.symbol || row.interval !== plan.interval) return;
      const timeMs = safeFloat(row.open_time_ms, NaN);
      const price = safeFloat(row.close, NaN);
      if (!Number.isFinite(timeMs) || !Number.isFinite(price)) return;
      if (timeMs < plan.chunks[0].start_ms || timeMs >= plan.chunks[plan.chunks.length - 1].end_ms) return;
      byOpenTime.set(timeMs, {
        timestamp: formatJst(new Date(timeMs), 'time'),
        timestamp_full: row.open_time_jst || formatJst(new Date(timeMs)),
        price,
        time_ms: timeMs,
        source: 'downloaded-kline',
      });
    });
  }
  return {
    points: Array.from(byOpenTime.values()).sort((a, b) => a.time_ms - b.time_ms),
    source: files.length ? files.join('; ') : plan.merged_file,
    planned_file: plan.merged_file,
  };
}

async function downloadedKlineRows(params = {}) {
  const plan = buildKlineDownloadPlan(params);
  const files = fs.existsSync(plan.merged_file)
    ? [plan.merged_file]
    : plan.chunks.map((chunk) => chunk.file).filter((file) => fs.existsSync(file));
  const rowsByTime = new Map();
  for (const file of files) {
    const rows = await readLongDataRows(file);
    rows.forEach((row) => {
      if (row.symbol !== plan.symbol || row.interval !== plan.interval) return;
      const timeMs = safeFloat(row.open_time_ms, NaN);
      if (!Number.isFinite(timeMs)) return;
      if (timeMs < plan.chunks[0].start_ms || timeMs >= plan.chunks[plan.chunks.length - 1].end_ms) return;
      rowsByTime.set(timeMs, row);
    });
  }
  return {
    rows: Array.from(rowsByTime.values()).sort((a, b) => safeFloat(a.open_time_ms) - safeFloat(b.open_time_ms)),
    files,
    plan,
  };
}

async function estimateVirtualFillRate(body = {}) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : 'BTCJPY';
  const interval = ['1m', '5m', '15m', '1h'].includes(body.interval) ? body.interval : '1m';
  const date = String(body.date || '').trim();
  if (!date) {
    return { rate: null, note: '仮想約定率の自動推定: 日付が未指定のため手入力値を使います。' };
  }
  try {
    const target = Math.max(0, safeFloat(body.target_profit_jpy));
    const capital = Math.max(1, safeFloat(body.capital_jpy, 1));
    const maxOpp = Math.max(1, safeInt(body.max_opportunities, 1));
    const costPct = Math.max(0, safeFloat(body.roundtrip_cost_pct, 0.28));
    const requiredMovePct = (target / capital / maxOpp) * 100 + costPct;
    const { rows, files } = await downloadedKlineRows({
      symbol,
      interval,
      date,
      start_hour: body.start_hour,
      end_hour: body.end_hour,
    });
    if (rows.length < 10) {
      return { rate: null, note: '仮想約定率の自動推定: DL済み履歴が不足しているため手入力値を使います。' };
    }
    let fillable = 0;
    rows.forEach((row) => {
      const open = safeFloat(row.open, NaN);
      const high = safeFloat(row.high, NaN);
      const low = safeFloat(row.low, NaN);
      if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || open <= 0) return;
      const rangePct = ((high - low) / open) * 100;
      if (rangePct >= requiredMovePct) fillable += 1;
    });
    const rawRate = rows.length ? (fillable / rows.length) * 100 : 0;
    const rate = Math.max(5, Math.min(95, rawRate));
    return {
      rate,
      note: `仮想約定率の自動推定: ${date} ${interval} 足 ${rows.length}本（${files.length}ファイル）から、必要変動率 ${requiredMovePct.toFixed(3)}% を満たす足の割合を使い ${rate.toFixed(1)}% としました。`,
    };
  } catch (error) {
    return { rate: null, note: `仮想約定率の自動推定: ${error.message} のため手入力値を使います。` };
  }
}

function combineChartPoints(downloadedPoints, localPoints, limit) {
  const byTime = new Map();
  downloadedPoints.forEach((point) => byTime.set(point.time_ms, point));
  localPoints.forEach((point) => byTime.set(point.time_ms, point));
  return Array.from(byTime.values())
    .filter((point) => Number.isFinite(point.time_ms) && Number.isFinite(Number(point.price)))
    .sort((a, b) => a.time_ms - b.time_ms)
    .slice(-limit);
}

async function mergeLongDataChunks(plan) {
  const byOpenTime = new Map();
  for (const chunk of plan.chunks) {
    const rows = await readLongDataRows(chunk.file);
    rows.forEach((row) => {
      const key = `${row.symbol}|${row.interval}|${row.open_time_ms}`;
      byOpenTime.set(key, row);
    });
  }
  const mergedRows = Array.from(byOpenTime.values()).sort((a, b) => safeFloat(a.open_time_ms) - safeFloat(b.open_time_ms));
  await writeCsvRows(plan.merged_file, LONG_DATA_COLUMNS, mergedRows);
  return mergedRows.length;
}

async function downloadHistoricalKlines(body = {}) {
  const plan = buildKlineDownloadPlan(body);
  if (body.dry_run) {
    return {
      ok: true,
      dry_run: true,
      symbol: plan.symbol,
      interval: plan.interval,
      date: plan.date,
      chunks: plan.chunks.map((chunk) => ({ label: chunk.label, file: chunk.file })),
      merged_file: plan.merged_file,
      message: `${plan.chunks.length}個の1時間チャンクで取得します。`,
    };
  }

  const results = [];
  const errors = [];
  for (const chunk of plan.chunks) {
    if (plan.skipExisting && fs.existsSync(chunk.file)) {
      const existingRows = await readLongDataRows(chunk.file);
      results.push({ label: chunk.label, status: 'skipped', rows: existingRows.length, file: chunk.file });
      continue;
    }
    try {
      const items = await fetchJsonWithRetry('/api/v3/klines', {
        symbol: chunk.symbol,
        interval: chunk.interval,
        startTime: chunk.start_ms,
        endTime: chunk.end_ms - 1,
        limit: 1000,
      }, 15000, 2);
      const rows = mapKlineRows(items, chunk.symbol, chunk.interval);
      await writeCsvRows(chunk.file, LONG_DATA_COLUMNS, rows);
      results.push({ label: chunk.label, status: 'downloaded', rows: rows.length, file: chunk.file });
      await sleep(plan.waitMs);
    } catch (error) {
      errors.push({ label: chunk.label, error: error.message, file: chunk.file });
    }
  }
  const mergedRows = await mergeLongDataChunks(plan);
  return {
    ok: errors.length === 0,
    dry_run: false,
    symbol: plan.symbol,
    interval: plan.interval,
    date: plan.date,
    start_hour: plan.startHour,
    end_hour: plan.endHour,
    chunks: results,
    errors,
    merged_file: plan.merged_file,
    merged_rows: mergedRows,
    message: `履歴DL完了: ${results.length}チャンク / merged ${mergedRows}行${errors.length ? ` / エラー ${errors.length}件` : ''}`,
  };
}

async function fetchAllPrices() {
  const timestamp = nowJstIso();
  const rows = [];
  const errors = [];
  for (const symbol of SYMBOLS) {
    try {
      const data = await fetchJson('/api/v3/ticker/price', { symbol }, 10000);
      rows.push({ timestamp, symbol, price_jpy: safeFloat(data.price) });
    } catch (error) {
      errors.push(`${symbol}: ${error.message}`);
    }
  }
  return { rows, errors };
}

async function status() {
  const { source } = await currentPriceData();
  const { rows } = await readHistoryRows();
  return {
    ok: true,
    version: VERSION,
    mode: 'electron-ui + electron-main-node-engine',
    project_dir: projectDir(),
    history_file: historyFilePath(),
    history_rows: rows.length,
    data_source: source,
    api_boundary: API_BOUNDARY,
    calculation_engine: 'local_engine_calculations.js',
  };
}

async function capabilities() {
  return {
    ok: true,
    version: VERSION,
    symbols: SYMBOLS,
    routes: {
      GET: ['status', 'capabilities', 'summary', 'impact', 'alert-preview', 'alert-history', 'daily-goal-reports', 'chart', 'contract', 'api-readiness'],
      POST: ['fetch-prices', 'download-history', 'trade-preview', 'daily-goal', 'save-daily-goal-report', 'clear-alert-history', 'clear-daily-goal-reports'],
    },
    api_boundary: API_BOUNDARY,
    calculation_engine: {
      module: 'local_engine_calculations.js',
      style: 'pure functions called from Electron main process',
      io_owner: 'local_engine.js',
    },
  };
}

async function contract() {
  const filePath = contractFilePath();
  if (!fs.existsSync(filePath)) {
    return {
      version: VERSION,
      mode: 'electron-ui + electron-main-node-engine',
      forbidden: API_BOUNDARY.forbidden,
      routes: {
        GET: ['status', 'capabilities', 'summary', 'impact', 'alert-preview', 'alert-history', 'daily-goal-reports', 'chart', 'api-readiness'],
        POST: ['fetch-prices', 'download-history', 'trade-preview', 'daily-goal', 'save-daily-goal-report', 'clear-alert-history', 'clear-daily-goal-reports'],
      },
      note: 'API_CONTRACT.json が未配置のため簡易情報を返しています。',
    };
  }
  const text = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

async function summary() {
  const { symbols, source } = await currentPriceData();
  const memo = source === 'mock'
    ? 'price_history.csv が見つからないため、サンプル価格で表示しています。「現在価格を取得して保存」を押すと公開APIから価格を取得して履歴CSVへ保存します。'
    : `price_history.csv から最新価格を読みました。データ元: ${source}`;
  return { symbols, data_source: source, memo };
}

async function apiReadiness() {
  const envFileValues = parseSimpleEnvFile(envFilePath());
  const envApiKey = String(process.env.BINANCE_API_KEY || '').trim();
  const envApiSecret = String(process.env.BINANCE_API_SECRET || '').trim();
  const fileApiKey = String(envFileValues.BINANCE_API_KEY || '').trim();
  const fileApiSecret = String(envFileValues.BINANCE_API_SECRET || '').trim();
  const hasApiKey = Boolean(envApiKey || fileApiKey);
  const hasApiSecret = Boolean(envApiSecret || fileApiSecret);
  const keySource = envApiKey ? 'environment' : fileApiKey ? '.env' : 'none';
  const secretSource = envApiSecret ? 'environment' : fileApiSecret ? '.env' : 'none';
  let publicApiOk = false;
  let publicApiError = '';
  try {
    await fetchJson('/api/v3/time', {}, 8000);
    publicApiOk = true;
  } catch (error) {
    publicApiError = error.message;
  }
  return {
    has_api_key: hasApiKey,
    has_api_secret: hasApiSecret,
    api_key_source: keySource,
    api_secret_source: secretSource,
    public_api_ok: publicApiOk,
    public_api_error: publicApiError,
    fee_fetch_ready: Boolean(publicApiOk && hasApiKey && hasApiSecret),
    note: '読み取り専用の最小チェックです。キー保存は行いません。',
  };
}

async function impact(params = {}) {
  const { symbols } = await currentPriceData();
  return { rows: calculations.calculateImpactRows({ summaries: symbols, amountsText: params.amounts }) };
}

async function alertPreview(params = {}) {
  const windowMinutes = Math.max(1, Math.min(240, safeInt(params.window_minutes, 15)));
  const alertMode = String(params.alert_mode || 'simple').trim().toLowerCase() === 'rolling' ? 'rolling' : 'simple';
  const rollingMinPoints = Math.max(2, Math.min(20, safeInt(params.rolling_min_points, 3)));
  const thresholdPct = Math.max(0, safeFloat(params.threshold_pct, 0.2));
  const thresholdsText = String(params.thresholds || '').trim();
  const thresholdsBySymbol = {};
  if (thresholdsText) {
    thresholdsText.split(',').forEach((part) => {
      const [symbolText, thresholdText] = String(part).split(':').map((v) => String(v || '').trim());
      if (!SYMBOLS.includes(symbolText)) return;
      const value = safeFloat(thresholdText, NaN);
      if (!Number.isFinite(value) || value < 0) return;
      thresholdsBySymbol[symbolText] = value;
    });
  }
  const selectedSymbols = Array.isArray(params.symbols)
    ? params.symbols
    : String(params.symbols || '').split(',').map((v) => String(v).trim()).filter(Boolean);
  const targetSymbols = selectedSymbols.length
    ? SYMBOLS.filter((symbol) => selectedSymbols.includes(symbol))
    : SYMBOLS.slice();
  const saveHistory = params.save_history !== false;
  const historyLimit = Math.max(20, Math.min(500, safeInt(params.history_limit, 200)));
  const { rows, source } = await readHistoryRows();
  if (!rows.length) {
    return {
      window_minutes: windowMinutes,
      threshold_pct: thresholdPct,
      source,
      symbols: targetSymbols,
      rows: targetSymbols.map((symbol) => ({
        symbol,
        status: 'データ不足',
        move_pct: null,
        samples: 0,
        latest_price: null,
        base_price: null,
        latest_time: '',
      })),
      message: '履歴データがないためアラート判定は未実施です。',
    };
  }
  const resultRows = targetSymbols.map((symbol) => {
    const symbolRows = rows.filter((row) => row.symbol === symbol).sort((a, b) => a.timestamp - b.timestamp);
    if (symbolRows.length < 2) {
      return {
        symbol,
        status: 'データ不足',
        move_pct: null,
        samples: symbolRows.length,
        latest_price: symbolRows[0]?.price ?? null,
        base_price: symbolRows[0]?.price ?? null,
        latest_time: symbolRows[0] ? formatJst(symbolRows[0].timestamp) : '',
      };
    }
    const latest = symbolRows[symbolRows.length - 1];
    const windowStart = new Date(latest.timestamp.getTime() - windowMinutes * 60 * 1000);
    const windowRows = symbolRows.filter((row) => row.timestamp >= windowStart && row.timestamp <= latest.timestamp);
    const base = windowRows[0];
    if (!base || base.price <= 0) {
      return {
        symbol,
        status: 'データ不足',
        move_pct: null,
        samples: windowRows.length,
        latest_price: latest.price,
        base_price: null,
        latest_time: formatJst(latest.timestamp),
      };
    }
    const movePct = ((latest.price - base.price) / base.price) * 100;
    const thresholdForSymbol = Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct;
    let streakCount = 0;
    for (let i = windowRows.length - 1; i >= 0; i -= 1) {
      const pivot = windowRows[i];
      if (!pivot || !Number.isFinite(pivot.price) || pivot.price <= 0) break;
      const moveFromPivot = ((latest.price - pivot.price) / pivot.price) * 100;
      if (moveFromPivot >= thresholdForSymbol) streakCount += 1;
      else break;
    }
    let rollingStreak = 0;
    for (let i = windowRows.length - 1; i > 0; i -= 1) {
      const curr = windowRows[i];
      const prev = windowRows[i - 1];
      if (!curr || !prev || !Number.isFinite(curr.price) || !Number.isFinite(prev.price) || prev.price <= 0) break;
      const stepPct = ((curr.price - prev.price) / prev.price) * 100;
      if (stepPct > 0) rollingStreak += 1;
      else break;
    }
    const simpleHit = movePct >= thresholdForSymbol;
    const rollingHit = rollingStreak >= rollingMinPoints && movePct >= Math.max(thresholdForSymbol * 0.4, 0.02);
    const hit = alertMode === 'rolling' ? rollingHit : simpleHit;
    return {
      symbol,
      status: hit ? (alertMode === 'rolling' ? 'ローリング上昇アラート' : '上昇アラート') : '監視中',
      move_pct: movePct,
      threshold_pct: thresholdForSymbol,
      streak_count: streakCount,
      rolling_streak: rollingStreak,
      samples: windowRows.length,
      latest_price: latest.price,
      base_price: base.price,
      latest_time: formatJst(latest.timestamp),
    };
  });
  const alertCount = resultRows.filter((row) => row.status === '上昇アラート').length;
  const ranked = resultRows.filter((row) => Number.isFinite(row.move_pct)).sort((a, b) => b.move_pct - a.move_pct);
  const topAlert = ranked.length ? ranked[0] : null;
  let historySaved = 0;
  if (saveHistory && alertCount > 0) {
    const existing = await readAlertHistory();
    const nowText = nowJstIso();
    const appendItems = resultRows
      .filter((row) => row.status === '上昇アラート')
      .map((row) => ({
        timestamp_jst: nowText,
        symbol: row.symbol,
        move_pct: row.move_pct,
        threshold_pct: row.threshold_pct,
        window_minutes: windowMinutes,
        streak_count: row.streak_count,
      }));
    const merged = existing.concat(appendItems).slice(-historyLimit);
    await writeAlertHistory(merged);
    historySaved = appendItems.length;
  }
  return {
    alert_mode: alertMode,
    rolling_min_points: rollingMinPoints,
    window_minutes: windowMinutes,
    threshold_pct: thresholdPct,
    thresholds_by_symbol: thresholdsBySymbol,
    source,
    symbols: targetSymbols,
    top_alert: topAlert,
    history_saved: historySaved,
    rows: resultRows,
    message: alertCount
      ? `${alertCount}通貨がしきい値超えです。`
      : 'しきい値を超えた通貨はありません。',
  };
}

async function alertHistory(params = {}) {
  const limit = Math.max(1, Math.min(200, safeInt(params.limit, 20)));
  const items = await readAlertHistory();
  const rows = items.slice(-limit).reverse();
  return {
    rows,
    count: items.length,
    limit,
    file: alertHistoryFilePath(),
  };
}

async function clearAlertHistory() {
  await writeAlertHistory([]);
  return {
    ok: true,
    message: 'alert_history.json をクリアしました。',
    file: alertHistoryFilePath(),
  };
}

async function saveDailyGoalReport(body = {}) {
  const daily = await dailyGoal(body);
  const rows = Array.isArray(daily.scenarios) ? daily.scenarios : [];
  const file = dailyGoalReportFilePath();
  const header = [
    'saved_at_jst',
    'strategy_template',
    'symbol',
    'target_profit_jpy',
    'capital_jpy',
    'roundtrip_cost_pct',
    'virtual_fill_rate_pct_used',
    'cancel_rate',
    'opportunities',
    'effective',
    'needed_move_pct',
    'needed_win_rate_pct',
    'movement_ratio',
    'reality',
  ];
  const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
  const lines = [];
  if (!exists) lines.push(header.join(','));
  const now = nowJstIso();
  rows.forEach((row) => {
    lines.push([
      now,
      toCsvValue(daily.strategy_template || body.strategy_template || ''),
      toCsvValue(body.symbol || ''),
      safeFloat(body.target_profit_jpy, 0),
      safeFloat(body.capital_jpy, 0),
      safeFloat(daily.roundtrip_cost_pct, 0),
      safeFloat(daily.virtual_fill_rate_pct_used, 0),
      safeFloat(row.cancel_rate, 0),
      safeInt(row.opportunities, 0),
      safeInt(row.effective, 0),
      safeFloat(row.needed_move_pct, 0),
      safeFloat(row.needed_win_rate_pct, 0),
      row.movement_ratio === null || row.movement_ratio === undefined ? '' : safeFloat(row.movement_ratio, 0),
      toCsvValue(row.reality || ''),
    ].join(','));
  });
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (lines.length) await fs.promises.appendFile(file, `${lines.join('\n')}\n`, 'utf8');
  return {
    ok: true,
    rows_saved: rows.length,
    file,
    message: `日次目標レポートを${rows.length}行保存しました。`,
  };
}

async function dailyGoalReports(params = {}) {
  const limit = Math.max(1, Math.min(300, safeInt(params.limit, 20)));
  const file = dailyGoalReportFilePath();
  if (!fs.existsSync(file)) return { rows: [], count: 0, limit, file };
  const text = await fs.promises.readFile(file, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { rows: [], count: 0, limit, file };
  const headers = parseCsvLine(lines[0]);
  const allRows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, idx) => [header, values[idx] ?? '']));
  });
  return {
    rows: allRows.slice(-limit).reverse(),
    count: allRows.length,
    limit,
    file,
  };
}

async function clearDailyGoalReports() {
  const file = dailyGoalReportFilePath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, '', 'utf8');
  return {
    ok: true,
    message: 'daily_goal_reports.csv をクリアしました。',
    file,
  };
}

async function chart(params = {}) {
  const symbol = SYMBOLS.includes(params.symbol) ? params.symbol : 'BTCJPY';
  const sourceMode = params.source || 'local';
  const interval = params.interval || '1m';
  const limit = Math.min(Math.max(safeInt(params.limit, 160), 2), 1000);
  let { points } = await localChartPoints(symbol, limit);
  let usedSource = 'local-history';
  let message = 'ローカル price_history.csv からチャートを作成しました。';
  const errors = [];

  if (sourceMode === 'downloaded' || sourceMode === 'combined') {
    try {
      const date = String(params.date || '').trim();
      if (!date) throw new Error('DL済み過去データの表示には日付が必要です。');
      const downloaded = await downloadedChartPoints({
        symbol,
        interval,
        date,
        start_hour: params.start_hour,
        end_hour: params.end_hour,
      });
      const downloadedPoints = downloaded.points.slice(-limit);
      if (sourceMode === 'downloaded') {
        points = downloadedPoints;
        usedSource = 'downloaded-kline';
        message = downloadedPoints.length
          ? `long_data のDL済み ${interval} 足からチャートを作成しました。`
          : `DL済み過去データが見つかりません。先に履歴データDLを実行してください。予定CSV: ${downloaded.planned_file}`;
      } else {
        const local = await localChartPoints(symbol, limit);
        points = combineChartPoints(downloadedPoints, local.points, limit);
        usedSource = 'local-history+downloaded-kline';
        message = downloadedPoints.length
          ? `price_history.csv と long_data のDL済み ${interval} 足を時刻順に統合しました。同時刻はローカル履歴を優先します。`
          : `DL済み過去データが見つからないため、ローカル履歴だけで表示しています。予定CSV: ${downloaded.planned_file}`;
      }
    } catch (error) {
      errors.push(error.message);
      points = sourceMode === 'combined' ? points : [];
      usedSource = sourceMode === 'combined' ? 'local-history' : 'downloaded-kline';
      message = sourceMode === 'combined'
        ? 'DL済み過去データを読めなかったため、ローカル履歴だけで表示しています。'
        : 'DL済み過去データを読めませんでした。履歴データDLの日付と時間帯を確認してください。';
    }
  }

  if (sourceMode === 'klines' || (sourceMode === 'local' && points.length < 2)) {
    try {
      points = await fetchKlinesForChart(symbol, interval, Math.min(Math.max(limit, 20), 1000));
      usedSource = 'binance-klines';
      message = `Binance公開APIの ${interval} 足からチャートを作成しました。履歴CSVには保存していません。`;
    } catch (error) {
      errors.push(error.message);
      if (points.length < 2) {
        const mock = MOCK_PRICES[symbol];
        points = [
          { timestamp: 'sample-1', timestamp_full: 'sample', price: mock.short_base },
          { timestamp: 'sample-2', timestamp_full: 'sample', price: mock.prev },
          { timestamp: 'sample-3', timestamp_full: 'sample', price: mock.price },
        ];
        usedSource = 'mock';
        message = '履歴とklineを使えないため、サンプルチャートを表示しています。';
      }
    }
  }
  const chartSummary = calculations.summarizeChartPoints(points);
  return {
    symbol,
    points,
    source: usedSource,
    message,
    errors,
    ...chartSummary,
  };
}

async function fetchPrices() {
  const { rows, errors } = await fetchAllPrices();
  const { added, path: filePath } = await appendHistoryRows(rows);
  const { symbols, source } = await currentPriceData();
  return {
    ok: Boolean(rows.length),
    fetched: rows,
    errors,
    added_rows: added,
    history_file: filePath,
    symbols,
    data_source: source,
    message: rows.length
      ? `公開APIから価格を取得し、${added}行を price_history.csv に保存しました。`
      : '価格取得に失敗しました。',
  };
}

async function tradePreview(body = {}) {
  const { symbols } = await currentPriceData();
  return calculations.calculateTradePreview({
    body,
    summaries: symbols,
    mockPrices: MOCK_PRICES,
    symbols: SYMBOLS,
  });
}

async function dailyGoal(body = {}) {
  const { symbols } = await currentPriceData();
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : SYMBOLS[0];
  const summary = symbols.find((item) => item.symbol === symbol);
  const manualFillRate = Math.max(0, Math.min(100, safeFloat(body.virtual_fill_rate_pct, 70)));
  const autoEnabled = body.virtual_fill_rate_auto !== false;
  const estimated = autoEnabled ? await estimateVirtualFillRate(body) : null;
  const fillRateToUse = Number.isFinite(estimated?.rate) ? estimated.rate : manualFillRate;
  const fillRateNote = autoEnabled
    ? (estimated?.note || '仮想約定率の自動推定を試し、手入力値を使いました。')
    : '仮想約定率は手入力値を使っています。';
  return calculations.calculateDailyGoal({
    ...body,
    virtual_fill_rate_pct: fillRateToUse,
    virtual_fill_rate_pct_used: fillRateToUse,
    virtual_fill_rate_note: fillRateNote,
    recent_move_pct: body.recent_move_pct ?? summary?.short_pct ?? 0,
    recent_move_label: summary?.timestamp ? `${symbol} 短期値動き` : `${symbol} 短期値動き`,
  });
}

async function invoke(route, payload = {}) {
  const query = payload.query || {};
  const body = payload.body || {};
  switch (route) {
    case 'status': return status();
    case 'capabilities': return capabilities();
    case 'summary': return summary();
    case 'impact': return impact(query);
    case 'alert-preview': return alertPreview(query);
    case 'alert-history': return alertHistory(query);
    case 'daily-goal-reports': return dailyGoalReports(query);
    case 'chart': return chart(query);
    case 'contract': return contract();
    case 'api-readiness': return apiReadiness();
    case 'fetch-prices': return fetchPrices();
    case 'download-history': return downloadHistoricalKlines(body);
    case 'trade-preview': return tradePreview(body);
    case 'daily-goal': return dailyGoal(body);
    case 'save-daily-goal-report': return saveDailyGoalReport(body);
    case 'clear-alert-history': return clearAlertHistory();
    case 'clear-daily-goal-reports': return clearDailyGoalReports();
    default: throw new Error(`Unknown local engine route: ${route}`);
  }
}

module.exports = {
  invoke,
  status,
  capabilities,
  summary,
  impact,
  contract,
  chart,
  downloadHistoricalKlines,
  buildKlineDownloadPlan,
  fetchPrices,
  tradePreview,
  dailyGoal,
  saveDailyGoalReport,
  dailyGoalReports,
  clearDailyGoalReports,
  calculations,
};
