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
  reloadConfig();
});

afterEach(async () => {
  delete process.env.AGENT_RUN_HEARTBEAT_STALE_MS;
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

  it('deletes a stale sync reservation row rather than finalizing it', async () => {
    const conversationId = 'conv-stale-sync';
    const run = await db.createAgentRun(baseRecord(conversationId, 'sync'));
    await db.claimAgentRun(String(run._id), tenantId, 'dead-worker', new Date(Date.now() - 120_000));

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

    const staleAfter = await db.getAgentRunById(String(staleRun._id), tenantId, PROJECT_ID);
    expect(staleAfter?.status).toBe('failed');
    expect(staleAfter?.errorReason).toBe('worker_lost');
  });
});
