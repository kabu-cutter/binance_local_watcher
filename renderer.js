const titles = {
  summary: ['サマリー', 'Electron main process が公開データ取得・履歴・計算を担当します。'],
  chart: ['チャート', 'Electron main process で履歴または公開klineを読み、rendererでSVGチャートを描きます。'],
  impact: ['値動き影響', '保有していた場合の金額感覚を確認します。'],
  trade: ['損益プレビュー', '実注文なしで投入額・コスト・Net P/Lを概算します。'],
  daily: ['日次目標', '約定率・勝率・値動きから今日の現実度を整理します。'],
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

async function getJson(path) {
  if (window.blw?.api) {
    const url = new URL(path, 'http://local-engine');
    const query = Object.fromEntries(url.searchParams.entries());
    if (url.pathname === '/api/status') return window.blw.api.getStatus();
    if (url.pathname === '/api/capabilities') return window.blw.api.getCapabilities();
    if (url.pathname === '/api/contract') return window.blw.api.getContract();
    if (url.pathname === '/api/api-readiness') return window.blw.api.getApiReadiness();
    if (url.pathname === '/api/summary') return window.blw.api.getSummary();
    if (url.pathname === '/api/impact') return window.blw.api.getImpact(query);
    if (url.pathname === '/api/alert-preview') return window.blw.api.getAlertPreview(query);
    if (url.pathname === '/api/alert-history') return window.blw.api.getAlertHistory(query);
    if (url.pathname === '/api/daily-goal-reports') return window.blw.api.getDailyGoalReports(query);
    if (url.pathname === '/api/chart') return window.blw.api.getChart(query);
    throw new Error(`未対応のローカルエンジンGET: ${url.pathname}`);
  }
  throw new Error('Electron preload の window.blw.api が見つかりません。npm start から起動してください。');
}
async function postJson(path, body) {
  if (window.blw?.api) {
    if (path === '/api/fetch-prices') return window.blw.api.fetchPrices();
    if (path === '/api/download-history') return window.blw.api.downloadHistory(body || {});
    if (path === '/api/update-history-to-now') return window.blw.api.updateHistoryToNow(body || {});
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
  const interval = document.getElementById('chartInterval').value;
  const range = elValue('chartRange', '24h');
  const date = document.getElementById('historyDate').value;
  const startHour = document.getElementById('historyStartHour').value;
  const endHour = document.getElementById('historyEndHour').value;
  const data = await getJson(`/api/chart?symbol=${encodeURIComponent(symbol)}&source=${encodeURIComponent(source)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&date=${encodeURIComponent(date)}&start_hour=${encodeURIComponent(startHour)}&end_hour=${encodeURIComponent(endHour)}&limit=520`);
  renderChart(data);
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
  const occurrenceInterval = elValue('dailyOccurrenceInterval', '1m');
  return {
    strategy_template: elValue('dailyTemplate', 'market_priority'),
    symbol: elValue('dailySymbol', 'BTCJPY'),
    target_profit_jpy: elNumber('dailyTarget', 0),
    capital_jpy: elNumber('dailyCapital', 1),
    min_opportunities: elNumber('dailyMinOpp', 1),
    max_opportunities: elNumber('dailyMaxOpp', 1),
    stop_loss_pct: elNumber('dailyStopPct', 0),
    roundtrip_cost_pct: linkedCost,
    cancel_rates_text: elValue('dailyCancelRates', '10,30,50'),
    virtual_fill_rate_pct: elNumber('dailyFillRate', 70),
    // trueなら、約定率ではなく「必要値幅の出現率」を別計算します。
    virtual_fill_rate_auto: elChecked('dailyOccurrenceEnabled', true),
    occurrence_interval: occurrenceInterval,
    occurrence_scope: elValue('dailyOccurrenceScope', 'latest'),
    occurrence_start_date: elValue('dailyOccurrenceStartDate', ''),
    occurrence_end_date: elValue('dailyOccurrenceEndDate', ''),
    occurrence_start_hour: elNumber('dailyOccurrenceStartHour', 0),
    occurrence_end_hour: elNumber('dailyOccurrenceEndHour', 24),
    // 旧API互換用。日次目標側の参照設定であり、チャート/履歴DL欄とは切り離しています。
    interval: occurrenceInterval,
  };
}

async function calcDaily() {
  const templateId = document.getElementById('dailyTemplate').value;
  const errorMemo = document.getElementById('dailyErrorMemo');
  const payload = buildDailyPayload();
  const errors = [];
  if (!Number.isFinite(payload.target_profit_jpy) || payload.target_profit_jpy < 0) errors.push('日次目標利益は0以上で入力してください。');
  if (!Number.isFinite(payload.capital_jpy) || payload.capital_jpy <= 0) errors.push('資金 / 主投入額は0より大きい値にしてください。');
  if (!Number.isFinite(payload.min_opportunities) || payload.min_opportunities < 1) errors.push('最小機会回数は1以上にしてください。');
  if (!Number.isFinite(payload.max_opportunities) || payload.max_opportunities < payload.min_opportunities) errors.push('最大機会回数は最小機会回数以上にしてください。');
  if (!Number.isFinite(payload.stop_loss_pct) || payload.stop_loss_pct < 0) errors.push('損切り逆行率は0以上で入力してください。');
  if (!Number.isFinite(payload.roundtrip_cost_pct) || payload.roundtrip_cost_pct < 0) errors.push('往復コストは0以上で入力してください。');
  if (!Number.isFinite(payload.virtual_fill_rate_pct) || payload.virtual_fill_rate_pct < 0 || payload.virtual_fill_rate_pct > 100) errors.push('仮想約定率（手入力）は0〜100%で入力してください。');
  if (errors.length) {
    errorMemo.textContent = `入力エラー: ${errors.join(' / ')}`;
    return;
  }
  errorMemo.textContent = '';
  const data = await postJson('/api/daily-goal', payload);
  // 仮想約定率は手入力/テンプレート値を維持します。履歴確認は「必要値幅の出現率」として別表示します。
  document.getElementById('dailyCostPct').value = Number(data.roundtrip_cost_pct || payload.roundtrip_cost_pct).toFixed(2);
  document.getElementById('dailyTemplateMemo').textContent = data.strategy_template_note
    || 'テンプレートは売買シグナルではなく、条件比較の補助です。';
  document.getElementById('dailySuggestion').textContent = data.suggestion;
  document.getElementById('dailyDiagnosticSummary').textContent = data.diagnostic_summary || '総合診断はまだありません。';
  document.getElementById('dailyFillRateMemo').textContent = data.virtual_fill_rate_note
    || '仮想約定率は手入力値またはテンプレート値です。必要値幅の履歴確認とは別扱いです。';
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
    ['fill_rate', '仮想約定率'], ['opportunities', '機会'], ['effective', '約定'], ['needed_net', '1回必要Net'], ['needed_pct', '必要変動率'], ['needed_win', '必要勝率'], ['movement_ratio', '値動き比'], ['reality', '現実度'], ['memo', '理由'],
  ], data.scenarios.map((r) => ({
    fill_rate: `${Number(r.fill_rate).toFixed(0)}%`,
    opportunities: `${r.opportunities}回`,
    effective: `${r.effective}回`,
    needed_net: yen(r.needed_net_per_trade, 2),
    needed_pct: pct(r.needed_move_pct, 3),
    needed_win: pct(r.needed_win_rate_pct, 1),
    movement_ratio: r.movement_ratio === null ? '比較不可' : `${Number(r.movement_ratio).toFixed(2)}倍`,
    reality: r.reality,
    memo: r.memo,
  })));
}

function renderDailyOccurrence(data) {
  const memoEl = document.getElementById('dailyOccurrenceMemo');
  const tableEl = document.getElementById('dailyOccurrenceTable');
  if (!memoEl || !tableEl) return;
  const meta = data.required_move_occurrence_meta || {};
  const files = Array.isArray(meta.referenced_files) ? meta.referenced_files : [];
  memoEl.textContent = data.required_move_occurrence_note || '必要値幅の出現率はまだ計算していません。';
  const rows = [
    { item: '参照モード', value: meta.reference_scope_label || '—' },
    { item: '通貨 / 足', value: `${meta.symbol || elValue('dailySymbol', 'BTCJPY')} / ${meta.interval || elValue('dailyOccurrenceInterval', '1m')}` },
    { item: '候補ファイル数', value: meta.selected_file_count === undefined ? '—' : `${meta.selected_file_count}件` },
    { item: '使用ファイル数', value: meta.referenced_file_count === undefined ? '—' : `${meta.referenced_file_count}件` },
    { item: '参照足数', value: meta.referenced_row_count === undefined ? '—' : `${meta.referenced_row_count}本` },
    { item: '参照期間', value: meta.reference_period_text || '—' },
    { item: '必要値幅', value: pct(meta.required_move_pct ?? data.required_move_occurrence_required_pct, 3) },
    { item: '必要値幅を満たした足数', value: meta.matched_row_count === undefined ? '—' : `${meta.matched_row_count}本` },
    { item: '必要値幅出現率', value: pct(data.required_move_occurrence_rate_pct, 1) },
    { item: '使用ファイル名', value: files.length ? files.slice(0, 8).join('\n') + (files.length > 8 ? `\nほか${files.length - 8}件` : '') : '—' },
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
    win: pct(row.needed_win_rate_pct, 1),
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
    ['need', '必要変動率'],
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
  document.getElementById('reloadChart').addEventListener('click', loadChart);
  document.getElementById('downloadHistory').addEventListener('click', downloadHistory);
  document.getElementById('updateHistoryToNow').addEventListener('click', updateHistoryToNow);
  document.getElementById('chartSymbol').addEventListener('change', loadChart);
  document.getElementById('chartSource').addEventListener('change', loadChart);
  document.getElementById('chartInterval').addEventListener('change', loadChart);
  document.getElementById('chartRange').addEventListener('change', loadChart);
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
