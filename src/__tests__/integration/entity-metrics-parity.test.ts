/**
 * Entity health rollup (`entity_metrics`), run against BOTH providers.
 *
 * Pins the contract the health views, alert evaluator and reports rely on:
 * additive upserts (histogram + max latency included), re-bucketed grouped
 * aggregation, half-open ranges, retention purge and tenant isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { describeForEachProvider } from './db-parity.helper';
import {
  ENTITY_METRIC_BUCKET_MS,
  type IEntityMetricIncrement,
} from '@/lib/database/provider/types.base';

const B = ENTITY_METRIC_BUCKET_MS;
// A bucket-aligned origin well inside the day so +/- hours stay positive.
const T0 = Math.floor(Date.UTC(2026, 9, 1, 0, 0, 0) / B) * B;

type Seed = { tenantId: string; otherTenantId: string; projectId: string; dbName: string };

function inc(seed: Seed, over: Partial<IEntityMetricIncrement> = {}): IEntityMetricIncrement {
  return {
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    entityType: 'agent',
    entityKey: 'Pulse Main',
    source: 'tracing',
    bucketMs: T0,
    ...over,
  };
}

describeForEachProvider('Entity metrics rollup', (getDb) => {
  let seed: Seed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `entity-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Entity Metrics',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = {
      tenantId: String(tenant._id),
      otherTenantId: `other-${unique}`,
      projectId: `proj-${unique}`,
      dbName,
    };
  });

  it('adds increments onto one row, including histogram fields, and keeps the max latency', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([
      inc(seed, { requests: 2, errors: 1, latencyMsSum: 300, latencyCount: 2, lat0: 1, lat1: 1, latencyMsMax: 240, costUsd: 0.5, inputTokens: 10 }),
    ]);
    await db.incrementEntityMetrics([
      inc(seed, { requests: 3, errors: 0, latencyMsSum: 9000, latencyCount: 3, lat1: 1, lat6: 2, latencyMsMax: 4800, costUsd: 0.25, outputTokens: 7 }),
      // A lower max must not win.
      inc(seed, { requests: 1, latencyMsMax: 90, lat0: 1 }),
    ]);

    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      fromMs: T0,
      toMs: T0 + B,
      groupBy: ['entityKey'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityKey: 'Pulse Main',
      requests: 6,
      errors: 1,
      latencyMsSum: 9300,
      latencyCount: 5,
      lat0: 2,
      lat1: 2,
      lat6: 2,
      inputTokens: 10,
      outputTokens: 7,
      latencyMsMax: 4800,
    });
    expect(rows[0].costUsd).toBeCloseTo(0.75, 10);
    // Counters that were never incremented read as zero, never undefined.
    expect(rows[0].lat14).toBe(0);
    expect(rows[0].emptyResults).toBe(0);
  });

  it('accepts negative corrections and zero-only rows', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([inc(seed, { requests: 4, errors: 2, abandoned: 1 })]);
    await db.incrementEntityMetrics([inc(seed, { requests: 0, errors: -1, abandoned: -1 })]);
    await db.incrementEntityMetrics([inc(seed, { bucketMs: T0 + B })]);

    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + 2 * B, groupBy: ['entityKey'],
    });
    expect(rows[0]).toMatchObject({ requests: 4, errors: 1, abandoned: 0 });
  });

  it('keeps rows with different dimensions apart and groups by the requested fields', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([
      inc(seed, { entityKey: 'a', requests: 5, source: 'tracing' }),
      inc(seed, { entityKey: 'a', requests: 2, source: 'hosted' }),
      inc(seed, { entityKey: 'b', requests: 9, source: 'tracing' }),
      inc(seed, { entityType: 'model', entityKey: 'gpt', requests: 1, source: 'gateway' }),
    ]);

    const byKey = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, entityType: 'agent',
      fromMs: T0, toMs: T0 + B, groupBy: ['entityKey'],
    });
    // Sorted by requests desc when there is no time grouping.
    expect(byKey.map((r) => [r.entityKey, r.requests])).toEqual([['b', 9], ['a', 7]]);

    const bySource = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, entityType: 'agent',
      fromMs: T0, toMs: T0 + B, groupBy: ['source'],
    });
    expect(Object.fromEntries(bySource.map((r) => [r.source, r.requests]))).toEqual({ tracing: 14, hosted: 2 });

    const byType = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId,
      fromMs: T0, toMs: T0 + B, groupBy: ['entityType'],
    });
    expect(Object.fromEntries(byType.map((r) => [r.entityType, r.requests]))).toEqual({ agent: 16, model: 1 });

    const total = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId,
      fromMs: T0, toMs: T0 + B, groupBy: [],
    });
    expect(total).toHaveLength(1);
    expect(total[0].requests).toBe(17);
  });

  it('re-buckets 5-minute rows into larger buckets, sorted by time then requests', async () => {
    const db = getDb();
    const HOUR = 12 * B;
    await db.incrementEntityMetrics([
      inc(seed, { entityKey: 'a', bucketMs: T0, requests: 1 }),
      inc(seed, { entityKey: 'a', bucketMs: T0 + B, requests: 2 }),
      inc(seed, { entityKey: 'b', bucketMs: T0 + 2 * B, requests: 10 }),
      inc(seed, { entityKey: 'a', bucketMs: T0 + HOUR, requests: 4, latencyMsMax: 50 }),
      inc(seed, { entityKey: 'a', bucketMs: T0 + HOUR + B, requests: 8, latencyMsMax: 80 }),
    ]);

    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId,
      fromMs: T0, toMs: T0 + 2 * HOUR, groupBy: ['entityKey'], bucketMs: HOUR,
    });

    expect(rows.map((r) => [r.bucketMs, r.entityKey, r.requests])).toEqual([
      [T0, 'b', 10],
      [T0, 'a', 3],
      [T0 + HOUR, 'a', 12],
    ]);
    expect(rows[2].latencyMsMax).toBe(80);

    // Time-only series (no dimension grouping).
    const series = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId,
      fromMs: T0, toMs: T0 + 2 * HOUR, groupBy: [], bucketMs: HOUR,
    });
    expect(series.map((r) => [r.bucketMs, r.requests])).toEqual([[T0, 13], [T0 + HOUR, 12]]);
  });

  it('filters by entityKeys and sources', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([
      inc(seed, { entityKey: 'a', requests: 1, source: 'tracing' }),
      inc(seed, { entityKey: 'b', requests: 2, source: 'tracing' }),
      inc(seed, { entityKey: 'c', requests: 4, source: 'hosted' }),
    ]);
    const base = { tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + B, groupBy: ['entityKey' as const] };

    const keys = await db.aggregateEntityMetrics({ ...base, entityKeys: ['a', 'c'] });
    expect(keys.map((r) => r.entityKey).sort()).toEqual(['a', 'c']);

    const sources = await db.aggregateEntityMetrics({ ...base, sources: ['hosted'] });
    expect(sources.map((r) => r.entityKey)).toEqual(['c']);

    expect(await db.aggregateEntityMetrics({ ...base, entityKeys: [] })).toEqual([]);
    expect(await db.aggregateEntityMetrics({ ...base, sources: [] })).toEqual([]);
  });

  it('treats the range as half-open [fromMs, toMs)', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([
      inc(seed, { bucketMs: T0 - B, requests: 100 }),
      inc(seed, { bucketMs: T0, requests: 1 }),
      inc(seed, { bucketMs: T0 + B, requests: 2 }),
      inc(seed, { bucketMs: T0 + 2 * B, requests: 100 }),
    ]);
    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + 2 * B, groupBy: [],
    });
    expect(rows[0].requests).toBe(3);
  });

  it('isolates projects and tenants, and sums projects when projectId is omitted', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([
      inc(seed, { requests: 1 }),
      inc(seed, { projectId: `${seed.projectId}-2`, requests: 10 }),
      inc(seed, { tenantId: seed.otherTenantId, requests: 1000 }),
    ]);
    const range = { fromMs: T0, toMs: T0 + B, groupBy: [] as never[] };

    const one = await db.aggregateEntityMetrics({ tenantId: seed.tenantId, projectId: seed.projectId, ...range });
    expect(one[0].requests).toBe(1);

    const all = await db.aggregateEntityMetrics({ tenantId: seed.tenantId, ...range });
    expect(all[0].requests).toBe(11);

    const byProject = await db.aggregateEntityMetrics({ tenantId: seed.tenantId, fromMs: T0, toMs: T0 + B, groupBy: ['projectId'] });
    expect(byProject.map((r) => [r.projectId, r.requests])).toEqual([[`${seed.projectId}-2`, 10], [seed.projectId, 1]]);

    const other = await db.aggregateEntityMetrics({ tenantId: seed.otherTenantId, ...range });
    expect(other[0].requests).toBe(1000);
  });

  it('uses an empty-string project as its own bucket, never null', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([inc(seed, { projectId: '', requests: 3 })]);
    await db.incrementEntityMetrics([inc(seed, { projectId: '', requests: 4 })]);
    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: '', fromMs: T0, toMs: T0 + B, groupBy: ['projectId'],
    });
    expect(rows).toEqual([expect.objectContaining({ projectId: '', requests: 7 })]);
  });

  it('survives concurrent increments without losing any', async () => {
    const db = getDb();
    await Promise.all(
      Array.from({ length: 8 }, () => db.incrementEntityMetrics([inc(seed, { requests: 1, lat2: 1, latencyMsMax: 300 })])),
    );
    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + B, groupBy: [],
    });
    expect(rows[0]).toMatchObject({ requests: 8, lat2: 8, latencyMsMax: 300 });
  });

  it('sums concurrent batches that race onto the same brand-new keys, duplicates included', async () => {
    const db = getDb();
    const batch = () => [
      ...Array.from({ length: 6 }, (_, i) => inc(seed, { entityKey: `fresh${i}`, requests: 1 })),
      inc(seed, { entityKey: 'fresh0', requests: 2 }),
    ];
    await Promise.all(Array.from({ length: 6 }, () => db.incrementEntityMetrics(batch())));
    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + B, groupBy: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(6 * 8);
    const byKey = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + B, groupBy: ['entityKey'],
    });
    expect(byKey.find((r) => r.entityKey === 'fresh0')?.requests).toBe(18);
    expect(byKey.find((r) => r.entityKey === 'fresh3')?.requests).toBe(6);
  });

  it('returns no rows for an ungrouped aggregate over an empty range', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([inc(seed, { requests: 3 })]);
    const empty = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0 + B, toMs: T0 + 2 * B, groupBy: [],
    });
    expect(empty).toEqual([]);
    const emptyBucketed = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0 + B, toMs: T0 + 2 * B, groupBy: [], bucketMs: B,
    });
    expect(emptyBucketed).toEqual([]);
  });

  it('writes more rows than one chunk', async () => {
    const db = getDb();
    const rows = Array.from({ length: 1200 }, (_, i) => inc(seed, { entityKey: `k${i}`, requests: 1 }));
    await db.incrementEntityMetrics(rows);
    const agg = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + B, groupBy: ['entityKey'], limit: 5000,
    });
    expect(agg).toHaveLength(1200);

    const limited = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + B, groupBy: ['entityKey'], limit: 10,
    });
    expect(limited).toHaveLength(10);
  });

  it('purges buckets older than the cutoff in batches and returns how many', async () => {
    const db = getDb();
    await db.incrementEntityMetrics(
      Array.from({ length: 7 }, (_, i) => inc(seed, { bucketMs: T0 + i * B, requests: 1 })),
    );
    // Cutoff keeps buckets 5 and 6 (bucketMs >= T0 + 5B).
    const deleted = await db.purgeEntityMetrics({ olderThanMs: T0 + 5 * B, batchSize: 2 });
    expect(deleted).toBe(5);

    const rows = await db.aggregateEntityMetrics({
      tenantId: seed.tenantId, projectId: seed.projectId, fromMs: T0, toMs: T0 + 10 * B, groupBy: [], bucketMs: B,
    });
    expect(rows.map((r) => r.bucketMs)).toEqual([T0 + 5 * B, T0 + 6 * B]);

    expect(await db.purgeEntityMetrics({ olderThanMs: T0 + 5 * B })).toBe(0);
  });

  it('stores bucketStart and expiresAt on insert only', async () => {
    const db = getDb();
    const expiresAtMs = T0 + 45 * 86_400_000;
    await db.incrementEntityMetrics([inc(seed, { requests: 1, expiresAtMs })]);
    // A later increment with a different expiry must not move it.
    await db.incrementEntityMetrics([inc(seed, { requests: 1, expiresAtMs: expiresAtMs + 86_400_000 })]);

    const raw = await readRawRow(db as unknown as RawAccess, seed);
    expect(new Date(raw.bucketStart as string | Date).getTime()).toBe(T0);
    expect(new Date(raw.expiresAt as string | Date).getTime()).toBe(expiresAtMs);
    expect(Number(raw.requests)).toBe(2);
  });

  it('creates the unique dimension index and the bucket index on first write', async () => {
    const db = getDb();
    await db.incrementEntityMetrics([inc(seed, { requests: 1, expiresAtMs: T0 + 86_400_000 })]);
    const names = await readIndexNames(db as unknown as RawAccess, 'entity_metrics');
    expect(names).toContain('idx_entity_metrics_type_bucket');
    // Mongo: explicit unique index + TTL; SQLite: the UNIQUE constraint's auto index.
    const handle = (db as unknown as RawAccess).getTenantDb() as { prepare?: unknown };
    if (typeof handle.prepare === 'function') {
      expect(names.some((n) => n.startsWith('sqlite_autoindex_entity_metrics'))).toBe(true);
    } else {
      expect(names).toContain('uniq_entity_metrics_dims');
      expect(names).toContain('ttl_entity_metrics_expiresAt');
    }
  });
});

describe('Entity metrics rollup (type contract)', () => {
  it('exposes the histogram constants the spec fixes', () => {
    expect(ENTITY_METRIC_BUCKET_MS).toBe(300_000);
  });
});

// ── raw access helpers (provider-specific, test-only) ──────────────────────

type RawAccess = {
  getTenantDb(): unknown;
};

async function readRawRow(db: RawAccess, seed: Seed): Promise<Record<string, unknown>> {
  const handle = db.getTenantDb() as {
    prepare?: (sql: string) => { get: (p: unknown) => unknown };
    collection?: (name: string) => { findOne: (f: unknown) => Promise<unknown> };
  };
  if (typeof handle.prepare === 'function') {
    return handle.prepare(
      'SELECT * FROM entity_metrics WHERE tenantId = @t AND projectId = @p',
    ).get({ t: seed.tenantId, p: seed.projectId }) as Record<string, unknown>;
  }
  return (await handle.collection!('entity_metrics').findOne({
    tenantId: seed.tenantId,
    projectId: seed.projectId,
  })) as Record<string, unknown>;
}

async function readIndexNames(db: RawAccess, table: string): Promise<string[]> {
  const handle = db.getTenantDb() as {
    prepare?: (sql: string) => { all: () => unknown[] };
    collection?: (name: string) => { indexes: () => Promise<Array<{ name: string }>> };
  };
  if (typeof handle.prepare === 'function') {
    return (handle.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
  }
  return (await handle.collection!(table).indexes()).map((i) => i.name);
}
