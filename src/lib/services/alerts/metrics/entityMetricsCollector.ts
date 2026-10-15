/**
 * Entity metrics collector.
 *
 * Serves every per-entity metric (agents, models, knowledge bases, MCP servers,
 * tools) from the `entity_metrics` rollup: one value for a single scope
 * (`collect`) or one per entity (`collectByEntity`). The formulas live in
 * `computeEntityMetric`; this file only picks the window and the counters.
 */

import { getConfig } from '@/lib/core/config';
import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric, EntityMetricCounters, EntityMetricType } from '@/lib/database';
import { ENTITY_METRIC_BUCKET_MS } from '@/lib/database/provider/types.base';
import { computeEntityMetric, toCounters } from '@/lib/services/entityMetrics';
import { ALERT_METRIC_CATALOG, getMetricDef } from '../metricCatalog';
import type { EntityMetricQuery, IMetricCollector, MetricQuery, MetricResult } from './types';

const MINUTE_MS = 60_000;

/** Fallback for the rollup flush interval when the configuration cannot be read. */
const DEFAULT_ENTITY_METRICS_FLUSH_MS = 30_000;

function entityMetricsFlushMs(): number {
  try {
    const value = getConfig().health.entityMetricsFlushMs;
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_ENTITY_METRICS_FLUSH_MS;
  } catch {
    return DEFAULT_ENTITY_METRICS_FLUSH_MS;
  }
}

/**
 * `[align5(settled) - window, align5(settled))` with `settled = now - flushInterval`: whole rollup
 * buckets only, so a half-filled bucket never skews a rate, and only buckets the in-memory rollup
 * buffer (flushed every `entityMetricsFlushMs`, per pod) has had time to write, so a count or `lt`
 * rule never judges a bucket whose last seconds are still unflushed.
 */
export function entityEvaluationWindow(nowMs: number, windowMinutes: number): { fromMs: number; toMs: number } {
  const settledMs = nowMs - entityMetricsFlushMs();
  const toMs = settledMs - (settledMs % ENTITY_METRIC_BUCKET_MS);
  return { fromMs: toMs - windowMinutes * MINUTE_MS, toMs };
}

export interface EntityCountersInput {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  entityType: EntityMetricType;
  fromMs: number;
  toMs: number;
  /** Omit for every entity with data. */
  entityKeys?: string[];
}

/** Counters per entity key over `[fromMs, toMs)` (entities without rows are absent from the map). */
export async function aggregateEntityCounters(input: EntityCountersInput): Promise<Map<string, EntityMetricCounters>> {
  const db = await getTenantDatabase(input.tenantDbName);
  const rows = await db.aggregateEntityMetrics({
    tenantId: input.tenantId,
    projectId: input.projectId,
    entityType: input.entityType,
    ...(input.entityKeys ? { entityKeys: input.entityKeys } : {}),
    fromMs: input.fromMs,
    toMs: input.toMs,
    groupBy: ['entityKey'],
  });
  const out = new Map<string, EntityMetricCounters>();
  for (const row of rows) {
    if (!row.entityKey) continue;
    out.set(row.entityKey, toCounters(row));
  }
  return out;
}

/** The legacy scope field that names the one entity of a single-scope `collect`, when there is one. */
function scopeKeyFor(query: MetricQuery, entityType: EntityMetricType): string | undefined {
  switch (entityType) {
    case 'model': return query.scope?.modelKey;
    case 'kb': return query.scope?.ragModuleKey;
    case 'mcp': return query.scope?.mcpServerKey;
    default: return undefined;
  }
}

export class EntityMetricsCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = ALERT_METRIC_CATALOG
    .filter((def) => def.source === 'entity')
    .map((def) => def.id);

  async collect(query: MetricQuery): Promise<MetricResult> {
    const def = getMetricDef(query.metric);
    if (!def || def.source !== 'entity' || !def.entityType) return { value: 0, sampleCount: 0 };
    const projectId = query.scope?.projectId;
    if (projectId === undefined) return { value: 0, sampleCount: 0 };

    const nowMs = Date.now();
    const { fromMs, toMs } = entityEvaluationWindow(nowMs, query.windowMinutes);
    const db = await getTenantDatabase(query.tenantDbName);
    const key = scopeKeyFor(query, def.entityType);
    const rows = await db.aggregateEntityMetrics({
      tenantId: query.tenantId,
      projectId,
      entityType: def.entityType,
      ...(key ? { entityKeys: [key] } : {}),
      fromMs,
      toMs,
      groupBy: [],
    });
    const { value, sampleCount } = computeEntityMetric(query.metric, toCounters(rows[0]));
    return { value: value ?? 0, sampleCount };
  }

  async collectByEntity(query: EntityMetricQuery): Promise<Map<string, MetricResult>> {
    const def = getMetricDef(query.metric);
    const out = new Map<string, MetricResult>();
    if (!def || def.source !== 'entity' || !def.entityType) return out;
    const projectId = query.scope?.projectId;
    if (projectId === undefined) return out;

    const { fromMs, toMs } = entityEvaluationWindow(query.nowMs ?? Date.now(), query.windowMinutes);
    const counters = await aggregateEntityCounters({
      tenantDbName: query.tenantDbName,
      tenantId: query.tenantId,
      projectId,
      entityType: def.entityType,
      fromMs,
      toMs,
      entityKeys: query.entityKeys,
    });
    for (const [key, c] of counters) {
      const { value, sampleCount } = computeEntityMetric(query.metric, c);
      out.set(key, { value: value ?? 0, sampleCount });
    }
    return out;
  }
}
