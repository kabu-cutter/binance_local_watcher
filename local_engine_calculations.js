const DEFAULT_AMOUNTS = [1000, 10000, 100000];
const DEFAULT_CANCEL_RATES = [10, 30, 50, 70];
const DEFAULT_ROUNDTRIP_COST_PCT = 0.28;
const DEFAULT_LIMIT_CANDIDATES = [
  { key: 'shallow', label: '浅め', distance_pct: 0.05 },
  { key: 'standard', label: '標準', distance_pct: 0.10 },
  { key: 'deep', label: '深め', distance_pct: 0.20 },
  { key: 'very_deep', label: 'かなり深め', distance_pct: 0.40 },
];
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
  custom: {
    label: 'カスタム',
    note: '固定前提を持たず、入力した条件で重さを診断します。',
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
  const idx = ['軽い', '普通', '重い', 'かなり重い'].indexOf(label);
  return idx >= 0 ? idx : 1;
}

function fillRealityLabel(fillRate) {
  if (fillRate >= 80) return '軽い';
  if (fillRate >= 60) return '普通';
  if (fillRate >= 40) return '重い';
  return 'かなり重い';
}

function occurrenceRealityLabel(rate) {
  if (!Number.isFinite(rate)) return '未確認';
  if (rate >= 35) return '軽い';
  if (rate >= 15) return '普通';
  if (rate >= 5) return '重い';
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
  return Math.max(0, rate);
}

function formatNeededWinRate(winRate) {
  if (!Number.isFinite(winRate)) return '—';
  if (winRate >= 100) return '100%以上';
  return `${winRate.toFixed(1)}%`;
}

function neededWinPremiseLabel(winRate) {
  if (!Number.isFinite(winRate)) return '確認不可';
  if (winRate >= 100) return '全勝前提';
  if (winRate >= 90) return 'ほぼ全勝前提';
  if (winRate >= 75) return 'かなり重い';
  if (winRate >= 60) return '重い';
  return '確認範囲';
}

function formatExpectedReachCount(count) {
  if (!Number.isFinite(count) || count <= 0) return '0回相当';
  if (count < 1) return `1回未満（${count.toFixed(2)}回相当）`;
  if (count < 10) return `${count.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}回相当`;
  return `${count.toFixed(1).replace(/\.0$/, '')}回相当`;
}

function formatMaybePct(value, digits = 3) {
  if (!Number.isFinite(value)) return '計算不可';
  return `${value.toFixed(digits)}%`;
}

function formatMaybeYen(value, digits = 2) {
  if (!Number.isFinite(value)) return '計算不可';
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: digits })}円`;
}


function requiredSuccessLabel(requiredCount, plannedCount) {
  if (!Number.isFinite(requiredCount) || requiredCount <= 0) return '計算不可';
  if (!Number.isFinite(plannedCount) || plannedCount <= 0) return '確認範囲';
  if (requiredCount <= plannedCount) return '計画内';
  if (requiredCount <= plannedCount * 1.5) return 'やや多い';
  if (requiredCount <= plannedCount * 2.5) return 'かなり多い';
  return '現実的に重い';
}

function successLabelToReality(label) {
  if (label === '計画内') return '軽い';
  if (label === 'やや多い') return '普通';
  if (label === 'かなり多い') return '重い';
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

function isAligned(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return true;
  const q = Math.round(value / step);
  const aligned = Math.abs(value - (q * step));
  return aligned <= Math.max(step * 1e-6, 1e-12);
}

function calculateTradePreview({ body = {}, summaries, mockPrices, symbols, symbolRules = null }) {
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
  const ruleCheck = symbolRules ? {
    source: symbolRules.source || '',
    tick_size: symbolRules.tick_size,
    step_size: symbolRules.step_size,
    min_qty: symbolRules.min_qty,
    min_notional: symbolRules.min_notional,
    price_tick_ok: isAligned(price, symbolRules.tick_size),
    qty_step_ok: isAligned(quantity, symbolRules.step_size),
    qty_min_ok: Number.isFinite(symbolRules.min_qty) ? quantity >= symbolRules.min_qty : true,
    notional_min_ok: Number.isFinite(symbolRules.min_notional) ? amount >= symbolRules.min_notional : true,
  } : null;
  const ruleSummary = ruleCheck
    ? `ルール確認(exchInfo): tick=${ruleCheck.price_tick_ok ? 'ok' : 'ng'} / qtyStep=${ruleCheck.qty_step_ok ? 'ok' : 'ng'} / minQty=${ruleCheck.qty_min_ok ? 'ok' : 'ng'} / minNotional=${ruleCheck.notional_min_ok ? 'ok' : 'ng'}`
    : 'ルール確認(exchInfo): 取得できなかったため未判定';
  return {
    symbol,
    amount_jpy: amount,
    current_price: price,
    exit_price: exitPrice,
    quantity,
    gross_pl_yen: gross,
    net_pl_yen: net,
    roundtrip_cost_pct: costPct,
    rule_check: ruleCheck,
    accuracy: '概算',
    memo: `${symbol} を ${amount.toLocaleString('ja-JP')}円ぶん想定。現在価格から ${exitPct >= 0 ? '+' : ''}${exitPct.toFixed(3)}% 動くと、Grossは約${gross.toLocaleString('ja-JP', { maximumFractionDigits: 2, signDisplay: 'always' })}円、往復コスト${costPct.toFixed(2)}%を引いたNetは約${net.toLocaleString('ja-JP', { maximumFractionDigits: 2, signDisplay: 'always' })}円です。${ruleSummary}。これは実注文ではなく、Electron main process のローカル概算プレビューです。APIキーやSecretは使いません。`,
  };
}


function limitCandidateConditionLabel(requiredMovePct, distancePct) {
  if (!Number.isFinite(requiredMovePct)) return '計算不可';
  if (requiredMovePct < 0.25 && distancePct <= 0.1) return '条件軽め';
  if (requiredMovePct < 0.6 && distancePct <= 0.2) return '確認範囲';
  if (requiredMovePct < 1.2) return '条件重め';
  return 'かなり重い';
}

function limitCandidateConditionKind(label) {
  if (label === '条件軽め' || label === '確認範囲') return 'good';
  if (label === '条件重め') return 'warn';
  return 'bad';
}

function limitCandidateNote({ label, distancePct, requiredMovePct, currentPriceDistancePct }) {
  const depthText = distancePct <= 0.05
    ? '現在価格に近い浅め候補です。指値到達は見込みやすい一方、約定後の余裕は薄くなりやすい前提です。'
    : distancePct <= 0.1
      ? '標準寄りの候補です。指値到達と約定後の余裕を並べて確認するための基準点です。'
      : distancePct <= 0.2
        ? '深めの候補です。約定しにくくなる代わりに、約定後の必要利確価格までの余裕を確認しやすい前提です。'
        : 'かなり深い候補です。約定しない可能性を強めに見ながら、刺さった場合の余裕を確認する参考候補です。';
  const moveText = requiredMovePct >= 1
    ? '必要利確までの上昇率が大きめなので、条件診断では重めに扱います。'
    : requiredMovePct >= 0.5
      ? '必要利確までの上昇率は中程度です。時間帯・ボラティリティと合わせて確認します。'
      : '必要利確までの上昇率は比較的小さめです。ただしコスト負けしないかを確認します。';
  const distanceText = Number.isFinite(currentPriceDistancePct)
    ? `現在価格からの距離は${currentPriceDistancePct.toFixed(3)}%です。`
    : '';
  return `${label}: ${depthText} ${moveText} ${distanceText}これは売買指示ではなく、指値候補の条件比較です。`;
}

function calculateLimitCandidateDiagnostics(body = {}) {
  const currentPrice = safeFloat(body.current_price_jpy, NaN);
  const capital = Math.max(1, safeFloat(body.capital_jpy, 1));
  const target = Math.max(0, safeFloat(body.target_profit_jpy));
  const expectedSuccessCount = Math.max(1, safeInt(body.expected_success_count, 1));
  const perTradeTarget = target / expectedSuccessCount;
  const costPct = Math.max(0, safeFloat(body.roundtrip_cost_pct, DEFAULT_ROUNDTRIP_COST_PCT));
  const side = body.limit_candidate_side === 'sell_limit' ? 'sell_limit' : 'buy_limit';
  const rows = [];
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      rows,
      note: '指値候補診断: 現在価格が取得できないため、指値価格・必要利確価格は計算していません。',
      meta: {
        enabled: false,
        reason: 'current_price_missing',
        side,
        side_label: side === 'sell_limit' ? '売り指値候補' : '買い指値候補',
        current_price: null,
        capital_jpy: capital,
        target_profit_jpy: target,
        expected_success_count: expectedSuccessCount,
        per_trade_target_jpy: perTradeTarget,
        roundtrip_cost_pct: costPct,
      },
    };
  }

  DEFAULT_LIMIT_CANDIDATES.forEach((candidate) => {
    const distancePct = Math.max(0, safeFloat(candidate.distance_pct));
    const directionMultiplier = side === 'sell_limit' ? 1 : -1;
    const currentPriceDistancePct = directionMultiplier * distancePct;
    const limitPrice = currentPrice * (1 + currentPriceDistancePct / 100);
    const quantity = limitPrice > 0 ? capital / limitPrice : 0;
    const estimatedRoundtripCostJpy = capital * costPct / 100;
    const requiredGrossProfitJpy = perTradeTarget + estimatedRoundtripCostJpy;
    const requiredMovePctFromLimit = capital > 0 ? (requiredGrossProfitJpy / capital) * 100 : 0;
    const requiredMoveJpy = limitPrice * requiredMovePctFromLimit / 100;
    const requiredTakeProfitPrice = side === 'sell_limit'
      ? Math.max(0, limitPrice - requiredMoveJpy)
      : limitPrice + requiredMoveJpy;
    const takeProfitDistanceFromCurrentPct = currentPrice > 0
      ? ((requiredTakeProfitPrice - currentPrice) / currentPrice) * 100
      : null;
    const label = limitCandidateConditionLabel(requiredMovePctFromLimit, distancePct);
    rows.push({
      key: candidate.key,
      candidate_label: candidate.label,
      side,
      side_label: side === 'sell_limit' ? '売り指値候補' : '買い指値候補',
      current_price: currentPrice,
      distance_pct: distancePct,
      current_price_distance_pct: currentPriceDistancePct,
      limit_price: limitPrice,
      capital_jpy: capital,
      quantity,
      target_profit_jpy: target,
      expected_success_count: expectedSuccessCount,
      per_trade_target_jpy: perTradeTarget,
      roundtrip_cost_pct: costPct,
      estimated_roundtrip_cost_jpy: estimatedRoundtripCostJpy,
      required_gross_profit_jpy: requiredGrossProfitJpy,
      required_take_profit_price: requiredTakeProfitPrice,
      required_move_jpy_from_limit: Math.abs(requiredTakeProfitPrice - limitPrice),
      required_move_pct_from_limit: requiredMovePctFromLimit,
      take_profit_distance_from_current_pct: takeProfitDistanceFromCurrentPct,
      condition_label: label,
      condition_kind: limitCandidateConditionKind(label),
      note: limitCandidateNote({
        label: candidate.label,
        distancePct,
        requiredMovePct: requiredMovePctFromLimit,
        currentPriceDistancePct,
      }),
    });
  });

  return {
    rows,
    note: `必要利確価格ベース: 現在価格${currentPrice.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円を基準に、固定%の${side === 'sell_limit' ? '売り' : '買い'}指値候補を比較しました。主役は「この指値で約定した場合、コスト込みでどの価格まで戻れば1回目標が残るか」です。利確幅シミュレーション%は参考条件で、過去データによる指値到達率・利確到達率・損切り先行率は次段階で追加します。`,
    meta: {
      enabled: true,
      side,
      side_label: side === 'sell_limit' ? '売り指値候補' : '買い指値候補',
      current_price: currentPrice,
      capital_jpy: capital,
      target_profit_jpy: target,
      expected_success_count: expectedSuccessCount,
      per_trade_target_jpy: perTradeTarget,
      roundtrip_cost_pct: costPct,
      candidate_count: rows.length,
      candidate_source: 'fixed_percent',
      candidate_distances_pct: DEFAULT_LIMIT_CANDIDATES.map((candidate) => candidate.distance_pct),
      note: 'この表は条件診断です。実注文・自動売買・売買指示ではありません。',
    },
  };
}

function calculateDailyGoal(body = {}) {
  const template = STRATEGY_TEMPLATES[body.strategy_template] || null;
  const target = Math.max(0, safeFloat(body.target_profit_jpy));
  const capital = Math.max(1, safeFloat(body.capital_jpy, 1));
  const minOpp = Math.max(1, safeInt(body.min_opportunities, 1));
  const maxOpp = Math.max(minOpp, safeInt(body.max_opportunities, minOpp));
  const expectedSuccessCount = Math.max(1, safeInt(body.expected_success_count, Math.max(1, Math.round((minOpp + maxOpp) / 2))));
  const takeProfitPct = Math.max(0, safeFloat(body.take_profit_pct, 0.4));
  const stopPct = Math.max(0, safeFloat(body.stop_loss_pct));
  const cancelRates = parseCancelRates(body.cancel_rates_text);
  const costPct = Math.max(0, safeFloat(body.roundtrip_cost_pct, DEFAULT_ROUNDTRIP_COST_PCT));
  const virtualFillRate = Math.max(0, Math.min(100, safeFloat(body.virtual_fill_rate_pct, 70)));
  const recentMovePct = safeFloat(body.recent_move_pct, 0);
  const recentMoveAbsPct = Math.abs(recentMovePct);
  const recentMoveLabel = body.recent_move_label || '直近値動き';
  const requiredMoveOccurrenceRate = Number.isFinite(Number(body.required_move_occurrence_rate_pct))
    ? Math.max(0, Math.min(100, safeFloat(body.required_move_occurrence_rate_pct)))
    : null;
  const requiredMoveOccurrenceNote = body.required_move_occurrence_note || '';
  const targetPct = (target / capital) * 100;
  const onePct = targetPct + costPct;
  const minPct = (target / capital / minOpp) * 100 + costPct;
  const maxPct = (target / capital / maxOpp) * 100 + costPct;
  const perTradeTarget = target / expectedSuccessCount;
  const perTradeRequiredPct = (perTradeTarget / capital) * 100 + costPct;
  const takeProfitGrossPerTrade = capital * takeProfitPct / 100;
  const takeProfitNetPerTrade = capital * Math.max(takeProfitPct - costPct, 0) / 100;
  const requiredSuccessCountByTakeProfit = takeProfitNetPerTrade > 0 ? Math.ceil(target / takeProfitNetPerTrade) : null;
  const requiredSuccessLabelText = requiredSuccessLabel(requiredSuccessCountByTakeProfit, expectedSuccessCount);
  const requiredSuccessReality = successLabelToReality(requiredSuccessLabelText);
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
  // 指値到達見込みは「取引機会数 × 指値到達率」で出します。
  // 1未満でも切り上げず、0.03回相当のように表示します。
  const virtualExpectedReachCount = maxOpp * virtualFillRate / 100;
  const virtualReachCountForCalc = virtualExpectedReachCount > 0 ? virtualExpectedReachCount : 0;
  const virtualNeededNet = virtualReachCountForCalc > 0 ? target / virtualReachCountForCalc : Infinity;
  const virtualNeededPct = Number.isFinite(virtualNeededNet) ? (virtualNeededNet / capital) * 100 + costPct : Infinity;
  const virtualReachCountText = formatExpectedReachCount(virtualExpectedReachCount);
  const virtualNeededWinRate = neededWinRatePct({
    target,
    capital,
    attempts: virtualReachCountForCalc,
    recentMoveAbsPct,
    costPct,
    lossAbs,
  });
  const fillLabel = fillRealityLabel(virtualFillRate);
  const winLabel = winRealityLabel(virtualNeededWinRate);
  const moveLabel = movementRealityLabel(virtualNeededPct, recentMoveAbsPct);
  const occurrenceLabel = requiredMoveOccurrenceRate === null ? '未確認' : occurrenceRealityLabel(requiredMoveOccurrenceRate);
  const overallLabel = realityLabel(Math.max(
    labelLevel(fillLabel),
    labelLevel(winLabel),
    labelLevel(moveLabel),
    requiredMoveOccurrenceRate === null ? 0 : labelLevel(occurrenceLabel),
  ));
  const movementRatio = recentMoveAbsPct > 0 ? virtualNeededPct / recentMoveAbsPct : null;
  const limitCandidateDiagnostics = calculateLimitCandidateDiagnostics({
    ...body,
    target_profit_jpy: target,
    capital_jpy: capital,
    expected_success_count: expectedSuccessCount,
    roundtrip_cost_pct: costPct,
    limit_candidate_side: body.limit_candidate_side || body.virtual_fill_side || 'buy_limit',
  });
  const standardLimitCandidate = limitCandidateDiagnostics.rows.find((row) => row.key === 'standard') || limitCandidateDiagnostics.rows[0] || null;
  const suggestion = [
    template ? `今日の見方: ${template.label}（売買シグナルではなく条件テンプレート）` : 'テンプレート未選択: 条件比較モードで計算しています。',
    '日次Net = 勝ち回数 × 1回勝ちNet + 負け回数 × 1回負けNet で見ます。',
    '指値到達見込み = 取引機会数 × 指値到達率 として見ます。これは勝ち回数でも利益が出る回数でもありません。',
    `今日の目標は ${target.toLocaleString('ja-JP')}円、資金/主投入額は ${capital.toLocaleString('ja-JP')}円です。`,
    `想定成功回数は${expectedSuccessCount}回、1回あたり目標利益は約${perTradeTarget.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円です。`,
    standardLimitCandidate
      ? `必要利確価格ベースでは、標準候補の指値${standardLimitCandidate.limit_price.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円に対して、必要利確価格は約${standardLimitCandidate.required_take_profit_price.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円です。`
      : '必要利確価格ベースの指値候補は、現在価格取得後に表示します。',
    `利確幅シミュレーションは${takeProfitPct.toFixed(3)}%です。これは参考条件で、最初に決める主条件ではありません。この幅なら、コスト込み1回あたり見込みNetは約${takeProfitNetPerTrade.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円、目標達成に必要な成功回数は${requiredSuccessCountByTakeProfit === null ? '計算不可' : `${requiredSuccessCountByTakeProfit}回`}です。`,
    `この日次目標は往復コスト${costPct.toFixed(2)}%前提で計算しています。`,
    limitCandidateDiagnostics.note,
    `指値到達率${virtualFillRate.toFixed(1)}%なら、${maxOpp}回の取引機会に対する指値到達見込みは${virtualReachCountText}です。これは勝ち回数ではなく、到達見込みあたり必要Netは約${formatMaybeYen(virtualNeededNet)}です。`,
    `${recentMoveLabel}は ${recentMovePct >= 0 ? '+' : ''}${recentMovePct.toFixed(3)}% なので、到達見込み加味の必要値幅${formatMaybePct(virtualNeededPct)}は直近値動き比で${movementRatio === null ? '比較不可' : `${movementRatio.toFixed(2)}倍`}です。`,
    requiredMoveOccurrenceRate === null
      ? '必要値幅の出現率は未確認です。これは約定率とは別に、必要な値幅が過去データでどれくらい出たかを見る参考値です。'
      : `必要値幅の出現率は${requiredMoveOccurrenceRate.toFixed(1)}%です。これは約定率ではなく、必要な値幅が過去データ上どれくらい出たかの参考値です。`,
    `この前提の現実度は「${overallLabel}」です。主診断は必要利確価格・指値到達率・必要勝率・1回あたり必要値幅を分けて見ます。利確幅シミュレーションは参考として扱います。`,
    'これは売買指示ではなく、今日の条件が今の相場で現実的かを見る準備サジェストです。',
  ].join('\n');
  const readinessCards = [
    {
      title: '指値到達見込み',
      main: virtualReachCountText,
      sub: `取引機会数${maxOpp}回 × 指値到達率${virtualFillRate.toFixed(1)}% = ${virtualReachCountText} / 勝ち回数ではありません / 現実度 ${fillLabel}`,
      tag: fillLabel,
      kind: realityKind(fillLabel),
    },
    {
      title: '1回あたり必要値幅',
      main: `${perTradeRequiredPct.toFixed(3)}%`,
      sub: `日次目標${target.toLocaleString('ja-JP')}円 ÷ 想定成功${expectedSuccessCount}回 = 1回約${perTradeTarget.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円 / コスト込み`,
      tag: riskLabel(perTradeRequiredPct),
      kind: riskKind(riskLabel(perTradeRequiredPct)),
    },
    {
      title: '必要利確価格ベース',
      main: standardLimitCandidate ? `${standardLimitCandidate.required_take_profit_price.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円` : '未計算',
      sub: standardLimitCandidate
        ? `標準指値 ${standardLimitCandidate.limit_price.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円 → 必要利確 ${standardLimitCandidate.required_take_profit_price.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円 / 指値後必要値幅 ${standardLimitCandidate.required_move_jpy_from_limit.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円`
        : '現在価格取得後に、指値価格から必要利確価格までを表示します。',
      tag: standardLimitCandidate ? standardLimitCandidate.condition_label : '未計算',
      kind: standardLimitCandidate ? standardLimitCandidate.condition_kind : 'warn',
    },
    {
      title: '利確幅シミュレーション',
      main: `${takeProfitPct.toFixed(3)}%`,
      sub: `参考条件です。最初に決める主条件ではありません。この幅なら1回Net約${takeProfitNetPerTrade.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円 / 日次目標には${requiredSuccessCountByTakeProfit === null ? '計算不可' : `${requiredSuccessCountByTakeProfit}回`}成功が必要`,
      tag: requiredSuccessLabelText,
      kind: 'warn',
    },
    {
      title: '必要勝率',
      main: formatNeededWinRate(virtualNeededWinRate),
      sub: `${recentMoveLabel}を勝ち幅、損切り${stopPct.toFixed(2)}%として概算 / ${neededWinPremiseLabel(virtualNeededWinRate)}`,
      tag: winLabel,
      kind: realityKind(winLabel),
    },
    {
      title: '値動き現実度',
      main: movementRatio === null ? '比較不可' : `${movementRatio.toFixed(2)}倍`,
      sub: `到達見込み加味の必要値幅 ${formatMaybePct(virtualNeededPct)} / ${recentMoveLabel} ${recentMoveAbsPct.toFixed(3)}% / 現実度 ${moveLabel}`,
      tag: moveLabel,
      kind: realityKind(moveLabel),
    },
    {
      title: '必要値幅の出現率',
      main: requiredMoveOccurrenceRate === null ? '未確認' : `${requiredMoveOccurrenceRate.toFixed(1)}%`,
      sub: requiredMoveOccurrenceRate === null
        ? '履歴確認OFFまたは履歴不足。これは約定率とは別の参考値です。'
        : `過去データで必要値幅が出た頻度 / これは約定率ではありません / 現実度 ${occurrenceLabel}`,
      tag: occurrenceLabel,
      kind: occurrenceLabel === '未確認' ? 'warn' : realityKind(occurrenceLabel),
    },
  ];
  const prepNotes = [
    template ? `テンプレート補助: ${template.note}` : 'テンプレート補助: 売買推奨ではなく、条件の置き方を比較するための表示です。',
    `日次目標は1回で全部取る前提ではなく、想定成功${expectedSuccessCount}回に分けて、1回あたり約${perTradeTarget.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円を目安にします。`,
    requiredSuccessCountByTakeProfit === null
      ? '利確幅シミュレーションがコスト以下のため、この参考条件では1回あたり見込みNetが残りません。主判断は必要利確価格ベースで確認します。'
      : `利確幅シミュレーションは${takeProfitPct.toFixed(3)}%です。この参考幅では、日次目標達成に約${requiredSuccessCountByTakeProfit}回の成功が必要です。これは計画${expectedSuccessCount}回に対して「${requiredSuccessLabelText}」です。`,
    overallLabel === 'かなり重い'
      ? '今日の目標はかなり重い条件です。回数、投入額、損切り幅、コスト前提を先に見直す候補です。'
      : overallLabel === '重い'
        ? '今日の目標は重い条件です。未約定が増えた時の1回あたり負担を先に確認すると安全です。'
        : '今日の目標は条件上は軽いから普通の範囲です。実際の値動きとコスト負けだけ確認します。',
    moveLabel === 'かなり重い'
      ? '直近値動きに対して1回あたり必要値幅が大きいです。値幅が出ていない時間帯では無理が出やすい前提です。'
      : '1回あたり必要値幅は直近値動きと比較できる範囲です。指値到達率と必要勝率の前提を合わせて見ます。',
    requiredMoveOccurrenceRate === null
      ? '必要値幅の出現率は未確認です。履歴DL後に確認すると、値幅が出ていた頻度を参考にできます。'
      : `必要値幅の出現率は${requiredMoveOccurrenceRate.toFixed(1)}%です。これは約定率ではなく、必要な値幅が過去に出た割合です。`,
    stopPressurePct >= 50
      ? '損切り1回の影響が大きいです。何回狙うかより、逆行時にどこで止めるかが先に効きます。'
      : '損切り1回の影響は目標内で確認できる範囲です。連続ミス時の崩れ方だけ見ておきます。',
    nofillMultiplier >= 1.8
      ? '未約定が増えると残った約定1回あたりの負担が跳ねます。指値待ちの前提は厳しめに見ます。'
      : '未約定シナリオによる悪化は比較的読みやすい範囲です。チャンス回数の見積もりを更新しながら使います。',
    limitCandidateDiagnostics.note,
    'これは売買指示ではありません。今日の条件を希望ではなく準備項目へ分解するためのメモです。',
  ];
  const planOptions = [['1回で達成', 1], [`想定${expectedSuccessCount}回で分ける`, expectedSuccessCount], [`最大${maxOpp}回で分ける`, maxOpp]];
  const uniquePlanOptions = planOptions.filter((item, index, arr) => arr.findIndex((other) => other[1] === item[1]) === index);
  const planCards = uniquePlanOptions.map(([title, opp]) => {
    const neededNet = target / opp;
    const neededPct = (neededNet / capital) * 100 + costPct;
    return {
      title,
      main: `1回 ${neededPct.toFixed(3)}%`,
      sub: `このプランでは1回あたり最低${neededPct.toFixed(3)}%の有利な値幅を捉える想定 / 1回必要Net 約${neededNet.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円 / 損切り1回 約${lossPerStop.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円`,
      tag: riskLabel(neededPct),
      kind: neededPct >= 1.5 ? 'bad' : neededPct < 0.8 ? 'good' : 'warn',
    };
  });
  const scenarios = [];
  const seenScenarioKeys = new Set();
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
      const scenarioKey = `${opp}:${effective}:${neededNet.toFixed(6)}:${neededPct.toFixed(6)}:${Math.round(fillRate)}`;
      if (seenScenarioKeys.has(scenarioKey)) continue;
      seenScenarioKeys.add(scenarioKey);
      const lossExplain = lossAbs > 0
        ? `1回利益約${neededNet.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円に対して、損切り1回は約${lossAbs.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円です。1敗で目標達成が大きく崩れます。`
        : `1回利益約${neededNet.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円、損切りは未設定です。`;
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
        memo: scenarioWinRate >= 100
          ? `全勝前提。${lossExplain} ${recentMoveLabel}比で見る`
          : `必要勝ち${Math.ceil((scenarioWinRate / 100) * effective)}回目安。${lossExplain} ${recentMoveLabel}比で見る`,
      });
    }
  }
  const diagnosticSummary = [
    `指値到達見込み: ${fillLabel}（取引機会数 ${maxOpp}回 × 指値到達率 ${virtualFillRate.toFixed(1)}% = ${virtualReachCountText}。勝ち回数でも利益回数でもありません）`,
    `必要勝率: ${neededWinPremiseLabel(virtualNeededWinRate)}（必要勝率 ${formatNeededWinRate(virtualNeededWinRate)}）`,
    `1回あたり必要値幅: ${perTradeRequiredPct.toFixed(3)}%（日次目標${target.toLocaleString('ja-JP')}円 ÷ 想定成功${expectedSuccessCount}回 = 1回約${perTradeTarget.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円）`,
    standardLimitCandidate
      ? `必要利確価格ベース: 標準指値 ${standardLimitCandidate.limit_price.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円 → 必要利確 ${standardLimitCandidate.required_take_profit_price.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円（指値後必要値幅 ${standardLimitCandidate.required_move_jpy_from_limit.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円 / ${standardLimitCandidate.required_move_pct_from_limit.toFixed(3)}%）`
      : '必要利確価格ベース: 未計算',
    `利確幅シミュレーション: ${takeProfitPct.toFixed(3)}%（参考条件。この幅なら1回Net約${takeProfitNetPerTrade.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円 / 日次目標には${requiredSuccessCountByTakeProfit === null ? '計算不可' : `${requiredSuccessCountByTakeProfit}回成功が必要`} / ${requiredSuccessLabelText}）`,
    `値動き現実度: ${moveLabel}（到達見込み加味の必要値幅 ${formatMaybePct(virtualNeededPct)}）`,
    requiredMoveOccurrenceRate === null
      ? '必要値幅の出現率: 未確認（履歴確認OFFまたは履歴不足）'
      : `必要値幅の出現率: ${occurrenceLabel}（過去データで必要値幅が出た割合 ${requiredMoveOccurrenceRate.toFixed(1)}% / 約定率ではありません）`,
    `総合: ${overallLabel}。必要利確価格・指値到達見込み・必要勝率・1回あたり必要値幅・値幅出現率のどれが重いかを分けて確認してください。利確幅シミュレーションは参考表示です。`,
  ].join('\n');
  return {
    suggestion,
    diagnostic_summary: diagnosticSummary,
    readiness_cards: readinessCards,
    prep_notes: prepNotes,
    plan_cards: planCards,
    scenarios,
    limit_candidate_rows: limitCandidateDiagnostics.rows,
    limit_candidate_note: limitCandidateDiagnostics.note,
    limit_candidate_meta: limitCandidateDiagnostics.meta,
    target_profit_jpy: target,
    expected_success_count: expectedSuccessCount,
    take_profit_pct: takeProfitPct,
    per_trade_target_jpy: perTradeTarget,
    per_trade_required_move_pct: perTradeRequiredPct,
    take_profit_gross_per_trade_jpy: takeProfitGrossPerTrade,
    take_profit_net_per_trade_jpy: takeProfitNetPerTrade,
    required_success_count_by_take_profit: requiredSuccessCountByTakeProfit,
    required_success_label: requiredSuccessLabelText,
    roundtrip_cost_pct: costPct,
    required_move_occurrence_rate_pct: requiredMoveOccurrenceRate,
    required_move_occurrence_note: requiredMoveOccurrenceNote,
    required_move_occurrence_label: occurrenceLabel,
    required_move_occurrence_required_pct: Number.isFinite(Number(body.required_move_occurrence_required_pct))
      ? safeFloat(body.required_move_occurrence_required_pct)
      : null,
    required_move_occurrence_meta: body.required_move_occurrence_meta || null,
    strategy_template: body.strategy_template || '',
    strategy_template_label: template?.label || '',
    strategy_template_note: template
      ? `テンプレート「${template.label}」: ${template.note}（売買推奨ではなく条件比較の補助です）`
      : 'テンプレートは売買シグナルではなく、日次目標の条件比較を補助するためのものです。',
    virtual_fill_rate_pct_used: safeFloat(body.virtual_fill_rate_pct_used, virtualFillRate),
    virtual_fill_rate_note: body.virtual_fill_rate_note || '',
    overall_label: overallLabel,
    virtual_effective_count: virtualExpectedReachCount,
    virtual_expected_reach_count: virtualExpectedReachCount,
    virtual_expected_reach_count_text: virtualReachCountText,
    virtual_needed_net_per_trade_jpy: virtualNeededNet,
    virtual_needed_move_pct: virtualNeededPct,
    virtual_needed_win_rate_pct: virtualNeededWinRate,
    needed_win_premise_label: neededWinPremiseLabel(virtualNeededWinRate),
    loss_per_stop_jpy: lossPerStop,
    loss_abs_per_stop_jpy: lossAbs,
    allowed_stops_before_target_break: allowedStopsBeforeTargetBreak,
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
  calculateLimitCandidateDiagnostics,
  calculateDailyGoal,
  summarizeChartPoints,
};
