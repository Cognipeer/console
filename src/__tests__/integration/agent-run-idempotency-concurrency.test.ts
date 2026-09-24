/**
 * Group H (docs/guide/agent-background-execution.md §13) — v1 minimum bar:
 * idempotency (§12.15) and concurrency cap (§12.8).
 *
 * Same harness as `agent-run-background-execution.test.ts`: a REAL SQLite
 * provider (so the idempotency-key lookup and concurrency count are
 * genuinely exercised, not mocked) with only `executeAgentChatLocal` faked.
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
import { createBackgroundAgentRun } from '@/lib/services/agents/agentRunService';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_idempotency';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-bot';

function baseInput(conversationId: string, overrides: Partial<Parameters<typeof createBackgroundAgentRun>[0]> = {}) {
  return {
    tenantId,
    tenantDbName: dbName,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId,
    userMessage: 'hello',
    userId: 'user-1',
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.executeAgentChatLocal.mockImplementation(() => new Promise(() => undefined));
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-run-idempotency-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme',
    slug: 'acme-idempotency',
    dbName,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_TENANT = '2';
  reloadConfig();
});

afterEach(async () => {
  delete process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_TENANT;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Idempotency-Key (§12.15)', () => {
  it('a repeated key with the same request body returns the existing run instead of creating a new one', async () => {
    const first = await createBackgroundAgentRun(baseInput('conv-1', { idempotencyKey: 'idem-a' }));
    expect(first.kind).toBe('created');

    const second = await createBackgroundAgentRun(baseInput('conv-1', { idempotencyKey: 'idem-a' }));
    expect(second.kind).toBe('idempotent_replay');
    if (first.kind === 'created' && second.kind === 'idempotent_replay') {
      expect(String(second.run._id)).toBe(String(first.run._id));
    }

    // Not a second run — the active-run slot was only ever claimed once.
    expect(await db.countActiveAgentRuns(tenantId)).toBe(1);
  });

  it('a repeated key with a DIFFERENT request body is a conflict, neither silently executed nor merged', async () => {
    const first = await createBackgroundAgentRun(baseInput('conv-1', { idempotencyKey: 'idem-b' }));
    expect(first.kind).toBe('created');

    const second = await createBackgroundAgentRun(
      baseInput('conv-1', { idempotencyKey: 'idem-b', userMessage: 'a completely different message' }),
    );
    expect(second.kind).toBe('idempotency_conflict');
  });

  it('two different keys for the same conversation are independent (the active-run index still governs conflicts)', async () => {
    const first = await createBackgroundAgentRun(baseInput('conv-2', { idempotencyKey: 'idem-c' }));
    expect(first.kind).toBe('created');

    const second = await createBackgroundAgentRun(baseInput('conv-2', { idempotencyKey: 'idem-d' }));
    // Same conversation, still active from the first request — §12.14's
    // single-active-run rule is a separate guard idempotency doesn't bypass.
    expect(second.kind).toBe('conflict');
  });

  it('REGRESSION: a retried "start a new conversation" request (different conversationId each time, no previous_response_id) still replays — the hash must not depend on the freshly-minted conversationId', async () => {
    // Mirrors the real client-agents.ts flow: with no previous_response_id,
    // a NEW conversation is created on every physical attempt, so the two
    // calls below deliberately use DIFFERENT conversationId values (like two
    // real retries would) while `idempotencyConversationScope` is left
    // unset (null) both times, exactly as client-agents.ts does when it
    // never resolved an existing conversation.
    const first = await createBackgroundAgentRun(baseInput('conv-fresh-1', { idempotencyKey: 'idem-retry' }));
    expect(first.kind).toBe('created');

    const second = await createBackgroundAgentRun(baseInput('conv-fresh-2', { idempotencyKey: 'idem-retry' }));
    expect(second.kind).toBe('idempotent_replay');
    if (first.kind === 'created' && second.kind === 'idempotent_replay') {
      expect(String(second.run._id)).toBe(String(first.run._id));
      // The replay returns the FIRST attempt's real conversation, not the
      // second (fresh, now-orphaned) one.
      expect(second.run.conversationId).toBe('conv-fresh-1');
    }
  });

  it('when the caller DOES continue an existing conversation (idempotencyConversationScope set), a different conversation under the same key is a genuine conflict', async () => {
    const first = await createBackgroundAgentRun(
      baseInput('conv-x', { idempotencyKey: 'idem-scoped', idempotencyConversationScope: 'conv-x' }),
    );
    expect(first.kind).toBe('created');

    const second = await createBackgroundAgentRun(
      baseInput('conv-y', { idempotencyKey: 'idem-scoped', idempotencyConversationScope: 'conv-y' }),
    );
    expect(second.kind).toBe('idempotency_conflict');
  });
});

describe('Concurrency cap (§12.8)', () => {
  it('rejects a new background run once the tenant is at its configured concurrent-run cap', async () => {
    const first = await createBackgroundAgentRun(baseInput('conv-a'));
    const second = await createBackgroundAgentRun(baseInput('conv-b'));
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');

    // Cap is 2 (set in beforeEach) — a third request must be rejected, not
    // silently queued behind the other two.
    const third = await createBackgroundAgentRun(baseInput('conv-c'));
    expect(third.kind).toBe('concurrency_limit');
    if (third.kind === 'concurrency_limit') {
      expect(third.limit).toBe(2);
    }
  });

  it('does not count terminal (finalized) runs against the cap', async () => {
    const first = await createBackgroundAgentRun(baseInput('conv-a'));
    if (first.kind !== 'created') throw new Error('expected created');
    await db.claimAgentRun(String(first.run._id), tenantId, 'worker-1', new Date());
    await db.finalizeAgentRun(String(first.run._id), tenantId, { status: 'succeeded', completedAt: new Date() });

    const second = await createBackgroundAgentRun(baseInput('conv-b'));
    const third = await createBackgroundAgentRun(baseInput('conv-c'));
    expect(second.kind).toBe('created');
    expect(third.kind).toBe('created');
  });
});

describe('Retention (§12.10)', () => {
  it('createBackgroundAgentRun sets expiresAt from AGENT_RUN_RETENTION_DAYS', async () => {
    process.env.AGENT_RUN_RETENTION_DAYS = '30';
    reloadConfig();
    const outcome = await createBackgroundAgentRun(baseInput('conv-retention'));
    if (outcome.kind !== 'created') throw new Error('expected created');
    expect(outcome.run.expiresAt).toBeTruthy();
    const daysUntilExpiry = (new Date(outcome.run.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(daysUntilExpiry).toBeGreaterThan(29);
    expect(daysUntilExpiry).toBeLessThan(31);
    delete process.env.AGENT_RUN_RETENTION_DAYS;
    reloadConfig();
  });

  it('the creation write path cleans up rows past their own expiresAt (mirrors cleanupAgentTracingRetention)', async () => {
    // A prior, already-terminal run whose retention window has elapsed.
    const stale = await db.createAgentRun({
      mode: 'background',
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      conversationId: 'conv-old',
      userMessage: 'hello',
      status: 'succeeded',
      expiresAt: new Date(Date.now() - 1000),
      callbackAttempts: 0,
    });

    await createBackgroundAgentRun(baseInput('conv-new'));
    // The cleanup is fire-and-forgotten (non-blocking) on the creation
    // write path — give its microtask a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await db.getAgentRunById(String(stale._id), tenantId, PROJECT_ID)).toBeNull();
  });
});
