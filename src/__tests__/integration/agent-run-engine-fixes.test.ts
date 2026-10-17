/**
 * Run engine: claim failures, promotion caps, callback events, inline turns
 * ended elsewhere, quota admission, idempotency races, retention and the
 * accountable principal of a routine run.
 *
 * Same harness as `agent-run-background-execution.test.ts`: a REAL SQLite
 * provider with the agent turn itself (`agentService`), the queue, the quota
 * counters and the webhook delivery faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  executeAgentChat: vi.fn(),
  executeAgentChatLocal: vi.fn(),
  executeAgentResumeLocal: vi.fn(),
  executeAgentContinueLocal: vi.fn(),
  getDatabase: vi.fn(),
  publish: vi.fn(),
  getUserAuthState: vi.fn(),
  enforceAgentRunQuota: vi.fn(),
  settleAgentRun: vi.fn(),
  publishWebhookEvent: vi.fn(),
  sendSignedWebhook: vi.fn(),
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: hoisted.executeAgentChat,
  executeAgentChatLocal: hoisted.executeAgentChatLocal,
  executeAgentResumeLocal: hoisted.executeAgentResumeLocal,
  executeAgentContinueLocal: hoisted.executeAgentContinueLocal,
}));
vi.mock('@/lib/services/agents/agentQuota', () => ({
  enforceAgentRunQuota: hoisted.enforceAgentRunQuota,
  settleAgentRun: hoisted.settleAgentRun,
}));
vi.mock('@/lib/services/webhooks/webhookService', () => ({
  publishWebhookEvent: hoisted.publishWebhookEvent,
  cleanupWebhookDeliveries: vi.fn(async () => 0),
  sweepDueWebhookDeliveries: vi.fn(async () => 0),
}));
vi.mock('@/lib/services/webhooks/webhookDeliverer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/webhooks/webhookDeliverer')>();
  return { ...actual, sendSignedWebhook: hoisted.sendSignedWebhook };
});
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

import { AgentRunIdempotencyKeyTakenError, getDatabase } from '@/lib/database';
import type { IAgentRun } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { AgentRunInterruptedError } from '@/lib/services/agents/agentErrors';
import {
  AGENT_RUN_CALLBACK_QUEUE,
  AGENT_RUN_QUEUE,
  agentRunCallbackEventId,
  deliverAgentRunCallbackJob,
  drainLocalAgentRuns,
  fireAgentRunCallback,
  runAgentJobLocal,
  startAgentRun,
} from '@/lib/services/agents/agentRunService';
import { reconcileOrphanedAgentRuns, triggerAgentRunReconcilerRun } from '@/lib/services/agents/agentRunReconciler';
import { resetAgentRunDrainForTests } from '@/lib/services/agents/agentConsumer';
import { drainAgentRunsBeforeHttpClose } from '@/server/httpShutdown';
import { streamAgentRunAsResponses } from '@/server/api/plugins/agent-responses-stream';
import Fastify from 'fastify';
import http from 'node:http';
import { queueAgentRun } from '../helpers/agent-runs';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DAY = 86_400_000;

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_engine_fixes';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-agent';

function fakeResponse(id: string) {
  return {
    id,
    object: 'response' as const,
    model: AGENT_KEY,
    output: [],
    status: 'completed' as const,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    created_at: 0,
    previous_response_id: null,
    version: null,
  };
}

const base = (conversationId: string, overrides: Partial<Parameters<typeof queueAgentRun>[0]> = {}) => ({
  tenantId,
  tenantDbName: dbName,
  projectId: PROJECT_ID,
  agentKey: AGENT_KEY,
  conversationId,
  userMessage: 'hello',
  userId: 'user-1',
  ...overrides,
});

async function queued(conversationId: string, overrides: Partial<Parameters<typeof queueAgentRun>[0]> = {}): Promise<IAgentRun> {
  const outcome = await queueAgentRun(base(conversationId, overrides));
  if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`);
  return outcome.run;
}

const read = async (run: IAgentRun | string) => (await db.getAgentRunById(String(typeof run === 'string' ? run : run._id), tenantId, PROJECT_ID))!;
const runJobs = () => hoisted.publish.mock.calls.filter((call) => call[0] === AGENT_RUN_QUEUE);
const callbackJobs = () => hoisted.publish.mock.calls.filter((call) => call[0] === AGENT_RUN_CALLBACK_QUEUE);

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-run-engine-fixes-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-engine-fixes', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Support', config: { modelKey: 'gpt-4o' }, status: 'active', createdBy: 'user-1',
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.enforceAgentRunQuota.mockResolvedValue(undefined);
  hoisted.publishWebhookEvent.mockResolvedValue(undefined);
  hoisted.sendSignedWebhook.mockResolvedValue({ ok: true, statusCode: 200 });
  hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_x'));
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '10000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '1000';
  reloadConfig();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const key of [
    'AGENT_BACKGROUND_MAX_DURATION_MS', 'AGENT_RUN_HEARTBEAT_INTERVAL_MS', 'AGENT_RUN_MAX_ACTIVE_PER_TENANT',
    'AGENT_RUN_RETENTION_DAYS', 'AGENT_RUN_REQUEUE_AFTER_MS', 'AGENT_RUN_DRAIN_TIMEOUT_MS',
  ]) delete process.env[key];
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('a run job that fails before its claim', () => {
  it('completes instead of failing, and leaves the run queued for the reconciler', async () => {
    const run = await queued('conv-preclaim');
    vi.spyOn(db, 'claimAgentRun').mockRejectedValueOnce(new Error('transient database error'));

    await expect(runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName })).resolves.toBeUndefined();
    expect(await read(run)).toMatchObject({ status: 'queued' });
  });

  it('is republished under a job id of its own time bucket, not the id the queue still remembers', async () => {
    const run = await queued('conv-republish');
    expect(runJobs()[0][3]).toMatchObject({ dedupKey: `ar_${String(run._id)}_1` });
    hoisted.publish.mockClear();

    await reconcileOrphanedAgentRuns();

    const [job] = runJobs();
    expect(job[3].dedupKey).toMatch(new RegExp(`^ar_${String(run._id)}_1_r\\d+$`));
  });

  it('a tick leaves a run published within the requeue window alone, and republishes it once the window passed', async () => {
    process.env.AGENT_RUN_REQUEUE_AFTER_MS = '10000';
    reloadConfig();
    const run = await queued('conv-window');
    hoisted.publish.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15_000);

    await triggerAgentRunReconcilerRun();
    expect(runJobs()).toHaveLength(1);
    const first = runJobs()[0][3].dedupKey;

    await triggerAgentRunReconcilerRun();
    expect(runJobs()).toHaveLength(1); // just published

    vi.setSystemTime(Date.now() + 15_000);
    await triggerAgentRunReconcilerRun();
    expect(runJobs()).toHaveLength(2);
    expect(runJobs()[1][3].dedupKey).not.toBe(first);
    void run;
  });
});

describe('promoting scheduled runs', () => {
  it('keeps a due run scheduled while the default class is at its active cap, and promotes it once a slot frees', async () => {
    process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT = '2';
    reloadConfig();
    const runs: IAgentRun[] = [];
    for (let i = 0; i < 4; i += 1) runs.push(await queued(`conv-sched-${i}`, { notBefore: new Date(Date.now() + 1_500) }));
    expect(runs.every((run) => run.status === 'scheduled')).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5_000);

    await triggerAgentRunReconcilerRun();
    let states = await Promise.all(runs.map(async (run) => (await read(run)).status));
    expect(states.filter((status) => status === 'queued')).toHaveLength(2);
    expect(states.filter((status) => status === 'scheduled')).toHaveLength(2);

    const first = runs.find((_, i) => states[i] === 'queued')!;
    await runAgentJobLocal({ runId: String(first._id), tenantId, tenantDbName: dbName });
    await triggerAgentRunReconcilerRun();
    states = await Promise.all(runs.map(async (run) => (await read(run)).status));
    expect(states.filter((status) => status === 'scheduled')).toHaveLength(1);
  });
});

describe('run callbacks', () => {
  const pause = async (run: IAgentRun) => {
    await db.claimAgentRun(String(run._id), tenantId, 'node-1', new Date());
    return (await db.finalizeAgentRun(String(run._id), tenantId, { status: 'requires_action', stopReason: 'requires_action' }))!;
  };
  const payloadOf = (call: unknown[]) => call[2] as Parameters<typeof deliverAgentRunCallbackJob>[0];

  it('a second pause of the same run is a new event: its callback carries a new event id', async () => {
    const run = await queued('conv-cb-ids', { callbackUrl: 'https://example.com/cb' });
    const firstPause = await pause(run);
    await fireAgentRunCallback(firstPause, 'requires_action', {});
    const resumed = (await db.requeueAgentRunForResume(String(run._id), tenantId, ['act_1']))!;
    const secondPause = await pause(resumed);
    await fireAgentRunCallback(secondPause, 'requires_action', {});

    const ids = callbackJobs().map((call) => payloadOf(call).eventId);
    expect(ids).toEqual([`evt_${String(run._id)}_requires_action`, `evt_${String(run._id)}_requires_action_2`]);
    expect(agentRunCallbackEventId(secondPause, 'requires_action')).toBe(ids[1]);

    for (const call of callbackJobs()) await deliverAgentRunCallbackJob(payloadOf(call));
    const sentIds = hoisted.sendSignedWebhook.mock.calls.map(([input]) => (input as { eventId: string }).eventId);
    expect(sentIds).toEqual(ids);
  });

  it('a late delivery of an older event does not overwrite the bookkeeping of the newer one', async () => {
    const run = await queued('conv-cb-cas', { callbackUrl: 'https://example.com/cb' });
    const paused = await pause(run);
    await fireAgentRunCallback(paused, 'requires_action', {});
    const olderJob = payloadOf(callbackJobs()[0]);
    const resumed = (await db.requeueAgentRunForResume(String(run._id), tenantId, ['act_1']))!;
    await db.claimAgentRun(String(resumed._id), tenantId, 'node-1', new Date());
    const done = (await db.finalizeAgentRun(String(run._id), tenantId, { status: 'succeeded', completedAt: new Date() }))!;
    await fireAgentRunCallback(done, 'succeeded', { result: null });
    const newerJob = payloadOf(callbackJobs()[1]);

    hoisted.sendSignedWebhook.mockResolvedValueOnce({ ok: false, statusCode: 500 });
    await expect(deliverAgentRunCallbackJob(newerJob)).rejects.toThrow();
    expect(await read(run)).toMatchObject({ callbackStatus: 'failed', callbackAttempts: 1 });

    await deliverAgentRunCallbackJob(olderJob);
    // Still owed: the reconciler sends the succeeded callback again.
    expect(await read(run)).toMatchObject({ callbackStatus: 'failed', callbackAttempts: 1, callbackEventId: newerJob.eventId });
  });
});

describe('an inline turn whose row was ended elsewhere', () => {
  it('drained at shutdown: the caller gets the row\'s outcome (interrupted), not the turn\'s partial answer', async () => {
    // The turn answers with what it had once its signal aborts.
    hoisted.executeAgentChat.mockImplementation((request: { signal: AbortSignal }) => new Promise((resolve) => {
      request.signal.addEventListener('abort', () => resolve(fakeResponse('resp_partial')), { once: true });
    }));
    const outcome = startAgentRun({
      ...base('conv-inline-drain'),
      channel: 'responses',
      execution: { kind: 'inline', waitMs: 60_000, cancelOnDisconnect: false },
    });
    const settled = outcome.then(() => 'completed', (error: unknown) => error);
    await delay(100);

    expect(await drainLocalAgentRuns(50)).toEqual({ settled: 0, interrupted: 1 });

    const error = await settled;
    expect(error).toBeInstanceOf(AgentRunInterruptedError);
    expect((error as AgentRunInterruptedError).reason).toBe('interrupted');
    const [row] = await db.listAgentRuns({ tenantId, projectId: PROJECT_ID, conversationId: 'conv-inline-drain' });
    expect(row).toMatchObject({ status: 'failed', errorReason: 'interrupted' });
  });

  it('drained while the turn is still inside a call: the caller is answered at once', async () => {
    hoisted.executeAgentChat.mockImplementation(() => new Promise(() => undefined));
    const outcome = startAgentRun({
      ...base('conv-inline-hung'),
      channel: 'responses',
      execution: { kind: 'inline', waitMs: 0, stream: {}, cancelOnDisconnect: false },
    });
    await delay(100);
    await drainLocalAgentRuns(50);
    await expect(outcome).rejects.toBeInstanceOf(AgentRunInterruptedError);
  });
});

describe('the agent-run quota of a queued run', () => {
  it('is counted only for a run that is admitted', async () => {
    await queued('conv-quota');
    expect(hoisted.enforceAgentRunQuota).toHaveBeenCalledTimes(1);

    const conflict = await queueAgentRun(base('conv-quota'));
    expect(conflict.kind).toBe('conflict');

    process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT = '1';
    reloadConfig();
    const capped = await queueAgentRun(base('conv-quota-2'));
    expect(capped.kind).toBe('concurrency_limit');
    expect(hoisted.enforceAgentRunQuota).toHaveBeenCalledTimes(1);
  });

  it('a refusal by the quota removes the run again', async () => {
    hoisted.enforceAgentRunQuota.mockRejectedValueOnce(new Error('over quota'));
    await expect(queueAgentRun(base('conv-quota-refused'))).rejects.toThrow('over quota');
    expect(await db.listAgentRuns({ tenantId, projectId: PROJECT_ID, conversationId: 'conv-quota-refused' })).toEqual([]);
    expect(runJobs()).toHaveLength(0);
  });
});

describe('an Idempotency-Key whose run is being created by an identical request', () => {
  it('waits briefly for that run and replays it instead of answering a conflict', async () => {
    const original = db.createAgentRun.bind(db);
    const spy = vi.spyOn(db, 'createAgentRun').mockImplementationOnce(async (record) => {
      // The identical request holds the key and inserts its row a moment later.
      setTimeout(() => { void original(record); }, 150);
      throw new AgentRunIdempotencyKeyTakenError(record.idempotencyKey!);
    });

    const outcome = await queueAgentRun(base('conv-idem-race', { idempotencyKey: 'key-1' }));
    expect(outcome.kind).toBe('replay');
    spy.mockRestore();
  });
});

describe('retention of scheduled, deferred and finished runs', () => {
  beforeEach(() => {
    process.env.AGENT_RUN_RETENTION_DAYS = '7';
    reloadConfig();
  });

  it('a scheduled run is kept from its start, a deferred one from its longest wait', async () => {
    const notBefore = new Date(Date.now() + 10 * DAY);
    const scheduled = await queued('conv-ret-sched', { notBefore });
    expect(new Date(scheduled.expiresAt!).getTime()).toBeGreaterThanOrEqual(notBefore.getTime() + 7 * DAY);

    const before = Date.now();
    const deferred = await queued('conv-ret-deferred', { runClass: 'deferred' });
    // AGENT_DEFERRED_MAX_WAIT_MS defaults to a day.
    expect(new Date(deferred.expiresAt!).getTime()).toBeGreaterThanOrEqual(before + DAY + 7 * DAY);
  });

  it('a run is kept for the full retention from when it finished', async () => {
    const run = await queued('conv-ret-finish');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * DAY);
    const finishedAt = Date.now();

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    const done = await read(run);
    expect(done.status).toBe('succeeded');
    expect(new Date(done.expiresAt!).getTime()).toBeGreaterThanOrEqual(finishedAt + 7 * DAY);
  });
});

describe('a run owned by a synthetic actor (a routine fire)', () => {
  it('counts its quota and spend against its accountable principal', async () => {
    const run = await queued('conv-accountable', {
      userId: 'system:routine:rt1',
      actorType: 'system',
      channel: 'routine',
      routineId: 'rt1',
      accountable: { userId: 'user-2', apiTokenId: 'tok-2' },
    });
    expect(run).toMatchObject({ userId: 'system:routine:rt1', accountableUserId: 'user-2', accountableTokenId: 'tok-2' });
    expect(hoisted.enforceAgentRunQuota).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-2', tokenId: 'tok-2' }));

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.executeAgentChatLocal).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'system:routine:rt1', accountableUserId: 'user-2',
    }));
    expect(hoisted.settleAgentRun).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-2', tokenId: 'tok-2' }), expect.anything(), expect.anything());
  });
});

describe('graceful shutdown with an agent run streaming to its caller', () => {
  afterEach(() => resetAgentRunDrainForTests());

  it('drains the run before the HTTP server waits for connections: the stream ends with its terminal event and the server closes', async () => {
    process.env.AGENT_RUN_DRAIN_TIMEOUT_MS = '50';
    reloadConfig();
    // A turn that never ends on its own.
    hoisted.executeAgentChat.mockImplementation(() => new Promise(() => undefined));
    const app = Fastify();
    drainAgentRunsBeforeHttpClose(app);
    app.post('/stream', (_request, reply) => streamAgentRunAsResponses(reply, {
      ...base('conv-shutdown'),
      channel: 'responses',
    }, { cancelOnDisconnect: false, streamReasoning: false, object: {} }));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    // A client that closes its connection after the response (no keep-alive pool to wait out).
    let body = '';
    const readAll = new Promise<string>((resolve, reject) => {
      const request = http.request(`${address}/stream`, { method: 'POST', agent: false }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve(body));
      });
      request.on('error', reject);
      request.end();
    });
    while (!body.includes('response.created')) await delay(20);

    const closed = await Promise.race([app.close().then(() => 'closed'), delay(3_000).then(() => 'still open')]);
    expect(closed).toBe('closed');
    await readAll;

    expect(body).toContain('agent_run_interrupted');
    const [row] = await db.listAgentRuns({ tenantId, projectId: PROJECT_ID, conversationId: 'conv-shutdown' });
    expect(row).toMatchObject({ status: 'failed', errorReason: 'interrupted' });
  });
});
