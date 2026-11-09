/**
 * The red-team alert metrics pool attempts across the completed runs that
 * finished in the window, leave out runs whose rates cannot be trusted, and
 * report "no data" (sampleCount 0) rather than a made-up 0% when nothing is left.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  raw: null as unknown,
}));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getTenantDatabase: vi.fn(async () => ({})),
}));
vi.mock('@/lib/services/alerts/metrics/dbHelper', () => ({ getRawDb: () => h.raw }));

import { pooledAttackSuccess, RedTeamCollector } from '@/lib/services/alerts/metrics/redTeamCollector';
import { judgeable } from '@/lib/services/alerts/alertEvaluator';
import { getMetricDef } from '@/lib/services/alerts/metricCatalog';
import type { AlertMetric } from '@/lib/database';

const agg = (over: Record<string, unknown>) => ({
  total: 10, completed: 10, failed: 0, vulnerable: 0, safe: 10, needsReview: 0,
  attackSuccessRate: 0, resilienceScore: 1, inconclusive: false, inconclusiveReasons: [], ...over,
});

const query = (metric: AlertMetric, projectId?: string) => ({
  tenantDbName: 'tenant_db',
  tenantId: 'tenant-1',
  metric,
  windowMinutes: 60,
  ...(projectId ? { scope: { projectId } } : {}),
});

function mongoWith(aggregates: unknown[]) {
  const seen: { collection?: string; filter?: Record<string, unknown>; options?: unknown } = {};
  h.raw = {
    type: 'mongodb',
    db: {
      collection: (name: string) => ({
        find: (filter: Record<string, unknown>, options: unknown) => {
          Object.assign(seen, { collection: name, filter, options });
          return { toArray: async () => aggregates.map((aggregate) => ({ aggregate })) };
        },
      }),
    },
  };
  return seen;
}

function sqliteWith(aggregates: unknown[]) {
  const seen: { sql?: string; params?: Record<string, unknown> } = {};
  h.raw = {
    type: 'sqlite',
    db: {
      prepare: (sql: string) => ({
        get: () => undefined,
        all: (params: Record<string, unknown>) => {
          Object.assign(seen, { sql, params });
          return aggregates.map((a) => ({ aggregate: typeof a === 'string' || a === null ? a : JSON.stringify(a) }));
        },
      }),
    },
  };
  return seen;
}

beforeEach(() => {
  h.raw = null;
});

describe('pooledAttackSuccess', () => {
  it('weights every attempt equally across runs', () => {
    // 1 of 5 in one run, 30 of 100 in another: 31/105, not the average of 20% and 30%.
    const { rate, runs } = pooledAttackSuccess([
      agg({ completed: 5, vulnerable: 1, attackSuccessRate: 0.2 }),
      agg({ completed: 100, vulnerable: 30, attackSuccessRate: 0.3 }),
    ]);
    expect(runs).toBe(2);
    expect(rate).toBeCloseTo((31 / 105) * 100, 8);
  });

  it('leaves out inconclusive runs, runs with a null rate and runs with nothing completed', () => {
    const { rate, runs } = pooledAttackSuccess([
      agg({ completed: 10, vulnerable: 2, attackSuccessRate: 0.2 }),
      agg({ completed: 10, vulnerable: 10, attackSuccessRate: 1, inconclusive: true, inconclusiveReasons: ['judge-errors'] }),
      // Stored before reasons existed: inconclusive without any.
      agg({ completed: 10, vulnerable: 10, attackSuccessRate: 1, inconclusive: true }),
      agg({ completed: 0, vulnerable: 0, attackSuccessRate: null, resilienceScore: null }),
      // Stored before rates could be null: nothing completed, rate 0.
      agg({ completed: 0, vulnerable: 0, attackSuccessRate: 0 }),
    ]);
    expect(runs).toBe(1);
    expect(rate).toBeCloseTo(20, 8);
  });

  it('reads a stored JSON text and ignores one that does not parse', () => {
    const { runs } = pooledAttackSuccess([JSON.stringify(agg({ completed: 4, vulnerable: 1 })), 'not json', null]);
    expect(runs).toBe(1);
  });
});

describe('RedTeamCollector (MongoDB)', () => {
  const collector = new RedTeamCollector();

  it('returns the pooled attack success rate and the number of runs used', async () => {
    const seen = mongoWith([
      agg({ completed: 10, vulnerable: 2, attackSuccessRate: 0.2 }),
      agg({ completed: 30, vulnerable: 6, attackSuccessRate: 0.2 }),
    ]);

    const result = await collector.collect(query('redteam_attack_success_rate', 'proj-a'));

    expect(result.sampleCount).toBe(2);
    expect(result.value).toBeCloseTo(20, 8);
    expect(seen.collection).toBe('redteam_runs');
    expect(seen.filter).toMatchObject({ tenantId: 'tenant-1', status: 'completed', projectId: 'proj-a' });
    // The window reads finishedAt, and createdAt for a run that has none.
    const or = seen.filter?.$or as Array<Record<string, unknown>>;
    expect(or).toHaveLength(2);
    expect(or[0]).toHaveProperty('finishedAt');
    expect(or[1]).toMatchObject({ finishedAt: null });
  });

  it('reports resilience as 100 minus the attack success rate', async () => {
    mongoWith([agg({ completed: 10, vulnerable: 3, attackSuccessRate: 0.3 })]);

    const result = await collector.collect(query('redteam_resilience_score'));

    expect(result.value).toBeCloseTo(70, 8);
    expect(result.sampleCount).toBe(1);
  });

  it('has no data when no run can be used', async () => {
    mongoWith([agg({ completed: 0, attackSuccessRate: null, resilienceScore: null, inconclusive: true })]);

    expect(await collector.collect(query('redteam_attack_success_rate'))).toEqual({ value: 0, sampleCount: 0 });
    expect(await collector.collect(query('redteam_resilience_score'))).toEqual({ value: 0, sampleCount: 0 });
  });

  it('has no data for a metric it does not own, or without a database handle', async () => {
    expect(await collector.collect(query('total_requests' as AlertMetric))).toEqual({ value: 0, sampleCount: 0 });
    h.raw = null;
    expect(await collector.collect(query('redteam_attack_success_rate'))).toEqual({ value: 0, sampleCount: 0 });
  });
});

describe('RedTeamCollector (SQLite)', () => {
  const collector = new RedTeamCollector();

  it('reads completed runs of the window by their finish time and pools them', async () => {
    const seen = sqliteWith([
      agg({ completed: 20, vulnerable: 5, attackSuccessRate: 0.25 }),
      agg({ completed: 20, vulnerable: 15, attackSuccessRate: 0.75, inconclusive: true, inconclusiveReasons: ['target-errors'] }),
    ]);

    const result = await collector.collect(query('redteam_attack_success_rate', 'proj-a'));

    expect(result).toEqual({ value: 25, sampleCount: 1 });
    expect(seen.sql).toContain('COALESCE(finishedAt, createdAt)');
    expect(seen.sql).toContain("status = 'completed'");
    expect(seen.sql).toContain('projectId = @projectId');
    expect(seen.params).toMatchObject({ tenantId: 'tenant-1', projectId: 'proj-a' });
  });

  it('has no data when the window holds no completed run', async () => {
    sqliteWith([]);

    expect(await collector.collect(query('redteam_attack_success_rate'))).toEqual({ value: 0, sampleCount: 0 });
  });
});

describe('alert evaluation of an empty window', () => {
  it('never judges a red-team metric on sampleCount 0, so no rule fires on it', () => {
    for (const metric of ['redteam_attack_success_rate', 'redteam_resilience_score']) {
      const def = getMetricDef(metric)!;
      // Neither metric is zero-when-empty: an empty window is "no data", not a value of 0.
      expect(def.zeroWhenEmpty).toBeUndefined();
      expect(judgeable(def, 0, 0, 1, 'threshold')).toBe(false);
    }
  });
});
