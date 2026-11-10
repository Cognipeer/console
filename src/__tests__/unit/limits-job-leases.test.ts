import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(async () => undefined),
  publish: vi.fn(async () => 'job-1'),
}));

vi.mock('@/lib/limits', async () => {
  const errors = await vi.importActual<typeof import('@/lib/limits/errors')>('@/lib/limits/errors');
  return { PlanLimitError: errors.PlanLimitError, acquirePlanLease: (...args: unknown[]) => h.acquire(...args) };
});
vi.mock('@/lib/core/queue', () => ({ getQueue: async () => ({ publish: h.publish }) }));

import { JOB_LEASE_REQUEUE_DELAY_MS, runJobUnderLease } from '@/lib/services/planLeases';

const lease = () => ({ tenantId: 't1', pool: 'job', holderId: 'j1', release: h.release });
const allowed = { allowed: true, outcome: 'allowed', kind: 'concurrency', dimension: 'job', limit: 2, used: 1 };
const refused = { allowed: false, outcome: 'refused', kind: 'concurrency', dimension: 'job', limit: 2, used: 2 };
const payload = { tenantId: 't1', runId: 'j1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runJobUnderLease', () => {
  it('takes one job lease keyed by the job id and releases it after the job', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    const run = vi.fn(async () => 'done');
    const result = await runJobUnderLease({ tenantId: 't1', holderId: 'j1', queueName: 'q', jobName: 'n', payload, run });
    expect(result).toEqual({ deferred: false, value: 'done' });
    expect(h.acquire).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', pool: 'job', holderId: 'j1' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('takes the lease from the pool the caller names', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    const run = vi.fn(async () => 'done');
    await runJobUnderLease({ tenantId: 't1', holderId: 'j1', queueName: 'q', jobName: 'n', payload, pool: 'crawler', run });
    expect(h.acquire).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', pool: 'crawler', holderId: 'j1' }));
  });

  it('releases the lease when the job throws', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    await expect(
      runJobUnderLease({ tenantId: 't1', holderId: 'j1', queueName: 'q', jobName: 'n', payload, run: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow('boom');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('requeues with a 30 s delay and does not run the job when the pool is full', async () => {
    h.acquire.mockResolvedValue({ decision: refused, lease: null });
    const run = vi.fn();
    const result = await runJobUnderLease({ tenantId: 't1', holderId: 'j1', queueName: 'q', jobName: 'n', payload, run });
    expect(result).toEqual({ deferred: true });
    expect(run).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith('q', 'n', payload, expect.objectContaining({ delayMs: JOB_LEASE_REQUEUE_DELAY_MS, attempts: 1 }));
    expect(JOB_LEASE_REQUEUE_DELAY_MS).toBe(30_000);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('runs without a lease when limits are off or in shadow with no lease handed back', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: null });
    const run = vi.fn(async () => 1);
    const result = await runJobUnderLease({ tenantId: 't1', holderId: 'j1', queueName: 'q', jobName: 'n', payload, run });
    expect(result).toEqual({ deferred: false, value: 1 });
    expect(h.release).not.toHaveBeenCalled();
  });
});
