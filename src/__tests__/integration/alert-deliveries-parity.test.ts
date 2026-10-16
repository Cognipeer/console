/**
 * Rule mute / runbook / lastEvaluation fields and the alert delivery log
 * (`alert_deliveries`), run against BOTH providers.
 */

import { it, expect, beforeEach } from 'vitest';

import { describeForEachProvider, listTenantIndexNames, sqliteQueryPlan } from './db-parity.helper';
import type { IAlertDelivery } from '@/lib/database';

type Seed = { tenantId: string; projectId: string };

function delivery(seed: Seed, over: Partial<Omit<IAlertDelivery, '_id'>> = {}): Omit<IAlertDelivery, '_id'> {
  return {
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    ruleId: 'rule-1',
    incidentId: 'inc-1',
    eventId: 'evt-1',
    channelId: 'ch_aaaaaaaaaaaa',
    channelKind: 'email',
    channelName: null,
    trigger: 'fire',
    status: 'sent',
    reason: null,
    error: null,
    attemptAt: new Date('2026-10-10T10:00:00.000Z'),
    ...over,
  };
}

describeForEachProvider('Alert rule mute fields and delivery log', (getDb) => {
  let seed: Seed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `alert-deliv-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Alert Deliveries', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    await db.switchToTenant(dbName);
    seed = { tenantId: String(tenant._id), projectId: `proj-${unique}` };
  });

  async function newRule(extra: Record<string, unknown> = {}) {
    return getDb().createAlertRule({
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      name: 'Rule',
      module: 'models',
      enabled: true,
      metric: 'error_rate',
      condition: { operator: 'gt', threshold: 5 },
      windowMinutes: 15,
      cooldownMinutes: 15,
      channels: [],
      createdBy: 'u1',
      ...extra,
    } as never);
  }

  it('stores, updates and clears mute, runbook and lastEvaluation', async () => {
    const db = getDb();
    const until = new Date('2026-11-01T00:00:00.000Z');
    const at = new Date('2026-10-10T10:00:00.000Z');
    const created = await newRule({ runbookUrl: 'https://wiki.example.com/rb', mutedUntil: until, mutedBy: 'u1', muteReason: 'deploy' });
    const found = await db.findAlertRuleById(String(created._id));
    expect(found).toMatchObject({ runbookUrl: 'https://wiki.example.com/rb', mutedBy: 'u1', muteReason: 'deploy' });
    expect(new Date(found!.mutedUntil as Date).getTime()).toBe(until.getTime());

    const updatedAtBefore = new Date(found!.updatedAt as Date).getTime();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const withEval = await db.updateAlertRule(String(created._id), { lastEvaluation: { at, targets: 4, noDataTargets: 4 } });
    expect(withEval!.lastEvaluation).toMatchObject({ targets: 4, noDataTargets: 4 });
    expect(new Date(withEval!.lastEvaluation!.at).getTime()).toBe(at.getTime());
    // bookkeeping write: updatedAt stays
    expect(new Date(withEval!.updatedAt as Date).getTime()).toBe(updatedAtBefore);

    const cleared = await db.updateAlertRule(String(created._id), {
      mutedUntil: null, mutedBy: null, muteReason: null, runbookUrl: null,
    });
    expect(cleared!.mutedUntil ?? null).toBeNull();
    expect(cleared!.mutedBy ?? null).toBeNull();
    expect(cleared!.muteReason ?? null).toBeNull();
    expect(cleared!.runbookUrl ?? null).toBeNull();
    expect(cleared!.lastEvaluation).toMatchObject({ targets: 4 });
  });

  it('writes deliveries in a batch and lists them newest first by incident or rule', async () => {
    const db = getDb();
    await db.createAlertDeliveries([
      delivery(seed, { attemptAt: new Date('2026-10-10T10:00:00.000Z') }),
      delivery(seed, { trigger: 'renotify', status: 'suppressed', reason: 'rule_muted', attemptAt: new Date('2026-10-10T11:00:00.000Z') }),
      delivery(seed, { incidentId: 'inc-2', ruleId: 'rule-2', status: 'failed', error: 'HTTP 500', attemptAt: new Date('2026-10-10T12:00:00.000Z') }),
    ]);

    const byIncident = await db.listAlertDeliveries(seed.tenantId, { incidentId: 'inc-1' });
    expect(byIncident.map((d) => d.trigger)).toEqual(['renotify', 'fire']);
    expect(byIncident[0]).toMatchObject({ status: 'suppressed', reason: 'rule_muted', channelId: 'ch_aaaaaaaaaaaa', channelKind: 'email' });
    expect(byIncident[0].attemptAt).toBeInstanceOf(Date);

    const byRule = await db.listAlertDeliveries(seed.tenantId, { ruleId: 'rule-2' });
    expect(byRule).toHaveLength(1);
    expect(byRule[0]).toMatchObject({ status: 'failed', error: 'HTTP 500', incidentId: 'inc-2' });

    expect(await db.listAlertDeliveries('other-tenant', { incidentId: 'inc-1' })).toEqual([]);
    expect(await db.listAlertDeliveries(seed.tenantId, { incidentId: 'inc-1', limit: 1 })).toHaveLength(1);
  });

  it('prunes rows older than the cutoff', async () => {
    const db = getDb();
    await db.createAlertDeliveries([
      delivery(seed, { attemptAt: new Date('2026-08-01T00:00:00.000Z') }),
      delivery(seed, { attemptAt: new Date('2026-10-10T00:00:00.000Z') }),
    ]);
    const removed = await db.pruneAlertDeliveries(new Date('2026-09-01T00:00:00.000Z'));
    expect(removed).toBe(1);
    expect(await db.listAlertDeliveries(seed.tenantId, { incidentId: 'inc-1' })).toHaveLength(1);
  });

  it('lists fire timestamps per rule since a date, newest first', async () => {
    const db = getDb();
    const base = {
      tenantId: seed.tenantId, projectId: seed.projectId, ruleName: 'R', metric: 'error_rate' as const,
      threshold: 5, actualValue: 9, status: 'fired' as const, channels: [],
    };
    await db.createAlertEvent({ ...base, ruleId: 'r1', firedAt: new Date('2026-10-01T00:00:00.000Z') });
    await db.createAlertEvent({ ...base, ruleId: 'r1', firedAt: new Date('2026-10-12T00:00:00.000Z') });
    await db.createAlertEvent({ ...base, ruleId: 'r2', firedAt: new Date('2026-10-13T00:00:00.000Z') });
    await db.createAlertEvent({ ...base, projectId: 'other', ruleId: 'r3', firedAt: new Date('2026-10-13T00:00:00.000Z') });

    const rows = await db.listAlertFirings(seed.tenantId, { projectId: seed.projectId, since: new Date('2026-10-05T00:00:00.000Z') });
    expect(rows.map((r) => r.ruleId)).toEqual(['r2', 'r1']);
    expect(rows[0].firedAt).toBeInstanceOf(Date);
  });

  it('has the incident and rule delivery indexes', async () => {
    const db = getDb();
    await db.createAlertDeliveries([delivery(seed)]);
    const names = await listTenantIndexNames(db, 'alert_deliveries');
    expect(names).toEqual(expect.arrayContaining([
      'idx_alert_deliveries_incident_attemptAt',
      'idx_alert_deliveries_rule_attemptAt',
    ]));
    const plan = sqliteQueryPlan(
      db,
      'SELECT * FROM alert_deliveries WHERE tenantId = @t AND incidentId = @i ORDER BY attemptAt DESC',
      { t: seed.tenantId, i: 'inc-1' },
    );
    if (plan !== null) expect(plan).toContain('idx_alert_deliveries_incident_attemptAt');
  });
});
