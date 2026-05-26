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

function historyFilePath() {
  return path.join(projectDir(), 'price_history.csv');
}

function longDataDir() {
  return path.join(projectDir(), 'long_data');
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
      GET: ['status', 'capabilities', 'summary', 'impact', 'chart'],
      POST: ['fetch-prices', 'download-history', 'trade-preview', 'daily-goal'],
    },
    api_boundary: API_BOUNDARY,
    calculation_engine: {
      module: 'local_engine_calculations.js',
      style: 'pure functions called from Electron main process',
      io_owner: 'local_engine.js',
    },
  };
}

async function summary() {
  const { symbols, source } = await currentPriceData();
  const memo = source === 'mock'
    ? 'price_history.csv が見つからないため、サンプル価格で表示しています。「現在価格を取得して保存」を押すと公開APIから価格を取得して履歴CSVへ保存します。'
    : `price_history.csv から最新価格を読みました。データ元: ${source}`;
  return { symbols, data_source: source, memo };
}

async function impact(params = {}) {
  const { symbols } = await currentPriceData();
  return { rows: calculations.calculateImpactRows({ summaries: symbols, amountsText: params.amounts }) };
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
  return calculations.calculateDailyGoal({
    ...body,
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
    case 'chart': return chart(query);
    case 'fetch-prices': return fetchPrices();
    case 'download-history': return downloadHistoricalKlines(body);
    case 'trade-preview': return tradePreview(body);
    case 'daily-goal': return dailyGoal(body);
    default: throw new Error(`Unknown local engine route: ${route}`);
  }
}

module.exports = {
  invoke,
  status,
  capabilities,
  summary,
  impact,
  chart,
  downloadHistoricalKlines,
  buildKlineDownloadPlan,
  fetchPrices,
  tradePreview,
  dailyGoal,
  calculations,
};
