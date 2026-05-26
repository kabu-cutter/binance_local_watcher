const DEFAULT_AMOUNTS = [1000, 10000, 100000];
const DEFAULT_CANCEL_RATES = [10, 30, 50, 70];
const DEFAULT_ROUNDTRIP_COST_PCT = 0.28;
const STRATEGY_TEMPLATES = {
  market_priority: {
    label: '約定優先・成行寄り',
    note: '約定率は高め、未約定は少なめ、往復コストは重め。小さい値動き狙いは手数料負けを重点確認。',
  },
  pullback_limit: {
    label: '押し目指値待ち',
    note: '未約定が増えやすい前提。約定できればコストを抑えやすい。未約定30〜50%を重点確認。',
  },
  breakout_follow: {
    label: 'ブレイクアウト追随',
    note: '約定率は高め。必要変動率は中〜大。損切り幅が広くなりやすく、ダマシ耐性を確認。',
  },
  range_reversion: {
    label: 'レンジ逆張り',
    note: '小さい値動きを狙う前提。レンジ内は勝率を上げやすい可能性があり、レンジ抜け時の損切り確認を優先。',
  },
};

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
  if (neededPct < 0.3) return '軽い';
  if (neededPct < 0.8) return '普通';
  if (neededPct < 1.5) return '重い';
  return 'かなり重い';
}

function riskKind(label) {
  if (label === '軽い' || label === '普通') return 'good';
  if (label === '重い') return 'warn';
  return 'bad';
}

function realityLabel(level) {
  if (level <= 0) return '軽い';
  if (level === 1) return '普通';
  if (level === 2) return '重い';
  return 'かなり重い';
}

function realityKind(label) {
  return riskKind(label);
}

function labelLevel(label) {
  return ['軽い', '普通', '重い', 'かなり重い'].indexOf(label);
}

function fillRealityLabel(fillRate) {
  if (fillRate >= 80) return '軽い';
  if (fillRate >= 60) return '普通';
  if (fillRate >= 40) return '重い';
  return 'かなり重い';
}

function movementRealityLabel(neededPct, recentMoveAbsPct) {
  if (recentMoveAbsPct <= 0) return 'かなり重い';
  const ratio = neededPct / recentMoveAbsPct;
  if (ratio <= 0.7) return '軽い';
  if (ratio <= 1.1) return '普通';
  if (ratio <= 1.8) return '重い';
  return 'かなり重い';
}

function winRealityLabel(winRate) {
  if (winRate <= 45) return '軽い';
  if (winRate <= 60) return '普通';
  if (winRate <= 75) return '重い';
  return 'かなり重い';
}

function neededWinRatePct({ target, capital, attempts, recentMoveAbsPct, costPct, lossAbs }) {
  const winNet = capital * Math.max(recentMoveAbsPct - costPct, 0) / 100;
  if (attempts <= 0 || winNet <= 0) return 100;
  const rate = ((target + attempts * lossAbs) / (attempts * (winNet + lossAbs))) * 100;
  return Math.max(0, Math.min(100, rate));
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
  const template = STRATEGY_TEMPLATES[body.strategy_template] || null;
  const target = Math.max(0, safeFloat(body.target_profit_jpy));
  const capital = Math.max(1, safeFloat(body.capital_jpy, 1));
  const minOpp = Math.max(1, safeInt(body.min_opportunities, 1));
  const maxOpp = Math.max(minOpp, safeInt(body.max_opportunities, minOpp));
  const stopPct = Math.max(0, safeFloat(body.stop_loss_pct));
  const cancelRates = parseCancelRates(body.cancel_rates_text);
  const costPct = Math.max(0, safeFloat(body.roundtrip_cost_pct, DEFAULT_ROUNDTRIP_COST_PCT));
  const virtualFillRate = Math.max(0, Math.min(100, safeFloat(body.virtual_fill_rate_pct, 70)));
  const recentMovePct = safeFloat(body.recent_move_pct, 0);
  const recentMoveAbsPct = Math.abs(recentMovePct);
  const recentMoveLabel = body.recent_move_label || '直近値動き';
  const targetPct = (target / capital) * 100;
  const onePct = targetPct + costPct;
  const minPct = (target / capital / minOpp) * 100 + costPct;
  const maxPct = (target / capital / maxOpp) * 100 + costPct;
  const lossPerStop = -(capital * (stopPct + costPct) / 100);
  const lossAbs = Math.abs(lossPerStop);
  const allowedStopsBeforeTargetBreak = lossAbs > 0 ? Math.max(0, Math.floor(target / lossAbs)) : null;
  const balancedOpp = Math.max(1, Math.round((minOpp + maxOpp) / 2));
  const balancedNet = target / balancedOpp;
  const balancedPct = (balancedNet / capital) * 100 + costPct;
  const weightLabel = riskLabel(balancedPct);
  const worstCancelRate = Math.max(...cancelRates);
  const worstNofill = Math.round((maxOpp * worstCancelRate) / 100);
  const worstEffective = Math.max(1, maxOpp - worstNofill);
  const worstNeededNet = target / worstEffective;
  const worstNeededPct = (worstNeededNet / capital) * 100 + costPct;
  const nofillMultiplier = balancedNet > 0 ? worstNeededNet / balancedNet : 1;
  const stopPressurePct = target > 0 ? (lossAbs / target) * 100 : 0;
  const virtualEffective = Math.max(1, Math.round(maxOpp * virtualFillRate / 100));
  const virtualNeededNet = target / virtualEffective;
  const virtualNeededPct = (virtualNeededNet / capital) * 100 + costPct;
  const virtualNeededWinRate = neededWinRatePct({
    target,
    capital,
    attempts: virtualEffective,
    recentMoveAbsPct,
    costPct,
    lossAbs,
  });
  const fillLabel = fillRealityLabel(virtualFillRate);
  const winLabel = winRealityLabel(virtualNeededWinRate);
  const moveLabel = movementRealityLabel(virtualNeededPct, recentMoveAbsPct);
  const overallLabel = realityLabel(Math.max(labelLevel(fillLabel), labelLevel(winLabel), labelLevel(moveLabel)));
  const movementRatio = recentMoveAbsPct > 0 ? virtualNeededPct / recentMoveAbsPct : null;
  const suggestion = [
    template ? `テンプレート: ${template.label}（売買シグナルではなく条件テンプレート）` : 'テンプレート未選択: 条件比較モードで計算しています。',
    `今日の目標は ${target.toLocaleString('ja-JP')}円、資金/主投入額は ${capital.toLocaleString('ja-JP')}円です。`,
    `この日次目標は往復コスト${costPct.toFixed(2)}%前提で計算しています。`,
    `仮想約定率${virtualFillRate.toFixed(0)}%なら、有効約定は約${virtualEffective}回、1回必要Netは約${virtualNeededNet.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円です。`,
    `${recentMoveLabel}は ${recentMovePct >= 0 ? '+' : ''}${recentMovePct.toFixed(3)}% なので、必要変動率${virtualNeededPct.toFixed(3)}%は直近値動き比で${movementRatio === null ? '比較不可' : `${movementRatio.toFixed(2)}倍`}です。`,
    `この前提の現実度は「${overallLabel}」です。約定率・勝率・値動きのどれが重いかを下のカードで見ます。`,
    'これは売買指示ではなく、今日の条件が今の相場で現実的かを見る準備サジェストです。',
  ].join('\n');
  const readinessCards = [
    {
      title: '仮想約定率',
      main: `${virtualFillRate.toFixed(0)}%`,
      sub: `${maxOpp}機会中、約${virtualEffective}回の約定として見る / 現実度 ${fillLabel}`,
      tag: fillLabel,
      kind: realityKind(fillLabel),
    },
    {
      title: '必要勝率',
      main: `${virtualNeededWinRate.toFixed(1)}%`,
      sub: `${recentMoveLabel}を勝ち幅、損切り${stopPct.toFixed(2)}%として概算 / 現実度 ${winLabel}`,
      tag: winLabel,
      kind: realityKind(winLabel),
    },
    {
      title: '値動き比較',
      main: movementRatio === null ? '比較不可' : `${movementRatio.toFixed(2)}倍`,
      sub: `必要変動率 ${virtualNeededPct.toFixed(3)}% / ${recentMoveLabel} ${recentMoveAbsPct.toFixed(3)}% / 現実度 ${moveLabel}`,
      tag: moveLabel,
      kind: realityKind(moveLabel),
    },
  ];
  const prepNotes = [
    template ? `テンプレート補助: ${template.note}` : 'テンプレート補助: 売買推奨ではなく、条件の置き方を比較するための表示です。',
    overallLabel === 'かなり重い'
      ? '今日の目標はかなり重い条件です。回数、投入額、損切り幅、コスト前提を先に見直す候補です。'
      : overallLabel === '重い'
        ? '今日の目標は重い条件です。未約定が増えた時の1回あたり負担を先に確認すると安全です。'
        : '今日の目標は条件上は軽いから普通の範囲です。実際の値動きとコスト負けだけ確認します。',
    moveLabel === 'かなり重い'
      ? '直近値動きに対して必要変動率が大きいです。値幅が出ていない時間帯では無理が出やすい前提です。'
      : '必要変動率は直近値動きと比較できる範囲です。約定率と勝率の前提を合わせて見ます。',
    stopPressurePct >= 50
      ? '損切り1回の影響が大きいです。何回狙うかより、逆行時にどこで止めるかが先に効きます。'
      : '損切り1回の影響は目標内で確認できる範囲です。連続ミス時の崩れ方だけ見ておきます。',
    nofillMultiplier >= 1.8
      ? '未約定が増えると残った約定1回あたりの負担が跳ねます。指値待ちの前提は厳しめに見ます。'
      : '未約定シナリオによる悪化は比較的読みやすい範囲です。チャンス回数の見積もりを更新しながら使います。',
    'これは売買指示ではありません。今日の条件を希望ではなく準備項目へ分解するためのメモです。',
  ];
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
      const fillRate = ((effective / opp) * 100);
      const scenarioWinRate = neededWinRatePct({
        target,
        capital,
        attempts: effective,
        recentMoveAbsPct,
        costPct,
        lossAbs,
      });
      const scenarioMoveLabel = movementRealityLabel(neededPct, recentMoveAbsPct);
      const scenarioWinLabel = winRealityLabel(scenarioWinRate);
      const scenarioFillLabel = fillRealityLabel(fillRate);
      const scenarioReality = realityLabel(Math.max(
        labelLevel(scenarioMoveLabel),
        labelLevel(scenarioWinLabel),
        labelLevel(scenarioFillLabel),
      ));
      scenarios.push({
        cancel_rate: rate,
        fill_rate: fillRate,
        opportunities: opp,
        nofill,
        effective,
        needed_net_per_trade: neededNet,
        needed_move_pct: neededPct,
        needed_win_rate_pct: scenarioWinRate,
        movement_ratio: recentMoveAbsPct > 0 ? neededPct / recentMoveAbsPct : null,
        reality: scenarioReality,
        risk: scenarioReality,
        memo: `約定${effective}回 / ${recentMoveLabel}比で見る`,
      });
    }
  }
  return {
    suggestion,
    readiness_cards: readinessCards,
    prep_notes: prepNotes,
    plan_cards: planCards,
    scenarios,
    roundtrip_cost_pct: costPct,
    strategy_template: body.strategy_template || '',
    strategy_template_label: template?.label || '',
    strategy_template_note: template
      ? `テンプレート「${template.label}」: ${template.note}（売買推奨ではなく条件比較の補助です）`
      : 'テンプレートは売買シグナルではなく、日次目標の条件比較を補助するためのものです。',
    virtual_fill_rate_pct_used: safeFloat(body.virtual_fill_rate_pct_used, virtualFillRate),
    virtual_fill_rate_note: body.virtual_fill_rate_note || '',
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
  riskKind,
  buildSymbolSummaries,
  calculateImpactRows,
  calculateTradePreview,
  calculateDailyGoal,
  summarizeChartPoints,
};
