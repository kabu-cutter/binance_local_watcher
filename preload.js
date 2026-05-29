const { contextBridge, ipcRenderer } = require('electron');

async function invokeEngine(route, payload) {
  const result = await ipcRenderer.invoke('blw:engine', route, payload || {});
  if (!result?.ok) throw new Error(result?.error || `Local engine failed: ${route}`);
  return result.data;
}

contextBridge.exposeInMainWorld('blw', {
  version: 'electron-node-engine-v0.5-phase1-db',
  engineMode: 'electron-main-node-engine',
  safetyMode: 'read-only-market-data-and-local-calculation',
  capabilities: {
    ui: ['display', 'input', 'navigation'],
    backend: ['public_price_fetch', 'history_csv', 'sqlite_phase1_cache', 'chart_data', 'local_calculation'],
    forbidden: ['real_order', 'auto_trading', 'withdrawal', 'api_key_storage', 'secret_storage'],
  },
  api: {
    getStatus: () => invokeEngine('status'),
    getCapabilities: () => invokeEngine('capabilities'),
    getContract: () => invokeEngine('contract'),
    getApiReadiness: () => invokeEngine('api-readiness'),
    getDbStatus: () => invokeEngine('db-status'),
    getSummary: () => invokeEngine('summary'),
    getImpact: (query) => invokeEngine('impact', { query }),
    getAlertPreview: (query) => invokeEngine('alert-preview', { query }),
    getAlertHistory: (query) => invokeEngine('alert-history', { query }),
    getDailyGoalReports: (query) => invokeEngine('daily-goal-reports', { query }),
    getChart: (query) => invokeEngine('chart', { query }),
    getChartCoverage: (query) => invokeEngine('chart-coverage', { query }),
    getAnalysisCacheStatus: (query) => invokeEngine('analysis-cache-status', { query }),
    fetchPrices: () => invokeEngine('fetch-prices'),
    downloadHistory: (body) => invokeEngine('download-history', { body }),
    updateHistoryToNow: (body) => invokeEngine('update-history-to-now', { body }),
    ensureAnalysisCache: (body) => invokeEngine('ensure-analysis-cache', { body }),
    tradePreview: (body) => invokeEngine('trade-preview', { body }),
    dailyGoal: (body) => invokeEngine('daily-goal', { body }),
    saveDailyGoalReport: (body) => invokeEngine('save-daily-goal-report', { body }),
    clearAlertHistory: () => invokeEngine('clear-alert-history'),
    clearDailyGoalReports: () => invokeEngine('clear-daily-goal-reports'),
  },
});
