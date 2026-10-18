/**
 * Triggers end to end over a REAL SQLite provider and the real run engine
 * (only the queue and the webhook publisher are faked): `fireTrigger` — the
 * one way a trigger starts a run — and the scheduler tick that fires due
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
import type { AgentTriggerOnce, AgentTriggerSchedule, AgentTriggerType, IAgentTrigger } from '@/lib/database';
import { reloadConfig } from '@/lib/core/config';
import { deleteAgentRecord } from '@/lib/services/agents/agentService';
import {
  createAgentTrigger,
  fireTrigger,
  resetTriggerEventThrottle,
  serializeAgentTrigger,
  updateAgentTrigger,
  type NewTriggerWrite,
  type TriggerFields,
} from '@/lib/services/agents/agentTriggers';
import { triggerSlotKey, tickAgentTriggers } from '@/lib/services/agents/agentTriggerScheduler';
import { encryptObject } from '@/lib/utils/crypto';

const DB_NAME = 'tenant_triggers';
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
const triggerRuns = (triggerId: string) => db.listAgentRuns({ tenantId, projectId: PROJECT_ID, triggerId, excludeModes: ['sync'] });
const reload = async (trigger: IAgentTrigger) => (await db.getAgentTrigger(String(trigger._id), tenantId, PROJECT_ID))!;

/** A trigger: manual unless `type` (with the settings object of that type) says otherwise. */
function newTrigger(
  write: TriggerFields & Partial<{ type: AgentTriggerType; schedule: AgentTriggerSchedule; once: AgentTriggerOnce }> = {},
  now = new Date(),
) {
  return createAgentTrigger(scope(), AGENT_KEY, {
    name: 'Nightly',
    type: 'manual',
    prompt: 'Summarise.',
    ...write,
  } as NewTriggerWrite, 'user-1', now);
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetTriggerEventThrottle();
  hoisted.spendCheck.refuse = false;
  hoisted.spendCheck.calls = [];
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-triggers-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const created = await db.createTenant({ companyName: 'Acme', slug: 'acme-triggers', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
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
  delete process.env.AGENT_TRIGGER_MISFIRE_GRACE_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('fireTrigger (§2.4a)', () => {
  it('starts a queued, unattended run owned by the trigger actor on a new trigger session, and records it', async () => {
    const trigger = await newTrigger({
      metadata: { team: 'ops' }, runClass: 'default', responseFormat: { type: 'json_object' },
      callback: { url: 'https://example.com/hook', secretSealed: encryptObject('a-signing-secret-1234') },
    });
    const fireAt = new Date('2026-10-18T06:00:00.000Z');

    const result = await fireTrigger(trigger, tenant(), {
      trigger: 'schedule', message: 'Summarise.', metadata: { slot: 'morning' }, idempotencyKey: 'trigger:x:1', fireAt,
    });

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    const triggerId = String(trigger._id);
    expect(result.run).toMatchObject({
      status: 'queued', channel: 'trigger', triggerId, trigger: 'schedule', userId: `system:trigger:${triggerId}`, actorType: 'system',
      unattended: true, usePublished: true, idempotencyKey: 'trigger:x:1', metadata: { team: 'ops', slot: 'morning' },
      responseFormat: { type: 'json_object' }, callbackUrl: 'https://example.com/hook',
    });
    expect(result.run.externalContent).toBeFalsy();
    expect(result.run.apiTokenId).toBeFalsy();
    const conversation = await db.findAgentConversationById(result.run.conversationId);
    expect(conversation).toMatchObject({ createdBy: `system:trigger:${triggerId}`, metadata: { source: 'trigger', triggerId, trigger: 'schedule' } });
    expect(conversation?.title).toBe('Nightly · 2026-10-18 06:00');
    expect(hoisted.publish).toHaveBeenCalledTimes(1);

    const stored = await reload(trigger);
    expect(stored).toMatchObject({ lastStatus: 'started', lastRunId: String(result.run._id), lastError: null });
    expect(new Date(stored.lastFireAt!).toISOString()).toBe(fireAt.toISOString());
    expect(events()).toEqual([expect.objectContaining({
      type: 'trigger.fired',
      data: expect.objectContaining({ triggerId, agentKey: AGENT_KEY, trigger: 'schedule', runId: `run_${String(result.run._id)}` }),
    })]);
    expect(serializeAgentTrigger(stored).last_run_id).toBe(`run_${String(result.run._id)}`);
  });

  it('a pinned version runs that version; external content is carried on the run', async () => {
    const trigger = await newTrigger({ version: 2 });
    const result = await fireTrigger(trigger, tenant(), { trigger: 'manual', message: 'go', externalContent: true });
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.run).toMatchObject({ version: 2, usePublished: false, externalContent: true, trigger: 'manual' });
  });

  it('the same idempotency key is a duplicate: no second run, no second session, last* untouched, no event', async () => {
    const trigger = await newTrigger();
    const first = await fireTrigger(trigger, tenant(), { trigger: 'schedule', message: 'x', idempotencyKey: 'trigger:r:slot', fireAt: new Date('2026-10-18T06:00:00Z') });
    expect(first.kind).toBe('accepted');
    hoisted.publishWebhook.mockClear();
    const before = await reload(trigger);

    const again = await fireTrigger(trigger, tenant(), { trigger: 'schedule', message: 'x', idempotencyKey: 'trigger:r:slot', fireAt: new Date('2026-10-18T07:00:00Z') });
    expect(again.kind).toBe('duplicate');
    expect(await triggerRuns(String(trigger._id))).toHaveLength(1);
    expect(await conversations()).toHaveLength(1);
    expect((await reload(trigger)).lastFireAt).toEqual(before.lastFireAt);
    expect(events()).toEqual([]);
  });

  it('a key another trigger used is refused (idempotency key in use), recorded as failed', async () => {
    const other = await newTrigger({ name: 'Other' });
    await fireTrigger(other, tenant(), { trigger: 'manual', message: 'x', idempotencyKey: 'trigger:shared' });
    const trigger = await newTrigger();
    const result = await fireTrigger(trigger, tenant(), { trigger: 'manual', message: 'x', idempotencyKey: 'trigger:shared' });
    expect(result).toEqual({ kind: 'failed', reason: 'idempotency key in use' });
    expect(await reload(trigger)).toMatchObject({ lastStatus: 'failed', lastError: 'idempotency key in use' });
  });

  it('an inactive agent is a failed fire: no session left behind, trigger.failed sent', async () => {
    await db.updateAgent(agentId, { status: 'inactive' } as never);
    const trigger = await newTrigger();
    const result = await fireTrigger(trigger, tenant(), { trigger: 'schedule', message: 'x' });
    expect(result).toEqual({ kind: 'failed', reason: 'agent is not active' });
    expect(await conversations()).toHaveLength(0);
    expect(await reload(trigger)).toMatchObject({ lastStatus: 'failed', lastError: 'agent is not active' });
    expect(events()).toEqual([expect.objectContaining({ type: 'trigger.failed', data: expect.objectContaining({ reason: 'agent is not active' }) })]);
  });

  it('a run limit refusal deletes the session it created and leaves last* alone; the failure event is sent once an hour', async () => {
    process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT = '1';
    reloadConfig();
    const blocker = await newTrigger({ name: 'Blocker' });
    expect((await fireTrigger(blocker, tenant(), { trigger: 'manual', message: 'x' })).kind).toBe('accepted');
    hoisted.publishWebhook.mockClear();
    const trigger = await newTrigger();

    const refused = await fireTrigger(trigger, tenant(), { trigger: 'schedule', message: 'x' });
    expect(refused).toMatchObject({ kind: 'concurrency_limit', reason: 'agent run limit reached' });
    expect(await conversations()).toHaveLength(1); // only the blocker's
    const stored = await reload(trigger);
    expect(stored.lastFireAt ?? null).toBeNull();
    expect(stored.lastStatus ?? null).toBeNull();

    await fireTrigger(trigger, tenant(), { trigger: 'schedule', message: 'x' });
    expect(events().filter((e) => e.type === 'trigger.failed')).toHaveLength(1);
  });

  it('a spend limit refusal is spend_limit and creates nothing', async () => {
    hoisted.spendCheck.refuse = true;
    const trigger = await newTrigger();
    const result = await fireTrigger(trigger, tenant(), { trigger: 'schedule', message: 'x' });
    expect(result).toMatchObject({ kind: 'spend_limit', reason: 'spend limit reached' });
    expect(await conversations()).toHaveLength(0);
    expect((await reload(trigger)).lastStatus ?? null).toBeNull();
  });

  it('a scheduled fire is accountable to the trigger\'s last updater (else its creator); the session stays the trigger\'s', async () => {
    const trigger = await newTrigger();
    await updateAgentTrigger(scope(), trigger, { prompt: 'Summarise again.' }, 'user-2');
    const result = await fireTrigger(await reload(trigger), tenant(), { trigger: 'schedule', message: 'x' });
    expect(result.kind).toBe('accepted');
    const [run] = await triggerRuns(String(trigger._id));
    expect(run).toMatchObject({ userId: `system:trigger:${String(trigger._id)}`, accountableUserId: 'user-2' });
    expect(hoisted.spendCheck.calls.at(-1)).toMatchObject({ userId: 'user-2' });

    const fresh = await newTrigger({ name: 'Fresh' });
    await fireTrigger(fresh, tenant(), { trigger: 'schedule', message: 'x' });
    const [freshRun] = await triggerRuns(String(fresh._id));
    expect(freshRun).toMatchObject({ accountableUserId: 'user-1' });
    expect(hoisted.spendCheck.calls.at(-1)).toMatchObject({ userId: 'user-1' });
  });

  it('Run now is accountable to its caller and the caller\'s token', async () => {
    const trigger = await newTrigger();
    await fireTrigger(trigger, tenant(), { trigger: 'manual', message: 'x', principal: { userId: 'user-3', apiTokenId: 'tok-3' } });
    const [run] = await triggerRuns(String(trigger._id));
    expect(run).toMatchObject({ accountableUserId: 'user-3', accountableTokenId: 'tok-3' });
    expect(hoisted.spendCheck.calls.at(-1)).toMatchObject({ userId: 'user-3' });
  });

  it('too many metadata keys together is a failed fire', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v']));
    const trigger = await newTrigger({ metadata });
    const result = await fireTrigger(trigger, tenant(), {
      trigger: 'manual', message: 'x', metadata: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`o${i}`, 'v'])),
    });
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringContaining('metadata') });
  });
});

describe('agent delete', () => {
  it('deletes the agent’s triggers with it', async () => {
    await newTrigger();
    await newTrigger({ name: 'Second' });
    expect(await deleteAgentRecord(DB_NAME, agentId)).toBe(true);
    expect(await db.listAgentTriggers({ tenantId, projectId: PROJECT_ID })).toEqual([]);
  });
});

describe('the scheduler tick (§2.5)', () => {
  it('fires a due schedule slot once, advances nextFireAt, and keys the run by the slot', async () => {
    const created = new Date('2026-10-18T05:59:00.000Z');
    const trigger = await newTrigger({ type: 'schedule', schedule: { cron: '0 9 * * *', timezone: 'Europe/Istanbul' } }, created);
    expect(new Date(trigger.nextFireAt!).toISOString()).toBe('2026-10-18T06:00:00.000Z'); // 09:00 Istanbul (UTC+3)

    const result = await tickAgentTriggers(new Date('2026-10-18T06:00:10.000Z'));
    expect(result).toMatchObject({ fired: 1, claimedElsewhere: 0, skipped: 0 });
    const runs = await triggerRuns(String(trigger._id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', idempotencyKey: triggerSlotKey(String(trigger._id), new Date('2026-10-18T06:00:00.000Z')) });
    expect(new Date((await reload(trigger)).nextFireAt!).toISOString()).toBe('2026-10-19T06:00:00.000Z');

    // Not due again until tomorrow.
    expect(await tickAgentTriggers(new Date('2026-10-18T06:01:00.000Z'))).toMatchObject({ fired: 0 });
  });

  it('two schedulers on the same slot start ONE run', async () => {
    const trigger = await newTrigger({ type: 'schedule', schedule: { cron: '*/5 * * * *', timezone: 'UTC' } }, new Date('2026-10-18T05:59:00.000Z'));
    const now = new Date('2026-10-18T06:00:05.000Z');
    const [a, b] = await Promise.all([tickAgentTriggers(now), tickAgentTriggers(now)]);
    expect(a.fired + b.fired).toBe(1);
    expect(await triggerRuns(String(trigger._id))).toHaveLength(1);
    expect(new Date((await reload(trigger)).nextFireAt!).toISOString()).toBe('2026-10-18T06:05:00.000Z');
  });

  it('a once trigger fires once and is finished', async () => {
    const runAt = new Date('2026-10-18T07:30:00.000Z');
    const trigger = await newTrigger({ type: 'once', once: { runAt } }, new Date('2026-10-18T07:00:00.000Z'));
    expect(await tickAgentTriggers(new Date('2026-10-18T07:29:00.000Z'))).toMatchObject({ fired: 0 });
    expect(await tickAgentTriggers(new Date('2026-10-18T07:30:01.000Z'))).toMatchObject({ fired: 1 });
    expect(await tickAgentTriggers(new Date('2026-10-18T07:31:00.000Z'))).toMatchObject({ fired: 0 });
    const runs = await triggerRuns(String(trigger._id));
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe('once');
    expect((await reload(trigger)).nextFireAt ?? null).toBeNull();
    // Re-enabling a fired once trigger does not bring it back.
    const updated = await updateAgentTrigger(scope(), await reload(trigger), { enabled: true }, 'user-1', new Date('2026-10-18T08:00:00.000Z'));
    expect(updated?.nextFireAt ?? null).toBeNull();
  });

  it('after downtime, only the latest missed slot within the grace fires; older ones are skipped', async () => {
    const trigger = await newTrigger({ type: 'schedule', schedule: { cron: '0 * * * *', timezone: 'UTC' } }, new Date('2026-10-18T05:30:00.000Z'));
    // Down from 05:30 to 09:20: slots 06:00, 07:00, 08:00, 09:00 missed; 09:00 is within the 1 h grace.
    expect(await tickAgentTriggers(new Date('2026-10-18T09:20:00.000Z'))).toMatchObject({ fired: 1 });
    const runs = await triggerRuns(String(trigger._id));
    expect(runs).toHaveLength(1);
    expect(runs[0].idempotencyKey).toBe(triggerSlotKey(String(trigger._id), new Date('2026-10-18T09:00:00.000Z')));
    expect(new Date((await reload(trigger)).nextFireAt!).toISOString()).toBe('2026-10-18T10:00:00.000Z');
  });

  it('a slot older than the grace is skipped without a run', async () => {
    process.env.AGENT_TRIGGER_MISFIRE_GRACE_MS = '600000'; // 10 min
    reloadConfig();
    const trigger = await newTrigger({ type: 'once', once: { runAt: new Date('2026-10-18T06:00:00.000Z') } }, new Date('2026-10-18T05:00:00.000Z'));
    expect(await tickAgentTriggers(new Date('2026-10-18T07:00:00.000Z'))).toMatchObject({ fired: 0, skipped: 1 });
    expect(await triggerRuns(String(trigger._id))).toHaveLength(0);
    expect((await reload(trigger)).nextFireAt ?? null).toBeNull();
  });

  it('a refused slot is skipped, not retried: the next tick waits for the next slot', async () => {
    hoisted.spendCheck.refuse = true;
    const trigger = await newTrigger({ type: 'schedule', schedule: { cron: '0 * * * *', timezone: 'UTC' } }, new Date('2026-10-18T05:30:00.000Z'));
    expect(await tickAgentTriggers(new Date('2026-10-18T06:00:01.000Z'))).toMatchObject({ fired: 0, skipped: 1 });
    hoisted.spendCheck.refuse = false;
    expect(await tickAgentTriggers(new Date('2026-10-18T06:00:30.000Z'))).toMatchObject({ fired: 0 });
    expect(await triggerRuns(String(trigger._id))).toHaveLength(0);
    expect(new Date((await reload(trigger)).nextFireAt!).toISOString()).toBe('2026-10-18T07:00:00.000Z');
  });

  it('disabled and manual triggers never fire on their own', async () => {
    await newTrigger({ type: 'schedule', schedule: { cron: '* * * * *', timezone: 'UTC' }, enabled: false }, new Date('2026-10-18T05:30:00.000Z'));
    await newTrigger({ type: 'manual' });
    expect(await tickAgentTriggers(new Date('2026-10-18T06:00:00.000Z'))).toMatchObject({ fired: 0, skipped: 0 });
  });
});
