/**
 * Prometheus exporter — tracing + entity health families.
 *
 * These used to be computed from the newest 50 tracing sessions and typed as
 * counters; they are now typed 24h window gauges read from the entity_metrics
 * rollup, cached briefly per tenant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({
  getTenantDatabase: vi.fn(),
}));

import { getTenantDatabase } from '@/lib/database';
import {
  __resetPrometheusHealthCacheForTests,
  collectPrometheusMetrics,
} from '@/lib/services/metrics/prometheusExporter';

const DAY_MS = 24 * 60 * 60 * 1000;

type MockDb = ReturnType<typeof createMockDb>;

function entityRow(over: Record<string, unknown>) {
  return { requests: 0, errors: 0, ...over };
}

function primeDb(): MockDb {
  const db = createMockDb();
  db.aggregateEntityMetrics.mockImplementation((async (q: { groupBy: string[]; entityType?: string }) => {
    if (q.groupBy.includes('entityKey')) {
      return [
        entityRow({ entityKey: 'pulse-main', requests: 10 }),
        entityRow({ entityKey: 'idle-agent', requests: 0 }),
        entityRow({ entityKey: 'helper', requests: 3 }),
      ];
    }
    return [
      entityRow({ entityType: 'agent', requests: 13, errors: 2, abandoned: 1, inputTokens: 1200, outputTokens: 300 }),
      entityRow({ entityType: 'model', requests: 400, errors: 7 }),
    ];
  }) as unknown as MockDb['aggregateEntityMetrics']);
  return db;
}

describe('collectPrometheusMetrics — tracing and entity health', () => {
  let db: MockDb;

  beforeEach(() => {
    __resetPrometheusHealthCacheForTests();
    vi.clearAllMocks();
    db = primeDb();
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes finished tracing sessions as a typed 24h gauge from the entity rollup, not a tenant-wide tracing scan', async () => {
    const text = await collectPrometheusMetrics('tenant_db', 'tenant-1');

    expect(text).toContain('# TYPE console_tracing_sessions_total gauge');
    expect(text).toContain('console_tracing_sessions_total{status="success"} 10');
    expect(text).toContain('console_tracing_sessions_total{status="error"} 2');
    expect(text).toContain('console_tracing_sessions_total{status="abandoned"} 1');
    expect(db.listAgentTracingSessions).not.toHaveBeenCalled();
    expect(db.aggregateAgentTracingDashboard).not.toHaveBeenCalled();
  });

  it('exposes token totals as 24h gauges instead of counters', async () => {
    const text = await collectPrometheusMetrics('tenant_db', 'tenant-1');

    expect(text).toContain('# TYPE console_tracing_input_tokens_24h gauge');
    expect(text).toContain('console_tracing_input_tokens_24h 1200');
    expect(text).toContain('console_tracing_output_tokens_24h 300');
    expect(text).not.toContain('console_tracing_input_tokens_total');
    expect(text).not.toContain('console_tracing_output_tokens_total');
  });

  it('counts distinct agents from entity_metrics (active agents only)', async () => {
    const text = await collectPrometheusMetrics('tenant_db', 'tenant-1');

    expect(text).toContain('# TYPE console_tracing_agents_total gauge');
    expect(text).toContain('console_tracing_agents_total 2');
    expect(db.countAgentTracingDistinctAgents).not.toHaveBeenCalled();
  });

  it('adds per-entity-type request and error gauges for the last 24h, tenant-wide', async () => {
    const text = await collectPrometheusMetrics('tenant_db', 'tenant-1');

    expect(text).toContain('# TYPE console_entity_requests_24h gauge');
    expect(text).toContain('console_entity_requests_24h{entity_type="agent"} 13');
    expect(text).toContain('console_entity_requests_24h{entity_type="model"} 400');
    expect(text).toContain('# TYPE console_entity_errors_24h gauge');
    expect(text).toContain('console_entity_errors_24h{entity_type="agent"} 2');
    expect(text).toContain('console_entity_errors_24h{entity_type="model"} 7');

    const typeQuery = db.aggregateEntityMetrics.mock.calls
      .map((c) => c[0])
      .find((q) => q.groupBy.length === 1 && q.groupBy[0] === 'entityType')!;
    expect(typeQuery.tenantId).toBe('tenant-1');
    expect(typeQuery.projectId).toBeUndefined();
    expect(typeQuery.toMs - typeQuery.fromMs).toBe(DAY_MS);
  });

  it('serves repeat scrapes from a short per-tenant cache and refreshes after it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));

    await collectPrometheusMetrics('tenant_db', 'tenant-1');
    expect(db.aggregateEntityMetrics).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-10-15T12:00:20Z'));
    await collectPrometheusMetrics('tenant_db', 'tenant-1');
    expect(db.aggregateEntityMetrics).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-10-15T12:02:00Z'));
    await collectPrometheusMetrics('tenant_db', 'tenant-1');
    expect(db.aggregateEntityMetrics).toHaveBeenCalledTimes(4);
  });

  it('keeps tenants apart in the cache', async () => {
    await collectPrometheusMetrics('tenant_a', 'tenant-a');
    await collectPrometheusMetrics('tenant_b', 'tenant-b');

    const tenantIds = db.aggregateEntityMetrics.mock.calls.map((c) => c[0].tenantId);
    expect(tenantIds).toContain('tenant-a');
    expect(tenantIds).toContain('tenant-b');
  });

  it('coalesces concurrent scrapes of the same tenant into one set of reads', async () => {
    await Promise.all([
      collectPrometheusMetrics('tenant_db', 'tenant-1'),
      collectPrometheusMetrics('tenant_db', 'tenant-1'),
      collectPrometheusMetrics('tenant_db', 'tenant-1'),
    ]);

    expect(db.aggregateEntityMetrics).toHaveBeenCalledTimes(2);
  });

  it('serves empty session gauges as zeros when the tenant has no agent rows', async () => {
    db.aggregateEntityMetrics.mockResolvedValue([]);

    const text = await collectPrometheusMetrics('tenant_db', 'tenant-1');

    expect(text).toContain('console_tracing_sessions_total{status="success"} 0');
    expect(text).toContain('console_tracing_input_tokens_24h 0');
  });

  it('drops the health families when the entity rollup is unavailable', async () => {
    db.aggregateEntityMetrics.mockRejectedValue(new Error('rollup unavailable'));

    const text = await collectPrometheusMetrics('tenant_db', 'tenant-1');

    expect(text).not.toContain('console_tracing_sessions_total');
    expect(text).not.toContain('console_entity_requests_24h');
  });
});
