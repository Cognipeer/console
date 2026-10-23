/**
 * Retention registry: every log-shaped collection the console writes, and what
 * happens to its rows as they age.
 *
 * Two kinds of entry, and every one has a default duration:
 *   - targets          the engine ages them out by class (engine.ts);
 *   - legacy targets   an older, working mechanism keeps doing it (agent run
 *                      reconciler, entity-metrics purge...); listed with its
 *                      default so the retention page shows every duration in
 *                      one place.
 * The coverage test (retention-registry-coverage.test.ts) fails when a new log
 * collection lands in neither: a delete method nobody calls is how
 * `rag_query_logs` grew without bound.
 *
 * Enterprise modules add their own entries through `registerRetentionTarget`
 * and `registerLegacyRetentionTarget` (overlay registry).
 */

import { getConfig } from '@/lib/core/config';
import type { RetentionRedactField, RetentionWhere } from '@/lib/database/provider/types';
import type { RetentionClassId } from './classes';

export interface RetentionPhase {
  class: RetentionClassId;
  action: 'delete' | 'redact';
  /** `redact` only: the content fields cleared. */
  fields?: RetentionRedactField[];
  /** A duration that is not policy-driven (destruction records). */
  fixedDays?: () => number;
}

/** Child rows deleted together with each batch of parent rows. */
export interface RetentionCascade {
  parentField: string;
  children: Array<{ collection: string; field: string }>;
}

export interface RetentionTarget {
  id: string;
  collection: string;
  edition: 'core' | 'enterprise';
  /** What the rows are, for the retention page. */
  label: string;
  timeField: string;
  /** Present when rows carry a project, so project overrides apply. */
  projectField?: string;
  /** Applied in order of the policy: deletes before redactions (fewer rows left to rewrite). */
  phases: RetentionPhase[];
  /** Rows matching these are never touched (a running job, an open incident). */
  guard?: RetentionWhere[];
  cascade?: RetentionCascade;
  /** Further collections this entry accounts for (cascade children). */
  covers?: string[];
}

export interface LegacyRetentionTarget {
  id: string;
  collection: string;
  edition: 'core' | 'enterprise';
  label: string;
  class: RetentionClassId;
  /** What deletes the rows today. */
  managedBy: string;
  /** Where the duration is set. */
  setting: string;
  /** The default duration in days (the longest one when it can be set per record or per entity). */
  days: () => number;
  covers?: string[];
}

const NOT_RUNNING: RetentionWhere[] = [{ field: 'status', notIn: ['pending', 'queued', 'running'] }];

const clear = (field: string): RetentionRedactField => ({ field, clearTo: 'null' });
/** For columns the SQLite schema declares NOT NULL. */
const blank = (field: string): RetentionRedactField => ({ field, clearTo: 'empty' });

function contentAndTelemetry(fields: RetentionRedactField[]): RetentionPhase[] {
  return [
    { class: 'telemetry', action: 'delete' },
    { class: 'content', action: 'redact', fields },
  ];
}

const CORE_TARGETS: RetentionTarget[] = [
  {
    id: 'model_usage_logs', collection: 'model_usage_logs', edition: 'core',
    label: 'Model calls (prompt and response, tokens, cost)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: contentAndTelemetry([clear('providerRequest'), clear('providerResponse')]),
  },
  {
    id: 'guardrail_evaluation_logs', collection: 'guardrail_evaluation_logs', edition: 'core',
    label: 'Guardrail evaluations (the evaluated text)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: contentAndTelemetry([clear('inputText')]),
  },
  {
    id: 'mcp_request_logs', collection: 'mcp_request_logs', edition: 'core',
    label: 'MCP tool calls (request and response bodies)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: contentAndTelemetry([clear('requestPayload'), clear('responsePayload')]),
  },
  {
    id: 'tool_request_logs', collection: 'tool_request_logs', edition: 'core',
    label: 'Tool calls (request and response bodies)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: contentAndTelemetry([clear('requestPayload'), clear('responsePayload')]),
  },
  {
    id: 'rag_query_logs', collection: 'rag_query_logs', edition: 'core',
    label: 'Knowledge Engine queries',
    timeField: 'createdAt', projectField: 'projectId',
    phases: contentAndTelemetry([blank('query')]),
  },
  {
    id: 'reranker_run_logs', collection: 'reranker_run_logs', edition: 'core',
    label: 'Reranker runs',
    timeField: 'createdAt', projectField: 'projectId',
    phases: contentAndTelemetry([blank('query')]),
  },
  {
    id: 'websearch_run_logs', collection: 'websearch_run_logs', edition: 'core',
    label: 'Web searches (query, answer, results)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: contentAndTelemetry([blank('query'), clear('answer'), clear('results')]),
  },
  {
    id: 'vector_query_logs', collection: 'vector_query_logs', edition: 'core',
    label: 'Vector queries',
    timeField: 'timestamp', projectField: 'projectId',
    phases: [{ class: 'telemetry', action: 'delete' }],
  },
  {
    id: 'agent_tracing_sessions', collection: 'agent_tracing_sessions', edition: 'core',
    label: 'Agent traces (sessions and their events)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'trace', action: 'delete' }],
    cascade: { parentField: 'sessionId', children: [{ collection: 'agent_tracing_events', field: 'sessionId' }] },
    covers: ['agent_tracing_events'],
  },
  {
    id: 'agent_tracing_threads', collection: 'agent_tracing_threads', edition: 'core',
    label: 'Agent trace threads (rollups)',
    timeField: 'updatedAt', projectField: 'projectId',
    phases: [{ class: 'trace', action: 'delete' }],
  },
  {
    id: 'browser_session_events', collection: 'browser_session_events', edition: 'core',
    label: 'Browser session steps',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [
      { class: 'trace', action: 'delete' },
      { class: 'content', action: 'redact', fields: [clear('data')] },
    ],
  },
  {
    id: 'browser_sessions', collection: 'browser_sessions', edition: 'core',
    label: 'Browser sessions (last screenshot)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [
      { class: 'trace', action: 'delete' },
      { class: 'content', action: 'redact', fields: [clear('lastScreenshot')] },
    ],
    guard: [{ field: 'status', in: ['closed', 'errored', 'expired'] }],
  },
  {
    id: 'crawl_results', collection: 'crawl_results', edition: 'core',
    label: 'Crawled pages (page body)',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [
      { class: 'jobs', action: 'delete' },
      { class: 'content', action: 'redact', fields: [clear('bodyMarkdown')] },
    ],
  },
  {
    id: 'browser_flow_runs', collection: 'browser_flow_runs', edition: 'core',
    label: 'Browser flow runs',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'jobs', action: 'delete' }],
    guard: NOT_RUNNING,
  },
  {
    id: 'batch_job_items', collection: 'batch_job_items', edition: 'core',
    label: 'Batch API items (request and response bodies)',
    timeField: 'createdAt',
    phases: [
      { class: 'jobs', action: 'delete' },
      { class: 'content', action: 'redact', fields: [blank('requestBody'), clear('responseBody')] },
    ],
    guard: NOT_RUNNING,
  },
  {
    id: 'ocr_job_items', collection: 'ocr_job_items', edition: 'core',
    label: 'OCR job items (extracted text)',
    timeField: 'createdAt',
    phases: [
      { class: 'jobs', action: 'delete' },
      { class: 'content', action: 'redact', fields: [clear('result')] },
    ],
    guard: NOT_RUNNING,
  },
  {
    id: 'vector_migration_logs', collection: 'vector_migration_logs', edition: 'core',
    label: 'Vector migration batches',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'jobs', action: 'delete' }],
  },
  {
    id: 'rag_reindex_runs', collection: 'rag_reindex_runs', edition: 'core',
    label: 'Knowledge Engine re-index runs',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'jobs', action: 'delete' }],
    guard: NOT_RUNNING,
  },
  {
    id: 'evaluation_runs', collection: 'evaluation_runs', edition: 'core',
    label: 'Evaluation runs and their results',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'results', action: 'delete' }],
    guard: NOT_RUNNING,
  },
  {
    id: 'redteam_runs', collection: 'redteam_runs', edition: 'core',
    label: 'Red-team runs and their attempts',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'results', action: 'delete' }],
    guard: NOT_RUNNING,
  },
  {
    id: 'analysis_runs', collection: 'analysis_runs', edition: 'core',
    label: 'Analysis runs and their results',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'results', action: 'delete' }],
    guard: NOT_RUNNING,
  },
  {
    id: 'prescription_reports', collection: 'prescription_reports', edition: 'core',
    label: 'Cost prescription reports',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'results', action: 'delete' }],
    guard: NOT_RUNNING,
  },
  {
    id: 'alert_events', collection: 'alert_events', edition: 'core',
    label: 'Resolved alerts',
    timeField: 'firedAt', projectField: 'projectId',
    phases: [{ class: 'alerts', action: 'delete' }],
    guard: [{ field: 'status', in: ['resolved'] }],
  },
  {
    id: 'incidents', collection: 'incidents', edition: 'core',
    label: 'Resolved and closed incidents',
    timeField: 'firedAt', projectField: 'projectId',
    phases: [{ class: 'alerts', action: 'delete' }],
    guard: [{ field: 'status', in: ['resolved', 'closed'] }],
  },
  {
    id: 'inference_server_metrics', collection: 'inference_server_metrics', edition: 'core',
    label: 'Inference server metrics',
    timeField: 'createdAt',
    phases: [{ class: 'metrics', action: 'delete' }],
  },
  {
    id: 'gpu_fleet_events', collection: 'gpu_fleet_events', edition: 'core',
    label: 'GPU fleet events',
    timeField: 'createdAt',
    phases: [{ class: 'metrics', action: 'delete' }],
  },
  {
    id: 'usage_daily', collection: 'usage_daily', edition: 'core',
    label: 'Daily usage totals',
    timeField: 'day', projectField: 'projectId',
    phases: [{ class: 'usage', action: 'delete' }],
  },
  {
    id: 'audit_logs', collection: 'audit_logs', edition: 'core',
    label: 'Audit log',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'audit', action: 'delete' }],
    // Destruction records have their own, longer duration (below).
    guard: [{ field: 'service', notIn: ['retention'] }],
  },
  {
    id: 'retention_records', collection: 'audit_logs', edition: 'core',
    label: 'Destruction records (what retention deleted)',
    timeField: 'createdAt',
    phases: [{ class: 'audit', action: 'delete', fixedDays: () => getConfig().retention.recordsDays }],
    guard: [{ field: 'service', in: ['retention'] }],
  },
  {
    id: 'config_audit_logs', collection: 'config_audit_logs', edition: 'core',
    label: 'Config change log',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'audit', action: 'delete' }],
  },
  {
    id: 'mcp_audit_logs', collection: 'mcp_audit_logs', edition: 'core',
    label: 'MCP server change log',
    timeField: 'createdAt', projectField: 'projectId',
    phases: [{ class: 'audit', action: 'delete' }],
  },
];

const CORE_LEGACY_TARGETS: LegacyRetentionTarget[] = [
  {
    id: 'agent_runs', collection: 'agent_runs', edition: 'core', label: 'Background agent runs', class: 'jobs',
    managedBy: 'Agent run reconciler', setting: 'AGENT_RUN_RETENTION_DAYS', days: () => getConfig().agent.runRetentionDays,
  },
  {
    id: 'agent_session_events', collection: 'agent_session_events', edition: 'core', label: 'Agent session event log', class: 'trace',
    managedBy: 'TTL index + agent run reconciler', setting: 'AGENT_SESSION_EVENT_RETENTION_DAYS',
    days: () => getConfig().agent.sessionEventRetentionDays,
  },
  {
    id: 'webhook_deliveries', collection: 'webhook_deliveries', edition: 'core', label: 'Outgoing webhook deliveries', class: 'delivery',
    managedBy: 'Agent run reconciler', setting: 'WEBHOOK_DELIVERY_RETENTION_DAYS', days: () => getConfig().webhooks.deliveryRetentionDays,
  },
  {
    id: 'agent_trigger_deliveries', collection: 'agent_trigger_deliveries', edition: 'core', label: 'Incoming trigger webhooks', class: 'delivery',
    managedBy: 'Agent run reconciler', setting: 'Built in', days: () => 7,
  },
  {
    id: 'alert_deliveries', collection: 'alert_deliveries', edition: 'core', label: 'Alert notification attempts', class: 'delivery',
    managedBy: 'Alert delivery log', setting: 'Built in', days: () => 30,
  },
  {
    id: 'scheduler_claims', collection: 'scheduler_claims', edition: 'core', label: 'Scheduler claims', class: 'delivery',
    managedBy: 'Agent run reconciler', setting: 'Built in (expiry stored on each claim)', days: () => 7,
  },
  {
    id: 'entity_metrics', collection: 'entity_metrics', edition: 'core', label: 'Entity health buckets', class: 'metrics',
    managedBy: 'TTL index + entity metrics rollup', setting: 'ENTITY_METRICS_RETENTION_DAYS',
    days: () => getConfig().health.entityMetricsRetentionDays,
  },
  {
    id: 'session_files', collection: 'files', edition: 'core', label: 'Agent session files', class: 'jobs',
    managedBy: 'Agent run reconciler', setting: 'Each agent\'s attachments.retentionDays', days: () => 30,
  },
];

const extraTargets: RetentionTarget[] = [];
const extraLegacy: LegacyRetentionTarget[] = [];

/** Adds an engine-managed target (enterprise modules). Registering the same id again is ignored. */
export function registerRetentionTarget(target: RetentionTarget): void {
  if (getRetentionTargets().some((t) => t.id === target.id)) return;
  extraTargets.push(target);
}

/** Lists a collection whose rows another mechanism ages out (enterprise modules). */
export function registerLegacyRetentionTarget(target: LegacyRetentionTarget): void {
  if (getLegacyRetentionTargets().some((t) => t.id === target.id)) return;
  extraLegacy.push(target);
}

export function getRetentionTargets(): RetentionTarget[] {
  return [...CORE_TARGETS, ...extraTargets];
}

export function getLegacyRetentionTargets(): LegacyRetentionTarget[] {
  return [...CORE_LEGACY_TARGETS, ...extraLegacy];
}

/** The classes at least one engine target uses: the ones a tenant policy can change. */
export function policyDrivenClasses(): Set<RetentionClassId> {
  const classes = new Set<RetentionClassId>();
  for (const target of getRetentionTargets()) {
    for (const phase of target.phases) {
      if (!phase.fixedDays) classes.add(phase.class);
    }
  }
  return classes;
}
