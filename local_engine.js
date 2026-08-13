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

function isBlankInput(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function safeNonNegativeFloat(value, fallback = 0) {
  if (isBlankInput(value)) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function parseBooleanInput(value, fallback = false) {
  if (value === true || value === false) return value;
  if (isBlankInput(value)) return fallback;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return fallback;
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
      GET: ['status', 'capabilities', 'summary', 'impact', 'alert-preview', 'alert-history', 'daily-goal-reports', 'chart', 'chart-coverage', 'analysis-cache-status', 'contract', 'api-readiness', 'cost-estimate', 'db-status'],
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
        GET: ['status', 'capabilities', 'summary', 'impact', 'alert-preview', 'alert-history', 'daily-goal-reports', 'chart', 'chart-coverage', 'api-readiness', 'cost-estimate', 'db-status'],
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


function commissionRateToPct(value, fallbackPct = 0.1) {
  const n = safeFloat(value, NaN);
  if (!Number.isFinite(n) || n < 0) return fallbackPct;
  return n <= 1 ? n * 100 : n;
}

async function fetchTradeFeeMap(targetSymbols = []) {
  const { apiKey, apiSecret } = credentialsFromEnv();
  const fallbackRows = Object.fromEntries(targetSymbols.map((symbol) => [symbol, {
    symbol,
    maker_fee_pct: 0.1,
    taker_fee_pct: 0.1,
    source: 'fallback_default_fee',
  }]));
  if (!apiKey || !apiSecret) {
    return {
      ok: false,
      source: 'fallback_default_fee',
      error: 'APIキー/Secret未設定のため、手数料は仮値0.10%を使用します。',
      rows: fallbackRows,
    };
  }
  try {
    const fees = await fetchSignedJson('/sapi/v1/asset/tradeFee', {}, 10000);
    const list = Array.isArray(fees) ? fees : [];
    const rows = { ...fallbackRows };
    targetSymbols.forEach((symbol) => {
      const row = list.find((item) => String(item.symbol || '') === symbol);
      if (!row) return;
      rows[symbol] = {
        symbol,
        maker_fee_pct: commissionRateToPct(row.makerCommission, 0.1),
        taker_fee_pct: commissionRateToPct(row.takerCommission, 0.1),
        source: 'tradeFee_api',
      };
    });
    return { ok: true, source: 'tradeFee_api', error: '', rows };
  } catch (error) {
    return {
      ok: false,
      source: 'fallback_default_fee',
      error: error.body ? `${error.message} ${error.body}` : error.message,
      rows: fallbackRows,
    };
  }
}

function normalizeOrderAssumption(value) {
  const text = String(value || 'market').trim().toLowerCase();
  return ['market', 'limit', 'limit_fill_priority', 'limit_price_priority', 'manual'].includes(text) ? text : 'market';
}

function normalizeEstimateStyle(value) {
  const text = String(value || 'standard').trim().toLowerCase();
  return ['standard', 'strict', 'manual'].includes(text) ? text : 'standard';
}

function orderAssumptionMeta(orderAssumption) {
  const map = {
    market: {
      label: '成行想定',
      fee_mode: 'taker',
      note: 'taker手数料・スプレッド・板滑りを反映します。急変時や成行寄りの確認用です。',
      risk: '約定しやすい一方、価格ズレと滑りが重くなりやすい想定です。',
    },
    limit: {
      label: '指値想定',
      fee_mode: 'maker',
      note: 'maker手数料を中心に見ます。ただし未約定リスクは別途確認が必要です。',
      risk: 'コストは軽めに見えますが、指値に届かない可能性があります。',
    },
    limit_fill_priority: {
      label: '約定優先の指値',
      fee_mode: 'maker',
      note: '現在価格に近い指値を想定します。約定しやすさを優先する代わりに価格の有利さは小さめです。',
      risk: '約定しやすい一方、値幅とコストの余裕は小さくなりやすい想定です。',
    },
    limit_price_priority: {
      label: '価格優先の指値',
      fee_mode: 'maker',
      note: '深めの指値を想定します。価格は有利でも約定しにくく、下落中に刺さる可能性があります。',
      risk: '価格は有利ですが、未約定や刺さった後の逆行リスクを強めに確認します。',
    },
    manual: {
      label: '手動補正',
      fee_mode: 'taker',
      note: '手入力のコスト目安を優先して確認します。',
      risk: '手動補正値の妥当性を別途確認してください。',
    },
  };
  return map[orderAssumption] || map.market;
}

function estimateStyleMeta(estimateStyle, safetyBufferInput) {
  const manual = Number.isFinite(safetyBufferInput) ? safetyBufferInput : 0.05;
  const map = {
    standard: { label: '標準', safety_buffer_pct: 0.05, depth_multiplier: 1.0, spread_multiplier: 1.0 },
    strict: { label: '厳しめ', safety_buffer_pct: 0.08, depth_multiplier: 1.5, spread_multiplier: 1.15 },
    manual: { label: '手動', safety_buffer_pct: manual, depth_multiplier: 1.0, spread_multiplier: 1.0 },
  };
  return map[estimateStyle] || map.standard;
}

function parseDepthLevels(levels = []) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: safeFloat(level[0], NaN), qty: safeFloat(level[1], NaN) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.qty) && level.price > 0 && level.qty > 0);
}

function consumeQuote(levels, quoteAmount) {
  let remaining = quoteAmount;
  let baseQty = 0;
  let quoteUsed = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const levelQuote = level.price * level.qty;
    const useQuote = Math.min(remaining, levelQuote);
    const useQty = useQuote / level.price;
    quoteUsed += useQuote;
    baseQty += useQty;
    remaining -= useQuote;
  }
  return {
    base_qty: baseQty,
    quote_used: quoteUsed,
    avg_price: baseQty > 0 ? quoteUsed / baseQty : null,
    enough_depth: quoteUsed >= quoteAmount * 0.999,
    coverage_pct: quoteAmount > 0 ? (quoteUsed / quoteAmount) * 100 : null,
  };
}

function consumeBase(levels, baseAmount) {
  let remaining = baseAmount;
  let baseUsed = 0;
  let quoteReceived = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const useQty = Math.min(remaining, level.qty);
    baseUsed += useQty;
    quoteReceived += useQty * level.price;
    remaining -= useQty;
  }
  return {
    base_qty: baseUsed,
    quote_received: quoteReceived,
    avg_price: baseUsed > 0 ? quoteReceived / baseUsed : null,
    enough_depth: baseUsed >= baseAmount * 0.999,
    coverage_pct: baseAmount > 0 ? (baseUsed / baseAmount) * 100 : null,
  };
}

async function fetchDepthCostRow(symbol, amountJpy) {
  try {
    const data = await fetchJson('/api/v3/depth', { symbol, limit: 100 }, 10000);
    const bids = parseDepthLevels(data.bids);
    const asks = parseDepthLevels(data.asks);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : null;
    const spreadPct = Number.isFinite(bestBid) && Number.isFinite(bestAsk) && mid > 0 && bestAsk >= bestBid
      ? ((bestAsk - bestBid) / mid) * 100
      : null;
    const buy = Number.isFinite(amountJpy) && amountJpy > 0 ? consumeQuote(asks, amountJpy) : null;
    const sell = buy && Number.isFinite(buy.base_qty) && buy.base_qty > 0 ? consumeBase(bids, buy.base_qty) : null;
    const buySlippagePct = buy && Number.isFinite(buy.avg_price) && Number.isFinite(bestAsk) && Number.isFinite(mid) && mid > 0
      ? Math.max(0, ((buy.avg_price - bestAsk) / mid) * 100)
      : null;
    const sellSlippagePct = sell && Number.isFinite(sell.avg_price) && Number.isFinite(bestBid) && Number.isFinite(mid) && mid > 0
      ? Math.max(0, ((bestBid - sell.avg_price) / mid) * 100)
      : null;
    const depthSlippagePct = Number.isFinite(buySlippagePct) || Number.isFinite(sellSlippagePct)
      ? (Number.isFinite(buySlippagePct) ? buySlippagePct : 0) + (Number.isFinite(sellSlippagePct) ? sellSlippagePct : 0)
      : null;
    return {
      ok: Number.isFinite(spreadPct),
      bid_price: bestBid,
      ask_price: bestAsk,
      mid_price: mid,
      spread_pct: Number.isFinite(spreadPct) ? spreadPct : null,
      buy_avg_price: buy?.avg_price ?? null,
      sell_avg_price: sell?.avg_price ?? null,
      buy_slippage_pct: Number.isFinite(buySlippagePct) ? buySlippagePct : null,
      sell_slippage_pct: Number.isFinite(sellSlippagePct) ? sellSlippagePct : null,
      depth_slippage_pct: Number.isFinite(depthSlippagePct) ? depthSlippagePct : null,
      depth_buy_coverage_pct: buy?.coverage_pct ?? null,
      depth_sell_coverage_pct: sell?.coverage_pct ?? null,
      enough_depth: Boolean((buy?.enough_depth ?? false) && (sell?.enough_depth ?? false)),
      source: 'depth',
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      bid_price: null,
      ask_price: null,
      mid_price: null,
      spread_pct: null,
      buy_avg_price: null,
      sell_avg_price: null,
      buy_slippage_pct: null,
      sell_slippage_pct: null,
      depth_slippage_pct: null,
      depth_buy_coverage_pct: null,
      depth_sell_coverage_pct: null,
      enough_depth: false,
      source: 'unavailable',
      error: error.message || String(error),
    };
  }
}

function costComponentForOrder({ orderAssumption, fee, depth, estimateStyle, safetyBufferInput }) {
  const order = orderAssumptionMeta(orderAssumption);
  const style = estimateStyleMeta(estimateStyle, safetyBufferInput);
  const makerRoundtripPct = safeNonNegativeFloat(fee.maker_fee_pct, 0.1) * 2;
  const takerRoundtripPct = safeNonNegativeFloat(fee.taker_fee_pct, 0.1) * 2;
  const spreadPct = Number.isFinite(depth.spread_pct) ? depth.spread_pct : 0;
  const depthSlippagePct = Number.isFinite(depth.depth_slippage_pct) ? depth.depth_slippage_pct : 0;
  let feeRoundtripPct = order.fee_mode === 'maker' ? makerRoundtripPct : takerRoundtripPct;
  let spreadUsedPct = 0;
  let depthSlippageUsedPct = 0;
  let safetyBufferPct = style.safety_buffer_pct;
  let spreadApplication = 'not_applied';
  let depthApplication = 'not_applied';
  let spreadApplicationLabel = '直接反映なし';
  let depthApplicationLabel = '直接反映なし';

  if (orderAssumption === 'market') {
    spreadUsedPct = spreadPct * style.spread_multiplier;
    depthSlippageUsedPct = depthSlippagePct * style.depth_multiplier;
    spreadApplication = 'applied';
    depthApplication = 'applied';
    spreadApplicationLabel = '成行想定として反映';
    depthApplicationLabel = '板消費を反映';
  } else if (orderAssumption === 'limit_fill_priority') {
    spreadUsedPct = spreadPct * 0.35 * style.spread_multiplier;
    depthSlippageUsedPct = depthSlippagePct * 0.15 * style.depth_multiplier;
    spreadApplication = 'partial';
    depthApplication = 'partial';
    spreadApplicationLabel = '約定優先の指値として一部反映';
    depthApplicationLabel = '約定優先の指値として一部反映';
  } else if (orderAssumption === 'limit_price_priority') {
    spreadUsedPct = 0;
    depthSlippageUsedPct = 0;
    safetyBufferPct *= 0.8;
    spreadApplicationLabel = '価格優先の指値では直接反映なし';
    depthApplicationLabel = '価格優先の指値では直接反映なし';
  } else if (orderAssumption === 'limit') {
    spreadUsedPct = 0;
    depthSlippageUsedPct = 0;
    spreadApplicationLabel = '指値想定では直接反映なし';
    depthApplicationLabel = '指値想定では直接反映なし';
  } else if (orderAssumption === 'manual') {
    spreadUsedPct = spreadPct * 0.5;
    depthSlippageUsedPct = depthSlippagePct * 0.5;
    spreadApplication = 'partial';
    depthApplication = 'partial';
    spreadApplicationLabel = '手動補正として一部反映';
    depthApplicationLabel = '手動補正として一部反映';
  }
  const estimatedCostPct = feeRoundtripPct + spreadUsedPct + depthSlippageUsedPct + safetyBufferPct;
  return {
    order,
    style,
    maker_roundtrip_pct: makerRoundtripPct,
    taker_roundtrip_pct: takerRoundtripPct,
    fee_roundtrip_pct: feeRoundtripPct,
    spread_used_pct: spreadUsedPct,
    spread_application: spreadApplication,
    spread_application_label: spreadApplicationLabel,
    depth_slippage_used_pct: depthSlippageUsedPct,
    depth_application: depthApplication,
    depth_application_label: depthApplicationLabel,
    safety_buffer_pct: safetyBufferPct,
    estimated_cost_pct: estimatedCostPct,
  };
}

async function costEstimate(params = {}) {
  const selectedSymbols = Array.isArray(params.symbols)
    ? params.symbols
    : String(params.symbols || '').split(',').map((v) => String(v).trim()).filter(Boolean);
  const targetSymbols = selectedSymbols.length
    ? SYMBOLS.filter((symbol) => selectedSymbols.includes(symbol))
    : SYMBOLS.slice();
  const amountJpy = Math.max(100, safeNonNegativeFloat(params.amount_jpy, 10000));
  const orderAssumption = normalizeOrderAssumption(params.order_assumption);
  const estimateStyle = normalizeEstimateStyle(params.estimate_style);
  const safetyBufferInput = isBlankInput(params.safety_buffer_pct) ? NaN : safeNonNegativeFloat(params.safety_buffer_pct, NaN);
  const thresholdPct = isBlankInput(params.threshold_pct) ? null : safeNonNegativeFloat(params.threshold_pct, NaN);
  const feeMap = await fetchTradeFeeMap(targetSymbols);
  const rows = [];
  for (const symbol of targetSymbols) {
    const fee = feeMap.rows[symbol] || { maker_fee_pct: 0.1, taker_fee_pct: 0.1, source: 'fallback_default_fee' };
    const depth = await fetchDepthCostRow(symbol, amountJpy);
    const component = costComponentForOrder({ orderAssumption, fee, depth, estimateStyle, safetyBufferInput });
    const gap = Number.isFinite(thresholdPct) ? thresholdPct - component.estimated_cost_pct : null;
    rows.push({
      symbol,
      amount_jpy: amountJpy,
      order_assumption: orderAssumption,
      order_label: component.order.label,
      estimate_style: estimateStyle,
      estimate_label: component.style.label,
      fee_source: fee.source || feeMap.source,
      fee_mode: component.order.fee_mode,
      maker_fee_pct: safeNonNegativeFloat(fee.maker_fee_pct, 0.1),
      taker_fee_pct: safeNonNegativeFloat(fee.taker_fee_pct, 0.1),
      maker_roundtrip_pct: component.maker_roundtrip_pct,
      taker_roundtrip_pct: component.taker_roundtrip_pct,
      fee_roundtrip_pct: component.fee_roundtrip_pct,
      bid_price: depth.bid_price,
      ask_price: depth.ask_price,
      mid_price: depth.mid_price,
      spread_pct: depth.spread_pct,
      spread_used_pct: component.spread_used_pct,
      spread_application: component.spread_application,
      spread_application_label: component.spread_application_label,
      buy_avg_price: depth.buy_avg_price,
      sell_avg_price: depth.sell_avg_price,
      buy_slippage_pct: depth.buy_slippage_pct,
      sell_slippage_pct: depth.sell_slippage_pct,
      depth_slippage_pct: depth.depth_slippage_pct,
      depth_slippage_used_pct: component.depth_slippage_used_pct,
      depth_application: component.depth_application,
      depth_application_label: component.depth_application_label,
      depth_buy_coverage_pct: depth.depth_buy_coverage_pct,
      depth_sell_coverage_pct: depth.depth_sell_coverage_pct,
      enough_depth: depth.enough_depth,
      depth_source: depth.source,
      depth_error: depth.error,
      safety_buffer_pct: component.safety_buffer_pct,
      estimated_cost_pct: component.estimated_cost_pct,
      threshold_pct: thresholdPct,
      threshold_gap_pct: Number.isFinite(gap) ? gap : null,
      order_note: component.order.note,
      risk_note: component.order.risk,
    });
  }
  const finiteCosts = rows.map((row) => row.estimated_cost_pct).filter((value) => Number.isFinite(value));
  const recommendedCostPct = finiteCosts.length ? Math.max(...finiteCosts) : 0.28;
  const orderMeta = orderAssumptionMeta(orderAssumption);
  const styleMeta = estimateStyleMeta(estimateStyle, safetyBufferInput);
  const usedFallbackFee = rows.some((row) => row.fee_source !== 'tradeFee_api');
  const usedDepthFallback = rows.some((row) => row.depth_source !== 'depth');
  const costVsThreshold = Number.isFinite(thresholdPct)
    ? thresholdPct - recommendedCostPct
    : null;
  const message = Number.isFinite(costVsThreshold)
    ? costVsThreshold >= 0
      ? `実取引寄りコストを更新しました。しきい値はコスト目安を ${costVsThreshold.toFixed(3)}% 上回っています。`
      : `実取引寄りコストを更新しました。しきい値はコスト目安を ${Math.abs(costVsThreshold).toFixed(3)}% 下回っています。小さな値動きは利益として残りにくい可能性があります。`
    : '実取引寄りコストを更新しました。';
  return {
    ok: true,
    symbols: targetSymbols,
    amount_jpy: amountJpy,
    order_assumption: orderAssumption,
    order_label: orderMeta.label,
    estimate_style: estimateStyle,
    estimate_label: styleMeta.label,
    safety_buffer_pct: styleMeta.safety_buffer_pct,
    fee_api_ok: feeMap.ok,
    fee_api_error: feeMap.error || '',
    used_fallback_fee: usedFallbackFee,
    used_depth_fallback: usedDepthFallback,
    threshold_pct: thresholdPct,
    recommended_cost_pct: recommendedCostPct,
    threshold_gap_pct: Number.isFinite(costVsThreshold) ? costVsThreshold : null,
    rows,
    source: `${feeMap.ok ? '手数料API' : '手数料仮値'} + ${usedDepthFallback ? '板一部未取得' : 'depth板'} + ${orderMeta.label} + ${styleMeta.label}`,
    message,
    note: '実注文はしません。APIキー/Secretは保存せず、読み取り用に一時参照するだけです。数値は注文想定ごとの確認材料であり、売買指示ではありません。',
  };
}


function medianNumber(values) {
  const nums = (values || []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function volumeLevelFromRatio(ratio) {
  if (!Number.isFinite(ratio)) return { level: 'unknown', label: '未取得', rank: 0 };
  if (ratio < 0.8) return { level: 'thin', label: '薄い', rank: 1 };
  if (ratio < 1.5) return { level: 'normal', label: '通常', rank: 2 };
  if (ratio < 2.5) return { level: 'thick', label: '厚い', rank: 3 };
  return { level: 'surge', label: '急増', rank: 4 };
}

function takerBuyLabel(ratio) {
  if (!Number.isFinite(ratio)) return '未取得';
  if (ratio >= 0.55) return '買い主導寄り';
  if (ratio <= 0.45) return '売り主導寄り';
  return '中立';
}

function klineMinuteSummary(items = [], windowMinutes = 15) {
  const sorted = (items || [])
    .filter((item) => Array.isArray(item) && Number.isFinite(Number(item[0])))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  if (sorted.length < Math.max(3, windowMinutes + 2)) return null;
  const windowSize = Math.max(1, Math.min(240, safeInt(windowMinutes, 15)));
  const current = sorted.slice(-windowSize);
  const baselineRaw = sorted.slice(0, Math.max(0, sorted.length - windowSize));
  const windows = [];
  for (let end = baselineRaw.length; end >= windowSize; end -= windowSize) {
    windows.push(baselineRaw.slice(end - windowSize, end));
    if (windows.length >= 24) break;
  }
  const sumWindow = (rows) => rows.reduce((acc, item) => {
    acc.volume += safeFloat(item[5], 0);
    acc.quoteVolume += safeFloat(item[7], 0);
    acc.tradeCount += safeFloat(item[8], 0);
    acc.takerBuyBaseVolume += safeFloat(item[9], 0);
    acc.takerBuyQuoteVolume += safeFloat(item[10], 0);
    return acc;
  }, { volume: 0, quoteVolume: 0, tradeCount: 0, takerBuyBaseVolume: 0, takerBuyQuoteVolume: 0 });
  const currentSum = sumWindow(current);
  const baselineSums = windows.map(sumWindow);
  const baselineVolume = medianNumber(baselineSums.map((row) => row.volume));
  const baselineQuoteVolume = medianNumber(baselineSums.map((row) => row.quoteVolume));
  const baselineTradeCount = medianNumber(baselineSums.map((row) => row.tradeCount));
  const volumeRatio = baselineVolume && baselineVolume > 0 ? currentSum.volume / baselineVolume : null;
  const quoteVolumeRatio = baselineQuoteVolume && baselineQuoteVolume > 0 ? currentSum.quoteVolume / baselineQuoteVolume : null;
  const tradeCountRatio = baselineTradeCount && baselineTradeCount > 0 ? currentSum.tradeCount / baselineTradeCount : null;
  const takerBuyRatio = currentSum.quoteVolume > 0 ? currentSum.takerBuyQuoteVolume / currentSum.quoteVolume : null;
  const currentVwap = currentSum.volume > 0 ? currentSum.quoteVolume / currentSum.volume : null;
  const volumeLevel = volumeLevelFromRatio(volumeRatio);
  const tradeLevel = volumeLevelFromRatio(tradeCountRatio);
  const first = current[0];
  const last = current[current.length - 1];
  return {
    ok: true,
    source: 'binance_klines',
    window_minutes: windowSize,
    baseline_window_count: windows.length,
    current_volume: currentSum.volume,
    current_quote_volume: currentSum.quoteVolume,
    current_trade_count: currentSum.tradeCount,
    current_vwap: Number.isFinite(currentVwap) ? currentVwap : null,
    baseline_volume_median: baselineVolume,
    baseline_quote_volume_median: baselineQuoteVolume,
    baseline_trade_count_median: baselineTradeCount,
    volume_ratio: Number.isFinite(volumeRatio) ? volumeRatio : null,
    quote_volume_ratio: Number.isFinite(quoteVolumeRatio) ? quoteVolumeRatio : null,
    trade_count_ratio: Number.isFinite(tradeCountRatio) ? tradeCountRatio : null,
    taker_buy_ratio: Number.isFinite(takerBuyRatio) ? takerBuyRatio : null,
    volume_level: volumeLevel.level,
    volume_label: volumeLevel.label,
    volume_rank: volumeLevel.rank,
    trade_count_level: tradeLevel.level,
    trade_count_label: tradeLevel.label,
    trade_count_rank: tradeLevel.rank,
    taker_buy_label: takerBuyLabel(takerBuyRatio),
    start_time_ms: Number(first?.[0]),
    end_time_ms: Number(last?.[0]),
  };
}

async function volumeContextForSymbol(symbol, windowMinutes = 15) {
  const normalizedSymbol = SYMBOLS.includes(symbol) ? symbol : 'BTCJPY';
  const windowSize = Math.max(1, Math.min(240, safeInt(windowMinutes, 15)));
  const limit = Math.max(windowSize + 8, Math.min(1000, windowSize * 24 + windowSize));
  try {
    const items = await fetchJson('/api/v3/klines', {
      symbol: normalizedSymbol,
      interval: '1m',
      limit,
    }, 10000);
    const context = klineMinuteSummary(items, windowSize);
    if (!context) {
      return {
        ok: false,
        source: 'binance_klines',
        window_minutes: windowSize,
        volume_level: 'unknown',
        volume_label: '未取得',
        note: '出来高判定に必要なKline本数が不足しています。',
      };
    }
    return context;
  } catch (error) {
    return {
      ok: false,
      source: 'unavailable',
      window_minutes: windowSize,
      volume_level: 'unknown',
      volume_label: '未取得',
      note: `出来高コンテキスト未取得: ${error.message}`,
    };
  }
}

function ratioText(value, digits = 2) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}倍` : '—';
}

function percentRatioText(value, digits = 0) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : '—';
}

function marketContextSummary(volumeContext = {}) {
  if (!volumeContext || !volumeContext.ok) return volumeContext?.note || '出来高コンテキストは未取得です。';
  return `出来高 ${volumeContext.volume_label} ${ratioText(volumeContext.volume_ratio)} / 取引回数 ${volumeContext.trade_count_label} ${ratioText(volumeContext.trade_count_ratio)} / Taker buy ${volumeContext.taker_buy_label} ${percentRatioText(volumeContext.taker_buy_ratio)}`;
}


function orderFlowBiasFromTakerRatio(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value)) return { bias: 'unknown', label: '未取得', strength: 'unknown', rank: 0 };
  if (value >= 0.62) return { bias: 'buy_side', label: '買い主導強め', strength: 'strong', rank: 2 };
  if (value >= 0.55) return { bias: 'buy_side', label: '買い主導寄り', strength: 'info', rank: 1 };
  if (value <= 0.38) return { bias: 'sell_side', label: '売り主導強め', strength: 'strong', rank: 2 };
  if (value <= 0.45) return { bias: 'sell_side', label: '売り主導寄り', strength: 'info', rank: 1 };
  return { bias: 'neutral', label: '中立', strength: 'neutral', rank: 0 };
}

function costRiskContext(thresholdPct, costFloorPct) {
  const threshold = Number(thresholdPct);
  const cost = Number(costFloorPct);
  const gap = Number.isFinite(threshold) && Number.isFinite(cost) ? threshold - cost : null;
  if (!Number.isFinite(cost)) {
    return {
      ok: false,
      total_cost_pct: null,
      threshold_pct: Number.isFinite(threshold) ? threshold : null,
      threshold_gap_pct: null,
      cost_risk: 'unknown',
      cost_label: 'コスト未取得',
      level: '—',
      level_rank: 0,
      alert_hit: false,
      note: '実取引寄りコスト目安が未取得です。',
    };
  }
  if (Number.isFinite(threshold) && threshold > 0 && cost >= threshold) {
    return {
      ok: true,
      total_cost_pct: cost,
      threshold_pct: threshold,
      threshold_gap_pct: gap,
      cost_risk: 'high',
      cost_label: 'コスト超過',
      level: 'Lv3 警戒',
      level_rank: 3,
      alert_hit: true,
      note: `往復コスト目安 ${cost.toFixed(3)}% がしきい値 ${threshold.toFixed(3)}% 以上です。小さな値動き狙いは取引候補から外す材料です。`,
    };
  }
  if (Number.isFinite(threshold) && threshold > 0 && cost >= threshold * 0.9) {
    return {
      ok: true,
      total_cost_pct: cost,
      threshold_pct: threshold,
      threshold_gap_pct: gap,
      cost_risk: 'near_threshold',
      cost_label: 'コスト近接',
      level: 'Lv2 注意',
      level_rank: 2,
      alert_hit: true,
      note: `往復コスト目安 ${cost.toFixed(3)}% がしきい値 ${threshold.toFixed(3)}% に近く、浅い利確ではNetが残りにくい状態です。`,
    };
  }
  if (Number.isFinite(threshold) && threshold > 0 && cost >= threshold * 0.7) {
    return {
      ok: true,
      total_cost_pct: cost,
      threshold_pct: threshold,
      threshold_gap_pct: gap,
      cost_risk: 'medium',
      cost_label: 'コストやや重い',
      level: 'Lv1 情報',
      level_rank: 1,
      alert_hit: false,
      note: `往復コスト目安 ${cost.toFixed(3)}% はしきい値に対してやや重めです。利確幅に余裕が必要です。`,
    };
  }
  return {
    ok: true,
    total_cost_pct: cost,
    threshold_pct: Number.isFinite(threshold) ? threshold : null,
    threshold_gap_pct: gap,
    cost_risk: 'low',
    cost_label: 'コスト余裕あり',
    level: '注意以上なし',
    level_rank: 0,
    alert_hit: false,
    note: Number.isFinite(threshold) ? `往復コスト目安 ${cost.toFixed(3)}% に対して、しきい値との差は ${gap.toFixed(3)}% です。` : '往復コスト目安を情報として保持します。',
  };
}

function buildVolumeCostAlertContext({ movePct, thresholdPct, volumeContext, costContext }) {
  const move = Number(movePct);
  const direction = movementDirection(move);
  const strength = movementStrength(move, thresholdPct);
  const volumeRank = Number(volumeContext?.volume_rank || 0);
  const tradeRank = Number(volumeContext?.trade_count_rank || 0);
  const flow = orderFlowBiasFromTakerRatio(volumeContext?.taker_buy_ratio);
  const activeAlerts = [];
  const add = (family, type, label, level, levelRank, note, alertHit = levelRank >= 2, extra = {}) => {
    activeAlerts.push({ family, type, label, level, level_rank: levelRank, note, alert_hit: Boolean(alertHit), ...extra });
  };

  if (volumeContext && volumeContext.ok) {
    if (volumeRank >= 4 || tradeRank >= 4) {
      add('volume_context', 'volume_or_trade_surge', '出来高/取引回数急増', 'Lv2 注意', 2, '参加量が急増しています。方向が出る前後の急変・反転候補として扱います。', true, {
        volume_ratio: volumeContext.volume_ratio,
        trade_count_ratio: volumeContext.trade_count_ratio,
      });
    } else if (volumeRank >= 3 || tradeRank >= 3) {
      add('volume_context', 'volume_or_trade_thick', '出来高/取引回数厚い', 'Lv1 情報', 1, '参加量が通常より厚めです。値動きの裏付け候補として残します。', false, {
        volume_ratio: volumeContext.volume_ratio,
        trade_count_ratio: volumeContext.trade_count_ratio,
      });
    } else if (volumeRank === 1 && tradeRank === 1) {
      add('volume_context', 'volume_and_trade_thin', '出来高/取引回数薄い', 'Lv1 情報', 1, '参加量が薄く、追随判断の信頼度を下げる材料です。', false, {
        volume_ratio: volumeContext.volume_ratio,
        trade_count_ratio: volumeContext.trade_count_ratio,
      });
    }

    if (flow.rank >= 2) {
      add('order_flow', flow.bias === 'buy_side' ? 'strong_buy_side' : 'strong_sell_side', flow.label, 'Lv2 注意', 2, `${flow.label}です。価格方向と一致する場合は継続材料、不一致なら矛盾材料として扱います。`, true, { taker_buy_ratio: volumeContext.taker_buy_ratio });
    } else if (flow.rank >= 1) {
      add('order_flow', flow.bias === 'buy_side' ? 'buy_side_bias' : 'sell_side_bias', flow.label, 'Lv1 情報', 1, `${flow.label}です。単独では売買判断に使わず、方向・出来高・価格位置と組み合わせます。`, false, { taker_buy_ratio: volumeContext.taker_buy_ratio });
    }

    const volumeBacked = volumeRank >= 3 || tradeRank >= 3;
    const volumeSurge = volumeRank >= 4 || tradeRank >= 4;
    if (direction === 'up' && (strength === 'threshold' || strength === 'strong') && volumeBacked && flow.bias !== 'sell_side') {
      add('combined_volume_flow', 'up_with_volume_support', '上昇＋参加量裏付け', 'Lv2 注意', 2, '上昇に出来高または取引回数の裏付けがあります。浅め〜標準指値候補を残す材料です。', true);
    }
    if (direction === 'up' && (strength === 'threshold' || strength === 'strong') && (volumeRank <= 1 && tradeRank <= 1)) {
      add('combined_volume_flow', 'up_with_thin_volume', '上昇＋出来高薄い', 'Lv2 注意', 2, '価格は上がっていますが参加量が薄く、追随候補を落とす材料です。', true);
    }
    if (direction === 'up' && (strength === 'threshold' || strength === 'strong') && flow.bias === 'sell_side') {
      add('combined_volume_flow', 'up_with_sell_flow_divergence', '上昇＋売り主導寄り', 'Lv2 注意', 2, '価格上昇に対してTaker buyが弱く、上昇継続の信頼度を下げる矛盾材料です。', true);
    }
    if (direction === 'down' && (strength === 'threshold' || strength === 'strong') && (volumeSurge || flow.bias === 'sell_side')) {
      add('combined_volume_flow', 'down_with_sell_pressure', '下落＋売り圧力', 'Lv2 注意', 2, '下落方向に参加量または売り主導が重なっています。浅い買い指値を除外する材料です。', true);
    }
    if ((direction === 'flat' || strength === 'small' || strength === 'info') && volumeSurge) {
      add('combined_volume_flow', 'volume_leads_price', '出来高先行', 'Lv2 注意', 2, '価格変化は限定的ですが参加量が急増しています。レンジ突破または反落の前兆として、方向確定待ちに寄せます。', true);
    }
  }

  if (costContext && costContext.ok && (costContext.level_rank || 0) >= 1) {
    add('cost_context', costContext.cost_risk === 'high' ? 'cost_exceeds_threshold' : costContext.cost_risk === 'near_threshold' ? 'cost_near_threshold' : 'cost_medium', costContext.cost_label, costContext.level, costContext.level_rank, costContext.note, costContext.alert_hit, {
      total_cost_pct: costContext.total_cost_pct,
      threshold_gap_pct: costContext.threshold_gap_pct,
    });
  }

  const ranked = activeAlerts.slice().sort((a, b) => ((b.level_rank || 0) - (a.level_rank || 0)) || (Number(b.alert_hit) - Number(a.alert_hit)));
  const primary = ranked[0] || null;
  return {
    ok: Boolean(volumeContext?.ok || costContext?.ok),
    volume_level: volumeContext?.volume_level || 'unknown',
    volume_label: volumeContext?.volume_label || '未取得',
    volume_ratio: Number.isFinite(Number(volumeContext?.volume_ratio)) ? Number(volumeContext.volume_ratio) : null,
    trade_count_level: volumeContext?.trade_count_level || 'unknown',
    trade_count_label: volumeContext?.trade_count_label || '未取得',
    trade_count_ratio: Number.isFinite(Number(volumeContext?.trade_count_ratio)) ? Number(volumeContext.trade_count_ratio) : null,
    order_flow_bias: flow.bias,
    order_flow_label: flow.label,
    order_flow_rank: flow.rank,
    taker_buy_ratio: Number.isFinite(Number(volumeContext?.taker_buy_ratio)) ? Number(volumeContext.taker_buy_ratio) : null,
    cost_context: costContext || null,
    level: primary?.level || '注意以上なし',
    level_rank: primary?.level_rank || 0,
    alert_hit: ranked.some((item) => item.alert_hit && (item.level_rank || 0) >= 2),
    primary_signal: primary?.type || 'none',
    primary_label: primary?.label || '出来高・コスト通常',
    active_alerts: ranked,
    summary: ranked.length ? ranked.slice(0, 4).map((item) => `${item.label}: ${item.note}`).join(' / ') : '出来高・取引回数・Taker buy・コストで注意以上の追加材料はありません。',
    volume_alert_summary: ranked.filter((item) => item.family === 'volume_context' || item.family === 'combined_volume_flow').map((item) => item.label).join(' / ') || '出来高アラートなし',
    order_flow_summary: flow.label,
    cost_alert_summary: costContext?.note || 'コスト文脈なし',
  };
}

function applyVolumeCostDecisionOverlay(decision, volumeCostContext, costContext, direction) {
  if (!decision || !volumeCostContext) return decision;
  const types = new Set((volumeCostContext.active_alerts || []).map((item) => item.type));
  if (costContext?.cost_risk === 'high') {
    return {
      ...decision,
      entry_bias: decision.entry_bias === 'data_unavailable' ? decision.entry_bias : 'no_trade_cost_exceeds',
      decision_title: 'コスト超過 / 取引候補を絞る',
      decision_comment: '実取引寄りコストがしきい値以上です。小さな値動きでは利益が残りにくく、取引候補から外す判断を優先します。',
      order_adjustment: '成行追随・浅め指値・標準指値は除外寄りです。候補に残すなら、十分に深い指値またはコスト差が改善した後だけです。',
      target_adjustment: '必要利確価格は、往復コストを明確に上回る幅が取れる場合だけ設定します。',
      risk_comment: costContext.note,
    };
  }
  if (types.has('up_with_thin_volume') || types.has('up_with_sell_flow_divergence')) {
    return {
      ...decision,
      entry_bias: 'standard_limit_or_watch',
      decision_title: '上昇の裏付け弱め',
      decision_comment: '価格は上向きですが、出来高またはTaker buyの裏付けが弱めです。追随候補を落とす判断です。',
      order_adjustment: '買い候補として扱うなら、成行追随と浅すぎる指値は避け、標準〜深め指値または待機に寄せます。',
      target_adjustment: '利確幅は控えめに見積もらず、コスト後Netが残る幅を満たす時だけ候補にします。',
      risk_comment: '出来高・フローが伴わない上昇はダマシや伸び不足を重く見ます。',
    };
  }
  if (types.has('down_with_sell_pressure')) {
    return {
      ...decision,
      entry_bias: 'deeper_limit_or_rebound_wait',
      decision_title: '下落＋売り圧力',
      decision_comment: '下落に参加量または売り主導が重なっています。浅い買い候補は除外します。',
      order_adjustment: '買い候補として残すなら、深め指値または反発確認後だけです。現在価格付近は候補から外します。',
      target_adjustment: '反発幅がコスト後Netを十分に残す場合だけ利確候補にします。',
      risk_comment: '続落リスクが強く、約定後に損切り側へ先に触れる可能性を重く見ます。',
    };
  }
  if (types.has('volume_leads_price')) {
    return {
      ...decision,
      entry_bias: 'range_break_or_lower_limit',
      decision_title: '出来高先行 / 方向待ち',
      decision_comment: '参加量が先に増えていますが、価格方向はまだ限定的です。現在価格で決め打ちしない判断です。',
      order_adjustment: 'レンジ上抜け後の浅め〜標準指値候補と、レンジ下限付近の深め指値候補を分けて残します。',
      target_adjustment: '方向確定前なので、レンジ幅とコスト後Netを超える条件だけを候補にします。',
      risk_comment: '攻防中の可能性があり、上抜け・下抜けどちらにも外れ条件を置きます。',
    };
  }
  if (types.has('up_with_volume_support') && direction === 'up' && costContext?.cost_risk !== 'near_threshold') {
    return {
      ...decision,
      entry_bias: 'shallow_to_standard_limit',
      decision_title: '上昇＋参加量裏付け',
      decision_comment: '上昇に出来高または取引回数の裏付けがあります。追随ではなく、浅め〜標準指値候補を残す判断です。',
      order_adjustment: '成行追随は優先しません。浅め指値で到達機会を残し、標準指値で利確余地も残す比較にします。',
      target_adjustment: '必要利確価格は、出来高裏付けがある間の継続余地とコスト後Netを基準にします。',
      risk_comment: '出来高が急増しすぎる場合は反落もあるため、外れ条件を同時に置きます。',
    };
  }
  if (costContext?.cost_risk === 'near_threshold') {
    return {
      ...decision,
      entry_bias: 'lower_limit_for_margin',
      decision_title: `${decision.decision_title} / コスト近接`,
      decision_comment: `${decision.decision_comment || ''} コストがしきい値に近く、注文位置は利確余地を作る方向に補正します。`.trim(),
      order_adjustment: '買い候補として扱うなら、現在価格付近ではなく標準〜深め指値で、必要利確価格までの余地を作ります。',
      target_adjustment: '浅い利確幅は避け、実取引寄りコストを明確に上回るNetだけを候補にします。',
      risk_comment: costContext.note,
    };
  }
  return decision;
}


function movementDirection(movePct) {
  const move = Number(movePct);
  if (!Number.isFinite(move)) return 'unknown';
  if (move > 0) return 'up';
  if (move < 0) return 'down';
  return 'flat';
}

function movementStrength(movePct, thresholdPct) {
  const moveAbs = Math.abs(Number(movePct));
  const threshold = Number(thresholdPct);
  if (!Number.isFinite(moveAbs) || !Number.isFinite(threshold) || threshold <= 0) return 'unknown';
  if (moveAbs >= threshold * 2) return 'strong';
  if (moveAbs >= threshold) return 'threshold';
  if (moveAbs >= Math.max(threshold * 0.5, 0.03)) return 'info';
  return 'small';
}

const ALERT_DIRECTION_WINDOWS = [1, 5, 15, 30, 60];

function movementDirectionLabel(direction) {
  if (direction === 'up') return '上昇';
  if (direction === 'down') return '下落';
  if (direction === 'flat') return '横ばい';
  return '不明';
}

function movementStrengthLabel(strength) {
  if (strength === 'strong') return '強い';
  if (strength === 'threshold') return 'しきい値到達';
  if (strength === 'info') return '小さめ';
  if (strength === 'small') return '小動き';
  return '不明';
}

function movementAlertType(movePct, thresholdPct) {
  const direction = movementDirection(movePct);
  const strength = movementStrength(movePct, thresholdPct);
  if (direction === 'up' && strength === 'strong') return 'spike_up';
  if (direction === 'up' && strength === 'threshold') return 'rise';
  if (direction === 'up' && strength === 'info') return 'moving_up';
  if (direction === 'down' && strength === 'strong') return 'spike_down';
  if (direction === 'down' && strength === 'threshold') return 'fall';
  if (direction === 'down' && strength === 'info') return 'moving_down';
  if (direction === 'flat') return 'flat';
  return 'quiet';
}

function movementAlertLabel(type) {
  const labels = {
    spike_up: '急騰',
    rise: '上昇',
    moving_up: 'Moving up',
    spike_down: '急落',
    fall: '下落',
    moving_down: 'Moving down',
    flat: '横ばい',
    quiet: '小動き',
    data_unavailable: '判定不可',
  };
  return labels[type] || '小動き';
}

function directionLevelInfo(movePct, thresholdPct) {
  const move = Number(movePct);
  const threshold = Number(thresholdPct);
  const direction = movementDirection(move);
  const strength = movementStrength(move, threshold);
  const type = movementAlertType(move, threshold);
  if (!Number.isFinite(move) || !Number.isFinite(threshold) || threshold <= 0) {
    return {
      level: '—', level_rank: 0, level_note: '判定不可', alert_hit: false,
      direction, direction_label: movementDirectionLabel(direction), movement_strength: strength,
      movement_alert_type: 'data_unavailable', movement_alert_label: '判定不可', movement_status: '判定不可', movement_side: 'none',
    };
  }
  if (strength === 'strong') {
    const sideLabel = direction === 'down' ? '急落' : direction === 'up' ? '急騰' : '急変';
    return {
      level: 'Lv3 警戒', level_rank: 3, level_note: `${sideLabel}。しきい値の2倍以上で、実取引では追随・逆張りの両方を慎重に扱います。`, alert_hit: true,
      direction, direction_label: movementDirectionLabel(direction), movement_strength: strength,
      movement_alert_type: type, movement_alert_label: movementAlertLabel(type), movement_status: `${sideLabel}アラート`, movement_side: direction,
    };
  }
  if (strength === 'threshold') {
    const sideLabel = direction === 'down' ? '下落' : direction === 'up' ? '上昇' : '変動';
    return {
      level: 'Lv2 注意', level_rank: 2, level_note: `${sideLabel}しきい値に到達。注意表示と履歴保存の対象です。`, alert_hit: true,
      direction, direction_label: movementDirectionLabel(direction), movement_strength: strength,
      movement_alert_type: type, movement_alert_label: movementAlertLabel(type), movement_status: `${sideLabel}アラート`, movement_side: direction,
    };
  }
  if (strength === 'info') {
    const sideLabel = direction === 'down' ? 'Moving down' : direction === 'up' ? 'Moving up' : '小動き';
    return {
      level: 'Lv1 情報', level_rank: 1, level_note: `${sideLabel}。注意以上ではありませんが、方向メモとして残します。`, alert_hit: false,
      direction, direction_label: movementDirectionLabel(direction), movement_strength: strength,
      movement_alert_type: type, movement_alert_label: movementAlertLabel(type), movement_status: sideLabel, movement_side: direction,
    };
  }
  return {
    level: '注意以上なし', level_rank: 0, level_note: 'しきい値未満。方向メモとして市場状態だけ表示します。', alert_hit: false,
    direction, direction_label: movementDirectionLabel(direction), movement_strength: strength,
    movement_alert_type: type, movement_alert_label: movementAlertLabel(type), movement_status: direction === 'down' ? '小さな下落' : direction === 'up' ? '小さな上昇' : '小動き', movement_side: direction,
  };
}

function computeWindowMoveSnapshot(symbolRows, latest, windowMinutes, thresholdPct) {
  const minutes = Math.max(1, Math.min(240, safeInt(windowMinutes, 15)));
  if (!latest || !Array.isArray(symbolRows) || symbolRows.length < 2) {
    return {
      window_minutes: minutes,
      ok: false,
      samples: Array.isArray(symbolRows) ? symbolRows.length : 0,
      move_pct: null,
      base_price: null,
      latest_price: latest?.price ?? null,
      direction: 'unknown',
      direction_label: '不明',
      movement_strength: 'unknown',
      movement_alert_type: 'data_unavailable',
      movement_alert_label: '判定不可',
      level: '—',
      level_rank: 0,
      alert_hit: false,
      note: '価格履歴が不足しています。',
    };
  }
  const windowStart = new Date(latest.timestamp.getTime() - minutes * 60 * 1000);
  const windowRows = symbolRows.filter((row) => row.timestamp >= windowStart && row.timestamp <= latest.timestamp);
  const base = windowRows[0];
  if (!base || !Number.isFinite(base.price) || base.price <= 0) {
    return {
      window_minutes: minutes,
      ok: false,
      samples: windowRows.length,
      move_pct: null,
      base_price: null,
      latest_price: latest.price,
      direction: 'unknown',
      direction_label: '不明',
      movement_strength: 'unknown',
      movement_alert_type: 'data_unavailable',
      movement_alert_label: '判定不可',
      level: '—',
      level_rank: 0,
      alert_hit: false,
      note: '窓内の起点価格が不足しています。',
    };
  }
  const movePct = ((latest.price - base.price) / base.price) * 100;
  const levelInfo = directionLevelInfo(movePct, thresholdPct);
  return {
    window_minutes: minutes,
    ok: true,
    samples: windowRows.length,
    move_pct: movePct,
    base_price: base.price,
    latest_price: latest.price,
    direction: levelInfo.direction,
    direction_label: levelInfo.direction_label,
    movement_strength: levelInfo.movement_strength,
    movement_strength_label: movementStrengthLabel(levelInfo.movement_strength),
    movement_alert_type: levelInfo.movement_alert_type,
    movement_alert_label: levelInfo.movement_alert_label,
    level: levelInfo.level,
    level_rank: levelInfo.level_rank,
    alert_hit: levelInfo.alert_hit,
    note: levelInfo.level_note,
  };
}

function buildDirectionWindowSnapshots(symbolRows, latest, mainWindowMinutes, thresholdPct) {
  const windows = Array.from(new Set([safeInt(mainWindowMinutes, 15), ...ALERT_DIRECTION_WINDOWS])).filter((value) => value > 0).sort((a, b) => a - b);
  return windows.map((minutes) => computeWindowMoveSnapshot(symbolRows, latest, minutes, thresholdPct));
}

function choosePrimaryDirectionAlert(windowMoves, mainWindowMinutes) {
  const rows = Array.isArray(windowMoves) ? windowMoves.filter((row) => row && row.ok) : [];
  if (!rows.length) return null;
  const main = rows.find((row) => Number(row.window_minutes) === Number(mainWindowMinutes));
  const ranked = rows.slice().sort((a, b) => ((b.level_rank || 0) - (a.level_rank || 0)) || (Math.abs(Number(b.move_pct || 0)) - Math.abs(Number(a.move_pct || 0))));
  const strongest = ranked[0] || main || rows[0];
  if (!main) return strongest;
  // 選択中の窓は表示に残すが、より強い別窓アラートを潰さない。
  // 例: 15分はLv1でも、30分/60分がしきい値超えなら中期上昇を判断の軸にする。
  if ((strongest.level_rank || 0) > (main.level_rank || 0)) return strongest;
  if ((strongest.level_rank || 0) === (main.level_rank || 0) && (strongest.level_rank || 0) >= 2) return strongest;
  if ((main.level_rank || 0) >= 1) return main;
  return strongest;
}

function directionLevelInfoFromSnapshot(snapshot, fallbackLevelInfo) {
  if (!snapshot || !snapshot.ok) return fallbackLevelInfo;
  return {
    level: snapshot.level || fallbackLevelInfo?.level || '注意以上なし',
    level_rank: Number.isFinite(Number(snapshot.level_rank)) ? Number(snapshot.level_rank) : Number(fallbackLevelInfo?.level_rank || 0),
    level_note: snapshot.note || fallbackLevelInfo?.level_note || '',
    alert_hit: Boolean(snapshot.alert_hit),
    direction: snapshot.direction || fallbackLevelInfo?.direction || 'unknown',
    direction_label: snapshot.direction_label || movementDirectionLabel(snapshot.direction),
    movement_strength: snapshot.movement_strength || fallbackLevelInfo?.movement_strength || 'unknown',
    movement_alert_type: snapshot.movement_alert_type || fallbackLevelInfo?.movement_alert_type || 'quiet',
    movement_alert_label: snapshot.movement_alert_label || fallbackLevelInfo?.movement_alert_label || movementAlertLabel(snapshot.movement_alert_type),
    movement_status: `${snapshot.window_minutes}分${snapshot.movement_alert_label || '方向'}アラート`,
    movement_side: snapshot.direction || fallbackLevelInfo?.movement_side || 'none',
  };
}

function directionAlertStatus(snapshot, fallbackStatus) {
  if (!snapshot || !snapshot.ok) return fallbackStatus || '監視中';
  if ((snapshot.level_rank || 0) >= 2) return `${snapshot.window_minutes}分${snapshot.movement_alert_label}アラート`;
  if ((snapshot.level_rank || 0) === 1) return `${snapshot.window_minutes}分${snapshot.movement_alert_label}`;
  return fallbackStatus || `${snapshot.window_minutes}分小動き`;
}

function buildMultiWindowContinuation(windowMoves, mainWindowMinutes) {
  const rows = Array.isArray(windowMoves) ? windowMoves.filter((row) => row && row.ok && Number.isFinite(Number(row.move_pct))) : [];
  if (!rows.length) {
    return {
      signal: 'unknown',
      label: '継続判定不可',
      direction: 'unknown',
      level: '—',
      level_rank: 0,
      alert_hit: false,
      supporting_windows: [],
      threshold_windows: [],
      short_term_confirmation: 'unknown',
      note: '複数窓の価格履歴が不足しています。',
    };
  }
  const main = rows.find((row) => Number(row.window_minutes) === Number(mainWindowMinutes));
  const upRows = rows.filter((row) => row.direction === 'up');
  const downRows = rows.filter((row) => row.direction === 'down');
  const upHitRows = upRows.filter((row) => (row.level_rank || 0) >= 2);
  const downHitRows = downRows.filter((row) => (row.level_rank || 0) >= 2);
  const upInfoRows = upRows.filter((row) => (row.level_rank || 0) >= 1);
  const downInfoRows = downRows.filter((row) => (row.level_rank || 0) >= 1);
  const upScore = upHitRows.length * 3 + upInfoRows.length;
  const downScore = downHitRows.length * 3 + downInfoRows.length;
  const direction = upScore > downScore ? 'up' : downScore > upScore ? 'down' : (main?.direction || 'flat');
  const infoRows = direction === 'up' ? upInfoRows : direction === 'down' ? downInfoRows : [];
  const hitRows = direction === 'up' ? upHitRows : direction === 'down' ? downHitRows : [];
  const mediumHitRows = hitRows.filter((row) => Number(row.window_minutes) >= 30);
  const shortRows = rows.filter((row) => Number(row.window_minutes) <= 15);
  const shortSame = shortRows.filter((row) => row.direction === direction && (row.level_rank || 0) >= 1);
  const shortHit = shortRows.some((row) => row.direction === direction && (row.level_rank || 0) >= 2);
  const shortTermConfirmation = shortHit ? 'strong' : shortSame.length ? 'weak' : 'none';
  const supportingWindows = infoRows.map((row) => row.window_minutes);
  const thresholdWindows = hitRows.map((row) => row.window_minutes);
  const directionLabel = movementDirectionLabel(direction);

  if (direction === 'up' && mediumHitRows.length >= 1 && infoRows.length >= 2) {
    return {
      signal: 'upward_continuation',
      label: '中期上昇継続',
      direction,
      level: 'Lv2 注意',
      level_rank: 2,
      alert_hit: true,
      supporting_windows: supportingWindows,
      threshold_windows: thresholdWindows,
      short_term_confirmation: shortTermConfirmation,
      note: `${thresholdWindows.join('/')}分で上昇しきい値超え。${Number(mainWindowMinutes)}分が未達でも、中期上昇は判断材料に残します。`,
    };
  }
  if (direction === 'down' && mediumHitRows.length >= 1 && infoRows.length >= 2) {
    return {
      signal: 'downward_continuation',
      label: '中期下落継続',
      direction,
      level: 'Lv2 注意',
      level_rank: 2,
      alert_hit: true,
      supporting_windows: supportingWindows,
      threshold_windows: thresholdWindows,
      short_term_confirmation: shortTermConfirmation,
      note: `${thresholdWindows.join('/')}分で下落しきい値超え。${Number(mainWindowMinutes)}分が未達でも、中期下落は判断材料に残します。`,
    };
  }
  if (direction === 'up' && hitRows.length >= 2) {
    return {
      signal: 'upward_multi_window',
      label: '複数窓上昇',
      direction,
      level: 'Lv2 注意',
      level_rank: 2,
      alert_hit: true,
      supporting_windows: supportingWindows,
      threshold_windows: thresholdWindows,
      short_term_confirmation: shortTermConfirmation,
      note: `${thresholdWindows.join('/')}分で上昇しきい値を超えています。`,
    };
  }
  if (direction === 'down' && hitRows.length >= 2) {
    return {
      signal: 'downward_multi_window',
      label: '複数窓下落',
      direction,
      level: 'Lv2 注意',
      level_rank: 2,
      alert_hit: true,
      supporting_windows: supportingWindows,
      threshold_windows: thresholdWindows,
      short_term_confirmation: shortTermConfirmation,
      note: `${thresholdWindows.join('/')}分で下落しきい値を超えています。`,
    };
  }
  if (infoRows.length >= 2) {
    return {
      signal: direction === 'up' ? 'weak_upward_bias' : direction === 'down' ? 'weak_downward_bias' : 'mixed',
      label: direction === 'up' ? '上昇気配' : direction === 'down' ? '下落気配' : '方向混在',
      direction,
      level: 'Lv1 情報',
      level_rank: 1,
      alert_hit: false,
      supporting_windows: supportingWindows,
      threshold_windows: thresholdWindows,
      short_term_confirmation: shortTermConfirmation,
      note: `${directionLabel}方向の窓が複数ありますが、注意以上としてはまだ弱めです。`,
    };
  }
  return {
    signal: 'no_continuation',
    label: '継続なし',
    direction: 'flat',
    level: '注意以上なし',
    level_rank: 0,
    alert_hit: false,
    supporting_windows: supportingWindows,
    threshold_windows: thresholdWindows,
    short_term_confirmation: shortTermConfirmation,
    note: '複数窓で同方向の継続はまだ弱めです。',
  };
}

function applyContinuationDecisionOverlay(decision, continuation, selectedSnapshot) {
  if (!continuation || !decision) return decision;
  const selectedRank = Number(selectedSnapshot?.level_rank || 0);
  const hitText = Array.isArray(continuation.threshold_windows) && continuation.threshold_windows.length
    ? `${continuation.threshold_windows.join('/')}分`
    : '中期窓';
  if (continuation.signal === 'upward_continuation' && selectedRank < 2) {
    return {
      ...decision,
      entry_bias: decision.entry_bias === 'data_unavailable' ? decision.entry_bias : 'shallow_or_standard_limit',
      decision_title: '中期上昇継続（短期は未達）',
      decision_comment: `${hitText}で上昇しきい値を超えています。短期は追随根拠がまだ弱いため、現在価格追随ではなく押し目・浅め〜標準指値候補で見る判断です。`,
      order_adjustment: `${hitText}の上昇は買い候補の材料に残します。ただし選択中の短期窓は弱めなので、成行追随ではなく浅め〜標準指値、または押し目候補を優先します。`,
      target_adjustment: '必要利確価格は、短期の伸び余地ではなく中期上昇の継続余地とコスト後Netを同時に見ます。',
      risk_comment: '短期だけで追いかけると高値掴みになりやすい局面です。出来高・Taker buyが弱い場合は追随候補を除外します。',
    };
  }
  if (continuation.signal === 'downward_continuation' && selectedRank < 2) {
    return {
      ...decision,
      entry_bias: decision.entry_bias === 'data_unavailable' ? decision.entry_bias : 'deeper_limit_or_rebound_wait',
      decision_title: '中期下落継続（短期は未達）',
      decision_comment: `${hitText}で下落しきい値を超えています。買い候補として扱うなら、浅い指値を外し、深め指値または反発確認後だけを候補に残す判断です。`,
      order_adjustment: `${hitText}の下落は買い候補を絞る材料です。現在価格付近や浅め指値は除外し、深め指値または反発確認後に寄せます。`,
      target_adjustment: '反発幅が実取引寄りコストを超える条件だけを残します。',
      risk_comment: '中期下落中は、約定後に続落するリスクを未約定リスクより重く見ます。',
    };
  }
  return decision;
}

function strongestDirectionSnapshot(rows, predicate) {
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => row && row.ok && Number.isFinite(Number(row.move_pct)) && (!predicate || predicate(row)));
  if (!filtered.length) return null;
  return filtered.slice().sort((a, b) => ((b.level_rank || 0) - (a.level_rank || 0)) || (Math.abs(Number(b.move_pct || 0)) - Math.abs(Number(a.move_pct || 0))) || (Number(b.window_minutes || 0) - Number(a.window_minutes || 0)))[0];
}

function directionBucketScore(rows, direction) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.direction === direction && Number.isFinite(Number(row.move_pct)))
    .reduce((sum, row) => {
      const level = Number(row.level_rank || 0);
      const windowWeight = Number(row.window_minutes || 0) >= 30 ? 1.4 : Number(row.window_minutes || 0) >= 15 ? 1.15 : 1;
      return sum + (level + Math.min(Math.abs(Number(row.move_pct || 0)) * 2, 1)) * windowWeight;
    }, 0);
}

function compactActiveAlert(item) {
  if (!item) return null;
  return {
    family: item.family || 'combined_market_signal',
    type: item.type || 'unknown',
    label: item.label || item.type || '複合判定',
    level: item.level || '注意以上なし',
    level_rank: Number(item.level_rank || 0),
    note: item.note || '',
    alert_hit: Boolean(item.alert_hit),
  };
}

function emptyCombinedSignalContext(note = '継続・矛盾チェックに必要な材料が不足しています。') {
  return {
    ok: false,
    combined_signal: 'data_unavailable',
    combined_label: '複合判定不可',
    combined_level: '—',
    combined_level_rank: 0,
    alert_hit: false,
    direction_score: { up: 0, down: 0 },
    short_direction: 'unknown',
    medium_long_direction: 'unknown',
    strongest_window_minutes: null,
    strongest_move_pct: null,
    price_position_signal: 'unknown',
    volume_cost_signal: 'none',
    active_alerts: [],
    summary: note,
    invalidation_conditions: [],
  };
}

function buildContinuationConflictContext({ movementWindowMoves = [], continuationAlert = null, pricePositionContext = null, volumeCostContext = null, costContext = null }) {
  const rows = (Array.isArray(movementWindowMoves) ? movementWindowMoves : []).filter((row) => row && row.ok && Number.isFinite(Number(row.move_pct)));
  const activeAlerts = [];
  const add = (family, type, label, level, levelRank, note, alertHit = levelRank >= 2, extra = {}) => {
    activeAlerts.push({ family, type, label, level, level_rank: levelRank, note, alert_hit: Boolean(alertHit), ...extra });
  };

  const short = strongestDirectionSnapshot(rows, (row) => Number(row.window_minutes) <= 15);
  const veryShort = strongestDirectionSnapshot(rows, (row) => Number(row.window_minutes) <= 5);
  const mediumLong = strongestDirectionSnapshot(rows, (row) => Number(row.window_minutes) >= 30);
  const strongest = strongestDirectionSnapshot(rows);
  const upScore = directionBucketScore(rows, 'up');
  const downScore = directionBucketScore(rows, 'down');
  const priceSignal = pricePositionContext?.signal || 'unknown';
  const priceLabel = pricePositionContext?.label || '価格位置不明';
  const volumeTypes = new Set((volumeCostContext?.active_alerts || []).map((item) => item.type));
  const continuationSignal = continuationAlert?.signal || 'no_continuation';
  const hasCostReject = costContext?.cost_risk === 'high';
  const hasCostNear = costContext?.cost_risk === 'near_threshold';
  const hasVolumeSupport = volumeTypes.has('up_with_volume_support');
  const hasThinUp = volumeTypes.has('up_with_thin_volume') || volumeTypes.has('up_with_sell_flow_divergence');
  const hasSellPressure = volumeTypes.has('down_with_sell_pressure');
  const hasVolumeLead = volumeTypes.has('volume_leads_price');
  const isUpperPosition = ['near_day_high', 'range_upper', 'day_high_breakout', 'range_breakout_up'].includes(priceSignal);
  const isLowerBreak = ['day_low_breakdown', 'range_breakout_down'].includes(priceSignal);
  const isBreakoutUp = ['day_high_breakout', 'range_breakout_up'].includes(priceSignal);
  const isBreakoutDown = ['day_low_breakdown', 'range_breakout_down'].includes(priceSignal);

  if (hasCostReject && strongest && (strongest.level_rank || 0) >= 1) {
    add('combined_market_signal', 'trade_rejected_by_cost', 'コスト主導の取引除外', 'Lv3 警戒', 3, '値動き材料はありますが、往復コストがしきい値以上です。シミュレーターでは取引候補を除外し、見送りを主候補にします。', true);
  } else if (hasCostNear && strongest && (strongest.level_rank || 0) >= 2) {
    add('combined_market_signal', 'cost_near_on_signal', 'シグナル＋コスト近接', 'Lv2 注意', 2, '価格シグナルはありますがコスト余裕が小さく、浅い利確では利益が残りにくい状態です。', true);
  }

  if (short && mediumLong && short.direction === 'up' && mediumLong.direction === 'down' && (short.level_rank || 0) >= 1 && (mediumLong.level_rank || 0) >= 1) {
    add('continuation_conflict', 'short_up_against_medium_down', '短期上昇＋中期下向き', 'Lv2 注意', 2, `${short.window_minutes}分は上向きですが、${mediumLong.window_minutes}分は下向きです。戻り上げの可能性を重く見て、成行追随を落とします。`, true, { short_window: short.window_minutes, medium_window: mediumLong.window_minutes });
  }
  if (short && mediumLong && short.direction === 'down' && mediumLong.direction === 'up' && (short.level_rank || 0) >= 1 && (mediumLong.level_rank || 0) >= 1) {
    add('continuation_conflict', 'short_down_in_medium_uptrend', '短期下落＋中期上向き', 'Lv2 注意', 2, `${short.window_minutes}分は下向きですが、${mediumLong.window_minutes}分は上向きです。押し目候補にはなりますが、反発確認なしの浅い買いは落とします。`, true, { short_window: short.window_minutes, medium_window: mediumLong.window_minutes });
  }

  if ((continuationSignal === 'upward_continuation' || continuationSignal === 'upward_multi_window') && hasVolumeSupport && !isUpperPosition && !hasCostReject) {
    add('combined_market_signal', 'up_continuation_with_volume', '上昇継続＋参加量裏付け', 'Lv2 注意', 2, '複数窓上昇に出来高・取引回数の裏付けがあります。浅め〜標準指値候補を残す材料です。', true);
  }
  if ((continuationSignal === 'upward_continuation' || continuationSignal === 'upward_multi_window') && hasThinUp) {
    add('continuation_conflict', 'up_continuation_weak_volume_or_flow', '上昇継続＋裏付け不足', 'Lv2 注意', 2, '複数窓上昇はありますが、出来高またはTaker buyの裏付けが弱く、追随候補を落とす材料です。', true);
  }
  if ((continuationSignal === 'downward_continuation' || continuationSignal === 'downward_multi_window') && (hasSellPressure || isBreakoutDown || isLowerBreak)) {
    add('combined_market_signal', 'down_continuation_with_pressure', '下落継続＋売り圧力', 'Lv3 警戒', 3, '複数窓下落に売り圧力または下抜けが重なっています。浅い買い候補は除外し、反発確認まで待つ判断です。', true);
  }

  if (isBreakoutUp && hasVolumeSupport && !hasCostReject) {
    add('combined_market_signal', 'breakout_up_confirmed_by_volume', `${priceLabel}＋参加量`, 'Lv2 注意', 2, '上抜けに参加量の裏付けがあります。成行追随ではなく、浅め〜標準指値でブレイク後の到達機会を検証する材料です。', true);
  }
  if (isBreakoutUp && (hasThinUp || hasCostNear)) {
    add('continuation_conflict', 'breakout_up_weak_confirmation', `${priceLabel}＋裏付け不足`, 'Lv2 注意', 2, '上抜けていますが、出来高・フロー・コストのどれかが弱く、ブレイク失敗を外れ条件にします。', true);
  }
  if (isBreakoutDown) {
    add('combined_market_signal', 'breakout_down_buy_filter', `${priceLabel}買い候補絞り`, 'Lv2 注意', 2, '下抜け中です。買い候補は深め指値または反発確認後に限定し、浅い買い候補を除外します。', true);
  }

  if (hasVolumeLead) {
    add('combined_market_signal', 'volume_leads_direction_wait', '出来高先行・方向待ち', 'Lv2 注意', 2, '価格変化より参加量が先に増えています。上抜け・下抜けのどちらもあり得るため、方向確定前の成行追随は除外します。', true);
  }

  if (!activeAlerts.length && rows.length >= 2 && Math.abs(upScore - downScore) <= 0.8 && (upScore > 0 || downScore > 0)) {
    add('continuation_conflict', 'mixed_direction_low_confidence', '方向混在', 'Lv1 情報', 1, '複数窓で方向が揃っていません。注文候補は待機寄りにし、明確な継続または価格位置シグナルを待ちます。', false);
  }

  const ranked = activeAlerts.slice().sort((a, b) => ((b.level_rank || 0) - (a.level_rank || 0)) || (Number(b.alert_hit) - Number(a.alert_hit)));
  const primary = ranked[0] || null;
  const invalidation = [];
  if (primary?.type === 'short_up_against_medium_down') invalidation.push('中期下向きが解消し、30分以上の窓も上昇側へ揃う。');
  if (primary?.type === 'short_down_in_medium_uptrend') invalidation.push('短期下落が止まり、5分/15分でも上昇側へ戻る。');
  if (primary?.type === 'up_continuation_weak_volume_or_flow') invalidation.push('出来高・取引回数が厚くなり、Taker buyが買い主導寄りへ戻る。');
  if (primary?.type === 'down_continuation_with_pressure') invalidation.push('売り圧力が弱まり、反発後も出来高が維持される。');
  if (primary?.type === 'breakout_up_weak_confirmation') invalidation.push('上抜け後にレンジ上限を維持し、出来高・Taker buyの裏付けが増える。');
  if (primary?.type === 'volume_leads_direction_wait') invalidation.push('レンジ上抜けまたは下抜けで方向が確定する。');

  const summary = ranked.length
    ? ranked.slice(0, 3).map((item) => `${item.label}: ${item.note}`).join(' / ')
    : '継続・矛盾チェックで注意以上の追加材料はありません。';
  return {
    ok: true,
    combined_signal: primary?.type || 'no_combined_signal',
    combined_label: primary?.label || '複合判定なし',
    combined_level: primary?.level || '注意以上なし',
    combined_level_rank: primary?.level_rank || 0,
    alert_hit: ranked.some((item) => item.alert_hit && (item.level_rank || 0) >= 2),
    direction_score: { up: Number(upScore.toFixed(3)), down: Number(downScore.toFixed(3)) },
    short_direction: short?.direction || 'unknown',
    medium_long_direction: mediumLong?.direction || 'unknown',
    strongest_window_minutes: strongest?.window_minutes || null,
    strongest_move_pct: Number.isFinite(Number(strongest?.move_pct)) ? Number(strongest.move_pct) : null,
    price_position_signal: priceSignal,
    volume_cost_signal: volumeCostContext?.primary_signal || 'none',
    active_alerts: ranked.map(compactActiveAlert).filter(Boolean),
    summary,
    invalidation_conditions: invalidation,
  };
}

function applyCombinedSignalDecisionOverlay(decision, combinedContext) {
  if (!decision || !combinedContext) return decision;
  const signal = combinedContext.combined_signal;
  if (signal === 'trade_rejected_by_cost') {
    return {
      ...decision,
      entry_bias: decision.entry_bias === 'data_unavailable' ? decision.entry_bias : 'no_trade_cost_exceeds',
      decision_title: '複合判定：コスト主導で取引除外',
      decision_comment: '価格・出来高材料があっても、往復コストがしきい値以上です。実取引ロジックでは取引候補を落とします。',
      order_adjustment: '成行追随・浅め指値・標準指値は除外し、コスト差が改善するまで待機を主候補にします。',
      target_adjustment: '必要利確価格は、往復コストを明確に上回る値幅が取れる場合だけ検証します。',
      risk_comment: combinedContext.summary,
    };
  }
  if (signal === 'short_up_against_medium_down') {
    return {
      ...decision,
      entry_bias: 'standard_limit_or_watch',
      decision_title: '複合判定：短期上昇と中期下向きの矛盾',
      decision_comment: '短期だけは上向きですが、中期は下向きです。戻り上げの可能性を重く見て、現在価格追随は候補から外します。',
      order_adjustment: '買い候補として残すなら標準〜深め指値または見送りです。浅め指値は中期下向きが解消するまで弱い候補にします。',
      target_adjustment: '利確幅は短期の戻りだけで見積もらず、中期下向きが解消する条件を待ちます。',
      risk_comment: '短期上昇が中期下落の戻りにすぎない場合、約定後に再下落するリスクを重く見ます。',
    };
  }
  if (signal === 'short_down_in_medium_uptrend') {
    return {
      ...decision,
      entry_bias: 'wait_for_pullback',
      decision_title: '複合判定：中期上向き内の短期下落',
      decision_comment: '中期は上向きですが短期は下げています。押し目候補にはなりますが、反発確認なしの浅い買いは落とします。',
      order_adjustment: '買い候補は押し目の標準指値、または反発確認後の浅め指値に分けます。成行追随は優先しません。',
      target_adjustment: '必要利確価格は、中期上昇の継続余地と反発後の出来高維持を条件にします。',
      risk_comment: '押し目ではなく下落転換になる外れ条件を必ず置きます。',
    };
  }
  if (signal === 'up_continuation_with_volume' || signal === 'breakout_up_confirmed_by_volume') {
    return {
      ...decision,
      entry_bias: 'shallow_to_standard_limit',
      decision_title: `複合判定：${combinedContext.combined_label}`,
      decision_comment: '複数窓の上昇または上抜けに参加量の裏付けがあります。追随ではなく、浅め〜標準指値候補を残します。',
      order_adjustment: '成行追随は優先せず、浅め指値で到達機会、標準指値で利確余地を比較します。',
      target_adjustment: '必要利確価格はコスト後Netが残る範囲で、上昇継続の余地がある場合だけ候補にします。',
      risk_comment: '上抜け失敗または出来高低下を外れ条件にします。',
    };
  }
  if (signal === 'up_continuation_weak_volume_or_flow' || signal === 'breakout_up_weak_confirmation' || signal === 'cost_near_on_signal') {
    return {
      ...decision,
      entry_bias: 'standard_limit_or_watch',
      decision_title: `複合判定：${combinedContext.combined_label}`,
      decision_comment: '上向き材料はありますが、出来高・フロー・コストのどれかが弱く、追随候補を落とします。',
      order_adjustment: '買い候補として残すなら標準指値または待機です。浅め指値は利益幅不足・ブレイク失敗リスクを重く見ます。',
      target_adjustment: '必要利確価格は上げすぎず、Netが残る範囲だけを候補にします。',
      risk_comment: combinedContext.summary,
    };
  }
  if (signal === 'down_continuation_with_pressure' || signal === 'breakout_down_buy_filter') {
    return {
      ...decision,
      entry_bias: 'deeper_limit_or_rebound_wait',
      decision_title: `複合判定：${combinedContext.combined_label}`,
      decision_comment: '下落継続または下抜けに売り圧力が重なっています。浅い買い候補は除外します。',
      order_adjustment: '買い候補は深め指値または反発確認後だけです。現在価格付近と浅め指値は候補から外します。',
      target_adjustment: '反発幅がコスト後Netを十分に残す場合だけ検証します。',
      risk_comment: '続落リスクを主リスクとして扱い、反発確認を外れ条件にします。',
    };
  }
  if (signal === 'volume_leads_direction_wait' || signal === 'mixed_direction_low_confidence') {
    return {
      ...decision,
      entry_bias: 'range_break_or_lower_limit',
      decision_title: `複合判定：${combinedContext.combined_label}`,
      decision_comment: '方向がまだ確定していません。実取引ロジックでは現在価格で決め打ちせず、レンジ突破または下限指値に分けます。',
      order_adjustment: '上抜け確認後の浅め〜標準指値と、レンジ下限付近の深め指値を別候補にします。成行追随は除外します。',
      target_adjustment: '方向確定前は、レンジ幅とコスト後Netを超える条件だけを候補にします。',
      risk_comment: combinedContext.summary,
    };
  }
  return decision;
}

function jstDateKey(date) {
  if (!date || Number.isNaN(new Date(date).getTime())) return '';
  const jst = new Date(new Date(date).getTime() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}`;
}

function signedPctDiff(current, reference) {
  const c = Number(current);
  const r = Number(reference);
  if (!Number.isFinite(c) || !Number.isFinite(r) || r <= 0) return null;
  return ((c - r) / r) * 100;
}

function pricePositionLabel(signal) {
  const labels = {
    day_high_breakout: '日中高値突破',
    day_low_breakdown: '日中安値割れ',
    range_breakout_up: '30分レンジ上抜け',
    range_breakout_down: '30分レンジ下抜け',
    near_day_high: '日中高値接近',
    near_day_low: '日中安値接近',
    range_upper: '30分レンジ上限付近',
    range_lower: '30分レンジ下限付近',
    range_middle: '30分レンジ中央付近',
    unknown: '価格位置不明',
  };
  return labels[signal] || '価格位置メモ';
}

function buildPricePositionContext(symbolRows, latest, thresholdPct) {
  const threshold = Number(thresholdPct);
  const proximityPct = Number.isFinite(threshold) && threshold > 0 ? Math.max(0.04, threshold * 0.35) : 0.08;
  const current = Number(latest?.price);
  if (!latest || !Number.isFinite(current) || !Array.isArray(symbolRows) || symbolRows.length < 2) {
    return {
      ok: false,
      signal: 'unknown',
      label: pricePositionLabel('unknown'),
      level: '—',
      level_rank: 0,
      alert_hit: false,
      note: '価格位置を判定する履歴が不足しています。',
      active_alerts: [],
    };
  }
  const latestTime = latest.timestamp instanceof Date ? latest.timestamp : new Date(latest.timestamp);
  const sameDayKey = jstDateKey(latestTime);
  const dayRowsAll = symbolRows.filter((row) => row.timestamp <= latestTime && jstDateKey(row.timestamp) === sameDayKey && Number.isFinite(Number(row.price)));
  const beforeRows = symbolRows.filter((row) => row.timestamp < latestTime && Number.isFinite(Number(row.price)));
  const dayRowsBefore = beforeRows.filter((row) => jstDateKey(row.timestamp) === sameDayKey);
  const rangeStart = new Date(latestTime.getTime() - 30 * 60 * 1000);
  const rangeRowsAll = symbolRows.filter((row) => row.timestamp >= rangeStart && row.timestamp <= latestTime && Number.isFinite(Number(row.price)));
  const rangeRowsBefore = symbolRows.filter((row) => row.timestamp >= rangeStart && row.timestamp < latestTime && Number.isFinite(Number(row.price)));

  const prices = (items) => items.map((row) => Number(row.price)).filter(Number.isFinite);
  const dayPricesAll = prices(dayRowsAll);
  const dayPricesBefore = prices(dayRowsBefore);
  const rangePricesAll = prices(rangeRowsAll);
  const rangePricesBefore = prices(rangeRowsBefore);
  const dayHigh = dayPricesAll.length ? Math.max(...dayPricesAll) : null;
  const dayLow = dayPricesAll.length ? Math.min(...dayPricesAll) : null;
  const prevDayHigh = dayPricesBefore.length ? Math.max(...dayPricesBefore) : dayHigh;
  const prevDayLow = dayPricesBefore.length ? Math.min(...dayPricesBefore) : dayLow;
  const rangeHigh = rangePricesAll.length ? Math.max(...rangePricesAll) : null;
  const rangeLow = rangePricesAll.length ? Math.min(...rangePricesAll) : null;
  const prevRangeHigh = rangePricesBefore.length ? Math.max(...rangePricesBefore) : rangeHigh;
  const prevRangeLow = rangePricesBefore.length ? Math.min(...rangePricesBefore) : rangeLow;

  const distanceToDayHighPct = signedPctDiff(current, dayHigh);
  const distanceToDayLowPct = signedPctDiff(current, dayLow);
  const distanceToPrevDayHighPct = signedPctDiff(current, prevDayHigh);
  const distanceToPrevDayLowPct = signedPctDiff(current, prevDayLow);
  const distanceToRangeHighPct = signedPctDiff(current, rangeHigh);
  const distanceToRangeLowPct = signedPctDiff(current, rangeLow);
  const distanceToPrevRangeHighPct = signedPctDiff(current, prevRangeHigh);
  const distanceToPrevRangeLowPct = signedPctDiff(current, prevRangeLow);
  const rangeSpanPct = Number.isFinite(Number(rangeHigh)) && Number.isFinite(Number(rangeLow)) && Number(rangeLow) > 0 ? ((Number(rangeHigh) - Number(rangeLow)) / Number(rangeLow)) * 100 : null;
  const rangePositionRatio = Number.isFinite(Number(rangeHigh)) && Number.isFinite(Number(rangeLow)) && Number(rangeHigh) > Number(rangeLow) ? (current - Number(rangeLow)) / (Number(rangeHigh) - Number(rangeLow)) : null;

  const activeAlerts = [];
  const add = (type, label, level, levelRank, note) => {
    activeAlerts.push({ family: 'price_position', type, label, level, level_rank: levelRank, note });
  };

  let signal = 'range_middle';
  let level = '注意以上なし';
  let levelRank = 0;
  let alertHit = false;
  let note = '価格は直近レンジの中央付近です。方向アラートや出来高と組み合わせて見ます。';

  const brokePrevDayHigh = Number.isFinite(Number(distanceToPrevDayHighPct)) && distanceToPrevDayHighPct >= 0 && dayRowsBefore.length >= 2;
  const brokePrevDayLow = Number.isFinite(Number(distanceToPrevDayLowPct)) && distanceToPrevDayLowPct <= 0 && dayRowsBefore.length >= 2;
  const brokePrevRangeHigh = Number.isFinite(Number(distanceToPrevRangeHighPct)) && distanceToPrevRangeHighPct >= 0 && rangeRowsBefore.length >= 2;
  const brokePrevRangeLow = Number.isFinite(Number(distanceToPrevRangeLowPct)) && distanceToPrevRangeLowPct <= 0 && rangeRowsBefore.length >= 2;
  const nearDayHigh = Number.isFinite(Number(distanceToDayHighPct)) && Math.abs(distanceToDayHighPct) <= proximityPct;
  const nearDayLow = Number.isFinite(Number(distanceToDayLowPct)) && Math.abs(distanceToDayLowPct) <= proximityPct;
  const nearRangeHigh = Number.isFinite(Number(rangePositionRatio)) && rangePositionRatio >= 0.72;
  const nearRangeLow = Number.isFinite(Number(rangePositionRatio)) && rangePositionRatio <= 0.28;

  if (brokePrevDayHigh && Number.isFinite(Number(distanceToPrevDayHighPct)) && distanceToPrevDayHighPct >= Math.max(0, proximityPct * 0.25)) {
    signal = 'day_high_breakout';
    level = 'Lv2 注意'; levelRank = 2; alertHit = true;
    note = '日中高値を上抜けています。追随候補にするには出来高・約定回数・コスト後Netの裏付けが必要です。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  } else if (brokePrevDayLow && Number.isFinite(Number(distanceToPrevDayLowPct)) && distanceToPrevDayLowPct <= -Math.max(0, proximityPct * 0.25)) {
    signal = 'day_low_breakdown';
    level = 'Lv2 注意'; levelRank = 2; alertHit = true;
    note = '日中安値を割っています。買い候補は浅い指値を外し、反発確認後または深め指値に限定する材料です。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  } else if (brokePrevRangeHigh && Number.isFinite(Number(distanceToPrevRangeHighPct)) && distanceToPrevRangeHighPct >= Math.max(0, proximityPct * 0.25)) {
    signal = 'range_breakout_up';
    level = 'Lv2 注意'; levelRank = 2; alertHit = true;
    note = '30分レンジを上抜けています。ブレイク追随候補は出来高の裏付けがある時だけ残し、弱い時は押し目待ちに寄せます。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  } else if (brokePrevRangeLow && Number.isFinite(Number(distanceToPrevRangeLowPct)) && distanceToPrevRangeLowPct <= -Math.max(0, proximityPct * 0.25)) {
    signal = 'range_breakout_down';
    level = 'Lv2 注意'; levelRank = 2; alertHit = true;
    note = '30分レンジを下抜けています。逆張り買いは続落リスクを重く見て、深め指値または反発確認に限定します。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  } else if (nearDayHigh) {
    signal = 'near_day_high';
    level = 'Lv1 情報'; levelRank = 1;
    note = '日中高値に近い位置です。上昇中でも現在価格追随は高値掴みになりやすく、押し目候補を優先します。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  } else if (nearDayLow) {
    signal = 'near_day_low';
    level = 'Lv1 情報'; levelRank = 1;
    note = '日中安値に近い位置です。反発候補にはなりますが、下抜け時は買い候補から外す条件も同時に置きます。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  } else if (nearRangeHigh) {
    signal = 'range_upper';
    level = 'Lv1 情報'; levelRank = 1;
    note = '30分レンジ上限寄りです。買い候補としては追随より、上抜け確認か押し目待ちに分ける材料です。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  } else if (nearRangeLow) {
    signal = 'range_lower';
    level = 'Lv1 情報'; levelRank = 1;
    note = '30分レンジ下限寄りです。買い候補なら深すぎない指値や反発確認を比較する材料です。';
    add(signal, pricePositionLabel(signal), level, levelRank, note);
  }

  return {
    ok: true,
    signal,
    label: pricePositionLabel(signal),
    level,
    level_rank: levelRank,
    alert_hit: alertHit,
    note,
    current_price: current,
    day_key: sameDayKey,
    day_high: Number.isFinite(Number(dayHigh)) ? dayHigh : null,
    day_low: Number.isFinite(Number(dayLow)) ? dayLow : null,
    range_high_30m: Number.isFinite(Number(rangeHigh)) ? rangeHigh : null,
    range_low_30m: Number.isFinite(Number(rangeLow)) ? rangeLow : null,
    range_span_pct: Number.isFinite(Number(rangeSpanPct)) ? rangeSpanPct : null,
    range_position_ratio: Number.isFinite(Number(rangePositionRatio)) ? rangePositionRatio : null,
    distance_to_day_high_pct: Number.isFinite(Number(distanceToDayHighPct)) ? distanceToDayHighPct : null,
    distance_to_day_low_pct: Number.isFinite(Number(distanceToDayLowPct)) ? distanceToDayLowPct : null,
    distance_to_range_high_pct: Number.isFinite(Number(distanceToRangeHighPct)) ? distanceToRangeHighPct : null,
    distance_to_range_low_pct: Number.isFinite(Number(distanceToRangeLowPct)) ? distanceToRangeLowPct : null,
    proximity_pct: proximityPct,
    active_alerts: activeAlerts,
  };
}

function pricePositionSummary(context) {
  if (!context || !context.ok) return '価格位置: 判定不可';
  const high = Number.isFinite(Number(context.distance_to_day_high_pct)) ? `${context.distance_to_day_high_pct.toFixed(3)}%` : '—';
  const low = Number.isFinite(Number(context.distance_to_day_low_pct)) ? `${context.distance_to_day_low_pct.toFixed(3)}%` : '—';
  const range = Number.isFinite(Number(context.range_position_ratio)) ? `${Math.round(context.range_position_ratio * 100)}%位置` : '—';
  return `${context.label} / 日中高値差 ${high} / 日中安値差 ${low} / 30分レンジ ${range}`;
}

function applyPricePositionDecisionOverlay(decision, pricePosition, direction) {
  if (!decision || !pricePosition || !pricePosition.ok) return decision;
  const signal = pricePosition.signal;
  const base = { ...decision, price_position_note: pricePosition.note };
  if (['day_high_breakout', 'range_breakout_up'].includes(signal)) {
    return {
      ...base,
      entry_bias: decision.entry_bias === 'data_unavailable' ? decision.entry_bias : 'breakout_or_pullback_wait',
      decision_title: `${decision.decision_title} / ${pricePosition.label}`,
      decision_comment: `${decision.decision_comment} ${pricePosition.label}のため、追随候補は出来高・取引回数の裏付けがある時だけ残し、弱い時は押し目待ちへ落とす判断です。`,
      order_adjustment: `${decision.order_adjustment} 価格位置は${pricePosition.label}です。成行追随を主候補にせず、浅め指値は高値掴みリスク、標準〜押し目指値は未約定リスクとして比較します。`,
      risk_comment: `${decision.risk_comment} ${pricePosition.label}ではブレイク失敗時の反落を外れ条件にします。`,
    };
  }
  if (['day_low_breakdown', 'range_breakout_down'].includes(signal)) {
    return {
      ...base,
      entry_bias: decision.entry_bias === 'data_unavailable' ? decision.entry_bias : 'deeper_limit_or_rebound_wait',
      decision_title: `${decision.decision_title} / ${pricePosition.label}`,
      decision_comment: `${decision.decision_comment} ${pricePosition.label}のため、浅い買い候補は外し、深め指値または反発確認後だけを残す判断です。`,
      order_adjustment: `${decision.order_adjustment} 価格位置は${pricePosition.label}です。現在価格付近の買いは候補から外し、反発確認または深め指値を比較します。`,
      risk_comment: `${decision.risk_comment} 下抜け後は続落を主リスクとして扱います。`,
    };
  }
  if (['near_day_high', 'range_upper'].includes(signal) && direction === 'up') {
    return {
      ...base,
      decision_title: `${decision.decision_title} / 上限接近`,
      decision_comment: `${decision.decision_comment} 価格が上限寄りのため、買い候補は追随より押し目・標準指値を優先します。`,
      order_adjustment: `${decision.order_adjustment} 上限接近中なので、浅すぎる指値は利益幅不足になりやすく、押し目候補まで下げる判断を残します。`,
    };
  }
  if (['near_day_low', 'range_lower'].includes(signal)) {
    return {
      ...base,
      decision_title: `${decision.decision_title} / 下限接近`,
      decision_comment: `${decision.decision_comment} 価格が下限寄りのため、反発候補と下抜け見送り条件をセットで扱います。`,
      order_adjustment: `${decision.order_adjustment} 下限接近中なので、深すぎない指値候補と反発確認後候補を比較します。下抜け時は候補から外します。`,
    };
  }
  return base;
}


function averageNumber(values) {
  const nums = (values || []).map((value) => Number(value)).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function slopeDirectionLabel(direction) {
  if (direction === 'up') return '上向き';
  if (direction === 'down') return '下向き';
  if (direction === 'flat') return '横ばい';
  return '不明';
}

function slopeDirectionFromPct(pctValue, thresholdPct = 0.03) {
  const value = Number(pctValue);
  const threshold = Math.max(0.006, Number(thresholdPct) || 0.03);
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= threshold) return 'up';
  if (value <= -threshold) return 'down';
  return 'flat';
}

function buildSidewaysContext(symbolRows = [], latest = null, thresholdPct = 0.3, volumeContext = null) {
  const current = Number(latest?.price);
  if (!latest || !Number.isFinite(current) || current <= 0) {
    return {
      ok: false,
      signal: 'unknown',
      label: '横ばい判定不可',
      level: '—',
      level_rank: 0,
      alert_hit: false,
      note: '横ばい判定に必要な価格履歴が不足しています。',
      active_alerts: [],
    };
  }
  const latestTime = latest.timestamp instanceof Date ? latest.timestamp : new Date(latest.timestamp);
  const maxLookbackMinutes = 180;
  const threshold = Number(thresholdPct);
  const sidewaysBandPct = Number.isFinite(threshold) && threshold > 0 ? Math.max(0.035, threshold * 0.42) : 0.10;
  const rows = (Array.isArray(symbolRows) ? symbolRows : [])
    .filter((row) => row && row.timestamp <= latestTime && Number.isFinite(Number(row.price)) && Number(row.price) > 0 && (latestTime - row.timestamp) <= maxLookbackMinutes * 60 * 1000)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (rows.length < 3) {
    return {
      ok: false,
      signal: 'insufficient_sideways_data',
      label: '横ばい判定不可',
      level: '—',
      level_rank: 0,
      alert_hit: false,
      note: '横ばい継続を測る履歴本数が不足しています。',
      active_alerts: [],
    };
  }
  const run = [];
  let high = current;
  let low = current;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const price = Number(rows[i].price);
    high = Math.max(high, price);
    low = Math.min(low, price);
    const rangePct = low > 0 ? ((high - low) / low) * 100 : null;
    if (Number.isFinite(rangePct) && rangePct <= sidewaysBandPct) {
      run.unshift(rows[i]);
    } else {
      break;
    }
  }
  const first = run[0] || rows[rows.length - 1];
  const sidewaysMinutes = Math.max(0, (latestTime - first.timestamp) / 60000);
  const runPrices = run.map((row) => Number(row.price)).filter(Number.isFinite);
  const runHigh = runPrices.length ? Math.max(...runPrices) : current;
  const runLow = runPrices.length ? Math.min(...runPrices) : current;
  const runRangePct = runLow > 0 ? ((runHigh - runLow) / runLow) * 100 : null;
  const rangePositionRatio = runHigh > runLow ? (current - runLow) / (runHigh - runLow) : 0.5;
  const volumeRank = Number(volumeContext?.volume_rank || 0);
  const tradeRank = Number(volumeContext?.trade_count_rank || 0);
  const activeAlerts = [];
  const add = (type, label, level, levelRank, note, alertHit = levelRank >= 2, extra = {}) => {
    activeAlerts.push({ family: 'sideways_range', type, label, level, level_rank: levelRank, note, alert_hit: Boolean(alertHit), ...extra });
  };
  let signal = 'not_sideways';
  let label = '横ばい弱め';
  let level = '注意以上なし';
  let levelRank = 0;
  let alertHit = false;
  let note = '横ばい継続は短く、方向待ち材料としては弱めです。';
  if (sidewaysMinutes >= 45 && Number.isFinite(runRangePct) && runRangePct <= sidewaysBandPct * 0.75) {
    signal = 'long_sideways';
    label = '長めの横ばい';
    level = 'Lv2 注意';
    levelRank = 2;
    alertHit = true;
    note = `${Math.round(sidewaysMinutes)}分ほど狭いレンジに滞在しています。ブレイク待ちまたは下限/上限指値比較の材料です。`;
    add(signal, label, level, levelRank, note, true, { sideways_minutes: sidewaysMinutes, sideways_range_pct: runRangePct });
  } else if (sidewaysMinutes >= 18) {
    signal = 'sideways_established';
    label = '横ばい継続';
    level = 'Lv1 情報';
    levelRank = 1;
    note = `${Math.round(sidewaysMinutes)}分ほど横ばいです。成行追随ではなく、上抜け/下抜けまたはレンジ端の候補に分けます。`;
    add(signal, label, level, levelRank, note, false, { sideways_minutes: sidewaysMinutes, sideways_range_pct: runRangePct });
  } else if (sidewaysMinutes >= 8) {
    signal = 'short_sideways';
    label = '短めの横ばい';
    level = 'Lv1 情報';
    levelRank = 1;
    note = `${Math.round(sidewaysMinutes)}分ほど値幅が小さい状態です。方向が出るまで待機寄りです。`;
    add(signal, label, level, levelRank, note, false, { sideways_minutes: sidewaysMinutes, sideways_range_pct: runRangePct });
  }
  if ((sidewaysMinutes >= 8) && (volumeRank >= 4 || tradeRank >= 4)) {
    signal = 'sideways_volume_surge';
    label = '横ばい＋参加量急増';
    level = 'Lv2 注意';
    levelRank = Math.max(levelRank, 2);
    alertHit = true;
    note = '価格は狭い範囲ですが出来高または取引回数が急増しています。ブレイク前兆または反転前兆として、方向確定待ちにします。';
    add('sideways_volume_surge', label, level, 2, note, true, { sideways_minutes: sidewaysMinutes, sideways_range_pct: runRangePct });
  }
  const breakoutWatch = sidewaysMinutes >= 8 && Number.isFinite(runRangePct) && runRangePct <= sidewaysBandPct;
  return {
    ok: true,
    signal,
    label,
    level,
    level_rank: levelRank,
    alert_hit: alertHit,
    note,
    sideways_minutes: Number(sidewaysMinutes.toFixed(1)),
    sideways_range_pct: Number.isFinite(runRangePct) ? Number(runRangePct.toFixed(4)) : null,
    sideways_band_pct: Number(sidewaysBandPct.toFixed(4)),
    range_high: Number.isFinite(runHigh) ? runHigh : null,
    range_low: Number.isFinite(runLow) ? runLow : null,
    range_position_ratio: Number.isFinite(rangePositionRatio) ? Number(Math.max(0, Math.min(1, rangePositionRatio)).toFixed(4)) : null,
    breakout_watch: breakoutWatch,
    active_alerts: activeAlerts,
  };
}

function sidewaysSummary(context) {
  if (!context || !context.ok) return '横ばい: 判定不可';
  const minutes = Number.isFinite(Number(context.sideways_minutes)) ? `${Math.round(Number(context.sideways_minutes))}分` : '—';
  const range = Number.isFinite(Number(context.sideways_range_pct)) ? `${Number(context.sideways_range_pct).toFixed(3)}%` : '—';
  const position = Number.isFinite(Number(context.range_position_ratio)) ? `${Math.round(Number(context.range_position_ratio) * 100)}%位置` : '—';
  return `${context.label} / 継続 ${minutes} / 値幅 ${range} / レンジ内 ${position}`;
}

function applySidewaysDecisionOverlay(decision, sidewaysContext, volumeContext) {
  if (!decision || !sidewaysContext || !sidewaysContext.ok || (sidewaysContext.level_rank || 0) < 1) return decision;
  const volumeRank = Number(volumeContext?.volume_rank || 0);
  const tradeRank = Number(volumeContext?.trade_count_rank || 0);
  const base = { ...decision, sideways_note: sidewaysContext.note };
  if (sidewaysContext.signal === 'sideways_volume_surge') {
    return {
      ...base,
      entry_bias: 'range_break_or_lower_limit',
      decision_title: `${decision.decision_title} / 横ばい＋参加量急増`,
      decision_comment: `${decision.decision_comment} 横ばい中に参加量が急増しており、実取引ロジックでは方向確定前の成行追随を除外します。`,
      order_adjustment: 'レンジ上抜け後の浅め〜標準指値、レンジ下限付近の深め指値、見送りを別候補に分けます。方向確定前の現在価格追随は候補から外します。',
      target_adjustment: '必要利確価格はレンジ幅とコスト後Netを明確に超える場合だけ検証します。',
      risk_comment: '出来高先行で上下どちらにも動き得るため、上抜け失敗・下抜けを外れ条件にします。',
    };
  }
  if (sidewaysContext.signal === 'long_sideways' || sidewaysContext.signal === 'sideways_established') {
    return {
      ...base,
      entry_bias: volumeRank >= 3 || tradeRank >= 3 ? 'range_break_or_lower_limit' : 'watch_or_standard_limit',
      decision_title: `${decision.decision_title} / ${sidewaysContext.label}`,
      decision_comment: `${decision.decision_comment} ${sidewaysSummary(sidewaysContext)}のため、横ばいを「何もない」ではなくブレイク待ち・レンジ端候補として扱います。`,
      order_adjustment: '現在価格で決め打ちせず、レンジ上抜け確認後の候補とレンジ下限付近の候補を分けます。参加量が薄い場合は見送りを主候補にします。',
      target_adjustment: 'レンジ幅がコスト後Netを超えない場合、小刻み狙いは候補から落とします。',
      risk_comment: '横ばいは方向未確定です。上抜け/下抜け、出来高変化、レンジ幅拡大を外れ条件にします。',
    };
  }
  return base;
}

function technicalDirectionFromSlope(slopePct, thresholdPct) {
  return slopeDirectionFromPct(slopePct, Math.max(0.006, Number(thresholdPct || 0.3) * 0.08));
}

function maAlignmentLabel(alignment) {
  const labels = {
    aligned_up: 'MA上向き整合',
    aligned_down: 'MA下向き整合',
    conflict: 'MA方向不一致',
    flat: 'MA横ばい',
    mixed: 'MA混在',
    unknown: 'MA不明',
  };
  return labels[alignment] || 'MA不明';
}

function buildTechnicalContext(symbolRows = [], latest = null, thresholdPct = 0.3, volumeContext = null, sidewaysContext = null) {
  const current = Number(latest?.price);
  const rows = (Array.isArray(symbolRows) ? symbolRows : [])
    .filter((row) => row && (!latest || row.timestamp <= latest.timestamp) && Number.isFinite(Number(row.price)) && Number(row.price) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!latest || !Number.isFinite(current) || rows.length < 8) {
    return {
      ok: false,
      signal: 'technical_data_unavailable',
      label: 'テクニカル判定不可',
      level: '—',
      level_rank: 0,
      alert_hit: false,
      note: 'テクニカル判定に必要な価格履歴が不足しています。',
      active_alerts: [],
    };
  }
  const threshold = Number(thresholdPct);
  const prices = rows.map((row) => Number(row.price));
  const recent = prices.slice(-60);
  const lastSlice = (n) => recent.slice(-Math.min(n, recent.length));
  const prevSlice = (n) => recent.slice(-Math.min(n * 2, recent.length), -Math.min(n, recent.length));
  const maShort = averageNumber(lastSlice(5));
  const maShortPrev = averageNumber(prevSlice(5));
  const maMid = averageNumber(lastSlice(15));
  const maMidPrev = averageNumber(prevSlice(15));
  const maLong = averageNumber(lastSlice(30));
  const maShortSlopePct = maShortPrev && maShortPrev > 0 ? ((maShort - maShortPrev) / maShortPrev) * 100 : null;
  const maMidSlopePct = maMidPrev && maMidPrev > 0 ? ((maMid - maMidPrev) / maMidPrev) * 100 : null;
  const shortDir = technicalDirectionFromSlope(maShortSlopePct, threshold);
  const midDir = technicalDirectionFromSlope(maMidSlopePct, threshold);
  let maAlignment = 'unknown';
  if (shortDir === 'up' && midDir === 'up') maAlignment = 'aligned_up';
  else if (shortDir === 'down' && midDir === 'down') maAlignment = 'aligned_down';
  else if ((shortDir === 'up' && midDir === 'down') || (shortDir === 'down' && midDir === 'up')) maAlignment = 'conflict';
  else if (shortDir === 'flat' && midDir === 'flat') maAlignment = 'flat';
  else if (shortDir !== 'unknown' || midDir !== 'unknown') maAlignment = 'mixed';

  const stepPcts = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (prev > 0) stepPcts.push(Math.abs(((curr - prev) / prev) * 100));
  }
  const currentAtrPct = averageNumber(stepPcts.slice(-14));
  const previousAtrPct = averageNumber(stepPcts.slice(-28, -14));
  const atrRatio = previousAtrPct && previousAtrPct > 0 ? currentAtrPct / previousAtrPct : null;
  let atrLevel = 'unknown';
  let atrLabel = 'ATR不明';
  if (Number.isFinite(currentAtrPct)) {
    const lowLine = Number.isFinite(threshold) && threshold > 0 ? Math.max(0.006, threshold * 0.10) : 0.015;
    const highLine = Number.isFinite(threshold) && threshold > 0 ? Math.max(0.03, threshold * 0.55) : 0.08;
    const extremeLine = Number.isFinite(threshold) && threshold > 0 ? Math.max(0.06, threshold * 1.0) : 0.16;
    if (currentAtrPct < lowLine) { atrLevel = 'compressed'; atrLabel = 'ATR低下'; }
    else if (currentAtrPct >= extremeLine) { atrLevel = 'extreme'; atrLabel = 'ATR極大'; }
    else if (currentAtrPct >= highLine) { atrLevel = 'expanded'; atrLabel = 'ATR上昇'; }
    else { atrLevel = 'normal'; atrLabel = 'ATR通常'; }
  }
  const vwap = Number(volumeContext?.current_vwap);
  const vwapDistancePct = Number.isFinite(vwap) && vwap > 0 ? ((current - vwap) / vwap) * 100 : null;
  const vwapBase = Number.isFinite(threshold) && threshold > 0 ? Math.max(0.05, threshold * 0.35) : 0.10;
  let vwapState = 'unknown';
  let vwapLabel = 'VWAP不明';
  if (Number.isFinite(vwapDistancePct)) {
    if (vwapDistancePct >= vwapBase * 2) { vwapState = 'above_extended'; vwapLabel = 'VWAP上振れ大'; }
    else if (vwapDistancePct >= vwapBase) { vwapState = 'above'; vwapLabel = 'VWAP上振れ'; }
    else if (vwapDistancePct <= -vwapBase * 2) { vwapState = 'below_extended'; vwapLabel = 'VWAP下振れ大'; }
    else if (vwapDistancePct <= -vwapBase) { vwapState = 'below'; vwapLabel = 'VWAP下振れ'; }
    else { vwapState = 'near'; vwapLabel = 'VWAP近辺'; }
  }

  const activeAlerts = [];
  const add = (type, label, level, levelRank, note, alertHit = levelRank >= 2, extra = {}) => {
    activeAlerts.push({ family: 'technical_context', type, label, level, level_rank: levelRank, note, alert_hit: Boolean(alertHit), ...extra });
  };
  if (maAlignment === 'aligned_up') add('ma_aligned_up', 'MA上向き整合', 'Lv2 注意', 2, '短期・中期MAが上向きで揃っています。上昇継続候補の信頼度を上げる材料です。', true);
  else if (maAlignment === 'aligned_down') add('ma_aligned_down', 'MA下向き整合', 'Lv2 注意', 2, '短期・中期MAが下向きで揃っています。買い候補は浅い位置を除外する材料です。', true);
  else if (maAlignment === 'conflict') add('ma_conflict', 'MA方向不一致', 'Lv2 注意', 2, '短期と中期のMA方向が食い違っています。追随候補を落として待機寄りにします。', true);
  else if (maAlignment === 'flat') add('ma_flat', 'MA横ばい', 'Lv1 情報', 1, 'MAが横ばいで、方向の根拠は弱めです。', false);

  if (atrLevel === 'compressed') add('atr_compressed', 'ATR低下', 'Lv1 情報', 1, '値幅が縮んでいます。横ばい・ブレイク待ちの補助材料です。', false, { atr_pct: currentAtrPct, atr_ratio: atrRatio });
  else if (atrLevel === 'expanded') add('atr_expanded', 'ATR上昇', 'Lv2 注意', 2, '値幅が広がっています。ブレイク候補ですが滑り・逆行リスクも上げます。', true, { atr_pct: currentAtrPct, atr_ratio: atrRatio });
  else if (atrLevel === 'extreme') add('atr_extreme', 'ATR極大', 'Lv3 警戒', 3, '値幅がかなり大きく、成行追随では滑り・高値掴み/安値掴みリスクを重く見ます。', true, { atr_pct: currentAtrPct, atr_ratio: atrRatio });

  if (vwapState === 'above_extended') add('vwap_above_extended', 'VWAP上振れ大', 'Lv2 注意', 2, '価格がVWAPより大きく上です。上昇中でも成行追随は高値掴み注意です。', true, { vwap_distance_pct: vwapDistancePct });
  else if (vwapState === 'below_extended') add('vwap_below_extended', 'VWAP下振れ大', 'Lv2 注意', 2, '価格がVWAPより大きく下です。反発候補にはなりますが、下落継続も同時に警戒します。', true, { vwap_distance_pct: vwapDistancePct });
  else if (vwapState === 'near' && maAlignment === 'aligned_up') add('trend_near_vwap', 'MA上向き＋VWAP近辺', 'Lv2 注意', 2, 'MA上向きで価格がVWAP近辺です。過熱しすぎない上昇継続候補として浅め〜標準指値を検証する材料です。', true);

  if (sidewaysContext?.breakout_watch && atrLevel === 'compressed') {
    add('sideways_atr_squeeze', '横ばい＋ATR低下', 'Lv1 情報', 1, '横ばいとATR低下が重なっています。ブレイク待ちの状態として扱います。', false);
  }
  if (sidewaysContext?.breakout_watch && (atrLevel === 'expanded' || atrLevel === 'extreme')) {
    add('sideways_atr_breakout_watch', '横ばい後のATR上昇', 'Lv2 注意', 2, '横ばい後に値幅が広がっています。上抜け/下抜けの方向確定を待つ材料です。', true);
  }

  const ranked = activeAlerts.slice().sort((a, b) => ((b.level_rank || 0) - (a.level_rank || 0)) || (Number(b.alert_hit) - Number(a.alert_hit)));
  const primary = ranked[0] || null;
  const summaryParts = [maAlignmentLabel(maAlignment), atrLabel, vwapLabel].filter(Boolean);
  return {
    ok: true,
    signal: primary?.type || 'technical_context',
    label: primary?.label || 'テクニカル通常',
    level: primary?.level || '注意以上なし',
    level_rank: primary?.level_rank || 0,
    alert_hit: ranked.some((item) => item.alert_hit && (item.level_rank || 0) >= 2),
    note: primary?.note || summaryParts.join(' / '),
    ma_short: Number.isFinite(maShort) ? maShort : null,
    ma_mid: Number.isFinite(maMid) ? maMid : null,
    ma_long: Number.isFinite(maLong) ? maLong : null,
    ma_short_slope_pct: Number.isFinite(maShortSlopePct) ? maShortSlopePct : null,
    ma_mid_slope_pct: Number.isFinite(maMidSlopePct) ? maMidSlopePct : null,
    short_ma_direction: shortDir,
    mid_ma_direction: midDir,
    short_ma_label: slopeDirectionLabel(shortDir),
    mid_ma_label: slopeDirectionLabel(midDir),
    ma_alignment: maAlignment,
    ma_alignment_label: maAlignmentLabel(maAlignment),
    atr_pct: Number.isFinite(currentAtrPct) ? currentAtrPct : null,
    atr_previous_pct: Number.isFinite(previousAtrPct) ? previousAtrPct : null,
    atr_ratio: Number.isFinite(atrRatio) ? atrRatio : null,
    atr_level: atrLevel,
    atr_label: atrLabel,
    vwap: Number.isFinite(vwap) ? vwap : null,
    vwap_distance_pct: Number.isFinite(vwapDistancePct) ? vwapDistancePct : null,
    vwap_state: vwapState,
    vwap_label: vwapLabel,
    technical_bias: primary?.type || maAlignment,
    summary: summaryParts.join(' / '),
    active_alerts: ranked.map(compactActiveAlert).filter(Boolean),
  };
}

function technicalSummary(context) {
  if (!context || !context.ok) return 'テクニカル: 判定不可';
  const atr = Number.isFinite(Number(context.atr_pct)) ? `${Number(context.atr_pct).toFixed(3)}%` : '—';
  const vwap = Number.isFinite(Number(context.vwap_distance_pct)) ? `${Number(context.vwap_distance_pct).toFixed(3)}%` : '—';
  return `${context.ma_alignment_label || 'MA不明'} / ${context.atr_label || 'ATR不明'} ${atr} / ${context.vwap_label || 'VWAP不明'} ${vwap}`;
}

function applyTechnicalDecisionOverlay(decision, technicalContext, direction) {
  if (!decision || !technicalContext || !technicalContext.ok || (technicalContext.level_rank || 0) < 1) return decision;
  const signal = technicalContext.signal;
  const base = { ...decision, technical_note: technicalContext.note };
  if (signal === 'atr_extreme') {
    return {
      ...base,
      entry_bias: 'wait_for_pullback',
      decision_title: `${decision.decision_title} / ATR極大`,
      decision_comment: `${decision.decision_comment} ATRが極端に大きく、実取引では滑り・逆行を重く見ます。`,
      order_adjustment: '成行追随は候補から外し、急変が落ち着いた後の押し目/反発確認候補だけを残します。',
      target_adjustment: '必要利確価格は広めに見積もり、コスト後Netが残る条件だけを検証します。',
      risk_comment: '値幅急拡大中は約定直後の逆行と板滑りを主リスクにします。',
    };
  }
  if (signal === 'ma_aligned_up' || signal === 'trend_near_vwap') {
    return {
      ...base,
      entry_bias: direction === 'down' ? 'standard_limit_or_watch' : 'shallow_to_standard_limit',
      decision_title: `${decision.decision_title} / ${technicalContext.label}`,
      decision_comment: `${decision.decision_comment} テクニカルは上昇継続側の材料です。ただし単独ではなく出来高・価格位置・コストと合わせて候補を残します。`,
      order_adjustment: '浅め指値で到達機会、標準指値で利確余地を比較します。VWAP上振れが大きい場合は追随を落とします。',
      target_adjustment: 'MA整合が続く間だけ必要利確価格を検証し、VWAP過熱または出来高低下で候補を落とします。',
      risk_comment: 'MA整合が崩れる、またはVWAP上振れが拡大する場合を外れ条件にします。',
    };
  }
  if (signal === 'ma_aligned_down') {
    return {
      ...base,
      entry_bias: 'deeper_limit_or_rebound_wait',
      decision_title: `${decision.decision_title} / MA下向き整合`,
      decision_comment: `${decision.decision_comment} テクニカルは下向きで揃っています。浅い買い候補は除外します。`,
      order_adjustment: '買い候補は深め指値または反発確認後に限定します。現在価格付近と浅め指値は候補から外します。',
      target_adjustment: '下向きMAが解消するまで、必要利確価格は反発確認後だけ検証します。',
      risk_comment: '下向きMA継続中は続落を主リスクにします。',
    };
  }
  if (signal === 'ma_conflict' || signal === 'sideways_atr_breakout_watch') {
    return {
      ...base,
      entry_bias: 'range_break_or_lower_limit',
      decision_title: `${decision.decision_title} / ${technicalContext.label}`,
      decision_comment: `${decision.decision_comment} テクニカルに方向未確定またはブレイク待ちの材料があります。`,
      order_adjustment: '現在価格で決め打ちせず、上抜け後候補・下限候補・見送りを分けます。',
      target_adjustment: '方向確定前はレンジ幅とコスト後Netを超える条件だけ候補にします。',
      risk_comment: 'MA方向が揃う、またはレンジ突破後に出来高が維持されることを確認材料にします。',
    };
  }
  if (signal === 'vwap_above_extended') {
    return {
      ...base,
      entry_bias: 'wait_for_pullback',
      decision_title: `${decision.decision_title} / VWAP上振れ大`,
      decision_comment: `${decision.decision_comment} VWAPから大きく上振れており、追随買いは高値掴み注意です。`,
      order_adjustment: '成行追随を除外し、押し目候補または標準指値まで下げて利確余地を作ります。',
      target_adjustment: '必要利確価格は上げすぎず、過熱が落ち着く条件で検証します。',
      risk_comment: 'VWAP回帰の反落を主リスクとして扱います。',
    };
  }
  if (signal === 'vwap_below_extended') {
    return {
      ...base,
      entry_bias: 'deeper_limit_or_rebound_wait',
      decision_title: `${decision.decision_title} / VWAP下振れ大`,
      decision_comment: `${decision.decision_comment} VWAPから大きく下振れており、反発候補と続落リスクが両方あります。`,
      order_adjustment: '浅い買いは除外し、反発確認後または深め指値だけを候補にします。',
      target_adjustment: '反発幅がコスト後Netを超える場合だけ検証します。',
      risk_comment: 'VWAPへ戻れない場合は続落を外れ条件にします。',
    };
  }
  return base;
}

function directionAlertSummary(windowMoves) {
  const rows = Array.isArray(windowMoves) ? windowMoves.filter((row) => row && row.ok) : [];
  if (!rows.length) return '方向アラート判定不可';
  const notable = rows.filter((row) => (row.level_rank || 0) >= 1);
  const target = notable.length ? notable : rows.slice(-2);
  return target.map((row) => `${row.window_minutes}分:${row.movement_alert_label} ${Number.isFinite(Number(row.move_pct)) ? Number(row.move_pct).toFixed(3) : '—'}%`).join(' / ');
}

function decisionConfidence({ movePct, thresholdPct, volumeContext }) {
  const strength = movementStrength(movePct, thresholdPct);
  const volumeRank = Number(volumeContext?.volume_rank || 0);
  const tradeRank = Number(volumeContext?.trade_count_rank || 0);
  if (strength === 'strong' && (volumeRank >= 3 || tradeRank >= 3)) {
    return { level: '中〜高', reason: '値動きが大きく、出来高または取引回数の裏付けがあります。' };
  }
  if (strength === 'threshold') {
    return volumeRank >= 3 || tradeRank >= 3
      ? { level: '中', reason: 'しきい値以上の値動きに、参加量の裏付けが一部あります。' }
      : { level: '低〜中', reason: '値動きはありますが、出来高の裏付けは強くありません。' };
  }
  if (volumeRank >= 4 || tradeRank >= 4) {
    return { level: '中', reason: '価格変化は小さめですが、出来高または取引回数が急増しています。' };
  }
  return { level: '低', reason: '値動きが小さく、判断材料はまだ弱めです。' };
}

function candidate(label, key, status, reason) {
  return { key, label, status, reason };
}

function orderCandidatesForEntryBias(entryBias, { movePct, costHeavy }) {
  const direction = movementDirection(movePct);
  if (entryBias === 'data_unavailable') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', '価格・出来高データ不足のため候補から外します。'),
      candidate('浅め指値', 'shallow_limit', 'excluded', '起点データが不足しているため候補から外します。'),
      candidate('標準指値', 'standard_limit', 'excluded', 'シミュレーション材料が不足しています。'),
      candidate('深め指値', 'deep_limit', 'excluded', 'シミュレーション材料が不足しています。'),
      candidate('待機/見送り', 'watch_only', 'preferred', 'データ取得を先に整える候補です。'),
    ];
  }
  if (entryBias === 'no_trade_cost_exceeds') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', 'コストがしきい値以上で、現在価格追随は取引候補から外します。'),
      candidate('浅め指値', 'shallow_limit', 'excluded', '浅い指値ではコスト後Netが残りにくい前提です。'),
      candidate('標準指値', 'standard_limit', 'excluded', '標準指値でも利確余地が不足しやすいため除外寄りです。'),
      candidate('深め指値', 'deep_limit', 'weak', '十分な利確余地を作れる場合だけ検証候補に残します。'),
      candidate('待機/見送り', 'watch_only', 'preferred', 'コスト差が改善するまで取引しない候補を優先します。'),
    ];
  }
  if (entryBias === 'wait_for_pullback') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', '急騰後で滑り・高値掴みを重く見ます。'),
      candidate('浅め指値', 'shallow_limit', 'conditional', '押し目を待つ条件付き候補です。'),
      candidate('標準指値', 'standard_limit', 'candidate', '押し目候補として残します。'),
      candidate('深め指値', 'deep_limit', 'watch', '未約定リスクはありますが、反落待ち候補として残します。'),
      candidate('待機/見送り', 'watch_only', 'candidate', '急変が落ち着くまでの待機候補です。'),
    ];
  }
  if (entryBias === 'lower_limit_for_margin') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', 'コスト余裕が小さく、現在価格追随ではNetが残りにくい前提です。'),
      candidate('浅め指値', 'shallow_limit', 'weak', '約定しやすい一方、利確余地が不足しやすいです。'),
      candidate('標準指値', 'standard_limit', 'candidate', 'コスト後Netを残す候補として優先します。'),
      candidate('深め指値', 'deep_limit', 'candidate', '利確余地は作れますが、未約定リスクがあります。'),
      candidate('待機/見送り', 'watch_only', 'candidate', 'コスト差が改善するまで待つ候補です。'),
    ];
  }
  if (entryBias === 'shallow_to_standard_limit') {
    return [
      candidate('成行追随', 'market_follow', costHeavy ? 'excluded' : 'weak', costHeavy ? 'コストが近く、成行追随は除外寄りです。' : '滑りを受けるため優先度は下げます。'),
      candidate('浅め指値', 'shallow_limit', 'candidate', '出来高の裏付けがあり、到達機会を残す候補です。'),
      candidate('標準指値', 'standard_limit', 'candidate', '利確余地とのバランス候補です。'),
      candidate('深め指値', 'deep_limit', 'watch', '価格は有利ですが、未約定リスクを見ます。'),
      candidate('待機/見送り', 'watch_only', 'watch', '急変が強まるなら待機候補です。'),
    ];
  }
  if (entryBias === 'standard_limit') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', '追随では価格の有利さが小さくなります。'),
      candidate('浅め指値', 'shallow_limit', 'weak', '浅すぎると利益幅不足になりやすいです。'),
      candidate('標準指値', 'standard_limit', 'preferred', '価格の有利さと到達機会のバランス候補です。'),
      candidate('深め指値', 'deep_limit', 'watch', '未約定リスクを許容する待機候補です。'),
      candidate('待機/見送り', 'watch_only', 'watch', '参加量が弱い場合に残す候補です。'),
    ];
  }
  if (entryBias === 'standard_limit_or_watch' || entryBias === 'watch_or_standard_limit') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', '出来高の裏付けが弱く、追随候補から外します。'),
      candidate('浅め指値', 'shallow_limit', 'weak', '伸び不足になりやすいため優先度は低めです。'),
      candidate('標準指値', 'standard_limit', 'candidate', '待つなら標準指値候補です。'),
      candidate('深め指値', 'deep_limit', 'candidate', '利確余地を確保する待機候補です。'),
      candidate('待機/見送り', 'watch_only', 'preferred', '材料が強まるまで待つ候補です。'),
    ];
  }
  if (entryBias === 'deeper_limit_or_rebound_wait') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', '出来高を伴う下落中で、現在価格追随は除外します。'),
      candidate('浅め指値', 'shallow_limit', 'excluded', '浅い買いは下落継続に巻き込まれるリスクを重く見ます。'),
      candidate('標準指値', 'standard_limit', 'weak', '反発確認がない場合は弱い候補です。'),
      candidate('深め指値', 'deep_limit', 'candidate', '反発待ち・深め指値として残します。'),
      candidate('待機/見送り', 'watch_only', 'preferred', '下落が止まるまで待つ候補です。'),
    ];
  }
  if (entryBias === 'range_break_or_lower_limit') {
    return [
      candidate('成行追随', 'market_follow', 'excluded', '方向が出る前の攻防のため除外します。'),
      candidate('浅め指値', 'shallow_limit', 'conditional', 'レンジ上限突破後なら候補にします。'),
      candidate('標準指値', 'standard_limit', 'conditional', 'レンジ内では条件付き候補です。'),
      candidate('深め指値', 'deep_limit', 'candidate', 'レンジ下限付近の候補として残します。'),
      candidate('待機/見送り', 'watch_only', 'candidate', '方向が出るまで待つ候補です。'),
    ];
  }
  return [
    candidate('成行追随', 'market_follow', 'excluded', direction === 'down' ? '下落中のため追随買いは候補から外します。' : '値動きが弱く、追随候補から外します。'),
    candidate('浅め指値', 'shallow_limit', 'weak', '約定しやすい一方、利確余地が不足しやすいです。'),
    candidate('標準指値', 'standard_limit', 'watch', '条件が強まるまで待機候補です。'),
    candidate('深め指値', 'deep_limit', 'candidate', '事前に決めた価格余地のある候補だけ残します。'),
    candidate('待機/見送り', 'watch_only', 'preferred', '現在の主候補です。'),
  ];
}

function enrichDecisionContext({ symbol, windowMinutes, alertMode, movePct, thresholdPct, costFloorPct, levelInfo, volumeContext, volumeCostContext = null, costContext = null, decision, movementWindowMoves = [], primaryDirectionAlert = null, continuationAlert = null, pricePositionContext = null, sidewaysContext = null, technicalContext = null, combinedSignalContext = null, selectedWindowMovePct = null, selectedWindowMinutes = null }) {
  const move = Number(movePct);
  const threshold = Number(thresholdPct);
  const cost = Number(costFloorPct);
  const direction = movementDirection(move);
  const strength = movementStrength(move, threshold);
  const costHeavy = Number.isFinite(cost) && Number.isFinite(threshold) && threshold > 0 && cost >= threshold * 0.9;
  const confidence = decisionConfidence({ movePct: move, thresholdPct: threshold, volumeContext });
  const candidates = orderCandidatesForEntryBias(decision.entry_bias, { movePct: move, costHeavy });
  const preferred = candidates.find((item) => item.status === 'preferred') || candidates.find((item) => item.status === 'candidate') || candidates[candidates.length - 1] || null;
  const excluded = candidates.filter((item) => item.status === 'excluded');
  const volumeRank = Number(volumeContext?.volume_rank || 0);
  const tradeRank = Number(volumeContext?.trade_count_rank || 0);
  const invalidationConditions = [];
  if (strength === 'small' || strength === 'info') {
    invalidationConditions.push(`価格が${windowMinutes}分しきい値 ${Number.isFinite(threshold) ? threshold.toFixed(2) : '—'}% を超える。`);
  }
  if (volumeRank < 3 && tradeRank < 3) {
    invalidationConditions.push('出来高または取引回数が「厚い」以上に増える。');
  }
  if (direction === 'down') {
    invalidationConditions.push('下落が止まり、反発後も出来高が維持される。');
  }
  if (costContext?.cost_risk === 'high' || costContext?.cost_risk === 'near_threshold') {
    invalidationConditions.push('コスト目安がしきい値から十分に下がる、または必要値幅がコストを明確に上回る。');
  }
  if (sidewaysContext?.breakout_watch) {
    invalidationConditions.push('横ばいレンジを上抜けまたは下抜けし、方向が確定する。');
  }
  if (technicalContext?.ma_alignment === 'conflict') {
    invalidationConditions.push('短期MAと中期MAの方向が揃う。');
  }
  if (technicalContext?.vwap_state === 'above_extended') {
    invalidationConditions.push('VWAP上振れが縮小し、過熱が落ち着く。');
  }
  if (Array.isArray(combinedSignalContext?.invalidation_conditions)) {
    combinedSignalContext.invalidation_conditions.forEach((item) => {
      if (item && !invalidationConditions.includes(item)) invalidationConditions.push(item);
    });
  }
  if (!invalidationConditions.length) {
    invalidationConditions.push('出来高・値動き・コスト差のいずれかが現在条件から大きく変わる。');
  }
  const directionSummary = directionAlertSummary(movementWindowMoves);
  const continuationSummary = continuationAlert && continuationAlert.signal !== 'no_continuation' ? `${continuationAlert.label}：${continuationAlert.note}` : '';
  const pricePositionText = pricePositionSummary(pricePositionContext);
  const sidewaysText = sidewaysSummary(sidewaysContext);
  const technicalText = technicalSummary(technicalContext);
  const volumeCostSummary = volumeCostContext?.summary ? `。${volumeCostContext.summary}` : '';
  const combinedSummary = combinedSignalContext?.summary ? `。継続・矛盾チェック: ${combinedSignalContext.summary}` : '';
  const currentInsight = `${decision.decision_title}。${directionSummary}${continuationSummary ? `。${continuationSummary}` : ''}。${pricePositionText}。${sidewaysText}。${technicalText}。${decision.market_context_text || marketContextSummary(volumeContext)}${volumeCostSummary}${combinedSummary}`;
  const conditionalForecast = decision.order_adjustment || decision.decision_comment || '条件付き見通しは未判定です。';
  const simulationUse = preferred
    ? `売買シミュレーターでは「${preferred.label}」を主候補として検証し、除外候補は取引しない比較対象にします。`
    : '売買シミュレーターへ渡す主候補は未定です。';
  return {
    schema_version: 1,
    purpose: 'future_trade_simulation_and_decision_engine',
    execution_stage: 'analysis_only_no_real_order',
    symbol,
    window_minutes: windowMinutes,
    selected_window_minutes: Number.isFinite(Number(selectedWindowMinutes)) ? Number(selectedWindowMinutes) : windowMinutes,
    selected_window_move_pct: Number.isFinite(Number(selectedWindowMovePct)) ? Number(selectedWindowMovePct) : (Number.isFinite(move) ? move : null),
    decision_basis_window_minutes: windowMinutes,
    decision_basis_move_pct: Number.isFinite(move) ? move : null,
    alert_mode: alertMode,
    current_insight: currentInsight,
    conditional_forecast: conditionalForecast,
    confidence_level: confidence.level,
    confidence_reason: confidence.reason,
    market_state: {
      direction,
      direction_label: movementDirectionLabel(direction),
      movement_strength: strength,
      movement_strength_label: movementStrengthLabel(strength),
      movement_alert_type: levelInfo?.movement_alert_type || movementAlertType(move, threshold),
      movement_alert_label: levelInfo?.movement_alert_label || movementAlertLabel(movementAlertType(move, threshold)),
      primary_direction_alert: primaryDirectionAlert || null,
      continuation_alert: continuationAlert || null,
      continuation_signal: continuationAlert?.signal || 'unknown',
      continuation_label: continuationAlert?.label || '継続判定不可',
      multi_window_direction: continuationAlert?.direction || direction,
      supporting_windows: Array.isArray(continuationAlert?.supporting_windows) ? continuationAlert.supporting_windows : [],
      threshold_windows: Array.isArray(continuationAlert?.threshold_windows) ? continuationAlert.threshold_windows : [],
      short_term_confirmation: continuationAlert?.short_term_confirmation || 'unknown',
      price_position_signal: pricePositionContext?.signal || 'unknown',
      price_position_label: pricePositionContext?.label || '価格位置不明',
      price_position_note: pricePositionContext?.note || '',
      sideways_signal: sidewaysContext?.signal || 'unknown',
      sideways_label: sidewaysContext?.label || '横ばい判定不可',
      sideways_minutes: Number.isFinite(Number(sidewaysContext?.sideways_minutes)) ? Number(sidewaysContext.sideways_minutes) : null,
      sideways_range_pct: Number.isFinite(Number(sidewaysContext?.sideways_range_pct)) ? Number(sidewaysContext.sideways_range_pct) : null,
      breakout_watch: Boolean(sidewaysContext?.breakout_watch),
      technical_signal: technicalContext?.signal || 'unknown',
      technical_label: technicalContext?.label || 'テクニカル判定不可',
      ma_alignment: technicalContext?.ma_alignment || 'unknown',
      atr_level: technicalContext?.atr_level || 'unknown',
      vwap_state: technicalContext?.vwap_state || 'unknown',
      selected_window_minutes: Number.isFinite(Number(selectedWindowMinutes)) ? Number(selectedWindowMinutes) : windowMinutes,
      selected_window_move_pct: Number.isFinite(Number(selectedWindowMovePct)) ? Number(selectedWindowMovePct) : (Number.isFinite(move) ? move : null),
      decision_basis_window_minutes: windowMinutes,
      decision_basis_move_pct: Number.isFinite(move) ? move : null,
      direction_window_summary: directionSummary,
      direction_window_moves: movementWindowMoves,
      move_pct: Number.isFinite(move) ? move : null,
      threshold_pct: Number.isFinite(threshold) ? threshold : null,
      level: levelInfo?.level || '注意以上なし',
      volume_level: volumeContext?.volume_level || 'unknown',
      volume_ratio: Number.isFinite(Number(volumeContext?.volume_ratio)) ? Number(volumeContext.volume_ratio) : null,
      trade_count_level: volumeContext?.trade_count_level || 'unknown',
      trade_count_ratio: Number.isFinite(Number(volumeContext?.trade_count_ratio)) ? Number(volumeContext.trade_count_ratio) : null,
      taker_buy_ratio: Number.isFinite(Number(volumeContext?.taker_buy_ratio)) ? Number(volumeContext.taker_buy_ratio) : null,
      order_flow_bias: volumeCostContext?.order_flow_bias || orderFlowBiasFromTakerRatio(volumeContext?.taker_buy_ratio).bias,
      order_flow_label: volumeCostContext?.order_flow_label || orderFlowBiasFromTakerRatio(volumeContext?.taker_buy_ratio).label,
      volume_cost_signal: volumeCostContext?.primary_signal || 'none',
      volume_cost_label: volumeCostContext?.primary_label || '出来高・コスト通常',
      combined_signal: combinedSignalContext?.combined_signal || 'no_combined_signal',
      combined_label: combinedSignalContext?.combined_label || '複合判定なし',
      combined_level: combinedSignalContext?.combined_level || '注意以上なし',
      cost_floor_pct: Number.isFinite(cost) ? cost : null,
      cost_risk: costContext?.cost_risk || (costHeavy ? 'near_threshold' : 'unknown'),
      cost_label: costContext?.cost_label || '',
      threshold_gap_pct: Number.isFinite(Number(costContext?.threshold_gap_pct)) ? Number(costContext.threshold_gap_pct) : (Number.isFinite(cost) && Number.isFinite(threshold) ? threshold - cost : null),
      cost_heavy: Boolean(costHeavy),
    },
    price_position: pricePositionContext || null,
    price_position_summary: pricePositionText,
    sideways_context: sidewaysContext || null,
    sideways_summary: sidewaysText,
    technical_context: technicalContext || null,
    technical_summary: technicalText,
    volume_cost_context: volumeCostContext || null,
    combined_signal_context: combinedSignalContext || null,
    combined_signal_summary: combinedSignalContext?.summary || '継続・矛盾チェックで注意以上の追加材料はありません。',
    combined_signal: combinedSignalContext?.combined_signal || 'no_combined_signal',
    combined_label: combinedSignalContext?.combined_label || '複合判定なし',
    cost_context: costContext || null,
    volume_alert_summary: volumeCostContext?.volume_alert_summary || '',
    order_flow_summary: volumeCostContext?.order_flow_summary || '',
    cost_alert_summary: volumeCostContext?.cost_alert_summary || costContext?.note || '',
    reference_mode_context: null,
    active_alerts: [
      ...(Array.isArray(movementWindowMoves) ? movementWindowMoves.filter((row) => row && (row.level_rank || 0) >= 1).map((row) => ({ family: 'price_direction', window_minutes: row.window_minutes, type: row.movement_alert_type, label: row.movement_alert_label, level: row.level, move_pct: row.move_pct })) : []),
      ...((continuationAlert && (continuationAlert.level_rank || 0) >= 1) ? [{ family: 'multi_window_continuation', type: continuationAlert.signal, label: continuationAlert.label, level: continuationAlert.level, direction: continuationAlert.direction, supporting_windows: continuationAlert.supporting_windows, threshold_windows: continuationAlert.threshold_windows, alert_hit: continuationAlert.alert_hit }] : []),
      ...(Array.isArray(pricePositionContext?.active_alerts) ? pricePositionContext.active_alerts.map((item) => ({ ...item, alert_hit: Boolean(pricePositionContext.alert_hit) })) : []),
      ...(Array.isArray(sidewaysContext?.active_alerts) ? sidewaysContext.active_alerts : []),
      ...(Array.isArray(technicalContext?.active_alerts) ? technicalContext.active_alerts : []),
      ...(Array.isArray(volumeCostContext?.active_alerts) ? volumeCostContext.active_alerts : []),
      ...(Array.isArray(combinedSignalContext?.active_alerts) ? combinedSignalContext.active_alerts : []),
    ],
    order_candidates: candidates,
    preferred_candidate: preferred,
    excluded_candidates: excluded,
    order_position_hint: decision.order_adjustment || '',
    target_hint: decision.target_adjustment || '',
    risk_hint: decision.risk_comment || '',
    continuation_alert: continuationAlert || null,
    invalidation_conditions: invalidationConditions,
    simulator_note: simulationUse,
    no_trade_is_valid: preferred?.key === 'watch_only' || excluded.length >= 2,
  };
}

function buildGrowthAlertContext(rows = [], costFloorPct = 0.28, windowMinutes = 15) {
  const moves = rows.map((row) => Number(row.move_pct)).filter(Number.isFinite);
  const maxAbsMove = moves.length ? Math.max(...moves.map((v) => Math.abs(v))) : null;
  const hasDown = moves.some((v) => v < 0);
  const hasVolumeSurge = rows.some((row) => Number(row.volume_context?.volume_rank || 0) >= 4 || Number(row.volume_context?.trade_count_rank || 0) >= 4);
  const hasVolumeCostAlerts = rows.some((row) => row.volume_cost_context && Array.isArray(row.volume_cost_context.active_alerts));
  const hasCostHeavy = rows.some((row) => row.decision_context?.market_state?.cost_heavy || row.cost_context?.cost_risk === 'high' || row.cost_context?.cost_risk === 'near_threshold');
  const hasContinuation = rows.some((row) => row.continuation_alert && (row.continuation_alert.level_rank || 0) >= 1);
  const hasPricePosition = rows.some((row) => row.price_position_context && (row.price_position_context.level_rank || 0) >= 1);
  const hasReferenceModes = rows.some((row) => row.reference_mode_context);
  const hasSideways = rows.some((row) => row.sideways_context && (row.sideways_context.level_rank || 0) >= 1);
  const hasTechnical = rows.some((row) => row.technical_context && Array.isArray(row.technical_context.active_alerts));
  const hasCombinedSignals = rows.some((row) => row.combined_signal_context && Array.isArray(row.combined_signal_context.active_alerts));
  return [
    {
      family: '市場判断 / decision_context',
      status: '着手中',
      priority: 'A',
      note: '現在の気づき、条件付き見通し、注文候補、除外候補、外れ条件を返します。',
    },
    {
      family: '出来高コンテキスト',
      status: hasVolumeCostAlerts ? '更新3 着手済み' : '更新3 着手済み',
      priority: 'A',
      note: '出来高・取引回数・Taker buy比率を単独/複合アラート化し、decision_contextへ渡します。',
    },
    {
      family: '価格変動・方向アラート',
      status: '更新1 着手済み',
      priority: 'A',
      note: `上昇/下落/急騰/急落/Moving up/downを${windowMinutes}分窓と1m/5m/15m/30m/1h窓でdecision_contextへ渡します。`,
    },
    {
      family: '価格到達・レンジ系',
      status: hasPricePosition ? '更新2 着手済み' : '更新2 着手済み',
      priority: 'A',
      note: '日中高値/安値、30分レンジ上限/下限、突破/接近をdecision_contextへ渡します。',
    },
    {
      family: '参考・別モード',
      status: hasReferenceModes ? '更新2 着手済み' : '更新2 着手済み',
      priority: 'A',
      note: 'simple/rolling/sustainedを主判定と参考値に分け、選択外モードもdecision_contextへ残します。',
    },
    {
      family: '成行・コスト注意',
      status: hasCostHeavy ? '更新3 着手済み' : '更新3 着手済み',
      priority: 'A',
      note: '実取引寄りコスト目安をコスト超過/近接/余裕として分類し、注文候補の除外理由に接続します。',
    },
    {
      family: '継続・矛盾チェック',
      status: hasCombinedSignals ? '更新4 着手済み' : (hasContinuation ? '更新1.5 着手済み' : '更新1.5 着手済み'),
      priority: 'A',
      note: '複数窓の継続、短期/中期の矛盾、価格位置・出来高・コストの複合判定をdecision_contextへ渡します。',
    },
    {
      family: '横ばい・レンジ滞在',
      status: hasSideways ? '更新4.5 実装済み' : '更新4.5 実装済み',
      priority: 'A',
      note: '横ばい継続時間、狭いレンジ幅、横ばい＋出来高急増をsideways_contextとしてdecision_contextへ渡します。',
    },
    {
      family: '強いテクニカルアラート',
      status: hasTechnical ? '更新5 実装済み' : '更新5 実装済み',
      priority: 'A',
      note: 'MA方向整合、ATR変動率、VWAP乖離をtechnical_contextとして実取引判断材料にします。',
    },
    {
      family: '次フェーズ技術強化',
      status: '計画中',
      priority: 'B',
      note: 'RSI、ボリンジャーバンド、複合テクニカル一致、シミュレーター検証で強化します。',
    },
    {
      family: 'シミュレーター連携',
      status: '着手中',
      priority: 'A',
      note: 'decision_contextを売買シミュレーターへ渡せる形にします。実注文はまだ行いません。',
    },
  ];
}

function buildOrderDecisionComment({ movePct, thresholdPct, costFloorPct, levelInfo, volumeContext }) {
  const move = Number(movePct);
  const threshold = Number(thresholdPct);
  const cost = Number(costFloorPct);
  const volumeRank = Number(volumeContext?.volume_rank || 0);
  const tradeRank = Number(volumeContext?.trade_count_rank || 0);
  const takerBuyRatio = Number(volumeContext?.taker_buy_ratio);
  const volumeSummary = marketContextSummary(volumeContext);
  const costHeavy = Number.isFinite(cost) && Number.isFinite(threshold) && threshold > 0 && cost >= threshold * 0.9;
  const absMove = Math.abs(move);
  const direction = movementDirection(move);
  const strongMove = Number.isFinite(move) && Number.isFinite(threshold) && threshold > 0 && absMove >= threshold * 2;
  const hitMove = Number.isFinite(move) && Number.isFinite(threshold) && threshold > 0 && absMove >= threshold;
  const infoMove = Number.isFinite(move) && Number.isFinite(threshold) && threshold > 0 && absMove >= Math.max(threshold * 0.5, 0.03);
  const downHit = direction === 'down' && hitMove;
  const downInfo = direction === 'down' && infoMove;
  const upHit = direction === 'up' && hitMove;
  const upInfo = direction === 'up' && infoMove;
  const volumeBacked = volumeRank >= 3 || tradeRank >= 3;
  const volumeSurge = volumeRank >= 4 || tradeRank >= 4;
  const buyLed = Number.isFinite(takerBuyRatio) && takerBuyRatio >= 0.55;
  const sellLed = Number.isFinite(takerBuyRatio) && takerBuyRatio <= 0.45;

  if (!Number.isFinite(move)) {
    return {
      entry_bias: 'data_unavailable',
      decision_title: '判定材料不足',
      order_adjustment: '注文位置は決めず、価格履歴とKline出来高の取得状態を先に整える段階です。',
      target_adjustment: '必要利確価格の判断には使いません。',
      risk_comment: 'データ不足のため、買い候補として扱いません。',
      decision_comment: '判定材料が不足しています。注文位置の判断には進みません。',
      market_context_text: volumeSummary,
    };
  }

  if (direction === 'down') {
    if (strongMove && volumeSurge) {
      return {
        entry_bias: 'deeper_limit_or_rebound_wait',
        decision_title: '急落＋出来高急増',
        order_adjustment: '買い候補として扱うなら、現在価格付近は除外し、深め指値か反発確認後だけを候補に残す判断です。',
        target_adjustment: '必要利確価格は反発幅が実取引寄りコストを明確に超える範囲に限定します。',
        risk_comment: '急落中は落ちるナイフを拾う形になりやすく、利確より先に逆行が続くリスクを最重視します。',
        decision_comment: '急落と出来高急増が重なっています。買い候補なら深め指値か反発確認後に限定する判断です。',
        market_context_text: volumeSummary,
      };
    }
    if (downHit && (volumeBacked || sellLed)) {
      return {
        entry_bias: 'deeper_limit_or_rebound_wait',
        decision_title: '下落しきい値到達',
        order_adjustment: '買い候補として扱うなら、浅い指値は除外し、深め指値または反発確認後の候補に寄せる判断です。',
        target_adjustment: '必要利確価格は高く置きすぎず、反発幅が実取引寄りコストを超えるかを重く見ます。',
        risk_comment: '下落方向に値動きが出ています。逆張り候補は未約定よりも約定後の続落リスクを重く見ます。',
        decision_comment: '下落がしきい値に到達しています。買い候補なら深め指値か反発確認後へ寄せる判断です。',
        market_context_text: volumeSummary,
      };
    }
    if (downInfo) {
      return {
        entry_bias: 'standard_or_deeper_limit',
        decision_title: '小さめの下落',
        order_adjustment: '買い候補として扱うなら、現在価格追随ではなく標準〜深め指値で待つ判断です。',
        target_adjustment: '必要利確価格までの余地を確保し、浅すぎる指値は避けます。',
        risk_comment: '下落方向の情報メモです。反発前提を強く置かず、続落時の除外条件を優先します。',
        decision_comment: '小さめの下落です。買い候補なら標準〜深め指値で待つ判断です。',
        market_context_text: volumeSummary,
      };
    }
    return {
      entry_bias: 'standard_or_deeper_limit',
      decision_title: '弱い下落',
      order_adjustment: '買い候補として扱うなら、現在価格追随ではなく深め指値だけを残す判断です。',
      target_adjustment: '必要利確価格の到達余地はまだ弱く、目標利益を強く見積もらない方針です。',
      risk_comment: '下落方向ですが注意以上ではありません。方向が強まるか反発するかを分けて見ます。',
      decision_comment: '弱い下落です。買い候補なら深め指値だけを候補に残す判断です。',
      market_context_text: volumeSummary,
    };
  }

  if (upHit && strongMove && volumeSurge) {
    return {
      entry_bias: 'wait_for_pullback',
      decision_title: '急騰＋出来高急増',
      order_adjustment: '買い候補として扱う場合でも、成行追随は避け、上昇後の押し目候補まで指値を下げる判断です。',
      target_adjustment: '必要利確価格は追いかけて上げすぎず、コスト後Netが残る範囲を優先します。',
      risk_comment: '急騰直後は滑り・高値掴み・反落を重く見ます。',
      decision_comment: '急騰と出来高急増が重なっています。成行追随ではなく、押し目候補まで指値を下げる判断です。',
      market_context_text: volumeSummary,
    };
  }

  if (upHit && volumeBacked) {
    if (costHeavy) {
      return {
        entry_bias: 'lower_limit_for_margin',
        decision_title: '値動き＋出来高あり / コスト余裕小',
        order_adjustment: '買い候補として扱うなら、現在価格付近ではなく指値を少し下げ、必要利確価格までの余地を作る判断です。',
        target_adjustment: '目標利確幅は実取引寄りコストを上回る水準まで確保します。浅すぎる利確は避けます。',
        risk_comment: '値動きはありますが、しきい値とコストが近く、小さな上昇は利益として残りにくい状態です。',
        decision_comment: '値動きに出来高もありますが、コスト余裕は小さめです。買い候補なら指値を少し下げて利確余地を作る判断です。',
        market_context_text: volumeSummary,
      };
    }
    return {
      entry_bias: buyLed ? 'shallow_to_standard_limit' : 'standard_limit',
      decision_title: '値動き＋出来高あり',
      order_adjustment: buyLed
        ? '買い候補として扱うなら、深すぎる指値より浅め〜標準指値で到達機会を残す判断です。'
        : '買い候補として扱うなら、浅すぎる追随ではなく標準指値で価格の有利さも残す判断です。',
      target_adjustment: '必要利確価格は、実取引寄りコストを差し引いてもNetが残る位置を基準にします。',
      risk_comment: '成行追随は滑りを受けるため、注文想定とコスト差を重く見ます。',
      decision_comment: '値動きに出来高も伴っています。買い候補なら浅め〜標準指値で到達機会と利確余地を両立する判断です。',
      market_context_text: volumeSummary,
    };
  }

  if (upHit) {
    return {
      entry_bias: 'standard_limit_or_watch',
      decision_title: '値動きあり / 出来高裏付け弱め',
      order_adjustment: '買い候補として扱うなら、追随より一段下の指値待ちが自然です。',
      target_adjustment: '必要利確価格までの余地を優先し、浅い指値で伸び不足になる形を避けます。',
      risk_comment: '出来高の裏付けが弱いため、だましや軽い反発の可能性を重く見ます。',
      decision_comment: '値動きはありますが出来高の裏付けは弱めです。買い候補なら追随より一段下の指値待ちが自然です。',
      market_context_text: volumeSummary,
    };
  }

  if (!upHit && !downHit && volumeSurge) {
    return {
      entry_bias: 'range_break_or_lower_limit',
      decision_title: '出来高急増 / 価格変化は小さめ',
      order_adjustment: '買い候補として扱うなら、レンジ上限突破後の候補か、レンジ下限付近の指値候補に分ける判断です。',
      target_adjustment: '方向が出る前なので、必要利確価格はレンジ幅と実取引寄りコストを超えるかで決めます。',
      risk_comment: '方向が出る前の攻防の可能性があり、現在価格で決め打ちしない方針です。',
      decision_comment: '価格変化は小さめですが出来高が急増しています。レンジ上限突破後か下限指値候補に分ける判断です。',
      market_context_text: volumeSummary,
    };
  }

  if (upInfo) {
    return {
      entry_bias: 'watch_or_standard_limit',
      decision_title: '小さめの上昇',
      order_adjustment: '買い候補として扱うなら、今すぐ追随ではなく標準指値で待つ判断です。',
      target_adjustment: 'しきい値未満のため、必要利確価格を高くしすぎると到達しにくい前提で見ます。',
      risk_comment: '小さな上昇は情報表示寄りで、取引候補としてはまだ弱めです。',
      decision_comment: '小さめの上昇です。買い候補なら追随ではなく標準指値で待つ判断です。',
      market_context_text: volumeSummary,
    };
  }

  return {
    entry_bias: 'watch_only',
    decision_title: '目立つ値動きなし',
    order_adjustment: '買い候補としては、現在価格追随ではなく様子見か、事前に決めた深め指値だけを候補にする判断です。',
    target_adjustment: '必要利確価格の達成余地は弱く、目標利益を強く見積もらない方針です。',
    risk_comment: '値動きが小さいため、コストを超える余地がまだ見えにくい状態です。',
    decision_comment: '目立つ値動きはありません。買い候補なら様子見か、事前に決めた深め指値だけを候補にする判断です。',
    market_context_text: volumeSummary,
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
  const thresholdPct = safeNonNegativeFloat(params.threshold_pct, 0.3);
  const costFloorPct = safeNonNegativeFloat(params.cost_floor_pct, 0.28);
  const thresholdsText = String(params.thresholds || '').trim();
  const thresholdsBySymbol = {};
  if (thresholdsText) {
    thresholdsText.split(',').forEach((part) => {
      const [symbolText, thresholdText] = String(part).split(':').map((v) => String(v || '').trim());
      if (!SYMBOLS.includes(symbolText)) return;
      if (isBlankInput(thresholdText)) return;
      const value = safeNonNegativeFloat(thresholdText, NaN);
      if (!Number.isFinite(value)) return;
      thresholdsBySymbol[symbolText] = value;
    });
  }
  const selectedSymbols = Array.isArray(params.symbols)
    ? params.symbols
    : String(params.symbols || '').split(',').map((v) => String(v).trim()).filter(Boolean);
  const targetSymbols = selectedSymbols.length
    ? SYMBOLS.filter((symbol) => selectedSymbols.includes(symbol))
    : SYMBOLS.slice();
  const saveHistory = parseBooleanInput(params.save_history, true);
  const historyLimit = Math.max(20, Math.min(500, safeInt(params.history_limit, 200)));
  const { rows, source } = await readHistoryRows();
  const volumeContexts = await Promise.all(targetSymbols.map(async (symbol) => [symbol, await volumeContextForSymbol(symbol, windowMinutes)]));
  const volumeContextBySymbol = Object.fromEntries(volumeContexts);
  const makeLevel = (movePct, thresholdForSymbol) => directionLevelInfo(movePct, thresholdForSymbol);
  const thresholdGuidance = thresholdPct < costFloorPct
    ? `共通しきい値 ${thresholdPct.toFixed(2)}% は往復コスト目安 ${costFloorPct.toFixed(2)}% より低めです。情報表示寄りとして扱うのが安全です。`
    : thresholdPct < costFloorPct * 1.5
      ? `共通しきい値 ${thresholdPct.toFixed(2)}% は往復コスト目安 ${costFloorPct.toFixed(2)}% に近い水準です。注意アラートの初期値としては標準寄りです。`
      : `共通しきい値 ${thresholdPct.toFixed(2)}% は往復コスト目安 ${costFloorPct.toFixed(2)}% より余裕を見た設定です。`;
  if (!rows.length) {
    return {
      alert_mode: alertMode,
      rolling_min_points: rollingMinPoints,
      alert_rising_ratio: risingRatioThreshold,
      window_minutes: windowMinutes,
      threshold_pct: thresholdPct,
      common_threshold_pct: thresholdPct,
      cost_floor_pct: costFloorPct,
      threshold_guidance: thresholdGuidance,
      source,
      symbols: targetSymbols,
      rows: targetSymbols.map((symbol) => ({
        symbol,
        status: 'データ不足',
        level: '—',
        level_rank: 0,
        level_note: '履歴データ不足',
        alert_hit: false,
        move_pct: null,
        selected_window_move_pct: null,
        selected_window_minutes: windowMinutes,
        decision_basis_move_pct: null,
        decision_basis_window_minutes: windowMinutes,
        direction: 'unknown',
        direction_label: '不明',
        movement_strength: 'unknown',
        movement_alert_type: 'data_unavailable',
        movement_alert_label: '判定不可',
        primary_direction_alert: null,
        continuation_alert: null,
        continuation_alert_summary: '継続判定不可',
        price_position_context: null,
        price_position_summary: '価格位置: 判定不可',
        sideways_context: null,
        sideways_summary: '横ばい: 判定不可',
        technical_context: null,
        technical_summary: 'テクニカル: 判定不可',
        reference_mode_context: null,
        direction_alerts: [],
        direction_alert_summary: '方向アラート判定不可',
        threshold_pct: Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct,
        samples: 0,
        latest_price: null,
        base_price: null,
        latest_time: '',
        volume_context: volumeContextBySymbol[symbol] || null,
        volume_cost_context: buildVolumeCostAlertContext({ movePct: null, thresholdPct: Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, costFloorPct) }),
        combined_signal_context: emptyCombinedSignalContext('価格データ不足のため継続・矛盾チェック不可'),
        combined_signal_summary: '価格データ不足のため継続・矛盾チェック不可',
        combined_signal: 'data_unavailable',
        cost_context: costRiskContext(Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, costFloorPct),
        volume_alert_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, costFloorPct) }).volume_alert_summary,
        order_flow_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, costFloorPct) }).order_flow_summary,
        cost_alert_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, costFloorPct) }).cost_alert_summary,
        market_context_text: marketContextSummary(volumeContextBySymbol[symbol]),
        decision_title: '判定材料不足',
        decision_comment: '判定材料が不足しています。注文位置の判断には進みません。',
        order_adjustment: '注文位置は決めず、価格履歴とKline出来高の取得状態を先に整える段階です。',
        decision_context: enrichDecisionContext({ symbol, windowMinutes, alertMode, movePct: null, thresholdPct: Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct, costFloorPct, levelInfo: { level: '—' }, volumeContext: volumeContextBySymbol[symbol] || null, decision: { entry_bias: 'data_unavailable', decision_title: '判定材料不足', decision_comment: '判定材料が不足しています。注文位置の判断には進みません。', order_adjustment: '注文位置は決めず、価格履歴とKline出来高の取得状態を先に整える段階です。', target_adjustment: '必要利確価格の判断には使いません。', risk_comment: 'データ不足のため、買い候補として扱いません。', market_context_text: marketContextSummary(volumeContextBySymbol[symbol]) } }),
      })),
      top_alert: null,
      history_saved: 0,
      alert_count: 0,
      growth_alert_context: buildGrowthAlertContext([], costFloorPct, windowMinutes),
      decision_context_schema: 'decision_context.v1.technical_sideways',
      message: '履歴データがないためアラート判定は未実施です。',
    };
  }
  const resultRows = targetSymbols.map((symbol) => {
    const symbolRows = rows.filter((row) => row.symbol === symbol).sort((a, b) => a.timestamp - b.timestamp);
    const thresholdForSymbol = Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct;
    if (symbolRows.length < 2) {
      return {
        symbol,
        status: 'データ不足',
        level: '—',
        level_rank: 0,
        level_note: '履歴データ不足',
        alert_hit: false,
        move_pct: null,
        selected_window_move_pct: null,
        selected_window_minutes: windowMinutes,
        decision_basis_move_pct: null,
        decision_basis_window_minutes: windowMinutes,
        direction: 'unknown',
        direction_label: '不明',
        movement_strength: 'unknown',
        movement_alert_type: 'data_unavailable',
        movement_alert_label: '判定不可',
        primary_direction_alert: null,
        continuation_alert: null,
        continuation_alert_summary: '継続判定不可',
        price_position_context: null,
        price_position_summary: '価格位置: 判定不可',
        sideways_context: null,
        sideways_summary: '横ばい: 判定不可',
        technical_context: null,
        technical_summary: 'テクニカル: 判定不可',
        reference_mode_context: null,
        direction_alerts: [],
        direction_alert_summary: '方向アラート判定不可',
        threshold_pct: thresholdForSymbol,
        samples: symbolRows.length,
        latest_price: symbolRows[0]?.price ?? null,
        base_price: symbolRows[0]?.price ?? null,
        latest_time: symbolRows[0] ? formatJst(symbolRows[0].timestamp) : '',
        volume_context: volumeContextBySymbol[symbol] || null,
        volume_cost_context: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }),
        combined_signal_context: emptyCombinedSignalContext('履歴データ不足のため継続・矛盾チェック不可'),
        combined_signal_summary: '履歴データ不足のため継続・矛盾チェック不可',
        combined_signal: 'data_unavailable',
        cost_context: costRiskContext(thresholdForSymbol, costFloorPct),
        volume_alert_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }).volume_alert_summary,
        order_flow_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }).order_flow_summary,
        cost_alert_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }).cost_alert_summary,
        market_context_text: marketContextSummary(volumeContextBySymbol[symbol]),
        decision_title: '判定材料不足',
        decision_comment: '履歴データが不足しています。注文位置の判断には進みません。',
        order_adjustment: '価格履歴を増やしてから、指値位置や利確余地を判断します。',
        decision_context: enrichDecisionContext({ symbol, windowMinutes, alertMode, movePct: null, thresholdPct: thresholdForSymbol, costFloorPct, levelInfo: { level: '—' }, volumeContext: volumeContextBySymbol[symbol] || null, decision: { entry_bias: 'data_unavailable', decision_title: '判定材料不足', decision_comment: '履歴データが不足しています。注文位置の判断には進みません。', order_adjustment: '価格履歴を増やしてから、指値位置や利確余地を判断します。', target_adjustment: '必要利確価格の判断には使いません。', risk_comment: 'データ不足のため、買い候補として扱いません。', market_context_text: marketContextSummary(volumeContextBySymbol[symbol]) } }),
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
        level: '—',
        level_rank: 0,
        level_note: '窓内の起点価格不足',
        alert_hit: false,
        move_pct: null,
        selected_window_move_pct: null,
        selected_window_minutes: windowMinutes,
        decision_basis_move_pct: null,
        decision_basis_window_minutes: windowMinutes,
        direction: 'unknown',
        direction_label: '不明',
        movement_strength: 'unknown',
        movement_alert_type: 'data_unavailable',
        movement_alert_label: '判定不可',
        primary_direction_alert: null,
        continuation_alert: null,
        continuation_alert_summary: '継続判定不可',
        price_position_context: null,
        price_position_summary: '価格位置: 判定不可',
        sideways_context: null,
        sideways_summary: '横ばい: 判定不可',
        technical_context: null,
        technical_summary: 'テクニカル: 判定不可',
        reference_mode_context: null,
        direction_alerts: [],
        direction_alert_summary: '方向アラート判定不可',
        threshold_pct: thresholdForSymbol,
        samples: windowRows.length,
        latest_price: latest.price,
        base_price: null,
        latest_time: formatJst(latest.timestamp),
        volume_context: volumeContextBySymbol[symbol] || null,
        volume_cost_context: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }),
        combined_signal_context: emptyCombinedSignalContext('履歴データ不足のため継続・矛盾チェック不可'),
        combined_signal_summary: '履歴データ不足のため継続・矛盾チェック不可',
        combined_signal: 'data_unavailable',
        cost_context: costRiskContext(thresholdForSymbol, costFloorPct),
        volume_alert_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }).volume_alert_summary,
        order_flow_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }).order_flow_summary,
        cost_alert_summary: buildVolumeCostAlertContext({ movePct: null, thresholdPct: thresholdForSymbol, volumeContext: volumeContextBySymbol[symbol] || null, costContext: costRiskContext(thresholdForSymbol, costFloorPct) }).cost_alert_summary,
        market_context_text: marketContextSummary(volumeContextBySymbol[symbol]),
        decision_title: '判定材料不足',
        decision_comment: '窓内の起点価格が不足しています。注文位置の判断には進みません。',
        order_adjustment: '起点価格を取得してから、指値位置や利確余地を判断します。',
        decision_context: enrichDecisionContext({ symbol, windowMinutes, alertMode, movePct: null, thresholdPct: thresholdForSymbol, costFloorPct, levelInfo: { level: '—' }, volumeContext: volumeContextBySymbol[symbol] || null, decision: { entry_bias: 'data_unavailable', decision_title: '判定材料不足', decision_comment: '窓内の起点価格が不足しています。注文位置の判断には進みません。', order_adjustment: '起点価格を取得してから、指値位置や利確余地を判断します。', target_adjustment: '必要利確価格の判断には使いません。', risk_comment: 'データ不足のため、買い候補として扱いません。', market_context_text: marketContextSummary(volumeContextBySymbol[symbol]) } }),
      };
    }
    const movePct = ((latest.price - base.price) / base.price) * 100;
    const directionWindowMoves = buildDirectionWindowSnapshots(symbolRows, latest, windowMinutes, thresholdForSymbol);
    const primaryDirectionAlert = choosePrimaryDirectionAlert(directionWindowMoves, windowMinutes);
    const selectedDirectionSnapshot = directionWindowMoves.find((row) => Number(row.window_minutes) === Number(windowMinutes)) || null;
    const continuationAlert = buildMultiWindowContinuation(directionWindowMoves, windowMinutes);
    const pricePositionContext = buildPricePositionContext(symbolRows, latest, thresholdForSymbol);
    const earlyVolumeContext = volumeContextBySymbol[symbol] || null;
    const sidewaysContext = buildSidewaysContext(symbolRows, latest, thresholdForSymbol, earlyVolumeContext);
    const technicalContext = buildTechnicalContext(symbolRows, latest, thresholdForSymbol, earlyVolumeContext, sidewaysContext);
    const direction = movementDirection(movePct);
    let streakCount = 0;
    for (let i = windowRows.length - 1; i >= 0; i -= 1) {
      const pivot = windowRows[i];
      if (!pivot || !Number.isFinite(pivot.price) || pivot.price <= 0) break;
      const moveFromPivot = ((latest.price - pivot.price) / pivot.price) * 100;
      if (direction === 'up' && moveFromPivot >= thresholdForSymbol) streakCount += 1;
      else if (direction === 'down' && moveFromPivot <= -thresholdForSymbol) streakCount += 1;
      else break;
    }
    let rollingUpStreak = 0;
    let rollingDownStreak = 0;
    let upSteps = 0;
    let downSteps = 0;
    let totalSteps = 0;
    for (let i = windowRows.length - 1; i > 0; i -= 1) {
      const curr = windowRows[i];
      const prev = windowRows[i - 1];
      if (!curr || !prev || !Number.isFinite(curr.price) || !Number.isFinite(prev.price) || prev.price <= 0) break;
      const stepPct = ((curr.price - prev.price) / prev.price) * 100;
      totalSteps += 1;
      if (stepPct > 0) upSteps += 1;
      if (stepPct < 0) downSteps += 1;
      if (stepPct > 0 && rollingDownStreak === 0) rollingUpStreak += 1;
      else if (stepPct < 0 && rollingUpStreak === 0) rollingDownStreak += 1;
      else if (stepPct !== 0) break;
    }
    const risingRatio = totalSteps > 0 ? (upSteps / totalSteps) * 100 : 0;
    const fallingRatio = totalSteps > 0 ? (downSteps / totalSteps) * 100 : 0;
    const dominantDirectionRatio = direction === 'down' ? fallingRatio : direction === 'up' ? risingRatio : Math.max(risingRatio, fallingRatio);
    const simpleHit = Math.abs(movePct) >= thresholdForSymbol;
    const rollingStreak = direction === 'down' ? rollingDownStreak : rollingUpStreak;
    const rollingHit = rollingStreak >= rollingMinPoints && Math.abs(movePct) >= Math.max(thresholdForSymbol * 0.4, 0.02);
    const sustainedHit = Math.abs(movePct) >= thresholdForSymbol && dominantDirectionRatio >= risingRatioThreshold;
    const hit = alertMode === 'rolling' ? rollingHit : alertMode === 'sustained' ? sustainedHit : simpleHit;
    const levelInfo = makeLevel(movePct, thresholdForSymbol);
    const primaryIsStronger = primaryDirectionAlert && (primaryDirectionAlert.level_rank || 0) > (levelInfo.level_rank || 0);
    const effectiveDirectionSnapshot = primaryIsStronger ? primaryDirectionAlert : null;
    const effectiveLevelInfo = effectiveDirectionSnapshot ? directionLevelInfoFromSnapshot(effectiveDirectionSnapshot, levelInfo) : levelInfo;
    const continuationIsStronger = continuationAlert && (continuationAlert.level_rank || 0) > (effectiveLevelInfo.level_rank || 0);
    const pricePositionIsStronger = pricePositionContext && (pricePositionContext.level_rank || 0) > (continuationIsStronger ? (continuationAlert.level_rank || 0) : (effectiveLevelInfo.level_rank || 0));
    const preliminaryLevelInfo = pricePositionIsStronger
      ? { ...effectiveLevelInfo, level: pricePositionContext.level, level_rank: pricePositionContext.level_rank, movement_alert_type: pricePositionContext.signal, movement_alert_label: pricePositionContext.label }
      : (continuationIsStronger ? { ...effectiveLevelInfo, level: continuationAlert.level, level_rank: continuationAlert.level_rank } : effectiveLevelInfo);
    const decisionBasisMovePct = Number.isFinite(Number(effectiveDirectionSnapshot?.move_pct)) ? Number(effectiveDirectionSnapshot.move_pct) : movePct;
    const decisionBasisWindowMinutes = Number.isFinite(Number(effectiveDirectionSnapshot?.window_minutes)) ? Number(effectiveDirectionSnapshot.window_minutes) : windowMinutes;
    const volumeContext = volumeContextBySymbol[symbol] || null;
    const costContext = costRiskContext(thresholdForSymbol, costFloorPct);
    const volumeCostContext = buildVolumeCostAlertContext({ movePct: decisionBasisMovePct, thresholdPct: thresholdForSymbol, volumeContext, costContext });
    const combinedSignalContext = buildContinuationConflictContext({
      movementWindowMoves: directionWindowMoves,
      continuationAlert,
      pricePositionContext,
      volumeCostContext,
      costContext,
    });
    const volumeCostIsStronger = volumeCostContext && (volumeCostContext.level_rank || 0) > (preliminaryLevelInfo.level_rank || 0);
    const combinedIsStronger = combinedSignalContext && (combinedSignalContext.combined_level_rank || 0) > (volumeCostIsStronger ? (volumeCostContext.level_rank || 0) : (preliminaryLevelInfo.level_rank || 0));
    let contextLevelInfo = combinedIsStronger
      ? { ...preliminaryLevelInfo, level: combinedSignalContext.combined_level, level_rank: combinedSignalContext.combined_level_rank, movement_alert_type: combinedSignalContext.combined_signal, movement_alert_label: combinedSignalContext.combined_label }
      : (volumeCostIsStronger
        ? { ...preliminaryLevelInfo, level: volumeCostContext.level, level_rank: volumeCostContext.level_rank, movement_alert_type: volumeCostContext.primary_signal, movement_alert_label: volumeCostContext.primary_label }
        : preliminaryLevelInfo);
    const sidewaysIsStronger = sidewaysContext && (sidewaysContext.level_rank || 0) > (contextLevelInfo.level_rank || 0);
    if (sidewaysIsStronger) {
      contextLevelInfo = { ...contextLevelInfo, level: sidewaysContext.level, level_rank: sidewaysContext.level_rank, movement_alert_type: sidewaysContext.signal, movement_alert_label: sidewaysContext.label };
    }
    const technicalIsStronger = technicalContext && (technicalContext.level_rank || 0) > (contextLevelInfo.level_rank || 0);
    if (technicalIsStronger) {
      contextLevelInfo = { ...contextLevelInfo, level: technicalContext.level, level_rank: technicalContext.level_rank, movement_alert_type: technicalContext.signal, movement_alert_label: technicalContext.label };
    }
    const alertHit = Boolean((hit && levelInfo.alert_hit) || effectiveDirectionSnapshot?.alert_hit || continuationAlert?.alert_hit || pricePositionContext?.alert_hit || sidewaysContext?.alert_hit || technicalContext?.alert_hit || volumeCostContext?.alert_hit || combinedSignalContext?.alert_hit);
    let decision = buildOrderDecisionComment({
      movePct: decisionBasisMovePct,
      thresholdPct: thresholdForSymbol,
      costFloorPct,
      levelInfo: contextLevelInfo,
      volumeContext,
    });
    decision = applyContinuationDecisionOverlay(decision, continuationAlert, selectedDirectionSnapshot);
    decision = applyPricePositionDecisionOverlay(decision, pricePositionContext, movementDirection(decisionBasisMovePct));
    decision = applyVolumeCostDecisionOverlay(decision, volumeCostContext, costContext, movementDirection(decisionBasisMovePct));
    decision = applyCombinedSignalDecisionOverlay(decision, combinedSignalContext);
    decision = applySidewaysDecisionOverlay(decision, sidewaysContext, volumeContext);
    decision = applyTechnicalDecisionOverlay(decision, technicalContext, movementDirection(decisionBasisMovePct));
    const decisionContext = enrichDecisionContext({
      symbol,
      windowMinutes: decisionBasisWindowMinutes,
      alertMode,
      movePct: decisionBasisMovePct,
      thresholdPct: thresholdForSymbol,
      costFloorPct,
      levelInfo: contextLevelInfo,
      volumeContext,
      volumeCostContext,
      costContext,
      decision,
      movementWindowMoves: directionWindowMoves,
      primaryDirectionAlert,
      continuationAlert,
      pricePositionContext,
      sidewaysContext,
      technicalContext,
      combinedSignalContext,
      selectedWindowMovePct: movePct,
      selectedWindowMinutes: windowMinutes,
    });
    const referenceModeContext = {
      selected_mode: alertMode,
      simple: { hit: simpleHit, move_pct: movePct, threshold_pct: thresholdForSymbol },
      rolling: { hit: rollingHit, streak: rollingStreak, up_streak: rollingUpStreak, down_streak: rollingDownStreak, min_points: rollingMinPoints },
      sustained: { hit: sustainedHit, dominant_direction_ratio: dominantDirectionRatio, required_ratio: risingRatioThreshold, rising_ratio: risingRatio, falling_ratio: fallingRatio },
      note: '選択モードを主判定に使い、別モードは参考値として売買シミュレーター設計用に残します。',
    };
    decisionContext.reference_mode_context = referenceModeContext;
    if ((alertMode === 'rolling' && rollingHit) || (alertMode === 'sustained' && sustainedHit)) {
      decisionContext.active_alerts.push({ family: 'alert_mode', type: alertMode, label: alertMode === 'rolling' ? 'rollingモード到達' : 'sustainedモード到達', level: levelInfo.level, alert_hit: true });
    }
    let statusText = '監視中';
    if (alertHit) {
      if (technicalIsStronger) statusText = `${technicalContext.label}アラート`;
      else if (sidewaysIsStronger) statusText = `${sidewaysContext.label}アラート`;
      else if (combinedIsStronger) statusText = `${combinedSignalContext.combined_label}アラート`;
      else if (pricePositionIsStronger) statusText = `${pricePositionContext.label}アラート`;
      else if (continuationAlert?.alert_hit && continuationIsStronger) statusText = `${continuationAlert.label}アラート`;
      else if (effectiveDirectionSnapshot) statusText = directionAlertStatus(effectiveDirectionSnapshot, effectiveLevelInfo.movement_status);
      else if (alertMode === 'rolling') statusText = `ローリング${levelInfo.movement_alert_label}アラート`;
      else if (alertMode === 'sustained') statusText = `持続${levelInfo.movement_alert_label}アラート`;
      else statusText = levelInfo.movement_status;
    } else if (contextLevelInfo.level_rank === 1) {
      statusText = contextLevelInfo.movement_status || contextLevelInfo.movement_alert_label || '情報あり';
    }
    return {
      symbol,
      status: statusText,
      level: contextLevelInfo.level,
      level_rank: contextLevelInfo.level_rank,
      level_note: decision.decision_comment || effectiveLevelInfo.level_note,
      raw_level_note: effectiveLevelInfo.level_note,
      alert_hit: alertHit,
      move_pct: decisionBasisMovePct,
      selected_window_move_pct: movePct,
      selected_window_minutes: windowMinutes,
      decision_basis_move_pct: decisionBasisMovePct,
      decision_basis_window_minutes: decisionBasisWindowMinutes,
      threshold_pct: thresholdForSymbol,
      direction: effectiveLevelInfo.direction,
      direction_label: effectiveLevelInfo.direction_label,
      movement_strength: effectiveLevelInfo.movement_strength,
      movement_alert_type: combinedIsStronger ? combinedSignalContext.combined_signal : (pricePositionIsStronger ? pricePositionContext.signal : (continuationIsStronger ? continuationAlert.signal : effectiveLevelInfo.movement_alert_type)),
      movement_alert_label: combinedIsStronger ? combinedSignalContext.combined_label : (pricePositionIsStronger ? pricePositionContext.label : (continuationIsStronger ? continuationAlert.label : effectiveLevelInfo.movement_alert_label)),
      primary_direction_alert: primaryDirectionAlert,
      continuation_alert: continuationAlert,
      price_position_context: pricePositionContext,
      price_position_summary: pricePositionSummary(pricePositionContext),
      sideways_context: sidewaysContext,
      sideways_summary: sidewaysSummary(sidewaysContext),
      technical_context: technicalContext,
      technical_summary: technicalSummary(technicalContext),
      reference_mode_context: referenceModeContext,
      direction_alerts: directionWindowMoves,
      direction_alert_summary: directionAlertSummary(directionWindowMoves),
      continuation_alert_summary: continuationAlert ? `${continuationAlert.label}: ${continuationAlert.note}` : '—',
      streak_count: streakCount,
      rolling_streak: rollingStreak,
      rolling_up_streak: rollingUpStreak,
      rolling_down_streak: rollingDownStreak,
      rising_ratio: risingRatio,
      falling_ratio: fallingRatio,
      dominant_direction_ratio: dominantDirectionRatio,
      samples: windowRows.length,
      latest_price: latest.price,
      base_price: base.price,
      latest_time: formatJst(latest.timestamp),
      volume_context: volumeContext,
      volume_cost_context: volumeCostContext,
      combined_signal_context: combinedSignalContext,
      combined_signal_summary: combinedSignalContext.summary,
      combined_signal: combinedSignalContext.combined_signal,
      cost_context: costContext,
      volume_alert_summary: volumeCostContext.volume_alert_summary,
      order_flow_summary: volumeCostContext.order_flow_summary,
      cost_alert_summary: volumeCostContext.cost_alert_summary,
      market_context_text: decision.market_context_text,
      entry_bias: decision.entry_bias,
      decision_title: decision.decision_title,
      decision_comment: decision.decision_comment,
      order_adjustment: decision.order_adjustment,
      target_adjustment: decision.target_adjustment,
      risk_comment: decision.risk_comment,
      conditional_forecast: decisionContext.conditional_forecast,
      confidence_level: decisionContext.confidence_level,
      confidence_reason: decisionContext.confidence_reason,
      preferred_candidate: decisionContext.preferred_candidate,
      excluded_candidates: decisionContext.excluded_candidates,
      invalidation_conditions: decisionContext.invalidation_conditions,
      simulator_note: decisionContext.simulator_note,
      decision_context: decisionContext,
    };
  });
  const alertCount = resultRows.filter((row) => row.alert_hit).length;
  const ranked = resultRows
    .filter((row) => row.alert_hit && Number.isFinite(row.move_pct))
    .sort((a, b) => (b.level_rank - a.level_rank) || (Math.abs(Number(b.move_pct || 0)) - Math.abs(Number(a.move_pct || 0))));
  const topAlert = ranked.length ? ranked[0] : null;
  let historySaved = 0;
  if (saveHistory && alertCount > 0) {
    const existing = await readAlertHistory();
    const nowText = nowJstIso();
    const appendItems = resultRows
      .filter((row) => row.alert_hit)
      .map((row) => ({
        timestamp_jst: nowText,
        symbol: row.symbol,
        status: row.status,
        level: row.level,
        move_pct: row.move_pct,
        selected_window_move_pct: row.selected_window_move_pct,
        selected_window_minutes: row.selected_window_minutes,
        decision_basis_move_pct: row.decision_basis_move_pct,
        decision_basis_window_minutes: row.decision_basis_window_minutes,
        threshold_pct: row.threshold_pct,
        volume_alert_summary: row.volume_alert_summary,
        order_flow_summary: row.order_flow_summary,
        cost_alert_summary: row.cost_alert_summary,
        window_minutes: windowMinutes,
        alert_mode: alertMode,
        streak_count: row.streak_count,
        rising_ratio: row.rising_ratio,
        falling_ratio: row.falling_ratio,
        direction: row.direction,
        movement_alert_type: row.movement_alert_type,
        primary_direction_alert: row.primary_direction_alert,
        continuation_alert: row.continuation_alert,
        continuation_alert_summary: row.continuation_alert_summary,
        price_position_context: row.price_position_context,
        price_position_summary: row.price_position_summary,
        sideways_context: row.sideways_context,
        sideways_summary: row.sideways_summary,
        technical_context: row.technical_context,
        technical_summary: row.technical_summary,
        reference_mode_context: row.reference_mode_context,
        combined_signal_context: row.combined_signal_context,
        combined_signal_summary: row.combined_signal_summary,
        combined_signal: row.combined_signal,
        volume_context: row.volume_context,
        entry_bias: row.entry_bias,
        decision_title: row.decision_title,
        decision_comment: row.decision_comment,
        order_adjustment: row.order_adjustment,
        decision_context: row.decision_context,
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
    common_threshold_pct: thresholdPct,
    cost_floor_pct: costFloorPct,
    threshold_guidance: thresholdGuidance,
    thresholds_by_symbol: thresholdsBySymbol,
    source,
    symbols: targetSymbols,
    top_alert: topAlert,
    history_saved: historySaved,
    alert_count: alertCount,
    rows: resultRows,
    volume_context_source: 'binance_klines',
    growth_alert_context: buildGrowthAlertContext(resultRows, costFloorPct, windowMinutes),
    decision_context_schema: 'decision_context.v1.technical_sideways',
    message: alertCount
      ? `${alertCount}通貨が注意しきい値以上です。`
      : '注意以上はありません。現在の気づきと注文候補を表示します。',
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
  const sourceMode = params.source || 'klines';
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
      message = `Binance公開Klineの ${result.range.label} / ${actualInterval} 足を一時表示しています。CSV/DBには保存していません。${sampled ? ` 表示用に${rawRows}本から${points.length}点へ間引きました。` : ''}`;
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


function limitCandidateHistoryLabel(rate) {
  if (!Number.isFinite(rate)) return '未確認';
  if (rate >= 45) return '高め';
  if (rate >= 20) return '確認範囲';
  if (rate >= 8) return '少なめ';
  return '低め';
}

function firstLimitOutcomeWithinWindow({ rows, startIndex, endTimeExclusive, side, limitPrice, takeProfitPrice, stopLossPrice }) {
  let hitIndex = -1;
  for (let i = startIndex; i < rows.length; i += 1) {
    const row = rows[i];
    const t = safeFloat(row.open_time_ms, NaN);
    if (!Number.isFinite(t)) continue;
    if (t >= endTimeExclusive) break;
    const high = safeFloat(row.high, NaN);
    const low = safeFloat(row.low, NaN);
    const hit = side === 'sell_limit'
      ? Number.isFinite(high) && high >= limitPrice
      : Number.isFinite(low) && low <= limitPrice;
    if (hit) {
      hitIndex = i;
      break;
    }
  }
  if (hitIndex < 0) return { hit: false, outcome: 'no_hit' };

  for (let i = hitIndex; i < rows.length; i += 1) {
    const row = rows[i];
    const t = safeFloat(row.open_time_ms, NaN);
    if (!Number.isFinite(t)) continue;
    if (t >= endTimeExclusive) break;
    const high = safeFloat(row.high, NaN);
    const low = safeFloat(row.low, NaN);
    let takeProfitTouched = false;
    let stopTouched = false;
    if (side === 'sell_limit') {
      takeProfitTouched = Number.isFinite(low) && low <= takeProfitPrice;
      stopTouched = Number.isFinite(high) && Number.isFinite(stopLossPrice) && high >= stopLossPrice;
    } else {
      takeProfitTouched = Number.isFinite(high) && high >= takeProfitPrice;
      stopTouched = Number.isFinite(low) && Number.isFinite(stopLossPrice) && low <= stopLossPrice;
    }
    if (takeProfitTouched && stopTouched) return { hit: true, outcome: 'ambiguous' };
    if (takeProfitTouched) return { hit: true, outcome: 'take_profit_first' };
    if (stopTouched) return { hit: true, outcome: 'stop_first' };
  }
  return { hit: true, outcome: 'no_exit' };
}

async function estimateMarketShortOutcomeRates(body = {}) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : SYMBOLS[0];
  const referenceDays = normalizeOccurrenceReferenceDays(body);
  const windowMinutes = normalizeOccurrenceWindowMinutes(body.occurrence_window_minutes || body.virtual_fill_window_minutes || 15);
  const windowMs = windowMinutes * 60 * 1000;
  const takeProfitPct = Math.max(0, safeFloat(body.take_profit_pct, 0.4));
  const stopPct = Math.max(0, safeFloat(body.stop_loss_pct, 0.5));
  const side = normalizeVirtualFillSide(body.limit_candidate_side || body.virtual_fill_side);
  const window = analysisCacheWindow(referenceDays);
  const base = {
    symbol,
    interval: '1m',
    reference_days: referenceDays,
    evaluation_window_minutes: windowMinutes,
    take_profit_pct: takeProfitPct,
    stop_loss_pct: stopPct,
    side,
    start_count: 0,
    take_profit_first_count: 0,
    stop_first_count: 0,
    ambiguous_count: 0,
    no_exit_count: 0,
    take_profit_first_rate_pct: null,
    stop_first_rate_pct: null,
    ambiguous_rate_pct: null,
    no_exit_rate_pct: null,
    quality_label: '未計算',
  };
  try {
    const cache = await analysisRowsForWindow({ symbol, start_ms: window.start_ms, end_ms: window.end_ms });
    const rows = (cache.rows || []).filter((row) => {
      const open = safeFloat(row.open, NaN);
      const high = safeFloat(row.high, NaN);
      const low = safeFloat(row.low, NaN);
      const t = safeFloat(row.open_time_ms, NaN);
      return Number.isFinite(t) && t >= window.start_ms && t < window.end_ms
        && Number.isFinite(open) && open > 0 && Number.isFinite(high) && Number.isFinite(low);
    }).sort((a, b) => safeFloat(a.open_time_ms, 0) - safeFloat(b.open_time_ms, 0));
    const startRows = rows.filter((row) => safeFloat(row.open_time_ms, 0) + windowMs <= window.end_ms);
    if (startRows.length < 10) {
      return { ...base, start_count: startRows.length, quality_label: '不足', note: '成行短期型の履歴判定に必要な1分足が不足しています。' };
    }
    let searchStartIndex = 0;
    const result = { ...base, start_count: startRows.length };
    for (const startRow of startRows) {
      const startTime = safeFloat(startRow.open_time_ms, NaN);
      const open = safeFloat(startRow.open, NaN);
      while (searchStartIndex < rows.length && safeFloat(rows[searchStartIndex].open_time_ms, NaN) < startTime) searchStartIndex += 1;
      const takeProfitPrice = side === 'sell_limit' ? open * (1 - takeProfitPct / 100) : open * (1 + takeProfitPct / 100);
      const stopLossPrice = side === 'sell_limit' ? open * (1 + stopPct / 100) : open * (1 - stopPct / 100);
      const outcome = firstLimitOutcomeWithinWindow({
        rows,
        startIndex: searchStartIndex,
        endTimeExclusive: startTime + windowMs,
        side,
        limitPrice: open,
        takeProfitPrice,
        stopLossPrice,
      });
      if (outcome.outcome === 'take_profit_first') result.take_profit_first_count += 1;
      else if (outcome.outcome === 'stop_first') result.stop_first_count += 1;
      else if (outcome.outcome === 'ambiguous') result.ambiguous_count += 1;
      else result.no_exit_count += 1;
    }
    result.take_profit_first_rate_pct = result.take_profit_first_count / result.start_count * 100;
    result.stop_first_rate_pct = result.stop_first_count / result.start_count * 100;
    result.ambiguous_rate_pct = result.ambiguous_count / result.start_count * 100;
    result.no_exit_rate_pct = result.no_exit_count / result.start_count * 100;
    result.quality_label = '計算済み';
    result.note = `成行短期型: ${symbol} 1分足 / 直近${referenceDays}日 / ${windowMinutes}分以内。即時参加後、利確${takeProfitPct.toFixed(3)}%と損切り${stopPct.toFixed(3)}%のどちらへ先に触れたかを比較しました。`;
    return result;
  } catch (error) {
    return { ...base, quality_label: 'エラー', error: error.message, note: `成行短期型の履歴判定: ${error.message}` };
  }
}

async function estimateLimitCandidateOutcomeRates(body = {}, summary = null, candidateRows = []) {
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : SYMBOLS[0];
  const side = normalizeVirtualFillSide(body.limit_candidate_side || body.virtual_fill_side);
  const referenceDays = normalizeOccurrenceReferenceDays(body);
  const windowMinutes = normalizeOccurrenceWindowMinutes(body.occurrence_window_minutes || body.virtual_fill_window_minutes || 15);
  const windowMs = windowMinutes * 60 * 1000;
  const stopPct = Math.max(0, safeFloat(body.stop_loss_pct, 0));
  const window = analysisCacheWindow(referenceDays);
  const baseMeta = {
    symbol,
    interval: '1m',
    reference_days: referenceDays,
    evaluation_window_minutes: windowMinutes,
    side,
    side_label: virtualFillSideLabel(side),
    stop_loss_pct: stopPct,
    start_time_ms: window.start_ms,
    end_time_ms: window.end_ms,
    reference_period_text: `${window.start_jst} → ${window.end_jst}`,
    source: 'analysis_cache',
    referenced_row_count: 0,
    start_row_count: 0,
    quality_label: '未計算',
    note: '',
  };
  if (!Array.isArray(candidateRows) || candidateRows.length === 0) {
    return { by_key: {}, meta: { ...baseMeta, quality_label: '候補なし' }, note: '指値候補別の履歴診断: 指値候補がないため計算していません。' };
  }
  try {
    const cache = await analysisRowsForWindow({ symbol, start_ms: window.start_ms, end_ms: window.end_ms });
    const rows = (cache.rows || []).filter((row) => {
      const open = safeFloat(row.open, NaN);
      const high = safeFloat(row.high, NaN);
      const low = safeFloat(row.low, NaN);
      const t = safeFloat(row.open_time_ms, NaN);
      return Number.isFinite(t) && t >= window.start_ms && t < window.end_ms
        && Number.isFinite(open) && open > 0
        && Number.isFinite(high) && Number.isFinite(low);
    }).sort((a, b) => safeFloat(a.open_time_ms, 0) - safeFloat(b.open_time_ms, 0));
    const expected = expectedRowsForAnalysisWindow(window.start_ms, window.end_ms);
    const coverage = expected > 0 ? rows.length / expected : 0;
    const startRows = rows.filter((row) => {
      const t = safeFloat(row.open_time_ms, NaN);
      return Number.isFinite(t) && t + windowMs <= window.end_ms;
    });
    const qualityLabel = rows.length <= 0 ? '不足' : coverage >= 0.95 ? '良好' : coverage >= 0.5 ? '一部不足' : '不足';
    const byKey = {};
    for (const candidate of candidateRows) {
      const distancePct = Math.abs(safeFloat(candidate.distance_pct, NaN));
      const requiredMovePct = Math.max(0, safeFloat(candidate.required_move_pct_from_limit, NaN));
      const item = {
        key: candidate.key,
        candidate_label: candidate.candidate_label || candidate.label || candidate.key,
        reference_days: referenceDays,
        evaluation_window_minutes: windowMinutes,
        stop_loss_pct: stopPct,
        start_count: startRows.length,
        hit_count: 0,
        take_profit_first_count: 0,
        stop_first_count: 0,
        ambiguous_count: 0,
        no_exit_count: 0,
        no_hit_count: 0,
        limit_hit_rate_pct: null,
        take_profit_after_hit_rate_pct: null,
        stop_first_rate_pct: null,
        ambiguous_rate_pct: null,
        no_exit_rate_pct: null,
        label: '未確認',
        note: '',
      };
      if (!Number.isFinite(distancePct) || !Number.isFinite(requiredMovePct) || startRows.length < 10) {
        item.note = '履歴データまたは候補条件が不足しているため、候補別の到達診断は未確認です。';
        byKey[candidate.key] = item;
        continue;
      }
      let searchStartIndex = 0;
      for (const startRow of startRows) {
        const startTime = safeFloat(startRow.open_time_ms, NaN);
        const open = safeFloat(startRow.open, NaN);
        if (!Number.isFinite(startTime) || !Number.isFinite(open) || open <= 0) continue;
        while (searchStartIndex < rows.length && safeFloat(rows[searchStartIndex].open_time_ms, NaN) < startTime) {
          searchStartIndex += 1;
        }
        const limitPrice = side === 'sell_limit'
          ? open * (1 + distancePct / 100)
          : open * (1 - distancePct / 100);
        const takeProfitPrice = side === 'sell_limit'
          ? limitPrice * (1 - requiredMovePct / 100)
          : limitPrice * (1 + requiredMovePct / 100);
        const stopLossPrice = stopPct > 0
          ? (side === 'sell_limit' ? limitPrice * (1 + stopPct / 100) : limitPrice * (1 - stopPct / 100))
          : null;
        const outcome = firstLimitOutcomeWithinWindow({
          rows,
          startIndex: searchStartIndex,
          endTimeExclusive: startTime + windowMs,
          side,
          limitPrice,
          takeProfitPrice,
          stopLossPrice,
        });
        if (!outcome.hit) {
          item.no_hit_count += 1;
        } else {
          item.hit_count += 1;
          if (outcome.outcome === 'take_profit_first') item.take_profit_first_count += 1;
          else if (outcome.outcome === 'stop_first') item.stop_first_count += 1;
          else if (outcome.outcome === 'ambiguous') item.ambiguous_count += 1;
          else item.no_exit_count += 1;
        }
      }
      item.limit_hit_rate_pct = item.start_count ? (item.hit_count / item.start_count) * 100 : null;
      item.take_profit_after_hit_rate_pct = item.hit_count ? (item.take_profit_first_count / item.hit_count) * 100 : null;
      item.stop_first_rate_pct = item.hit_count ? (item.stop_first_count / item.hit_count) * 100 : null;
      item.ambiguous_rate_pct = item.hit_count ? (item.ambiguous_count / item.hit_count) * 100 : null;
      item.no_exit_rate_pct = item.hit_count ? (item.no_exit_count / item.hit_count) * 100 : null;
      item.label = limitCandidateHistoryLabel(item.limit_hit_rate_pct);
      item.note = `${candidate.candidate_label || candidate.key}: ${windowMinutes}分以内の指値到達率 ${Number.isFinite(item.limit_hit_rate_pct) ? item.limit_hit_rate_pct.toFixed(1) : '—'}%。到達後の必要利確到達率 ${Number.isFinite(item.take_profit_after_hit_rate_pct) ? item.take_profit_after_hit_rate_pct.toFixed(1) : '—'}%、損切り先行率 ${Number.isFinite(item.stop_first_rate_pct) ? item.stop_first_rate_pct.toFixed(1) : '—'}%。`;
      byKey[candidate.key] = item;
    }
    const meta = {
      ...baseMeta,
      referenced_row_count: rows.length,
      expected_row_count: expected,
      missing_count: Math.max(0, expected - rows.length),
      start_row_count: startRows.length,
      coverage_pct: coverage * 100,
      quality_label: qualityLabel,
      source: cache.source,
      csv_row_count: cache.csv_row_count,
      db_row_count: cache.db_row_count,
      db_enabled: cache.db_enabled,
      referenced_files: (cache.files || []).map((file) => path.basename(file)),
      referenced_file_count: (cache.files || []).length,
      note: `候補別履歴診断: ${symbol} 1分足 / 直近${referenceDays}日 / 判定窓${windowMinutes}分以内。1分足のため、同じ足の中で利確と損切りに触れた順序は確定できず、同時扱いとして分けています。`,
    };
    return { by_key: byKey, meta, note: meta.note };
  } catch (error) {
    return { by_key: {}, meta: { ...baseMeta, quality_label: 'エラー', error: error.message }, note: `候補別履歴診断: ${error.message} のため計算できませんでした。` };
  }
}

function mergeLimitCandidateHistoryRows(rows = [], history = {}) {
  const byKey = history?.by_key || {};
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const stat = byKey[row.key] || null;
    if (!stat) return row;
    return {
      ...row,
      history_reference_days: stat.reference_days,
      history_window_minutes: stat.evaluation_window_minutes,
      history_start_count: stat.start_count,
      limit_hit_count: stat.hit_count,
      limit_hit_rate_pct: stat.limit_hit_rate_pct,
      take_profit_first_count: stat.take_profit_first_count,
      take_profit_after_hit_rate_pct: stat.take_profit_after_hit_rate_pct,
      stop_first_count: stat.stop_first_count,
      stop_first_rate_pct: stat.stop_first_rate_pct,
      ambiguous_count: stat.ambiguous_count,
      ambiguous_rate_pct: stat.ambiguous_rate_pct,
      no_exit_count: stat.no_exit_count,
      no_exit_rate_pct: stat.no_exit_rate_pct,
      history_label: stat.label,
      history_note: stat.note,
    };
  });
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
  const limitCandidateHistory = await estimateLimitCandidateOutcomeRates({
    ...body,
    current_price_jpy: Number.isFinite(summary?.price_jpy) ? summary.price_jpy : null,
    limit_candidate_side: body.limit_candidate_side || body.virtual_fill_side || 'buy_limit',
  }, summary, result.limit_candidate_rows);
  const mergedLimitCandidateRows = mergeLimitCandidateHistoryRows(result.limit_candidate_rows, limitCandidateHistory);
  const marketShortHistory = await estimateMarketShortOutcomeRates({
    ...body,
    take_profit_pct: result.take_profit_pct,
    stop_loss_pct: result.stop_loss_pct,
  });
  const tradeMethodComparison = calculations.calculateTradeMethodComparison({
    ...body,
    target_profit_jpy: result.target_profit_jpy,
    capital_jpy: body.capital_jpy,
    take_profit_pct: result.take_profit_pct,
    stop_loss_pct: result.stop_loss_pct,
    roundtrip_cost_pct: result.roundtrip_cost_pct,
    required_move_occurrence_rate_pct: result.required_move_occurrence_rate_pct,
  }, mergedLimitCandidateRows, marketShortHistory);
  return {
    ...result,
    trade_method_rows: tradeMethodComparison.rows,
    trade_method_meta: tradeMethodComparison.meta,
    trade_method_note: tradeMethodComparison.note,
    trade_method_market_history: marketShortHistory,
    limit_candidate_rows: mergedLimitCandidateRows,
    limit_candidate_note: `${String(result.limit_candidate_note || '').replace('指値到達率・約定後利確到達率・損切り先行率は次段階で追加します。', '指値到達率・約定後利確到達率・損切り先行率を分析用1分足キャッシュから参考表示します。')} ${limitCandidateHistory?.note || ''}`.trim(),
    limit_candidate_history_note: limitCandidateHistory?.note || '',
    limit_candidate_history_meta: limitCandidateHistory?.meta || null,
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
    case 'cost-estimate': return costEstimate(query);
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
