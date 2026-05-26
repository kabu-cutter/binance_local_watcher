const DEFAULT_AMOUNTS = [1000, 10000, 100000];
const DEFAULT_CANCEL_RATES = [10, 30, 50, 70];
const DEFAULT_ROUNDTRIP_COST_PCT = 0.28;

function safeFloat(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeInt(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function parsePositiveNumberList(text, fallback = DEFAULT_AMOUNTS) {
  const values = String(text || '')
    .replace(/、/g, ',')
    .replace(/円/g, '')
    .replace(/%/g, '')
    .split(',')
    .map((part) => safeFloat(part.trim(), NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? values : fallback;
}

function parseCancelRates(text) {
  const values = [];
  parsePositiveNumberList(text, DEFAULT_CANCEL_RATES).forEach((value) => {
    const clamped = Math.max(0, Math.min(95, value));
    if (!values.includes(clamped)) values.push(clamped);
  });
  return values.length ? values : DEFAULT_CANCEL_RATES;
}

function riskLabel(neededPct) {
  if (neededPct < 0.3) return '軽め';
  if (neededPct < 0.8) return '中くらい';
  if (neededPct < 1.5) return '重め';
  return 'かなり重い';
}

function formatSignedPct(value, digits = 4) {
  const number = safeFloat(value);
  return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}%`;
}

function buildSymbolSummaries({ symbols, sourceData, mockPrices }) {
  return symbols.map((symbol) => {
    const item = sourceData[symbol] || mockPrices[symbol];
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
      note: `短期 ${status} / ${formatSignedPct(shortPct, 4)}`,
      timestamp: item.timestamp || '',
    };
  });
}

function calculateImpactRows({ summaries, amountsText }) {
  const amounts = parsePositiveNumberList(amountsText, DEFAULT_AMOUNTS);
  const rows = [];
  for (const summary of summaries) {
    const price = safeFloat(summary.price_jpy);
    for (const amount of amounts) {
      const quantity = price ? amount / price : 0;
      rows.push({
        symbol: summary.symbol,
        amount_jpy: amount,
        price_jpy: price,
        quantity,
        prev_impact_yen: quantity * safeFloat(summary.prev_diff_yen),
        short_impact_yen: quantity * safeFloat(summary.short_diff_yen),
      });
    }
  }
  return rows;
}

function calculateTradePreview({ body = {}, summaries, mockPrices, symbols }) {
  const prices = Object.fromEntries(summaries.map((summary) => [summary.symbol, summary.price_jpy]));
  const symbol = symbols.includes(body.symbol) ? body.symbol : symbols[0];
  const amount = Math.max(0, safeFloat(body.amount_jpy));
  const price = safeFloat(prices[symbol], mockPrices[symbol].price);
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

function calculateDailyGoal(body = {}) {
  const target = Math.max(0, safeFloat(body.target_profit_jpy));
  const capital = Math.max(1, safeFloat(body.capital_jpy, 1));
  const minOpp = Math.max(1, safeInt(body.min_opportunities, 1));
  const maxOpp = Math.max(minOpp, safeInt(body.max_opportunities, minOpp));
  const stopPct = Math.max(0, safeFloat(body.stop_loss_pct));
  const cancelRates = parseCancelRates(body.cancel_rates_text);
  const costPct = Math.max(0, safeFloat(body.roundtrip_cost_pct, DEFAULT_ROUNDTRIP_COST_PCT));
  const targetPct = (target / capital) * 100;
  const onePct = targetPct + costPct;
  const minPct = (target / capital / minOpp) * 100 + costPct;
  const maxPct = (target / capital / maxOpp) * 100 + costPct;
  const lossPerStop = -(capital * (stopPct + costPct) / 100);
  const suggestion = [
    `今日の目標は ${target.toLocaleString('ja-JP')}円、資金/主投入額は ${capital.toLocaleString('ja-JP')}円です。`,
    `この日次目標は往復コスト${costPct.toFixed(2)}%前提で計算しています。`,
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
  return {
    suggestion,
    plan_cards: planCards,
    scenarios,
    roundtrip_cost_pct: costPct,
  };
}

function summarizeChartPoints(points) {
  const prices = points.map((point) => safeFloat(point.price, NaN)).filter(Number.isFinite);
  return {
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    rows: points.length,
  };
}

module.exports = {
  safeFloat,
  safeInt,
  parsePositiveNumberList,
  parseCancelRates,
  riskLabel,
  buildSymbolSummaries,
  calculateImpactRows,
  calculateTradePreview,
  calculateDailyGoal,
  summarizeChartPoints,
};
