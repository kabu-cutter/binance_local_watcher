const fs = require('fs');
const path = require('path');
const https = require('https');

const VERSION = 'electron-node-engine-v0.3';
const SYMBOLS = ['BTCJPY', 'ETHJPY'];
const HISTORY_COLUMNS = ['timestamp', 'symbol', 'price_jpy'];
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
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeInt(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
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
          reject(new Error(`${res.statusCode} ${res.statusMessage}`));
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
  const symbols = SYMBOLS.map((symbol) => {
    const item = data[symbol] || MOCK_PRICES[symbol];
    const price = safeFloat(item.price);
    const prev = safeFloat(item.prev, price);
    const shortBase = safeFloat(item.short_base, prev);
    const prevDiff = price - prev;
    const shortDiff = price - shortBase;
    const prevPct = prev ? (prevDiff / prev) * 100 : 0;
    const shortPct = shortBase ? (shortDiff / shortBase) * 100 : 0;
    const status = shortDiff > 0 ? '上昇' : shortDiff < 0 ? '下落' : '横ばい';
    return {
      symbol,
      price_jpy: price,
      prev_price: prev,
      prev_diff_yen: prevDiff,
      prev_pct: prevPct,
      short_diff_yen: shortDiff,
      short_pct: shortPct,
      status,
      note: `短期 ${status} / ${shortPct >= 0 ? '+' : ''}${shortPct.toFixed(4)}%`,
      timestamp: item.timestamp || '',
    };
  });
  return { symbols, source };
}

function parseAmounts(text) {
  const amounts = String(text || '').replace(/、/g, ',').replace(/円/g, '').split(',')
    .map((part) => safeFloat(part.trim(), 0))
    .filter((value) => value > 0);
  return amounts.length ? amounts : [1000, 10000, 100000];
}

function parseCancelRates(text) {
  const values = [];
  String(text || '').replace(/、/g, ',').replace(/%/g, '').split(',').forEach((part) => {
    const value = Math.max(0, Math.min(95, safeFloat(part.trim(), NaN)));
    if (Number.isFinite(value) && !values.includes(value)) values.push(value);
  });
  return values.length ? values : [10, 30, 50, 70];
}

function riskLabel(neededPct) {
  if (neededPct < 0.3) return '軽め';
  if (neededPct < 0.8) return '中くらい';
  if (neededPct < 1.5) return '重め';
  return 'かなり重い';
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
    };
  });
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
  };
}

async function capabilities() {
  return {
    ok: true,
    version: VERSION,
    symbols: SYMBOLS,
    routes: {
      GET: ['status', 'capabilities', 'summary', 'impact', 'chart'],
      POST: ['fetch-prices', 'trade-preview', 'daily-goal'],
    },
    api_boundary: API_BOUNDARY,
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
  const amounts = parseAmounts(params.amounts);
  const { symbols } = await currentPriceData();
  const rows = [];
  for (const s of symbols) {
    const price = safeFloat(s.price_jpy);
    for (const amount of amounts) {
      const quantity = price ? amount / price : 0;
      rows.push({
        symbol: s.symbol,
        amount_jpy: amount,
        price_jpy: price,
        quantity,
        prev_impact_yen: quantity * safeFloat(s.prev_diff_yen),
        short_impact_yen: quantity * safeFloat(s.short_diff_yen),
      });
    }
  }
  return { rows };
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
  if (sourceMode === 'klines' || points.length < 2) {
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
  const prices = points.map((point) => safeFloat(point.price)).filter(Number.isFinite);
  return {
    symbol,
    points,
    source: usedSource,
    message,
    errors,
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    rows: points.length,
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
  const prices = Object.fromEntries(symbols.map((s) => [s.symbol, s.price_jpy]));
  const symbol = SYMBOLS.includes(body.symbol) ? body.symbol : 'BTCJPY';
  const amount = Math.max(0, safeFloat(body.amount_jpy));
  const price = safeFloat(prices[symbol], MOCK_PRICES[symbol].price);
  const exitPct = safeFloat(body.exit_change_pct);
  const costPct = Math.max(0, safeFloat(body.roundtrip_cost_pct));
  const exitPrice = price * (1 + exitPct / 100);
  const quantity = price ? amount / price : 0;
  const gross = quantity * (exitPrice - price);
  const cost = amount * costPct / 100;
  const net = gross - cost;
  return {
    symbol,
    amount_jpy: amount,
    current_price: price,
    exit_price: exitPrice,
    quantity,
    gross_pl_yen: gross,
    net_pl_yen: net,
    roundtrip_cost_pct: costPct,
    accuracy: '概算',
    memo: `${symbol} を ${amount.toLocaleString('ja-JP')}円ぶん想定。現在価格から ${exitPct >= 0 ? '+' : ''}${exitPct.toFixed(3)}% 動くと、Grossは約${gross.toLocaleString('ja-JP', { maximumFractionDigits: 2, signDisplay: 'always' })}円、往復コスト${costPct.toFixed(2)}%を引いたNetは約${net.toLocaleString('ja-JP', { maximumFractionDigits: 2, signDisplay: 'always' })}円です。これは実注文ではなく、Electron main process のローカル概算プレビューです。APIキーやSecretは使いません。`,
  };
}

async function dailyGoal(body = {}) {
  const target = Math.max(0, safeFloat(body.target_profit_jpy));
  const capital = Math.max(1, safeFloat(body.capital_jpy, 1));
  const minOpp = Math.max(1, safeInt(body.min_opportunities, 1));
  const maxOpp = Math.max(minOpp, safeInt(body.max_opportunities, minOpp));
  const stopPct = Math.max(0, safeFloat(body.stop_loss_pct));
  const cancelRates = parseCancelRates(body.cancel_rates_text);
  const costPct = 0.28;
  const targetPct = (target / capital) * 100;
  const onePct = targetPct + costPct;
  const minPct = (target / capital / minOpp) * 100 + costPct;
  const maxPct = (target / capital / maxOpp) * 100 + costPct;
  const lossPerStop = -(capital * (stopPct + costPct) / 100);
  const suggestion = [
    `今日の目標は ${target.toLocaleString('ja-JP')}円、資金/主投入額は ${capital.toLocaleString('ja-JP')}円です。`,
    `1回で全部狙うと、コスト込みで約 ${onePct.toFixed(3)}% のNet変動が必要なので、まず重さを見る基準になります。`,
    `${minOpp}回で分けると1回あたり約 ${(target / minOpp).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円、必要変動率は約 ${minPct.toFixed(3)}% です。`,
    `${maxOpp}回で分けると1回あたり約 ${(target / maxOpp).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円、必要変動率は約 ${maxPct.toFixed(3)}% です。`,
    `損切り逆行率を ${stopPct.toFixed(2)}% と見る場合、1回の損切りは概算で約 ${lossPerStop.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円です。未約定が増えるほど、残りの約定1回あたりの必要Netが重くなります。`,
    'これは売買指示ではなく、今日の条件がどれくらい厳しいかを見る準備サジェストです。',
  ].join('\n');
  const planCards = [
    ['1回で達成', 1],
    [`${minOpp}回で分ける`, minOpp],
    [`${maxOpp}回で分ける`, maxOpp],
  ].map(([title, opp]) => {
    const neededNet = target / opp;
    const neededPct = (neededNet / capital) * 100 + costPct;
    return {
      title,
      main: `${neededPct.toFixed(3)}%`,
      sub: `1回必要Net 約${neededNet.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円 / 損切り1回 約${lossPerStop.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円`,
      tag: riskLabel(neededPct),
      kind: neededPct >= 1.5 ? 'bad' : neededPct < 0.8 ? 'good' : 'warn',
    };
  });
  const scenarios = [];
  for (const rate of cancelRates) {
    for (const opp of [minOpp, maxOpp]) {
      const nofill = Math.round((opp * rate) / 100);
      if (nofill <= 0) continue;
      const effective = Math.max(1, opp - nofill);
      const neededNet = target / effective;
      const neededPct = (neededNet / capital) * 100 + costPct;
      scenarios.push({
        cancel_rate: rate,
        opportunities: opp,
        nofill,
        effective,
        needed_net_per_trade: neededNet,
        needed_move_pct: neededPct,
        risk: riskLabel(neededPct),
        memo: `未約定${nofill}回なら、有効約定${effective}回で目標を見る`,
      });
    }
  }
  return { suggestion, plan_cards: planCards, scenarios };
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
  fetchPrices,
  tradePreview,
  dailyGoal,
};
