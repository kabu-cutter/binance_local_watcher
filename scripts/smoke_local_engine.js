const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../local_engine');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(route, payload = {}) {
  const data = await engine.invoke(route, payload);
  return data;
}


function syntheticJstTimestamp(epochMs) {
  const d = new Date(epochMs + (9 * 60 * 60 * 1000));
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' JST';
}

function writeSyntheticPriceHistory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now() - (120 * 60 * 1000);
  const lines = ['timestamp,symbol,price_jpy'];
  for (let i = 0; i < 120; i += 1) {
    const timestamp = syntheticJstTimestamp(base + (i * 60 * 1000));
    const btc = 15000000 + (Math.sin(i / 8) * 6000) + (i * 100);
    const eth = 300000 + (Math.sin(i / 10) * 120) + (i * 2);
    lines.push(`${timestamp},BTCJPY,${btc.toFixed(0)}`);
    lines.push(`${timestamp},ETHJPY,${eth.toFixed(0)}`);
  }
  fs.writeFileSync(path.join(dir, 'price_history.csv'), `${lines.join('\n')}\n`, 'utf8');
}

async function runSyntheticAlertPreviewCheck() {
  const previousProjectDir = process.env.BLW_PROJECT_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-alert-smoke-'));
  try {
    writeSyntheticPriceHistory(tempDir);
    process.env.BLW_PROJECT_DIR = tempDir;
    const preview = await call('alert-preview', {
      query: {
        window_minutes: 15,
        threshold_pct: 0.3,
        symbols: 'BTCJPY,ETHJPY',
        save_history: false,
      },
    });
    assert(Array.isArray(preview.rows) && preview.rows.length === 2, 'synthetic alert-preview.rows missing');
    assert(preview.rows.every((row) => row.sideways_context), 'synthetic sideways_context missing');
    assert(preview.rows.every((row) => row.technical_context), 'synthetic technical_context missing');
    assert(preview.rows.every((row) => typeof row.technical_practical_text === 'string'), 'synthetic technical_practical_text missing');
    return preview.rows.map((row) => `${row.symbol}:${row.technical_context?.label || 'technical'}`).join(', ');
  } finally {
    if (previousProjectDir === undefined) delete process.env.BLW_PROJECT_DIR;
    else process.env.BLW_PROJECT_DIR = previousProjectDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'volume_cost_context')), 'alert-preview.volume_cost_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'cost_context')), 'alert-preview.cost_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'combined_signal_context')), 'alert-preview.combined_signal_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'combined_signal_summary')), 'alert-preview.combined_signal_summary missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'sideways_context')), 'alert-preview.sideways_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'technical_context')), 'alert-preview.technical_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'technical_practical_text')), 'alert-preview.technical_practical_text missing');
  assert(alertPreview.rows.every((row) => row.technical_context === null || Object.prototype.hasOwnProperty.call(row.technical_context, 'practical_text')), 'alert-preview.technical_context.practical_text missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'volume_alert_summary')), 'alert-preview.volume_alert_summary missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'cost_alert_summary')), 'alert-preview.cost_alert_summary missing');
  assert(alertPreview.rows.every((row) => row.decision_context && row.decision_context.market_state), 'alert-preview.decision_context.market_state missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'continuation_signal')), 'alert-preview.decision_context.market_state.continuation_signal missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'price_position')), 'alert-preview.decision_context.price_position missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'reference_mode_context')), 'alert-preview.decision_context.reference_mode_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'price_position_signal')), 'alert-preview.decision_context.market_state.price_position_signal missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'volume_cost_signal')), 'alert-preview.decision_context.market_state.volume_cost_signal missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'cost_risk')), 'alert-preview.decision_context.market_state.cost_risk missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'combined_signal_context')), 'alert-preview.decision_context.combined_signal_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'combined_signal')), 'alert-preview.decision_context.market_state.combined_signal missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'sideways_context')), 'alert-preview.decision_context.sideways_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'technical_context')), 'alert-preview.decision_context.technical_context missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context, 'technical_practical_text')), 'alert-preview.decision_context.technical_practical_text missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'technical_practical_text')), 'alert-preview.decision_context.market_state.technical_practical_text missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'sideways_signal')), 'alert-preview.decision_context.market_state.sideways_signal missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'technical_signal')), 'alert-preview.decision_context.market_state.technical_signal missing');
  assert(alertPreview.rows.every((row) => row.technical_context === null || Object.prototype.hasOwnProperty.call(row.technical_context, 'rsi')), 'alert-preview.technical_context.rsi missing');
  assert(alertPreview.rows.every((row) => row.technical_context === null || Object.prototype.hasOwnProperty.call(row.technical_context, 'bb_width_pct')), 'alert-preview.technical_context.bb_width_pct missing');
  assert(alertPreview.rows.every((row) => row.technical_context === null || Object.prototype.hasOwnProperty.call(row.technical_context, 'confluence_signal')), 'alert-preview.technical_context.confluence_signal missing');
  assert(alertPreview.rows.every((row) => row.technical_context === null || Object.prototype.hasOwnProperty.call(row.technical_context, 'technical_score')), 'alert-preview.technical_context.technical_score missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'rsi_level')), 'alert-preview.decision_context.market_state.rsi_level missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'bb_width_state')), 'alert-preview.decision_context.market_state.bb_width_state missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'confluence_signal')), 'alert-preview.decision_context.market_state.confluence_signal missing');
  assert(alertPreview.rows.every((row) => Object.prototype.hasOwnProperty.call(row.decision_context.market_state, 'technical_score')), 'alert-preview.decision_context.market_state.technical_score missing');
  assert(Array.isArray(alertPreview.growth_alert_context), 'alert-preview.growth_alert_context missing');
  checks.push(`alert-preview ok (${alertPreview.rows.length} rows)`);

  const syntheticSummary = await runSyntheticAlertPreviewCheck();
  checks.push(`synthetic alert-preview ok (${syntheticSummary})`);

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
