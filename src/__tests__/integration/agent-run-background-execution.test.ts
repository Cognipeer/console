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
  executeAgentResumeLocal: vi.fn(),
  executeAgentContinueLocal: vi.fn(),
  getDatabase: vi.fn(),
  publish: vi.fn(),
  getUserAuthState: vi.fn(),
}));

// The owner-state lookup resolves its own database via the barrel's internal
// getDatabase (which the mock below cannot rebind), so stub it here; the
// default is an active owner.
vi.mock('@/lib/services/users/userAuthState', () => ({
  getUserAuthState: hoisted.getUserAuthState,
}));

// Observe run/callback jobs instead of pushing them into a real queue whose
// consumer would race the explicit runAgentJobLocal calls below.
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish: hoisted.publish })),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: vi.fn(),
  executeAgentChatLocal: hoisted.executeAgentChatLocal,
  executeAgentResumeLocal: hoisted.executeAgentResumeLocal,
  executeAgentContinueLocal: hoisted.executeAgentContinueLocal,
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
  AGENT_RUN_CALLBACK_QUEUE,
  runAgentJobLocal,
  getAgentRunStatus,
  requestAgentRunCancellation,
  serializeAgentRun,
  AGENT_RUN_DEFERRED_QUEUE,
  cancelAgentRun,
  drainLocalAgentRuns,
  queueAgentRunContinue,
  queueAgentRunResume,
  startAgentRun,
  type StartAgentRunInput,
} from '@/lib/services/agents/agentRunService';
import { queueAgentRun } from '../helpers/agent-runs';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
import { clearServiceAvailabilityMemo, isServiceDisabledError } from '@/lib/services/availability/serviceAvailability';

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
  hoisted.getUserAuthState.mockResolvedValue('active');
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
  delete process.env.AGENT_DEFERRED_MAX_RUNNING_PER_TENANT;
  delete process.env.AGENT_DEFERRED_MAX_QUEUED_PER_TENANT;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createRun(
  conversationId: string,
  overrides: Partial<Parameters<typeof queueAgentRun>[0]> = {},
) {
  const outcome = await queueAgentRun({
    tenantId,
    tenantDbName: dbName,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId,
    userMessage: 'hello',
    userId: 'user-1',
    ...overrides,
  });
  if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`);
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
    // The agent is named the way every agent surface names it, not by its display name.
    expect((finalStatus?.result as { model?: string } | null)?.model).toMatch(/^agent:/);
  });

  it('records how the turn ended: end_turn, and a limit stop still finalizes succeeded with stopReason limit', async () => {
    hoisted.executeAgentChatLocal.mockResolvedValueOnce({ ...fakeResponse('resp_a'), stop_reason: 'completed' });
    const completed = await createRun('conv-stop-end');
    await runAgentJobLocal({ runId: String(completed._id), tenantId, tenantDbName: dbName });
    const endTurn = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(completed._id));
    expect(endTurn?.status).toBe('succeeded');
    expect(endTurn?.stopReason).toBe('end_turn');

    hoisted.executeAgentChatLocal.mockResolvedValueOnce({
      ...fakeResponse('resp_b'), status: 'incomplete', stop_reason: 'limit', stop_detail: 'maxWallClockMs (1000ms) exceeded',
    });
    const limited = await createRun('conv-stop-limit');
    await runAgentJobLocal({ runId: String(limited._id), tenantId, tenantDbName: dbName });
    const stopped = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(limited._id));
    expect(stopped?.status).toBe('succeeded'); // unchanged: old SDK clients poll for terminal states
    expect(stopped?.stopReason).toBe('limit');
  });

  it('a failed run records stopReason error', async () => {
    hoisted.executeAgentChatLocal.mockRejectedValueOnce(new Error('model exploded'));
    const run = await createRun('conv-stop-error');
    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    const failed = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(failed?.status).toBe('failed');
    expect(failed?.stopReason).toBe('error');
  });

  it('a second background request against the same conversation gets a conflict while the first is queued/running', async () => {
    hoisted.executeAgentChatLocal.mockImplementation(() => new Promise(() => undefined));

    await createRun('conv-conflict');
    const second = await queueAgentRun({
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
      limits: { syncWaitMs: 60_000, maxDurationMs: 40, maxActivePerTenant: 0, maxActivePerProject: 0 },
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
      limits: { syncWaitMs: 60_000, maxDurationMs: 3_600_000, maxActivePerTenant: 0, maxActivePerProject: 0 },
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

    const callbackJobs = hoisted.publish.mock.calls.filter(([queue, name]) => queue === AGENT_RUN_CALLBACK_QUEUE && name === 'callback');
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
    const callbackJobs = hoisted.publish.mock.calls.filter(([queue, name]) => queue === AGENT_RUN_CALLBACK_QUEUE && name === 'callback');
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

  it('a run whose owner was disabled after submit fails owner_disabled without invoking, and still fires the failure callback', async () => {
    const run = await createRun('conv-disabled-owner');
    hoisted.getUserAuthState.mockResolvedValue('disabled');

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.getUserAuthState).toHaveBeenCalledWith(dbName, tenantId, 'user-1');
    expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.errorReason).toBe('owner_disabled');
    expect(finalStatus?.errorMessage).toBe('Run owner is disabled');
  });

  it('a run whose owner has no user row (synthetic actor) is NOT blocked', async () => {
    hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_synthetic'));
    const run = await createRun('conv-synthetic-owner');
    hoisted.getUserAuthState.mockResolvedValue('missing');

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.executeAgentChatLocal).toHaveBeenCalledTimes(1);
    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id)))?.status).toBe('succeeded');
  });

  it('an unreadable owner state fails the run closed (owner_unverifiable) without invoking', async () => {
    const run = await createRun('conv-unreadable-owner');
    hoisted.getUserAuthState.mockRejectedValue(new Error('db blip'));

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.errorReason).toBe('owner_unverifiable');
  });

  it.each(['system:trigger:trg1', 'a2a-public'])('synthetic actor %s skips the owner lookup entirely', async (actor) => {
    hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_actor'));
    hoisted.getUserAuthState.mockRejectedValue(new Error('would throw on a non-ObjectId'));
    const run = await createRun(`conv-${actor}`, { userId: actor });

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    expect(hoisted.getUserAuthState).not.toHaveBeenCalled();
    expect(hoisted.executeAgentChatLocal).toHaveBeenCalledTimes(1);
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

describe('structured output through a background run', () => {
  const callbackJobs = () => hoisted.publish.mock.calls.filter(([queue, name]) => queue === AGENT_RUN_CALLBACK_QUEUE && name === 'callback');

  it('persists output_parsed on the run, serializes it in the status envelope, and carries it in the callback', async () => {
    const run = await createRun('conv-structured-ok', { callbackUrl: 'https://hooks.example.com/run' });
    const parsed = { verdict: 'bug', confidence: 0.9 };
    hoisted.executeAgentChatLocal.mockResolvedValue({
      ...fakeResponse('resp_conv'),
      output_parsed: parsed,
      _conversation_messages: [{ role: 'user', content: 'x', timestamp: new Date() }],
    });
    hoisted.publish.mockClear();

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    const stored = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(stored?.status).toBe('succeeded');
    const envelope = serializeAgentRun(stored!);
    expect(envelope.result).toMatchObject({ id: `resp_${run._id}`, output_parsed: parsed });
    expect(envelope.result).not.toHaveProperty('output_error');
    expect(envelope.result).not.toHaveProperty('_conversation_messages');

    expect(callbackJobs()).toHaveLength(1);
    expect(callbackJobs()[0][2]).toMatchObject({
      event: 'succeeded',
      data: { result: { id: `resp_${run._id}`, output_parsed: parsed } },
    });
  });

  it('a structured-output failure is a succeeded run whose result carries output_error', async () => {
    const run = await createRun('conv-structured-bad', { callbackUrl: 'https://hooks.example.com/run' });
    hoisted.executeAgentChatLocal.mockResolvedValue({
      ...fakeResponse('resp_conv'),
      output_error: 'verdict is required',
    });
    hoisted.publish.mockClear();

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    const stored = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    const envelope = serializeAgentRun(stored!);
    expect(envelope.status).toBe('succeeded');
    expect(envelope.error).toBeNull();
    expect(envelope.result).toMatchObject({ output_error: 'verdict is required' });
    expect(envelope.result).not.toHaveProperty('output_parsed');
    expect(callbackJobs()[0][2]).toMatchObject({ event: 'succeeded', data: { result: { output_error: 'verdict is required' } } });
  });

  it('a plain-text run (no structured output) is unchanged: neither field appears', async () => {
    const run = await createRun('conv-plain', { callbackUrl: 'https://hooks.example.com/run' });
    hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_conv'));
    hoisted.publish.mockClear();

    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

    const envelope = serializeAgentRun((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id)))!);
    expect(envelope.result).not.toHaveProperty('output_parsed');
    expect(envelope.result).not.toHaveProperty('output_error');
    expect(envelope.result).toMatchObject({ output: [], status: 'completed' });
  });
});

describe('queued runs through startAgentRun (§4.3–§4.8)', () => {
  const ref = (run: { _id?: unknown }) => ({ tenantDbName: dbName, tenantId, projectId: PROJECT_ID, runId: String(run._id) });
  const runJobs = (queue: string) => hoisted.publish.mock.calls.filter(([q, name]) => q === queue && (name === 'run' || name === 'resume'));

  function queuedInput(conversationId: string, overrides: Partial<StartAgentRunInput> = {}): StartAgentRunInput {
    return {
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      conversationId,
      userMessage: 'hello',
      userId: 'user-1',
      channel: 'runs',
      execution: { kind: 'queued' },
      ...overrides,
    };
  }

  async function startQueued(conversationId: string, overrides: Partial<StartAgentRunInput> = {}) {
    const outcome = await startAgentRun(queuedInput(conversationId, overrides));
    if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`);
    return outcome.run;
  }

  it('a run starting more than a second ahead is a scheduled row: not published, and cancel ends it at once', async () => {
    const run = await startQueued('conv-scheduled', { execution: { kind: 'queued', notBefore: new Date(Date.now() + 60_000) } });
    expect(run.status).toBe('scheduled');
    expect(runJobs(AGENT_RUN_QUEUE)).toHaveLength(0);

    const outcome = await cancelAgentRun(ref(run));
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    expect(outcome.run).toMatchObject({ status: 'canceled', errorReason: 'canceled_by_caller' });
  });

  it('a default-class queued run is published on agent-runs with the generation dedup key', async () => {
    const run = await startQueued('conv-default-queued');
    expect(run).toMatchObject({ status: 'queued', mode: 'background', runClass: 'default' });
    const jobs = runJobs(AGENT_RUN_QUEUE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0][3]).toMatchObject({ dedupKey: `ar_${String(run._id)}_1` });
  });

  it('deferred runs go to their own queue through the dispatcher and are capped per tenant while waiting', async () => {
    process.env.AGENT_DEFERRED_MAX_QUEUED_PER_TENANT = '1';
    reloadConfig();
    const first = await startQueued('conv-deferred-1', { runClass: 'deferred' });
    expect(first.runClass).toBe('deferred');
    expect(runJobs(AGENT_RUN_DEFERRED_QUEUE).map(([, , payload]) => payload)).toEqual([
      expect.objectContaining({ runId: String(first._id), runClass: 'deferred' }),
    ]);
    expect(runJobs(AGENT_RUN_QUEUE)).toHaveLength(0);

    const second = await startAgentRun(queuedInput('conv-deferred-2', { runClass: 'deferred' }));
    expect(second).toMatchObject({ kind: 'concurrency_limit', limit: 1, scope: 'tenant', runClass: 'deferred' });
    expect(await db.listAgentRuns({ tenantId, projectId: PROJECT_ID, conversationId: 'conv-deferred-2' })).toHaveLength(0);
  });

  it('the deferred claim guard leaves the run queued while the class is at its running cap', async () => {
    process.env.AGENT_DEFERRED_MAX_RUNNING_PER_TENANT = '1';
    reloadConfig();
    const busy = await startQueued('conv-deferred-busy', { runClass: 'deferred' });
    await db.claimAgentRun(String(busy._id), tenantId, 'other-node', new Date());
    const waiting = await startQueued('conv-deferred-waiting', { runClass: 'deferred' });

    await runAgentJobLocal({ runId: String(waiting._id), tenantId, tenantDbName: dbName, runClass: 'deferred' });

    expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(waiting._id)))?.status).toBe('queued');
  });

  it('cancel of a running run stamps cancelRequestedAt and leaves it running for the executor to stop', async () => {
    const run = await startQueued('conv-cancel-running');
    await db.claimAgentRun(String(run._id), tenantId, 'other-node', new Date());

    const outcome = await cancelAgentRun(ref(run));
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    expect(outcome.run.status).toBe('running');
    expect(outcome.run.cancelRequestedAt).toBeInstanceOf(Date);
  });

  it('cancel of a requires_action run settles it canceled and frees the conversation', async () => {
    const run = await startQueued('conv-cancel-paused');
    await db.claimAgentRun(String(run._id), tenantId, 'other-node', new Date());
    await db.finalizeAgentRun(String(run._id), tenantId, { status: 'requires_action', stopReason: 'requires_action' });

    const outcome = await cancelAgentRun(ref(run));
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    expect(outcome.run).toMatchObject({ status: 'canceled', errorReason: 'canceled_by_caller' });
    expect((await startAgentRun(queuedInput('conv-cancel-paused'))).kind).toBe('accepted');
  });

  it('a finished run cannot be cancelled', async () => {
    const run = await startQueued('conv-cancel-done');
    await db.claimAgentRun(String(run._id), tenantId, 'other-node', new Date());
    await db.finalizeAgentRun(String(run._id), tenantId, { status: 'succeeded', completedAt: new Date() });
    expect((await cancelAgentRun(ref(run))).kind).toBe('already_terminal');
  });

  it('a conversation Stop goes through cancelAgentRun: a queued run is canceled, a paused one settled', async () => {
    const queued = await startQueued('conv-stop-queued');
    const stopQueued = await cancelConversationTurn({ tenantDbName: dbName, tenantId, projectId: PROJECT_ID, conversationId: 'conv-stop-queued' });
    expect(stopQueued.runIds).toEqual([String(queued._id)]);
    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(queued._id)))?.status).toBe('canceled');

    const paused = await startQueued('conv-stop-paused');
    await db.claimAgentRun(String(paused._id), tenantId, 'other-node', new Date());
    await db.finalizeAgentRun(String(paused._id), tenantId, { status: 'requires_action', stopReason: 'requires_action' });

    // A caller that may not answer approvals leaves the paused run alone.
    const limited = await cancelConversationTurn({ tenantDbName: dbName, tenantId, projectId: PROJECT_ID, conversationId: 'conv-stop-paused', cancelActions: false });
    expect(limited.cancelled).toBe(false);
    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(paused._id)))?.status).toBe('requires_action');

    const full = await cancelConversationTurn({ tenantDbName: dbName, tenantId, projectId: PROJECT_ID, conversationId: 'conv-stop-paused' });
    expect(full).toMatchObject({ cancelled: true, runIds: [String(paused._id)], cancelledActions: true });
    expect((await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(paused._id)))?.status).toBe('canceled');
  });

  it('resuming a paused run requeues the same row with its class, channel, metadata, format and variables, under a new generation', async () => {
    const run = await startQueued('conv-resume', {
      metadata: { order: '42' },
      responseFormat: { type: 'json_object' },
      variables: { locale: 'tr' },
    });
    await db.claimAgentRun(String(run._id), tenantId, 'other-node', new Date());
    await db.finalizeAgentRun(String(run._id), tenantId, { status: 'requires_action', stopReason: 'requires_action' });
    hoisted.publish.mockClear();

    const outcome = await queueAgentRunResume({
      tenantDbName: dbName,
      tenantId,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      conversationId: 'conv-resume',
      userId: 'user-1',
      resumeActionIds: ['act_1'],
      ownerRunId: String(run._id),
    });
    expect(outcome.kind).toBe('queued');
    if (outcome.kind !== 'queued') return;
    expect(String(outcome.run._id)).toBe(String(run._id));
    expect(outcome.run).toMatchObject({
      status: 'queued',
      runClass: 'default',
      channel: 'runs',
      metadata: { order: '42' },
      responseFormat: { type: 'json_object' },
      variables: { locale: 'tr' },
      queueGeneration: 2,
    });
    const jobs = runJobs(AGENT_RUN_QUEUE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0][1]).toBe('resume');
    expect(jobs[0][3]).toMatchObject({ dedupKey: `ar_${String(run._id)}_2` });
  });

  describe('a trigger run with external content (§2.4a): what came from the event never reaches the system prompt', () => {
    // `region` is written in the trigger itself (a literal name); `ticket` came out of the event.
    const triggerRun = {
      userId: 'system:trigger:trg1', actorType: 'system' as const, channel: 'trigger' as const, triggerId: 'trg1', trigger: 'schedule' as const,
      unattended: true, externalContent: true, variables: { region: 'eu', ticket: 'T-1' }, literalVariables: ['region'],
    };
    const jobOf = (runId: string) => hoisted.publish.mock.calls.find(([, name, payload]) => (name === 'run' || name === 'resume') && (payload as { runId: string }).runId === runId)?.[2] as Parameters<typeof runAgentJobLocal>[0];

    it('the first turn runs unattended; the prompt may read only the literal names, the rest stays in the message', async () => {
      hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_first'));
      const run = await startQueued('conv-ext-first', triggerRun);
      await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
      expect(hoisted.executeAgentChatLocal).toHaveBeenCalledWith(expect.objectContaining({
        unattended: true, externalContent: true, variablesInPrompt: false, variables: { region: 'eu', ticket: 'T-1' }, literalVariables: ['region'],
      }));
    });

    it('a paused one resumed by the worker continues with variablesInPrompt false', async () => {
      const run = await startQueued('conv-ext-resume', triggerRun);
      await db.claimAgentRun(String(run._id), tenantId, 'other-node', new Date());
      await db.finalizeAgentRun(String(run._id), tenantId, { status: 'requires_action', stopReason: 'requires_action' });
      hoisted.publish.mockClear();
      hoisted.executeAgentResumeLocal.mockResolvedValue({ response: fakeResponse('resp_resumed') });

      const outcome = await queueAgentRunResume({
        tenantDbName: dbName, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: 'conv-ext-resume',
        userId: 'system:trigger:trg1', resumeActionIds: ['act_1'], ownerRunId: String(run._id),
      });
      expect(outcome.kind).toBe('queued');
      if (outcome.kind !== 'queued') return;
      expect(outcome.run).toMatchObject({ unattended: true, externalContent: true, triggerId: 'trg1', literalVariables: ['region'] });
      await runAgentJobLocal(jobOf(String(run._id)));

      expect(hoisted.executeAgentResumeLocal).toHaveBeenCalledTimes(1);
      expect(hoisted.executeAgentResumeLocal.mock.calls[0][0]).toMatchObject({
        variablesInPrompt: false, unattended: true, variables: { region: 'eu', ticket: 'T-1' }, literalVariables: ['region'],
      });
    });

    it('a budget continuation (no paused run) copies the trigger, flags and variables from the session\'s last run', async () => {
      hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_budget_first'));
      const run = await startQueued('conv-ext-continue', triggerRun);
      await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
      hoisted.publish.mockClear();
      hoisted.executeAgentContinueLocal.mockResolvedValue({ response: fakeResponse('resp_continued') });

      const outcome = await queueAgentRunContinue({
        tenantDbName: dbName, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: 'conv-ext-continue', userId: 'user-1',
      });
      expect(outcome.kind).toBe('queued');
      if (outcome.kind !== 'queued') return;
      expect(String(outcome.run._id)).not.toBe(String(run._id));
      expect(outcome.run).toMatchObject({
        triggerId: 'trg1', channel: 'trigger', trigger: 'schedule', unattended: true, externalContent: true,
        variables: { region: 'eu', ticket: 'T-1' }, literalVariables: ['region'],
      });
      await runAgentJobLocal(jobOf(String(outcome.run._id)));

      expect(hoisted.executeAgentContinueLocal).toHaveBeenCalledTimes(1);
      expect(hoisted.executeAgentContinueLocal.mock.calls[0][0]).toMatchObject({
        variablesInPrompt: false, unattended: true, variables: { region: 'eu', ticket: 'T-1' }, literalVariables: ['region'],
      });
    });

    it('an ordinary run keeps its variables in the prompt (nothing is turned off by default)', async () => {
      hoisted.executeAgentChatLocal.mockResolvedValue(fakeResponse('resp_plain'));
      const run = await startQueued('conv-plain-variables', { variables: { region: 'eu' } });
      await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
      const request = hoisted.executeAgentChatLocal.mock.calls[0][0];
      expect(request.variablesInPrompt).toBeUndefined();
      expect(request.unattended).toBeUndefined();
      expect(request.literalVariables).toBeUndefined();
    });
  });

  it('the shutdown drain waits for local runs, then fails the ones still going as interrupted', async () => {
    hoisted.executeAgentChatLocal.mockImplementation(() => new Promise(() => undefined));
    const run = await startQueued('conv-drain');
    const job = runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    // Executing: claimed, preconditions passed, the turn invoked.
    await vi.waitFor(() => {
      expect(hoisted.executeAgentChatLocal).toHaveBeenCalledTimes(1);
    });

    const drained = await drainLocalAgentRuns(50);

    expect(drained).toEqual({ settled: 0, interrupted: 1 });
    expect(await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id))).toMatchObject({
      status: 'failed',
      errorReason: 'interrupted',
      stopReason: 'error',
    });
    await job;
  });
  describe('the agents service switched off', () => {
    /** Runs `fn` with the agents service off for the deployment, and puts the environment back. */
    async function withAgentsOff<T>(fn: () => Promise<T>): Promise<T> {
      process.env.CONSOLE_DISABLED_SERVICES = 'agents';
      reloadConfig();
      clearServiceAvailabilityMemo();
      try {
        return await fn();
      } finally {
        delete process.env.CONSOLE_DISABLED_SERVICES;
        reloadConfig();
        clearServiceAvailabilityMemo();
      }
    }

    it('a queued run of such a tenant fails service_disabled at the worker, without invoking, and is not retried', async () => {
      const run = await createRun('conv-agents-off');

      await withAgentsOff(() => runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName }));

      expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
      expect(await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id))).toMatchObject({
        status: 'failed',
        errorReason: 'service_disabled',
        stopReason: 'error',
      });
      // A second delivery of the same job finds a finished run and leaves it alone.
      await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
      expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
    });

    it('a new run, a resume and a continue are refused before anything is queued', async () => {
      await withAgentsOff(async () => {
        const started = await startAgentRun({
          tenantId, tenantDbName: dbName, projectId: PROJECT_ID, agentKey: AGENT_KEY,
          conversationId: 'conv-agents-off-start', userMessage: 'hello', userId: 'user-1',
          channel: 'runs', execution: { kind: 'queued' },
        }).catch((error) => error);
        expect(isServiceDisabledError(started)).toBe(true);
        expect(started).toMatchObject({ status: 403, code: 'service_disabled', service: 'agents' });

        const resumeInput = {
          tenantId, tenantDbName: dbName, projectId: PROJECT_ID, agentKey: AGENT_KEY,
          conversationId: 'conv-agents-off-resume', userId: 'user-1',
        };
        expect(isServiceDisabledError(await queueAgentRunResume({ ...resumeInput, resumeActionIds: ['a1'] }).catch((e) => e))).toBe(true);
        expect(isServiceDisabledError(await queueAgentRunContinue(resumeInput).catch((e) => e))).toBe(true);
      });
      expect(hoisted.publish).not.toHaveBeenCalled();
    });

    it('a run whose precondition check cannot be made fails closed instead of executing', async () => {
      const run = await createRun('conv-precondition-unreadable');
      vi.spyOn(db, 'findAgentByKey').mockRejectedValue(new Error('db blip'));

      await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });

      expect(hoisted.executeAgentChatLocal).not.toHaveBeenCalled();
      expect(await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id))).toMatchObject({
        status: 'failed',
        errorReason: 'precondition_failed',
      });
    });
  });
});
