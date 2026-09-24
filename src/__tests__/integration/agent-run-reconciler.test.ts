/**
 * Group F (docs/guide/agent-background-execution.md §13) — crash-recovery
 * reconciler.
 *
 * DoD (plan.md Group F): a fabricated stale `background` run gets failed
 * with `worker_lost` by the sweep; a fabricated stale `sync` row gets
 * deleted, not finalized. Also proves the boot-time queued-run requeue and
 * that a HEALTHY (fresh-heartbeat) running row is left untouched — the gap
 * the crawler's boot-only sweep has (§12.1) that this reconciler is
 * specifically designed not to repeat.
 *
 * Reconciler functions call the GLOBAL `getDatabase()` singleton directly
 * (as production code must, to iterate every tenant) — unlike the
 * parity-style tests elsewhere in this suite, so `@/lib/database` is
 * mocked here to resolve to a REAL, isolated SQLiteProvider instance this
 * test controls (same pattern as `agent-run-sync-ceiling.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  publish: vi.fn(),
}));

// Observe republishes instead of pushing into a real (memory/BullMQ) queue.
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish: hoisted.publish })),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

import { getDatabase } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import {
  reconcileOrphanedAgentRuns,
  triggerAgentRunReconcilerRun,
} from '@/lib/services/agents/agentRunReconciler';
import { AGENT_RUN_QUEUE } from '@/lib/services/agents/agentRunService';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_reconcile';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-bot';

function baseRecord(conversationId: string, mode: 'sync' | 'background' = 'background') {
  return {
    mode,
    tenantId,
    tenantDbName: dbName,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId,
    userMessage: 'hello',
    status: 'queued' as const,
    callbackAttempts: 0,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-run-reconciler-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme',
    slug: 'acme-reconcile',
    dbName,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  process.env.AGENT_RUN_HEARTBEAT_STALE_MS = '45000';
  process.env.AGENT_SYNC_TIMEOUT_MS = '5000';
  reloadConfig();
  hoisted.publish.mockResolvedValue(undefined);
});

afterEach(async () => {
  delete process.env.AGENT_RUN_HEARTBEAT_STALE_MS;
  delete process.env.AGENT_SYNC_TIMEOUT_MS;
  delete process.env.AGENT_RUN_REQUEUE_AFTER_MS;
  vi.useRealTimers();
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('agent-run crash-recovery reconciler (§7.1)', () => {
  it('fails a stale background run as worker_lost, without auto-restarting it', async () => {
    const conversationId = 'conv-stale-background';
    const run = await db.createAgentRun(baseRecord(conversationId));
    // Simulate a worker that claimed the run then died: running, heartbeat
    // long in the past (older than AGENT_RUN_HEARTBEAT_STALE_MS).
    await db.claimAgentRun(String(run._id), tenantId, 'dead-worker', new Date(Date.now() - 120_000));

    await triggerAgentRunReconcilerRun();

    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.status).toBe('failed');
    expect(after?.errorReason).toBe('worker_lost');
  });

  it('deletes an ABANDONED sync reservation row (past its own ceiling + grace) rather than finalizing it', async () => {
    const conversationId = 'conv-stale-sync';
    const run = await db.createAgentRun(baseRecord(conversationId, 'sync'));
    // Started long before AGENT_SYNC_TIMEOUT_MS (set to 5s) + the 60s grace.
    await db.claimAgentRun(String(run._id), tenantId, 'dead-worker', new Date(Date.now() - 10 * 60_000));

    await triggerAgentRunReconcilerRun();

    expect(await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID)).toBeNull();
    // The conversationId's active-run slot is freed immediately.
    const recreated = await db.createAgentRun(baseRecord(conversationId, 'sync'));
    expect(recreated._id).toBeTruthy();
  });

  it('leaves a healthy (fresh-heartbeat) running row untouched — the gap the crawler sweep has (§12.1)', async () => {
    const conversationId = 'conv-healthy';
    const run = await db.createAgentRun(baseRecord(conversationId));
    await db.claimAgentRun(String(run._id), tenantId, 'healthy-worker', new Date());

    await triggerAgentRunReconcilerRun();

    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.status).toBe('running');
    expect(after?.workerId).toBe('healthy-worker');
  });

  it('boot-time reconcileOrphanedAgentRuns republishes queued runs and sweeps stale running ones', async () => {
    const queuedRun = await db.createAgentRun(baseRecord('conv-queued'));
    const staleRun = await db.createAgentRun(baseRecord('conv-stale'));
    await db.claimAgentRun(String(staleRun._id), tenantId, 'dead-worker', new Date(Date.now() - 120_000));

    const result = await reconcileOrphanedAgentRuns();
    expect(result.requeuedRuns).toBeGreaterThanOrEqual(1);
    expect(result.failedRunningRuns).toBeGreaterThanOrEqual(1);

    // Requeue only re-publishes the job message — it does not itself
    // transition status, so the queued run is still `queued`, waiting for
    // a worker to claim it.
    const queuedAfter = await db.getAgentRunById(String(queuedRun._id), tenantId, PROJECT_ID);
    expect(queuedAfter?.status).toBe('queued');
    // At boot EVERY queued run is republished, however young.
    expect(hoisted.publish).toHaveBeenCalledWith(
      AGENT_RUN_QUEUE,
      'run',
      { runId: String(queuedRun._id), tenantId, tenantDbName: dbName },
      expect.anything(),
    );

    const staleAfter = await db.getAgentRunById(String(staleRun._id), tenantId, PROJECT_ID);
    expect(staleAfter?.status).toBe('failed');
    expect(staleAfter?.errorReason).toBe('worker_lost');
  });

  it('REGRESSION: leaves a YOUNG sync reservation alone even though its heartbeat is stale (sync rows never heartbeat)', async () => {
    const conversationId = 'conv-live-long-sync';
    const run = await db.createAgentRun(baseRecord(conversationId, 'sync'));
    // Heartbeat older than AGENT_RUN_HEARTBEAT_STALE_MS (45s) but the turn is
    // still inside its 5s ceiling + 60s grace window.
    await db.claimAgentRun(String(run._id), tenantId, 'sync-caller', new Date(Date.now() - 50_000));

    const result = await triggerAgentRunReconcilerRun();

    expect(result.deletedSyncRuns).toBe(0);
    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.status).toBe('running');
    // Its conversation is still locked — a second turn cannot start on it.
    await expect(db.createAgentRun(baseRecord(conversationId))).rejects.toThrow();
  });

  it('a periodic tick republishes a queued run older than AGENT_RUN_REQUEUE_AFTER_MS, but not a fresh one', async () => {
    process.env.AGENT_RUN_REQUEUE_AFTER_MS = '10000';
    reloadConfig();
    const oldRun = await db.createAgentRun(baseRecord('conv-old-queued'));

    // Time moves on 30s (past the 10s requeue threshold)...
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 30_000));
    // ...and a new run is queued "now".
    const freshRun = await db.createAgentRun(baseRecord('conv-fresh-queued'));

    const result = await triggerAgentRunReconcilerRun();
    vi.useRealTimers();

    expect(result.requeuedRuns).toBe(1);
    const republishedIds = hoisted.publish.mock.calls
      .filter(([queue, name]) => queue === AGENT_RUN_QUEUE && name === 'run')
      .map(([, , payload]) => (payload as { runId: string }).runId);
    expect(republishedIds).toEqual([String(oldRun._id)]);
    expect(republishedIds).not.toContain(String(freshRun._id));
    // Republishing never changes the row; the worker's claim CAS does.
    expect((await db.getAgentRunById(String(oldRun._id), tenantId, PROJECT_ID))?.status).toBe('queued');
  });

  it('a failed republish is logged and counted as not requeued, never aborting the sweep', async () => {
    process.env.AGENT_RUN_REQUEUE_AFTER_MS = '10000';
    reloadConfig();
    await db.createAgentRun(baseRecord('conv-old-queued-2'));
    const stale = await db.createAgentRun(baseRecord('conv-stale-2'));
    await db.claimAgentRun(String(stale._id), tenantId, 'dead-worker', new Date(Date.now() - 120_000));
    hoisted.publish.mockRejectedValue(new Error('queue down'));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 30_000));
    const result = await triggerAgentRunReconcilerRun();
    vi.useRealTimers();

    expect(result.requeuedRuns).toBe(0);
    expect(result.failedRunningRuns).toBe(1);
  });
});
