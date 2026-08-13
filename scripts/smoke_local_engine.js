const engine = require('../local_engine');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(route, payload = {}) {
  const data = await engine.invoke(route, payload);
  return data;
}

async function run() {
  const checks = [];

  const status = await call('status');
  assert(status.version, 'status.version missing');
  checks.push(`status ok (${status.version})`);

  const capabilities = await call('capabilities');
  assert(capabilities.routes?.GET && capabilities.routes?.POST, 'capabilities.routes missing');
  checks.push('capabilities ok');

  const contract = await call('contract');
  assert(contract.routes?.GET && contract.routes?.POST, 'contract.routes missing');
  checks.push('contract ok');

  const readiness = await call('api-readiness');
  assert(typeof readiness.public_api_ok === 'boolean', 'api-readiness.public_api_ok missing');
  checks.push(`api-readiness ok (public=${readiness.public_api_ok})`);

  const summary = await call('summary');
  assert(Array.isArray(summary.symbols), 'summary.symbols missing');
  checks.push('summary ok');

  const impact = await call('impact', { query: { amounts: '1000,10000' } });
  assert(Array.isArray(impact.rows), 'impact.rows missing');
  checks.push(`impact ok (${impact.rows.length} rows)`);

  const alertPreview = await call('alert-preview', {
    query: {
      window_minutes: 15,
      threshold_pct: 0.2,
      symbols: 'BTCJPY,ETHJPY',
      save_history: false,
    },
  });
  assert(Array.isArray(alertPreview.rows), 'alert-preview.rows missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'decision_comment')), 'alert-preview.decision_comment missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'volume_context')), 'alert-preview.volume_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'decision_context')), 'alert-preview.decision_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'direction_alerts')), 'alert-preview.direction_alerts missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'movement_alert_type')), 'alert-preview.movement_alert_type missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'selected_window_move_pct')), 'alert-preview.selected_window_move_pct missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'decision_basis_move_pct')), 'alert-preview.decision_basis_move_pct missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'continuation_alert')), 'alert-preview.continuation_alert missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'price_position_context')), 'alert-preview.price_position_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'reference_mode_context')), 'alert-preview.reference_mode_context missing');
  assert(alertPreview.rows.every((row) => row.decision_context && row.decision_context.market_state), 'alert-preview.decision_context.market_state missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'continuation_signal')), 'alert-preview.decision_context.market_state.continuation_signal missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'price_position')), 'alert-preview.decision_context.price_position missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'reference_mode_context')), 'alert-preview.decision_context.reference_mode_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'price_position_signal')), 'alert-preview.decision_context.market_state.price_position_signal missing');
  assert(Array.isArray(alertPreview.growth_alert_context), 'alert-preview.growth_alert_context missing');
  checks.push(`alert-preview ok (${alertPreview.rows.length} rows)`);

  const costEstimate = await call('cost-estimate', {
    query: {
      symbols: 'BTCJPY,ETHJPY',
      amount_jpy: 10000,
      order_assumption: 'market',
      estimate_style: 'standard',
      threshold_pct: 0.3,
    },
  });
  assert(Array.isArray(costEstimate.rows), 'cost-estimate.rows missing');
  assert(Number.isFinite(Number(costEstimate.recommended_cost_pct)), 'cost-estimate.recommended_cost_pct missing');
  checks.push(`cost-estimate ok (${costEstimate.rows.length} rows)`);

  const chart = await call('chart', {
    query: {
      symbol: 'BTCJPY',
      source: 'local',
      interval: '1m',
      limit: 40,
    },
  });
  assert(Array.isArray(chart.points), 'chart.points missing');
  checks.push(`chart ok (${chart.points.length} points)`);

  const trade = await call('trade-preview', {
    body: {
      symbol: 'BTCJPY',
      amount_jpy: 2000,
      exit_change_pct: 0.8,
      roundtrip_cost_pct: 0.28,
    },
  });
  assert(Number.isFinite(Number(trade.net_pl_yen)), 'trade-preview.net_pl_yen missing');
  checks.push('trade-preview ok');

  const daily = await call('daily-goal', {
    body: {
      strategy_template: 'market_priority',
      symbol: 'BTCJPY',
      target_profit_jpy: 100,
      capital_jpy: 2000,
      min_opportunities: 5,
      max_opportunities: 10,
      stop_loss_pct: 0.5,
      roundtrip_cost_pct: 0.34,
      cancel_rates_text: '10,20,30',
      virtual_fill_rate_pct: 85,
      virtual_fill_rate_auto: false,
      interval: '1m',
      date: '2026-05-25',
      start_hour: 0,
      end_hour: 24,
    },
  });
  assert(Array.isArray(daily.readiness_cards), 'daily-goal.readiness_cards missing');
  checks.push(`daily-goal ok (${daily.readiness_cards.length} cards)`);

  const dryDownload = await call('download-history', {
    body: {
      dry_run: true,
      symbol: 'BTCJPY',
      interval: '1m',
      date: '2026-05-25',
      start_hour: 0,
      end_hour: 1,
      skip_existing: true,
    },
  });
  assert(Array.isArray(dryDownload.chunks), 'download-history dry_run chunks missing');
  checks.push(`download-history dry_run ok (${dryDownload.chunks.length} chunk)`);

  checks.forEach((line) => console.log(`[OK] ${line}`));
  console.log('[DONE] local_engine smoke checks passed');
}

run().catch((error) => {
  console.error('[FAIL]', error.message);
  process.exit(1);
});
