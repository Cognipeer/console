/**
 * Plan limits usage persistence (monthly meters, limit events, capacity peaks),
 * run against both SQLite and MongoDB.
 */

import { it, expect, beforeEach } from 'vitest';
import type { PlanLimitEvent } from '@/lib/limits/types';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Plan limits usage', (getDb) => {
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenantId = `t-${suffix}`;
    otherTenantId = `o-${suffix}`;
  });

  it('increments monthly meters atomically and reads them back', async () => {
    const db = getDb();
    expect(await db.getPlanUsageMonthly(tenantId, '2026-11')).toEqual({});

    await db.incrementPlanUsageMonthly(tenantId, '2026-11', { searches: 2, flowRuns: 1 });
    await db.incrementPlanUsageMonthly(tenantId, '2026-11', { searches: 3, sandboxSeconds: 90 });
    await db.incrementPlanUsageMonthly(tenantId, '2026-11', {});
    await db.incrementPlanUsageMonthly(tenantId, '2026-12', { crawlerPages: 7 });

    const nov = await db.getPlanUsageMonthly(tenantId, '2026-11');
    expect(nov.searches).toBe(5);
    expect(nov.flowRuns).toBe(1);
    expect(nov.sandboxSeconds).toBe(90);
    expect(nov.crawlerPages ?? 0).toBe(0);

    const dec = await db.getPlanUsageMonthly(tenantId, '2026-12');
    expect(dec.crawlerPages).toBe(7);

    await Promise.all(
      Array.from({ length: 10 }, () => db.incrementPlanUsageMonthly(tenantId, '2027-01', { searches: 1 })),
    );
    expect((await db.getPlanUsageMonthly(tenantId, '2027-01')).searches).toBe(10);
  });

  it('lists monthly usage per period, optionally narrowed to tenants', async () => {
    const db = getDb();
    await db.incrementPlanUsageMonthly(tenantId, '2030-05', { searches: 4 });
    await db.incrementPlanUsageMonthly(otherTenantId, '2030-05', { flowRuns: 2 });
    await db.incrementPlanUsageMonthly(tenantId, '2030-06', { searches: 1 });

    const all = await db.listPlanUsageMonthly('2030-05');
    const ours = all.filter((row) => row.tenantId === tenantId || row.tenantId === otherTenantId);
    expect(ours).toHaveLength(2);
    expect(ours.every((row) => row.period === '2030-05')).toBe(true);

    const narrowed = await db.listPlanUsageMonthly('2030-05', { tenantIds: [tenantId] });
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]).toMatchObject({ tenantId, period: '2030-05', searches: 4 });

    expect(await db.listPlanUsageMonthly('2030-05', { tenantIds: [] })).toEqual([]);
  });

  it('stores limit events, lists them newest first with filters, and prunes by age', async () => {
    const db = getDb();
    const base = Date.parse('2031-03-01T12:00:00.000Z');
    const events: PlanLimitEvent[] = [
      {
        tenantId,
        kind: 'api_rpm',
        dimension: 'apiRpm',
        outcome: 'refused',
        mode: 'on',
        limit: 600,
        used: 601,
        source: { type: 'api_token', id: 'tok1' },
        count: 3,
        at: new Date(base),
      },
      {
        tenantId,
        kind: 'concurrency',
        dimension: 'agent',
        outcome: 'waited',
        mode: 'on',
        limit: 4,
        waitMs: 1200,
        count: 1,
        at: new Date(base + 60_000),
      },
      { tenantId, kind: 'monthly', outcome: 'refused', mode: 'on', count: 1, at: new Date(base + 120_000) },
      { tenantId: otherTenantId, kind: 'api_rpm', outcome: 'refused', mode: 'on', count: 1, at: new Date(base) },
    ];
    await db.insertPlanLimitEvents(events);
    await db.insertPlanLimitEvents([]);

    const listed = await db.listPlanLimitEvents(tenantId, { limit: 10 });
    expect(listed.map((e) => e.kind)).toEqual(['monthly', 'concurrency', 'api_rpm']);
    expect(listed[2]).toMatchObject({
      tenantId,
      dimension: 'apiRpm',
      outcome: 'refused',
      mode: 'on',
      limit: 600,
      used: 601,
      count: 3,
      source: { type: 'api_token', id: 'tok1' },
    });
    expect(listed[2].at).toBeInstanceOf(Date);
    expect(listed[2].at.getTime()).toBe(base);
    expect(listed[1].waitMs).toBe(1200);
    expect(listed[0].dimension).toBeUndefined();

    expect(await db.listPlanLimitEvents(tenantId, { limit: 2 })).toHaveLength(2);
    expect(
      (await db.listPlanLimitEvents(tenantId, { limit: 10, kind: 'concurrency' })).map((e) => e.kind),
    ).toEqual(['concurrency']);
    expect(
      await db.listPlanLimitEvents(tenantId, { limit: 10, since: new Date(base + 30_000) }),
    ).toHaveLength(2);

    const removed = await db.deletePlanLimitEventsBefore(new Date(base + 90_000));
    expect(removed).toBeGreaterThanOrEqual(3);
    const left = await db.listPlanLimitEvents(tenantId, { limit: 10 });
    expect(left.map((e) => e.kind)).toEqual(['monthly']);
    await db.deletePlanLimitEventsBefore(new Date(base + 200_000));
  });

  it('keeps the highest peak per day/dimension/hour', async () => {
    const db = getDb();
    await db.maxPlanUsagePeak(tenantId, '2031-04-01', 'agent', 9, 3);
    await db.maxPlanUsagePeak(tenantId, '2031-04-01', 'agent', 9, 5);
    await db.maxPlanUsagePeak(tenantId, '2031-04-01', 'agent', 9, 4);
    await db.maxPlanUsagePeak(tenantId, '2031-04-01', 'agent', 10, 2);
    await db.maxPlanUsagePeak(tenantId, '2031-04-01', 'api_rpm', 9, 120);
    await db.maxPlanUsagePeak(tenantId, '2031-04-02', 'agent', 0, 1);
    await db.maxPlanUsagePeak(otherTenantId, '2031-04-01', 'agent', 9, 99);

    const peaks = await db.getPlanUsagePeaks(tenantId, ['2031-04-01', '2031-04-02']);
    const sorted = [...peaks].sort(
      (a, b) => a.day.localeCompare(b.day) || a.dimension.localeCompare(b.dimension) || a.hour - b.hour,
    );
    expect(sorted).toEqual([
      { day: '2031-04-01', dimension: 'agent', hour: 9, value: 5 },
      { day: '2031-04-01', dimension: 'agent', hour: 10, value: 2 },
      { day: '2031-04-01', dimension: 'api_rpm', hour: 9, value: 120 },
      { day: '2031-04-02', dimension: 'agent', hour: 0, value: 1 },
    ]);

    expect(await db.getPlanUsagePeaks(tenantId, ['2031-04-02'])).toHaveLength(1);
    expect(await db.getPlanUsagePeaks(tenantId, [])).toEqual([]);
  });

  it('rejects dimensions that are not plain identifiers', async () => {
    const db = getDb();
    await expect(db.maxPlanUsagePeak(tenantId, '2031-04-01', 'a.b', 1, 1)).rejects.toThrow();
    await expect(db.maxPlanUsagePeak(tenantId, '2031-04-01', '$set', 1, 1)).rejects.toThrow();
    await expect(db.maxPlanUsagePeak(tenantId, '2031-04-01', '', 1, 1)).rejects.toThrow();
  });
});
