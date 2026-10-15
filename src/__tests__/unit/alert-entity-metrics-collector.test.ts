import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;

vi.mock('@/lib/database', () => ({ getTenantDatabase: vi.fn() }));

import { getTenantDatabase } from '@/lib/database';
import { ENTITY_METRIC_BUCKET_MS } from '@/lib/database/provider/types.base';
import {
  EntityMetricsCollector,
  aggregateEntityCounters,
  entityEvaluationWindow,
} from '@/lib/services/alerts/metrics/entityMetricsCollector';
import { getCollectorForMetric } from '@/lib/services/alerts/metrics';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';

describe('entityEvaluationWindow', () => {
  const FLUSH_MS = 30_000;

  it('ends at the last whole rollup bucket that has been flushed and spans the window', () => {
    const now = 1_700_000_123_456;
    const { fromMs, toMs } = entityEvaluationWindow(now, 15);
    expect(toMs % ENTITY_METRIC_BUCKET_MS).toBe(0);
    expect(toMs).toBeLessThanOrEqual(now - FLUSH_MS);
    expect(now - FLUSH_MS - toMs).toBeLessThan(ENTITY_METRIC_BUCKET_MS);
    expect(toMs - fromMs).toBe(15 * 60_000);
  });

  it('a bucket boundary only becomes the end once the flush interval has passed', () => {
    const boundary = 10 * ENTITY_METRIC_BUCKET_MS;
    expect(entityEvaluationWindow(boundary + FLUSH_MS, 5)).toEqual({ fromMs: boundary - 5 * 60_000, toMs: boundary });
    // Just before that, the last bucket may still be partly unflushed: the previous boundary ends the window.
    const earlier = boundary - ENTITY_METRIC_BUCKET_MS;
    expect(entityEvaluationWindow(boundary + FLUSH_MS - 1, 5)).toEqual({ fromMs: earlier - 5 * 60_000, toMs: earlier });
    expect(entityEvaluationWindow(boundary, 5).toMs).toBe(earlier);
  });
});

describe('EntityMetricsCollector', () => {
  let db: LooseDb;
  const collector = new EntityMetricsCollector();

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb() as unknown as LooseDb;
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('supports exactly the entity-sourced catalog metrics and is registered', () => {
    const expected = ALERT_METRIC_CATALOG.filter((def) => def.source === 'entity').map((def) => def.id);
    expect(expected.length).toBeGreaterThan(0);
    expect([...collector.supportedMetrics].sort()).toEqual([...expected].sort());
    expect(getCollectorForMetric('agent_error_rate')).toBeInstanceOf(EntityMetricsCollector);
    expect(getCollectorForMetric('error_rate')).not.toBeInstanceOf(EntityMetricsCollector);
  });

  describe('collectByEntity', () => {
    it('groups by entity key over whole buckets and computes one value per entity', async () => {
      db.aggregateEntityMetrics.mockResolvedValue([
        { entityKey: 'Pulse Main', requests: 100, errors: 10 },
        { entityKey: 'Triage', requests: 40, errors: 0 },
        { entityKey: '', requests: 5, errors: 5 },
      ]);
      const nowMs = 1_700_000_123_456;
      const result = await collector.collectByEntity({
        metric: 'agent_error_rate',
        windowMinutes: 30,
        tenantDbName: 'tenant_acme',
        tenantId: 't1',
        scope: { projectId: 'p1' },
        nowMs,
      } as never);

      expect(result.get('Pulse Main')).toEqual({ value: 10, sampleCount: 100 });
      expect(result.get('Triage')).toEqual({ value: 0, sampleCount: 40 });
      expect(result.has('')).toBe(false);

      const query = db.aggregateEntityMetrics.mock.calls[0][0];
      const { fromMs, toMs } = entityEvaluationWindow(nowMs, 30);
      expect(query).toMatchObject({
        tenantId: 't1', projectId: 'p1', entityType: 'agent', fromMs, toMs, groupBy: ['entityKey'],
      });
      expect(query).not.toHaveProperty('entityKeys');
    });

    it('restricts to the given keys', async () => {
      db.aggregateEntityMetrics.mockResolvedValue([]);
      await collector.collectByEntity({
        metric: 'agent_error_rate', windowMinutes: 5, tenantDbName: 'd', tenantId: 't1', scope: { projectId: 'p1' }, entityKeys: ['a', 'b'],
      } as never);
      expect(db.aggregateEntityMetrics.mock.calls[0][0]).toMatchObject({ entityKeys: ['a', 'b'] });
    });

    it('answers an empty map for a legacy metric or when the project is unknown', async () => {
      expect((await collector.collectByEntity({ metric: 'error_rate', windowMinutes: 5, tenantDbName: 'd', tenantId: 't', scope: { projectId: 'p' } } as never)).size).toBe(0);
      expect((await collector.collectByEntity({ metric: 'agent_error_rate', windowMinutes: 5, tenantDbName: 'd', tenantId: 't' } as never)).size).toBe(0);
      expect(db.aggregateEntityMetrics).not.toHaveBeenCalled();
    });
  });

  describe('collect', () => {
    it('aggregates the whole project for an agent metric', async () => {
      db.aggregateEntityMetrics.mockResolvedValue([{ requests: 50, errors: 5 }]);
      const result = await collector.collect({
        metric: 'agent_error_rate', windowMinutes: 15, tenantDbName: 'd', tenantId: 't1', scope: { projectId: 'p1' },
      } as never);
      expect(result).toEqual({ value: 10, sampleCount: 50 });
      expect(db.aggregateEntityMetrics.mock.calls[0][0]).toMatchObject({ entityType: 'agent', groupBy: [] });
      expect(db.aggregateEntityMetrics.mock.calls[0][0]).not.toHaveProperty('entityKeys');
    });

    it('narrows a model metric to the scoped model key', async () => {
      db.aggregateEntityMetrics.mockResolvedValue([{ requests: 10, errors: 1 }]);
      await collector.collect({
        metric: 'model_error_rate', windowMinutes: 15, tenantDbName: 'd', tenantId: 't1', scope: { projectId: 'p1', modelKey: 'gpt-4o' },
      } as never);
      expect(db.aggregateEntityMetrics.mock.calls[0][0]).toMatchObject({ entityType: 'model', entityKeys: ['gpt-4o'] });
    });

    it('is zero without data, an unknown metric or a project', async () => {
      db.aggregateEntityMetrics.mockResolvedValue([]);
      expect(await collector.collect({ metric: 'agent_error_rate', windowMinutes: 5, tenantDbName: 'd', tenantId: 't', scope: { projectId: 'p' } } as never))
        .toEqual({ value: 0, sampleCount: 0 });
      expect(await collector.collect({ metric: 'error_rate', windowMinutes: 5, tenantDbName: 'd', tenantId: 't', scope: { projectId: 'p' } } as never))
        .toEqual({ value: 0, sampleCount: 0 });
      expect(await collector.collect({ metric: 'agent_error_rate', windowMinutes: 5, tenantDbName: 'd', tenantId: 't' } as never))
        .toEqual({ value: 0, sampleCount: 0 });
    });
  });
});

describe('aggregateEntityCounters', () => {
  it('returns a counter set per entity key', async () => {
    const db = createMockDb() as unknown as LooseDb;
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.aggregateEntityMetrics.mockResolvedValue([{ entityKey: 'a', requests: 3, errors: 1 }]);
    const map = await aggregateEntityCounters({ tenantDbName: 'd', tenantId: 't', projectId: 'p', entityType: 'agent', fromMs: 0, toMs: 300_000 });
    expect(map.get('a')).toMatchObject({ requests: 3, errors: 1, cancelled: 0 });
  });
});
