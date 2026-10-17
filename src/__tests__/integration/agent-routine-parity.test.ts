/**
 * Agent routines parity — the routine store behaves identically on SQLite and
 * MongoDB: CRUD scoped by tenant + project, the type and its settings object
 * round-trip (a once time comes back a Date; a routine holds only the object
 * of its own type, also after the type changed), the scheduler's due list, the
 * CAS that moves `nextFireAt` on, the newest-fire-wins record of the last fire,
 * and the agent-delete cascade. Plus the two run flags routines set
 * (`unattended`, `externalContent`), which a resume requeue keeps; the
 * webhook type (found by hook id, its dates round-trip) and its delivery
 * log (newest first with a cursor, batched retention, removal per routine);
 * the runs list's trigger filter.
 */

import { beforeEach, expect, it } from 'vitest';
import type {
  AgentRoutineOnce,
  AgentRoutineSchedule,
  AgentRoutineType,
  AgentRoutineWebhook,
  IAgentRoutineBase,
  IAgentRoutineDelivery,
  NewAgentRoutine,
} from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Agent routines', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';

  beforeEach(async () => {
    const slug = `routines-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  /**
   * A new routine: a nightly schedule unless the overrides bring their own `type`
   * with the settings object of that type (a routine has only that one).
   */
  const record = (
    overrides: Partial<Omit<IAgentRoutineBase, '_id' | 'createdAt' | 'updatedAt'>>
      & Partial<{ type: AgentRoutineType; schedule: AgentRoutineSchedule; once: AgentRoutineOnce; webhook: AgentRoutineWebhook }> = {},
  ): NewAgentRoutine => ({
    tenantId,
    projectId,
    agentKey: 'report-bot',
    name: 'Nightly',
    enabled: true,
    ...(overrides.type ? {} : { type: 'schedule', schedule: { cron: '0 2 * * *', timezone: 'Europe/Istanbul' } }),
    prompt: 'Summarise.',
    runClass: 'default',
    createdBy: 'user-1',
    ...overrides,
  } as NewAgentRoutine);

  it('creates, reads, lists (oldest first), updates and deletes within the project', async () => {
    const db = getDb();
    const runAt = new Date('2026-11-01T06:00:00.000Z');
    const first = await db.createAgentRoutine(record({
      metadata: { team: 'ops' },
      inputs: { region: 'eu' },
      callback: { url: 'https://example.com/hook', secretSealed: 'sealed' },
      responseFormat: { type: 'json_object' },
      version: 3,
      nextFireAt: new Date('2026-10-18T23:00:00.000Z'),
    }));
    const second = await db.createAgentRoutine(record({ name: 'Once', type: 'once', once: { runAt }, runClass: 'deferred' }));
    await db.createAgentRoutine(record({ name: 'Other agent', agentKey: 'other' }));
    await db.createAgentRoutine(record({ name: 'Other project', projectId: 'proj-2' }));

    const got = await db.getAgentRoutine(String(first._id), tenantId, projectId);
    expect(got).toMatchObject({
      name: 'Nightly',
      enabled: true,
      type: 'schedule',
      schedule: { cron: '0 2 * * *', timezone: 'Europe/Istanbul' },
      metadata: { team: 'ops' },
      inputs: { region: 'eu' },
      callback: { url: 'https://example.com/hook', secretSealed: 'sealed' },
      responseFormat: { type: 'json_object' },
      version: 3,
      runClass: 'default',
      createdBy: 'user-1',
    });
    expect(new Date(got!.nextFireAt!).toISOString()).toBe('2026-10-18T23:00:00.000Z');
    const once = await db.getAgentRoutine(String(second._id), tenantId, projectId);
    expect(once).toMatchObject({ type: 'once', once: { runAt } });
    expect(once?.type === 'once' && once.once.runAt instanceof Date).toBe(true);
    expect(once?.runClass).toBe('deferred');
    // A routine holds only the settings object of its own type.
    expect(once).not.toHaveProperty('schedule');
    expect(once).not.toHaveProperty('webhook');
    expect(got).not.toHaveProperty('once');

    expect(await db.getAgentRoutine(String(first._id), tenantId, 'proj-2')).toBeNull();
    expect(await db.getAgentRoutine('not-an-id', tenantId, projectId)).toBeNull();
    expect((await db.listAgentRoutines({ tenantId, projectId, agentKey: 'report-bot' })).map((r) => r.name)).toEqual(['Nightly', 'Once']);
    expect(await db.listAgentRoutines({ tenantId, projectId })).toHaveLength(3);

    const updated = await db.updateAgentRoutine(String(first._id), tenantId, projectId, {
      name: 'Renamed', enabled: false, type: 'manual', nextFireAt: null, metadata: null, updatedBy: 'user-2',
    });
    expect(updated).toMatchObject({ name: 'Renamed', enabled: false, type: 'manual', metadata: null, updatedBy: 'user-2' });
    // Changing the type drops the settings object of the type it left.
    expect(updated).not.toHaveProperty('schedule');
    expect(await db.getAgentRoutine(String(first._id), tenantId, projectId)).not.toHaveProperty('schedule');
    expect(updated?.nextFireAt ?? null).toBeNull();
    expect(await db.updateAgentRoutine(String(first._id), tenantId, 'proj-2', { name: 'x' })).toBeNull();

    expect(await db.deleteAgentRoutine(String(first._id), tenantId, 'proj-2')).toBe(false);
    expect(await db.deleteAgentRoutine(String(first._id), tenantId, projectId)).toBe(true);
    expect(await db.getAgentRoutine(String(first._id), tenantId, projectId)).toBeNull();
  });

  it('lists due routines (enabled, nextFireAt reached) soonest first', async () => {
    const db = getDb();
    const now = new Date('2026-10-18T10:00:00.000Z');
    await db.createAgentRoutine(record({ name: 'late', nextFireAt: new Date('2026-10-18T09:59:00.000Z') }));
    await db.createAgentRoutine(record({ name: 'early', nextFireAt: new Date('2026-10-18T09:00:00.000Z') }));
    await db.createAgentRoutine(record({ name: 'future', nextFireAt: new Date('2026-10-18T10:01:00.000Z') }));
    await db.createAgentRoutine(record({ name: 'disabled', enabled: false, nextFireAt: new Date('2026-10-18T09:00:00.000Z') }));
    await db.createAgentRoutine(record({ name: 'manual', type: 'manual', nextFireAt: null }));
    expect((await db.listDueRoutines(now, 10)).map((r) => r.name)).toEqual(['early', 'late']);
    expect(await db.listDueRoutines(now, 1)).toHaveLength(1);
  });

  it('moves nextFireAt on only from the value the caller saw (CAS)', async () => {
    const db = getDb();
    const due = new Date('2026-10-18T09:00:00.000Z');
    const next = new Date('2026-10-19T09:00:00.000Z');
    const routine = await db.createAgentRoutine(record({ nextFireAt: due }));
    const id = String(routine._id);
    const [a, b] = await Promise.all([db.advanceRoutineNextFire(id, due, next), db.advanceRoutineNextFire(id, due, next)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await db.advanceRoutineNextFire(id, due, null)).toBe(false);
    expect(new Date((await db.getAgentRoutine(id, tenantId, projectId))!.nextFireAt!).toISOString()).toBe(next.toISOString());
    expect(await db.advanceRoutineNextFire(id, next, null)).toBe(true);
    expect((await db.getAgentRoutine(id, tenantId, projectId))!.nextFireAt ?? null).toBeNull();
  });

  it('records the newest fire; a failed one keeps the last run that started', async () => {
    const db = getDb();
    const routine = await db.createAgentRoutine(record());
    const id = String(routine._id);
    const t1 = new Date('2026-10-18T09:00:00.000Z');
    const t2 = new Date('2026-10-18T10:00:00.000Z');
    expect(await db.setRoutineFireResult(id, { fireAt: t1, status: 'started', runId: 'run-1' })).toBe(true);
    expect(await db.setRoutineFireResult(id, { fireAt: t2, status: 'failed', error: 'agent run limit reached' })).toBe(true);
    let got = await db.getAgentRoutine(id, tenantId, projectId);
    expect(got).toMatchObject({ lastStatus: 'failed', lastRunId: 'run-1', lastError: 'agent run limit reached' });
    expect(new Date(got!.lastFireAt!).toISOString()).toBe(t2.toISOString());

    // An older fire landing late does not overwrite a newer one.
    expect(await db.setRoutineFireResult(id, { fireAt: t1, status: 'started', runId: 'run-0' })).toBe(false);
    const t3 = new Date('2026-10-18T11:00:00.000Z');
    expect(await db.setRoutineFireResult(id, { fireAt: t3, status: 'started', runId: 'run-3' })).toBe(true);
    got = await db.getAgentRoutine(id, tenantId, projectId);
    expect(got).toMatchObject({ lastStatus: 'started', lastRunId: 'run-3', lastError: null });
  });

  it('deletes every routine of an agent (the agent-delete cascade), only in that project', async () => {
    const db = getDb();
    await db.createAgentRoutine(record());
    await db.createAgentRoutine(record({ name: 'b' }));
    await db.createAgentRoutine(record({ name: 'kept', agentKey: 'other' }));
    await db.createAgentRoutine(record({ name: 'kept too', projectId: 'proj-2' }));
    expect(await db.deleteAgentRoutinesForAgent(tenantId, projectId, 'report-bot')).toBe(2);
    expect((await db.listAgentRoutines({ tenantId, projectId })).map((r) => r.name)).toEqual(['kept']);
    expect(await db.listAgentRoutines({ tenantId, projectId: 'proj-2' })).toHaveLength(1);
  });

  it('keeps a run’s unattended / externalContent flags, also through a resume requeue', async () => {
    const db = getDb();
    const base = {
      mode: 'background' as const, tenantId, tenantDbName: dbName, projectId, agentKey: 'report-bot', userMessage: 'hi',
    };
    const flagged = await db.createAgentRun({ ...base, conversationId: 'conv-a', status: 'requires_action', unattended: true, externalContent: true });
    const plain = await db.createAgentRun({ ...base, conversationId: 'conv-b', status: 'queued' });
    expect(await db.getAgentRunById(String(flagged._id), tenantId, projectId)).toMatchObject({ unattended: true, externalContent: true });
    const plainRead = await db.getAgentRunById(String(plain._id), tenantId, projectId);
    expect(plainRead?.unattended ?? false).toBe(false);
    expect(plainRead?.externalContent ?? false).toBe(false);

    const requeued = await db.requeueAgentRunForResume(String(flagged._id), tenantId, ['action-1']);
    expect(requeued).toMatchObject({ status: 'queued', unattended: true, externalContent: true });
  });

  const webhookSettings = (overrides: Partial<AgentRoutineWebhook> = {}): AgentRoutineWebhook => ({
    hookId: 'wh_abcdefghijklmnopqrstuvwx',
    preset: 'github',
    auth: 'github_signature',
    headerName: null,
    secretSealed: 'sealed-current',
    secretHint: 'wxyz',
    secretSource: 'generated',
    previousSecretSealed: 'sealed-previous',
    previousSecretExpiresAt: new Date('2026-10-19T00:00:00.000Z'),
    events: ['pull_request'],
    filter: [{ path: 'payload.action', op: 'in', value: ['opened', 'synchronize'] }],
    includePayload: true,
    ...overrides,
  });

  it('finds a webhook routine by its hook id; its webhook dates round-trip; switching away drops the id', async () => {
    const db = getDb();
    const routine = await db.createAgentRoutine(record({ type: 'webhook', webhook: webhookSettings(), nextFireAt: null }));
    await db.createAgentRoutine(record({ name: 'other', type: 'webhook', webhook: webhookSettings({ hookId: 'wh_zzzzzzzzzzzzzzzzzzzzzzzz' }) }));
    const found = await db.findAgentRoutineByHookId('wh_abcdefghijklmnopqrstuvwx');
    expect(String(found?._id)).toBe(String(routine._id));
    expect(found?.type).toBe('webhook');
    expect(found?.type === 'webhook' && found.webhook).toEqual(webhookSettings());
    expect(found?.type === 'webhook' && found.webhook.previousSecretExpiresAt instanceof Date).toBe(true);
    expect(found).not.toHaveProperty('schedule');
    expect(await db.findAgentRoutineByHookId('wh_unknownunknownunknown')).toBeNull();

    await db.updateAgentRoutine(String(routine._id), tenantId, projectId, {
      type: 'webhook', webhook: webhookSettings({ previousSecretSealed: null, previousSecretExpiresAt: null }),
    });
    const rotated = await db.findAgentRoutineByHookId('wh_abcdefghijklmnopqrstuvwx');
    expect(rotated?.type === 'webhook' && rotated.webhook).toMatchObject({ previousSecretSealed: null, previousSecretExpiresAt: null });

    const away = await db.updateAgentRoutine(String(routine._id), tenantId, projectId, { type: 'manual' });
    expect(away).toMatchObject({ type: 'manual' });
    expect(away).not.toHaveProperty('webhook');
    expect(await db.findAgentRoutineByHookId('wh_abcdefghijklmnopqrstuvwx')).toBeNull();

    // And back again: a new type replaces the settings as a whole, here with a schedule in between.
    const timed = await db.updateAgentRoutine(String(routine._id), tenantId, projectId, { type: 'schedule', schedule: { cron: '*/5 * * * *', timezone: 'UTC' } });
    expect(timed).toMatchObject({ type: 'schedule', schedule: { cron: '*/5 * * * *', timezone: 'UTC' } });
    const rehooked = await db.updateAgentRoutine(String(routine._id), tenantId, projectId, { type: 'webhook', webhook: webhookSettings() });
    expect(rehooked).toMatchObject({ type: 'webhook', webhook: { hookId: 'wh_abcdefghijklmnopqrstuvwx' } });
    expect(rehooked).not.toHaveProperty('schedule');
    expect(String((await db.findAgentRoutineByHookId('wh_abcdefghijklmnopqrstuvwx'))?._id)).toBe(String(routine._id));
  });

  const delivery = (overrides: Partial<Omit<IAgentRoutineDelivery, '_id'>> = {}): Omit<IAgentRoutineDelivery, '_id'> => ({
    tenantId,
    projectId,
    routineId: 'routine-1',
    receivedAt: new Date('2026-10-18T10:00:00.000Z'),
    expiresAt: new Date('2026-10-25T10:00:00.000Z'),
    outcome: 'accepted',
    httpStatus: 202,
    event: 'pull_request',
    deliveryId: 'd-1',
    runId: 'run-1',
    reason: null,
    bytes: 1234,
    ...overrides,
  });

  it('keeps a delivery log per routine, newest first, paged with a cursor', async () => {
    const db = getDb();
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 10, minute));
    const first = await db.recordAgentRoutineDelivery(delivery({ receivedAt: at(1) }));
    // Two in the same instant: the later write comes first.
    await db.recordAgentRoutineDelivery(delivery({ receivedAt: at(2), deliveryId: 'd-2', outcome: 'filtered', httpStatus: 200, runId: null, reason: 'rule 1 (payload.action in) did not match (value: string, 6 chars)' }));
    await db.recordAgentRoutineDelivery(delivery({ receivedAt: at(2), deliveryId: 'd-3', outcome: 'duplicate', httpStatus: 200 }));
    await db.recordAgentRoutineDelivery(delivery({ routineId: 'routine-2', receivedAt: at(3) }));
    await db.recordAgentRoutineDelivery(delivery({ projectId: 'proj-2', receivedAt: at(4) }));

    const page = await db.listAgentRoutineDeliveries({ tenantId, projectId, routineId: 'routine-1', limit: 2 });
    expect(page.map((row) => row.deliveryId)).toEqual(['d-3', 'd-2']);
    expect(page[1]).toMatchObject({ outcome: 'filtered', httpStatus: 200, runId: null, bytes: 1234 });
    expect(page[1].receivedAt).toBeInstanceOf(Date);
    const rest = await db.listAgentRoutineDeliveries({ tenantId, projectId, routineId: 'routine-1', limit: 10, before: String(page[1]._id) });
    expect(rest.map((row) => String(row._id))).toEqual([String(first._id)]);
    expect(await db.listAgentRoutineDeliveries({ tenantId, projectId, routineId: 'routine-1', limit: 10, before: 'not-a-delivery' })).toEqual([]);
  });

  it('removes expired deliveries in batches and a routine’s whole log', async () => {
    const db = getDb();
    for (let i = 0; i < 3; i += 1) await db.recordAgentRoutineDelivery(delivery({ expiresAt: new Date('2026-10-01T00:00:00.000Z') }));
    await db.recordAgentRoutineDelivery(delivery({ expiresAt: new Date('2026-12-01T00:00:00.000Z') }));
    await db.recordAgentRoutineDelivery(delivery({ routineId: 'routine-2' }));
    const olderThan = new Date('2026-10-18T00:00:00.000Z');
    expect(await db.cleanupAgentRoutineDeliveryRetention({ olderThan, batchSize: 2 })).toEqual({ deletedCount: 2 });
    expect(await db.cleanupAgentRoutineDeliveryRetention({ olderThan, batchSize: 2 })).toEqual({ deletedCount: 1 });
    expect(await db.cleanupAgentRoutineDeliveryRetention({ olderThan, batchSize: 2 })).toEqual({ deletedCount: 0 });
    expect(await db.listAgentRoutineDeliveries({ tenantId, projectId, routineId: 'routine-1', limit: 10 })).toHaveLength(1);
    expect(await db.deleteAgentRoutineDeliveries('routine-1')).toBe(1);
    expect(await db.listAgentRoutineDeliveries({ tenantId, projectId, routineId: 'routine-2', limit: 10 })).toHaveLength(1);
  });

  it('filters the runs list by trigger', async () => {
    const db = getDb();
    const base = { mode: 'background' as const, tenantId, tenantDbName: dbName, projectId, agentKey: 'report-bot', userMessage: 'hi', status: 'queued' as const };
    await db.createAgentRun({ ...base, conversationId: 'conv-a', trigger: 'webhook', routineId: 'routine-1' });
    await db.createAgentRun({ ...base, conversationId: 'conv-b', trigger: 'schedule', routineId: 'routine-1' });
    const runs = await db.listAgentRuns({ tenantId, projectId, trigger: 'webhook' });
    expect(runs.map((run) => run.conversationId)).toEqual(['conv-a']);
  });
});
