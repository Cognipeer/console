/**
 * Agent routines parity — the routine store behaves identically on SQLite and
 * MongoDB: CRUD scoped by tenant + project, the trigger round-trips (a once
 * time comes back a Date), the scheduler's due list, the CAS that moves
 * `nextFireAt` on, the newest-fire-wins record of the last fire, and the
 * agent-delete cascade. Plus the two run flags routines set
 * (`unattended`, `externalContent`), which a resume requeue keeps.
 */

import { beforeEach, expect, it } from 'vitest';
import type { IAgentRoutine } from '@/lib/database/provider.interface';
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

  const record = (overrides: Partial<Omit<IAgentRoutine, '_id' | 'createdAt' | 'updatedAt'>> = {}): Omit<IAgentRoutine, '_id' | 'createdAt' | 'updatedAt'> => ({
    tenantId,
    projectId,
    agentKey: 'report-bot',
    name: 'Nightly',
    enabled: true,
    trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'Europe/Istanbul' },
    prompt: 'Summarise.',
    runClass: 'default',
    createdBy: 'user-1',
    ...overrides,
  });

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
    const second = await db.createAgentRoutine(record({ name: 'Once', trigger: { type: 'once', runAt }, runClass: 'deferred' }));
    await db.createAgentRoutine(record({ name: 'Other agent', agentKey: 'other' }));
    await db.createAgentRoutine(record({ name: 'Other project', projectId: 'proj-2' }));

    const got = await db.getAgentRoutine(String(first._id), tenantId, projectId);
    expect(got).toMatchObject({
      name: 'Nightly',
      enabled: true,
      trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'Europe/Istanbul' },
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
    expect(once?.trigger).toEqual({ type: 'once', runAt });
    expect(once?.trigger.type === 'once' && once.trigger.runAt instanceof Date).toBe(true);
    expect(once?.runClass).toBe('deferred');

    expect(await db.getAgentRoutine(String(first._id), tenantId, 'proj-2')).toBeNull();
    expect(await db.getAgentRoutine('not-an-id', tenantId, projectId)).toBeNull();
    expect((await db.listAgentRoutines({ tenantId, projectId, agentKey: 'report-bot' })).map((r) => r.name)).toEqual(['Nightly', 'Once']);
    expect(await db.listAgentRoutines({ tenantId, projectId })).toHaveLength(3);

    const updated = await db.updateAgentRoutine(String(first._id), tenantId, projectId, {
      name: 'Renamed', enabled: false, trigger: { type: 'manual' }, nextFireAt: null, metadata: null, updatedBy: 'user-2',
    });
    expect(updated).toMatchObject({ name: 'Renamed', enabled: false, trigger: { type: 'manual' }, metadata: null, updatedBy: 'user-2' });
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
    await db.createAgentRoutine(record({ name: 'manual', trigger: { type: 'manual' }, nextFireAt: null }));
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
});
