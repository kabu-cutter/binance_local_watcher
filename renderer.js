const titles = {
  summary: ['サマリー', 'Electron main process が公開データ取得・履歴・計算を担当します。'],
  chart: ['チャート', 'Electron main process で履歴または公開klineを読み、rendererでSVGチャートを描きます。'],
  impact: ['値動き影響', '保有していた場合の金額感覚を確認します。'],
  trade: ['損益プレビュー', '実注文なしで投入額・コスト・Net P/Lを概算します。'],
  daily: ['日次目標', '仮想約定率・必要勝率・必要値幅から今日の条件の重さを整理します。'],
  api: ['API・準備度', 'Electron内のローカルエンジン境界、安全範囲、禁止機能を確認します。'],
};

const DAILY_TEMPLATES = {
  market_priority: {
    label: '約定優先・成行寄り',
    fillRate: 85,
    stopPct: 0.5,
    costPct: 0.34,
    cancelRates: '10,20,30',
    autoFill: false,
    memo: '約定率は高めですが、往復コストは重めです。小さい値動き狙いは手数料負けを重点確認します。',
  },
  pullback_limit: {
    label: '押し目指値待ち',
    fillRate: 55,
    stopPct: 0.45,
    costPct: 0.24,
    cancelRates: '30,40,50',
    autoFill: false,
    memo: '未約定が増えやすい前提です。未約定30〜50%シナリオを重点に見ます。',
  },
  breakout_follow: {
    label: 'ブレイクアウト追随',
    fillRate: 78,
    stopPct: 0.8,
    costPct: 0.30,
    cancelRates: '15,25,35',
    autoFill: false,
    memo: '約定率は高めですが、必要変動率と損切り幅が中〜大になりやすく、ダマシ耐性を確認します。',
  },
  range_reversion: {
    label: 'レンジ逆張り',
    fillRate: 68,
    stopPct: 0.35,
    costPct: 0.26,
    cancelRates: '20,30,40',
    autoFill: false,
    memo: '小さい値動きを狙う前提です。レンジ抜け時の損切り負担を必ず確認します。',
  },
  custom: {
    label: 'カスタム',
    fillRate: 70,
    stopPct: 0.5,
    costPct: 0.28,
    cancelRates: '10,30,50,70',
    autoFill: true,
    memo: '固定前提を持たず、入力条件をそのまま診断します。',
  },
};

function yen(v, digits = 0, signed = false) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: digits })}円`;
}
function pct(v, digits = 3, signed = false) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}
function neededWinDisplay(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (n >= 100) return '100%以上';
  return `${n.toFixed(digits)}%`;
}
function neededWinLabel(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (n >= 100) return '全勝前提';
  if (n >= 90) return 'ほぼ全勝前提';
  if (n >= 75) return 'かなり重い';
  if (n >= 60) return '重い';
  return '確認範囲';
}
function qty(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return Number(v).toFixed(8);
}

function elValue(id, fallback = '') {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
}
function elNumber(id, fallback = 0) {
  const value = Number(elValue(id, fallback));
  return Number.isFinite(value) ? value : fallback;
}
function elChecked(id, fallback = false) {
  const el = document.getElementById(id);
  return el ? el.checked : fallback;
}
function setValueIfExists(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}
function setCheckedIfExists(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = value;
}


const CHART_RANGE_MS_RENDERER = {
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};
const CHART_RANGE_LABELS_RENDERER = {
  '1h': '直近1時間',
  '3h': '直近3時間',
  '6h': '直近6時間',
  '24h': '直近24時間',
  '3d': '直近3日',
  '1w': '直近1週間',
};

function chartAutoInterval(rangeKey = '24h') {
  if (rangeKey === '1h' || rangeKey === '3h' || rangeKey === '6h') return '1m';
  if (rangeKey === '24h') return '5m';
  if (rangeKey === '3d' || rangeKey === '1w') return '15m';
  return '5m';
}

function selectedChartIntervalForDownload() {
  const range = elValue('chartRange', '24h');
  const requested = elValue('chartInterval', 'auto');
  return requested === 'auto' ? chartAutoInterval(range) : requested;
}

function jstPartsFromMs(ms) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
  };
}

function jstStartMs(dateText, hour = 0) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  return Date.UTC(year, month - 1, day, hour, 0, 0) - 9 * 60 * 60 * 1000;
}

function buildChartRangeDownloadRequests(rangeKey = '24h') {
  const duration = CHART_RANGE_MS_RENDERER[rangeKey] || CHART_RANGE_MS_RENDERER['24h'];
  const nowMs = Date.now();
  const startMs = nowMs - duration;
  const start = jstPartsFromMs(startMs);
  const end = jstPartsFromMs(nowMs);
  const requests = [];
  let dayMs = jstStartMs(start.date, 0);
  const endDayMs = jstStartMs(end.date, 0);
  while (dayMs <= endDayMs) {
    const date = jstPartsFromMs(dayMs).date;
    const startHour = date === start.date ? start.hour : 0;
    const endHour = date === end.date ? Math.min(24, end.hour + 1) : 24;
    if (endHour > startHour) requests.push({ date, start_hour: startHour, end_hour: endHour });
    dayMs += 24 * 60 * 60 * 1000;
  }
  return requests;
}

async function getJson(path) {
  if (window.blw?.api) {
    const url = new URL(path, 'http://local-engine');
    const query = Object.fromEntries(url.searchParams.entries());
    if (url.pathname === '/api/status') return window.blw.api.getStatus();
    if (url.pathname === '/api/capabilities') return window.blw.api.getCapabilities();
    if (url.pathname === '/api/contract') return window.blw.api.getContract();
    if (url.pathname === '/api/api-readiness') return window.blw.api.getApiReadiness();
    if (url.pathname === '/api/db-status') return window.blw.api.getDbStatus();
    if (url.pathname === '/api/summary') return window.blw.api.getSummary();
    if (url.pathname === '/api/impact') return window.blw.api.getImpact(query);
    if (url.pathname === '/api/alert-preview') return window.blw.api.getAlertPreview(query);
    if (url.pathname === '/api/alert-history') return window.blw.api.getAlertHistory(query);
    if (url.pathname === '/api/daily-goal-reports') return window.blw.api.getDailyGoalReports(query);
    if (url.pathname === '/api/chart') return window.blw.api.getChart(query);
    if (url.pathname === '/api/chart-coverage') return window.blw.api.getChartCoverage(query);
    if (url.pathname === '/api/analysis-cache-status') return window.blw.api.getAnalysisCacheStatus(query);
    throw new Error(`未対応のローカルエンジンGET: ${url.pathname}`);
  }
  throw new Error('Electron preload の window.blw.api が見つかりません。npm start から起動してください。');
}
async function postJson(path, body) {
  if (window.blw?.api) {
    if (path === '/api/fetch-prices') return window.blw.api.fetchPrices();
    if (path === '/api/download-history') return window.blw.api.downloadHistory(body || {});
    if (path === '/api/update-history-to-now') return window.blw.api.updateHistoryToNow(body || {});
    if (path === '/api/ensure-analysis-cache') return window.blw.api.ensureAnalysisCache(body || {});
    if (path === '/api/trade-preview') return window.blw.api.tradePreview(body || {});
    if (path === '/api/daily-goal') return window.blw.api.dailyGoal(body || {});
    if (path === '/api/save-daily-goal-report') return window.blw.api.saveDailyGoalReport(body || {});
    if (path === '/api/clear-alert-history') return window.blw.api.clearAlertHistory();
    if (path === '/api/clear-daily-goal-reports') return window.blw.api.clearDailyGoalReports();
    throw new Error(`未対応のローカルエンジンPOST: ${path}`);
  }
  throw new Error('Electron preload の window.blw.api が見つかりません。npm start から起動してください。');
}

function renderTable(el, columns, rows) {
  el.innerHTML = '';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  columns.forEach(([, label]) => {
    const th = document.createElement('th');
    th.textContent = label;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  el.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach(([key]) => {
      const td = document.createElement('td');
      td.textContent = row[key] ?? '—';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  el.appendChild(tbody);
}

function card({ title, value, sub, tag, kind }) {
  return `
    <div class="card">
      <div class="card-head">
        <h3>${title}</h3>
        ${tag ? `<span class="tag ${kind === 'warn' ? 'warn' : 'soft'}">${tag}</span>` : ''}
      </div>
      <div class="metric ${kind === 'good' ? 'good' : kind === 'bad' ? 'bad' : ''}">${value}</div>
      <div class="small">${sub || ''}</div>
    </div>
  `;
}

function formatBoundary(boundary) {
  if (!boundary) return 'API境界を取得できませんでした。';
  return [
    `UI: ${boundary.ui}`,
    `Backend: ${boundary.backend}`,
    `禁止: ${(boundary.forbidden || []).join(', ')}`,
    `Secret: ${boundary.secrets}`,
  ].join('\n');
}


function formatDbTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderDbStatusTables(data) {
  const candleRows = (data.latest_candles || []).map((row) => ({
    symbol: row.symbol || '—',
    interval: row.interval || '—',
    rows: row.rows ?? 0,
    period: `${formatDbTime(row.start_time_ms)} → ${formatDbTime(row.end_time_ms)}`,
  }));
  renderTable(document.getElementById('dbCandlesTable'), [
    ['symbol', '通貨'],
    ['interval', '足'],
    ['rows', '本数'],
    ['period', '期間(JST)'],
  ], candleRows);

  const fetchRows = (data.latest_fetch_runs || []).map((row) => ({
    id: row.id,
    target: `${row.symbol || '—'} / ${row.interval || '—'}`,
    type: row.fetch_type || '—',
    rows: `${row.rows_fetched ?? 0}本 / 追加${row.rows_inserted ?? 0} / 更新${row.rows_updated ?? 0}`,
    status: row.status || '—',
    at: formatDbTime(row.finished_at_ms || row.started_at_ms),
  }));
  renderTable(document.getElementById('dbFetchRunsTable'), [
    ['id', 'ID'],
    ['target', '対象'],
    ['type', '取得種別'],
    ['rows', '本数'],
    ['status', '状態'],
    ['at', '時刻(JST)'],
  ], fetchRows);

  const refRows = (data.latest_references || []).map((row) => ({
    id: row.id,
    purpose: row.purpose || '—',
    target: `${row.symbol || '—'} / ${row.interval || '—'}`,
    rows: `${row.row_count ?? 0}本`,
    quality: row.quality_label || '—',
    missing: row.missing_count === null || row.missing_count === undefined ? '—' : `${row.missing_count}本`,
    at: formatDbTime(row.created_at_ms),
  }));
  renderTable(document.getElementById('dbReferencesTable'), [
    ['id', 'ID'],
    ['purpose', '用途'],
    ['target', '対象'],
    ['rows', '参照本数'],
    ['quality', '品質'],
    ['missing', '欠損'],
    ['at', '作成時刻(JST)'],
  ], refRows);
}


function analysisCacheSymbolSelection() {
  const value = elValue('analysisCacheSymbol', 'all');
  if (value === 'BTCJPY' || value === 'ETHJPY') return [value];
  return CURRENT_UPDATE_SYMBOLS;
}

function renderAnalysisCacheStatus(data) {
  const rows = (data.rows || []).map((row) => ({
    symbol: row.symbol,
    interval: row.interval || '1m',
    period: `${row.start_jst || '—'} → ${row.end_jst || '—'}`,
    rows: `${row.row_count ?? 0}/${row.expected_row_count ?? '?'}本`,
    coverage: Number.isFinite(Number(row.coverage_pct)) ? `${Number(row.coverage_pct).toFixed(1)}%` : '—',
    quality: row.quality || '—',
    files: row.referenced_file_count ?? 0,
    source: row.source || '—',
  }));
  const table = document.getElementById('analysisCacheTable');
  if (table) {
    renderTable(table, [
      ['symbol', '通貨'],
      ['interval', '足'],
      ['period', '参照期間(JST)'],
      ['rows', '本数'],
      ['coverage', 'カバー率'],
      ['quality', '品質'],
      ['files', 'CSV'],
      ['source', '主ソース'],
    ], rows);
  }
  const memo = document.getElementById('analysisCacheMemo');
  if (memo) {
    memo.textContent = [
      data.message || '分析用キャッシュ状態を確認しました。',
      `参照: 1分足 / 直近${data.reference_days || '?'}日 / 保持方針${data.retention_days || 30}日`,
      `合計: ${data.row_count ?? 0}/${data.expected_row_count ?? '?'}本 / カバー率 ${Number.isFinite(Number(data.coverage_pct)) ? `${Number(data.coverage_pct).toFixed(1)}%` : '—'}`,
      '診断計算では未確定足を除外する方針です。',
    ].join('\n');
  }
}

async function loadAnalysisCacheStatus() {
  const days = elValue('analysisCacheDays', '7');
  const symbols = analysisCacheSymbolSelection().join(',');
  const data = await getJson(`/api/analysis-cache-status?reference_days=${encodeURIComponent(days)}&symbols=${encodeURIComponent(symbols)}`);
  renderAnalysisCacheStatus(data);
  return data;
}

async function ensureAnalysisCache() {
  const btn = document.getElementById('ensureAnalysisCache');
  const old = btn ? btn.textContent : '';
  const memo = document.getElementById('analysisCacheMemo');
  const days = elValue('analysisCacheDays', '7');
  const symbols = analysisCacheSymbolSelection();
  const label = symbols.length === CURRENT_UPDATE_SYMBOLS.length ? 'BTCJPY / ETHJPY' : symbols.join(', ');
  const ok = window.confirm(`分析用1分足キャッシュを整備します。\n\n対象: ${label}\n参照期間: 直近${days}日\n\n不足している場合は、Binance public klineから1分足を取得してlong_dataとDBへ保存します。\nこれは表示用ではなく、仮想約定率・必要値幅出現率・日次目標診断のためのデータ準備です。`);
  if (!ok) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '整備中...';
  }
  if (memo) memo.textContent = `分析用1分足キャッシュを整備中です...\n${label} / 直近${days}日`;
  try {
    const data = await postJson('/api/ensure-analysis-cache', {
      symbols,
      reference_days: Number(days),
      wait_ms: 250,
    });
    const lines = [data.message];
    (data.results || []).forEach((item) => lines.push(item.message));
    if (memo) memo.textContent = lines.filter(Boolean).join('\n');
    renderAnalysisCacheStatus(data.status || await loadAnalysisCacheStatus());
    await loadDbStatus();
    await loadSummaryMiniCharts();
  } catch (error) {
    if (memo) memo.textContent = `分析用1分足キャッシュ整備に失敗しました。\n${error.message}`;
  } finally {
    if (btn) {
      btn.textContent = old;
      btn.disabled = false;
    }
  }
}

async function loadDbStatus() {
  const memo = document.getElementById('dbStatusMemo');
  if (!memo) return;
  try {
    const data = await getJson('/api/db-status');
    const counts = data.counts || {};
    memo.textContent = data.enabled
      ? `DB Phase 1 有効: ${data.db_file}\nローソク足 ${counts.candles || 0}本 / 取得記録 ${counts.fetch_runs || 0}件 / 参照記録 ${counts.data_references || 0}件\n${data.message || ''}`
      : `DB Phase 1 未有効: ${data.message || '状態を取得できませんでした。'}\nDB予定パス: ${data.db_file || '—'}\n有効化するには npm install 後に再起動してください。`;
    renderDbStatusTables(data);
  } catch (e) {
    memo.textContent = `DB状態の取得に失敗: ${e.message}`;
    renderDbStatusTables({ latest_candles: [], latest_fetch_runs: [], latest_references: [] });
  }
}

async function loadStatus() {
  const pill = document.getElementById('backendStatus');
  try {
    const status = await getJson('/api/status');
    pill.textContent = `Local Engine OK / ${status.version}`;
    pill.className = 'status-pill ok';
    document.getElementById('apiBackendText').textContent = [
      'Electron内のローカルエンジンは利用可能です。',
      `モード: ${status.mode}`,
      `データ元: ${status.data_source}`,
      `履歴行数: ${status.history_rows}`,
      `履歴CSV: ${status.history_file}`,
      `DB Phase 1: ${status.db_phase1?.enabled ? '有効' : '未有効'} / candles=${status.db_phase1?.counts?.candles ?? 0}`,
      '',
      formatBoundary(status.api_boundary),
    ].join('\n');
    const contract = await getJson('/api/contract');
    document.getElementById('apiBackendText').textContent += `\n\nAPI Contract: GET ${Object.keys(contract.routes?.GET || {}).length} / POST ${Object.keys(contract.routes?.POST || {}).length}`;
    const readiness = await getJson('/api/api-readiness');
    document.getElementById('apiBackendText').textContent += `\nAPI Readiness: public=${readiness.public_api_ok ? 'ok' : 'ng'} / key=${readiness.has_api_key ? 'set' : 'unset'}(${readiness.api_key_source}) / secret=${readiness.has_api_secret ? 'set' : 'unset'}(${readiness.api_secret_source}) / auth=${readiness.auth_api_ok ? 'ok' : 'ng'} / fee=${readiness.fee_fetch_ready ? 'ready' : 'not-ready'}`;
  } catch (e) {
    pill.textContent = 'Local Engine NG';
    pill.className = 'status-pill bad';
    document.getElementById('apiBackendText').textContent = `ローカルエンジンを呼び出せません。\n${e.message}`;
  }
}

async function loadApiReadiness() {
  const memo = document.getElementById('apiReadinessMemo');
  const feeMemo = document.getElementById('apiFeeSampleMemo');
  const dailyLine = document.getElementById('dailyApiReadinessLine');
  try {
    const r = await getJson('/api/api-readiness');
    if (dailyLine) {
      dailyLine.textContent = `API準備度: public=${r.public_api_ok ? 'ok' : 'ng'} / key=${r.has_api_key ? 'set' : 'unset'} / auth=${r.auth_api_ok ? 'ok' : 'ng'} / fee=${r.fee_api_ok ? 'ok' : 'ng'}（保存なし）`;
    }
    memo.textContent = r.note || '読み取り専用チェック結果です。';
    const rows = [
      { item: '公開API到達', value: r.public_api_ok ? 'ok' : 'ng', detail: r.public_api_error || '—' },
      { item: 'API Key', value: r.has_api_key ? 'set' : 'unset', detail: r.api_key_source || 'none' },
      { item: 'API Secret', value: r.has_api_secret ? 'set' : 'unset', detail: r.api_secret_source || 'none' },
      { item: '署名API認証', value: r.auth_api_ok ? 'ok' : 'ng', detail: r.auth_api_error || '—' },
      { item: '手数料API', value: r.fee_api_ok ? 'ok' : 'ng', detail: r.fee_api_error || (Array.isArray(r.fee_sample) ? `${r.fee_sample.length}件サンプル取得` : '—') },
      { item: '口座タイプ', value: r.account_type || '—', detail: r.can_trade === null ? '—' : `canTrade=${r.can_trade}` },
      { item: '手数料取得準備', value: r.fee_fetch_ready ? 'ready' : 'not-ready', detail: '保存処理なし' },
    ];
    renderTable(document.getElementById('apiReadinessTable'), [
      ['item', '項目'],
      ['value', '状態'],
      ['detail', '詳細'],
    ], rows);
    const feeRows = Array.isArray(r.fee_sample) ? r.fee_sample.map((row) => ({
      symbol: row.symbol || '—',
      maker: Number.isFinite(Number(row.makerCommission)) ? `${(Number(row.makerCommission) * 100).toFixed(4)}%` : '—',
      taker: Number.isFinite(Number(row.takerCommission)) ? `${(Number(row.takerCommission) * 100).toFixed(4)}%` : '—',
    })) : [];
    feeMemo.textContent = r.fee_api_ok
      ? `手数料サンプル取得: ${feeRows.length}件（先頭のみ表示）`
      : `手数料サンプル取得NG: ${r.fee_api_error || '未取得'}`;
    renderTable(document.getElementById('apiFeeSampleTable'), [
      ['symbol', '通貨ペア'],
      ['maker', 'Maker'],
      ['taker', 'Taker'],
    ], feeRows);
  } catch (e) {
    memo.textContent = `API準備度の取得に失敗: ${e.message}`;
    if (dailyLine) dailyLine.textContent = `API準備度: 取得失敗 (${e.message})`;
    renderTable(document.getElementById('apiReadinessTable'), [['item', '項目'], ['value', '状態'], ['detail', '詳細']], []);
    feeMemo.textContent = '手数料サンプルは取得できませんでした。';
    renderTable(document.getElementById('apiFeeSampleTable'), [['symbol', '通貨ペア'], ['maker', 'Maker'], ['taker', 'Taker']], []);
  }
}

async function loadSummary() {
  const data = await getJson('/api/summary');
  const cards = data.symbols.map((s) => card({
    title: s.symbol,
    value: yen(s.price_jpy),
    sub: `前回比 ${yen(s.prev_diff_yen, 0, true)} / ${pct(s.prev_pct, 4, true)}\n${s.note}`,
    tag: s.status,
    kind: s.prev_diff_yen >= 0 ? 'good' : 'bad',
  })).join('');
  document.getElementById('summaryCards').innerHTML = cards;
  document.getElementById('summaryMemo').textContent = data.memo;
}

function renderMiniChart(symbol, data) {
  const svg = document.getElementById(`summaryMiniChart${symbol}`);
  const meta = document.getElementById(`summaryMiniChart${symbol}Meta`);
  if (!svg || !meta) return;

  const width = 420;
  const height = 150;
  const pad = 14;
  const points = (data?.points || []).filter((p) => Number.isFinite(Number(p.price)));
  svg.innerHTML = '';

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', String(width));
  bg.setAttribute('height', String(height));
  bg.setAttribute('rx', '14');
  bg.setAttribute('class', 'chart-bg');
  svg.appendChild(bg);

  for (let i = 0; i < 3; i += 1) {
    const y = pad + (i / 2) * (height - pad * 2);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(pad));
    line.setAttribute('x2', String(width - pad));
    line.setAttribute('y1', y.toFixed(2));
    line.setAttribute('y2', y.toFixed(2));
    line.setAttribute('class', 'chart-grid');
    svg.appendChild(line);
  }

  if (points.length >= 2) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', makeSvgPath(points, width, height, pad));
    path.setAttribute('class', 'mini-chart-line');
    svg.appendChild(path);

    const last = points[points.length - 1];
    const prices = points.map((p) => Number(p.price));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = Math.max(max - min, Math.abs(max) * 0.0001, 1);
    const x = width - pad;
    const y = height - pad - ((Number(last.price) - min) / span) * (height - pad * 2);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
    dot.setAttribute('r', '4');
    dot.setAttribute('class', 'chart-dot');
    svg.appendChild(dot);

    const first = points[0];
    const changePct = Number(first.price) ? ((Number(last.price) - Number(first.price)) / Number(first.price)) * 100 : null;
    const lastTime = last.timestamp || last.timestamp_full || '';
    meta.textContent = `${points.length}点 / ${pct(changePct, 3, true)} / 最新 ${yen(last.price)}${lastTime ? ` / ${lastTime}` : ''}`;
  } else {
    meta.textContent = data?.errors?.length
      ? `表示できません: ${data.errors.join(' / ')}`
      : 'データ不足';
  }
}

async function loadSummaryMiniCharts() {
  const symbols = ['BTCJPY', 'ETHJPY'];
  await Promise.all(symbols.map(async (symbol) => {
    const meta = document.getElementById(`summaryMiniChart${symbol}Meta`);
    if (meta) meta.textContent = '読み込み中...';
    try {
      // サマリーのミニチャートは「直近の形」を軽く見る目的なので、
      // チャートタブの日付指定には依存させず、DL済み＋現在まで更新済みデータを優先します。
      const today = todayJstDateText();
      const data = await getJson(`/api/chart?symbol=${encodeURIComponent(symbol)}&source=combined&interval=1m&date=${encodeURIComponent(today)}&start_hour=0&end_hour=24&limit=80`);
      renderMiniChart(symbol, data);
    } catch (e) {
      const svg = document.getElementById(`summaryMiniChart${symbol}`);
      if (svg) svg.innerHTML = '';
      if (meta) meta.textContent = `取得失敗: ${e.message}`;
    }
  }));
}

const CURRENT_UPDATE_SYMBOLS = ['BTCJPY', 'ETHJPY'];
const AUTO_CURRENT_UPDATE_MS = 60 * 1000;
let currentUpdateRunning = false;
let autoCurrentUpdateTimer = null;
let autoCurrentUpdateLastRunAt = null;
let autoCurrentUpdateNextRunAt = null;

function formatClock(date) {
  if (!date) return '—';
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setAutoUpdateStatus(message) {
  const el = document.getElementById('autoUpdateStatus');
  if (el) el.textContent = message;
}

function isAutoCurrentUpdateEnabled() {
  const el = document.getElementById('autoUpdateEnabled');
  return el ? el.checked : false;
}

function clearAutoCurrentUpdateTimer() {
  if (autoCurrentUpdateTimer) {
    clearTimeout(autoCurrentUpdateTimer);
    autoCurrentUpdateTimer = null;
  }
}

function scheduleAutoCurrentUpdate(delayMs = AUTO_CURRENT_UPDATE_MS) {
  clearAutoCurrentUpdateTimer();
  if (!isAutoCurrentUpdateEnabled()) {
    autoCurrentUpdateNextRunAt = null;
    setAutoUpdateStatus(autoCurrentUpdateLastRunAt
      ? `自動更新OFF / 最終 ${formatClock(autoCurrentUpdateLastRunAt)}`
      : '自動更新OFF');
    return;
  }
  autoCurrentUpdateNextRunAt = new Date(Date.now() + delayMs);
  setAutoUpdateStatus(`自動更新ON / 次回 ${formatClock(autoCurrentUpdateNextRunAt)}`);
  autoCurrentUpdateTimer = setTimeout(async () => {
    if (!isAutoCurrentUpdateEnabled()) {
      scheduleAutoCurrentUpdate();
      return;
    }
    try {
      await fetchPrices({ source: 'auto' });
    } catch (e) {
      setAutoUpdateStatus(`自動更新エラー / 次回再試行予定: ${e.message}`);
    } finally {
      if (isAutoCurrentUpdateEnabled()) scheduleAutoCurrentUpdate(AUTO_CURRENT_UPDATE_MS);
    }
  }, delayMs);
}

function setupAutoCurrentUpdate() {
  const checkbox = document.getElementById('autoUpdateEnabled');
  if (!checkbox) return;
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      scheduleAutoCurrentUpdate(1000);
    } else {
      scheduleAutoCurrentUpdate();
    }
  });
  scheduleAutoCurrentUpdate(AUTO_CURRENT_UPDATE_MS);
}

function summarizeHistoryToNowResults(results) {
  const okItems = results.filter((item) => item.ok && item.data);
  const errorItems = results.filter((item) => !item.ok);
  const totalFetched = okItems.reduce((sum, item) => sum + Number(item.data.fetched_rows || 0), 0);
  const totalInserted = okItems.reduce((sum, item) => sum + Number(item.data.inserted_rows || 0), 0);
  const totalRequests = okItems.reduce((sum, item) => sum + Number(item.data.request_count || 0), 0);
  const fileNames = Array.from(new Set(okItems.flatMap((item) => item.data.file_names || [])));
  const latestLines = okItems.map((item) => {
    const data = item.data;
    return `${data.symbol}: ${data.latest_before_jst || 'なし'} → ${data.latest_after_jst || 'なし'}`;
  });
  const engineErrors = okItems.flatMap((item) => (item.data.errors || []).map((error) => `${item.data.symbol}: ${error}`));
  const thrownErrors = errorItems.map((item) => `${item.symbol}: ${item.error}`);
  const unconfirmed = okItems.some((item) => item.data.unconfirmed_latest);
  const fallback = okItems.some((item) => item.data.fallback_used);

  return [
    `現在時刻まで差分DL: 取得 ${totalFetched}本 / 追加 ${totalInserted}本 / API回数 ${totalRequests}`,
    latestLines.length ? `最新足: ${latestLines.join(' / ')}` : '',
    fileNames.length ? `更新ファイル: ${fileNames.join(' / ')}` : '',
    fallback ? 'DL済み履歴がない通貨は、今日の直近分から取得しました。' : '',
    unconfirmed ? '注意: 最新足は未確定の可能性があります。条件診断では確定足だけを優先して見る予定です。' : '',
    engineErrors.length || thrownErrors.length ? `エラー: ${[...engineErrors, ...thrownErrors].join(' / ')}` : '',
  ].filter(Boolean);
}

async function updateHistoryToNowBatch({ symbols = CURRENT_UPDATE_SYMBOLS, interval = '1m', memo = null, progressLabel = '履歴を現在時刻まで更新中' } = {}) {
  const results = [];
  for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    if (memo) memo.textContent = `${progressLabel}\n${symbol} ${interval} を更新中... (${i + 1}/${symbols.length})`;
    try {
      const data = await postJson('/api/update-history-to-now', {
        symbol,
        interval,
        wait_ms: 250,
        fallback_hours: 6,
        include_unconfirmed: true,
      });
      results.push({ ok: true, symbol, data });
    } catch (error) {
      results.push({ ok: false, symbol, error: error.message || String(error) });
    }
  }
  return results;
}

async function fetchPrices({ source = 'manual' } = {}) {
  if (currentUpdateRunning) {
    setAutoUpdateStatus('更新中のため、次の自動更新は待機します。');
    return;
  }
  currentUpdateRunning = true;
  const btn = document.getElementById('fetchPrices');
  const old = btn ? btn.textContent : '';
  const summaryMemo = document.getElementById('summaryMemo');
  const historyMemo = document.getElementById('historyDownloadMemo');
  const interval = elValue('historyInterval', elValue('chartInterval', '1m'));

  if (btn) {
    btn.textContent = source === 'auto' ? '自動更新中...' : '現在まで更新中...';
    btn.disabled = true;
  }
  setAutoUpdateStatus(source === 'auto' ? '自動更新中...' : '手動更新中...');
  if (summaryMemo) summaryMemo.textContent = `現在価格を保存し、BTCJPY / ETHJPY のDL済み履歴を現在時刻まで更新しています。`;
  try {
    const priceData = await postJson('/api/fetch-prices', {});
    const historyResults = await updateHistoryToNowBatch({
      symbols: CURRENT_UPDATE_SYMBOLS,
      interval,
      memo: summaryMemo,
      progressLabel: '現在価格保存後、チャート用DL履歴を現在時刻まで更新中',
    });
    const historyLines = summarizeHistoryToNowResults(historyResults);
    const priceLines = [
      priceData.message,
      `保存先: ${priceData.history_file}`,
      priceData.errors?.length ? `価格取得エラー: ${priceData.errors.join(' / ')}` : '',
    ].filter(Boolean);

    if (summaryMemo) summaryMemo.textContent = [...priceLines, ...historyLines].join('\n');
    if (historyMemo) historyMemo.textContent = historyLines.join('\n');

    setValueIfExists('historyInterval', interval);
    setValueIfExists('chartInterval', interval);
    setValueIfExists('chartSource', 'combined');
    await loadStatus();
    await loadSummary();
    if (summaryMemo) summaryMemo.textContent = [...priceLines, ...historyLines].join('\n');
    await loadSummaryMiniCharts();
    await loadImpact();
    await loadAlertPreview();
    await loadChart();
    autoCurrentUpdateLastRunAt = new Date();
    const nextText = isAutoCurrentUpdateEnabled() ? ` / 次回 ${formatClock(new Date(Date.now() + AUTO_CURRENT_UPDATE_MS))}` : '';
    setAutoUpdateStatus(`${source === 'auto' ? '自動更新完了' : '手動更新完了'} / 最終 ${formatClock(autoCurrentUpdateLastRunAt)}${nextText}`);
  } catch (e) {
    if (summaryMemo) summaryMemo.textContent = `現在価格＋履歴更新に失敗しました。\n${e.message}`;
    setAutoUpdateStatus(`${source === 'auto' ? '自動更新失敗' : '手動更新失敗'}: ${e.message}`);
  } finally {
    if (btn) {
      btn.textContent = old;
      btn.disabled = false;
    }
    currentUpdateRunning = false;
  }
}

async function loadImpact() {
  const amounts = encodeURIComponent(document.getElementById('impactAmounts').value);
  const data = await getJson(`/api/impact?amounts=${amounts}`);
  const rows = data.rows.map((r) => ({
    symbol: r.symbol,
    amount: yen(r.amount_jpy),
    price: yen(r.price_jpy),
    quantity: qty(r.quantity),
    prev: yen(r.prev_impact_yen, 2, true),
    short: yen(r.short_impact_yen, 2, true),
  }));
  renderTable(document.getElementById('impactTable'), [
    ['symbol', '通貨'], ['amount', '想定額'], ['price', '現在価格'], ['quantity', '概算数量'], ['prev', '前回比影響'], ['short', '短期影響'],
  ], rows);
}

async function loadAlertPreview() {
  const windowMinutes = Number(document.getElementById('alertWindowMinutes').value);
  const alertMode = document.getElementById('alertMode').value;
  const rollingMinPoints = Number(document.getElementById('alertRollingMinPoints').value);
  const risingRatio = Number(document.getElementById('alertRisingRatio').value);
  const thresholdPct = Number(document.getElementById('alertThresholdPct').value);
  const btcThreshold = Number(document.getElementById('alertThresholdBTC').value);
  const ethThreshold = Number(document.getElementById('alertThresholdETH').value);
  const saveHistory = document.getElementById('alertSaveHistory').checked;
  const selectedSymbols = Array.from(document.querySelectorAll('.alertSymbol:checked')).map((el) => el.value);
  if (!selectedSymbols.length) {
    document.getElementById('alertPreviewMemo').textContent = '判定対象の通貨を1つ以上選んでください。';
    document.getElementById('alertTopMemo').textContent = '上位通知は表示できません。';
    renderTable(document.getElementById('alertPreviewTable'), [
      ['symbol', '通貨'], ['status', '状態'],
    ], []);
    return;
  }
  const thresholdPairs = [];
  if (Number.isFinite(btcThreshold) && btcThreshold >= 0) thresholdPairs.push(`BTCJPY:${btcThreshold}`);
  if (Number.isFinite(ethThreshold) && ethThreshold >= 0) thresholdPairs.push(`ETHJPY:${ethThreshold}`);
  const thresholdsQuery = thresholdPairs.join(',');
  const data = await getJson(`/api/alert-preview?window_minutes=${encodeURIComponent(windowMinutes)}&alert_mode=${encodeURIComponent(alertMode)}&rolling_min_points=${encodeURIComponent(rollingMinPoints)}&alert_rising_ratio=${encodeURIComponent(risingRatio)}&threshold_pct=${encodeURIComponent(thresholdPct)}&symbols=${encodeURIComponent(selectedSymbols.join(','))}&thresholds=${encodeURIComponent(thresholdsQuery)}&save_history=${encodeURIComponent(saveHistory)}`);
  document.getElementById('alertPreviewMemo').textContent = `${data.message} / mode ${data.alert_mode} / 対象: ${(data.symbols || selectedSymbols).join(', ')} / 窓 ${data.window_minutes}分 / しきい値 ${pct(data.threshold_pct, 2)} / 上昇比率 ${pct(data.alert_rising_ratio, 1)} / 履歴保存 ${data.history_saved || 0}件 / データ元: ${data.source}`;
  const top = data.top_alert;
  document.getElementById('alertTopMemo').textContent = top
    ? `上位通知: ${top.symbol} ${pct(top.move_pct, 3, true)} (${top.status})`
    : '上位通知はまだありません。';
  const rows = (data.rows || []).map((row) => ({
    symbol: row.symbol,
    status: row.status,
    move_pct: row.move_pct === null || row.move_pct === undefined ? '—' : pct(row.move_pct, 3, true),
    threshold: row.threshold_pct === null || row.threshold_pct === undefined ? pct(data.threshold_pct, 2) : pct(row.threshold_pct, 2),
    streak: `${row.streak_count ?? 0}`,
    rolling_streak: `${row.rolling_streak ?? 0}`,
    rising_ratio: row.rising_ratio === null || row.rising_ratio === undefined ? '—' : pct(row.rising_ratio, 1),
    samples: `${row.samples ?? 0}`,
    latest: yen(row.latest_price),
    base: yen(row.base_price),
    latest_time: row.latest_time || '—',
  }));
  renderTable(document.getElementById('alertPreviewTable'), [
    ['symbol', '通貨'],
    ['status', '状態'],
    ['move_pct', `変動率(${data.window_minutes}分)`],
    ['threshold', '適用しきい値'],
    ['streak', '連続回数'],
    ['rolling_streak', 'rolling連続'],
    ['rising_ratio', '上昇比率'],
    ['samples', 'サンプル数'],
    ['latest', '最新価格'],
    ['base', '起点価格'],
    ['latest_time', '最新時刻'],
  ], rows);
  await loadAlertHistory();
}

async function loadAlertHistory() {
  const data = await getJson('/api/alert-history?limit=20');
  document.getElementById('alertHistoryMemo').textContent = `保存件数: ${data.count} / 表示: ${data.rows.length} / ${data.file}`;
  const rows = (data.rows || []).map((row) => ({
    timestamp: row.timestamp_jst || '—',
    symbol: row.symbol || '—',
    move_pct: row.move_pct === null || row.move_pct === undefined ? '—' : pct(row.move_pct, 3, true),
    threshold: row.threshold_pct === null || row.threshold_pct === undefined ? '—' : pct(row.threshold_pct, 2),
    streak: `${row.streak_count ?? 0}`,
    window: `${row.window_minutes ?? 0}`,
  }));
  renderTable(document.getElementById('alertHistoryTable'), [
    ['timestamp', '時刻'],
    ['symbol', '通貨'],
    ['move_pct', '変動率'],
    ['threshold', 'しきい値'],
    ['streak', '連続回数'],
    ['window', '窓(分)'],
  ], rows);
}

async function clearAlertHistory() {
  const result = await postJson('/api/clear-alert-history', {});
  document.getElementById('alertHistoryMemo').textContent = result.message;
  await loadAlertHistory();
}

function makeSvgPath(points, width, height, pad) {
  const prices = points.map((p) => Number(p.price)).filter((n) => Number.isFinite(n));
  if (prices.length < 2) return '';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(max - min, Math.abs(max) * 0.0001, 1);
  return points.map((p, i) => {
    const x = pad + (i / Math.max(points.length - 1, 1)) * (width - pad * 2);
    const y = height - pad - ((Number(p.price) - min) / span) * (height - pad * 2);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}


function chartSourceLabel(source) {
  const labels = {
    'local-history+downloaded-kline': 'DL済み＋現在まで更新済み',
    'downloaded-kline-current': 'DL済み＋現在まで更新済みkline',
    'downloaded-kline': 'DL済みファイルのみ',
    'binance-klines': '公開kline一時表示',
    'local-history': 'ローカル履歴フォールバック',
    mock: 'サンプル',
  };
  return labels[source] || source || '不明';
}

function renderChart(data) {
  const svg = document.getElementById('priceChart');
  const width = 900;
  const height = 320;
  const pad = 36;
  const points = data.points || [];
  svg.innerHTML = '';

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0'); bg.setAttribute('width', width); bg.setAttribute('height', height); bg.setAttribute('rx', '18');
  bg.setAttribute('class', 'chart-bg');
  svg.appendChild(bg);

  for (let i = 0; i < 4; i += 1) {
    const y = pad + (i / 3) * (height - pad * 2);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', pad); line.setAttribute('x2', width - pad); line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-grid');
    svg.appendChild(line);
  }

  if (points.length >= 2) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', makeSvgPath(points, width, height, pad));
    path.setAttribute('class', 'chart-line');
    svg.appendChild(path);

    const last = points[points.length - 1];
    const prices = points.map((p) => Number(p.price));
    const min = Math.min(...prices); const max = Math.max(...prices); const span = Math.max(max - min, Math.abs(max) * 0.0001, 1);
    const x = width - pad;
    const y = height - pad - ((Number(last.price) - min) / span) * (height - pad * 2);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '5'); dot.setAttribute('class', 'chart-dot');
    svg.appendChild(dot);
  }

  const errorText = data.errors?.length ? ` / エラー: ${data.errors.join(' / ')}` : '';
  const rangeText = data.range_label ? ` / ${data.range_label}${data.range_start_jst && data.range_end_jst ? ` (${data.range_start_jst}〜${data.range_end_jst})` : ''}` : '';
  const intervalText = data.interval ? ` / ${data.interval}足${data.interval_requested === 'auto' ? '（自動）' : ''}` : '';
  const rowsText = data.raw_rows && data.raw_rows !== data.rows ? `${data.rows}点表示 / 元${data.raw_rows}本` : `${data.rows}点`;
  document.getElementById('chartMeta').textContent = `${data.symbol} / ${rowsText} / ${chartSourceLabel(data.source)}${rangeText}${intervalText} / ${data.message} 価格範囲: ${yen(data.min_price)} - ${yen(data.max_price)}${errorText}`;
}

async function loadChart() {
  const symbol = document.getElementById('chartSymbol').value;
  let source = document.getElementById('chartSource').value;
  if (source === 'local') {
    source = 'combined';
    setValueIfExists('chartSource', 'combined');
  }
  let interval = document.getElementById('chartInterval').value;

  // 表示範囲・足切替は公開kline一時表示用。
  // DL済み表示は保存ファイル確認用なので、autoのままDL表示へ入ると1mフォールバックになりやすい。
  if (source !== 'klines' && interval === 'auto') {
    interval = '1m';
    setValueIfExists('chartInterval', '1m');
  }

  const range = elValue('chartRange', '24h');
  const date = document.getElementById('historyDate').value;
  const startHour = document.getElementById('historyStartHour').value;
  const endHour = document.getElementById('historyEndHour').value;
  const data = await getJson(`/api/chart?symbol=${encodeURIComponent(symbol)}&source=${encodeURIComponent(source)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&date=${encodeURIComponent(date)}&start_hour=${encodeURIComponent(startHour)}&end_hour=${encodeURIComponent(endHour)}&limit=520`);
  renderChart(data);
}

function loadChartRangeFromKlines() {
  // 「表示範囲」と「足」はkline直取得で効かせる。
  // DL済み＋現在データは基本1m保存なので、ここを切り替えないと5m/15m/30m/1hが同じ見た目になりやすい。
  setValueIfExists('chartSource', 'klines');
  return loadChart();
}


async function downloadSelectedChartRangeForDisplay(options = {}) {
  const symbol = elValue('chartSymbol', 'BTCJPY');
  const range = elValue('chartRange', '24h');
  const interval = selectedChartIntervalForDownload();
  const label = CHART_RANGE_LABELS_RENDERER[range] || range;
  const requests = Array.isArray(options.requests) && options.requests.length
    ? options.requests
    : buildChartRangeDownloadRequests(range);
  const skipExisting = options.skipExisting !== undefined ? Boolean(options.skipExisting) : true;
  const memo = document.getElementById('historyDownloadMemo');
  const btn = document.getElementById('reloadChart');
  const oldText = btn ? btn.textContent : '';
  let downloaded = 0;
  let skipped = 0;
  let errors = [];
  const files = new Set();

  if (!requests.length) throw new Error('DL対象の表示範囲を作れませんでした。');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'DLして更新中...';
  }
  try {
    for (let i = 0; i < requests.length; i += 1) {
      const req = requests[i];
      if (memo) memo.textContent = `チャート表示範囲をDL中: ${symbol} ${interval} / ${label}
${req.date} ${req.start_hour}:00〜${req.end_hour}:00 (${i + 1}/${requests.length})`;
      const data = await postJson('/api/download-history', {
        symbol,
        interval,
        date: req.date,
        start_hour: req.start_hour,
        end_hour: req.end_hour,
        skip_existing: skipExisting,
        wait_ms: 250,
      });
      (data.chunks || []).forEach((chunk) => {
        if (chunk.status === 'downloaded') downloaded += 1;
        if (chunk.status === 'skipped') skipped += 1;
        if (chunk.file) files.add(chunk.file.split(/[\\/]/).pop());
      });
      if (data.merged_file) files.add(String(data.merged_file).split(/[\\/]/).pop());
      if (Array.isArray(data.errors) && data.errors.length) {
        errors = errors.concat(data.errors.map((err) => `${err.label || req.date}: ${err.error || err}`));
      }
    }

    setValueIfExists('historySymbol', symbol);
    setValueIfExists('historyInterval', interval);
    setValueIfExists('chartInterval', interval);
    setValueIfExists('chartSource', 'combined');
    if (memo) {
      memo.textContent = [
        `チャート表示範囲DL完了: ${symbol} ${interval} / ${label}`,
        `取得チャンク: ${downloaded} / スキップ: ${skipped} / 対象範囲: ${requests.length}件`,
        files.size ? `更新ファイル: ${Array.from(files).slice(0, 8).join(' / ')}${files.size > 8 ? ` ほか${files.size - 8}件` : ''}` : '',
        errors.length ? `エラー: ${errors.join(' / ')}` : '',
      ].filter(Boolean).join('\n');
    }
    await loadStatus();
    await loadDbStatus();
    await loadSummaryMiniCharts();
    return { downloaded, skipped, errors, requests };
  } finally {
    if (btn) {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  }
}

async function getSelectedChartCoverage() {
  const symbol = elValue('chartSymbol', 'BTCJPY');
  const range = elValue('chartRange', '24h');
  const interval = selectedChartIntervalForDownload();
  return getJson(`/api/chart-coverage?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`);
}

function chartCoverageSummaryText(coverage) {
  if (!coverage) return '';
  const pct = Number.isFinite(Number(coverage.coverage_pct)) ? `${Number(coverage.coverage_pct).toFixed(1)}%` : '不明';
  const rows = `${coverage.row_count ?? 0}/${coverage.expected_row_count ?? '?'}本`;
  const files = coverage.referenced_file_count ? `参照ファイル${coverage.referenced_file_count}件` : '参照ファイルなし';
  return `${coverage.symbol} / ${coverage.range_label || coverage.range} / ${coverage.interval}足 / ${rows} / カバー率${pct} / ${files}`;
}

async function reloadChartWithDownloadConfirm() {
  const symbol = elValue('chartSymbol', 'BTCJPY');
  const range = elValue('chartRange', '24h');
  const interval = selectedChartIntervalForDownload();
  const label = CHART_RANGE_LABELS_RENDERER[range] || range;
  const memo = document.getElementById('historyDownloadMemo');
  let coverage = null;

  try {
    coverage = await getSelectedChartCoverage();
  } catch (error) {
    if (memo) memo.textContent = `DL済みデータ確認に失敗しました。従来どおり確認して更新します: ${error.message}`;
  }

  if (coverage?.enough) {
    setValueIfExists('chartInterval', interval);
    setValueIfExists('chartSource', 'combined');
    if (memo) {
      memo.textContent = `DL確認スキップ: 必要なデータは既にあります。\n${chartCoverageSummaryText(coverage)}`;
    }
    await loadChart();
    return;
  }

  const coverageText = coverage ? `\n\n現在のDL済み状況:\n${chartCoverageSummaryText(coverage)}` : '';
  const missingText = coverage?.missing_request_count
    ? `\n不足範囲: ${coverage.missing_request_count}件。はいを選ぶと不足範囲だけDLします。`
    : '';
  const title = coverage && coverage.row_count > 0
    ? 'チャート表示範囲のデータが一部不足しています。DLしてから更新しますか？'
    : 'チャート表示範囲のDL済みデータがありません。DLしてから更新しますか？';
  const shouldDownload = window.confirm(
    `${title}\n\n対象: ${symbol} / ${label} / ${interval}足${coverageText}${missingText}\n\nはい: long_data とDBへ保存してから「DL済み＋現在まで更新済み」で表示\nいいえ: 保存せず、現在の表示設定で更新`
  );
  if (shouldDownload) {
    await downloadSelectedChartRangeForDisplay({
      requests: coverage?.missing_requests || [],
      skipExisting: false,
    });
  }
  await loadChart();
}

function todayJstDateText() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

async function downloadHistory() {
  const btn = document.getElementById('downloadHistory');
  const old = btn.textContent;
  const memo = document.getElementById('historyDownloadMemo');
  const payload = {
    symbol: document.getElementById('historySymbol').value,
    interval: document.getElementById('historyInterval').value,
    date: document.getElementById('historyDate').value,
    start_hour: Number(document.getElementById('historyStartHour').value),
    end_hour: Number(document.getElementById('historyEndHour').value),
    skip_existing: document.getElementById('historySkipExisting').checked,
    wait_ms: 450,
  };
  btn.textContent = '取得中...';
  btn.disabled = true;
  memo.textContent = '1時間チャンクに分けて取得しています。';
  try {
    const data = await postJson('/api/download-history', payload);
    const downloaded = (data.chunks || []).filter((c) => c.status === 'downloaded').length;
    const skipped = (data.chunks || []).filter((c) => c.status === 'skipped').length;
    memo.textContent = [
      data.message,
      `取得: ${downloaded} / スキップ: ${skipped} / エラー: ${data.errors?.length || 0}`,
      `統合CSV: ${data.merged_file}`,
      data.errors?.length ? `エラー: ${data.errors.map((e) => `${e.label}: ${e.error}`).join(' / ')}` : '',
    ].filter(Boolean).join('\n');
    document.getElementById('chartSymbol').value = payload.symbol;
    document.getElementById('chartInterval').value = payload.interval;
    document.getElementById('chartSource').value = 'combined';
    await loadChart();
  } catch (e) {
    memo.textContent = `履歴DLに失敗しました。\n${e.message}`;
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

async function updateHistoryToNow() {
  const btn = document.getElementById('updateHistoryToNow');
  const old = btn.textContent;
  const memo = document.getElementById('historyDownloadMemo');
  const symbol = elValue('historySymbol', elValue('chartSymbol', 'BTCJPY'));
  const interval = elValue('historyInterval', elValue('chartInterval', '1m'));

  btn.textContent = '現在まで更新中...';
  btn.disabled = true;
  if (memo) memo.textContent = `${symbol} ${interval} の現在価格を保存し、DL済み履歴を現在時刻まで追加しています。`;
  try {
    const priceData = await postJson('/api/fetch-prices', {});
    const historyResults = await updateHistoryToNowBatch({
      symbols: [symbol],
      interval,
      memo,
      progressLabel: `${symbol} のチャート用DL履歴を現在時刻まで更新中`,
    });
    const historyLines = summarizeHistoryToNowResults(historyResults);
    const priceLines = [
      `現在価格保存: ${priceData.message}`,
      priceData.errors?.length ? `価格取得エラー: ${priceData.errors.join(' / ')}` : '',
    ].filter(Boolean);

    if (memo) memo.textContent = [...priceLines, ...historyLines].join('\n');
    setValueIfExists('historySymbol', symbol);
    setValueIfExists('historyInterval', interval);
    setValueIfExists('historyDate', todayJstDateText());
    setValueIfExists('historyStartHour', '0');
    setValueIfExists('historyEndHour', '24');
    setValueIfExists('chartSymbol', symbol);
    setValueIfExists('chartInterval', interval);
    setValueIfExists('chartSource', 'combined');
    await loadStatus();
    await loadSummary();
    await loadSummaryMiniCharts();
    await loadImpact();
    await loadAlertPreview();
    await loadChart();
  } catch (e) {
    if (memo) memo.textContent = `現在価格＋現在時刻までの差分DLに失敗しました。\n${e.message}`;
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

async function calcTrade() {
  const payload = {
    symbol: document.getElementById('tradeSymbol').value,
    amount_jpy: Number(document.getElementById('tradeAmount').value),
    exit_change_pct: Number(document.getElementById('tradeExitPct').value),
    roundtrip_cost_pct: Number(document.getElementById('tradeCostPct').value),
  };
  const data = await postJson('/api/trade-preview', payload);
  document.getElementById('tradeCards').innerHTML = [
    card({ title: '買える概算数量', value: qty(data.quantity), sub: `現在価格 ${yen(data.current_price)}` }),
    card({ title: 'Gross P/L', value: yen(data.gross_pl_yen, 2, true), sub: `想定売却価格 ${yen(data.exit_price)}`, kind: data.gross_pl_yen >= 0 ? 'good' : 'bad' }),
    card({ title: 'Net P/L', value: yen(data.net_pl_yen, 2, true), sub: `往復コスト ${pct(data.roundtrip_cost_pct, 2)}`, kind: data.net_pl_yen >= 0 ? 'good' : 'bad', tag: data.accuracy }),
  ].join('');
  document.getElementById('tradeMemo').textContent = data.memo;
}

function syncRoundtripCostFromTrade() {
  const tradeCostEl = document.getElementById('tradeCostPct');
  const dailyCostEl = document.getElementById('dailyCostPct');
  if (!tradeCostEl || !dailyCostEl) return;
  dailyCostEl.value = tradeCostEl.value;
}

function buildDailyPayload() {
  syncRoundtripCostFromTrade();
  const linkedCost = Number(document.getElementById('tradeCostPct').value);
  const occurrenceReferenceDays = elNumber('dailyOccurrenceReferenceDays', elNumber('dailyVirtualFillReferenceDays', 30));
  return {
    strategy_template: elValue('dailyTemplate', 'market_priority'),
    symbol: elValue('dailySymbol', 'BTCJPY'),
    target_profit_jpy: elNumber('dailyTarget', 0),
    expected_success_count: elNumber('dailyExpectedWins', 1),
    take_profit_pct: elNumber('dailyTakeProfitPct', 0.4),
    capital_jpy: elNumber('dailyCapital', 1),
    min_opportunities: elNumber('dailyMinOpp', 1),
    max_opportunities: elNumber('dailyMaxOpp', 1),
    stop_loss_pct: elNumber('dailyStopPct', 0),
    roundtrip_cost_pct: linkedCost,
    cancel_rates_text: elValue('dailyCancelRates', '10,30,50'),
    virtual_fill_rate_pct: elNumber('dailyFillRate', 70),
    virtual_fill_history_enabled: elChecked('dailyVirtualFillHistoryEnabled', true),
    virtual_fill_reference_days: elNumber('dailyVirtualFillReferenceDays', 30),
    virtual_fill_side: elValue('dailyVirtualFillSide', 'buy_limit'),
    limit_distance_pct: elNumber('dailyLimitDistancePct', 0.2),
    // trueなら「必要値幅の出現率」を別計算します。仮想約定率の履歴試算とは分離します。
    virtual_fill_rate_auto: elChecked('dailyOccurrenceEnabled', true),
    occurrence_reference_days: occurrenceReferenceDays,
    occurrence_window_minutes: elNumber('dailyOccurrenceWindowMinutes', 15),
    occurrence_direction: elValue('dailyOccurrenceDirection', 'up'),
    // 旧API互換用。日次目標側の必要値幅出現率は、常に分析用1分足キャッシュを使います。
    occurrence_interval: '1m',
    occurrence_scope: 'analysis_cache',
    interval: '1m',
  };
}

async function calcDaily() {
  const templateId = document.getElementById('dailyTemplate').value;
  const errorMemo = document.getElementById('dailyErrorMemo');
  const payload = buildDailyPayload();
  const errors = [];
  if (!Number.isFinite(payload.target_profit_jpy) || payload.target_profit_jpy < 0) errors.push('日次目標利益は0以上で入力してください。');
  if (!Number.isFinite(payload.capital_jpy) || payload.capital_jpy <= 0) errors.push('資金 / 主投入額は0より大きい値にしてください。');
  if (!Number.isFinite(payload.expected_success_count) || payload.expected_success_count < 1) errors.push('想定成功回数は1以上にしてください。');
  if (!Number.isFinite(payload.take_profit_pct) || payload.take_profit_pct < 0) errors.push('想定利確幅は0%以上で入力してください。');
  if (!Number.isFinite(payload.min_opportunities) || payload.min_opportunities < 1) errors.push('最小機会回数は1以上にしてください。');
  if (!Number.isFinite(payload.max_opportunities) || payload.max_opportunities < payload.min_opportunities) errors.push('最大機会回数は最小機会回数以上にしてください。');
  if (!Number.isFinite(payload.stop_loss_pct) || payload.stop_loss_pct < 0) errors.push('損切り逆行率は0以上で入力してください。');
  if (!Number.isFinite(payload.roundtrip_cost_pct) || payload.roundtrip_cost_pct < 0) errors.push('往復コストは0以上で入力してください。');
  if (!Number.isFinite(payload.virtual_fill_rate_pct) || payload.virtual_fill_rate_pct < 0 || payload.virtual_fill_rate_pct > 100) errors.push('仮想約定率（手入力/代替）は0〜100%で入力してください。');
  if (!Number.isFinite(payload.limit_distance_pct) || payload.limit_distance_pct < 0) errors.push('指値距離は0%以上で入力してください。');
  if (errors.length) {
    errorMemo.textContent = `入力エラー: ${errors.join(' / ')}`;
    return;
  }
  errorMemo.textContent = '';
  const data = await postJson('/api/daily-goal', payload);
  // 仮想約定率は、分析用1分足キャッシュで試算できればそれを使い、できない場合は手入力値を代替にします。
  document.getElementById('dailyCostPct').value = Number(data.roundtrip_cost_pct || payload.roundtrip_cost_pct).toFixed(2);
  document.getElementById('dailyTemplateMemo').textContent = data.strategy_template_note
    || 'テンプレートは売買シグナルではなく、条件比較の補助です。';
  document.getElementById('dailySuggestion').textContent = data.suggestion;
  document.getElementById('dailyDiagnosticSummary').textContent = data.diagnostic_summary || '総合診断はまだありません。';
  document.getElementById('dailyFillRateMemo').textContent = data.virtual_fill_rate_note
    || '仮想約定率は手入力値またはテンプレート値です。必要値幅の履歴確認とは別扱いです。';
  renderDailyVirtualFill(data);
  renderDailyOccurrence(data);
  document.getElementById('dailyReadinessCards').innerHTML = (data.readiness_cards || []).map((p) => card({
    title: p.title,
    value: p.main,
    sub: p.sub,
    tag: p.tag,
    kind: p.kind,
  })).join('');
  document.getElementById('dailyPrepNotes').innerHTML = (data.prep_notes || []).map((note) => `<li>${note}</li>`).join('');
  document.getElementById('dailyPlanCards').innerHTML = data.plan_cards.map((p) => card({
    title: p.title,
    value: p.main,
    sub: p.sub,
    tag: p.tag,
    kind: p.kind,
  })).join('');
  renderTable(document.getElementById('dailyScenarioTable'), [
    ['fill_rate', '仮想約定率'], ['opportunities', '想定機会'], ['effective', '到達想定'], ['needed_net', '1回必要Net'], ['needed_pct', '1回あたり必要値幅'], ['needed_win', '必要勝率'], ['win_label', '必要勝率判定'], ['movement_ratio', '値動き比'], ['reality', '現実度'], ['memo', '理由'],
  ], data.scenarios.map((r) => ({
    fill_rate: `${Number(r.fill_rate).toFixed(0)}%`,
    opportunities: `${r.opportunities}回`,
    effective: `${r.effective}回`,
    needed_net: yen(r.needed_net_per_trade, 2),
    needed_pct: pct(r.needed_move_pct, 3),
    needed_win: neededWinDisplay(r.needed_win_rate_pct, 1),
    win_label: neededWinLabel(r.needed_win_rate_pct),
    movement_ratio: r.movement_ratio === null ? '比較不可' : `${Number(r.movement_ratio).toFixed(2)}倍`,
    reality: r.reality,
    memo: r.memo,
  })));
}


function renderDailyVirtualFill(data) {
  const memoEl = document.getElementById('dailyVirtualFillMemo');
  const tableEl = document.getElementById('dailyVirtualFillTable');
  if (!memoEl || !tableEl) return;
  const meta = data.virtual_fill_history_meta || {};
  memoEl.textContent = data.virtual_fill_history_note || data.virtual_fill_rate_note || '仮想約定率の履歴試算はまだ計算していません。';
  const rows = [
    { item: '使用した仮想約定率', value: pct(data.virtual_fill_rate_pct_used, 1) },
    { item: '履歴試算の状態', value: meta.enabled === false ? 'OFF' : (meta.used_for_daily_goal ? '日次目標に使用' : '手入力値を代替使用') },
    { item: '通貨 / 足', value: `${meta.symbol || elValue('dailySymbol', 'BTCJPY')} / ${meta.interval || '1m'}` },
    { item: '参照期間', value: meta.reference_period_text || '—' },
    { item: '参照日数', value: meta.reference_days ? `直近${meta.reference_days}日` : '—' },
    { item: '指値方向', value: meta.side_label || '—' },
    { item: '指値距離', value: pct(meta.limit_distance_pct, 3) },
    { item: '現在価格ベースの仮想指値', value: meta.current_limit_price === undefined ? '—' : yen(meta.current_limit_price, 2) },
    { item: '参照足数', value: meta.referenced_row_count === undefined ? '—' : `${meta.referenced_row_count}本` },
    { item: '価格到達足数', value: meta.matched_row_count === undefined ? '—' : `${meta.matched_row_count}本` },
    { item: '仮想約定率', value: data.virtual_fill_history_rate_pct === null || data.virtual_fill_history_rate_pct === undefined ? '—' : pct(data.virtual_fill_history_rate_pct, 1) },
    { item: 'データ品質', value: meta.quality_label || '—' },
    { item: '未確定足', value: meta.include_unclosed_candle ? '含む' : '除外' },
    { item: '参照元', value: meta.source || '—' },
  ];
  renderTable(tableEl, [['item', '項目'], ['value', '値']], rows);
}

function renderDailyOccurrence(data) {
  const memoEl = document.getElementById('dailyOccurrenceMemo');
  const tableEl = document.getElementById('dailyOccurrenceTable');
  if (!memoEl || !tableEl) return;
  const meta = data.required_move_occurrence_meta || {};
  const files = Array.isArray(meta.referenced_files) ? meta.referenced_files : [];
  memoEl.textContent = data.required_move_occurrence_note || '必要値幅の出現率はまだ計算していません。';
  const rows = [
    { item: '参照モード', value: meta.reference_scope_label || '分析用1分足キャッシュ' },
    { item: '通貨 / 足', value: `${meta.symbol || elValue('dailySymbol', 'BTCJPY')} / ${meta.interval || '1m'}` },
    { item: '参照日数', value: meta.reference_days ? `直近${meta.reference_days}日` : '—' },
    { item: '判定窓', value: meta.window_minutes ? `${meta.window_minutes}分以内` : '—' },
    { item: '判定方向', value: meta.direction_label || '—' },
    { item: '参照足数', value: meta.referenced_row_count === undefined ? '—' : `${meta.referenced_row_count}本` },
    { item: '判定対象窓数', value: meta.window_count === undefined ? '—' : `${meta.window_count}窓` },
    { item: '参照期間', value: meta.reference_period_text || '—' },
    { item: '日次目標利益', value: data.target_profit_jpy === undefined ? '—' : yen(data.target_profit_jpy, 0) },
    { item: '想定成功回数', value: data.expected_success_count ? `${data.expected_success_count}回` : '—' },
    { item: '1回あたり目標利益', value: data.per_trade_target_jpy === undefined ? '—' : yen(data.per_trade_target_jpy, 2) },
    { item: '1回あたり必要値幅', value: pct(meta.required_move_pct ?? data.required_move_occurrence_required_pct, 3) },
    { item: '必要値幅を満たした窓数', value: meta.matched_window_count === undefined ? (meta.matched_row_count === undefined ? '—' : `${meta.matched_row_count}本`) : `${meta.matched_window_count}窓` },
    { item: '必要値幅出現率', value: pct(data.required_move_occurrence_rate_pct, 1) },
    { item: 'データ品質', value: meta.quality_label || '—' },
    { item: '参照元', value: meta.source || '—' },
    { item: '使用ファイル名', value: files.length ? files.slice(0, 8).join('\n') + (files.length > 8 ? `\nほか${files.length - 8}件` : '') : 'DBまたは分析キャッシュ' },
  ];
  renderTable(tableEl, [['item', '項目'], ['value', '値']], rows);
}

async function loadDailyReports() {
  const data = await getJson('/api/daily-goal-reports?limit=20');
  document.getElementById('dailyReportsMemo').textContent = `保存件数: ${data.count} / 表示: ${data.rows.length} / ${data.file}`;
  const rows = (data.rows || []).map((row) => ({
    saved_at: String(row.saved_at_jst || '').replace('T', ' ').replace('+09:00', ' JST'),
    template: row.strategy_template || '—',
    symbol: row.symbol || '—',
    target: yen(row.target_profit_jpy, 0),
    capital: yen(row.capital_jpy, 0),
    cost: pct(row.roundtrip_cost_pct, 2),
    fill: pct(row.virtual_fill_rate_pct_used, 1),
    width: row.required_move_occurrence_rate_pct === undefined || row.required_move_occurrence_rate_pct === '' ? '—' : pct(row.required_move_occurrence_rate_pct, 1),
    need: pct(row.needed_move_pct, 3),
    win: neededWinDisplay(row.needed_win_rate_pct, 1),
    reality: row.reality || '—',
  }));
  renderTable(document.getElementById('dailyReportsTable'), [
    ['saved_at', '保存時刻'],
    ['template', 'テンプレ'],
    ['symbol', '通貨'],
    ['target', '目標'],
    ['capital', '資金'],
    ['cost', '往復コスト'],
    ['fill', '仮想約定率'],
    ['width', '値幅出現率'],
    ['need', '1回あたり必要値幅'],
    ['win', '必要勝率'],
    ['reality', '現実度'],
  ], rows);
}

async function saveDailyReport() {
  const result = await postJson('/api/save-daily-goal-report', buildDailyPayload());
  document.getElementById('dailyReportsMemo').textContent = `${result.message} / ${result.file}`;
  await loadDailyReports();
}

async function clearDailyReports() {
  const result = await postJson('/api/clear-daily-goal-reports', {});
  document.getElementById('dailyReportsMemo').textContent = result.message;
  await loadDailyReports();
}

function applyDailyTemplate() {
  const templateId = elValue('dailyTemplate', 'market_priority');
  const template = DAILY_TEMPLATES[templateId] || DAILY_TEMPLATES.custom;
  setValueIfExists('dailyFillRate', String(template.fillRate));
  setValueIfExists('dailyStopPct', String(template.stopPct));
  setValueIfExists('dailyCostPct', String(template.costPct));
  setValueIfExists('dailyCancelRates', template.cancelRates);
  // テンプレートで仮想約定率は変えますが、必要値幅の履歴確認ON/OFFはユーザー設定を維持します。
  document.getElementById('dailyTemplateMemo').textContent = `${template.label}: ${template.memo}（売買推奨ではなく条件テンプレートです）`;
}

function setDailyTemplateTab(templateId) {
  const hidden = document.getElementById('dailyTemplate');
  hidden.value = templateId;
  document.querySelectorAll('#dailyTemplateTabs .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.template === templateId);
  });
}

function setupNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.section;
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(section).classList.add('active');
      document.getElementById('pageTitle').textContent = titles[section][0];
      document.getElementById('pageSubtitle').textContent = titles[section][1];
      if (section === 'summary') loadSummaryMiniCharts().catch(console.error);
      if (section === 'chart') loadChart().catch(console.error);
    });
  });
}

async function refreshAll() {
  await loadStatus();
  await loadSummary();
  await loadSummaryMiniCharts();
  await loadImpact();
  await loadAlertPreview();
  await loadApiReadiness();
  await loadDbStatus();
  await loadAnalysisCacheStatus().catch(console.error);
}

document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  document.getElementById('refreshAll').addEventListener('click', refreshAll);
  document.getElementById('fetchPrices').addEventListener('click', () => fetchPrices({ source: 'manual' }));
  document.getElementById('reloadSummaryMiniCharts').addEventListener('click', loadSummaryMiniCharts);
  document.getElementById('reloadImpact').addEventListener('click', loadImpact);
  document.getElementById('reloadAlertPreview').addEventListener('click', loadAlertPreview);
  document.getElementById('clearAlertHistory').addEventListener('click', clearAlertHistory);
  document.getElementById('reloadApiReadiness').addEventListener('click', loadApiReadiness);
  document.getElementById('reloadDbStatus').addEventListener('click', loadDbStatus);
  document.getElementById('reloadAnalysisCacheStatus').addEventListener('click', loadAnalysisCacheStatus);
  document.getElementById('ensureAnalysisCache').addEventListener('click', ensureAnalysisCache);
  document.getElementById('analysisCacheDays').addEventListener('change', loadAnalysisCacheStatus);
  document.getElementById('analysisCacheSymbol').addEventListener('change', loadAnalysisCacheStatus);
  document.getElementById('reloadChart').addEventListener('click', reloadChartWithDownloadConfirm);
  document.getElementById('downloadHistory').addEventListener('click', downloadHistory);
  document.getElementById('updateHistoryToNow').addEventListener('click', updateHistoryToNow);
  document.getElementById('chartSymbol').addEventListener('change', loadChart);
  document.getElementById('chartSource').addEventListener('change', loadChart);
  document.getElementById('chartInterval').addEventListener('change', loadChartRangeFromKlines);
  document.getElementById('chartRange').addEventListener('change', loadChartRangeFromKlines);
  document.getElementById('historyDate').addEventListener('change', loadChart);
  document.getElementById('historyStartHour').addEventListener('change', loadChart);
  document.getElementById('historyEndHour').addEventListener('change', loadChart);
  document.getElementById('calcTrade').addEventListener('click', calcTrade);
  document.getElementById('tradeCostPct').addEventListener('input', syncRoundtripCostFromTrade);
  document.getElementById('applyDailyTemplate').addEventListener('click', applyDailyTemplate);
  document.querySelectorAll('#dailyTemplateTabs .seg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setDailyTemplateTab(btn.dataset.template);
      applyDailyTemplate();
      await calcDaily();
    });
  });
  document.getElementById('calcDaily').addEventListener('click', calcDaily);
  document.getElementById('saveDailyReport').addEventListener('click', saveDailyReport);
  document.getElementById('reloadDailyReports').addEventListener('click', loadDailyReports);
  document.getElementById('clearDailyReports').addEventListener('click', clearDailyReports);
  document.getElementById('historyDate').value = todayJstDateText();
  setValueIfExists('dailyOccurrenceStartDate', todayJstDateText());
  setValueIfExists('dailyOccurrenceEndDate', todayJstDateText());
  setCheckedIfExists('dailyOccurrenceEnabled', true);
  setupAutoCurrentUpdate();
  setDailyTemplateTab(document.getElementById('dailyTemplate').value || 'market_priority');
  applyDailyTemplate();
  syncRoundtripCostFromTrade();
  document.getElementById('alertWindowMinutes').addEventListener('change', loadAlertPreview);
  document.getElementById('alertMode').addEventListener('change', loadAlertPreview);
  document.getElementById('alertRollingMinPoints').addEventListener('change', loadAlertPreview);
  document.getElementById('alertRisingRatio').addEventListener('change', loadAlertPreview);
  document.getElementById('alertThresholdPct').addEventListener('change', loadAlertPreview);
  document.getElementById('alertThresholdBTC').addEventListener('change', loadAlertPreview);
  document.getElementById('alertThresholdETH').addEventListener('change', loadAlertPreview);
  document.getElementById('alertSaveHistory').addEventListener('change', loadAlertPreview);
  document.querySelectorAll('.alertSymbol').forEach((el) => el.addEventListener('change', loadAlertPreview));
  refreshAll().then(loadChart).then(loadDailyReports).catch(console.error);
});
