/**
 * Evaluation run reconciler: boot pass per queue provider, and the periodic
 * stale / expired-pending pass. The database, queue and cache are fakes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  queueName: 'memory' as 'memory' | 'bullmq',
  db: {} as Record<string, ReturnType<typeof vi.fn>>,
  queue: { publish: vi.fn(async (..._a: unknown[]) => 'id') },
  cache: {
    acquireLock: vi.fn(async (..._a: unknown[]) => 'token' as string | undefined),
    releaseLock: vi.fn(async (..._a: unknown[]) => undefined),
  },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: async () => ({ listTenants: async () => [{ _id: 't1', dbName: 'tenant_one' }] }),
}));
vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => ({ name: state.queueName, publish: state.queue.publish }),
}));
vi.mock('@/lib/core/cache', () => ({ getCache: async () => state.cache }));
vi.mock('@/lib/services/agents/agentRunService', () => ({
  runWithTenantDb: async (_name: string, fn: (db: unknown) => Promise<unknown>) => fn(state.db),
}));
vi.mock('@/lib/services/evaluation/service', () => ({
  EVAL_RUN_PENDING_MAX_AGE_MS: 24 * 60 * 60 * 1000,
}));
vi.mock('@/lib/services/evaluation/evaluationRunJob', () => ({
  EVALUATION_RUN_QUEUE: 'evaluation-run',
  EVALUATION_RUN_JOB: 'evaluation.run',
}));

import {
  evaluationRunStaleMs,
  reconcileOrphanedEvaluationRuns,
  triggerEvaluationRunReconcilerRun,
} from '@/lib/services/evaluation/evaluationRunReconciler';

const pendingRun = { _id: 'r-pending', tenantId: 't1', projectId: 'p1', createdBy: 'u', suiteKey: 's1' };

beforeEach(() => {
  state.queueName = 'memory';
  state.queue.publish.mockClear();
  state.cache.acquireLock.mockClear();
  state.cache.acquireLock.mockResolvedValue('token');
  state.cache.releaseLock.mockClear();
  delete process.env.EVALUATION_RUN_STALE_MS;
  state.db = {
    failStaleEvaluationRuns: vi.fn(async () => 2),
    listEvaluationRunsByStatus: vi.fn(async (_statuses: unknown, opts?: { createdBefore?: Date }) =>
      opts?.createdBefore ? [] : [pendingRun],
    ),
    updateEvaluationRun: vi.fn(async () => null),
  };
});

describe('boot pass', () => {
  it('with the memory queue fails every running run and republishes pending ones', async () => {
    const result = await reconcileOrphanedEvaluationRuns();

    const [cutoff, message] = state.db.failStaleEvaluationRuns.mock.calls[0] as [Date, string];
    expect(cutoff.getTime()).toBeGreaterThan(Date.now());
    expect(message).toBe('The server restarted while this run was in progress');

    expect(state.queue.publish).toHaveBeenCalledTimes(1);
    const [queueName, jobName, payload] = state.queue.publish.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(queueName).toBe('evaluation-run');
    expect(jobName).toBe('evaluation.run');
    expect(payload).toMatchObject({ tenantDbName: 'tenant_one', runId: 'r-pending', suiteKey: 's1', projectId: 'p1' });
    expect(result).toMatchObject({ failedRunning: 2, requeuedPending: 1 });
  });

  it('with BullMQ fails only stale running runs and republishes nothing', async () => {
    state.queueName = 'bullmq';
    await reconcileOrphanedEvaluationRuns();

    const [cutoff] = state.db.failStaleEvaluationRuns.mock.calls[0] as [Date, string];
    expect(cutoff.getTime()).toBeLessThan(Date.now());
    expect(state.queue.publish).not.toHaveBeenCalled();
  });
});

describe('periodic pass', () => {
  it('fails runs whose heartbeat is older than the stale cutoff (default 10 minutes)', async () => {
    expect(evaluationRunStaleMs()).toBe(600_000);
    const before = Date.now();
    await triggerEvaluationRunReconcilerRun();

    const [cutoff, message] = state.db.failStaleEvaluationRuns.mock.calls[0] as [Date, string];
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(600_000 - 5);
    expect(before - cutoff.getTime()).toBeLessThan(600_000 + 5_000);
    expect(message).toMatch(/stopped responding/);
    expect(state.queue.publish).not.toHaveBeenCalled();
    expect(state.cache.releaseLock).toHaveBeenCalled();
  });

  it('honours EVALUATION_RUN_STALE_MS', () => {
    process.env.EVALUATION_RUN_STALE_MS = '120000';
    expect(evaluationRunStaleMs()).toBe(120_000);
    process.env.EVALUATION_RUN_STALE_MS = 'nonsense';
    expect(evaluationRunStaleMs()).toBe(600_000);
  });

  it('fails pending runs older than 24 hours', async () => {
    state.db.listEvaluationRunsByStatus = vi.fn(async (_s: unknown, opts?: { createdBefore?: Date }) =>
      opts?.createdBefore ? [{ ...pendingRun, _id: 'old' }] : [],
    );
    const result = await triggerEvaluationRunReconcilerRun();

    const [, , opts] = [null, null, (state.db.listEvaluationRunsByStatus.mock.calls[0] as unknown[])[1]] as [
      null,
      null,
      { createdBefore: Date },
    ];
    expect(Date.now() - opts.createdBefore.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5);
    expect(state.db.updateEvaluationRun).toHaveBeenCalledWith('old', expect.objectContaining({ status: 'failed' }));
    expect(result.expiredPending).toBe(1);
  });

  it('does nothing when another node holds the lock', async () => {
    state.cache.acquireLock.mockResolvedValue(undefined);
    const result = await triggerEvaluationRunReconcilerRun();
    expect(state.db.failStaleEvaluationRuns).not.toHaveBeenCalled();
    expect(result.tenantsScanned).toBe(0);
  });
});
