/**
 * Agent triggers parity — the trigger store behaves identically on SQLite and
 * MongoDB: CRUD scoped by tenant + project, the type and its settings object
 * round-trip (a once time comes back a Date; a trigger holds only the object
 * of its own type, also after the type changed), the scheduler's due list, the
 * CAS that moves `nextFireAt` on, the newest-fire-wins record of the last fire,
 * and the agent-delete cascade. Plus the two run flags triggers set
 * (`unattended`, `externalContent`), which a resume requeue keeps; the
 * webhook type (found by hook id, its dates round-trip) and its delivery
 * log (newest first with a cursor, batched retention, removal per trigger);
 * the runs list's trigger filter.
 */

import { beforeEach, expect, it } from 'vitest';
import type {
  AgentTriggerOnce,
  AgentTriggerSchedule,
  AgentTriggerType,
  AgentTriggerWebhook,
  IAgentTriggerBase,
  IAgentTriggerDelivery,
  NewAgentTrigger,
} from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Agent triggers', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';

  beforeEach(async () => {
    const slug = `triggers-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  /**
   * A new trigger: a nightly schedule unless the overrides bring their own `type`
   * with the settings object of that type (a trigger has only that one).
   */
  const record = (
    overrides: Partial<Omit<IAgentTriggerBase, '_id' | 'createdAt' | 'updatedAt'>>
      & Partial<{ type: AgentTriggerType; schedule: AgentTriggerSchedule; once: AgentTriggerOnce; webhook: AgentTriggerWebhook }> = {},
  ): NewAgentTrigger => ({
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
  } as NewAgentTrigger);

  it('creates, reads, lists (oldest first), updates and deletes within the project', async () => {
    const db = getDb();
    const runAt = new Date('2026-11-01T06:00:00.000Z');
    const first = await db.createAgentTrigger(record({
      metadata: { team: 'ops' },
      variables: { region: 'eu' },
      callback: { url: 'https://example.com/hook', secretSealed: 'sealed' },
      responseFormat: { type: 'json_object' },
      version: 3,
      nextFireAt: new Date('2026-10-18T23:00:00.000Z'),
    }));
    const second = await db.createAgentTrigger(record({ name: 'Once', type: 'once', once: { runAt }, runClass: 'deferred' }));
    await db.createAgentTrigger(record({ name: 'Other agent', agentKey: 'other' }));
    await db.createAgentTrigger(record({ name: 'Other project', projectId: 'proj-2' }));

    const got = await db.getAgentTrigger(String(first._id), tenantId, projectId);
    expect(got).toMatchObject({
      name: 'Nightly',
      enabled: true,
      type: 'schedule',
      schedule: { cron: '0 2 * * *', timezone: 'Europe/Istanbul' },
      metadata: { team: 'ops' },
      variables: { region: 'eu' },
      callback: { url: 'https://example.com/hook', secretSealed: 'sealed' },
      responseFormat: { type: 'json_object' },
      version: 3,
      runClass: 'default',
      createdBy: 'user-1',
    });
    expect(new Date(got!.nextFireAt!).toISOString()).toBe('2026-10-18T23:00:00.000Z');
    const once = await db.getAgentTrigger(String(second._id), tenantId, projectId);
    expect(once).toMatchObject({ type: 'once', once: { runAt } });
    expect(once?.type === 'once' && once.once.runAt instanceof Date).toBe(true);
    expect(once?.runClass).toBe('deferred');
    // A trigger holds only the settings object of its own type.
    expect(once).not.toHaveProperty('schedule');
    expect(once).not.toHaveProperty('webhook');
    expect(got).not.toHaveProperty('once');

    expect(await db.getAgentTrigger(String(first._id), tenantId, 'proj-2')).toBeNull();
    expect(await db.getAgentTrigger('not-an-id', tenantId, projectId)).toBeNull();
    expect((await db.listAgentTriggers({ tenantId, projectId, agentKey: 'report-bot' })).map((r) => r.name)).toEqual(['Nightly', 'Once']);
    expect(await db.listAgentTriggers({ tenantId, projectId })).toHaveLength(3);

    const updated = await db.updateAgentTrigger(String(first._id), tenantId, projectId, {
      name: 'Renamed', enabled: false, type: 'manual', nextFireAt: null, metadata: null, updatedBy: 'user-2',
    });
    expect(updated).toMatchObject({ name: 'Renamed', enabled: false, type: 'manual', metadata: null, updatedBy: 'user-2' });
    // Changing the type drops the settings object of the type it left.
    expect(updated).not.toHaveProperty('schedule');
    expect(await db.getAgentTrigger(String(first._id), tenantId, projectId)).not.toHaveProperty('schedule');
    expect(updated?.nextFireAt ?? null).toBeNull();
    expect(await db.updateAgentTrigger(String(first._id), tenantId, 'proj-2', { name: 'x' })).toBeNull();

    expect(await db.deleteAgentTrigger(String(first._id), tenantId, 'proj-2')).toBe(false);
    expect(await db.deleteAgentTrigger(String(first._id), tenantId, projectId)).toBe(true);
    expect(await db.getAgentTrigger(String(first._id), tenantId, projectId)).toBeNull();
  });

  it('lists due triggers (enabled, nextFireAt reached) soonest first', async () => {
    const db = getDb();
    const now = new Date('2026-10-18T10:00:00.000Z');
    await db.createAgentTrigger(record({ name: 'late', nextFireAt: new Date('2026-10-18T09:59:00.000Z') }));
    await db.createAgentTrigger(record({ name: 'early', nextFireAt: new Date('2026-10-18T09:00:00.000Z') }));
    await db.createAgentTrigger(record({ name: 'future', nextFireAt: new Date('2026-10-18T10:01:00.000Z') }));
    await db.createAgentTrigger(record({ name: 'disabled', enabled: false, nextFireAt: new Date('2026-10-18T09:00:00.000Z') }));
    await db.createAgentTrigger(record({ name: 'manual', type: 'manual', nextFireAt: null }));
    expect((await db.listDueTriggers(now, 10)).map((r) => r.name)).toEqual(['early', 'late']);
    expect(await db.listDueTriggers(now, 1)).toHaveLength(1);
  });

  it('moves nextFireAt on only from the value the caller saw (CAS)', async () => {
    const db = getDb();
    const due = new Date('2026-10-18T09:00:00.000Z');
    const next = new Date('2026-10-19T09:00:00.000Z');
    const trigger = await db.createAgentTrigger(record({ nextFireAt: due }));
    const id = String(trigger._id);
    const [a, b] = await Promise.all([db.advanceTriggerNextFire(id, due, next), db.advanceTriggerNextFire(id, due, next)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await db.advanceTriggerNextFire(id, due, null)).toBe(false);
    expect(new Date((await db.getAgentTrigger(id, tenantId, projectId))!.nextFireAt!).toISOString()).toBe(next.toISOString());
    expect(await db.advanceTriggerNextFire(id, next, null)).toBe(true);
    expect((await db.getAgentTrigger(id, tenantId, projectId))!.nextFireAt ?? null).toBeNull();
  });

  it('records the newest fire; a failed one keeps the last run that started', async () => {
    const db = getDb();
    const trigger = await db.createAgentTrigger(record());
    const id = String(trigger._id);
    const t1 = new Date('2026-10-18T09:00:00.000Z');
    const t2 = new Date('2026-10-18T10:00:00.000Z');
    expect(await db.setTriggerFireResult(id, { fireAt: t1, status: 'started', runId: 'run-1' })).toBe(true);
    expect(await db.setTriggerFireResult(id, { fireAt: t2, status: 'failed', error: 'agent run limit reached' })).toBe(true);
    let got = await db.getAgentTrigger(id, tenantId, projectId);
    expect(got).toMatchObject({ lastStatus: 'failed', lastRunId: 'run-1', lastError: 'agent run limit reached' });
    expect(new Date(got!.lastFireAt!).toISOString()).toBe(t2.toISOString());

    // An older fire landing late does not overwrite a newer one.
    expect(await db.setTriggerFireResult(id, { fireAt: t1, status: 'started', runId: 'run-0' })).toBe(false);
    const t3 = new Date('2026-10-18T11:00:00.000Z');
    expect(await db.setTriggerFireResult(id, { fireAt: t3, status: 'started', runId: 'run-3' })).toBe(true);
    got = await db.getAgentTrigger(id, tenantId, projectId);
    expect(got).toMatchObject({ lastStatus: 'started', lastRunId: 'run-3', lastError: null });
  });

  it('deletes every trigger of an agent (the agent-delete cascade), only in that project', async () => {
    const db = getDb();
    await db.createAgentTrigger(record());
    await db.createAgentTrigger(record({ name: 'b' }));
    await db.createAgentTrigger(record({ name: 'kept', agentKey: 'other' }));
    await db.createAgentTrigger(record({ name: 'kept too', projectId: 'proj-2' }));
    expect(await db.deleteAgentTriggersForAgent(tenantId, projectId, 'report-bot')).toBe(2);
    expect((await db.listAgentTriggers({ tenantId, projectId })).map((r) => r.name)).toEqual(['kept']);
    expect(await db.listAgentTriggers({ tenantId, projectId: 'proj-2' })).toHaveLength(1);
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

  it('keeps the variable names a fire marked as literal, also through a resume requeue; a plain run has none', async () => {
    const db = getDb();
    const base = {
      mode: 'background' as const, tenantId, tenantDbName: dbName, projectId, agentKey: 'report-bot', userMessage: 'hi',
    };
    const withNames = await db.createAgentRun({
      ...base, conversationId: 'conv-a', status: 'requires_action', externalContent: true, literalVariables: ['region', 'customer_id'],
    });
    const empty = await db.createAgentRun({ ...base, conversationId: 'conv-b', status: 'requires_action', externalContent: true, literalVariables: [] });
    const plain = await db.createAgentRun({ ...base, conversationId: 'conv-c', status: 'queued' });
    expect((await db.getAgentRunById(String(withNames._id), tenantId, projectId))?.literalVariables).toEqual(['region', 'customer_id']);
    expect((await db.getAgentRunById(String(empty._id), tenantId, projectId))?.literalVariables ?? []).toEqual([]);
    expect((await db.getAgentRunById(String(plain._id), tenantId, projectId))?.literalVariables ?? null).toBeNull();

    const requeued = await db.requeueAgentRunForResume(String(withNames._id), tenantId, ['action-1']);
    expect(requeued?.literalVariables).toEqual(['region', 'customer_id']);
  });

  const webhookSettings = (overrides: Partial<AgentTriggerWebhook> = {}): AgentTriggerWebhook => ({
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

  it('finds a webhook trigger by its hook id; its webhook dates round-trip; switching away drops the id', async () => {
    const db = getDb();
    const trigger = await db.createAgentTrigger(record({ type: 'webhook', webhook: webhookSettings(), nextFireAt: null }));
    await db.createAgentTrigger(record({ name: 'other', type: 'webhook', webhook: webhookSettings({ hookId: 'wh_zzzzzzzzzzzzzzzzzzzzzzzz' }) }));
    const found = await db.findAgentTriggerByHookId('wh_abcdefghijklmnopqrstuvwx');
    expect(String(found?._id)).toBe(String(trigger._id));
    expect(found?.type).toBe('webhook');
    expect(found?.type === 'webhook' && found.webhook).toEqual(webhookSettings());
    expect(found?.type === 'webhook' && found.webhook.previousSecretExpiresAt instanceof Date).toBe(true);
    expect(found).not.toHaveProperty('schedule');
    expect(await db.findAgentTriggerByHookId('wh_unknownunknownunknown')).toBeNull();

    await db.updateAgentTrigger(String(trigger._id), tenantId, projectId, {
      type: 'webhook', webhook: webhookSettings({ previousSecretSealed: null, previousSecretExpiresAt: null }),
    });
    const rotated = await db.findAgentTriggerByHookId('wh_abcdefghijklmnopqrstuvwx');
    expect(rotated?.type === 'webhook' && rotated.webhook).toMatchObject({ previousSecretSealed: null, previousSecretExpiresAt: null });

    const away = await db.updateAgentTrigger(String(trigger._id), tenantId, projectId, { type: 'manual' });
    expect(away).toMatchObject({ type: 'manual' });
    expect(away).not.toHaveProperty('webhook');
    expect(await db.findAgentTriggerByHookId('wh_abcdefghijklmnopqrstuvwx')).toBeNull();

    // And back again: a new type replaces the settings as a whole, here with a schedule in between.
    const timed = await db.updateAgentTrigger(String(trigger._id), tenantId, projectId, { type: 'schedule', schedule: { cron: '*/5 * * * *', timezone: 'UTC' } });
    expect(timed).toMatchObject({ type: 'schedule', schedule: { cron: '*/5 * * * *', timezone: 'UTC' } });
    const rehooked = await db.updateAgentTrigger(String(trigger._id), tenantId, projectId, { type: 'webhook', webhook: webhookSettings() });
    expect(rehooked).toMatchObject({ type: 'webhook', webhook: { hookId: 'wh_abcdefghijklmnopqrstuvwx' } });
    expect(rehooked).not.toHaveProperty('schedule');
    expect(String((await db.findAgentTriggerByHookId('wh_abcdefghijklmnopqrstuvwx'))?._id)).toBe(String(trigger._id));
  });

  const delivery = (overrides: Partial<Omit<IAgentTriggerDelivery, '_id'>> = {}): Omit<IAgentTriggerDelivery, '_id'> => ({
    tenantId,
    projectId,
    triggerId: 'trigger-1',
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

  it('keeps a delivery log per trigger, newest first, paged with a cursor', async () => {
    const db = getDb();
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 10, minute));
    const first = await db.recordAgentTriggerDelivery(delivery({ receivedAt: at(1) }));
    // Two in the same instant: the later write comes first.
    await db.recordAgentTriggerDelivery(delivery({ receivedAt: at(2), deliveryId: 'd-2', outcome: 'filtered', httpStatus: 200, runId: null, reason: 'rule 1 (payload.action in) did not match (value: string, 6 chars)' }));
    await db.recordAgentTriggerDelivery(delivery({ receivedAt: at(2), deliveryId: 'd-3', outcome: 'duplicate', httpStatus: 200 }));
    await db.recordAgentTriggerDelivery(delivery({ triggerId: 'trigger-2', receivedAt: at(3) }));
    await db.recordAgentTriggerDelivery(delivery({ projectId: 'proj-2', receivedAt: at(4) }));

    const page = await db.listAgentTriggerDeliveries({ tenantId, projectId, triggerId: 'trigger-1', limit: 2 });
    expect(page.map((row) => row.deliveryId)).toEqual(['d-3', 'd-2']);
    expect(page[1]).toMatchObject({ outcome: 'filtered', httpStatus: 200, runId: null, bytes: 1234 });
    expect(page[1].receivedAt).toBeInstanceOf(Date);
    const rest = await db.listAgentTriggerDeliveries({ tenantId, projectId, triggerId: 'trigger-1', limit: 10, before: String(page[1]._id) });
    expect(rest.map((row) => String(row._id))).toEqual([String(first._id)]);
    expect(await db.listAgentTriggerDeliveries({ tenantId, projectId, triggerId: 'trigger-1', limit: 10, before: 'not-a-delivery' })).toEqual([]);
  });

  it('removes expired deliveries in batches and a trigger’s whole log', async () => {
    const db = getDb();
    for (let i = 0; i < 3; i += 1) await db.recordAgentTriggerDelivery(delivery({ expiresAt: new Date('2026-10-01T00:00:00.000Z') }));
    await db.recordAgentTriggerDelivery(delivery({ expiresAt: new Date('2026-12-01T00:00:00.000Z') }));
    await db.recordAgentTriggerDelivery(delivery({ triggerId: 'trigger-2' }));
    const olderThan = new Date('2026-10-18T00:00:00.000Z');
    expect(await db.cleanupAgentTriggerDeliveryRetention({ olderThan, batchSize: 2 })).toEqual({ deletedCount: 2 });
    expect(await db.cleanupAgentTriggerDeliveryRetention({ olderThan, batchSize: 2 })).toEqual({ deletedCount: 1 });
    expect(await db.cleanupAgentTriggerDeliveryRetention({ olderThan, batchSize: 2 })).toEqual({ deletedCount: 0 });
    expect(await db.listAgentTriggerDeliveries({ tenantId, projectId, triggerId: 'trigger-1', limit: 10 })).toHaveLength(1);
    expect(await db.deleteAgentTriggerDeliveries('trigger-1')).toBe(1);
    expect(await db.listAgentTriggerDeliveries({ tenantId, projectId, triggerId: 'trigger-2', limit: 10 })).toHaveLength(1);
  });

  it('filters the runs list by trigger', async () => {
    const db = getDb();
    const base = { mode: 'background' as const, tenantId, tenantDbName: dbName, projectId, agentKey: 'report-bot', userMessage: 'hi', status: 'queued' as const };
    await db.createAgentRun({ ...base, conversationId: 'conv-a', trigger: 'webhook', triggerId: 'trigger-1' });
    await db.createAgentRun({ ...base, conversationId: 'conv-b', trigger: 'schedule', triggerId: 'trigger-1' });
    const runs = await db.listAgentRuns({ tenantId, projectId, trigger: 'webhook' });
    expect(runs.map((run) => run.conversationId)).toEqual(['conv-a']);
  });
});
