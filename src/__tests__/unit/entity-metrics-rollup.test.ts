/**
 * entity metrics rollup: buffer semantics (merge, cap, clamping), chunked
 * flush with failed-chunk re-buffering, and a real SQLite flush behind
 * `@/lib/database`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

const state = vi.hoisted(() => ({ provider: null as unknown as SQLiteProvider }));

vi.mock('@/lib/database', () => ({
  getDatabase: async () => state.provider,
  runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) =>
    state.provider.runWithTenant(tenantDbName, () => fn(state.provider)),
}));

import { reloadConfig } from '@/lib/core/config';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { getEntitySeries, getEntitySummaries } from '@/lib/services/entityMetrics/entityHealthService';
import {
  __resetEntityMetricsRollupForTests,
  flushEntityMetricsRollup,
  getEntityMetricsRollupHealth,
  recordEntityMetric,
  runEntityMetricsRetention,
  startEntityMetricsRollup,
  stopEntityMetricsRollup,
} from '@/lib/services/entityMetrics/entityMetricsRollup';

const base: {
  tenantDbName: string; tenantId: string; projectId: string; entityType: 'agent'; source: 'tracing';
} = { tenantDbName: '', tenantId: 't-1', projectId: 'p-1', entityType: 'agent', source: 'tracing' };
let TENANT_DB = '';
let tenantSeq = 0;
const FIVE_MIN = 300_000;
const DAY = 86_400_000;
let tmpDir = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'entity-metrics-rollup-'));
  state.provider = new SQLiteProvider(tmpDir, 'entity_rollup_main');
  await state.provider.connect();
});

afterAll(async () => {
  __resetEntityMetricsRollupForTests();
  await state.provider.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

// A fresh tenant database per test: rows must not leak between cases.
beforeEach(async () => {
  __resetEntityMetricsRollupForTests();
  tenantSeq += 1;
  TENANT_DB = `tenant_entity_metrics_rollup_${tenantSeq}`;
  base.tenantDbName = TENANT_DB;
  await state.provider.createTenant({
    companyName: `Rollup Co ${tenantSeq}`,
    slug: `entity-rollup-${tenantSeq}`,
    dbName: TENANT_DB,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENTITY_METRICS_MAX_BUFFERED_ROWS;
  reloadConfig();
});

async function readRows(
  extra: Partial<Parameters<SQLiteProvider['aggregateEntityMetrics']>[0]> = {},
) {
  return state.provider.runWithTenant(TENANT_DB, () =>
    state.provider.aggregateEntityMetrics({
      tenantId: 't-1',
      fromMs: Date.now() - 3 * DAY,
      toMs: Date.now() + DAY,
      groupBy: ['entityKey'],
      limit: 50_000,
      ...extra,
    }),
  );
}



describe('recordEntityMetric buffer', () => {
  it('never throws and drops inputs it cannot place', () => {
    expect(() => recordEntityMetric(null as never)).not.toThrow();
    recordEntityMetric({ ...base, entityKey: '   ' });
    recordEntityMetric({ ...base, entityKey: 'a', tenantDbName: undefined });
    recordEntityMetric({ ...base, entityKey: 'a', tenantId: undefined });
    expect(getEntityMetricsRollupHealth().pending).toBe(0);
  });

  it('reads tenant and project from the request context only when not given', () => {
    runWithRequestContext({ tenantId: 't-ctx', projectId: 'p-ctx' }, () => {
      recordEntityMetric({ tenantDbName: TENANT_DB, entityType: 'agent', entityKey: 'ctx', source: 'hosted' });
    });
    expect(getEntityMetricsRollupHealth().pending).toBe(1);
  });

  it('merges events of the same bucket and dimensions into one row', async () => {
    const at = Date.now();
    for (let i = 0; i < 4; i += 1) {
      recordEntityMetric({ ...base, entityKey: 'Pulse Main', outcome: i === 3 ? 'error' : 'ok', latencyMs: 200, at });
    }
    expect(getEntityMetricsRollupHealth().pending).toBe(1);
    await flushEntityMetricsRollup();
    const [row] = await readRows();
    expect(row.entityKey).toBe('Pulse Main');
    expect(row.requests).toBe(4);
    expect(row.errors).toBe(1);
    expect(row.latencyCount).toBe(3);
    expect(row.latencyMsSum).toBe(600);
    expect(row.lat1).toBe(3);
    expect(getEntityMetricsRollupHealth().pending).toBe(0);
    expect(getEntityMetricsRollupHealth().lastError).toBeNull();
  });

  it('trims and caps the entity key at 200 characters', async () => {
    recordEntityMetric({ ...base, entityKey: `  ${'x'.repeat(300)}  ` });
    await flushEntityMetricsRollup();
    const [row] = await readRows();
    expect(row.entityKey).toHaveLength(200);
  });

  it('counts requests per outcome (none = counters only, corrections may be negative)', async () => {
    recordEntityMetric({ ...base, entityKey: 'o', outcome: 'cancelled' });
    recordEntityMetric({ ...base, entityKey: 'o', outcome: 'abandoned' });
    recordEntityMetric({ ...base, entityKey: 'o', outcome: 'none', toolCalls: 3, toolErrors: 1, aiCalls: 2, errorEvents: 1 });
    recordEntityMetric({ ...base, entityKey: 'o', outcome: 'none', requests: 0, errorsDelta: 1, latencyMs: 400, latencyForce: true });
    recordEntityMetric({ ...base, entityKey: 'o', outcome: 'none', requests: 0, errorsDelta: -1, abandoned: -1 });
    await flushEntityMetricsRollup();
    const [row] = await readRows();
    expect(row.requests).toBe(2);
    expect(row.cancelled).toBe(1);
    expect(row.abandoned).toBe(0);
    expect(row.errors).toBe(0);
    expect(row.toolCalls).toBe(3);
    expect(row.toolErrors).toBe(1);
    expect(row.aiCalls).toBe(2);
    expect(row.errorEvents).toBe(1);
    expect(row.latencyCount).toBe(1);
  });

  it('records latency only for ok outcomes', async () => {
    recordEntityMetric({ ...base, entityKey: 'lat', outcome: 'error', latencyMs: 900 });
    recordEntityMetric({ ...base, entityKey: 'lat', outcome: 'ok', latencyMs: null });
    await flushEntityMetricsRollup();
    const [row] = await readRows();
    expect(row.requests).toBe(2);
    expect(row.latencyCount).toBe(0);
  });

  it('does not buffer an observation that adds nothing', () => {
    recordEntityMetric({ ...base, entityKey: 'empty', outcome: 'none' });
    expect(getEntityMetricsRollupHealth().pending).toBe(0);
  });

  it('clamps the event time to [now-24h, now+5min] (non-finite means now)', async () => {
    const before = Date.now();
    recordEntityMetric({ ...base, entityKey: 'past', at: before - 10 * DAY });
    recordEntityMetric({ ...base, entityKey: 'future', at: before + 10 * DAY });
    recordEntityMetric({ ...base, entityKey: 'nan', at: Number.NaN });
    await flushEntityMetricsRollup();
    const after = Date.now();
    const rows = await readRows({ bucketMs: FIVE_MIN });
    const byKey = new Map(rows.map((r) => [r.entityKey, r.bucketMs!]));
    expect(byKey.get('past')).toBeGreaterThanOrEqual(before - DAY - FIVE_MIN);
    expect(byKey.get('past')).toBeLessThanOrEqual(after - DAY);
    expect(byKey.get('future')).toBeLessThanOrEqual(after + FIVE_MIN);
    expect(byKey.get('future')).toBeGreaterThanOrEqual(before + FIVE_MIN - FIVE_MIN);
    expect(byKey.get('nan')! % FIVE_MIN).toBe(0);
    expect(byKey.get('nan')).toBeGreaterThanOrEqual(before - FIVE_MIN);
  });

  it('caps only NEW rows: existing keys keep merging, drops are counted', () => {
    process.env.ENTITY_METRICS_MAX_BUFFERED_ROWS = '100';
    reloadConfig();
    const at = Date.now();
    for (let i = 0; i < 100; i += 1) recordEntityMetric({ ...base, entityKey: `k${i}`, at });
    expect(getEntityMetricsRollupHealth()).toMatchObject({ pending: 100, dropped: 0 });

    recordEntityMetric({ ...base, entityKey: 'one-too-many', at });
    recordEntityMetric({ ...base, entityKey: 'another', at });
    expect(getEntityMetricsRollupHealth()).toMatchObject({ pending: 100, dropped: 2 });

    // an existing key still merges at the cap
    recordEntityMetric({ ...base, entityKey: 'k5', at });
    expect(getEntityMetricsRollupHealth()).toMatchObject({ pending: 100, dropped: 2 });
  });

  it('keeps merged counts for keys that were buffered before the cap was hit', async () => {
    process.env.ENTITY_METRICS_MAX_BUFFERED_ROWS = '100';
    reloadConfig();
    const at = Date.now();
    for (let i = 0; i < 100; i += 1) recordEntityMetric({ ...base, entityKey: `k${i}`, at });
    recordEntityMetric({ ...base, entityKey: 'k0', at });
    recordEntityMetric({ ...base, entityKey: 'k0', at });
    await flushEntityMetricsRollup();
    const rows = await readRows();
    expect(rows.find((r) => r.entityKey === 'k0')!.requests).toBe(3);
    expect(rows).toHaveLength(100);
  });
});

describe('flush', () => {
  it('writes in chunks of 500 rows', async () => {
    const spy = vi.spyOn(state.provider, 'incrementEntityMetrics');
    const at = Date.now();
    for (let i = 0; i < 1200; i += 1) recordEntityMetric({ ...base, entityKey: `e${i}`, at });
    await flushEntityMetricsRollup();
    expect(spy.mock.calls.map(([rows]) => rows.length).sort((a, b) => b - a)).toEqual([500, 500, 200]);
    expect(await readRows()).toHaveLength(1200);
  });

  it('stamps every row with an expiry of bucket + retention days', async () => {
    const spy = vi.spyOn(state.provider, 'incrementEntityMetrics');
    recordEntityMetric({ ...base, entityKey: 'ttl' });
    await flushEntityMetricsRollup();
    const [row] = spy.mock.calls[0]![0];
    expect(row.expiresAtMs).toBe(row.bucketMs + 45 * DAY);
  });

  it('re-buffers only the failed chunk and retries it on the next flush', async () => {
    const original = state.provider.incrementEntityMetrics.bind(state.provider);
    let call = 0;
    vi.spyOn(state.provider, 'incrementEntityMetrics').mockImplementation(async (rows) => {
      call += 1;
      if (call === 2) throw new Error('write failed');
      return original(rows);
    });
    const at = Date.now();
    for (let i = 0; i < 1200; i += 1) recordEntityMetric({ ...base, entityKey: `e${i}`, at });

    await flushEntityMetricsRollup();
    const failedRows = getEntityMetricsRollupHealth();
    expect(failedRows.lastError).toBe('write failed');
    expect(failedRows.pending).toBe(500);
    expect(await readRows()).toHaveLength(700);

    await flushEntityMetricsRollup();
    expect(getEntityMetricsRollupHealth()).toMatchObject({ pending: 0, lastError: null });
    const rows = await readRows();
    expect(rows).toHaveLength(1200);
    expect(rows.every((r) => r.requests === 1)).toBe(true);
  });

  it('merges re-buffered rows with events that arrived during the failed flush', async () => {
    let fail = true;
    const original = state.provider.incrementEntityMetrics.bind(state.provider);
    vi.spyOn(state.provider, 'incrementEntityMetrics').mockImplementation(async (rows) => {
      if (fail) {
        // an event lands while the flush is in flight
        recordEntityMetric({ ...base, entityKey: 'same', at: rows[0]!.bucketMs });
        throw new Error('down');
      }
      return original(rows);
    });
    const at = Date.now();
    recordEntityMetric({ ...base, entityKey: 'same', at });
    await flushEntityMetricsRollup();
    expect(getEntityMetricsRollupHealth().pending).toBe(1);
    fail = false;
    await flushEntityMetricsRollup();
    const [row] = await readRows();
    expect(row.requests).toBe(2);
  });

  it('serialises concurrent flushes and never rejects', async () => {
    recordEntityMetric({ ...base, entityKey: 'c1' });
    const results = await Promise.allSettled([
      flushEntityMetricsRollup(),
      flushEntityMetricsRollup(),
      flushEntityMetricsRollup(),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await readRows())[0]!.requests).toBe(1);
  });

  it('survives an unavailable database by re-buffering instead of throwing', async () => {
    vi.spyOn(state.provider, 'runWithTenant').mockRejectedValue(new Error('no db'));
    recordEntityMetric({ ...base, entityKey: 'down' });
    await expect(flushEntityMetricsRollup()).resolves.toBeUndefined();
    expect(getEntityMetricsRollupHealth()).toMatchObject({ pending: 1, lastError: 'no db' });
  });

  it('flushes several tenants', async () => {
    await state.provider.createTenant({
      companyName: 'Second Co', slug: `entity-rollup-second-${tenantSeq}`, dbName: `${TENANT_DB}_2`, licenseType: 'FREE', ownerId: 'pending',
    });
    recordEntityMetric({ ...base, entityKey: 'one' });
    recordEntityMetric({ ...base, tenantDbName: `${TENANT_DB}_2`, entityKey: 'two' });
    await flushEntityMetricsRollup();
    expect((await readRows()).map((r) => r.entityKey)).toEqual(['one']);
    const other = await state.provider.runWithTenant(`${TENANT_DB}_2`, () =>
      state.provider.aggregateEntityMetrics({
        tenantId: 't-1', fromMs: Date.now() - DAY, toMs: Date.now() + DAY, groupBy: ['entityKey'],
      }),
    );
    expect(other.map((r) => r.entityKey)).toEqual(['two']);
  });
});

describe('lifecycle', () => {
  it('start is idempotent and stop performs a final flush', async () => {
    startEntityMetricsRollup();
    startEntityMetricsRollup();
    recordEntityMetric({ ...base, entityKey: 'final' });
    await stopEntityMetricsRollup();
    expect(getEntityMetricsRollupHealth().pending).toBe(0);
    expect(getEntityMetricsRollupHealth().lastFlushAt).toBeInstanceOf(Date);
    expect((await readRows())[0]!.entityKey).toBe('final');
  });

  it('retention purges buckets older than the retention window', async () => {
    const old = Date.now() - 60 * DAY;
    await state.provider.runWithTenant(TENANT_DB, () =>
      state.provider.incrementEntityMetrics([
        {
          tenantId: 't-1', projectId: 'p-1', entityType: 'agent', entityKey: 'ancient', source: 'tracing',
          bucketMs: old - (old % FIVE_MIN), requests: 1,
        },
        {
          tenantId: 't-1', projectId: 'p-1', entityType: 'agent', entityKey: 'recent', source: 'tracing',
          bucketMs: Date.now() - (Date.now() % FIVE_MIN), requests: 1,
        },
      ]),
    );
    const purged = await runEntityMetricsRetention();
    expect(purged).toBe(1);
    const rows = await state.provider.runWithTenant(TENANT_DB, () =>
      state.provider.aggregateEntityMetrics({
        tenantId: 't-1', fromMs: 0, toMs: Date.now() + DAY, groupBy: ['entityKey'],
      }),
    );
    expect(rows.map((r) => r.entityKey)).toEqual(['recent']);
  });
});

describe('read side over a real provider', () => {
  it('summaries and series reflect what the rollup flushed', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      recordEntityMetric({ ...base, entityKey: 'Pulse Main', outcome: i < 2 ? 'error' : 'ok', latencyMs: 400, at: now - 10 * 60_000 });
    }
    recordEntityMetric({ ...base, entityKey: 'Quiet', outcome: 'ok', latencyMs: 50, at: now - 30 * 60_000 });
    await flushEntityMetricsRollup();

    const scope = { tenantDbName: TENANT_DB, tenantId: 't-1', projectId: 'p-1', entityType: 'agent' as const };
    const summaries = await getEntitySummaries({ ...scope, fromMs: now - 3_600_000, toMs: now + 60_000 });
    expect(summaries.map((s) => s.entityKey)).toEqual(['Pulse Main', 'Quiet']);
    expect(summaries[0]!.totals).toMatchObject({ requests: 10, errors: 2, errorRate: 20 });
    expect(summaries[0]!.totals.p95Ms).toBeGreaterThan(250);
    expect(summaries[0]!.totals.p95Ms).toBeLessThanOrEqual(500);

    const series = await getEntitySeries({ ...scope, entityKey: 'Pulse Main', fromMs: now - 3_600_000, toMs: now + 60_000 });
    expect(series.range.bucketMs).toBe(FIVE_MIN);
    expect(series.totals.requests).toBe(10);
    expect(series.buckets.reduce((sum, b) => sum + b.requests, 0)).toBe(10);
    expect(series.buckets.filter((b) => b.requests === 0).length).toBeGreaterThan(5);
  });
});
