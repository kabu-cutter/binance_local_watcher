const titles = {
  summary: ['サマリー', 'Electron main process が公開データ取得・履歴・計算を担当します。'],
  chart: ['チャート', 'Electron main process で履歴または公開klineを読み、rendererでSVGチャートを描きます。'],
  impact: ['値動き影響', '保有していた場合の金額感覚を確認します。'],
  trade: ['損益プレビュー', '実注文なしで投入額・コスト・Net P/Lを概算します。'],
  daily: ['日次目標', '今日の目標額・資金・機会回数から条件を整理します。'],
  api: ['API・準備度', 'Electron内のローカルエンジン境界、安全範囲、禁止機能を確認します。'],
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
    if (url.pathname === '/api/summary') return window.blw.api.getSummary();
    if (url.pathname === '/api/impact') return window.blw.api.getImpact(query);
    if (url.pathname === '/api/chart') return window.blw.api.getChart(query);
    throw new Error(`未対応のローカルエンジンGET: ${url.pathname}`);
  }
  throw new Error('Electron preload の window.blw.api が見つかりません。npm start から起動してください。');
}
async function postJson(path, body) {
  if (window.blw?.api) {
    if (path === '/api/fetch-prices') return window.blw.api.fetchPrices();
    if (path === '/api/trade-preview') return window.blw.api.tradePreview(body || {});
    if (path === '/api/daily-goal') return window.blw.api.dailyGoal(body || {});
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
  } catch (e) {
    pill.textContent = 'Local Engine NG';
    pill.className = 'status-pill bad';
    document.getElementById('apiBackendText').textContent = `ローカルエンジンを呼び出せません。\n${e.message}`;
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
  const data = await getJson(`/api/chart?symbol=${encodeURIComponent(symbol)}&source=${encodeURIComponent(source)}&interval=${encodeURIComponent(interval)}&limit=160`);
  renderChart(data);
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

async function calcDaily() {
  const payload = {
    target_profit_jpy: Number(document.getElementById('dailyTarget').value),
    capital_jpy: Number(document.getElementById('dailyCapital').value),
    min_opportunities: Number(document.getElementById('dailyMinOpp').value),
    max_opportunities: Number(document.getElementById('dailyMaxOpp').value),
    stop_loss_pct: Number(document.getElementById('dailyStopPct').value),
    cancel_rates_text: document.getElementById('dailyCancelRates').value,
    roundtrip_cost_pct: 0.28,
  };
  const data = await postJson('/api/daily-goal', payload);
  document.getElementById('dailySuggestion').textContent = data.suggestion;
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
    ['cancel_rate', '未約定率'], ['opportunities', '機会'], ['effective', '有効約定'], ['needed_net', '1回必要Net'], ['needed_pct', '必要変動率'], ['risk', '準備感'], ['memo', 'メモ'],
  ], data.scenarios.map((r) => ({
    cancel_rate: `${r.cancel_rate}%`,
    opportunities: `${r.opportunities}回`,
    effective: `${r.effective}回`,
    needed_net: yen(r.needed_net_per_trade, 2),
    needed_pct: pct(r.needed_move_pct, 3),
    risk: r.risk,
    memo: r.memo,
  })));
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
}

document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  document.getElementById('refreshAll').addEventListener('click', refreshAll);
  document.getElementById('fetchPrices').addEventListener('click', fetchPrices);
  document.getElementById('reloadImpact').addEventListener('click', loadImpact);
  document.getElementById('reloadChart').addEventListener('click', loadChart);
  document.getElementById('chartSymbol').addEventListener('change', loadChart);
  document.getElementById('chartSource').addEventListener('change', loadChart);
  document.getElementById('calcTrade').addEventListener('click', calcTrade);
  document.getElementById('calcDaily').addEventListener('click', calcDaily);
  refreshAll().then(loadChart).catch(console.error);
});
