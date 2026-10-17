/**
 * Inline runs (§4.2): a synchronous call is a recorded `inline` run that
 * waits up to its window and then DETACHES (the call answers 202, the run
 * keeps going and notifies when it ends) instead of failing at the window.
 *
 * `startAgentRun` with inline execution (agentRunService.ts) is exercised against a REAL
 * SQLite provider (so the single-active-run partial-unique-index guard,
 * §12.14, is genuinely exercised, not mocked) with only `executeAgentChat`
 * itself faked — this test is about the RACE/reservation orchestration in
 * the inline run, not the SDK invocation pipeline (already covered by
 * `agent-chat-cancellation-cell.test.ts` and the promoted spike).
 *
 * A deliberately slow `executeAgentChat` proves the call returns `detached`
 * at the window, not when the slow call eventually finishes; the run is
 * finalized when the turn settles; a second request against the same
 * conversation gets `409`/`conflict` while the first is in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  executeAgentChat: vi.fn(),
  getDatabase: vi.fn(),
  publish: vi.fn(),
  publishWebhookEvent: vi.fn(),
}));

// Observe callback jobs and webhook events (notifications are for async runs only).
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish: hoisted.publish })),
}));

vi.mock('@/lib/services/webhooks/webhookService', () => ({
  publishWebhookEvent: hoisted.publishWebhookEvent,
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: hoisted.executeAgentChat,
  executeAgentChatLocal: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

import { getDatabase } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import {
  AGENT_RUN_CALLBACK_QUEUE,
  startAgentRun,
  type AgentRunLimits,
  type StartAgentRunInput,
} from '@/lib/services/agents/agentRunService';
import { toAgentResponseObject } from '@/server/api/plugins/agent-response-object';
import { queueAgentRun } from '../helpers/agent-runs';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_sync_ceiling';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-agent';

function baseRequest(conversationId: string) {
  return {
    tenantDbName: dbName,
    tenantId,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId,
    userMessage: 'hello',
    userId: 'user-1',
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-run-sync-ceiling-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme',
    slug: 'acme-sync',
    dbName,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.publishWebhookEvent.mockResolvedValue(undefined);
  // The env ceiling is clamped to >= 5s; the per-call effective ceiling
  // (resolveAgentRunLimits' min) is what these tests shorten.
  process.env.AGENT_SYNC_TIMEOUT_MS = '5000';
  reloadConfig();
});

afterEach(async () => {
  delete process.env.AGENT_SYNC_TIMEOUT_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

const okResponse = (id: string) => ({ id, object: 'response', model: AGENT_KEY, output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null });

const callbackJobs = () => hoisted.publish.mock.calls.filter(([queue, name]) => queue === AGENT_RUN_CALLBACK_QUEUE && name === 'callback');

function inlineInput(conversationId: string, execution: Partial<Extract<StartAgentRunInput['execution'], { kind: 'inline' }>> = {}): StartAgentRunInput {
  return {
    ...baseRequest(conversationId),
    channel: 'responses',
    callback: { url: 'https://hooks.example.com/runs' },
    execution: { kind: 'inline', waitMs: 60, cancelOnDisconnect: false, ...execution },
    limits: { syncWaitMs: 60, maxDurationMs: 60_000, maxActivePerTenant: 0, maxActivePerProject: 0 },
  };
}

/** A plain synchronous API turn: an inline run waiting `waitMs` (the env window by default). */
function syncTurn(conversationId: string, waitMs = 5_000, limits?: AgentRunLimits) {
  return startAgentRun({
    ...baseRequest(conversationId),
    channel: 'responses',
    execution: { kind: 'inline', waitMs, cancelOnDisconnect: false },
    ...(limits ? { limits } : {}),
  });
}

describe('inline run — wait window and detach (§4.2)', () => {
  it('detaches at the window, not when the slow call eventually finishes', async () => {
    hoisted.executeAgentChat.mockImplementation(async () => {
      await delay(400);
      return okResponse('resp_conv-1');
    });

    const startedAt = Date.now();
    const outcome = await syncTurn('conv-timeout', 60);
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.kind).toBe('detached');
    // Well under the slow call's 400ms: the window won the race.
    expect(elapsedMs).toBeLessThan(300);
    if (outcome.kind !== 'detached') return;
    expect(outcome.run.mode).toBe('inline');
    expect(outcome.run.status).toBe('running');
    expect(outcome.run.detachedAt).toBeInstanceOf(Date);

    // The run keeps going and is finalized when the turn settles.
    await vi.waitFor(async () => {
      const row = await db.getAgentRunById(String(outcome.run._id), tenantId, PROJECT_ID);
      expect(row?.status).toBe('succeeded');
    }, { timeout: 2_000 });
    expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
  });

  it('a detached run holds the conversation until its turn settles, and its cell is bounded by the run ceiling, not the window', async () => {
    let finishTurn!: () => void;
    let seenCell: { cancelled?: boolean; deadlineAt?: number } | undefined;
    hoisted.executeAgentChat.mockImplementation(async (request: { cancellationCell?: { cancelled?: boolean; deadlineAt?: number } }) => {
      seenCell = request.cancellationCell;
      await new Promise<void>((resolve) => { finishTurn = resolve; });
      return okResponse('resp_x');
    });

    const startedAt = Date.now();
    const outcome = await syncTurn('conv-held', 60, { syncWaitMs: 60, maxDurationMs: 60_000, maxActivePerTenant: 0, maxActivePerProject: 0 });
    expect(outcome.kind).toBe('detached');

    // The turn is not cancelled by the window; its deadline is the run's ceiling.
    expect(seenCell?.cancelled).toBe(false);
    expect(seenCell?.deadlineAt).toBeGreaterThanOrEqual(startedAt + 60_000);

    // Still running: another turn on this conversation is refused.
    expect(await db.countActiveAgentRuns(tenantId, PROJECT_ID, { mode: 'inline' })).toBe(1);
    const callsBefore = hoisted.executeAgentChat.mock.calls.length;
    const meanwhile = await syncTurn('conv-held', 60);
    expect(meanwhile.kind).toBe('conflict');
    expect(hoisted.executeAgentChat.mock.calls.length).toBe(callsBefore);

    finishTurn();
    await vi.waitFor(async () => {
      expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
    });
  });

  it('a detached turn that REJECTS later is finalized failed/agent_error and frees the conversation', async () => {
    let failTurn!: (error: Error) => void;
    hoisted.executeAgentChat.mockImplementation(() => new Promise((_, reject) => { failTurn = reject; }));

    const outcome = await syncTurn('conv-held-reject', 60);
    expect(outcome.kind).toBe('detached');
    expect(await db.countActiveAgentRuns(tenantId)).toBe(1);

    failTurn(new Error('provider unavailable'));
    await vi.waitFor(async () => {
      expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
    });
    if (outcome.kind !== 'detached') return;
    const row = await db.getAgentRunById(String(outcome.run._id), tenantId, PROJECT_ID);
    expect(row).toMatchObject({ status: 'failed', errorReason: 'agent_error' });
  });

  it('a turn that completes in time is recorded as a succeeded inline run before returning', async () => {
    hoisted.executeAgentChat.mockResolvedValue(okResponse('resp_ok'));

    const outcome = await syncTurn('conv-quick', 1_000);
    expect(outcome.kind).toBe('completed');
    expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
    if (outcome.kind !== 'completed') return;
    expect(outcome.run).toMatchObject({ mode: 'inline', status: 'succeeded' });
    expect(outcome.run.detachedAt ?? null).toBeNull();
  });

  it('a turn that throws before the window releases the conversation and rethrows', async () => {
    hoisted.executeAgentChat.mockRejectedValue(new Error('provider exploded'));

    await expect(syncTurn('conv-throw', 1_000)).rejects.toThrow('provider exploded');
    expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
  });

  it('a second sync request against the same conversation gets a conflict while the first is in flight', async () => {
    hoisted.executeAgentChat.mockImplementation(async () => {
      await delay(150);
      return { id: 'resp_x', object: 'response', model: AGENT_KEY, output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null };
    });
    const conversationId = 'conv-conflict';
    const firstPromise = syncTurn(conversationId);
    await delay(20); // let the first call's reservation land before racing the second

    const secondOutcome = await syncTurn(conversationId);
    expect(secondOutcome.kind).toBe('conflict');

    const firstOutcome = await firstPromise;
    expect(firstOutcome.kind).toBe('completed');
  });

  it('a background request against a conversation with an in-flight sync run also gets a conflict (§12.14)', async () => {
    hoisted.executeAgentChat.mockImplementation(async () => {
      await delay(150);
      return { id: 'resp_x', object: 'response', model: AGENT_KEY, output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null };
    });
    const conversationId = 'conv-cross-mode-conflict';
    const firstPromise = syncTurn(conversationId);
    await delay(20);

    const backgroundOutcome = await queueAgentRun({
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      conversationId,
      userMessage: 'hello',
      userId: 'user-1',
    });
    expect(backgroundOutcome.kind).toBe('conflict');

    await firstPromise;
  });
});

describe('startAgentRun — inline runs (§4.2)', () => {
  it('an answered turn sends no callback and no webhook event; a detached one notifies when it ends', async () => {
    hoisted.executeAgentChat.mockResolvedValue(okResponse('resp_quick'));
    const answered = await startAgentRun(inlineInput('conv-notify-quick', { waitMs: 1_000 }));
    expect(answered.kind).toBe('completed');
    expect(callbackJobs()).toHaveLength(0);
    expect(hoisted.publishWebhookEvent).not.toHaveBeenCalled();

    let finishTurn!: () => void;
    hoisted.executeAgentChat.mockImplementation(async () => {
      await new Promise<void>((resolve) => { finishTurn = resolve; });
      return okResponse('resp_slow');
    });
    const detached = await startAgentRun(inlineInput('conv-notify-slow'));
    expect(detached.kind).toBe('detached');
    expect(callbackJobs()).toHaveLength(0);

    finishTurn();
    await vi.waitFor(() => {
      expect(callbackJobs()).toHaveLength(1);
    });
    expect(callbackJobs()[0][2]).toMatchObject({ event: 'succeeded' });
    expect(hoisted.publishWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_run.succeeded',
      data: expect.objectContaining({ status: 'succeeded', class: 'default', metadata: {}, triggerId: null }),
    }));
  });

  it('a streaming caller has no wait window: the call returns when the turn ends', async () => {
    const chunks: string[] = [];
    hoisted.executeAgentChat.mockImplementation(async (request: { onTextChunk?: (chunk: string) => void }) => {
      await delay(150);
      request.onTextChunk?.('hello');
      return okResponse('resp_stream');
    });

    const outcome = await startAgentRun(inlineInput('conv-stream', {
      waitMs: 20,
      stream: { onTextChunk: (chunk: string) => { chunks.push(chunk); } },
    }));
    expect(outcome.kind).toBe('completed');
    expect(chunks).toEqual(['hello']);
    if (outcome.kind !== 'completed') return;
    expect(outcome.run.detachedAt ?? null).toBeNull();
  });

  it('a stream that asked for background reads back background: true (Responses object); a plain turn reads false', async () => {
    hoisted.executeAgentChat.mockResolvedValue(okResponse('resp_x'));
    const streamed = await startAgentRun({ ...inlineInput('conv-stream-bg', { stream: {} }), background: true });
    const plain = await syncTurn('conv-plain');
    if (streamed.kind !== 'completed' || plain.kind !== 'completed') throw new Error('expected completed turns');
    const streamedRow = (await db.getAgentRunById(String(streamed.run._id), tenantId, PROJECT_ID))!;
    const plainRow = (await db.getAgentRunById(String(plain.run._id), tenantId, PROJECT_ID))!;
    expect(streamedRow).toMatchObject({ mode: 'inline', status: 'succeeded', background: true });
    expect(toAgentResponseObject(streamedRow).background).toBe(true);
    expect(plainRow.background ?? false).toBe(false);
    expect(toAgentResponseObject(plainRow).background).toBe(false);
  });

  it('a disconnect with cancelOnDisconnect stops the turn and finalizes the run canceled', async () => {
    const controller = new AbortController();
    hoisted.executeAgentChat.mockImplementation((request: { signal?: AbortSignal }) => new Promise((resolve) => {
      request.signal?.addEventListener('abort', () => resolve(okResponse('resp_partial')), { once: true });
    }));

    const pending = startAgentRun(inlineInput('conv-disconnect-cancel', {
      stream: {},
      signal: controller.signal,
      cancelOnDisconnect: true,
    }));
    await delay(30);
    controller.abort();
    const outcome = await pending;
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.run).toMatchObject({ status: 'canceled', errorReason: 'canceled_by_caller' });
    expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
  });

  it('a disconnect without cancelOnDisconnect detaches: the run keeps going and notifies', async () => {
    const controller = new AbortController();
    let finishTurn!: () => void;
    hoisted.executeAgentChat.mockImplementation(async () => {
      await new Promise<void>((resolve) => { finishTurn = resolve; });
      return okResponse('resp_bg');
    });

    const pending = startAgentRun(inlineInput('conv-disconnect-continue', {
      stream: {},
      signal: controller.signal,
      cancelOnDisconnect: false,
    }));
    await delay(30);
    controller.abort();
    await vi.waitFor(async () => {
      const [row] = await db.listAgentRuns({ tenantId, projectId: PROJECT_ID, conversationId: 'conv-disconnect-continue' });
      expect(row?.detachedAt).toBeInstanceOf(Date);
      expect(row?.status).toBe('running');
    });

    finishTurn();
    const outcome = await pending;
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.run.status).toBe('succeeded');
    expect(callbackJobs()).toHaveLength(1);
  });

  it('an Idempotency-Key retry of an inline run replays the stored run instead of starting another turn', async () => {
    hoisted.executeAgentChat.mockResolvedValue(okResponse('resp_idem'));
    const first = await startAgentRun({ ...inlineInput('conv-idem', { waitMs: 1_000 }), idempotencyKey: 'key-1' });
    expect(first.kind).toBe('completed');
    const retry = await startAgentRun({ ...inlineInput('conv-idem', { waitMs: 1_000 }), idempotencyKey: 'key-1' });
    expect(retry.kind).toBe('replay');
    if (retry.kind !== 'replay' || first.kind !== 'completed') return;
    expect(String(retry.run._id)).toBe(String(first.run._id));
    expect(retry.run.status).toBe('succeeded');
    expect(hoisted.executeAgentChat).toHaveBeenCalledTimes(1);

    const different = await startAgentRun({ ...inlineInput('conv-idem', { waitMs: 1_000 }), userMessage: 'something else', idempotencyKey: 'key-1' });
    expect(different.kind).toBe('idempotency_conflict');
  });

  it('dashboard sync reservations and inline runs share one admission count (§4.1)', async () => {
    await db.createAgentRun({
      mode: 'sync',
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      conversationId: 'conv-dashboard',
      userMessage: 'hello',
      status: 'running',
      startedAt: new Date(),
      callbackAttempts: 0,
    });
    hoisted.executeAgentChat.mockResolvedValue(okResponse('resp_cap'));
    const capped = await startAgentRun({
      ...inlineInput('conv-capped'),
      limits: { syncWaitMs: 60, maxDurationMs: 60_000, maxActivePerTenant: 1, maxActivePerProject: 0 },
    });
    expect(capped).toMatchObject({ kind: 'concurrency_limit', limit: 1, scope: 'tenant', runClass: 'default' });
    expect(hoisted.executeAgentChat).not.toHaveBeenCalled();
    expect(await db.listAgentRuns({ tenantId, projectId: PROJECT_ID, conversationId: 'conv-capped' })).toHaveLength(0);
  });
});
