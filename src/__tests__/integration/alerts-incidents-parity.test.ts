/**
 * Alert rules / events / incidents, run against BOTH providers.
 *
 * Pins the project-scoped by-id access, the event lookup by id, the incident
 * list filters and per-status counts, malformed-id handling, and that every
 * field of the v2 rule/event/incident shapes round-trips (SQLite used to drop
 * `channels` on `updateAlertEvent`).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { describeForEachProvider } from './db-parity.helper';
import type { IAlertEvent, IAlertRule, IIncident } from '@/lib/database';

type Seed = { tenantId: string; projectId: string; otherProjectId: string };

function rule(seed: Seed, over: Partial<IAlertRule> = {}): Omit<IAlertRule, '_id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    name: 'Pulse Main error rate',
    module: 'agents',
    enabled: true,
    metric: 'agent_error_rate',
    condition: { operator: 'gt', threshold: 5 },
    windowMinutes: 15,
    cooldownMinutes: 60,
    channels: [{ id: 'ch_000000000001', type: 'email', recipients: ['ops@example.com'] }],
    createdBy: 'user-1',
    ...over,
  };
}

function event(seed: Seed, ruleId: string, over: Partial<IAlertEvent> = {}): Omit<IAlertEvent, '_id'> {
  return {
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    ruleId,
    ruleName: 'Pulse Main error rate',
    metric: 'agent_error_rate',
    threshold: 5,
    actualValue: 12,
    status: 'fired',
    channels: [],
    firedAt: new Date('2026-10-01T10:00:00.000Z'),
    ...over,
  };
}

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
    firedAt: new Date('2026-10-01T10:00:00.000Z'),
    ...over,
  };
}

describeForEachProvider('Alert rules, events and incidents', (getDb) => {
  let seed: Seed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `alerts-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Alerts',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { tenantId: String(tenant._id), projectId: `proj-${unique}`, otherProjectId: `other-${unique}` };
  });

  // ── Rules ────────────────────────────────────────────────────────────

  describe('rules', () => {
    it('round-trips the v2 rule fields', async () => {
      const db = getDb();
      const created = await db.createAlertRule(rule(seed, {
        entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] },
        severity: 'critical',
        notifyOnResolve: true,
        renotifyMinutes: 120,
        condition: {
          operator: 'gt',
          threshold: 0,
          mode: 'baseline',
          forMinutes: 10,
          minSamples: 20,
          baseline: { direction: 'up', minRatio: 1.5, minZ: 3, minDelta: 2, lookbackDays: 14, seasonality: 'daily' },
        },
      }));
      const found = await db.findAlertRuleById(String(created._id));

      expect(String(found?._id)).toBe(String(created._id));
      expect(found).toMatchObject({
        module: 'agents',
        metric: 'agent_error_rate',
        entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] },
        severity: 'critical',
        notifyOnResolve: true,
        renotifyMinutes: 120,
        condition: { mode: 'baseline', forMinutes: 10, baseline: { lookbackDays: 14, seasonality: 'daily' } },
        channels: [{ id: 'ch_000000000001', type: 'email', recipients: ['ops@example.com'] }],
      });
    });

    it('reads a rule that carries none of the v2 fields', async () => {
      const db = getDb();
      const created = await db.createAlertRule(rule(seed));
      const found = await db.findAlertRuleById(String(created._id));
      expect(found?.entity).toBeUndefined();
      expect(found?.severity).toBeUndefined();
      expect(found?.notifyOnResolve).toBeUndefined();
      expect(found?.renotifyMinutes).toBeUndefined();
    });

    it('scopes find, update and delete to the given project', async () => {
      const db = getDb();
      const created = await db.createAlertRule(rule(seed));
      const id = String(created._id);

      expect(await db.findAlertRuleById(id, seed.otherProjectId)).toBeNull();
      expect((await db.findAlertRuleById(id, seed.projectId))?.name).toBe('Pulse Main error rate');
      // No project given: unscoped (internal callers such as the scheduler).
      expect(await db.findAlertRuleById(id)).not.toBeNull();

      expect(await db.updateAlertRule(id, { name: 'renamed-elsewhere' }, seed.otherProjectId)).toBeNull();
      expect((await db.findAlertRuleById(id))?.name).toBe('Pulse Main error rate');
      const updated = await db.updateAlertRule(id, { name: 'renamed', enabled: false }, seed.projectId);
      expect(updated).toMatchObject({ name: 'renamed', enabled: false });

      expect(await db.deleteAlertRule(id, seed.otherProjectId)).toBe(false);
      expect(await db.findAlertRuleById(id)).not.toBeNull();
      expect(await db.deleteAlertRule(id, seed.projectId)).toBe(true);
      expect(await db.findAlertRuleById(id)).toBeNull();
    });

    it('clears optional v2 fields with null and updates them', async () => {
      const db = getDb();
      const created = await db.createAlertRule(rule(seed, { severity: 'warning', renotifyMinutes: 30 }));
      const id = String(created._id);

      const updated = await db.updateAlertRule(id, {
        severity: 'critical',
        notifyOnResolve: false,
        entity: { entityType: 'model', mode: 'all' },
      });
      expect(updated).toMatchObject({ severity: 'critical', notifyOnResolve: false, entity: { entityType: 'model', mode: 'all' } });
      expect(updated?.renotifyMinutes).toBe(30);
    });

    it('answers null/false for malformed ids instead of throwing', async () => {
      const db = getDb();
      expect(await db.findAlertRuleById('not-an-id')).toBeNull();
      expect(await db.updateAlertRule('not-an-id', { name: 'x' })).toBeNull();
      expect(await db.deleteAlertRule('not-an-id')).toBe(false);
      expect(await db.findAlertEventById('not-an-id')).toBeNull();
      expect(await db.findIncidentById('not-an-id')).toBeNull();
      expect(await db.updateIncident('not-an-id', { status: 'resolved' })).toBeNull();
      expect(await db.updateAlertEvent('not-an-id', { status: 'resolved' })).toBeNull();
    });

    it('returns string ids from every read path', async () => {
      const db = getDb();
      await db.createAlertRule(rule(seed));
      const listed = await db.listAlertRules(seed.tenantId, { projectId: seed.projectId });
      expect(listed).toHaveLength(1);
      expect(typeof listed[0]._id).toBe('string');
    });
  });

  // ── Events ───────────────────────────────────────────────────────────

  describe('events', () => {
    it('finds an event by id, scoped to the project', async () => {
      const db = getDb();
      const created = await db.createAlertEvent(event(seed, 'rule-1', {
        entityType: 'agent',
        entityKey: 'Pulse Main',
        baselineValue: 2.5,
        sampleCount: 80,
      }));
      const id = String(created._id);

      const found = await db.findAlertEventById(id, seed.projectId);
      expect(String(found?._id)).toBe(id);
      expect(found).toMatchObject({ entityType: 'agent', entityKey: 'Pulse Main', baselineValue: 2.5, sampleCount: 80, ruleId: 'rule-1' });
      expect(await db.findAlertEventById(id, seed.otherProjectId)).toBeNull();
      expect(await db.findAlertEventById(id)).not.toBeNull();
    });

    it('persists channels and every v2 field on update (SQLite used to drop channels)', async () => {
      const db = getDb();
      const created = await db.createAlertEvent(event(seed, 'rule-1'));
      const id = String(created._id);
      const resolvedAt = new Date('2026-10-01T10:30:00.000Z');
      const acknowledgedAt = new Date('2026-10-01T10:10:00.000Z');

      const updated = await db.updateAlertEvent(id, {
        channels: [{ type: 'email', target: 'ops@example.com', success: true }, { type: 'webhook', target: 'hook', success: false, error: 'HTTP 500' }],
        status: 'resolved',
        kind: 'resolved',
        resolvedAt,
        acknowledgedBy: 'user-9',
        acknowledgedAt,
        actualValue: 1.5,
        baselineValue: 2,
        sampleCount: 33,
        entityType: 'model',
        entityKey: 'gpt-x',
      });
      expect(updated?.channels).toHaveLength(2);

      const reread = await db.findAlertEventById(id);
      expect(reread?.channels).toEqual([
        { type: 'email', target: 'ops@example.com', success: true },
        { type: 'webhook', target: 'hook', success: false, error: 'HTTP 500' },
      ]);
      expect(reread).toMatchObject({
        status: 'resolved',
        kind: 'resolved',
        acknowledgedBy: 'user-9',
        actualValue: 1.5,
        baselineValue: 2,
        sampleCount: 33,
        entityType: 'model',
        entityKey: 'gpt-x',
      });
      expect(reread?.resolvedAt?.getTime()).toBe(resolvedAt.getTime());
      expect(reread?.acknowledgedAt?.getTime()).toBe(acknowledgedAt.getTime());
    });

    it('counts only fired events as active, so a resolved event drops out', async () => {
      const db = getDb();
      const a = await db.createAlertEvent(event(seed, 'rule-1'));
      await db.createAlertEvent(event(seed, 'rule-1'));
      expect(await db.countActiveAlerts(seed.tenantId, seed.projectId)).toBe(2);

      await db.updateAlertEvent(String(a._id), { status: 'resolved', resolvedAt: new Date() });
      expect(await db.countActiveAlerts(seed.tenantId, seed.projectId)).toBe(1);
    });

    it('lists newest first, filters, and clamps limit/skip', async () => {
      const db = getDb();
      for (let i = 0; i < 5; i++) {
        await db.createAlertEvent(event(seed, i % 2 ? 'rule-b' : 'rule-a', { firedAt: new Date(Date.UTC(2026, 9, 1, i)) }));
      }
      const all = await db.listAlertEvents(seed.tenantId, { projectId: seed.projectId });
      expect(all.map((e) => e.firedAt.getUTCHours())).toEqual([4, 3, 2, 1, 0]);
      expect(typeof all[0]._id).toBe('string');

      expect(await db.listAlertEvents(seed.tenantId, { projectId: seed.projectId, ruleId: 'rule-b' })).toHaveLength(2);
      expect(await db.listAlertEvents(seed.tenantId, { projectId: seed.projectId, limit: 2, skip: 1 })).toHaveLength(2);
      // Out-of-range paging never errors or returns a negative window.
      expect(await db.listAlertEvents(seed.tenantId, { projectId: seed.projectId, limit: 0 })).toHaveLength(1);
      expect(await db.listAlertEvents(seed.tenantId, { projectId: seed.projectId, limit: 99999 })).toHaveLength(5);
      expect(await db.listAlertEvents(seed.tenantId, { projectId: seed.projectId, skip: -5 })).toHaveLength(5);
    });
  });

  // ── Incidents ────────────────────────────────────────────────────────

  describe('incidents', () => {
    it('round-trips the v2 incident fields', async () => {
      const db = getDb();
      const created = await db.createIncident(incident(seed, {
        module: 'agents',
        entityType: 'agent',
        entityKey: 'Pulse Main',
        baselineValue: 2,
        lastValue: 11,
        peakValue: 14,
        autoResolved: false,
        context: {
          mode: 'baseline',
          windowMinutes: 15,
          errorSignatures: [{ message: 'timeout', count: 4 }],
          failingSessions: { count: 4, listPath: '/dashboard/tracing/sessions?agent=Pulse%20Main&status=error' },
          notes: ['n'],
        },
      }));
      const found = await db.findIncidentById(String(created._id));

      expect(String(found?._id)).toBe(String(created._id));
      expect(found).toMatchObject({
        module: 'agents',
        entityType: 'agent',
        entityKey: 'Pulse Main',
        baselineValue: 2,
        lastValue: 11,
        peakValue: 14,
        autoResolved: false,
        context: { mode: 'baseline', windowMinutes: 15, errorSignatures: [{ message: 'timeout', count: 4 }] },
      });

      const updated = await db.updateIncident(String(created._id), {
        status: 'resolved',
        autoResolved: true,
        acknowledgedBy: 'user-3',
        lastValue: 1,
        peakValue: 15,
        resolvedAt: new Date('2026-10-01T11:00:00.000Z'),
      });
      expect(updated).toMatchObject({ status: 'resolved', autoResolved: true, acknowledgedBy: 'user-3', lastValue: 1, peakValue: 15 });
    });

    it('scopes find and update to the given project', async () => {
      const db = getDb();
      const created = await db.createIncident(incident(seed));
      const id = String(created._id);

      expect(await db.findIncidentById(id, seed.otherProjectId)).toBeNull();
      expect((await db.findIncidentById(id, seed.projectId))?.status).toBe('open');
      expect(await db.findIncidentById(id)).not.toBeNull();

      expect(await db.updateIncident(id, { status: 'closed' }, seed.otherProjectId)).toBeNull();
      expect((await db.findIncidentById(id))?.status).toBe('open');
      expect((await db.updateIncident(id, { status: 'acknowledged' }, seed.projectId))?.status).toBe('acknowledged');
    });

    it('filters the list by severity, rule, entity, module and status, and pages it', async () => {
      const db = getDb();
      await db.createIncident(incident(seed, { ruleId: 'r1', severity: 'critical', entityKey: 'a', module: 'agents', firedAt: new Date(Date.UTC(2026, 9, 1, 1)) }));
      await db.createIncident(incident(seed, { ruleId: 'r1', severity: 'warning', entityKey: 'b', module: 'agents', firedAt: new Date(Date.UTC(2026, 9, 1, 2)) }));
      await db.createIncident(incident(seed, { ruleId: 'r2', severity: 'warning', entityKey: 'a', module: 'models', status: 'resolved', firedAt: new Date(Date.UTC(2026, 9, 1, 3)) }));
      await db.createIncident(incident(seed, { projectId: seed.otherProjectId, ruleId: 'r1', severity: 'critical', entityKey: 'a' }));
      const base = { projectId: seed.projectId };

      expect((await db.listIncidents(seed.tenantId, base)).map((i) => i.entityKey)).toEqual(['a', 'b', 'a']);
      expect(await db.listIncidents(seed.tenantId, { ...base, severity: 'critical' })).toHaveLength(1);
      expect(await db.listIncidents(seed.tenantId, { ...base, ruleId: 'r1' })).toHaveLength(2);
      expect(await db.listIncidents(seed.tenantId, { ...base, entityKey: 'a' })).toHaveLength(2);
      expect(await db.listIncidents(seed.tenantId, { ...base, module: 'models' })).toHaveLength(1);
      expect(await db.listIncidents(seed.tenantId, { ...base, status: 'resolved' })).toHaveLength(1);
      expect(await db.listIncidents(seed.tenantId, { ...base, ruleId: 'r1', entityKey: 'b', severity: 'warning' })).toHaveLength(1);

      const page = await db.listIncidents(seed.tenantId, { ...base, limit: 1, skip: 1 });
      expect(page).toHaveLength(1);
      expect(page[0].entityKey).toBe('b');
      expect(typeof page[0]._id).toBe('string');

      // Clamped to 1..200 rather than erroring or returning everything.
      expect(await db.listIncidents(seed.tenantId, { ...base, limit: 0 })).toHaveLength(1);
      expect(await db.listIncidents(seed.tenantId, { ...base, limit: 5000 })).toHaveLength(3);
      expect(await db.listIncidents(seed.tenantId, { ...base, skip: -3 })).toHaveLength(3);
    });

    it('counts incidents per status for a project, with every status present', async () => {
      const db = getDb();
      await db.createIncident(incident(seed, { status: 'open' }));
      await db.createIncident(incident(seed, { status: 'open' }));
      await db.createIncident(incident(seed, { status: 'resolved' }));
      await db.createIncident(incident(seed, { status: 'investigating' }));
      await db.createIncident(incident(seed, { projectId: seed.otherProjectId, status: 'closed' }));

      expect(await db.countIncidentsByStatus(seed.projectId)).toEqual({
        open: 2,
        acknowledged: 0,
        investigating: 1,
        resolved: 1,
        closed: 0,
      });
      expect(await db.countIncidentsByStatus(`${seed.projectId}-none`)).toEqual({
        open: 0, acknowledged: 0, investigating: 0, resolved: 0, closed: 0,
      });
    });

    it('still finds an incident by its alert event id', async () => {
      const db = getDb();
      await db.createIncident(incident(seed, { alertEventId: 'evt-xyz' }));
      const found = await db.findIncidentByAlertEventId('evt-xyz');
      expect(found?.alertEventId).toBe('evt-xyz');
      expect(typeof found?._id).toBe('string');
    });
  });
});
