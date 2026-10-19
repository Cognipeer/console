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
import { AGENT_RUN_DEFERRED_QUEUE, AGENT_RUN_QUEUE } from '@/lib/services/agents/agentRunService';

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
  delete process.env.AGENT_DEFERRED_MAX_RUNNING_PER_TENANT;
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

  describe('the session event log of a run that is lost', () => {
    const runningSession = async () => {
      const conversation = await db.createAgentConversation({
        tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'Lost', messages: [], createdBy: 'user-1',
      });
      const conversationId = String(conversation._id);
      // What the turn did when it started, before its worker died.
      await db.updateAgentConversationRuntime(conversationId, { runtimeStatus: 'running', runtimeTurnId: 'turn-1' });
      return conversationId;
    };

    it('ends with the terminal events of a failed turn, so a follower is not left waiting, and the session is idle', async () => {
      const conversationId = await runningSession();
      const run = await db.createAgentRun(baseRecord(conversationId));
      await db.claimAgentRun(String(run._id), tenantId, 'dead-worker', new Date(Date.now() - 120_000));

      await triggerAgentRunReconcilerRun();

      const events = await db.listAgentSessionEvents(conversationId, { runId: String(run._id) });
      expect(events.map((event) => event.type)).toEqual(['session.error', 'session.status_idle']);
      expect(events[0].data).toMatchObject({ code: 'agent_run_interrupted' });
      expect(events[1].data).toMatchObject({ stopReason: 'error' });
      expect(await db.findAgentConversationById(conversationId)).toMatchObject({
        runtimeStatus: 'idle', stopReason: 'error', lastEventSeq: events[1].seq,
      });
    });

    it('leaves the log and the session of a healthy (fresh-heartbeat) run alone', async () => {
      const conversationId = await runningSession();
      const run = await db.createAgentRun(baseRecord(conversationId));
      await db.claimAgentRun(String(run._id), tenantId, 'healthy-worker', new Date());

      await triggerAgentRunReconcilerRun();

      expect(await db.listAgentSessionEvents(conversationId, { runId: String(run._id) })).toEqual([]);
      expect(await db.findAgentConversationById(conversationId)).toMatchObject({ runtimeStatus: 'running' });
    });

    it('does not reset a session that moved on (it reads requires_action, not running)', async () => {
      const conversationId = await runningSession();
      await db.updateAgentConversationRuntime(conversationId, { runtimeStatus: 'requires_action', stopReason: 'requires_action' });
      const run = await db.createAgentRun(baseRecord(conversationId));
      await db.claimAgentRun(String(run._id), tenantId, 'dead-worker', new Date(Date.now() - 120_000));

      await triggerAgentRunReconcilerRun();

      expect((await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID))?.errorReason).toBe('worker_lost');
      expect(await db.listAgentSessionEvents(conversationId, { runId: String(run._id) })).toEqual([]);
      expect(await db.findAgentConversationById(conversationId)).toMatchObject({ runtimeStatus: 'requires_action' });
    });
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

describe('agent-run reconciler: scheduled, deferred and expired runs (§4.4–§4.6)', () => {
  const runJobs = (queue: string) => hoisted.publish.mock.calls.filter(([q, name]) => q === queue && name === 'run');

  it('promotes a scheduled run that came due and publishes it; a future one stays scheduled', async () => {
    const due = await db.createAgentRun({ ...baseRecord('conv-due'), status: 'scheduled', notBefore: new Date(Date.now() - 1_000) });
    const later = await db.createAgentRun({ ...baseRecord('conv-later'), status: 'scheduled', notBefore: new Date(Date.now() + 3_600_000) });

    const result = await triggerAgentRunReconcilerRun();

    expect(result.promotedRuns).toBe(1);
    expect((await db.getAgentRunById(String(due._id), tenantId, PROJECT_ID))?.status).toBe('queued');
    expect((await db.getAgentRunById(String(later._id), tenantId, PROJECT_ID))?.status).toBe('scheduled');
    expect(runJobs(AGENT_RUN_QUEUE).map(([, , payload]) => payload.runId)).toEqual([String(due._id)]);
  });

  it('a due scheduled run whose conversation is busy stays scheduled and is promoted on a later tick', async () => {
    const busy = await db.createAgentRun({ ...baseRecord('conv-busy') });
    await db.claimAgentRun(String(busy._id), tenantId, 'healthy-worker', new Date());
    const waiting = await db.createAgentRun({ ...baseRecord('conv-busy'), status: 'scheduled', notBefore: new Date(Date.now() - 1_000) });

    const first = await triggerAgentRunReconcilerRun();
    expect(first.promotedRuns).toBe(0);
    expect((await db.getAgentRunById(String(waiting._id), tenantId, PROJECT_ID))?.status).toBe('scheduled');

    await db.finalizeAgentRun(String(busy._id), tenantId, { status: 'succeeded', completedAt: new Date() });
    const second = await triggerAgentRunReconcilerRun();
    expect(second.promotedRuns).toBe(1);
    expect((await db.getAgentRunById(String(waiting._id), tenantId, PROJECT_ID))?.status).toBe('queued');
  });

  describe('a due reminder', () => {
    async function reminderIn(runtimeStatus: string | undefined, whenBusy: 'postpone' | 'skip') {
      await db.createAgent({
        tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Support', status: 'active', createdBy: 'user-1',
        config: { modelKey: 'gpt-4o', reminders: { enabled: true, whenBusy } },
      });
      const conversation = await db.createAgentConversation({
        tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'S', messages: [], createdBy: 'user-1',
        ...(runtimeStatus ? { runtimeStatus: runtimeStatus as never } : {}),
      });
      return db.createAgentRun({
        ...baseRecord(String(conversation._id)), channel: 'reminder', status: 'scheduled', notBefore: new Date(Date.now() - 1_000),
      });
    }

    it('waits while its session waits on a person (postpone), and is promoted once it does not', async () => {
      const run = await reminderIn('requires_action', 'postpone');
      expect((await triggerAgentRunReconcilerRun()).promotedRuns).toBe(0);
      expect((await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID))?.status).toBe('scheduled');

      await db.updateAgentConversationRuntime(run.conversationId, { runtimeStatus: 'idle' });
      expect((await triggerAgentRunReconcilerRun()).promotedRuns).toBe(1);
      expect((await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID))?.status).toBe('queued');
    });

    it('is dropped when the agent says skip a busy session', async () => {
      const run = await reminderIn('budget_paused', 'skip');
      expect((await triggerAgentRunReconcilerRun()).promotedRuns).toBe(0);
      expect((await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID))?.status).toBe('canceled');
    });

    it('is dropped when its session is gone', async () => {
      const run = await db.createAgentRun({ ...baseRecord('conv-gone'), channel: 'reminder', status: 'scheduled', notBefore: new Date(Date.now() - 1_000) });
      await triggerAgentRunReconcilerRun();
      expect((await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID))?.status).toBe('canceled');
    });
  });

  it('a promoted deferred run is not published directly: the dispatcher hands it out', async () => {
    const run = await db.createAgentRun({ ...baseRecord('conv-deferred-due'), runClass: 'deferred', status: 'scheduled', notBefore: new Date(Date.now() - 1_000) });

    const result = await triggerAgentRunReconcilerRun();

    expect(result.promotedRuns).toBe(1);
    expect(runJobs(AGENT_RUN_QUEUE)).toHaveLength(0);
    expect(runJobs(AGENT_RUN_DEFERRED_QUEUE).map(([, , payload]) => payload.runId)).toEqual([String(run._id)]);
  });

  it('dispatches queued deferred runs only up to the class running cap', async () => {
    process.env.AGENT_DEFERRED_MAX_RUNNING_PER_TENANT = '2';
    reloadConfig();
    const running = await db.createAgentRun({ ...baseRecord('conv-d-running'), runClass: 'deferred' });
    await db.claimAgentRun(String(running._id), tenantId, 'healthy-worker', new Date());
    for (const c of ['conv-d-1', 'conv-d-2', 'conv-d-3']) {
      await db.createAgentRun({ ...baseRecord(c), runClass: 'deferred' });
    }

    const result = await triggerAgentRunReconcilerRun();

    // One of the two slots is taken: exactly one more is handed out.
    expect(result.dispatchedDeferredRuns).toBe(1);
    expect(runJobs(AGENT_RUN_DEFERRED_QUEUE)).toHaveLength(1);
    // The requeue step leaves deferred rows to the dispatcher.
    expect(runJobs(AGENT_RUN_QUEUE)).toHaveLength(0);
  });

  it('expires runs that waited past AGENT_DEFERRED_MAX_WAIT_MS, freeing the conversation', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const deferred = await db.createAgentRun({ ...baseRecord('conv-expired-deferred'), runClass: 'deferred', notBefore: twoDaysAgo });
    const scheduled = await db.createAgentRun({ ...baseRecord('conv-expired-scheduled'), status: 'scheduled', notBefore: new Date(Date.now() + 3_600_000) });
    const fresh = await db.createAgentRun({ ...baseRecord('conv-fresh-deferred'), runClass: 'deferred' });

    const result = await triggerAgentRunReconcilerRun();

    expect(result.expiredRuns).toBe(1);
    expect(await db.getAgentRunById(String(deferred._id), tenantId, PROJECT_ID)).toMatchObject({ status: 'failed', errorReason: 'expired' });
    expect((await db.getAgentRunById(String(scheduled._id), tenantId, PROJECT_ID))?.status).toBe('scheduled');
    expect((await db.getAgentRunById(String(fresh._id), tenantId, PROJECT_ID))?.status).toBe('queued');
    // The expired run's conversation takes a new run again.
    expect((await db.createAgentRun(baseRecord('conv-expired-deferred')))._id).toBeTruthy();
  });
});

describe('agent-run reconciler: hourly retention (§4.5)', () => {
  it('drops expired scheduler claims and keeps live ones', async () => {
    await db.claimSchedulerSlot('trigger:r1:2026-01-01T00:00:00.000Z', new Date(Date.now() - 60_000));
    await db.claimSchedulerSlot('trigger:r1:2099-01-01T00:00:00.000Z', new Date(Date.now() + 30 * 86_400_000));
    // Retention runs at most hourly per process: move the clock past the interval so this tick runs it.
    vi.useFakeTimers({ now: Date.now() + 2 * 3_600_000, toFake: ['Date'] });

    const result = await triggerAgentRunReconcilerRun();

    expect(result.retentionDeleted).toBeGreaterThanOrEqual(1);
    // The expired key is free to claim again; the live one still holds.
    expect(await db.claimSchedulerSlot('trigger:r1:2026-01-01T00:00:00.000Z', new Date(Date.now() + 60_000))).toBe(true);
    expect(await db.claimSchedulerSlot('trigger:r1:2099-01-01T00:00:00.000Z', new Date(Date.now() + 60_000))).toBe(false);
  });
});
