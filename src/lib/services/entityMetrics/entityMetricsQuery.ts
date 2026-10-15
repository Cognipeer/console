/**
 * Pure read-side math over entity_metrics counters: the single formula table
 * used by alert evaluation, the health APIs and the reports.
 */

import type { AlertMetric } from '@/lib/database/provider/types.domain';
import {
  ENTITY_METRIC_BUCKET_MS,
  type EntityMetricCounters,
  type EntityMetricType,
} from '@/lib/database/provider/types.base';
import { emptyCounters, mergeCounters, quantileFromCounters } from './latencyHistogram';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Rates are percentages in 0..100; null when the denominator is empty. */
export interface DerivedMetrics {
  requests: number;
  errors: number;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  maxMs: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  errorEvents: number;
  toolCalls: number;
  toolErrors: number;
  toolErrorRate: number | null;
  aiCalls: number;
  aiErrors: number;
  aiErrorRate: number | null;
  abandoned: number;
  abandonedRate: number | null;
  emptyResults: number;
  emptyResultRate: number | null;
}

export interface EntityMetricValue {
  value: number | null;
  sampleCount: number;
}

function n(value: unknown): number {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
}

/** Percentage clamped to 0..100 (late corrections can land in a different bucket than the request they correct). */
function pct(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.min(Math.max((numerator / denominator) * 100, 0), 100);
}

function ratio(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return numerator / denominator;
}

/** Normalise an aggregate row (or partial counters) into a complete counter set. */
export function toCounters(source: Partial<EntityMetricCounters> | null | undefined): EntityMetricCounters {
  const out = emptyCounters();
  if (!source) return out;
  return mergeCounters(out, source as EntityMetricCounters);
}

/**
 * Derive every dashboard metric from one counter set. The error rate follows
 * the same denominator as the alert formula in `computeEntityMetric`: only
 * models exclude cancelled requests; every other entity type uses `requests`.
 * Omitting `entityType` uses `requests` (the non-model formula).
 */
export function deriveMetrics(counters: EntityMetricCounters, entityType?: EntityMetricType): DerivedMetrics {
  const c = counters;
  const requests = n(c.requests);
  const errors = n(c.errors);
  const settled = entityType === 'model' ? Math.max(requests - n(c.cancelled), 0) : requests;
  const latencyCount = n(c.latencyCount);
  const hasLatency = latencyCount > 0;
  return {
    requests,
    errors,
    errorRate: pct(errors, settled),
    p50Ms: quantileFromCounters(c, 0.5),
    p95Ms: quantileFromCounters(c, 0.95),
    p99Ms: quantileFromCounters(c, 0.99),
    avgMs: hasLatency ? n(c.latencyMsSum) / latencyCount : null,
    maxMs: hasLatency ? n(c.latencyMsMax) : null,
    costUsd: n(c.costUsd),
    inputTokens: n(c.inputTokens),
    outputTokens: n(c.outputTokens),
    errorEvents: n(c.errorEvents),
    toolCalls: n(c.toolCalls),
    toolErrors: n(c.toolErrors),
    toolErrorRate: pct(n(c.toolErrors), n(c.toolCalls)),
    aiCalls: n(c.aiCalls),
    aiErrors: n(c.aiErrors),
    aiErrorRate: pct(n(c.aiErrors), n(c.aiCalls)),
    abandoned: n(c.abandoned),
    abandonedRate: pct(n(c.abandoned), requests),
    emptyResults: n(c.emptyResults),
    emptyResultRate: pct(n(c.emptyResults), Math.max(requests - errors, 0)),
  };
}

function avgLatency(c: EntityMetricCounters): EntityMetricValue {
  const count = n(c.latencyCount);
  return { value: count > 0 ? n(c.latencyMsSum) / count : null, sampleCount: count };
}

function p95Latency(c: EntityMetricCounters): EntityMetricValue {
  return { value: quantileFromCounters(c, 0.95), sampleCount: n(c.latencyCount) };
}

/**
 * Exact numerator and denominator of every metric that is a percentage of two
 * counters, or null for any other metric. `computeEntityMetric` derives its
 * value and sample count from this, so the two cannot drift; baselines use the
 * counts to weigh a rate by how many events stand behind it. The numerator is
 * clamped to 0..den like the percentage (late corrections can land in another
 * bucket than the request they correct); den may be 0.
 */
export function proportionOf(metric: AlertMetric, c: EntityMetricCounters): { num: number; den: number } | null {
  let num: number;
  let den: number;
  switch (metric) {
    case 'agent_error_rate':
    case 'kb_error_rate':
    case 'mcp_server_error_rate':
    case 'tool_error_rate':
      num = n(c.errors);
      den = n(c.requests);
      break;
    // only models exclude cancelled requests
    case 'model_error_rate':
      num = n(c.errors);
      den = Math.max(n(c.requests) - n(c.cancelled), 0);
      break;
    case 'agent_tool_error_rate':
      num = n(c.toolErrors);
      den = n(c.toolCalls);
      break;
    case 'agent_ai_error_rate':
      num = n(c.aiErrors);
      den = n(c.aiCalls);
      break;
    case 'agent_abandoned_rate':
      num = n(c.abandoned);
      den = n(c.requests);
      break;
    case 'kb_empty_result_rate':
      num = n(c.emptyResults);
      den = Math.max(n(c.requests) - n(c.errors), 0);
      break;
    default:
      return null;
  }
  return { num: Math.min(Math.max(num, 0), den), den };
}

/**
 * Single formula table for every entity metric (see the metric catalog).
 * `value` is null when the metric is undefined for the counters (empty
 * denominator); `sampleCount` is what `minSamples` is compared against.
 * Non-entity metrics yield `{ value: null, sampleCount: 0 }`.
 */
export function computeEntityMetric(metric: AlertMetric, c: EntityMetricCounters): EntityMetricValue {
  const proportion = proportionOf(metric, c);
  if (proportion) return { value: pct(proportion.num, proportion.den), sampleCount: proportion.den };
  switch (metric) {
    // agents
    case 'agent_sessions':
      return { value: n(c.requests), sampleCount: n(c.requests) };
    case 'agent_error_events':
      return { value: n(c.errorEvents), sampleCount: n(c.requests) + n(c.aiCalls) + n(c.toolCalls) };
    case 'agent_p95_duration_ms':
      return p95Latency(c);
    case 'agent_avg_duration_ms':
      return avgLatency(c);
    case 'agent_cost':
      return { value: n(c.costUsd), sampleCount: n(c.requests) + n(c.aiCalls) };
    case 'agent_tokens_per_session':
      return { value: ratio(n(c.inputTokens) + n(c.outputTokens), n(c.requests)), sampleCount: n(c.requests) };

    // models
    case 'model_requests':
      return { value: n(c.requests), sampleCount: n(c.requests) };
    case 'model_p95_latency_ms':
      return p95Latency(c);
    case 'model_avg_latency_ms':
      return avgLatency(c);
    case 'model_cost':
      return { value: n(c.costUsd), sampleCount: n(c.requests) };

    // knowledge bases
    case 'kb_queries':
      return { value: n(c.requests), sampleCount: n(c.requests) };
    case 'kb_p95_latency_ms':
      return p95Latency(c);
    case 'kb_avg_latency_ms':
      return avgLatency(c);

    // MCP servers
    case 'mcp_server_requests':
      return { value: n(c.requests), sampleCount: n(c.requests) };
    case 'mcp_server_p95_latency_ms':
      return p95Latency(c);

    // tools
    case 'tool_calls':
      return { value: n(c.requests), sampleCount: n(c.requests) };
    case 'tool_p95_latency_ms':
      return p95Latency(c);

    default:
      return { value: null, sampleCount: 0 };
  }
}

/** Bucket size for charts: <= 6h -> 5 min, <= 48h -> 1 h, otherwise 1 day. */
export function pickBucketMs(fromMs: number, toMs: number): number {
  const span = toMs - fromMs;
  if (span <= 6 * HOUR_MS) return ENTITY_METRIC_BUCKET_MS;
  if (span <= 48 * HOUR_MS) return HOUR_MS;
  return DAY_MS;
}
