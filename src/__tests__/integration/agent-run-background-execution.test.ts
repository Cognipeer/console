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
import {
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
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '5000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '20';
  reloadConfig();
});

afterEach(async () => {
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createRun(conversationId: string) {
  const outcome = await createBackgroundAgentRun({
    tenantId,
    tenantDbName: dbName,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId,
    userMessage: 'hello',
    userId: 'user-1',
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

  it('a run that exceeds AGENT_BACKGROUND_MAX_DURATION_MS is finalized failed/max_duration_exceeded without waiting for invoke()', async () => {
    process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '40';
    reloadConfig();
    let resolveInvoke: (value: unknown) => void;
    hoisted.executeAgentChatLocal.mockImplementation(
      () => new Promise((resolve) => { resolveInvoke = resolve; }),
    );

    const run = await createRun('conv-max-duration');
    const startedAt = Date.now();
    await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: dbName });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(300);

    const finalStatus = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.errorReason).toBe('max_duration_exceeded');

    // The abandoned invoke() eventually "succeeding" afterwards must not
    // flip a `failed` run back to `succeeded` (finalize's CAS guards it).
    resolveInvoke!(fakeResponse(`resp_${run._id}`));
    await delay(20);
    const stillFailed = await getAgentRunStatus(dbName, tenantId, PROJECT_ID, String(run._id));
    expect(stillFailed?.status).toBe('failed');
  });
});
