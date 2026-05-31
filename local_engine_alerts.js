function safeFloat(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeInt(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function isBlankInput(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function safeNonNegativeFloat(value, fallback = 0) {
  if (isBlankInput(value)) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function parseAlertOptions(params = {}, symbols = []) {
  const windowMinutes = Math.max(1, Math.min(240, safeInt(params.window_minutes, 15)));
  const modeText = String(params.alert_mode || 'simple').trim().toLowerCase();
  const alertMode = ['simple', 'rolling', 'sustained'].includes(modeText) ? modeText : 'simple';
  const rollingMinPoints = Math.max(2, Math.min(20, safeInt(params.rolling_min_points, 3)));
  const risingRatioThreshold = Math.max(1, Math.min(100, safeFloat(params.alert_rising_ratio, 60)));
  const thresholdPct = safeNonNegativeFloat(params.threshold_pct, 0.2);
  const thresholdsText = String(params.thresholds || '').trim();
  const thresholdsBySymbol = {};
  if (thresholdsText) {
    thresholdsText.split(',').forEach((part) => {
      const [symbolText, thresholdText] = String(part).split(':').map((v) => String(v || '').trim());
      if (!symbols.includes(symbolText)) return;
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
    ? symbols.filter((symbol) => selectedSymbols.includes(symbol))
    : symbols.slice();
  return {
    windowMinutes,
    alertMode,
    rollingMinPoints,
    risingRatioThreshold,
    thresholdPct,
    thresholdsBySymbol,
    targetSymbols,
  };
}

function evaluateAlertPreview({ rows = [], source = 'unknown', params = {}, symbols = [], formatJst }) {
  const options = parseAlertOptions(params, symbols);
  const {
    windowMinutes, alertMode, rollingMinPoints, risingRatioThreshold, thresholdPct, thresholdsBySymbol, targetSymbols,
  } = options;

  if (!rows.length) {
    return {
      ...options,
      source,
      rows: targetSymbols.map((symbol) => ({
        symbol,
        status: 'データ不足',
        move_pct: null,
        samples: 0,
        latest_price: null,
        base_price: null,
        latest_time: '',
      })),
      top_alert: null,
      alert_count: 0,
      message: '履歴データがないためアラート判定は未実施です。',
    };
  }

  const resultRows = targetSymbols.map((symbol) => {
    const symbolRows = rows.filter((row) => row.symbol === symbol).sort((a, b) => a.timestamp - b.timestamp);
    if (symbolRows.length < 2) {
      return {
        symbol,
        status: 'データ不足',
        move_pct: null,
        samples: symbolRows.length,
        latest_price: symbolRows[0]?.price ?? null,
        base_price: symbolRows[0]?.price ?? null,
        latest_time: symbolRows[0] ? formatJst(symbolRows[0].timestamp) : '',
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
        move_pct: null,
        samples: windowRows.length,
        latest_price: latest.price,
        base_price: null,
        latest_time: formatJst(latest.timestamp),
      };
    }
    const movePct = ((latest.price - base.price) / base.price) * 100;
    const thresholdForSymbol = Number.isFinite(thresholdsBySymbol[symbol]) ? thresholdsBySymbol[symbol] : thresholdPct;
    let streakCount = 0;
    for (let i = windowRows.length - 1; i >= 0; i -= 1) {
      const pivot = windowRows[i];
      if (!pivot || !Number.isFinite(pivot.price) || pivot.price <= 0) break;
      const moveFromPivot = ((latest.price - pivot.price) / pivot.price) * 100;
      if (moveFromPivot >= thresholdForSymbol) streakCount += 1;
      else break;
    }
    let rollingStreak = 0;
    let upSteps = 0;
    let totalSteps = 0;
    for (let i = windowRows.length - 1; i > 0; i -= 1) {
      const curr = windowRows[i];
      const prev = windowRows[i - 1];
      if (!curr || !prev || !Number.isFinite(curr.price) || !Number.isFinite(prev.price) || prev.price <= 0) break;
      const stepPct = ((curr.price - prev.price) / prev.price) * 100;
      totalSteps += 1;
      if (stepPct > 0) upSteps += 1;
      if (stepPct > 0) rollingStreak += 1;
      else break;
    }
    const risingRatio = totalSteps > 0 ? (upSteps / totalSteps) * 100 : 0;
    const simpleHit = movePct >= thresholdForSymbol;
    const rollingHit = rollingStreak >= rollingMinPoints && movePct >= Math.max(thresholdForSymbol * 0.4, 0.02);
    const sustainedHit = movePct >= thresholdForSymbol && risingRatio >= risingRatioThreshold;
    const hit = alertMode === 'rolling' ? rollingHit : alertMode === 'sustained' ? sustainedHit : simpleHit;
    return {
      symbol,
      status: hit
        ? (alertMode === 'rolling' ? 'ローリング上昇アラート' : alertMode === 'sustained' ? '持続上昇アラート' : '上昇アラート')
        : '監視中',
      move_pct: movePct,
      threshold_pct: thresholdForSymbol,
      streak_count: streakCount,
      rolling_streak: rollingStreak,
      rising_ratio: risingRatio,
      samples: windowRows.length,
      latest_price: latest.price,
      base_price: base.price,
      latest_time: formatJst(latest.timestamp),
    };
  });
  const alertCount = resultRows.filter((row) => String(row.status).includes('アラート')).length;
  const ranked = resultRows.filter((row) => Number.isFinite(row.move_pct)).sort((a, b) => b.move_pct - a.move_pct);
  return {
    ...options,
    source,
    rows: resultRows,
    top_alert: ranked.length ? ranked[0] : null,
    alert_count: alertCount,
    message: alertCount ? `${alertCount}通貨がしきい値超えです。` : 'しきい値を超えた通貨はありません。',
  };
}

module.exports = {
  evaluateAlertPreview,
};
