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
  checks.push(`alert-preview ok (${alertPreview.rows.length} rows)`);

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
