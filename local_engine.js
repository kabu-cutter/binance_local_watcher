const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const calculations = require('./local_engine_calculations');
const dbStore = require('./local_engine_db');

const VERSION = 'electron-node-engine-v0.5.2-db-phase2-daily-goal';
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
const INTERVAL_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

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


function expandCompactDateLabel(dateLabel) {
  const text = String(dateLabel || '').trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function latestDownloadedDateFor(symbol, interval) {
  const dir = longDataDir();
  if (!fs.existsSync(dir)) return '';
  const pattern = new RegExp(`^binance_${symbol}_${interval}_(\\d{8})_.*_JST\\.csv$`);
  const dates = [];
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(pattern);
    if (match) dates.push(match[1]);
  }
  dates.sort();
  return dates.length ? expandCompactDateLabel(dates[dates.length - 1]) : '';
}


function jstDateTextFromMs(ms) {
  const jst = new Date(Number(ms) + JST_OFFSET_MS);
  const yyyy = jst.getUTCFullYear();
  const mm = pad2(jst.getUTCMonth() + 1);
  const dd = pad2(jst.getUTCDate());
  return `${yyyy}-${mm}-${dd}`;
}

function fullDayMergedKlineFile(symbol, interval, dateText) {
  const dateLabel = compactDateLabel(dateText);
  return path.join(longDataDir(), `binance_${symbol}_${interval}_${dateLabel}_0000_2400_merged_JST.csv`);
}

function normalizeInterval(interval) {
  return INTERVAL_MS[interval] ? interval : '1m';
}

function currentOpenTimeMs(interval, nowMs = Date.now()) {
  const step = INTERVAL_MS[normalizeInterval(interval)] || INTERVAL_MS['1m'];
  return Math.floor(nowMs / step) * step;
}

async function readDownloadedRowsForDate(symbol, interval, dateText) {
  const dateLabel = compactDateLabel(dateText);
  const metas = listDownloadedKlineFileMetas(symbol, interval)
    .filter((meta) => meta.dateLabel === dateLabel);
  const byTime = new Map();
  for (const meta of metas) {
    const rows = await readLongDataRows(meta.file);
    rows.forEach((row) => {
      if (row.symbol !== symbol || row.interval !== interval) return;
      const timeMs = safeFloat(row.open_time_ms, NaN);
      if (!Number.isFinite(timeMs)) return;
      byTime.set(timeMs, row);
    });
  }
  return Array.from(byTime.values()).sort((a, b) => safeFloat(a.open_time_ms) - safeFloat(b.open_time_ms));
}

async function latestDownloadedKlineState(symbol, interval) {
  const metas = listDownloadedKlineFileMetas(symbol, interval);
  let latest = null;
  let rowCount = 0;
  const filesWithRows = new Set();
  for (const meta of metas) {
    const rows = await readLongDataRows(meta.file);
    rows.forEach((row) => {
      if (row.symbol !== symbol || row.interval !== interval) return;
      const timeMs = safeFloat(row.open_time_ms, NaN);
      const price = safeFloat(row.close, NaN);
      if (!Number.isFinite(timeMs) || !Number.isFinite(price)) return;
      rowCount += 1;
      filesWithRows.add(meta.file);
      if (!latest || timeMs > latest.open_time_ms) {
        latest = {
          open_time_ms: timeMs,
          open_time_jst: row.open_time_jst || formatJst(new Date(timeMs)),
          close: price,
          file: meta.file,
        };
      }
    });
  }
  return {
    latest,
    row_count: rowCount,
    file_count: filesWithRows.size,
  };
}

async function fetchKlineRowsBetween(symbol, interval, startMs, endMs, waitMs = 250) {
  const step = INTERVAL_MS[normalizeInterval(interval)] || INTERVAL_MS['1m'];
  const rowsByTime = new Map();
  const errors = [];
  let cursor = startMs;
  let requestCount = 0;
  while (cursor < endMs) {
    try {
      const items = await fetchJsonWithRetry('/api/v3/klines', {
        symbol,
        interval,
        startTime: cursor,
        endTime: endMs - 1,
        limit: 1000,
      }, 15000, 2);
      requestCount += 1;
      if (!Array.isArray(items) || !items.length) break;
      const rows = mapKlineRows(items, symbol, interval)
        .filter((row) => row.open_time_ms >= startMs && row.open_time_ms < endMs);
      rows.forEach((row) => rowsByTime.set(row.open_time_ms, row));
      const lastOpen = rows.length ? rows[rows.length - 1].open_time_ms : Number(items[items.length - 1]?.[0]);
      if (!Number.isFinite(lastOpen) || lastOpen < cursor) break;
      cursor = lastOpen + step;
      if (items.length < 1000) break;
      if (waitMs > 0) await sleep(waitMs);
    } catch (error) {
      errors.push(error.message);
      break;
    }
  }
  return {
    rows: Array.from(rowsByTime.values()).sort((a, b) => a.open_time_ms - b.open_time_ms),
    errors,
    request_count: requestCount,
  };
}

async function mergeDownloadedRowsIntoDailyFiles(symbol, interval, newRows) {
  const groups = new Map();
  newRows.forEach((row) => {
    const dateText = jstDateTextFromMs(row.open_time_ms);
    if (!groups.has(dateText)) groups.set(dateText, []);
    groups.get(dateText).push(row);
  });

  const files = [];
  let insertedRows = 0;
  for (const [dateText, rowsForDate] of groups.entries()) {
    const existingRows = await readDownloadedRowsForDate(symbol, interval, dateText);
    const before = new Set(existingRows.map((row) => safeFloat(row.open_time_ms, NaN)).filter((n) => Number.isFinite(n)));
    const byTime = new Map();
    existingRows.forEach((row) => {
      const timeMs = safeFloat(row.open_time_ms, NaN);
      if (Number.isFinite(timeMs)) byTime.set(timeMs, row);
    });
    rowsForDate.forEach((row) => {
      const timeMs = safeFloat(row.open_time_ms, NaN);
      if (Number.isFinite(timeMs)) byTime.set(timeMs, row);
    });
    const merged = Array.from(byTime.values()).sort((a, b) => safeFloat(a.open_time_ms) - safeFloat(b.open_time_ms));
    const file = fullDayMergedKlineFile(symbol, interval, dateText);
    await writeCsvRows(file, LONG_DATA_COLUMNS, merged);
    const after = new Set(merged.map((row) => safeFloat(row.open_time_ms, NaN)).filter((n) => Number.isFinite(n)));
    let addedForFile = 0;
    after.forEach((timeMs) => {
      if (!before.has(timeMs)) addedForFile += 1;
    });
    insertedRows += addedForFile;
    files.push({
      date: dateText,
      file,
      rows: merged.length,
      inserted_rows: addedForFile,
    });
  }
  return { files, inserted_rows: insertedRows };
}

function parseLongDataFileMeta(filePath) {
  const name = path.basename(filePath);
  const match = name.match(/^binance_(BTCJPY|ETHJPY)_(1m|5m|15m|1h)_(\d{8})_(\d{4})_(\d{4})(?:_merged)?_JST\.csv$/);
  if (!match) return null;
  const [, symbol, interval, dateLabel, startLabel, endLabel] = match;
  const date = expandCompactDateLabel(dateLabel);
  const startHour = Math.max(0, Math.min(24, safeInt(startLabel.slice(0, 2), 0)));
  const endHour = Math.max(0, Math.min(24, safeInt(endLabel.slice(0, 2), 24)));
  let startMs = null;
  let endMs = null;
  try {
    startMs = parseJstDateTime(date, startHour, 0).getTime();
    endMs = endHour >= 24
      ? parseJstDateTime(date, 0, 0).getTime() + 24 * 60 * 60 * 1000
      : parseJstDateTime(date, endHour, 0).getTime();
  } catch {
    startMs = null;
    endMs = null;
  }
  return {
    file: filePath,
    name,
    symbol,
    interval,
    date,
    dateLabel,
    startLabel,
    endLabel,
    startMs,
    endMs,
    isMerged: name.includes('_merged_'),
  };
}

function listDownloadedKlineFileMetas(symbol, interval) {
  const dir = longDataDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => parseLongDataFileMeta(path.join(dir, name)))
    .filter((meta) => meta && meta.symbol === symbol && meta.interval === interval)
    .sort((a, b) => {
      if (a.dateLabel !== b.dateLabel) return a.dateLabel.localeCompare(b.dateLabel);
      if (a.startLabel !== b.startLabel) return a.startLabel.localeCompare(b.startLabel);
      if (a.endLabel !== b.endLabel) return a.endLabel.localeCompare(b.endLabel);
      return Number(b.isMerged) - Number(a.isMerged);
    });
}

function clampHour(value, fallback) {
  return Math.max(0, Math.min(24, safeInt(value, fallback)));
}

function reduceLongDataFileMetas(metas) {
  if (!Array.isArray(metas) || !metas.length) return [];
  const sortable = metas
    .filter((meta) => Number.isFinite(meta.startMs) && Number.isFinite(meta.endMs))
    .sort((a, b) => {
      const spanDiff = (b.endMs - b.startMs) - (a.endMs - a.startMs);
      if (spanDiff !== 0) return spanDiff;
      if (a.isMerged !== b.isMerged) return Number(b.isMerged) - Number(a.isMerged);
      return a.name.localeCompare(b.name);
    });
  const selected = [];
  sortable.forEach((meta) => {
    const covered = selected.some((chosen) => (
      chosen.symbol === meta.symbol
      && chosen.interval === meta.interval
      && chosen.startMs <= meta.startMs
      && chosen.endMs >= meta.endMs
    ));
    if (!covered) selected.push(meta);
  });
  return selected.sort((a, b) => {
    if (a.dateLabel !== b.dateLabel) return a.dateLabel.localeCompare(b.dateLabel);
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.endMs !== b.endMs) return a.endMs - b.endMs;
    return Number(b.isMerged) - Number(a.isMerged);
  });
}

function occurrenceScopeLabel(scope) {
  if (scope === 'all_downloaded') return 'DL済み全体（複数ファイル）';
  if (scope === 'range') return '指定範囲';
  return '最新DLデータ';
}

function normalizeOccurrenceRequest(body = {}) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : 'BTCJPY';
  const interval = ['1m', '5m', '15m', '1h'].includes(body.occurrence_interval)
    ? body.occurrence_interval
    : ['1m', '5m', '15m', '1h'].includes(body.interval)
      ? body.interval
      : '1m';
  const rawScope = String(body.occurrence_scope || body.reference_scope || 'latest').trim();
  const scope = ['latest', 'all_downloaded', 'range'].includes(rawScope) ? rawScope : 'latest';
  return { symbol, interval, scope };
}

function selectOccurrenceReferenceFiles(body = {}) {
  const request = normalizeOccurrenceRequest(body);
  const metas = listDownloadedKlineFileMetas(request.symbol, request.interval);
  if (!metas.length) {
    return {
      ...request,
      scope_label: occurrenceScopeLabel(request.scope),
      files: [],
      file_metas: [],
      selected_file_count: 0,
      start_ms: null,
      end_ms: null,
      start_jst: '',
      end_jst: '',
      note: 'DL済み履歴ファイルが見つかりません。',
    };
  }

  let selected = [];
  let startMs = null;
  let endMs = null;
  let startJst = '';
  let endJst = '';

  if (request.scope === 'all_downloaded') {
    selected = metas;
  } else if (request.scope === 'range') {
    const latestDate = expandCompactDateLabel(metas[metas.length - 1].dateLabel);
    const startDate = String(body.occurrence_start_date || body.start_date || body.date || latestDate || '').trim();
    const endDate = String(body.occurrence_end_date || body.end_date || startDate || '').trim();
    const startHour = clampHour(body.occurrence_start_hour ?? body.start_hour, 0);
    const rawEndHour = clampHour(body.occurrence_end_hour ?? body.end_hour, 24);
    const endHour = Math.max(startHour === 24 ? 24 : startHour + 1, rawEndHour);
    if (!startDate || !endDate) throw new Error('指定範囲には開始日と終了日が必要です。');
    startMs = parseJstDateTime(startDate, Math.min(startHour, 23), 0).getTime();
    if (endHour >= 24) {
      endMs = parseJstDateTime(endDate, 0, 0).getTime() + 24 * 60 * 60 * 1000;
    } else {
      endMs = parseJstDateTime(endDate, endHour, 0).getTime();
    }
    if (endMs <= startMs) throw new Error('指定範囲の終了は開始より後にしてください。');
    startJst = formatJst(new Date(startMs));
    endJst = formatJst(new Date(endMs));
    selected = metas.filter((meta) => {
      if (!Number.isFinite(meta.startMs) || !Number.isFinite(meta.endMs)) return false;
      return meta.endMs > startMs && meta.startMs < endMs;
    });
  } else {
    const latestDateLabel = metas[metas.length - 1].dateLabel;
    selected = metas.filter((meta) => meta.dateLabel === latestDateLabel);
  }

  const reducedSelected = reduceLongDataFileMetas(selected);
  return {
    ...request,
    scope_label: occurrenceScopeLabel(request.scope),
    files: reducedSelected.map((meta) => meta.file),
    file_metas: reducedSelected,
    selected_file_count: reducedSelected.length,
    raw_selected_file_count: selected.length,
    start_ms: startMs,
    end_ms: endMs,
    start_jst: startJst,
    end_jst: endJst,
  };
}

function summarizeReferencePeriod(rows) {
  if (!Array.isArray(rows) || !rows.length) return { text: '', start_jst: '', end_jst: '' };
  const times = rows
    .map((row) => safeFloat(row.open_time_ms, NaN))
    .filter((value) => Number.isFinite(value));
  if (!times.length) return { text: '', start_jst: '', end_jst: '' };
  const startJst = formatJst(new Date(Math.min(...times)));
  const endJst = formatJst(new Date(Math.max(...times)));
  return {
    text: `参照期間: ${startJst}〜${endJst}`,
    start_jst: startJst,
    end_jst: endJst,
  };
}

async function occurrenceKlineRows(body = {}) {
  const selection = selectOccurrenceReferenceFiles(body);
  const rowsByTime = new Map();
  const usedFiles = [];
  const usedFileSet = new Set();
  for (const file of selection.files) {
    const rows = await readLongDataRows(file);
    let kept = 0;
    rows.forEach((row) => {
      if (row.symbol !== selection.symbol || row.interval !== selection.interval) return;
      const timeMs = safeFloat(row.open_time_ms, NaN);
      if (!Number.isFinite(timeMs)) return;
      if (selection.start_ms !== null && timeMs < selection.start_ms) return;
      if (selection.end_ms !== null && timeMs >= selection.end_ms) return;
      rowsByTime.set(timeMs, row);
      kept += 1;
    });
    if (kept > 0 && !usedFileSet.has(file)) {
      usedFileSet.add(file);
      usedFiles.push(file);
    }
  }
  return {
    rows: Array.from(rowsByTime.values()).sort((a, b) => safeFloat(a.open_time_ms) - safeFloat(b.open_time_ms)),
    files: usedFiles,
    selection,
  };
}


function summarizeReferenceFiles(files, maxShown = 4) {
  const names = Array.isArray(files) ? files.map((file) => path.basename(file)) : [];
  if (!names.length) return '参照ファイル: なし';
  const shown = names.slice(0, maxShown);
  const rest = names.length - shown.length;
  return `参照ファイル: ${shown.join(', ')}${rest > 0 ? ` ほか${rest}件` : ''}`;
}

function summarizeReferenceRange(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const times = rows
    .map((row) => safeFloat(row.open_time_ms, NaN))
    .filter((value) => Number.isFinite(value));
  if (!times.length) return '';
  const start = formatJst(new Date(Math.min(...times)));
  const end = formatJst(new Date(Math.max(...times)));
  return `参照範囲: ${start}〜${end}`;
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

function credentialsFromEnv() {
  const envFileValues = parseSimpleEnvFile(envFilePath());
  const envApiKey = String(process.env.BINANCE_API_KEY || '').trim();
  const envApiSecret = String(process.env.BINANCE_API_SECRET || '').trim();
  const fileApiKey = String(envFileValues.BINANCE_API_KEY || '').trim();
  const fileApiSecret = String(envFileValues.BINANCE_API_SECRET || '').trim();
  return {
    apiKey: envApiKey || fileApiKey,
    apiSecret: envApiSecret || fileApiSecret,
    keySource: envApiKey ? 'environment' : fileApiKey ? '.env' : 'none',
    secretSource: envApiSecret ? 'environment' : fileApiSecret ? '.env' : 'none',
  };
}

function signQuery(params, secret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

function fetchSignedJson(apiPath, params = {}, timeoutMs = 10000) {
  const { apiKey, apiSecret } = credentialsFromEnv();
  if (!apiKey || !apiSecret) {
    throw new Error('API key/secret が未設定です。');
  }
  const signedParams = {
    ...params,
    recvWindow: safeInt(params.recvWindow, 5000),
    timestamp: Date.now(),
  };
  const queryWithSig = signQuery(signedParams, apiSecret);
  const url = new URL(apiPath, BINANCE_BASE_URL);
  url.search = queryWithSig;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'BinanceLocalWatcherElectronNodeEngine/0.4',
        'X-MBX-APIKEY': apiKey,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`${res.statusCode} ${res.statusMessage}`);
          err.body = body;
          err.statusCode = res.statusCode;
          reject(err);
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

const CHART_INTERVALS = ['auto', '1m', '5m', '15m', '30m', '1h'];
const KLINE_INTERVALS = Object.keys(INTERVAL_MS);
const CHART_RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};
const CHART_RANGE_LABELS = {
  '1h': '直近1時間',
  '3h': '直近3時間',
  '6h': '直近6時間',
  '24h': '直近24時間',
  '3d': '直近3日',
  '1w': '直近1週間',
};

const ANALYSIS_CACHE_ALLOWED_DAYS = [7, 14, 30];
const ANALYSIS_CACHE_RETENTION_DAYS = 30;
const ANALYSIS_CACHE_SYMBOLS = SYMBOLS;


function normalizeChartInterval(interval = 'auto', rangeKey = '24h') {
  const requested = CHART_INTERVALS.includes(interval) ? interval : 'auto';
  if (requested !== 'auto') return requested;
  if (rangeKey === '1h' || rangeKey === '3h' || rangeKey === '6h') return '1m';
  if (rangeKey === '24h') return '5m';
  if (rangeKey === '3d' || rangeKey === '1w') return '15m';
  return '5m';
}

function normalizeChartRange(range = '24h') {
  const key = Object.prototype.hasOwnProperty.call(CHART_RANGE_MS, range) ? range : '24h';
  const endMs = Date.now();
  const startMs = endMs - CHART_RANGE_MS[key];
  return {
    key,
    label: CHART_RANGE_LABELS[key] || key,
    start_ms: startMs,
    end_ms: endMs,
    start_jst: formatJst(new Date(startMs)),
    end_jst: formatJst(new Date(endMs)),
  };
}


function normalizeAnalysisCacheDays(value, fallback = 7) {
  const n = safeInt(value, fallback);
  return ANALYSIS_CACHE_ALLOWED_DAYS.includes(n) ? n : fallback;
}

function normalizeAnalysisCacheSymbols(value) {
  if (Array.isArray(value)) {
    const symbols = value.filter((symbol) => SYMBOLS.includes(symbol));
    return symbols.length ? symbols : ANALYSIS_CACHE_SYMBOLS;
  }
  const text = String(value || '').trim();
  if (!text) return ANALYSIS_CACHE_SYMBOLS;
  const symbols = text.split(',').map((item) => item.trim()).filter((symbol) => SYMBOLS.includes(symbol));
  return symbols.length ? symbols : ANALYSIS_CACHE_SYMBOLS;
}

function analysisCacheWindow(days = 7) {
  const referenceDays = normalizeAnalysisCacheDays(days, 7);
  const endMs = currentOpenTimeMs('1m', Date.now());
  const startMs = endMs - referenceDays * 24 * 60 * 60 * 1000;
  return {
    reference_days: referenceDays,
    interval: '1m',
    start_ms: startMs,
    end_ms: endMs,
    start_jst: formatJst(new Date(startMs)),
    end_jst: formatJst(new Date(endMs)),
  };
}

function expectedRowsForAnalysisWindow(startMs, endMs) {
  const step = INTERVAL_MS['1m'];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / step));
}

async function downloadedKlineRowsForWindow({ symbol, interval = '1m', start_ms: startMs, end_ms: endMs } = {}) {
  const normalizedSymbol = SYMBOLS.includes(symbol) ? symbol : 'BTCJPY';
  const normalizedInterval = normalizeInterval(interval || '1m');
  const dir = longDataDir();
  const byOpenTime = new Map();
  const usedFiles = new Set();
  if (fs.existsSync(dir)) {
    const prefix = `binance_${normalizedSymbol}_${normalizedInterval}_`;
    const files = (await fs.promises.readdir(dir))
      .filter((name) => name.startsWith(prefix) && name.endsWith('_JST.csv'))
      .map((name) => path.join(dir, name));
    for (const file of files) {
      const rows = await readLongDataRows(file);
      let used = false;
      rows.forEach((row) => {
        if (row.symbol !== normalizedSymbol || row.interval !== normalizedInterval) return;
        const timeMs = safeFloat(row.open_time_ms, NaN);
        if (!Number.isFinite(timeMs)) return;
        if (timeMs < startMs || timeMs >= endMs) return;
        byOpenTime.set(timeMs, row);
        used = true;
      });
      if (used) usedFiles.add(file);
    }
  }
  return {
    rows: Array.from(byOpenTime.values()).sort((a, b) => safeFloat(a.open_time_ms) - safeFloat(b.open_time_ms)),
    files: Array.from(usedFiles),
  };
}

function summarizeAnalysisCacheCoverage({ symbol, rows, files, window, dbStatus = null } = {}) {
  const expected = expectedRowsForAnalysisWindow(window.start_ms, window.end_ms);
  const rowCount = Array.isArray(rows) ? rows.length : 0;
  const dbRowCount = Number(dbStatus?.row_count || 0);
  const effectiveRows = dbStatus?.enabled ? dbRowCount : rowCount;
  const missing = Math.max(0, expected - effectiveRows);
  const coverageRate = expected > 0 ? effectiveRows / expected : (effectiveRows > 0 ? 1 : 0);
  const quality = effectiveRows <= 0
    ? 'empty'
    : coverageRate >= 0.95
      ? 'good'
      : coverageRate >= 0.5
        ? 'partial'
        : 'thin';
  const period = rows?.length
    ? `${formatJst(new Date(safeFloat(rows[0].open_time_ms)))} → ${formatJst(new Date(safeFloat(rows[rows.length - 1].open_time_ms)))}`
    : `${window.start_jst} → ${window.end_jst}`;
  return {
    symbol,
    interval: '1m',
    reference_days: window.reference_days,
    start_time_ms: window.start_ms,
    end_time_ms: window.end_ms,
    start_jst: window.start_jst,
    end_jst: window.end_jst,
    row_count: effectiveRows,
    csv_row_count: rowCount,
    db_row_count: dbRowCount,
    expected_row_count: expected,
    missing_count: missing,
    coverage_rate: coverageRate,
    coverage_pct: coverageRate * 100,
    quality,
    enough: coverageRate >= 0.95,
    referenced_file_count: Array.isArray(files) ? files.length : 0,
    referenced_files: (files || []).map((file) => path.basename(file)),
    period_text: period,
    source: dbStatus?.enabled ? 'sqlite_candles' : 'long_data_csv',
  };
}

function mapKlineChartItems(items) {
  return items.map((item) => {
    const date = new Date(Number(item[0]));
    return {
      timestamp: formatJst(date, 'time'),
      timestamp_full: formatJst(date),
      price: safeFloat(item[4]),
      time_ms: Number(item[0]),
      high: safeFloat(item[2]),
      low: safeFloat(item[3]),
      open: safeFloat(item[1]),
      source: 'binance-klines',
    };
  });
}

function downsampleChartPoints(points, maxPoints) {
  const max = Math.max(2, safeInt(maxPoints, 500));
  if (!Array.isArray(points) || points.length <= max) return points || [];
  const lastIndex = points.length - 1;
  const sampled = [];
  for (let i = 0; i < max; i += 1) {
    const idx = Math.round((i / Math.max(max - 1, 1)) * lastIndex);
    sampled.push(points[idx]);
  }
  return sampled;
}

async function fetchKlinesForChart(symbol, interval = '1m', limit = 120) {
  const data = await fetchJson('/api/v3/klines', { symbol, interval, limit }, 15000);
  return mapKlineChartItems(data);
}

async function fetchKlinesForChartRange({ symbol, interval = 'auto', range = '24h', limit = 500 } = {}) {
  const normalizedRange = normalizeChartRange(range);
  const actualInterval = normalizeChartInterval(interval, normalizedRange.key);
  const stepMs = INTERVAL_MS[actualInterval] || INTERVAL_MS['1m'];
  const maxDisplayPoints = Math.max(40, Math.min(safeInt(limit, 500), 1200));
  const rawLimit = 1000;
  const maxRawPoints = Math.max(maxDisplayPoints, 3000);
  const rowsByTime = new Map();
  let cursor = normalizedRange.start_ms;
  let guard = 0;
  while (cursor < normalizedRange.end_ms && rowsByTime.size < maxRawPoints && guard < 12) {
    const data = await fetchJson('/api/v3/klines', {
      symbol,
      interval: actualInterval,
      startTime: cursor,
      endTime: normalizedRange.end_ms,
      limit: rawLimit,
    }, 15000);
    if (!Array.isArray(data) || !data.length) break;
    data.forEach((item) => {
      const openMs = Number(item[0]);
      if (Number.isFinite(openMs) && openMs >= normalizedRange.start_ms && openMs <= normalizedRange.end_ms) {
        rowsByTime.set(openMs, item);
      }
    });
    const lastOpenMs = Number(data[data.length - 1]?.[0]);
    if (!Number.isFinite(lastOpenMs) || lastOpenMs < cursor) break;
    cursor = lastOpenMs + stepMs;
    if (data.length < rawLimit) break;
    guard += 1;
  }
  const rawPoints = mapKlineChartItems(Array.from(rowsByTime.values()).sort((a, b) => Number(a[0]) - Number(b[0])));
  const points = downsampleChartPoints(rawPoints, maxDisplayPoints);
  return {
    points,
    raw_rows: rawPoints.length,
    display_rows: points.length,
    interval: actualInterval,
    interval_requested: interval,
    range: normalizedRange,
    sampled: rawPoints.length > points.length,
  };
}

function normalizeDownloadRequest(body = {}) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : 'BTCJPY';
  const interval = KLINE_INTERVALS.includes(body.interval) ? body.interval : '1m';
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

async function downloadedChartPointsForRange(params = {}) {
  const symbol = SYMBOLS.includes(params.symbol) ? params.symbol : 'BTCJPY';
  const interval = KLINE_INTERVALS.includes(params.interval) ? params.interval : '1m';
  const range = normalizeChartRange(params.range || '24h');
  const dir = longDataDir();
  const byOpenTime = new Map();
  const usedFiles = new Set();
  const plannedPattern = `binance_${symbol}_${interval}_*_JST.csv`;

  if (fs.existsSync(dir)) {
    const prefix = `binance_${symbol}_${interval}_`;
    const files = (await fs.promises.readdir(dir))
      .filter((name) => name.startsWith(prefix) && name.endsWith('_JST.csv'))
      .map((name) => path.join(dir, name));


    for (const file of files) {
      const rows = await readLongDataRows(file);
      let used = false;
      rows.forEach((row) => {
        if (row.symbol !== symbol || row.interval !== interval) return;
        const timeMs = safeFloat(row.open_time_ms, NaN);
        const price = safeFloat(row.close, NaN);
        if (!Number.isFinite(timeMs) || !Number.isFinite(price)) return;
        if (timeMs < range.start_ms || timeMs > range.end_ms) return;
        byOpenTime.set(timeMs, {
          timestamp: formatJst(new Date(timeMs), 'time'),
          timestamp_full: row.open_time_jst || formatJst(new Date(timeMs)),
          price,
          time_ms: timeMs,
          source: 'downloaded-kline',
        });
        used = true;
      });
      if (used) usedFiles.add(file);
    }
  }

  return {
    points: Array.from(byOpenTime.values()).sort((a, b) => a.time_ms - b.time_ms),
    source: usedFiles.size ? Array.from(usedFiles).join('; ') : plannedPattern,
    planned_file: plannedPattern,
    files: Array.from(usedFiles),
    range,
  };
}

function intervalMsForChart(interval) {
  return INTERVAL_MS[normalizeInterval(interval)] || INTERVAL_MS['1m'];
}

function jstPartsForRangeMs(ms) {
  const jst = new Date(Number(ms) + JST_OFFSET_MS);
  return {
    date: `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}`,
    hour: jst.getUTCHours(),
  };
}

function buildHourlyRequestsForChartRange(range) {
  const requests = [];
  const startDay = jstPartsForRangeMs(range.start_ms);
  let cursor = parseJstDateTime(startDay.date, startDay.hour, 0).getTime();
  const endMs = range.end_ms;
  let guard = 0;
  while (cursor < endMs && guard < 24 * 40) {
    const part = jstPartsForRangeMs(cursor);
    const next = cursor + 60 * 60 * 1000;
    const overlapStart = Math.max(cursor, range.start_ms);
    const overlapEnd = Math.min(next, range.end_ms);
    if (overlapEnd > overlapStart) {
      requests.push({
        date: part.date,
        start_hour: part.hour,
        end_hour: Math.min(24, part.hour + 1),
        start_ms: cursor,
        end_ms: next,
        overlap_start_ms: overlapStart,
        overlap_end_ms: overlapEnd,
      });
    }
    cursor = next;
    guard += 1;
  }
  return requests;
}

function expectedRowsForWindow(interval, startMs, endMs) {
  const step = intervalMsForChart(interval);
  if (!step || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.max(1, Math.round((endMs - startMs) / step));
}

function groupHourlyDownloadRequests(requests) {
  const groups = [];
  for (const req of requests) {
    const last = groups[groups.length - 1];
    if (last && last.date === req.date && last.end_hour === req.start_hour) {
      last.end_hour = req.end_hour;
      last.hour_count += 1;
      last.end_ms = req.end_ms;
    } else {
      groups.push({
        date: req.date,
        start_hour: req.start_hour,
        end_hour: req.end_hour,
        hour_count: 1,
        start_ms: req.start_ms,
        end_ms: req.end_ms,
      });
    }
  }
  return groups;
}

async function chartDataCoverage(params = {}) {
  const symbol = SYMBOLS.includes(params.symbol) ? params.symbol : 'BTCJPY';
  const range = normalizeChartRange(params.range || '24h');
  const requestedInterval = params.interval || 'auto';
  const interval = normalizeChartInterval(requestedInterval, range.key);
  const downloaded = await downloadedChartPointsForRange({ symbol, interval, range: range.key });
  const pointTimes = new Set((downloaded.points || []).map((point) => Number(point.time_ms)).filter(Number.isFinite));
  const expectedCount = expectedRowsForWindow(interval, range.start_ms, range.end_ms);
  const rowCount = pointTimes.size;
  const coverageRate = expectedCount > 0 ? rowCount / expectedCount : (rowCount > 0 ? 1 : 0);
  const hourly = buildHourlyRequestsForChartRange(range).map((req) => {
    const expected = expectedRowsForWindow(interval, req.overlap_start_ms, req.overlap_end_ms);
    let actual = 0;
    pointTimes.forEach((timeMs) => {
      if (timeMs >= req.overlap_start_ms && timeMs < req.overlap_end_ms) actual += 1;
    });
    const rate = expected > 0 ? actual / expected : (actual > 0 ? 1 : 0);
    return {
      ...req,
      expected_rows: expected,
      row_count: actual,
      coverage_rate: rate,
      enough: expected <= 0 || rate >= 0.95,
    };
  });
  const missingHourly = hourly.filter((item) => !item.enough);
  const missingRequests = groupHourlyDownloadRequests(missingHourly);
  const missingCount = Math.max(0, expectedCount - rowCount);
  const quality = rowCount <= 0
    ? 'empty'
    : coverageRate >= 0.95
      ? 'good'
      : coverageRate >= 0.5
        ? 'partial'
        : 'thin';
  return {
    ok: true,
    symbol,
    interval,
    interval_requested: requestedInterval,
    range: range.key,
    range_label: range.label,
    range_start_jst: range.start_jst,
    range_end_jst: range.end_jst,
    row_count: rowCount,
    expected_row_count: expectedCount,
    missing_count: missingCount,
    coverage_rate: coverageRate,
    coverage_pct: coverageRate * 100,
    quality,
    enough: coverageRate >= 0.95,
    source: 'long_data_csv',
    referenced_file_count: downloaded.files?.length || 0,
    referenced_files: (downloaded.files || []).map((file) => path.basename(file)),
    planned_file: downloaded.planned_file,
    missing_requests: missingRequests.map((item) => ({
      date: item.date,
      start_hour: item.start_hour,
      end_hour: item.end_hour,
      hour_count: item.hour_count,
    })),
    missing_request_count: missingRequests.length,
    message: rowCount <= 0
      ? `${symbol} ${interval} / ${range.label}: DL済みデータはまだありません。`
      : coverageRate >= 0.95
        ? `${symbol} ${interval} / ${range.label}: DL済みデータは十分あります。`
        : `${symbol} ${interval} / ${range.label}: DL済みデータが一部不足しています。`,
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

function normalizeOccurrenceReferenceDays(body = {}) {
  return normalizeAnalysisCacheDays(body.occurrence_reference_days || body.reference_days || body.virtual_fill_reference_days, 30);
}

function normalizeOccurrenceWindowMinutes(value) {
  const n = safeInt(value, 15);
  return [1, 5, 15, 30].includes(n) ? n : 15;
}

function normalizeOccurrenceDirection(value) {
  const text = String(value || 'up').trim();
  return ['up', 'down', 'either'].includes(text) ? text : 'up';
}

function occurrenceDirectionLabel(direction) {
  if (direction === 'down') return '下方向（指定窓内の下落幅）';
  if (direction === 'either') return '上下どちらか（指定窓内の値幅）';
  return '上方向（買って利確）';
}

function countRequiredMoveWindows(rows, requiredMovePct, windowMinutes, direction) {
  const cleanRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      time_ms: safeFloat(row.open_time_ms, NaN),
      open: safeFloat(row.open, NaN),
      high: safeFloat(row.high, NaN),
      low: safeFloat(row.low, NaN),
    }))
    .filter((row) => Number.isFinite(row.time_ms)
      && Number.isFinite(row.open) && row.open > 0
      && Number.isFinite(row.high)
      && Number.isFinite(row.low))
    .sort((a, b) => a.time_ms - b.time_ms);
  const span = normalizeOccurrenceWindowMinutes(windowMinutes);
  if (cleanRows.length < span) {
    return { window_count: 0, matched_window_count: 0 };
  }
  const directionMode = normalizeOccurrenceDirection(direction);
  const stepMs = INTERVAL_MS['1m'];
  let windowCount = 0;
  let matched = 0;
  for (let i = 0; i <= cleanRows.length - span; i += 1) {
    const start = cleanRows[i];
    const end = cleanRows[i + span - 1];
    // 欠損がある窓は判定から外します。1分足の連続性がある窓だけを見るためです。
    if (!Number.isFinite(start.time_ms) || !Number.isFinite(end.time_ms)) continue;
    if ((end.time_ms - start.time_ms) > (span - 1) * stepMs + 1000) continue;
    const subset = cleanRows.slice(i, i + span);
    const maxHigh = Math.max(...subset.map((row) => row.high));
    const minLow = Math.min(...subset.map((row) => row.low));
    const upTarget = start.open * (1 + requiredMovePct / 100);
    const downTarget = start.open * (1 - requiredMovePct / 100);
    windowCount += 1;
    if (directionMode === 'up') {
      if (maxHigh >= upTarget) matched += 1;
    } else if (directionMode === 'down') {
      if (minLow <= downTarget) matched += 1;
    } else if (maxHigh >= upTarget || minLow <= downTarget) {
      matched += 1;
    }
  }
  return { window_count: windowCount, matched_window_count: matched };
}

async function estimateRequiredMoveOccurrenceRate(body = {}) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : 'BTCJPY';
  const referenceDays = normalizeOccurrenceReferenceDays(body);
  const windowMinutes = normalizeOccurrenceWindowMinutes(body.occurrence_window_minutes);
  const direction = normalizeOccurrenceDirection(body.occurrence_direction);
  const window = analysisCacheWindow(referenceDays);
  try {
    const target = Math.max(0, safeFloat(body.target_profit_jpy));
    const capital = Math.max(1, safeFloat(body.capital_jpy, 1));
    const maxOpp = Math.max(1, safeInt(body.max_opportunities, 1));
    const expectedSuccessCount = Math.max(1, safeInt(body.expected_success_count, maxOpp));
    const costPct = Math.max(0, safeFloat(body.roundtrip_cost_pct, 0.28));
    const perTradeTarget = target / expectedSuccessCount;
    const requiredMovePct = (perTradeTarget / capital) * 100 + costPct;
    const cache = await analysisRowsForWindow({ symbol, start_ms: window.start_ms, end_ms: window.end_ms });
    const rows = (cache.rows || []).filter((row) => {
      const open = safeFloat(row.open, NaN);
      const high = safeFloat(row.high, NaN);
      const low = safeFloat(row.low, NaN);
      const t = safeFloat(row.open_time_ms, NaN);
      return Number.isFinite(t) && t >= window.start_ms && t < window.end_ms
        && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && open > 0;
    });
    const expectedRows = expectedRowsForAnalysisWindow(window.start_ms, window.end_ms);
    const coverage = expectedRows > 0 ? rows.length / expectedRows : 0;
    const qualityLabel = rows.length <= 0
      ? '不足'
      : coverage >= 0.95
        ? '良好'
        : coverage >= 0.5
          ? '一部不足'
          : '不足';
    const period = summarizeReferencePeriod(rows);
    const referencedFiles = Array.isArray(cache.files) ? cache.files.map((file) => path.basename(file)) : [];
    const baseMeta = {
      symbol,
      interval: '1m',
      reference_scope: 'analysis_cache',
      reference_scope_label: `分析用1分足キャッシュ（直近${referenceDays}日）`,
      reference_days: referenceDays,
      window_minutes: windowMinutes,
      direction,
      direction_label: occurrenceDirectionLabel(direction),
      referenced_files: referencedFiles,
      referenced_file_count: referencedFiles.length,
      selected_file_count: referencedFiles.length,
      referenced_row_count: rows.length,
      expected_row_count: expectedRows,
      missing_count: Math.max(0, expectedRows - rows.length),
      coverage_pct: coverage * 100,
      quality_label: qualityLabel,
      source: cache.source || 'analysis_cache',
      csv_row_count: cache.csv_row_count,
      db_row_count: cache.db_row_count,
      db_enabled: cache.db_enabled,
      include_unclosed_candle: false,
      matched_row_count: 0,
      matched_window_count: 0,
      window_count: 0,
      required_move_pct: requiredMovePct,
      target_profit_jpy: target,
      expected_success_count: expectedSuccessCount,
      per_trade_target_jpy: perTradeTarget,
      reference_period_start_jst: period.start_jst,
      reference_period_end_jst: period.end_jst,
      reference_period_text: period.text || `${window.start_jst} → ${window.end_jst}`,
    };
    if (rows.length < Math.max(10, windowMinutes)) {
      return {
        rate: null,
        required_move_pct: requiredMovePct,
        meta: baseMeta,
        note: `必要値幅の出現率: ${symbol} 1分足 / 直近${referenceDays}日の分析用キャッシュが不足しています（参照足数 ${rows.length}/${expectedRows}本）。必要値幅出現率はチャート表示日や最新DLファイルではなく、分析用1分足キャッシュで判定します。`,
      };
    }
    const counted = countRequiredMoveWindows(rows, requiredMovePct, windowMinutes, direction);
    const rate = counted.window_count ? Math.max(0, Math.min(100, (counted.matched_window_count / counted.window_count) * 100)) : null;
    const meta = {
      ...baseMeta,
      matched_row_count: counted.matched_window_count,
      matched_window_count: counted.matched_window_count,
      window_count: counted.window_count,
    };
    return {
      rate,
      required_move_pct: requiredMovePct,
      meta,
      note: `必要値幅の出現率: ${symbol} 1分足 / 直近${referenceDays}日 / ${windowMinutes}分判定窓 / ${occurrenceDirectionLabel(direction)}。${counted.window_count}窓のうち、1回あたり必要値幅 ${requiredMovePct.toFixed(3)}%（日次目標${target.toLocaleString('ja-JP')}円 ÷ 想定成功${expectedSuccessCount}回 = 1回${perTradeTarget.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円、コスト込み）を満たした窓は ${counted.matched_window_count}窓、${Number.isFinite(rate) ? rate.toFixed(1) : '—'}% でした。これは約定率ではなく、指定時間内に必要な値幅が出た頻度です。チャート表示日・最新DLファイルとは分離し、未確定足は除外しています。${period.text ? `\n${period.text}` : ''}`,
    };
  } catch (error) {
    return {
      rate: null,
      required_move_pct: null,
      meta: {
        symbol,
        interval: '1m',
        reference_scope: 'analysis_cache',
        reference_scope_label: `分析用1分足キャッシュ（直近${referenceDays}日）`,
        reference_days: referenceDays,
        window_minutes: windowMinutes,
        direction,
        direction_label: occurrenceDirectionLabel(direction),
        referenced_files: [],
        referenced_file_count: 0,
        selected_file_count: 0,
        referenced_row_count: 0,
        matched_row_count: 0,
        matched_window_count: 0,
        window_count: 0,
        quality_label: 'エラー',
        source: 'analysis_cache',
        error: error.message,
      },
      note: `必要値幅の出現率: ${error.message} のため、分析用1分足キャッシュで確認できませんでした。`,
    };
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
  const dbRows = await readLongDataRows(plan.merged_file);
  const dbResult = await dbStore.saveKlineRows(projectDir(), {
    symbol: plan.symbol,
    interval: plan.interval,
    rows: dbRows,
    requested_start_ms: plan.chunks[0]?.start_ms ?? null,
    requested_end_ms: plan.chunks[plan.chunks.length - 1]?.end_ms ?? null,
    source: 'binance_public_kline_csv_download',
    reference_source: 'long_data_csv_and_db',
    fetch_type: 'manual_history_download',
    purpose: 'fill_rate_calc',
    file_names: [path.basename(plan.merged_file)],
    status: errors.length === 0 ? 'ok' : 'partial',
    message: `履歴DLからDB Phase 1へ保存: ${dbRows.length}本`,
  });
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
    db_phase1: dbResult,
    message: `履歴DL完了: ${results.length}チャンク / merged ${mergedRows}行${errors.length ? ` / エラー ${errors.length}件` : ''}${dbResult.enabled ? ` / DB保存 ${dbResult.rows_inserted}追加 ${dbResult.rows_updated}更新` : ` / DB未有効: ${dbResult.error || dbResult.message || 'npm install が必要です'}`}`,
  };
}


async function updateDownloadedHistoryToNow(body = {}) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : 'BTCJPY';
  const interval = normalizeInterval(body.interval || '1m');
  const waitMs = Math.max(0, Math.min(5000, safeInt(body.wait_ms, 250)));
  const nowMs = Date.now();
  const endMs = body.include_unconfirmed === false
    ? currentOpenTimeMs(interval, nowMs)
    : nowMs;
  const step = INTERVAL_MS[interval] || INTERVAL_MS['1m'];
  const stateBefore = await latestDownloadedKlineState(symbol, interval);
  const fallbackHours = Math.max(1, Math.min(24, safeInt(body.fallback_hours, 6)));
  const fallbackStartMs = parseJstDateTime(jstDateTextFromMs(nowMs), 0, 0).getTime();
  const startMs = stateBefore.latest
    ? stateBefore.latest.open_time_ms + step
    : Math.max(fallbackStartMs, endMs - fallbackHours * 60 * 60 * 1000);

  if (startMs >= endMs) {
    const db = await dbStore.getDbStatus(projectDir());
    return {
      ok: true,
      symbol,
      interval,
      fetched_rows: 0,
      inserted_rows: 0,
      request_count: 0,
      files: [],
      file_names: [],
      errors: [],
      db_phase2: {
        enabled: db.enabled,
        db_file: db.db_file,
        counts: db.counts,
        message: db.message,
      },
      latest_before_jst: stateBefore.latest ? stateBefore.latest.open_time_jst : '',
      latest_after_jst: stateBefore.latest ? stateBefore.latest.open_time_jst : '',
      started_from_jst: formatJst(new Date(startMs)),
      updated_to_jst: formatJst(new Date(endMs)),
      unconfirmed_latest: false,
      fallback_used: !stateBefore.latest,
      message: `${symbol} ${interval}: 追加が必要な足はありません。DL済み履歴は現在時刻付近まであります。`,
    };
  }

  const fetched = await fetchKlineRowsBetween(symbol, interval, startMs, endMs, waitMs);
  const mergeResult = fetched.rows.length
    ? await mergeDownloadedRowsIntoDailyFiles(symbol, interval, fetched.rows)
    : { files: [], inserted_rows: 0 };
  const dbResult = await dbStore.saveKlineRows(projectDir(), {
    symbol,
    interval,
    rows: fetched.rows,
    requested_start_ms: startMs,
    requested_end_ms: endMs,
    source: 'binance_public_kline_incremental',
    reference_source: 'long_data_csv_and_db',
    fetch_type: stateBefore.latest ? 'incremental_update' : 'initial_backfill',
    purpose: interval === '1m' ? 'fill_rate_calc' : 'chart_display',
    file_names: mergeResult.files ? mergeResult.files.map((item) => path.basename(item.file)) : [],
    include_unclosed_candle: body.include_unconfirmed !== false,
    status: fetched.errors.length === 0 ? 'ok' : 'partial',
    message: `現在時刻まで差分更新からDB Phase 1へ保存: ${fetched.rows.length}本`,
  });
  const stateAfter = await latestDownloadedKlineState(symbol, interval);
  const latestOpen = stateAfter.latest?.open_time_ms ?? stateBefore.latest?.open_time_ms ?? null;
  const unconfirmedLatest = Number.isFinite(latestOpen) ? latestOpen + step > nowMs : false;
  const fileNames = mergeResult.files.map((item) => path.basename(item.file));
  return {
    ok: fetched.errors.length === 0,
    symbol,
    interval,
    fetched_rows: fetched.rows.length,
    inserted_rows: mergeResult.inserted_rows,
    request_count: fetched.request_count,
    files: mergeResult.files,
    file_names: fileNames,
    errors: fetched.errors,
    db_phase1: dbResult,
    latest_before_jst: stateBefore.latest ? stateBefore.latest.open_time_jst : '',
    latest_after_jst: stateAfter.latest ? stateAfter.latest.open_time_jst : '',
    started_from_jst: formatJst(new Date(startMs)),
    updated_to_jst: formatJst(new Date(endMs)),
    unconfirmed_latest: unconfirmedLatest,
    fallback_used: !stateBefore.latest,
    message: fetched.rows.length
      ? `${symbol} ${interval}: ${formatJst(new Date(startMs))} から現在時刻まで差分DLしました。取得 ${fetched.rows.length}本 / 追加 ${mergeResult.inserted_rows}本 / 更新ファイル ${mergeResult.files.length}件。${dbResult.enabled ? `DB保存 ${dbResult.rows_inserted}追加 ${dbResult.rows_updated}更新。` : `DB未有効: ${dbResult.error || 'npm install が必要です'}。`}${unconfirmedLatest ? '最新足は未確定の可能性があります。' : ''}`
      : `${symbol} ${interval}: 取得できる新しい足はありませんでした。${fetched.errors.length ? ` エラー: ${fetched.errors.join(' / ')}` : ''}`,
  };
}


async function analysisCacheStatus(params = {}) {
  const referenceDays = normalizeAnalysisCacheDays(params.reference_days || params.days, 7);
  const symbols = normalizeAnalysisCacheSymbols(params.symbols || params.symbol);
  const window = analysisCacheWindow(referenceDays);
  const rows = [];
  for (const symbol of symbols) {
    const csvData = await downloadedKlineRowsForWindow({ symbol, interval: '1m', start_ms: window.start_ms, end_ms: window.end_ms });
    const dbStatus = await dbStore.getCandleRangeStatus(projectDir(), {
      symbol,
      interval: '1m',
      start_time_ms: window.start_ms,
      end_time_ms: window.end_ms,
      include_unclosed_candle: false,
    });
    rows.push(summarizeAnalysisCacheCoverage({ symbol, rows: csvData.rows, files: csvData.files, window, dbStatus }));
  }
  const totalExpected = rows.reduce((sum, row) => sum + Number(row.expected_row_count || 0), 0);
  const totalRows = rows.reduce((sum, row) => sum + Number(row.row_count || 0), 0);
  const enough = rows.length > 0 && rows.every((row) => row.enough);
  return {
    ok: true,
    symbols,
    interval: '1m',
    reference_days: referenceDays,
    retention_days: ANALYSIS_CACHE_RETENTION_DAYS,
    start_time_ms: window.start_ms,
    end_time_ms: window.end_ms,
    start_jst: window.start_jst,
    end_jst: window.end_jst,
    row_count: totalRows,
    expected_row_count: totalExpected,
    coverage_pct: totalExpected > 0 ? (totalRows / totalExpected) * 100 : 0,
    enough,
    rows,
    message: enough
      ? `分析用1分足キャッシュは直近${referenceDays}日分を概ね満たしています。`
      : `分析用1分足キャッシュが不足しています。直近${referenceDays}日分を整備できます。`,
  };
}

async function ensureAnalysisCache(body = {}) {
  const referenceDays = normalizeAnalysisCacheDays(body.reference_days || body.days, 7);
  const symbols = normalizeAnalysisCacheSymbols(body.symbols || body.symbol);
  const waitMs = Math.max(0, Math.min(5000, safeInt(body.wait_ms, 250)));
  const force = Boolean(body.force);
  const window = analysisCacheWindow(referenceDays);
  const results = [];
  for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    const before = await analysisCacheStatus({ symbols: [symbol], reference_days: referenceDays });
    const beforeRow = before.rows?.[0] || null;
    if (beforeRow?.enough && !force) {
      results.push({
        ok: true,
        symbol,
        interval: '1m',
        skipped: true,
        fetched_rows: 0,
        inserted_rows: 0,
        request_count: 0,
        before: beforeRow,
        after: beforeRow,
        message: `${symbol}: 直近${referenceDays}日分の分析用1分足キャッシュは既に十分あります。`,
      });
      continue;
    }
    const fetched = await fetchKlineRowsBetween(symbol, '1m', window.start_ms, window.end_ms, waitMs);
    const mergeResult = fetched.rows.length
      ? await mergeDownloadedRowsIntoDailyFiles(symbol, '1m', fetched.rows)
      : { files: [], inserted_rows: 0 };
    const dbResult = await dbStore.saveKlineRows(projectDir(), {
      symbol,
      interval: '1m',
      rows: fetched.rows,
      requested_start_ms: window.start_ms,
      requested_end_ms: window.end_ms,
      source: 'binance_public_kline_analysis_cache',
      reference_source: 'analysis_cache_csv_and_db',
      fetch_type: beforeRow?.row_count ? 'analysis_cache_refresh' : 'analysis_cache_initial_backfill',
      purpose: 'fill_rate_calc',
      file_names: mergeResult.files ? mergeResult.files.map((item) => path.basename(item.file)) : [],
      include_unclosed_candle: false,
      status: fetched.errors.length === 0 ? 'ok' : 'partial',
      message: `分析用1分足キャッシュ整備: ${symbol} 直近${referenceDays}日 ${fetched.rows.length}本`,
    });
    const after = await analysisCacheStatus({ symbols: [symbol], reference_days: referenceDays });
    const afterRow = after.rows?.[0] || null;
    results.push({
      ok: fetched.errors.length === 0,
      symbol,
      interval: '1m',
      skipped: false,
      fetched_rows: fetched.rows.length,
      inserted_rows: mergeResult.inserted_rows,
      request_count: fetched.request_count,
      errors: fetched.errors,
      file_names: (mergeResult.files || []).map((item) => path.basename(item.file)),
      db_phase1: dbResult,
      before: beforeRow,
      after: afterRow,
      message: `${symbol}: 直近${referenceDays}日分の1分足を取得 ${fetched.rows.length}本 / 追加 ${mergeResult.inserted_rows}本 / API回数 ${fetched.request_count}。${dbResult.enabled ? `DB保存 ${dbResult.rows_inserted}追加 ${dbResult.rows_updated}更新。` : `DB未有効: ${dbResult.error || 'npm install が必要です'}。`}`,
    });
  }
  const status = await analysisCacheStatus({ symbols, reference_days: referenceDays });
  return {
    ok: results.every((item) => item.ok),
    symbols,
    interval: '1m',
    reference_days: referenceDays,
    retention_days: ANALYSIS_CACHE_RETENTION_DAYS,
    start_jst: window.start_jst,
    end_jst: window.end_jst,
    results,
    status,
    message: `分析用1分足キャッシュ整備完了: ${symbols.join(', ')} / 直近${referenceDays}日 / 合計 ${status.row_count}/${status.expected_row_count}本 / カバー率 ${status.coverage_pct.toFixed(1)}%。`,
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

async function fetchSymbolTradeRules(symbol) {
  try {
    const data = await fetchJson('/api/v3/exchangeInfo', { symbol }, 12000);
    const item = Array.isArray(data.symbols) ? data.symbols[0] : null;
    if (!item) return null;
    const filterMap = Object.fromEntries((item.filters || []).map((f) => [f.filterType, f]));
    const priceFilter = filterMap.PRICE_FILTER || {};
    const lotSize = filterMap.LOT_SIZE || {};
    const minNotional = filterMap.MIN_NOTIONAL || filterMap.NOTIONAL || {};
    return {
      tick_size: safeFloat(priceFilter.tickSize, NaN),
      step_size: safeFloat(lotSize.stepSize, NaN),
      min_qty: safeFloat(lotSize.minQty, NaN),
      min_notional: safeFloat(minNotional.minNotional, NaN),
      source: '/api/v3/exchangeInfo',
    };
  } catch {
    return null;
  }
}

async function status() {
  const { source } = await currentPriceData();
  const { rows } = await readHistoryRows();
  const db = await dbStore.getDbStatus(projectDir());
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
    db_phase1: {
      enabled: db.enabled,
      db_file: db.db_file,
      counts: db.counts,
      message: db.message,
    },
    db_phase2: {
      enabled: db.enabled,
      db_file: db.db_file,
      counts: db.counts,
      latest_daily_goal_results: db.latest_daily_goal_results || [],
      message: db.message,
    },
  };
}

async function capabilities() {
  return {
    ok: true,
    version: VERSION,
    symbols: SYMBOLS,
    routes: {
      GET: ['status', 'capabilities', 'summary', 'impact', 'alert-preview', 'alert-history', 'daily-goal-reports', 'chart', 'chart-coverage', 'analysis-cache-status', 'contract', 'api-readiness', 'db-status'],
      POST: ['fetch-prices', 'download-history', 'update-history-to-now', 'ensure-analysis-cache', 'trade-preview', 'daily-goal', 'save-daily-goal-report', 'clear-alert-history', 'clear-daily-goal-reports'],
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
        GET: ['status', 'capabilities', 'summary', 'impact', 'alert-preview', 'alert-history', 'daily-goal-reports', 'chart', 'chart-coverage', 'api-readiness', 'db-status'],
        POST: ['fetch-prices', 'download-history', 'update-history-to-now', 'ensure-analysis-cache', 'trade-preview', 'daily-goal', 'save-daily-goal-report', 'clear-alert-history', 'clear-daily-goal-reports'],
      },
      note: 'API_CONTRACT.json が未配置のため簡易情報を返しています。',
    };
  }
  const text = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

async function dbStatus() {
  return dbStore.getDbStatus(projectDir());
}

async function summary() {
  const { symbols, source } = await currentPriceData();
  const memo = source === 'mock'
    ? 'price_history.csv が見つからないため、サンプル価格で表示しています。「現在価格を取得して保存」を押すと公開APIから価格を取得して履歴CSVへ保存します。'
    : `price_history.csv から最新価格を読みました。データ元: ${source}`;
  return { symbols, data_source: source, memo };
}

async function apiReadiness() {
  const { apiKey, apiSecret, keySource, secretSource } = credentialsFromEnv();
  const hasApiKey = Boolean(apiKey);
  const hasApiSecret = Boolean(apiSecret);
  let publicApiOk = false;
  let publicApiError = '';
  try {
    await fetchJson('/api/v3/time', {}, 8000);
    publicApiOk = true;
  } catch (error) {
    publicApiError = error.message;
  }
  let authApiOk = false;
  let authApiError = '';
  let accountType = '';
  let canTrade = null;
  let feeApiOk = false;
  let feeApiError = '';
  let feeSample = [];
  if (hasApiKey && hasApiSecret) {
    try {
      const account = await fetchSignedJson('/api/v3/account', {}, 10000);
      authApiOk = true;
      accountType = String(account.accountType || '');
      canTrade = typeof account.canTrade === 'boolean' ? account.canTrade : null;
    } catch (error) {
      authApiError = error.body ? `${error.message} ${error.body}` : error.message;
    }
    if (authApiOk) {
      try {
        const fees = await fetchSignedJson('/sapi/v1/asset/tradeFee', {}, 10000);
        const list = Array.isArray(fees) ? fees : [];
        feeApiOk = true;
        feeSample = list.slice(0, 5).map((row) => ({
          symbol: String(row.symbol || ''),
          makerCommission: safeFloat(row.makerCommission, NaN),
          takerCommission: safeFloat(row.takerCommission, NaN),
        }));
      } catch (error) {
        feeApiError = error.body ? `${error.message} ${error.body}` : error.message;
      }
    }
  }
  return {
    has_api_key: hasApiKey,
    has_api_secret: hasApiSecret,
    api_key_source: keySource,
    api_secret_source: secretSource,
    public_api_ok: publicApiOk,
    public_api_error: publicApiError,
    auth_api_ok: authApiOk,
    auth_api_error: authApiError,
    account_type: accountType,
    can_trade: canTrade,
    fee_api_ok: feeApiOk,
    fee_api_error: feeApiError,
    fee_sample: feeSample,
    fee_fetch_ready: Boolean(publicApiOk && hasApiKey && hasApiSecret && authApiOk),
    note: '読み取り専用チェックです。APIキー/Secretの保存処理は行いません。',
  };
}

async function impact(params = {}) {
  const { symbols } = await currentPriceData();
  return { rows: calculations.calculateImpactRows({ summaries: symbols, amountsText: params.amounts }) };
}

async function alertPreview(params = {}) {
  const windowMinutes = Math.max(1, Math.min(240, safeInt(params.window_minutes, 15)));
  const modeText = String(params.alert_mode || 'simple').trim().toLowerCase();
  const alertMode = ['simple', 'rolling', 'sustained'].includes(modeText) ? modeText : 'simple';
  const rollingMinPoints = Math.max(2, Math.min(20, safeInt(params.rolling_min_points, 3)));
  const risingRatioThreshold = Math.max(1, Math.min(100, safeFloat(params.alert_rising_ratio, 60)));
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
    let upSteps = 0;
    let totalSteps = 0;
    for (let i = windowRows.length - 1; i > 0; i -= 1) {
      const curr = windowRows[i];
      const prev = windowRows[i - 1];
      if (!curr || !prev || !Number.isFinite(curr.price) || !Number.isFinite(prev.price) || prev.price <= 0) break;
      const stepPct = ((curr.price - prev.price) / prev.price) * 100;
      totalSteps += 1;
      if (stepPct > 0) upSteps += 1;
      if (stepPct > 0) rollingStreak += 1;
      else break;
    }
    const risingRatio = totalSteps > 0 ? (upSteps / totalSteps) * 100 : 0;
    const simpleHit = movePct >= thresholdForSymbol;
    const rollingHit = rollingStreak >= rollingMinPoints && movePct >= Math.max(thresholdForSymbol * 0.4, 0.02);
    const sustainedHit = movePct >= thresholdForSymbol && risingRatio >= risingRatioThreshold;
    const hit = alertMode === 'rolling' ? rollingHit : alertMode === 'sustained' ? sustainedHit : simpleHit;
    return {
      symbol,
      status: hit
        ? (alertMode === 'rolling' ? 'ローリング上昇アラート' : alertMode === 'sustained' ? '持続上昇アラート' : '上昇アラート')
        : '監視中',
      move_pct: movePct,
      threshold_pct: thresholdForSymbol,
      streak_count: streakCount,
      rolling_streak: rollingStreak,
      rising_ratio: risingRatio,
      samples: windowRows.length,
      latest_price: latest.price,
      base_price: base.price,
      latest_time: formatJst(latest.timestamp),
    };
  });
  const alertCount = resultRows.filter((row) => String(row.status).includes('アラート')).length;
  const ranked = resultRows.filter((row) => Number.isFinite(row.move_pct)).sort((a, b) => b.move_pct - a.move_pct);
  const topAlert = ranked.length ? ranked[0] : null;
  let historySaved = 0;
  if (saveHistory && alertCount > 0) {
    const existing = await readAlertHistory();
    const nowText = nowJstIso();
    const appendItems = resultRows
      .filter((row) => String(row.status).includes('アラート'))
      .map((row) => ({
        timestamp_jst: nowText,
        symbol: row.symbol,
        move_pct: row.move_pct,
        threshold_pct: row.threshold_pct,
        window_minutes: windowMinutes,
        streak_count: row.streak_count,
        rising_ratio: row.rising_ratio,
      }));
    const merged = existing.concat(appendItems).slice(-historyLimit);
    await writeAlertHistory(merged);
    historySaved = appendItems.length;
  }
  return {
    alert_mode: alertMode,
    rolling_min_points: rollingMinPoints,
    alert_rising_ratio: risingRatioThreshold,
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
    'required_move_occurrence_rate_pct',
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
  const nowMsValue = Date.now();
  rows.forEach((row) => {
    lines.push([
      now,
      toCsvValue(daily.strategy_template || body.strategy_template || ''),
      toCsvValue(body.symbol || ''),
      safeFloat(body.target_profit_jpy, 0),
      safeFloat(body.capital_jpy, 0),
      safeFloat(daily.roundtrip_cost_pct, 0),
      safeFloat(daily.virtual_fill_rate_pct_used, 0),
      daily.required_move_occurrence_rate_pct === null || daily.required_move_occurrence_rate_pct === undefined ? '' : safeFloat(daily.required_move_occurrence_rate_pct, 0),
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

  const dbPhase2 = await dbStore.saveDailyGoalDiagnosis(projectDir(), {
    input: body,
    result: daily,
    created_at_ms: nowMsValue,
    calculated_at_ms: nowMsValue,
  });

  return {
    ok: true,
    rows_saved: rows.length,
    file,
    db_phase2: dbPhase2,
    message: `日次目標レポートをCSVに${rows.length}行保存しました。${dbPhase2.enabled ? `DB Phase 2にも保存しました（input ${dbPhase2.input_id}, result ${dbPhase2.result_id}）。` : `DB Phase 2は未保存: ${dbPhase2.error || dbPhase2.message || 'DB未有効'}`}`,
  };
}

async function dailyGoalReports(params = {}) {
  const limit = Math.max(1, Math.min(300, safeInt(params.limit, 20)));
  const file = dailyGoalReportFilePath();
  const dbLogs = await dbStore.getDailyGoalDiagnosisLogs(projectDir(), { limit });
  if (!fs.existsSync(file)) {
    return {
      rows: [],
      count: 0,
      limit,
      file,
      db_phase2: dbLogs,
    };
  }
  const text = await fs.promises.readFile(file, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return {
      rows: [],
      count: 0,
      limit,
      file,
      db_phase2: dbLogs,
    };
  }
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
    db_phase2: dbLogs,
  };
}

async function clearDailyGoalReports() {
  const file = dailyGoalReportFilePath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, '', 'utf8');
  const dbPhase2 = await dbStore.clearDailyGoalDiagnosisLogs(projectDir());
  return {
    ok: true,
    message: dbPhase2.enabled
      ? 'daily_goal_reports.csv と DB Phase 2 の日次目標診断ログをクリアしました。'
      : `daily_goal_reports.csv をクリアしました。DB Phase 2 は未クリア: ${dbPhase2.error || dbPhase2.message || 'DB未有効'}`,
    file,
    db_phase2: dbPhase2,
  };
}

async function chart(params = {}) {
  const symbol = SYMBOLS.includes(params.symbol) ? params.symbol : 'BTCJPY';
  const sourceMode = params.source || 'combined';
  const intervalRequested = params.interval || 'auto';
  const rangeKey = params.range || '24h';
  const limit = Math.min(Math.max(safeInt(params.limit, 500), 2), 1200);
  let { points } = await localChartPoints(symbol, limit);
  let usedSource = 'local-history';
  let message = 'ローカル price_history.csv からチャートを作成しました。';
  let chartRange = null;
  let actualInterval = intervalRequested === 'auto' ? '1m' : intervalRequested;
  let rawRows = points.length;
  let sampled = false;
  const errors = [];

  if (sourceMode === 'downloaded' || sourceMode === 'combined') {
    actualInterval = KLINE_INTERVALS.includes(intervalRequested) ? intervalRequested : '1m';
    try {
      const rangeSelection = normalizeChartRange(rangeKey);
      const downloaded = await downloadedChartPointsForRange({
        symbol,
        interval: actualInterval,
        range: rangeKey,
      });
      const downloadedPoints = downsampleChartPoints(downloaded.points, limit);
      rawRows = downloaded.points.length;
      chartRange = downloaded.range || rangeSelection;
      if (sourceMode === 'downloaded') {
        points = downloadedPoints;
        usedSource = 'downloaded-kline';
        message = downloadedPoints.length
          ? `long_data のDL済み ${actualInterval} 足から ${chartRange.label} のチャートを作成しました（参照ファイル${downloaded.files?.length || 0}件）。`
          : `選択範囲のDL済みデータが見つかりません。グラフ更新時のDL確認で「はい」を選ぶか、履歴データDLを実行してください。対象: ${downloaded.planned_file}`;
      } else {
        // DL+ は price_history.csv の現在価格スナップショットを混ぜず、
        // long_data/DBへ保存されたklineだけで表示します。
        // 現在時刻までの補完は「現在価格＋履歴を現在まで更新」または
        // グラフ更新時の不足分DLでklineとして保存してから反映します。
        points = downloadedPoints;
        rawRows = downloaded.points.length;
        usedSource = 'downloaded-kline-current';
        message = downloadedPoints.length
          ? `long_data のDL済み ${actualInterval} 足だけで ${chartRange.label} のチャートを作成しました（参照ファイル${downloaded.files?.length || 0}件）。price_history.csv は混ぜていません。`
          : `選択範囲のDL済みklineデータが見つかりません。グラフ更新時のDL確認で「はい」を選んでください。対象: ${downloaded.planned_file}`;
      }
    } catch (error) {
      errors.push(error.message);
      points = sourceMode === 'combined' ? points : [];
      rawRows = points.length;
      usedSource = sourceMode === 'combined' ? 'local-history' : 'downloaded-kline';
      message = sourceMode === 'combined'
        ? 'DL済み過去データを読めなかったため、ローカル履歴だけで表示しています。'
        : 'DL済み過去データを読めませんでした。履歴データDLの日付と時間帯を確認してください。';
    }
  }

  if (sourceMode === 'klines' || (sourceMode === 'local' && points.length < 2)) {
    try {
      const result = await fetchKlinesForChartRange({
        symbol,
        interval: intervalRequested,
        range: rangeKey,
        limit,
      });
      points = result.points;
      actualInterval = result.interval;
      chartRange = result.range;
      rawRows = result.raw_rows;
      sampled = result.sampled;
      usedSource = 'binance-klines';
      message = `Binance公開APIの ${result.range.label} / ${actualInterval} 足からチャートを作成しました。履歴CSVには保存していません。${sampled ? ` 表示用に${rawRows}本から${points.length}点へ間引きました。` : ''}`;
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
    source_mode: sourceMode,
    interval: actualInterval,
    interval_requested: intervalRequested,
    range: chartRange?.key || rangeKey,
    range_label: chartRange?.label || CHART_RANGE_LABELS[rangeKey] || rangeKey,
    range_start_jst: chartRange?.start_jst || '',
    range_end_jst: chartRange?.end_jst || '',
    raw_rows: rawRows,
    display_rows: points.length,
    sampled,
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
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : SYMBOLS[0];
  const rules = await fetchSymbolTradeRules(symbol);
  return calculations.calculateTradePreview({
    body: { ...body, symbol },
    summaries: symbols,
    mockPrices: MOCK_PRICES,
    symbols: SYMBOLS,
    symbolRules: rules,
  });
}


function normalizeVirtualFillSide(value) {
  return value === 'sell_limit' ? 'sell_limit' : 'buy_limit';
}

function virtualFillSideLabel(side) {
  return normalizeVirtualFillSide(side) === 'sell_limit'
    ? '売り指値（現在価格より上）'
    : '買い指値（現在価格より下）';
}

async function analysisRowsForWindow({ symbol, start_ms: startMs, end_ms: endMs } = {}) {
  const csvData = await downloadedKlineRowsForWindow({ symbol, interval: '1m', start_ms: startMs, end_ms: endMs });
  const dbRows = await dbStore.getCandleRows(projectDir(), {
    symbol,
    interval: '1m',
    start_time_ms: startMs,
    end_time_ms: endMs,
    include_unclosed_candle: false,
  });
  const csvRows = Array.isArray(csvData.rows) ? csvData.rows : [];
  const rows = dbRows.enabled && Array.isArray(dbRows.rows) && dbRows.rows.length >= csvRows.length
    ? dbRows.rows
    : csvRows;
  return {
    rows,
    files: csvData.files || [],
    source: dbRows.enabled && rows === dbRows.rows ? 'sqlite_candles' : 'long_data_csv',
    db_row_count: dbRows.row_count || 0,
    csv_row_count: csvRows.length,
    db_enabled: Boolean(dbRows.enabled),
    db_error: dbRows.error || '',
  };
}

async function estimateVirtualFillRate(body = {}, summary = null) {
  const enabled = body.virtual_fill_history_enabled !== false;
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : SYMBOLS[0];
  const side = normalizeVirtualFillSide(body.virtual_fill_side);
  const referenceDays = normalizeAnalysisCacheDays(body.virtual_fill_reference_days || body.reference_days, 30);
  const limitDistancePct = Math.max(0, safeFloat(body.limit_distance_pct, 0.2));
  const fillWindowMinutes = Math.max(1, Math.min(240, safeInt(body.virtual_fill_window_minutes || body.occurrence_window_minutes || body.holding_window_minutes, 15)));
  const fillWindowMs = fillWindowMinutes * 60 * 1000;
  const window = analysisCacheWindow(referenceDays);
  const currentPrice = safeFloat(summary?.price_jpy, NaN);
  const currentLimitPrice = Number.isFinite(currentPrice)
    ? (side === 'sell_limit' ? currentPrice * (1 + limitDistancePct / 100) : currentPrice * (1 - limitDistancePct / 100))
    : null;
  const baseMeta = {
    enabled,
    symbol,
    interval: '1m',
    reference_days: referenceDays,
    side,
    side_label: virtualFillSideLabel(side),
    limit_distance_pct: limitDistancePct,
    current_price: Number.isFinite(currentPrice) ? currentPrice : null,
    current_limit_price: Number.isFinite(currentLimitPrice) ? currentLimitPrice : null,
    include_unclosed_candle: false,
    start_time_ms: window.start_ms,
    end_time_ms: window.end_ms,
    reference_period_text: `${window.start_jst} → ${window.end_jst}`,
    referenced_row_count: 0,
    expected_row_count: expectedRowsForAnalysisWindow(window.start_ms, window.end_ms),
    matched_row_count: 0,
    start_row_count: 0,
    evaluation_window_minutes: fillWindowMinutes,
    quality_label: '未計算',
    source: 'analysis_cache',
    used_for_daily_goal: false,
  };
  if (!enabled) {
    return {
      rate: null,
      meta: { ...baseMeta, enabled: false, quality_label: 'OFF' },
      note: '仮想約定率の履歴試算はOFFです。手入力値を使います。',
    };
  }
  try {
    const cache = await analysisRowsForWindow({ symbol, start_ms: window.start_ms, end_ms: window.end_ms });
    const rows = (cache.rows || []).filter((row) => {
      const open = safeFloat(row.open, NaN);
      const high = safeFloat(row.high, NaN);
      const low = safeFloat(row.low, NaN);
      const t = safeFloat(row.open_time_ms, NaN);
      return Number.isFinite(t) && t >= window.start_ms && t < window.end_ms
        && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && open > 0;
    });
    rows.sort((a, b) => safeFloat(a.open_time_ms, 0) - safeFloat(b.open_time_ms, 0));
    const expected = expectedRowsForAnalysisWindow(window.start_ms, window.end_ms);
    const coverage = expected > 0 ? rows.length / expected : 0;
    const startRows = rows.filter((row) => {
      const t = safeFloat(row.open_time_ms, NaN);
      return Number.isFinite(t) && t + fillWindowMs <= window.end_ms;
    });
    let matched = 0;
    let searchStartIndex = 0;
    for (const startRow of startRows) {
      const startTime = safeFloat(startRow.open_time_ms, NaN);
      const open = safeFloat(startRow.open, NaN);
      if (!Number.isFinite(startTime) || !Number.isFinite(open) || open <= 0) continue;
      while (searchStartIndex < rows.length && safeFloat(rows[searchStartIndex].open_time_ms, NaN) < startTime) {
        searchStartIndex += 1;
      }
      const target = side === 'sell_limit'
        ? open * (1 + limitDistancePct / 100)
        : open * (1 - limitDistancePct / 100);
      const endTimeExclusive = startTime + fillWindowMs;
      let touched = false;
      for (let i = searchStartIndex; i < rows.length; i += 1) {
        const row = rows[i];
        const t = safeFloat(row.open_time_ms, NaN);
        if (!Number.isFinite(t)) continue;
        if (t >= endTimeExclusive) break;
        const high = safeFloat(row.high, NaN);
        const low = safeFloat(row.low, NaN);
        if (side === 'sell_limit') {
          if (Number.isFinite(high) && high >= target) { touched = true; break; }
        } else if (Number.isFinite(low) && low <= target) {
          touched = true; break;
        }
      }
      if (touched) matched += 1;
    }
    const rate = startRows.length ? Math.max(0, Math.min(100, (matched / startRows.length) * 100)) : null;
    const qualityLabel = rows.length <= 0
      ? '不足'
      : coverage >= 0.95
        ? '良好'
        : coverage >= 0.5
          ? '一部不足'
          : '不足';
    const meta = {
      ...baseMeta,
      referenced_row_count: rows.length,
      expected_row_count: expected,
      missing_count: Math.max(0, expected - rows.length),
      matched_row_count: matched,
      start_row_count: startRows.length,
      evaluation_window_minutes: fillWindowMinutes,
      coverage_pct: coverage * 100,
      quality_label: qualityLabel,
      source: cache.source,
      csv_row_count: cache.csv_row_count,
      db_row_count: cache.db_row_count,
      db_enabled: cache.db_enabled,
      referenced_files: (cache.files || []).map((file) => path.basename(file)),
      referenced_file_count: (cache.files || []).length,
      used_for_daily_goal: Number.isFinite(rate),
    };
    if (startRows.length < 10 || !Number.isFinite(rate)) {
      return {
        rate: null,
        meta: { ...meta, used_for_daily_goal: false },
        note: `指値到達率: ${symbol} 1分足 / 直近${referenceDays}日の分析用キャッシュが不足しています（判定起点 ${startRows.length}/${expected}本）。手入力値を代替使用します。`,
      };
    }
    return {
      rate,
      meta,
      note: `指値到達率: ${symbol} 1分足 / 直近${referenceDays}日 / ${virtualFillSideLabel(side)} / 指値距離 ${limitDistancePct.toFixed(3)}% / 判定窓 ${fillWindowMinutes}分以内。判定起点${startRows.length}本のうち価格到達は${matched}本、${rate.toFixed(1)}%でした。これは実約定率ではなく、過去データ上の価格到達率です。未確定足と判定窓が足りない末尾足は除外しています。`,
    };
  } catch (error) {
    return {
      rate: null,
      meta: { ...baseMeta, quality_label: 'エラー', error: error.message, used_for_daily_goal: false },
      note: `仮想約定率: ${error.message} のため履歴試算できませんでした。手入力値を代替使用します。`,
    };
  }
}

async function dailyGoal(body = {}) {
  const { symbols } = await currentPriceData();
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : SYMBOLS[0];
  const summary = symbols.find((item) => item.symbol === symbol);
  const manualFillRate = Math.max(0, Math.min(100, safeFloat(body.virtual_fill_rate_pct, 70)));
  const autoEnabled = body.virtual_fill_rate_auto !== false;
  const occurrence = autoEnabled ? await estimateRequiredMoveOccurrenceRate(body) : null;
  const virtualFill = await estimateVirtualFillRate(body, summary);
  const historyFillRate = Number.isFinite(virtualFill?.rate) ? Math.max(0, Math.min(100, safeFloat(virtualFill.rate))) : null;
  const fillRateUsed = historyFillRate === null ? manualFillRate : historyFillRate;
  const fillRateNote = historyFillRate === null
    ? `${virtualFill?.note || '仮想約定率の履歴試算は使えませんでした。'} 手入力値 ${manualFillRate.toFixed(1)}% を代替使用します。`
    : `${virtualFill.note} 日次目標の仮想約定率として ${fillRateUsed.toFixed(1)}% を使います。`;
  const result = calculations.calculateDailyGoal({
    ...body,
    // 必要利確価格ベースの指値候補診断で使う現在価格。
    // ここで渡さないと、日次目標側では現在価格を持てず、候補表が未計算になる。
    current_price_jpy: Number.isFinite(summary?.price_jpy) ? summary.price_jpy : null,
    current_price_source: summary?.timestamp ? 'price_history' : 'mock_or_latest_summary',
    virtual_fill_rate_pct: fillRateUsed,
    virtual_fill_rate_pct_used: fillRateUsed,
    virtual_fill_rate_note: fillRateNote,
    virtual_fill_evaluation_window_minutes: virtualFill?.meta?.evaluation_window_minutes || body.virtual_fill_window_minutes || body.occurrence_window_minutes || 15,
    required_move_occurrence_rate_pct: Number.isFinite(occurrence?.rate) ? occurrence.rate : null,
    required_move_occurrence_note: autoEnabled
      ? (occurrence?.note || '必要値幅の出現率: 履歴ベース確認を試しましたが、参考値は作れませんでした。')
      : '必要値幅の出現率: 履歴確認はOFFです。',
    required_move_occurrence_required_pct: Number.isFinite(occurrence?.required_move_pct) ? occurrence.required_move_pct : null,
    required_move_occurrence_meta: occurrence?.meta || null,
    recent_move_pct: body.recent_move_pct ?? summary?.short_pct ?? 0,
    recent_move_label: summary?.timestamp ? `${symbol} 短期値動き` : `${symbol} 短期値動き`,
  });
  return {
    ...result,
    virtual_fill_history_rate_pct: historyFillRate,
    virtual_fill_history_note: virtualFill?.note || '',
    virtual_fill_history_meta: virtualFill?.meta || null,
    virtual_fill_manual_fallback_pct: manualFillRate,
  };
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
    case 'chart-coverage': return chartDataCoverage(query);
    case 'analysis-cache-status': return analysisCacheStatus(query);
    case 'contract': return contract();
    case 'api-readiness': return apiReadiness();
    case 'db-status': return dbStatus();
    case 'fetch-prices': return fetchPrices();
    case 'download-history': return downloadHistoricalKlines(body);
    case 'update-history-to-now': return updateDownloadedHistoryToNow(body);
    case 'ensure-analysis-cache': return ensureAnalysisCache(body);
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
  dbStatus,
  chart,
  chartDataCoverage,
  analysisCacheStatus,
  ensureAnalysisCache,
  downloadHistoricalKlines,
  updateDownloadedHistoryToNow,
  buildKlineDownloadPlan,
  fetchPrices,
  tradePreview,
  dailyGoal,
  saveDailyGoalReport,
  dailyGoalReports,
  clearDailyGoalReports,
  calculations,
};
