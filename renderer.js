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
  try {
    const r = await getJson('/api/api-readiness');
    memo.textContent = r.note || '読み取り専用チェック結果です。';
    const rows = [
      { item: '公開API到達', value: r.public_api_ok ? 'ok' : 'ng', detail: r.public_api_error || '—' },
      { item: 'API Key', value: r.has_api_key ? 'set' : 'unset', detail: r.api_key_source || 'none' },
      { item: 'API Secret', value: r.has_api_secret ? 'set' : 'unset', detail: r.api_secret_source || 'none' },
      { item: '署名API認証', value: r.auth_api_ok ? 'ok' : 'ng', detail: r.auth_api_error || '—' },
      { item: '口座タイプ', value: r.account_type || '—', detail: r.can_trade === null ? '—' : `canTrade=${r.can_trade}` },
      { item: '手数料取得準備', value: r.fee_fetch_ready ? 'ready' : 'not-ready', detail: '保存処理なし' },
    ];
    renderTable(document.getElementById('apiReadinessTable'), [
      ['item', '項目'],
      ['value', '状態'],
      ['detail', '詳細'],
    ], rows);
  } catch (e) {
    memo.textContent = `API準備度の取得に失敗: ${e.message}`;
    renderTable(document.getElementById('apiReadinessTable'), [['item', '項目'], ['value', '状態'], ['detail', '詳細']], []);
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

async function fetchPrices() {
  const btn = document.getElementById('fetchPrices');
  const old = btn.textContent;
  btn.textContent = '取得中...';
  btn.disabled = true;
  try {
    const data = await postJson('/api/fetch-prices', {});
    document.getElementById('summaryMemo').textContent = `${data.message}\n保存先: ${data.history_file}${data.errors?.length ? `\nエラー: ${data.errors.join(' / ')}` : ''}`;
    await loadStatus();
    await loadSummary();
    await loadImpact();
    await loadChart();
  } catch (e) {
    document.getElementById('summaryMemo').textContent = `価格取得に失敗しました。\n${e.message}`;
  } finally {
    btn.textContent = old;
    btn.disabled = false;
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
  const data = await getJson(`/api/alert-preview?window_minutes=${encodeURIComponent(windowMinutes)}&alert_mode=${encodeURIComponent(alertMode)}&rolling_min_points=${encodeURIComponent(rollingMinPoints)}&threshold_pct=${encodeURIComponent(thresholdPct)}&symbols=${encodeURIComponent(selectedSymbols.join(','))}&thresholds=${encodeURIComponent(thresholdsQuery)}&save_history=${encodeURIComponent(saveHistory)}`);
  document.getElementById('alertPreviewMemo').textContent = `${data.message} / mode ${data.alert_mode} / 対象: ${(data.symbols || selectedSymbols).join(', ')} / 窓 ${data.window_minutes}分 / しきい値 ${pct(data.threshold_pct, 2)} / 履歴保存 ${data.history_saved || 0}件 / データ元: ${data.source}`;
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
  document.getElementById('chartMeta').textContent = `${data.symbol} / ${data.rows}点 / ${data.source} / ${data.message} 価格範囲: ${yen(data.min_price)} - ${yen(data.max_price)}${errorText}`;
}

async function loadChart() {
  const symbol = document.getElementById('chartSymbol').value;
  const source = document.getElementById('chartSource').value;
  const interval = document.getElementById('chartInterval').value;
  const date = document.getElementById('historyDate').value;
  const startHour = document.getElementById('historyStartHour').value;
  const endHour = document.getElementById('historyEndHour').value;
  const data = await getJson(`/api/chart?symbol=${encodeURIComponent(symbol)}&source=${encodeURIComponent(source)}&interval=${encodeURIComponent(interval)}&date=${encodeURIComponent(date)}&start_hour=${encodeURIComponent(startHour)}&end_hour=${encodeURIComponent(endHour)}&limit=160`);
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

function buildDailyPayload() {
  return {
    strategy_template: document.getElementById('dailyTemplate').value,
    symbol: document.getElementById('dailySymbol').value,
    target_profit_jpy: Number(document.getElementById('dailyTarget').value),
    capital_jpy: Number(document.getElementById('dailyCapital').value),
    min_opportunities: Number(document.getElementById('dailyMinOpp').value),
    max_opportunities: Number(document.getElementById('dailyMaxOpp').value),
    stop_loss_pct: Number(document.getElementById('dailyStopPct').value),
    roundtrip_cost_pct: Number(document.getElementById('dailyCostPct').value),
    cancel_rates_text: document.getElementById('dailyCancelRates').value,
    virtual_fill_rate_pct: Number(document.getElementById('dailyFillRate').value),
    virtual_fill_rate_auto: document.getElementById('dailyFillRateAuto').checked,
    interval: document.getElementById('historyInterval').value,
    date: document.getElementById('historyDate').value,
    start_hour: Number(document.getElementById('historyStartHour').value),
    end_hour: Number(document.getElementById('historyEndHour').value),
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
  if (!Number.isFinite(payload.virtual_fill_rate_pct) || payload.virtual_fill_rate_pct < 0 || payload.virtual_fill_rate_pct > 100) errors.push('仮想約定率は0〜100%で入力してください。');
  if (errors.length) {
    errorMemo.textContent = `入力エラー: ${errors.join(' / ')}`;
    return;
  }
  errorMemo.textContent = '';
  const data = await postJson('/api/daily-goal', payload);
  if (Number.isFinite(Number(data.virtual_fill_rate_pct_used))) {
    document.getElementById('dailyFillRate').value = Number(data.virtual_fill_rate_pct_used).toFixed(0);
  }
  document.getElementById('dailyCostPct').value = Number(data.roundtrip_cost_pct || payload.roundtrip_cost_pct).toFixed(2);
  document.getElementById('dailyTemplateMemo').textContent = data.strategy_template_note
    || 'テンプレートは売買シグナルではなく、条件比較の補助です。';
  document.getElementById('dailySuggestion').textContent = data.suggestion;
  document.getElementById('dailyDiagnosticSummary').textContent = data.diagnostic_summary || '総合診断はまだありません。';
  document.getElementById('dailyFillRateMemo').textContent = data.virtual_fill_rate_note
    || '仮想約定率は手入力値を使っています。';
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
    ['fill_rate', '約定率'], ['opportunities', '機会'], ['effective', '約定'], ['needed_pct', '必要変動率'], ['needed_win', '必要勝率'], ['movement_ratio', '値動き比'], ['reality', '現実度'],
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
  const templateId = document.getElementById('dailyTemplate').value;
  const template = DAILY_TEMPLATES[templateId];
  if (!template) return;
  document.getElementById('dailyFillRate').value = String(template.fillRate);
  document.getElementById('dailyStopPct').value = String(template.stopPct);
  document.getElementById('dailyCostPct').value = String(template.costPct);
  document.getElementById('dailyCancelRates').value = template.cancelRates;
  document.getElementById('dailyFillRateAuto').checked = template.autoFill;
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
      if (section === 'chart') loadChart().catch(console.error);
    });
  });
}

async function refreshAll() {
  await loadStatus();
  await loadSummary();
  await loadImpact();
  await loadAlertPreview();
  await loadApiReadiness();
}

document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  document.getElementById('refreshAll').addEventListener('click', refreshAll);
  document.getElementById('fetchPrices').addEventListener('click', fetchPrices);
  document.getElementById('reloadImpact').addEventListener('click', loadImpact);
  document.getElementById('reloadAlertPreview').addEventListener('click', loadAlertPreview);
  document.getElementById('clearAlertHistory').addEventListener('click', clearAlertHistory);
  document.getElementById('reloadApiReadiness').addEventListener('click', loadApiReadiness);
  document.getElementById('reloadChart').addEventListener('click', loadChart);
  document.getElementById('downloadHistory').addEventListener('click', downloadHistory);
  document.getElementById('chartSymbol').addEventListener('change', loadChart);
  document.getElementById('chartSource').addEventListener('change', loadChart);
  document.getElementById('chartInterval').addEventListener('change', loadChart);
  document.getElementById('historyDate').addEventListener('change', loadChart);
  document.getElementById('historyStartHour').addEventListener('change', loadChart);
  document.getElementById('historyEndHour').addEventListener('change', loadChart);
  document.getElementById('calcTrade').addEventListener('click', calcTrade);
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
  setDailyTemplateTab(document.getElementById('dailyTemplate').value || 'market_priority');
  applyDailyTemplate();
  document.getElementById('alertWindowMinutes').addEventListener('change', loadAlertPreview);
  document.getElementById('alertMode').addEventListener('change', loadAlertPreview);
  document.getElementById('alertRollingMinPoints').addEventListener('change', loadAlertPreview);
  document.getElementById('alertThresholdPct').addEventListener('change', loadAlertPreview);
  document.getElementById('alertThresholdBTC').addEventListener('change', loadAlertPreview);
  document.getElementById('alertThresholdETH').addEventListener('change', loadAlertPreview);
  document.getElementById('alertSaveHistory').addEventListener('change', loadAlertPreview);
  document.querySelectorAll('.alertSymbol').forEach((el) => el.addEventListener('change', loadAlertPreview));
  refreshAll().then(loadChart).then(loadDailyReports).catch(console.error);
});
