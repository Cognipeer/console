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
  publish: vi.fn(),
}));

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
import {
  createBackgroundAgentRun,
  lookupIdempotentAgentRun,
} from '@/lib/services/agents/agentRunService';

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
  hoisted.publish.mockResolvedValue(undefined);
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

describe('Idempotency-Key — races and the pre-conversation lookup', () => {
  it('REGRESSION: concurrent same-key requests — exactly one run is created, the other replays it', async () => {
    const results = await Promise.all([
      createBackgroundAgentRun(baseInput('conv-race-1', { idempotencyKey: 'idem-race' })),
      createBackgroundAgentRun(baseInput('conv-race-2', { idempotencyKey: 'idem-race' })),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['created', 'idempotent_replay']);
    const created = results.find((r) => r.kind === 'created');
    const replay = results.find((r) => r.kind === 'idempotent_replay');
    if (created?.kind === 'created' && replay?.kind === 'idempotent_replay') {
      expect(String(replay.run._id)).toBe(String(created.run._id));
    }
    expect(await db.countActiveAgentRuns(tenantId)).toBe(1);
    expect(hoisted.publish.mock.calls.filter(([, name]) => name === 'run')).toHaveLength(1);
  });

  it('REGRESSION: an insert that loses the race on the unique key (AgentRunIdempotencyKeyTakenError) resolves to a replay, not a 500', async () => {
    const first = await createBackgroundAgentRun(baseInput('conv-taken-1', { idempotencyKey: 'idem-taken' }));
    expect(first.kind).toBe('created');

    // Make the pre-check miss, as it does when two requests read before
    // either writes — the insert itself must then catch the duplicate.
    const lookup = vi.spyOn(db, 'getAgentRunByIdempotencyKey');
    lookup.mockResolvedValueOnce(null);
    const second = await createBackgroundAgentRun(baseInput('conv-taken-2', { idempotencyKey: 'idem-taken' }));

    expect(second.kind).toBe('idempotent_replay');
    if (first.kind === 'created' && second.kind === 'idempotent_replay') {
      expect(String(second.run._id)).toBe(String(first.run._id));
    }
    // The losing insert left nothing behind.
    expect(await db.countActiveAgentRuns(tenantId)).toBe(1);
  });

  it('the same race with a DIFFERENT body resolves to idempotency_conflict', async () => {
    await createBackgroundAgentRun(baseInput('conv-taken-3', { idempotencyKey: 'idem-taken-2' }));
    vi.spyOn(db, 'getAgentRunByIdempotencyKey').mockResolvedValueOnce(null);
    const second = await createBackgroundAgentRun(
      baseInput('conv-taken-4', { idempotencyKey: 'idem-taken-2', userMessage: 'something else' }),
    );
    expect(second.kind).toBe('idempotency_conflict');
  });

  it('lookupIdempotentAgentRun (run before a conversation is created) answers replay / conflict / none', async () => {
    const created = await createBackgroundAgentRun(baseInput('conv-lookup', { idempotencyKey: 'idem-lookup' }));
    if (created.kind !== 'created') throw new Error('expected created');
    const common = {
      tenantDbName: dbName,
      tenantId,
      projectId: PROJECT_ID,
      agentKey: AGENT_KEY,
      idempotencyConversationScope: null,
    };

    const replay = await lookupIdempotentAgentRun({ ...common, userMessage: 'hello', idempotencyKey: 'idem-lookup' });
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(String(replay.run._id)).toBe(String(created.run._id));

    const conflict = await lookupIdempotentAgentRun({ ...common, userMessage: 'different', idempotencyKey: 'idem-lookup' });
    expect(conflict.kind).toBe('conflict');

    const none = await lookupIdempotentAgentRun({ ...common, userMessage: 'hello', idempotencyKey: 'idem-unused' });
    expect(none.kind).toBe('none');
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
      expect(third.scope).toBe('tenant');
    }
    // REGRESSION: the cap is checked AFTER the insert; the row that tipped it
    // over is deleted again (never queued, conversation not left locked).
    expect(await db.countActiveAgentRuns(tenantId)).toBe(2);
    expect((await db.listAgentRuns({ tenantId, projectId: PROJECT_ID, conversationId: 'conv-c' }))).toHaveLength(0);
    expect(hoisted.publish.mock.calls.filter(([, name]) => name === 'run')).toHaveLength(2);
    const retry = await createBackgroundAgentRun(baseInput('conv-c', { limits: { backgroundMaxDurationMs: 60_000, maxConcurrentRunsPerTenant: 3, maxConcurrentRunsPerProject: 0 } }));
    expect(retry.kind).toBe('created');
  });

  it('REGRESSION: sync reservations (interactive turns) do not count against the background cap', async () => {
    for (const conversationId of ['conv-sync-1', 'conv-sync-2', 'conv-sync-3']) {
      await db.createAgentRun({
        mode: 'sync',
        tenantId,
        tenantDbName: dbName,
        projectId: PROJECT_ID,
        agentKey: AGENT_KEY,
        conversationId,
        userMessage: 'hello',
        status: 'running',
        startedAt: new Date(),
        callbackAttempts: 0,
      });
    }
    const first = await createBackgroundAgentRun(baseInput('conv-a'));
    const second = await createBackgroundAgentRun(baseInput('conv-b'));
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
  });

  it('concurrent submissions cannot all slip past the cap (count is taken after each insert)', async () => {
    const results = await Promise.all(
      ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].map((c) => createBackgroundAgentRun(baseInput(c))),
    );
    expect(results.filter((r) => r.kind === 'created').length).toBeLessThanOrEqual(2);
    expect(await db.countActiveAgentRuns(tenantId, undefined, 'background')).toBeLessThanOrEqual(2);
  });

  it('a per-project cap rejects with scope "project" while the tenant still has room', async () => {
    const limits = { backgroundMaxDurationMs: 60_000, maxConcurrentRunsPerTenant: 10, maxConcurrentRunsPerProject: 1 };
    expect((await createBackgroundAgentRun(baseInput('conv-p1', { limits }))).kind).toBe('created');

    const overProject = await createBackgroundAgentRun(baseInput('conv-p2', { limits }));
    expect(overProject).toEqual({ kind: 'concurrency_limit', limit: 1, scope: 'project' });

    // Another project in the same tenant is unaffected.
    const otherProject = await createBackgroundAgentRun(baseInput('conv-p3', { limits, projectId: 'proj-2' }));
    expect(otherProject.kind).toBe('created');
  });

  it('a cap of 0 means no cap', async () => {
    const limits = { backgroundMaxDurationMs: 60_000, maxConcurrentRunsPerTenant: 0, maxConcurrentRunsPerProject: 0 };
    for (const c of ['z-1', 'z-2', 'z-3', 'z-4']) {
      expect((await createBackgroundAgentRun(baseInput(c, { limits }))).kind).toBe('created');
    }
  });

  it('a publish failure deletes the row (the conversation is not left locked) and rethrows', async () => {
    hoisted.publish.mockRejectedValueOnce(new Error('queue down'));
    await expect(createBackgroundAgentRun(baseInput('conv-publish-fail'))).rejects.toThrow('queue down');
    expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
    expect((await createBackgroundAgentRun(baseInput('conv-publish-fail'))).kind).toBe('created');
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

  it('retention is no longer done on the creation write path (it is the reconciler\'s hourly job)', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await db.getAgentRunById(String(stale._id), tenantId, PROJECT_ID)).not.toBeNull();

    // The sweep the reconciler runs deletes it (and never an active row).
    await db.cleanupAgentRunRetention({ olderThan: new Date(), batchSize: 1000 });
    expect(await db.getAgentRunById(String(stale._id), tenantId, PROJECT_ID)).toBeNull();
    expect(await db.countActiveAgentRuns(tenantId)).toBe(1);
  });

});
