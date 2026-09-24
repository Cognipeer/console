/**
 * Group E (docs/guide/agent-background-execution.md §13) — background
 * execution core.
 *
 * DoD (plan.md Group E): a background request creates a pollable run;
 * polling reflects `queued -> running -> succeeded`; a second background
 * request on the same conversation gets `409`/conflict; canceling a running
 * run stops the loop before its next step and the run finalizes as
 * `canceled`, never `succeeded` (§12.12's guard proven, not assumed).
 *
 * Same harness as `agent-run-sync-ceiling.test.ts`: a REAL SQLite provider
 * (so claim/finalize CAS and the partial-unique-index conflict guard are
 * genuinely exercised) with only `executeAgentChatLocal` faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  executeAgentChatLocal: vi.fn(),
  getDatabase: vi.fn(),
  publish: vi.fn(),
}));

// Observe run/callback jobs instead of pushing them into a real queue whose
// consumer would race the explicit runAgentJobLocal calls below.
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish: hoisted.publish })),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: vi.fn(),
  executeAgentChatLocal: hoisted.executeAgentChatLocal,
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

import { getDatabase } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { getRequestContext } from '@/lib/core/requestContext';
import {
  AGENT_RUN_QUEUE,
  createBackgroundAgentRun,
  runAgentJobLocal,
  getAgentRunStatus,
  requestAgentRunCancellation,
} from '@/lib/services/agents/agentRunService';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let agentId: string;
const dbName = 'tenant_background_run';
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

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-run-background-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme',
    slug: 'acme-background',
    dbName,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  // The worker re-checks its preconditions: the agent must exist and be active.
  agentId = String((await db.createAgent({
    tenantId,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Support',
    config: { modelKey: 'gpt-4o' },
    status: 'active',
    createdBy: 'user-1',
  }))._id);
  hoisted.publish.mockResolvedValue(undefined);
  // Env knobs are clamped (max duration >= 10s, heartbeat >= 1s); tests that
  // need a short ceiling pass it through the run's own resolved limit.
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '10000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '1000';
  reloadConfig();
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createRun(
  conversationId: string,
  overrides: Partial<Parameters<typeof createBackgroundAgentRun>[0]> = {},
) {
  const outcome = await createBackgroundAgentRun({
    tenantId,
    tenantDbName: dbName,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId,
    userMessage: 'hello',
    userId: 'user-1',
    ...overrides,
  });
  if (outcome.kind !== 'created') throw new Error(`expected created, got ${outcome.kind}`);
  return outcome.run;
}

describe('background execution core (§7)', () => {
  it('202-equivalent create returns a queued run; polling reflects queued -> running -> succeeded', async () => {
    let resolveInvoke: (value: unknown) => void;
    hoisted.executeAgentChatLocal.mockImplementation(
      () => new Promise((resolve) => { resolveInvoke = resolve; }),
    );

    const run = await createRun('conv-lifecycle');
    expect(run.status).toBe('queued');

    const jobPromise = runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    await delay(30); // let claimAgentRun's queued -> running CAS land

    const midFlight = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(midFlight?.status).toBe('running');

    resolveInvoke!(fakeResponse(`resp_${run._id}`));
    await jobPromise;

    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('succeeded');
    // §8: background/run responses get a per-run id, distinct from the
    // synchronous scheme's conversation-scoped id.
    expect((finalStatus?.result as { id?: string } | null)?.id).toBe(`resp_${run._id}`);
  });

  it('a second background request against the same conversation gets a conflict while the first is queued/running', async () => {
    hoisted.executeAgentChatLocal.mockImplementation(() => new Promise(() => undefined));

    await createRun('conv-conflict');
    const second = await createBackgroundAgentRun({
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      conversationId: 'conv-conflict',
      userMessage: 'hello again',
      userId: 'user-1',
    });
    expect(second.kind).toBe('conflict');
  });

  it('a redelivered/duplicate queue message cannot double-claim the same run', async () => {
    hoisted.executeAgentChatLocal.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse('resp_x')), 50)),
    );
    const run = await createRun('conv-duplicate');

    const [firstResult, secondResult] = await Promise.allSettled([
      runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName }),
      runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName }),
    ]);
    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('fulfilled');

    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('succeeded');
  });

  it('canceling a running run stops the loop before its next step and finalizes as canceled, never succeeded', async () => {
    let resolveInvoke: (value: unknown) => void;
    hoisted.executeAgentChatLocal.mockImplementation(
      () => new Promise((resolve) => { resolveInvoke = resolve; }),
    );

    const run = await createRun('conv-cancel');
    const jobPromise = runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    await delay(30); // let it reach `running`

    const cancelResult = await requestAgentRunCancellation(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(cancelResult.kind).toBe('accepted');
    if (cancelResult.kind === 'accepted') {
      expect(cancelResult.run.cancelRequestedAt).toBeTruthy();
    }

    // Give the dedicated cancel-poll timer (CANCEL_POLL_INTERVAL_MS,
    // independent of the heartbeat interval) a chance to observe the cancel
    // flag, then let the abandoned invoke() "succeed" anyway — proving the
    // late-arriving result does NOT flip the outcome back to succeeded
    // (§12.12).
    await delay(1300);
    resolveInvoke!(fakeResponse(`resp_${run._id}`));
    await jobPromise;

    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('canceled');
    expect(finalStatus?.errorReason).toBe('canceled_by_caller');
  }, 10_000);

  it('REGRESSION: cancellation is observed and finalized promptly even with a SLOW (production-default-like) heartbeat interval', async () => {
    // The bug this pins: cancellation used to be piggy-backed on the
    // heartbeat write. With the default 15s heartbeat, a turn that
    // naturally finishes in a few seconds (the common case for a simple,
    // tool-free turn) settled and got WRITTEN before the flag was ever
    // observed — cancel silently did nothing and the run ended `succeeded`.
    // Set the heartbeat interval deliberately much larger than the tight,
    // independent cancel-poll interval (hardcoded at 1000ms in
    // agentRunService.ts) so this test cannot pass by accident the way a
    // tiny heartbeat interval would mask it.
    process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '60000';
    reloadConfig();

    let resolveInvoke: (value: unknown) => void;
    hoisted.executeAgentChatLocal.mockImplementation(
      () => new Promise((resolve) => { resolveInvoke = resolve; }),
    );

    const run = await createRun('conv-cancel-slow-heartbeat');
    const jobPromise = runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    await delay(30);

    await requestAgentRunCancellation(dbName, tenantId, PROJECT_ID, String(run._id));

    // Real-time wait past the (hardcoded) 1000ms cancel-poll tick — the
    // heartbeat interval above (60s) would NEVER fire within this test.
    await delay(1300);
    resolveInvoke!(fakeResponse(`resp_${run._id}`));
    await jobPromise;

    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('canceled');
    expect(finalStatus?.errorReason).toBe('canceled_by_caller');
    // The canceled turn must never have been written to the conversation.
    expect(finalStatus?.result).toBeNull();
  }, 10_000);

  it('a run that exceeds its max duration is finalized failed/max_duration_exceeded without waiting for invoke()', async () => {
    let resolveInvoke: (value: unknown) => void;
    let seenCell: { cancelled: boolean; deadlineAt?: number } | undefined;
    hoisted.executeAgentChatLocal.mockImplementation(
      (request: { cancellationCell?: { cancelled: boolean; deadlineAt?: number } }) => {
        seenCell = request.cancellationCell;
        return new Promise((resolve) => { resolveInvoke = resolve; });
      },
    );

    // The effective ceiling (min of env/quota/agent) is carried on the row.
    const run = await createRun('conv-max-duration', {
      limits: { backgroundMaxDurationMs: 40, maxConcurrentRunsPerTenant: 0, maxConcurrentRunsPerProject: 0 },
    });
    expect(run.maxDurationMs).toBe(40);
    const startedAt = Date.now();
    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(300);

    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.errorReason).toBe('max_duration_exceeded');

    // REGRESSION: the ceiling stops the TURN, not just the record — the cell
    // the SDK loop polls is tripped, and it carried the deadline all along.
    expect(seenCell?.cancelled).toBe(true);
    expect(seenCell?.deadlineAt).toBeGreaterThanOrEqual(startedAt);
    expect(seenCell?.deadlineAt).toBeLessThanOrEqual(startedAt + 300);

    // The abandoned invoke() eventually "succeeding" afterwards must not
    // flip a `failed` run back to `succeeded` (finalize's CAS guards it).
    resolveInvoke!(fakeResponse(`resp_${run._id}`));
    await delay(20);
    const stillFailed = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(stillFailed?.status).toBe('failed');
  });

  it('the row\'s ceiling can never exceed the env ceiling (env is the hard cap)', async () => {
    // A row claiming 1h against a 10s env ceiling is still stopped at <= 10s:
    // assert via the deadline handed to the turn.
    let seenCell: { deadlineAt?: number } | undefined;
    hoisted.executeAgentChatLocal.mockImplementation((request: { cancellationCell?: { deadlineAt?: number } }) => {
      seenCell = request.cancellationCell;
      return Promise.reject(new Error('stop here'));
    });
    const run = await createRun('conv-env-cap', {
      limits: { backgroundMaxDurationMs: 3_600_000, maxConcurrentRunsPerTenant: 0, maxConcurrentRunsPerProject: 0 },
    });
    const before = Date.now();
    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    expect(seenCell?.deadlineAt).toBeLessThanOrEqual(before + 10_000 + 50);
  });
});

describe('background run ids (§8): the id the API returns is the id the API accepts', () => {
  it('REGRESSION: GET status with the run_<id> returned by create resolves the run (not 404)', async () => {
    hoisted.executeAgentChatLocal.mockImplementation(() => new Promise(() => undefined));
    const run = await createRun('conv-public-id');

    const viaPublicId = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, `run_${String(run._id)}`);
    expect(viaPublicId?._id).toBe(run._id);
    const viaRespId = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, `resp_${String(run._id)}`);
    expect(viaRespId?._id).toBe(run._id);
    const viaRawId = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(viaRawId?._id).toBe(run._id);
  });

  it('REGRESSION: cancel with the run_<id> returned by create is accepted (not 404)', async () => {
    const run = await createRun('conv-public-id-cancel');
    const outcome = await requestAgentRunCancellation(dbName, tenantId, PROJECT_ID, `run_${String(run._id)}`);
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind === 'accepted') expect(outcome.run.status).toBe('canceled');
  });

  it('cancel on a sync reservation row is not_found — it is an internal lock, not a caller-owned run', async () => {
    const reservation = await db.createAgentRun({
      mode: 'sync',
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      conversationId: 'conv-sync-row',
      userMessage: 'hello',
      status: 'running',
      startedAt: new Date(),
      callbackAttempts: 0,
    });
    const outcome = await requestAgentRunCancellation(dbName, tenantId, PROJECT_ID, `run_${String(reservation._id)}`);
    expect(outcome.kind).toBe('not_found');
    expect((await db.getAgentRunById(String(reservation._id), tenantId, PROJECT_ID))?.status).toBe('running');
  });

  it('canceling a QUEUED run finalizes it canceled at once and queues its canceled callback', async () => {
    const run = await createRun('conv-cancel-queued', { callbackUrl: 'https://hooks.example.com/run' });
    hoisted.publish.mockClear();

    const outcome = await requestAgentRunCancellation(dbName, tenantId, PROJECT_ID, `run_${String(run._id)}`);
    expect(outcome.kind).toBe('accepted');
    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id)))?.status).toBe('canceled');

    const callbackJobs = hoisted.publish.mock.calls.filter(([queue, name]) => queue === AGENT_RUN_QUEUE && name === 'callback');
    expect(callbackJobs).toHaveLength(1);
    expect(callbackJobs[0][2]).toMatchObject({ runId: String(run._id), event: 'canceled' });
  });
});

describe('worker hardening', () => {
  it('REGRESSION: invoke() rejecting finalizes the run failed/agent_error, stops every timer, and queues the callback', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const heartbeatSpy = vi.spyOn(db, 'updateAgentRunHeartbeat');
    hoisted.executeAgentChatLocal.mockRejectedValue(new Error('provider exploded: sk-live-SECRET at http://10.0.0.5'));

    const run = await createRun('conv-invoke-rejects', { callbackUrl: 'https://hooks.example.com/run' });
    hoisted.publish.mockClear();
    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.errorReason).toBe('agent_error');
    // Sanitized: an unclassified internal error never reaches the caller verbatim.
    expect(finalStatus?.errorMessage).not.toContain('sk-live-SECRET');
    expect(finalStatus?.errorMessage).toBeTruthy();

    // No heartbeat/cancel-poll interval survives the failure...
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(heartbeatSpy).not.toHaveBeenCalled();

    // ...and the failure is still reported to the caller's webhook.
    const callbackJobs = hoisted.publish.mock.calls.filter(([queue, name]) => queue === AGENT_RUN_QUEUE && name === 'callback');
    expect(callbackJobs).toHaveLength(1);
    expect(callbackJobs[0][2]).toMatchObject({ runId: String(run._id), event: 'failed', data: { errorReason: 'agent_error' } });
  });

  it('REGRESSION: a run whose agent was deactivated after submit fails precondition_failed without invoking', async () => {
    const run = await createRun('conv-inactive-agent');
    await db.updateAgent(agentId, { status: 'inactive' as never });

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.errorReason).toBe('precondition_failed');
    expect(finalStatus?.errorMessage).toMatch(/not active/i);
  });

  it('a run whose agent was deleted after submit fails precondition_failed without invoking', async () => {
    const run = await createRun('conv-deleted-agent');
    await db.deleteAgent(agentId);

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.errorReason).toBe('precondition_failed');
  });

  it('a run whose API token was revoked after submit fails precondition_failed without invoking', async () => {
    const run = await createRun('conv-revoked-token', { apiTokenId: 'tok-revoked' });
    vi.spyOn(db, 'listProjectApiTokens').mockResolvedValue([]);

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.errorReason).toBe('precondition_failed');
    expect(finalStatus?.errorMessage).toMatch(/revoked/i);
  });

  it('a run whose API token has expired fails precondition_failed; a live token lets it run', async () => {
    hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_x'));
    const expired = await createRun('conv-expired-token', { apiTokenId: 'tok-expired' });
    const live = await createRun('conv-live-token', { apiTokenId: 'tok-live' });
    vi.spyOn(db, 'listProjectApiTokens').mockResolvedValue([
      { _id: 'tok-expired', expiresAt: new Date(Date.now() - 1000) },
      { _id: 'tok-live', expiresAt: new Date(Date.now() + 3_600_000) },
    ] as never);

    await runAgentJobLocal({ runId: String(expired._id), tenantId, tenantDbName: dbName });
    await runAgentJobLocal({ runId: String(live._id), tenantId, tenantDbName: dbName });

    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(expired._id)))?.errorReason).toBe('precondition_failed');
    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(live._id)))?.status).toBe('succeeded');
    expect(hoisted.executeAgentChatLocal).toHaveBeenCalledTimes(1);
  });

  it('runs the turn inside a request context carrying the run\'s attribution (usage is not orphaned)', async () => {
    let seenContext: ReturnType<typeof getRequestContext>;
    hoisted.executeAgentChatLocal.mockImplementation(async () => {
      seenContext = getRequestContext();
      return fakeResponse('resp_x');
    });
    const run = await createRun('conv-attribution', { apiTokenId: undefined, userId: 'user-42' });

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(seenContext).toMatchObject({ tenantId, projectId: PROJECT_ID, userId: 'user-42', source: 'api' });
  });

  it('runtime-context headers are sealed at rest, opened for the turn, and erased at finalize', async () => {
    let seenRuntime: unknown;
    hoisted.executeAgentChatLocal.mockImplementation(async (request: { runtimeContext?: unknown }) => {
      seenRuntime = request.runtimeContext;
      return fakeResponse('resp_x');
    });
    const runtimeContext = { headers: { authorization: 'Bearer downstream-secret-token' } };
    const run = await createRun('conv-runtime', { runtimeContext: runtimeContext as never });

    const stored = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(JSON.stringify(stored?.runtimeContext)).not.toContain('downstream-secret-token');
    expect(stored?.runtimeContext).toHaveProperty('sealed');

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(seenRuntime).toEqual(runtimeContext);
    const finalized = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(finalized?.status).toBe('succeeded');
    expect(finalized?.runtimeContext ?? null).toBeNull();
  });

  it('the callback secret is sealed at rest, never stored or serialized in plaintext', async () => {
    const run = await createRun('conv-secret', {
      callbackUrl: 'https://hooks.example.com/run',
      callbackSecret: 'plain-callback-secret-123',
    });
    const stored = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(stored?.callbackSecret).toBeTruthy();
    expect(stored?.callbackSecret).not.toContain('plain-callback-secret-123');
  });

  it('a heartbeat that finds the row no longer ours (reconciler failed it) stops the turn instead of letting it finish', async () => {
    let seenCell: { cancelled: boolean } | undefined;
    let resolveInvoke: (value: unknown) => void;
    hoisted.executeAgentChatLocal.mockImplementation((request: { cancellationCell?: { cancelled: boolean } }) => {
      seenCell = request.cancellationCell;
      return new Promise((resolve) => { resolveInvoke = resolve; });
    });
    const run = await createRun('conv-superseded');
    const job = runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    await delay(30);

    // The reconciler declared it lost (its CAS on `running`), so the worker's
    // next heartbeat CAS matches nothing.
    await db.finalizeAgentRun(String(run._id), tenantId, { status: 'failed', errorReason: 'worker_lost', completedAt: new Date() });

    await job; // settles once the (1s) heartbeat observes the loss
    expect(seenCell?.cancelled).toBe(true);
    resolveInvoke!(fakeResponse('resp_late'));
    const after = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(after?.status).toBe('failed');
    expect(after?.errorReason).toBe('worker_lost');
  }, 10_000);
});
