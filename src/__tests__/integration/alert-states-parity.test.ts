/**
 * Alert evaluation state (`alert_states`), run against BOTH providers.
 */

import { it, expect, beforeEach } from 'vitest';

import { describeForEachProvider } from './db-parity.helper';
import type { IAlertState } from '@/lib/database';

type Seed = { tenantId: string; projectId: string };

function state(seed: Seed, over: Partial<Omit<IAlertState, '_id' | 'updatedAt'>> = {}): Omit<IAlertState, '_id' | 'updatedAt'> {
  const at = new Date('2026-10-01T10:00:00.000Z');
  return {
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    ruleId: 'rule-1',
    entityKey: 'Pulse Main',
    entityType: 'agent',
    phase: 'pending',
    phaseSince: at,
    breachStreak: 1,
    okStreak: 0,
    lastValue: 12.5,
    lastBaseline: 3.1,
    lastSampleCount: 40,
    lastEvaluatedAt: at,
    incidentId: null,
    eventId: null,
    firedAt: null,
    lastFiredAt: null,
    lastNotifiedAt: null,
    peakValue: 12.5,
    detail: null,
    ...over,
  };
}

describeForEachProvider('Alert states', (getDb) => {
  let seed: Seed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `alert-state-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Alert State',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { tenantId: String(tenant._id), projectId: `proj-${unique}` };
  });

  it('creates a state and reads every field back', async () => {
    const db = getDb();
    const fired = new Date('2026-10-01T10:05:00.000Z');
    const created = await db.upsertAlertState(state(seed, {
      phase: 'firing',
      breachStreak: 3,
      incidentId: 'inc-1',
      eventId: 'evt-1',
      firedAt: fired,
      lastFiredAt: fired,
      lastNotifiedAt: fired,
      detail: { insufficientData: false, z: 4.2 },
    }));

    expect(typeof created._id).toBe('string');
    expect(created).toMatchObject({
      ruleId: 'rule-1',
      entityKey: 'Pulse Main',
      entityType: 'agent',
      phase: 'firing',
      breachStreak: 3,
      okStreak: 0,
      lastValue: 12.5,
      lastBaseline: 3.1,
      lastSampleCount: 40,
      incidentId: 'inc-1',
      eventId: 'evt-1',
      peakValue: 12.5,
      detail: { insufficientData: false, z: 4.2 },
    });
    expect(created.firedAt?.getTime()).toBe(fired.getTime());
    expect(created.phaseSince.getTime()).toBe(new Date('2026-10-01T10:00:00.000Z').getTime());
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('upserts by (rule, entity): the second write replaces the first', async () => {
    const db = getDb();
    const first = await db.upsertAlertState(state(seed));
    const second = await db.upsertAlertState(state(seed, { phase: 'ok', breachStreak: 0, okStreak: 2, lastValue: null, firedAt: null }));

    expect(String(second._id)).toBe(String(first._id));
    expect(second).toMatchObject({ phase: 'ok', breachStreak: 0, okStreak: 2, lastValue: null });

    const all = await db.listAlertStates({ ruleId: 'rule-1' });
    expect(all).toHaveLength(1);
  });

  it('resets omitted optional fields on the second upsert (replace semantics)', async () => {
    const db = getDb();
    const fired = new Date('2026-10-01T10:05:00.000Z');
    await db.upsertAlertState(state(seed, {
      phase: 'firing', incidentId: 'inc-1', eventId: 'evt-1', firedAt: fired, lastFiredAt: fired,
      lastNotifiedAt: fired, peakValue: 99, detail: { z: 4 },
    }));
    const { incidentId, eventId, firedAt, lastFiredAt, lastNotifiedAt, peakValue, detail, entityType, ...bare } = state(seed, { phase: 'ok' });
    void incidentId; void eventId; void firedAt; void lastFiredAt; void lastNotifiedAt; void peakValue; void detail; void entityType;
    const second = await db.upsertAlertState(bare as Omit<IAlertState, '_id' | 'updatedAt'>);
    expect(second).toMatchObject({
      phase: 'ok', incidentId: null, eventId: null, firedAt: null, lastFiredAt: null,
      lastNotifiedAt: null, peakValue: null, detail: null, entityType: null,
    });
    const [listed] = await db.listAlertStates({ ruleId: 'rule-1' });
    expect(listed).toMatchObject({ incidentId: null, firedAt: null, lastFiredAt: null, peakValue: null, detail: null });
  });

  it('ANDs ruleId with ruleIds', async () => {
    const db = getDb();
    await db.upsertAlertState(state(seed, { ruleId: 'r1' }));
    await db.upsertAlertState(state(seed, { ruleId: 'r2' }));
    expect(await db.listAlertStates({ ruleId: 'r1', ruleIds: ['r2'] })).toEqual([]);
    expect(await db.listAlertStates({ ruleId: 'r1', ruleIds: ['r1', 'r2'] })).toHaveLength(1);
  });

  it('keeps one row per entity of a rule and per rule of an entity', async () => {
    const db = getDb();
    await db.upsertAlertState(state(seed, { entityKey: 'a' }));
    await db.upsertAlertState(state(seed, { entityKey: 'b' }));
    await db.upsertAlertState(state(seed, { ruleId: 'rule-2', entityKey: 'a' }));
    // Rule-level target uses the empty entity key.
    await db.upsertAlertState(state(seed, { ruleId: 'rule-3', entityKey: '', entityType: null }));

    expect(await db.listAlertStates({ ruleId: 'rule-1' })).toHaveLength(2);
    const ruleLevel = await db.listAlertStates({ ruleId: 'rule-3' });
    expect(ruleLevel).toHaveLength(1);
    expect(ruleLevel[0]).toMatchObject({ entityKey: '', entityType: null });
  });

  it('survives concurrent upserts of the same (rule, entity)', async () => {
    const db = getDb();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => db.upsertAlertState(state(seed, { breachStreak: i }))),
    );
    expect(await db.listAlertStates({ ruleId: 'rule-1' })).toHaveLength(1);
  });

  it('filters by ruleIds, projectId, phases and limit', async () => {
    const db = getDb();
    await db.upsertAlertState(state(seed, { ruleId: 'r1', entityKey: 'a', phase: 'firing' }));
    await db.upsertAlertState(state(seed, { ruleId: 'r1', entityKey: 'b', phase: 'ok' }));
    await db.upsertAlertState(state(seed, { ruleId: 'r2', entityKey: 'a', phase: 'pending' }));
    await db.upsertAlertState(state(seed, { ruleId: 'r3', entityKey: 'a', phase: 'firing', projectId: 'other-project' }));

    const byRules = await db.listAlertStates({ ruleIds: ['r1', 'r2'] });
    expect(byRules).toHaveLength(3);

    const firing = await db.listAlertStates({ phases: ['firing'], projectId: seed.projectId });
    expect(firing.map((s) => [s.ruleId, s.entityKey])).toEqual([['r1', 'a']]);

    const active = await db.listAlertStates({ phases: ['firing', 'pending'] });
    expect(active).toHaveLength(3);

    expect(await db.listAlertStates({ ruleIds: [] })).toEqual([]);
    expect(await db.listAlertStates({ phases: [] })).toEqual([]);
    expect(await db.listAlertStates({ limit: 2 })).toHaveLength(2);
  });

  it('deletes by rule, or only the named entities of a rule', async () => {
    const db = getDb();
    await db.upsertAlertState(state(seed, { ruleId: 'r1', entityKey: 'a' }));
    await db.upsertAlertState(state(seed, { ruleId: 'r1', entityKey: 'b' }));
    await db.upsertAlertState(state(seed, { ruleId: 'r1', entityKey: 'c' }));
    await db.upsertAlertState(state(seed, { ruleId: 'r2', entityKey: 'a' }));

    expect(await db.deleteAlertStates({ ruleId: 'r1', entityKeys: ['a', 'missing'] })).toBe(1);
    expect((await db.listAlertStates({ ruleId: 'r1' })).map((s) => s.entityKey).sort()).toEqual(['b', 'c']);
    expect(await db.deleteAlertStates({ ruleId: 'r1', entityKeys: [] })).toBe(0);

    expect(await db.deleteAlertStates({ ruleId: 'r1' })).toBe(2);
    expect(await db.listAlertStates({ ruleId: 'r1' })).toEqual([]);
    expect(await db.listAlertStates({ ruleId: 'r2' })).toHaveLength(1);
  });
});
