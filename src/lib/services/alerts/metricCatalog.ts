/**
 * Alert metric catalog — the server-side single source of truth for every
 * alertable metric: its module, label, unit, supported condition modes and
 * whether it is evaluated per entity (from `entity_metrics`) or by a legacy
 * collector over one scope.
 *
 * The module-to-metrics table, email/notification labels and units, and the
 * UI (served to the client as `meta.catalog`) all derive from this list. The
 * entity metric formulas live in `entityMetrics/entityMetricsQuery.ts`
 * (`computeEntityMetric`).
 */

import type {
  AlertConditionMode,
  AlertMetric,
  AlertModule,
  EntityMetricType,
} from '@/lib/database';

export interface AlertMetricDef {
  id: AlertMetric;
  module: AlertModule;
  /** Standalone English label (used by email and chat notifications). */
  label: string;
  unit: '%' | 'ms' | '$' | 'count' | 'score' | '';
  /** 'entity' metrics are evaluated per entity from entity_metrics; 'legacy' ones by a collector over one scope. */
  source: 'legacy' | 'entity';
  entityType?: EntityMetricType;
  /** Condition modes the metric supports ('threshold' always). */
  modes: AlertConditionMode[];
  goodDirection: 'down' | 'up';
  /** Count metrics evaluate as 0 when there are no samples, so "less than" rules can fire. */
  zeroWhenEmpty?: boolean;
  /** Legacy duplicates and deprecated spellings: not offered when authoring a new rule. */
  hiddenForNewRules?: boolean;
}

/** Entity metric to alert module (and back through `entityType`). */
export const MODULE_ENTITY_TYPE: Partial<Record<AlertModule, EntityMetricType>> = {
  agents: 'agent',
  models: 'model',
  rag: 'kb',
  mcp: 'mcp',
  tools: 'tool',
};

type LegacyOptions = Pick<AlertMetricDef, 'hiddenForNewRules'>;

function legacy(
  id: AlertMetric,
  module: AlertModule,
  label: string,
  unit: AlertMetricDef['unit'],
  goodDirection: AlertMetricDef['goodDirection'],
  options: LegacyOptions = {},
): AlertMetricDef {
  return {
    id,
    module,
    label,
    unit,
    source: 'legacy',
    modes: ['threshold'],
    goodDirection,
    ...(options.hiddenForNewRules ? { hiddenForNewRules: true } : {}),
  };
}

const ENTITY_MODES: AlertConditionMode[] = ['threshold', 'baseline', 'absence'];
const ENTITY_SLO_MODES: AlertConditionMode[] = ['threshold', 'baseline', 'absence', 'slo_burn'];

function entity(
  id: AlertMetric,
  module: AlertModule,
  entityType: EntityMetricType,
  label: string,
  unit: AlertMetricDef['unit'],
  goodDirection: AlertMetricDef['goodDirection'],
  options: { slo?: boolean; zeroWhenEmpty?: boolean } = {},
): AlertMetricDef {
  return {
    id,
    module,
    label,
    unit,
    source: 'entity',
    entityType,
    modes: options.slo ? [...ENTITY_SLO_MODES] : [...ENTITY_MODES],
    goodDirection,
    ...(options.zeroWhenEmpty ? { zeroWhenEmpty: true } : {}),
  };
}

export const ALERT_METRIC_CATALOG: AlertMetricDef[] = [
  // ── models (legacy; per-model entity metrics below) ───────────────────
  legacy('error_rate', 'models', 'Error Rate', '%', 'down', { hiddenForNewRules: true }),
  legacy('avg_latency_ms', 'models', 'Average Latency', 'ms', 'down', { hiddenForNewRules: true }),
  legacy('p95_latency_ms', 'models', 'P95 Latency', 'ms', 'down', { hiddenForNewRules: true }),
  legacy('total_cost', 'models', 'Total Cost', '$', 'down', { hiddenForNewRules: true }),
  legacy('total_requests', 'models', 'Total Requests', '', 'up', { hiddenForNewRules: true }),

  // ── inference ─────────────────────────────────────────────────────────
  legacy('gpu_cache_usage', 'inference', 'GPU Cache Usage', '%', 'down'),
  legacy('request_queue_depth', 'inference', 'Request Queue Depth', '', 'down'),

  // ── guardrails (+ the deprecated aegis spellings stored rules may carry) ──
  legacy('guardrail_fail_rate', 'guardrails', 'Guardrail Fail Rate', '%', 'down'),
  legacy('guardrail_avg_latency_ms', 'guardrails', 'Guardrail Avg Latency', 'ms', 'down'),
  legacy('guardrail_total_evaluations', 'guardrails', 'Guardrail Total Evaluations', '', 'up'),
  legacy('guardrail_block_rate', 'guardrails', 'Guardrail Block Rate', '%', 'down'),
  legacy('guardrail_approval_rate', 'guardrails', 'Guardrail Approval Rate', '%', 'down'),
  legacy('guardrail_avg_risk_score', 'guardrails', 'Guardrail Avg Risk Score', '', 'down'),
  legacy('guardrail_total_decisions', 'guardrails', 'Guardrail Total Decisions', '', 'up'),
  legacy('aegis_block_rate', 'guardrails', 'Guardrail Block Rate', '%', 'down', { hiddenForNewRules: true }),
  legacy('aegis_approval_rate', 'guardrails', 'Guardrail Approval Rate', '%', 'down', { hiddenForNewRules: true }),
  legacy('aegis_avg_risk_score', 'guardrails', 'Guardrail Avg Risk Score', '', 'down', { hiddenForNewRules: true }),
  legacy('aegis_total_decisions', 'guardrails', 'Guardrail Total Decisions', '', 'up', { hiddenForNewRules: true }),

  // ── rag ───────────────────────────────────────────────────────────────
  legacy('rag_avg_latency_ms', 'rag', 'Knowledge Engine Avg Query Latency', 'ms', 'down', { hiddenForNewRules: true }),
  legacy('rag_total_queries', 'rag', 'Knowledge Engine Total Queries', '', 'up', { hiddenForNewRules: true }),
  legacy('rag_failed_documents', 'rag', 'Knowledge Engine Failed Documents', '', 'down'),

  // ── mcp ───────────────────────────────────────────────────────────────
  legacy('mcp_error_rate', 'mcp', 'MCP Error Rate', '%', 'down', { hiddenForNewRules: true }),
  legacy('mcp_avg_latency_ms', 'mcp', 'MCP Average Latency', 'ms', 'down', { hiddenForNewRules: true }),
  legacy('mcp_total_requests', 'mcp', 'MCP Total Requests', '', 'up', { hiddenForNewRules: true }),

  // ── analysis / evaluation / red team (percentages averaged over completed runs) ──
  legacy('analysis_pass_rate', 'analysis', 'Analysis Pass Rate', '%', 'up'),
  legacy('analysis_avg_judge_score', 'analysis', 'Analysis Avg Judge Score', '%', 'up'),
  legacy('analysis_avg_accuracy', 'analysis', 'Analysis Avg Accuracy', '%', 'up'),
  legacy('evaluation_pass_rate', 'evaluation', 'Evaluation Pass Rate', '%', 'up'),
  legacy('evaluation_avg_score', 'evaluation', 'Evaluation Avg Score', '%', 'up'),
  legacy('redteam_attack_success_rate', 'redteam', 'Red Team Attack Success Rate', '%', 'down'),
  legacy('redteam_resilience_score', 'redteam', 'Red Team Resilience Score', '%', 'up'),

  // ── AI App Gateway (collector lives in the enterprise build) ───────────
  legacy('appgw_requests', 'ai-app-gateway', 'AI App Gateway Requests', '', 'up'),
  legacy('appgw_block_rate', 'ai-app-gateway', 'AI App Gateway Block Rate', '%', 'down'),
  legacy('appgw_error_rate', 'ai-app-gateway', 'AI App Gateway Error Rate', '%', 'down'),
  legacy('appgw_requests_per_user', 'ai-app-gateway', 'AI App Gateway Busiest User (requests)', '', 'up'),
  legacy('appgw_output_limit_turns', 'ai-app-gateway', 'AI App Gateway Output-Limit Turns', '', 'down'),
  legacy('appgw_output_limit_rate', 'ai-app-gateway', 'AI App Gateway Output-Limit Rate', '%', 'down'),

  // ── agents (entity_metrics; traced and hosted agents) ──────────────────
  entity('agent_sessions', 'agents', 'agent', 'Agent Sessions', 'count', 'up', { zeroWhenEmpty: true }),
  entity('agent_error_rate', 'agents', 'agent', 'Agent Error Rate', '%', 'down', { slo: true }),
  entity('agent_error_events', 'agents', 'agent', 'Agent Error Events', 'count', 'down', { zeroWhenEmpty: true }),
  entity('agent_tool_error_rate', 'agents', 'agent', 'Agent Tool Error Rate', '%', 'down'),
  entity('agent_ai_error_rate', 'agents', 'agent', 'Agent AI Call Error Rate', '%', 'down'),
  entity('agent_p95_duration_ms', 'agents', 'agent', 'Agent P95 Duration', 'ms', 'down', { slo: true }),
  entity('agent_avg_duration_ms', 'agents', 'agent', 'Agent Average Duration', 'ms', 'down'),
  entity('agent_abandoned_rate', 'agents', 'agent', 'Agent Abandoned Rate', '%', 'down'),
  entity('agent_cost', 'agents', 'agent', 'Agent Cost', '$', 'down', { zeroWhenEmpty: true }),
  entity('agent_tokens_per_session', 'agents', 'agent', 'Agent Tokens per Session', 'count', 'down'),

  // ── per-model health ───────────────────────────────────────────────────
  entity('model_requests', 'models', 'model', 'Model Requests', 'count', 'up', { zeroWhenEmpty: true }),
  entity('model_error_rate', 'models', 'model', 'Model Error Rate', '%', 'down', { slo: true }),
  entity('model_p95_latency_ms', 'models', 'model', 'Model P95 Latency', 'ms', 'down', { slo: true }),
  entity('model_avg_latency_ms', 'models', 'model', 'Model Average Latency', 'ms', 'down'),
  entity('model_cost', 'models', 'model', 'Model Cost', '$', 'down', { zeroWhenEmpty: true }),

  // ── per-knowledge-base health ──────────────────────────────────────────
  entity('kb_queries', 'rag', 'kb', 'Knowledge Base Queries', 'count', 'up', { zeroWhenEmpty: true }),
  entity('kb_error_rate', 'rag', 'kb', 'Knowledge Base Error Rate', '%', 'down', { slo: true }),
  entity('kb_p95_latency_ms', 'rag', 'kb', 'Knowledge Base P95 Latency', 'ms', 'down', { slo: true }),
  entity('kb_avg_latency_ms', 'rag', 'kb', 'Knowledge Base Average Latency', 'ms', 'down'),
  entity('kb_empty_result_rate', 'rag', 'kb', 'Knowledge Base Empty Result Rate', '%', 'down'),

  // ── per-MCP-server health ──────────────────────────────────────────────
  entity('mcp_server_requests', 'mcp', 'mcp', 'MCP Server Requests', 'count', 'up', { zeroWhenEmpty: true }),
  entity('mcp_server_error_rate', 'mcp', 'mcp', 'MCP Server Error Rate', '%', 'down', { slo: true }),
  entity('mcp_server_p95_latency_ms', 'mcp', 'mcp', 'MCP Server P95 Latency', 'ms', 'down', { slo: true }),

  // ── per-tool health ────────────────────────────────────────────────────
  entity('tool_calls', 'tools', 'tool', 'Tool Calls', 'count', 'up', { zeroWhenEmpty: true }),
  entity('tool_error_rate', 'tools', 'tool', 'Tool Error Rate', '%', 'down', { slo: true }),
  entity('tool_p95_latency_ms', 'tools', 'tool', 'Tool P95 Latency', 'ms', 'down', { slo: true }),
];

const BY_ID = new Map<AlertMetric, AlertMetricDef>(ALERT_METRIC_CATALOG.map((def) => [def.id, def]));

export function getMetricDef(id: AlertMetric | string): AlertMetricDef | undefined {
  return BY_ID.get(id as AlertMetric);
}

/**
 * Module to metric ids. The deprecated `aegis` module points at the same list
 * as `guardrails` so a stored rule filed under it still resolves its metric.
 */
export const ALERT_MODULE_METRICS: Record<AlertModule, AlertMetric[]> = (() => {
  const table: Record<AlertModule, AlertMetric[]> = {
    models: [],
    inference: [],
    guardrails: [],
    rag: [],
    mcp: [],
    analysis: [],
    evaluation: [],
    redteam: [],
    aegis: [],
    'ai-app-gateway': [],
    agents: [],
    tools: [],
  };
  for (const def of ALERT_METRIC_CATALOG) table[def.module].push(def.id);
  table.aegis = table.guardrails;
  return table;
})();
