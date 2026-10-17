/**
 * Routines end to end over a REAL SQLite provider and the real run engine
 * (only the queue and the webhook publisher are faked): `fireRoutine` — the
 * one way a routine starts a run — and the scheduler tick that fires due
 * slots exactly once across replicas.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  publish: vi.fn(),
  publishWebhook: vi.fn(),
  spendCheck: { refuse: false, calls: [] as Array<{ userId?: string }> },
  db: { current: null as unknown },
}));

vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhook }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});
vi.mock('@/lib/services/agents/agentSpendLimits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentSpendLimits')>();
  const { AgentSpendLimitError } = await import('@/lib/services/agents/agentErrors');
  return {
    ...actual,
    assertQueuedTurnSpendAllowed: async (...args: Parameters<typeof actual.assertQueuedTurnSpendAllowed>) => {
      hoisted.spendCheck.calls.push(args[0]);
      if (hoisted.spendCheck.refuse) throw new AgentSpendLimitError('Spend limit reached' as never);
      return actual.assertQueuedTurnSpendAllowed(...args);
    },
  };
});

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAgentRoutine } from '@/lib/database';
import { reloadConfig } from '@/lib/core/config';
import { deleteAgentRecord } from '@/lib/services/agents/agentService';
import {
  createAgentRoutine,
  fireRoutine,
  resetRoutineEventThrottle,
  serializeAgentRoutine,
  updateAgentRoutine,
} from '@/lib/services/agents/agentRoutines';
import { routineSlotKey, tickAgentRoutines } from '@/lib/services/agents/agentRoutineScheduler';
import { encryptObject } from '@/lib/utils/crypto';

const DB_NAME = 'tenant_routines';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'report-bot';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let agentId: string;

const scope = () => ({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID });
const tenant = () => ({ tenantDbName: DB_NAME, tenantId, licenseType: 'FREE' });
const events = () => hoisted.publishWebhook.mock.calls.map(([input]) => input as { type: string; data: Record<string, unknown> });
const conversations = () => db.listAgentConversations(AGENT_KEY, { projectId: PROJECT_ID });
const routineRuns = (routineId: string) => db.listAgentRuns({ tenantId, projectId: PROJECT_ID, routineId, excludeModes: ['sync'] });
const reload = async (routine: IAgentRoutine) => (await db.getAgentRoutine(String(routine._id), tenantId, PROJECT_ID))!;

function newRoutine(write: Partial<Parameters<typeof createAgentRoutine>[2]> = {}, now = new Date()) {
  return createAgentRoutine(scope(), AGENT_KEY, {
    name: 'Nightly',
    trigger: { type: 'manual' },
    prompt: 'Summarise.',
    ...write,
  }, 'user-1', now);
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetRoutineEventThrottle();
  hoisted.spendCheck.refuse = false;
  hoisted.spendCheck.calls = [];
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-routines-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const created = await db.createTenant({ companyName: 'Acme', slug: 'acme-routines', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(created._id);
  await db.switchToTenant(DB_NAME);
  agentId = String((await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Reports', config: { modelKey: 'gpt-4o' }, status: 'active', createdBy: 'user-1',
  }))._id);
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.publishWebhook.mockResolvedValue(undefined);
});

afterEach(async () => {
  delete process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT;
  delete process.env.AGENT_ROUTINE_MISFIRE_GRACE_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('fireRoutine (§2.4a)', () => {
  it('starts a queued, unattended run owned by the routine actor on a new routine session, and records it', async () => {
    const routine = await newRoutine({
      metadata: { team: 'ops' }, runClass: 'default', responseFormat: { type: 'json_object' },
      callback: { url: 'https://example.com/hook', secretSealed: encryptObject('a-signing-secret-1234') },
    });
    const fireAt = new Date('2026-10-18T06:00:00.000Z');

    const result = await fireRoutine(routine, tenant(), {
      trigger: 'schedule', message: 'Summarise.', metadata: { slot: 'morning' }, idempotencyKey: 'routine:x:1', fireAt,
    });

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    const routineId = String(routine._id);
    expect(result.run).toMatchObject({
      status: 'queued', channel: 'routine', routineId, trigger: 'schedule', userId: `system:routine:${routineId}`, actorType: 'system',
      unattended: true, usePublished: true, idempotencyKey: 'routine:x:1', metadata: { team: 'ops', slot: 'morning' },
      responseFormat: { type: 'json_object' }, callbackUrl: 'https://example.com/hook',
    });
    expect(result.run.externalContent).toBeFalsy();
    expect(result.run.apiTokenId).toBeFalsy();
    const conversation = await db.findAgentConversationById(result.run.conversationId);
    expect(conversation).toMatchObject({ createdBy: `system:routine:${routineId}`, metadata: { source: 'routine', routineId, trigger: 'schedule' } });
    expect(conversation?.title).toBe('Nightly · 2026-10-18 06:00');
    expect(hoisted.publish).toHaveBeenCalledTimes(1);

    const stored = await reload(routine);
    expect(stored).toMatchObject({ lastStatus: 'started', lastRunId: String(result.run._id), lastError: null });
    expect(new Date(stored.lastFireAt!).toISOString()).toBe(fireAt.toISOString());
    expect(events()).toEqual([expect.objectContaining({
      type: 'routine.fired',
      data: expect.objectContaining({ routineId, agentKey: AGENT_KEY, trigger: 'schedule', runId: `run_${String(result.run._id)}` }),
    })]);
    expect(serializeAgentRoutine(stored).last_run_id).toBe(`run_${String(result.run._id)}`);
  });

  it('a pinned version runs that version; external content is carried on the run', async () => {
    const routine = await newRoutine({ version: 2 });
    const result = await fireRoutine(routine, tenant(), { trigger: 'manual', message: 'go', externalContent: true });
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.run).toMatchObject({ version: 2, usePublished: false, externalContent: true, trigger: 'manual' });
  });

  it('the same idempotency key is a duplicate: no second run, no second session, last* untouched, no event', async () => {
    const routine = await newRoutine();
    const first = await fireRoutine(routine, tenant(), { trigger: 'schedule', message: 'x', idempotencyKey: 'routine:r:slot', fireAt: new Date('2026-10-18T06:00:00Z') });
    expect(first.kind).toBe('accepted');
    hoisted.publishWebhook.mockClear();
    const before = await reload(routine);

    const again = await fireRoutine(routine, tenant(), { trigger: 'schedule', message: 'x', idempotencyKey: 'routine:r:slot', fireAt: new Date('2026-10-18T07:00:00Z') });
    expect(again.kind).toBe('duplicate');
    expect(await routineRuns(String(routine._id))).toHaveLength(1);
    expect(await conversations()).toHaveLength(1);
    expect((await reload(routine)).lastFireAt).toEqual(before.lastFireAt);
    expect(events()).toEqual([]);
  });

  it('a key another routine used is refused (idempotency key in use), recorded as failed', async () => {
    const other = await newRoutine({ name: 'Other' });
    await fireRoutine(other, tenant(), { trigger: 'manual', message: 'x', idempotencyKey: 'routine:shared' });
    const routine = await newRoutine();
    const result = await fireRoutine(routine, tenant(), { trigger: 'manual', message: 'x', idempotencyKey: 'routine:shared' });
    expect(result).toEqual({ kind: 'failed', reason: 'idempotency key in use' });
    expect(await reload(routine)).toMatchObject({ lastStatus: 'failed', lastError: 'idempotency key in use' });
  });

  it('an inactive agent is a failed fire: no session left behind, routine.failed sent', async () => {
    await db.updateAgent(agentId, { status: 'inactive' } as never);
    const routine = await newRoutine();
    const result = await fireRoutine(routine, tenant(), { trigger: 'schedule', message: 'x' });
    expect(result).toEqual({ kind: 'failed', reason: 'agent is not active' });
    expect(await conversations()).toHaveLength(0);
    expect(await reload(routine)).toMatchObject({ lastStatus: 'failed', lastError: 'agent is not active' });
    expect(events()).toEqual([expect.objectContaining({ type: 'routine.failed', data: expect.objectContaining({ reason: 'agent is not active' }) })]);
  });

  it('a run limit refusal deletes the session it created and leaves last* alone; the failure event is sent once an hour', async () => {
    process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT = '1';
    reloadConfig();
    const blocker = await newRoutine({ name: 'Blocker' });
    expect((await fireRoutine(blocker, tenant(), { trigger: 'manual', message: 'x' })).kind).toBe('accepted');
    hoisted.publishWebhook.mockClear();
    const routine = await newRoutine();

    const refused = await fireRoutine(routine, tenant(), { trigger: 'schedule', message: 'x' });
    expect(refused).toMatchObject({ kind: 'concurrency_limit', reason: 'agent run limit reached' });
    expect(await conversations()).toHaveLength(1); // only the blocker's
    const stored = await reload(routine);
    expect(stored.lastFireAt ?? null).toBeNull();
    expect(stored.lastStatus ?? null).toBeNull();

    await fireRoutine(routine, tenant(), { trigger: 'schedule', message: 'x' });
    expect(events().filter((e) => e.type === 'routine.failed')).toHaveLength(1);
  });

  it('a spend limit refusal is spend_limit and creates nothing', async () => {
    hoisted.spendCheck.refuse = true;
    const routine = await newRoutine();
    const result = await fireRoutine(routine, tenant(), { trigger: 'schedule', message: 'x' });
    expect(result).toMatchObject({ kind: 'spend_limit', reason: 'spend limit reached' });
    expect(await conversations()).toHaveLength(0);
    expect((await reload(routine)).lastStatus ?? null).toBeNull();
  });

  it('a scheduled fire is accountable to the routine\'s last updater (else its creator); the session stays the routine\'s', async () => {
    const routine = await newRoutine();
    await updateAgentRoutine(scope(), routine, { prompt: 'Summarise again.' }, 'user-2');
    const result = await fireRoutine(await reload(routine), tenant(), { trigger: 'schedule', message: 'x' });
    expect(result.kind).toBe('accepted');
    const [run] = await routineRuns(String(routine._id));
    expect(run).toMatchObject({ userId: `system:routine:${String(routine._id)}`, accountableUserId: 'user-2' });
    expect(hoisted.spendCheck.calls.at(-1)).toMatchObject({ userId: 'user-2' });

    const fresh = await newRoutine({ name: 'Fresh' });
    await fireRoutine(fresh, tenant(), { trigger: 'schedule', message: 'x' });
    const [freshRun] = await routineRuns(String(fresh._id));
    expect(freshRun).toMatchObject({ accountableUserId: 'user-1' });
    expect(hoisted.spendCheck.calls.at(-1)).toMatchObject({ userId: 'user-1' });
  });

  it('Run now is accountable to its caller and the caller\'s token', async () => {
    const routine = await newRoutine();
    await fireRoutine(routine, tenant(), { trigger: 'manual', message: 'x', principal: { userId: 'user-3', apiTokenId: 'tok-3' } });
    const [run] = await routineRuns(String(routine._id));
    expect(run).toMatchObject({ accountableUserId: 'user-3', accountableTokenId: 'tok-3' });
    expect(hoisted.spendCheck.calls.at(-1)).toMatchObject({ userId: 'user-3' });
  });

  it('too many metadata keys together is a failed fire', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v']));
    const routine = await newRoutine({ metadata });
    const result = await fireRoutine(routine, tenant(), {
      trigger: 'manual', message: 'x', metadata: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`o${i}`, 'v'])),
    });
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringContaining('metadata') });
  });
});

describe('agent delete', () => {
  it('deletes the agent’s routines with it', async () => {
    await newRoutine();
    await newRoutine({ name: 'Second' });
    expect(await deleteAgentRecord(DB_NAME, agentId)).toBe(true);
    expect(await db.listAgentRoutines({ tenantId, projectId: PROJECT_ID })).toEqual([]);
  });
});

describe('the scheduler tick (§2.5)', () => {
  it('fires a due schedule slot once, advances nextFireAt, and keys the run by the slot', async () => {
    const created = new Date('2026-10-18T05:59:00.000Z');
    const routine = await newRoutine({ trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'Europe/Istanbul' } }, created);
    expect(new Date(routine.nextFireAt!).toISOString()).toBe('2026-10-18T06:00:00.000Z'); // 09:00 Istanbul (UTC+3)

    const result = await tickAgentRoutines(new Date('2026-10-18T06:00:10.000Z'));
    expect(result).toMatchObject({ fired: 1, claimedElsewhere: 0, skipped: 0 });
    const runs = await routineRuns(String(routine._id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', idempotencyKey: routineSlotKey(String(routine._id), new Date('2026-10-18T06:00:00.000Z')) });
    expect(new Date((await reload(routine)).nextFireAt!).toISOString()).toBe('2026-10-19T06:00:00.000Z');

    // Not due again until tomorrow.
    expect(await tickAgentRoutines(new Date('2026-10-18T06:01:00.000Z'))).toMatchObject({ fired: 0 });
  });

  it('two schedulers on the same slot start ONE run', async () => {
    const routine = await newRoutine({ trigger: { type: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' } }, new Date('2026-10-18T05:59:00.000Z'));
    const now = new Date('2026-10-18T06:00:05.000Z');
    const [a, b] = await Promise.all([tickAgentRoutines(now), tickAgentRoutines(now)]);
    expect(a.fired + b.fired).toBe(1);
    expect(await routineRuns(String(routine._id))).toHaveLength(1);
    expect(new Date((await reload(routine)).nextFireAt!).toISOString()).toBe('2026-10-18T06:05:00.000Z');
  });

  it('a once routine fires once and is finished', async () => {
    const runAt = new Date('2026-10-18T07:30:00.000Z');
    const routine = await newRoutine({ trigger: { type: 'once', runAt } }, new Date('2026-10-18T07:00:00.000Z'));
    expect(await tickAgentRoutines(new Date('2026-10-18T07:29:00.000Z'))).toMatchObject({ fired: 0 });
    expect(await tickAgentRoutines(new Date('2026-10-18T07:30:01.000Z'))).toMatchObject({ fired: 1 });
    expect(await tickAgentRoutines(new Date('2026-10-18T07:31:00.000Z'))).toMatchObject({ fired: 0 });
    const runs = await routineRuns(String(routine._id));
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe('once');
    expect((await reload(routine)).nextFireAt ?? null).toBeNull();
    // Re-enabling a fired once routine does not bring it back.
    const updated = await updateAgentRoutine(scope(), await reload(routine), { enabled: true }, 'user-1', new Date('2026-10-18T08:00:00.000Z'));
    expect(updated?.nextFireAt ?? null).toBeNull();
  });

  it('after downtime, only the latest missed slot within the grace fires; older ones are skipped', async () => {
    const routine = await newRoutine({ trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' } }, new Date('2026-10-18T05:30:00.000Z'));
    // Down from 05:30 to 09:20: slots 06:00, 07:00, 08:00, 09:00 missed; 09:00 is within the 1 h grace.
    expect(await tickAgentRoutines(new Date('2026-10-18T09:20:00.000Z'))).toMatchObject({ fired: 1 });
    const runs = await routineRuns(String(routine._id));
    expect(runs).toHaveLength(1);
    expect(runs[0].idempotencyKey).toBe(routineSlotKey(String(routine._id), new Date('2026-10-18T09:00:00.000Z')));
    expect(new Date((await reload(routine)).nextFireAt!).toISOString()).toBe('2026-10-18T10:00:00.000Z');
  });

  it('a slot older than the grace is skipped without a run', async () => {
    process.env.AGENT_ROUTINE_MISFIRE_GRACE_MS = '600000'; // 10 min
    reloadConfig();
    const routine = await newRoutine({ trigger: { type: 'once', runAt: new Date('2026-10-18T06:00:00.000Z') } }, new Date('2026-10-18T05:00:00.000Z'));
    expect(await tickAgentRoutines(new Date('2026-10-18T07:00:00.000Z'))).toMatchObject({ fired: 0, skipped: 1 });
    expect(await routineRuns(String(routine._id))).toHaveLength(0);
    expect((await reload(routine)).nextFireAt ?? null).toBeNull();
  });

  it('a refused slot is skipped, not retried: the next tick waits for the next slot', async () => {
    hoisted.spendCheck.refuse = true;
    const routine = await newRoutine({ trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' } }, new Date('2026-10-18T05:30:00.000Z'));
    expect(await tickAgentRoutines(new Date('2026-10-18T06:00:01.000Z'))).toMatchObject({ fired: 0, skipped: 1 });
    hoisted.spendCheck.refuse = false;
    expect(await tickAgentRoutines(new Date('2026-10-18T06:00:30.000Z'))).toMatchObject({ fired: 0 });
    expect(await routineRuns(String(routine._id))).toHaveLength(0);
    expect(new Date((await reload(routine)).nextFireAt!).toISOString()).toBe('2026-10-18T07:00:00.000Z');
  });

  it('disabled and manual routines never fire on their own', async () => {
    await newRoutine({ trigger: { type: 'schedule', cron: '* * * * *', timezone: 'UTC' }, enabled: false }, new Date('2026-10-18T05:30:00.000Z'));
    await newRoutine({ trigger: { type: 'manual' } });
    expect(await tickAgentRoutines(new Date('2026-10-18T06:00:00.000Z'))).toMatchObject({ fired: 0, skipped: 0 });
  });
});
