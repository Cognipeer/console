/**
 * Incident inbox store features, run against BOTH providers: live refresh
 * (`updatedAfter`), server-side q / assignee / snoozed / sort, the stats rows,
 * the snooze + reopen fields, and the indexes behind them.
 */

import { beforeEach, expect, it } from 'vitest';

import { describeForEachProvider, listTenantIndexNames, sqliteQueryPlan } from './db-parity.helper';
import type { IIncident } from '@/lib/database';

type Seed = { tenantId: string; projectId: string; otherProjectId: string };

const T0 = new Date('2026-10-01T10:00:00.000Z').getTime();
const min = (n: number) => new Date(T0 + n * 60_000);

function incident(seed: Seed, over: Partial<IIncident> = {}): Omit<IIncident, '_id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    alertEventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    ruleId: 'rule-1',
    ruleName: 'Pulse Main error rate',
    metric: 'agent_error_rate',
    threshold: 5,
    actualValue: 12,
    severity: 'warning',
    status: 'open',
    notes: [],
    firedAt: min(0),
    ...over,
  };
}

describeForEachProvider('Incident inbox store features', (getDb) => {
  let seed: Seed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `inbox-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Inbox', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    await db.switchToTenant(dbName);
    seed = { tenantId: String(tenant._id), projectId: `proj-${unique}`, otherProjectId: `other-${unique}` };
  });

  const list = async (options: Record<string, unknown> = {}) => {
    const rows = await getDb().listIncidents(seed.tenantId, { projectId: seed.projectId, limit: 200, ...options });
    return rows.map((r) => r.ruleName);
  };

  it('round-trips snooze and reopen fields, and null clears them', async () => {
    const db = getDb();
    const until = min(120);
    const created = await db.createIncident(incident(seed, { snoozedUntil: until, snoozedBy: 'u1', reopenedAt: min(5), reopenCount: 2 }));
    const found = await db.findIncidentById(String(created._id));
    expect(found?.snoozedUntil?.toISOString()).toBe(until.toISOString());
    expect(found).toMatchObject({ snoozedBy: 'u1', reopenCount: 2 });
    expect(found?.reopenedAt?.toISOString()).toBe(min(5).toISOString());

    const cleared = await db.updateIncident(String(created._id), { snoozedUntil: null, snoozedBy: null } as never);
    expect(cleared?.snoozedUntil ?? null).toBeNull();
    expect(cleared?.snoozedBy ?? null).toBeNull();
    expect(cleared?.reopenCount).toBe(2);

    const bumped = await db.updateIncident(String(created._id), { reopenCount: 3, reopenedAt: min(9) });
    expect(bumped?.reopenCount).toBe(3);
    expect(bumped?.reopenedAt?.toISOString()).toBe(min(9).toISOString());
  });

  it('updatedAfter is strict and follows every write', async () => {
    const db = getDb();
    const a = await db.createIncident(incident(seed, { ruleName: 'A' }));
    await new Promise((r) => setTimeout(r, 15));
    const marker = new Date();
    await new Promise((r) => setTimeout(r, 15));
    expect(await list({ updatedAfter: marker })).toEqual([]);
    const b = await db.createIncident(incident(seed, { ruleName: 'B' }));
    expect(await list({ updatedAfter: marker })).toEqual(['B']);
    await new Promise((r) => setTimeout(r, 5));
    await db.updateIncident(String(a._id), { lastValue: 99 });
    expect((await list({ updatedAfter: marker })).sort()).toEqual(['A', 'B']);
    expect(String(b._id)).toBeTruthy();
  });

  it('q is a case/Turkish-i-insensitive literal substring over ruleName, entityKey and metric', async () => {
    const db = getDb();
    await db.createIncident(incident(seed, { ruleName: 'Latency_p95 100%', entityKey: 'Isparta Agent' }));
    await db.createIncident(incident(seed, { ruleName: 'Other', entityKey: 'plain', metric: 'avg_latency_ms' }));
    expect(await list({ q: 'LATENCY_P95' })).toEqual(['Latency_p95 100%']);
    expect(await list({ q: 'ency_p9' })).toEqual(['Latency_p95 100%']);
    expect(await list({ q: '100%' })).toEqual(['Latency_p95 100%']);
    expect(await list({ q: 'y_p' })).toEqual(['Latency_p95 100%']);   // `_` literal
    expect(await list({ q: 'y.p' })).toEqual([]);                      // `.` literal (regex-safe)
    expect(await list({ q: '%' })).toEqual(['Latency_p95 100%']);      // `%` literal
    expect(await list({ q: 'ısparta' })).toEqual(['Latency_p95 100%']); // Turkish dotless i
    expect(await list({ q: 'avg_latency' })).toEqual(['Other']);        // metric id
    expect(await list({ q: 'nothing-here' })).toEqual([]);
  });

  it('filters by assignee (user / unassigned) and snoozed, combined with other filters', async () => {
    const db = getDb();
    const future = new Date(Date.now() + 3_600_000);
    const past = new Date(Date.now() - 3_600_000);
    await db.createIncident(incident(seed, { ruleName: 'mine', assignedTo: 'u1', snoozedUntil: future }));
    await db.createIncident(incident(seed, { ruleName: 'theirs', assignedTo: 'u2', snoozedUntil: past }));
    await db.createIncident(incident(seed, { ruleName: 'nobody' }));
    const cleared = await db.createIncident(incident(seed, { ruleName: 'cleared', assignedTo: 'u1' }));
    await db.updateIncident(String(cleared._id), { assignedTo: null as never });

    expect((await list({ assignee: 'u1' })).sort()).toEqual(['mine']);
    expect((await list({ assignee: null })).sort()).toEqual(['cleared', 'nobody']);
    expect(await list({ snoozed: true })).toEqual(['mine']);
    expect((await list({ snoozed: false })).sort()).toEqual(['cleared', 'nobody', 'theirs']);
    expect(await list({ snoozed: false, assignee: 'u2' })).toEqual(['theirs']);
    expect(await list({ snoozed: true, q: 'min' })).toEqual(['mine']);
    expect(await list({ snoozed: true, q: 'theirs' })).toEqual([]);
  });

  it('sorts by firedAt / updatedAt / severity and pages stably (severity walk with skip)', async () => {
    const db = getDb();
    const specs: Array<[string, IIncident['severity'], number]> = [
      ['c1', 'critical', 1], ['c2', 'critical', 4], ['w1', 'warning', 2], ['w2', 'warning', 5], ['i1', 'info', 3], ['i2', 'info', 6],
    ];
    for (const [name, severity, at] of specs) await db.createIncident(incident(seed, { ruleName: name, severity, firedAt: min(at) }));

    expect(await list()).toEqual(['i2', 'w2', 'c2', 'i1', 'w1', 'c1']);                  // default -firedAt
    expect(await list({ sort: '-firedAt' })).toEqual(['i2', 'w2', 'c2', 'i1', 'w1', 'c1']);
    expect(await list({ sort: 'firedAt' })).toEqual(['c1', 'w1', 'i1', 'c2', 'w2', 'i2']);
    expect(await list({ sort: '-severity' })).toEqual(['c2', 'c1', 'w2', 'w1', 'i2', 'i1']);
    expect(await list({ sort: 'severity' })).toEqual(['i2', 'i1', 'w2', 'w1', 'c2', 'c1']);

    // Pages of 2 and 4 across severity boundaries, with skip landing mid-segment.
    expect(await list({ sort: '-severity', limit: 2, skip: 0 })).toEqual(['c2', 'c1']);
    expect(await list({ sort: '-severity', limit: 2, skip: 1 })).toEqual(['c1', 'w2']);
    expect(await list({ sort: '-severity', limit: 4, skip: 3 })).toEqual(['w1', 'i2', 'i1']);
    expect(await list({ sort: 'severity', limit: 3, skip: 3 })).toEqual(['w1', 'c2', 'c1']);
    expect(await list({ sort: '-severity', limit: 5, skip: 6 })).toEqual([]);
    // With a severity filter the walk is that one severity.
    expect(await list({ sort: '-severity', severity: 'warning', limit: 1, skip: 1 })).toEqual(['w1']);

    // updatedAt: touch c1 last -> it is the newest.
    await new Promise((r) => setTimeout(r, 15));
    const c1 = (await db.listIncidents(seed.tenantId, { projectId: seed.projectId, q: 'c1' }))[0];
    await db.updateIncident(String(c1._id), { lastValue: 1 });
    expect((await list({ sort: '-updatedAt', limit: 1 }))).toEqual(['c1']);
    expect((await list({ sort: 'updatedAt' })).pop()).toBe('c1');
  });

  it('firedAfter and excludeId narrow the list; other projects stay out', async () => {
    const db = getDb();
    const a = await db.createIncident(incident(seed, { ruleName: 'old', firedAt: min(-600) }));
    await db.createIncident(incident(seed, { ruleName: 'new', firedAt: min(10) }));
    const foreign = await db.createIncident(incident({ ...seed, projectId: seed.otherProjectId }, { ruleName: 'foreign' }));
    expect(await list({ firedAfter: min(0) })).toEqual(['new']);
    expect((await list({ excludeId: String(a._id) }))).toEqual(['new']);
    expect(String(foreign._id)).toBeTruthy();
  });

  it('lists the minimal stat rows: fired and/or resolved since, project-scoped, capped', async () => {
    const db = getDb();
    const fresh = await db.createIncident(incident(seed, { ruleName: 'fresh', firedAt: min(100), acknowledgedAt: min(110), autoResolved: false }));
    const oldResolved = await db.createIncident(incident(seed, { ruleName: 'oldResolved', firedAt: min(-1000), status: 'resolved', resolvedAt: min(105) }));
    await db.createIncident(incident(seed, { ruleName: 'ancient', firedAt: min(-1000), status: 'resolved', resolvedAt: min(-900) }));
    await db.createIncident(incident({ ...seed, projectId: seed.otherProjectId }, { firedAt: min(100) }));

    const firedOnly = await db.listIncidentStatRows(seed.projectId, { firedSince: min(50) });
    expect(firedOnly.map((r) => String(r._id))).toEqual([String(fresh._id)]);
    expect(firedOnly[0].acknowledgedAt?.toISOString()).toBe(min(110).toISOString());
    expect(firedOnly[0].status).toBe('open');

    const both = await db.listIncidentStatRows(seed.projectId, { firedSince: min(50), resolvedSince: min(50) });
    expect(both.map((r) => String(r._id)).sort()).toEqual([String(fresh._id), String(oldResolved._id)].sort());
    expect(both.find((r) => String(r._id) === String(oldResolved._id))?.resolvedAt?.toISOString()).toBe(min(105).toISOString());

    expect(await db.listIncidentStatRows(seed.projectId, {})).toEqual([]);
    expect(await db.listIncidentStatRows(seed.projectId, { firedSince: min(-5000), limit: 1 })).toHaveLength(1);
  });

  it('indexes live refresh (updatedAt)', async () => {
    const db = getDb();
    await db.createIncident(incident(seed, { ruleName: 'idx' }));
    const names = await listTenantIndexNames(db, 'incidents');
    expect(names).toEqual(expect.arrayContaining([
      'idx_incidents_tenant_project_updatedAt',
    ]));
    const plan = sqliteQueryPlan(
      db,
      'SELECT * FROM incidents WHERE tenantId = @tenantId AND projectId = @projectId AND updatedAt > @updatedAfter',
      { tenantId: seed.tenantId, projectId: seed.projectId, updatedAfter: '2026-01-01T00:00:00.000Z' },
    );
    if (plan !== null) expect(plan).toContain('USING INDEX idx_incidents_tenant_project_updatedAt');
  });
});
