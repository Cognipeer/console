/**
 * The `analyticsDashboards` namespace: the config-driven dashboards index and
 * renderer (/dashboard/analytics). Dashboard, widget and variable titles come
 * from the server-side dashboard configs (English); the keys under `dashboards`
 * and `entityHealth` below translate the entity health dashboards by stable id
 * and fall back to the server string when a key is absent. Turkish counterpart in
 * analyticsDashboards.tr.ts must keep the same keys.
 */

export const analyticsDashboardsEn = {
  eyebrow: 'Analytics',
  indexTitle: 'Dashboards',
  indexSubtitle: 'Prebuilt, config-driven dashboards across your services',
  loadingList: 'Loading dashboards...',
  listError: 'The dashboards could not be loaded.',
  emptyList: 'No dashboards available for your permissions.',
  widgetCount: '{count} widgets',
  lockedTitle: 'Analytics is an Enterprise feature',
  lockedIndexBody: 'Activate an Enterprise license to unlock prebuilt cross-service dashboards.',
  lockedBody: 'Activate an Enterprise license to unlock dashboards.',
  viewLicense: 'View license',
  dashboardTitle: 'Dashboard',
  notFoundTitle: 'Dashboard not found',
  notFoundBody: 'This dashboard does not exist or you cannot view it.',
  allDashboards: 'All dashboards',
  scopeProject: 'This project',
  scopeTenant: 'All projects',
  refresh: 'Refresh',
  exportCsv: 'CSV',
  loadError: 'This dashboard could not be loaded.',
  retry: 'Retry',
  unavailable: 'Dashboard data is unavailable.',
  variableAll: 'All',
  variableNothing: 'Nothing found',
  variableOptionsError: 'The list could not be loaded.',
  widgetUnavailable: 'Data unavailable for this widget.',
  noData: 'No data.',
  noRows: 'No rows in range.',
  unsupportedWidget: 'Unsupported widget.',
  vsPrevious: 'vs previous period',
  vsPreviousPoints: 'pts vs previous period',
  scoreboardName: 'Name',
  dashboards: {
    'agent-health': {
      title: 'Agent Health',
      description: 'Per-agent sessions, failure rate, duration and cost, from external SDK traces and hosted runs.',
    },
    'model-health': {
      title: 'Model Health',
      description: 'Per-model request volume, error rate, latency percentiles and spend, gateway and traced calls.',
    },
    'kb-health': {
      title: 'Knowledge Base Health',
      description: 'Per-knowledge-base query volume, error rate and retrieval latency.',
    },
    'mcp-health': {
      title: 'MCP Server Health',
      description: 'Per-server tool-call volume, error rate and latency.',
    },
    'tool-health': {
      title: 'Tool Health',
      description: 'Per-tool invocation volume, error rate and latency.',
    },
  },
  entityHealth: {
    units: { agent: 'Sessions', model: 'Requests', kb: 'Queries', mcp: 'Calls', tool: 'Invocations' },
    entities: { agent: 'Agent', model: 'Model', kb: 'Knowledge base', mcp: 'MCP server', tool: 'Tool' },
    widgets: {
      requests: '{unit}',
      'error-rate': 'Error rate',
      p95: 'p95 latency',
      cost: 'Cost',
      volume: '{unit} and errors',
      'error-rate-over-time': 'Error rate',
      'latency-over-time': 'Latency p50 / p95',
      scoreboard: '{entity} scoreboard',
    },
    subtitles: { scoreboard: 'Ordered by traffic; pick one above to focus on it.' },
    measures: { errors: 'Errors', errorRate: 'Error rate', p50: 'p50', p95: 'p95', cost: 'Cost' },
  },
};
