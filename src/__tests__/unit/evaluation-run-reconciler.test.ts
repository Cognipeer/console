/**
 * Evaluation run reconciler: boot pass per queue provider, and the periodic
 * stale / expired-pending pass. The database, queue and cache are fakes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadConfig } from '@/lib/core/config';

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

const pendingRun: {
  _id: string; tenantId: string; projectId: string; createdBy: string; suiteKey: string; createdAt: Date;
  actorType?: 'user' | 'api_token'; apiTokenId?: string;
} = {
  _id: 'r-pending', tenantId: 't1', projectId: 'p1', createdBy: 'u', suiteKey: 's1', createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

type PageOpts = { createdBefore?: Date; limit?: number; after?: { createdAt: Date; id: string } };

/** listEvaluationRunsByStatus over `runs` as both providers answer it: ordered by (createdAt, id), keyset `after`. */
function pagedRuns(runs: Array<typeof pendingRun>) {
  return vi.fn(async (_statuses: unknown, opts: PageOpts = {}) => {
    const key = (r: { createdAt: Date; _id: string }) => [r.createdAt.getTime(), r._id] as const;
    const sorted = [...runs].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1].localeCompare(key(b)[1]));
    return sorted
      .filter((r) => !opts.createdBefore || r.createdAt < opts.createdBefore)
      .filter((r) => !opts.after
        || r.createdAt.getTime() > opts.after.createdAt.getTime()
        || (r.createdAt.getTime() === opts.after.createdAt.getTime() && r._id > opts.after.id))
      .slice(0, opts.limit ?? 1000);
  });
}

beforeEach(() => {
  state.queueName = 'memory';
  state.queue.publish.mockClear();
  state.cache.acquireLock.mockClear();
  state.cache.acquireLock.mockResolvedValue('token');
  state.cache.releaseLock.mockClear();
  delete process.env.EVALUATION_RUN_STALE_MS;
  reloadConfig();
  state.db = {
    failStaleEvaluationRuns: vi.fn(async () => 2),
    expirePendingEvaluationRuns: vi.fn(async () => 0),
    listEvaluationRunsByStatus: pagedRuns([pendingRun]),
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

  it('republishes a run with the caller stored with it, and one that records none without a caller', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    state.db.listEvaluationRunsByStatus = pagedRuns([
      { ...pendingRun, _id: 'r-token', createdAt: at, actorType: 'api_token', apiTokenId: 'tok-9' },
      { ...pendingRun, _id: 'r-user', createdAt: at, actorType: 'user' },
      { ...pendingRun, _id: 'r-legacy', createdAt: at },
    ]);

    await reconcileOrphanedEvaluationRuns();

    const byRun = new Map(state.queue.publish.mock.calls.map((call) => {
      const payload = call[2] as Record<string, unknown>;
      return [payload.runId, payload] as const;
    }));
    expect(byRun.get('r-token')).toMatchObject({ actorType: 'api_token', apiTokenId: 'tok-9', createdBy: 'u' });
    expect(byRun.get('r-user')).toMatchObject({ actorType: 'user' });
    expect(byRun.get('r-user')).not.toHaveProperty('apiTokenId');
    // The worker fails it rather than guess who it acts for (evaluation-run-caller.test.ts).
    expect(byRun.get('r-legacy')).not.toHaveProperty('actorType');
    expect(byRun.get('r-legacy')).not.toHaveProperty('apiTokenId');
  });

  it('with the memory queue republishes every pending run, past the first page', async () => {
    const runs = Array.from({ length: 401 }, (_, i) => ({
      ...pendingRun,
      _id: `r-${String(i).padStart(3, '0')}`,
      // Pairs of runs share a timestamp: the pages are ordered by (createdAt, id), not createdAt alone.
      createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + Math.floor(i / 2)),
    }));
    state.db.listEvaluationRunsByStatus = pagedRuns(runs);

    const result = await reconcileOrphanedEvaluationRuns();

    const published = state.queue.publish.mock.calls.map((call) => (call[2] as { runId: string }).runId);
    expect(published).toHaveLength(401);
    expect(new Set(published).size).toBe(401);
    expect(result.requeuedPending).toBe(401);
    // Three pages of at most 200, each continuing after the last run of the one before.
    expect(state.db.listEvaluationRunsByStatus).toHaveBeenCalledTimes(3);
    const pages = state.db.listEvaluationRunsByStatus.mock.calls.map((call) => call[1] as PageOpts);
    expect(pages.map((opts) => opts.limit)).toEqual([200, 200, 200]);
    expect(pages[0].after).toBeUndefined();
    expect(pages[1].after).toEqual({ createdAt: runs[199].createdAt, id: 'r-199' });
    expect(pages[2].after).toEqual({ createdAt: runs[399].createdAt, id: 'r-399' });
    // Only the runs that were pending when the pass started: later ones were published when they were created.
    for (const opts of pages) expect(opts.createdBefore!.getTime()).toBeLessThanOrEqual(Date.now());
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
    reloadConfig();
    expect(evaluationRunStaleMs()).toBe(120_000);
    process.env.EVALUATION_RUN_STALE_MS = 'nonsense';
    reloadConfig();
    expect(evaluationRunStaleMs()).toBe(600_000);
  });

  it('fails pending runs older than 24 hours in one conditional write, never through a plain update', async () => {
    state.db.expirePendingEvaluationRuns = vi.fn(async () => 3);
    const result = await triggerEvaluationRunReconcilerRun();

    const [cutoff, message] = state.db.expirePendingEvaluationRuns.mock.calls[0] as [Date, string];
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5);
    expect(Date.now() - cutoff.getTime()).toBeLessThan(24 * 60 * 60 * 1000 + 5_000);
    expect(message).toMatch(/never started/);
    // A plain update by id would overwrite a run a worker claimed after it was selected.
    expect(state.db.updateEvaluationRun).not.toHaveBeenCalled();
    expect(state.db.listEvaluationRunsByStatus).not.toHaveBeenCalled();
    expect(result.expiredPending).toBe(3);
  });

  it('does nothing when another node holds the lock', async () => {
    state.cache.acquireLock.mockResolvedValue(undefined);
    const result = await triggerEvaluationRunReconcilerRun();
    expect(state.db.failStaleEvaluationRuns).not.toHaveBeenCalled();
    expect(result.tenantsScanned).toBe(0);
  });
});
