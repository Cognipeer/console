/**
 * Group D (docs/guide/agent-background-execution.md §13) — synchronous
 * hard timeout.
 *
 * `runSyncAgentTurn` (agentRunService.ts) is exercised against a REAL
 * SQLite provider (so the single-active-run partial-unique-index guard,
 * §12.14, is genuinely exercised, not mocked) with only `executeAgentChat`
 * itself faked — this test is about the RACE/reservation orchestration in
 * `runSyncAgentTurn`, not the SDK invocation pipeline (already covered by
 * `agent-chat-cancellation-cell.test.ts` and the promoted spike).
 *
 * DoD (plan.md Group D): a deliberately slow `executeAgentChat` proves the
 * handler returns `504`/`timeout` at the deadline, not when the slow call
 * eventually finishes; a second request against the same conversation gets
 * `409`/`conflict` while the first is in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  executeAgentChat: vi.fn(),
  getDatabase: vi.fn(),
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
import { runSyncAgentTurn, createBackgroundAgentRun } from '@/lib/services/agents/agentRunService';

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
  process.env.AGENT_SYNC_TIMEOUT_MS = '60';
  reloadConfig();
});

afterEach(async () => {
  delete process.env.AGENT_SYNC_TIMEOUT_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runSyncAgentTurn — hard wall-clock ceiling (§5)', () => {
  it('returns timeout at the deadline, not when the slow call eventually finishes', async () => {
    hoisted.executeAgentChat.mockImplementation(async () => {
      await delay(400);
      return { id: 'resp_conv-1', object: 'response', model: AGENT_KEY, output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null };
    });

    const startedAt = Date.now();
    const outcome = await runSyncAgentTurn({ request: baseRequest('conv-timeout') });
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.kind).toBe('timeout');
    // Well under the slow call's 400ms — proves the deadline timer won the
    // race rather than the handler waiting for the slow call to settle.
    expect(elapsedMs).toBeLessThan(300);
  });

  it('deletes the sync reservation row on timeout, freeing the conversation for a new request', async () => {
    hoisted.executeAgentChat.mockImplementation(async () => {
      await delay(400);
      return { id: 'resp_x', object: 'response', model: AGENT_KEY, output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null };
    });

    await runSyncAgentTurn({ request: baseRequest('conv-freed') });
    expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
  });

  it('a second sync request against the same conversation gets a conflict while the first is in flight', async () => {
    hoisted.executeAgentChat.mockImplementation(async () => {
      await delay(150);
      return { id: 'resp_x', object: 'response', model: AGENT_KEY, output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null };
    });
    process.env.AGENT_SYNC_TIMEOUT_MS = '5000';
    reloadConfig();

    const conversationId = 'conv-conflict';
    const firstPromise = runSyncAgentTurn({ request: baseRequest(conversationId) });
    await delay(20); // let the first call's reservation land before racing the second

    const secondOutcome = await runSyncAgentTurn({ request: baseRequest(conversationId) });
    expect(secondOutcome.kind).toBe('conflict');

    const firstOutcome = await firstPromise;
    expect(firstOutcome.kind).toBe('ok');
  });

  it('a background request against a conversation with an in-flight sync run also gets a conflict (§12.14)', async () => {
    hoisted.executeAgentChat.mockImplementation(async () => {
      await delay(150);
      return { id: 'resp_x', object: 'response', model: AGENT_KEY, output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null };
    });
    process.env.AGENT_SYNC_TIMEOUT_MS = '5000';
    reloadConfig();

    const conversationId = 'conv-cross-mode-conflict';
    const firstPromise = runSyncAgentTurn({ request: baseRequest(conversationId) });
    await delay(20);

    const backgroundOutcome = await createBackgroundAgentRun({
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
