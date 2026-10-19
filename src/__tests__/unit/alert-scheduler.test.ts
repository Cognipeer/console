import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cache = {
  name: 'memory',
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
};
const mainDb = { listTenants: vi.fn() };

vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  isServiceEnabled: vi.fn(async () => true),
}));
vi.mock('@/lib/core/cache', () => ({ getCache: vi.fn(async () => cache) }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => mainDb),
  runWithTenantScope: vi.fn(async (_db: string, fn: () => unknown) => fn()),
}));
vi.mock('@/lib/core/cluster', () => ({
  findInstanceAssignment: vi.fn(async () => null),
  getThisNodeName: vi.fn(() => 'node-1'),
}));
vi.mock('@/lib/services/alerts/alertEvaluator', () => ({
  evaluateTenantAlerts: vi.fn(async () => 0),
}));

import { evaluateTenantAlerts } from '@/lib/services/alerts/alertEvaluator';
import { findInstanceAssignment } from '@/lib/core/cluster';
import { getAlertSchedulerStatus, triggerAlertSchedulerRun } from '@/lib/services/alerts/alertScheduler';

const tenants = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `t${i}`, dbName: `db${i}`, slug: `s${i}`, companyName: `C${i}` }));

describe('alert scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.acquireLock.mockResolvedValue('token');
    cache.releaseLock.mockResolvedValue(undefined);
    mainDb.listTenants.mockResolvedValue(tenants(2));
    vi.mocked(evaluateTenantAlerts).mockResolvedValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the lock for ten minutes so a fan-out sweep outlives the one-minute tick, and releases it', async () => {
    await triggerAlertSchedulerRun();
    expect(cache.acquireLock).toHaveBeenCalledWith('scheduler:alert-evaluation', 600);
    expect(cache.releaseLock).toHaveBeenCalledWith('scheduler:alert-evaluation', 'token');
  });

  it('evaluates every tenant inside its own scope and sums the fired alerts', async () => {
    vi.mocked(evaluateTenantAlerts).mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    expect(await triggerAlertSchedulerRun()).toEqual({ firedCount: 3, processedTenants: 2 });
    expect(evaluateTenantAlerts).toHaveBeenCalledTimes(2);
    expect(vi.mocked(evaluateTenantAlerts).mock.calls[0][0]).toMatchObject({ tenantDbName: 'db0', tenantId: 't0', tenantSlug: 's0' });
  });

  it('bounds each tenant: a deadline inside the lock TTL and within five minutes is passed down', async () => {
    const before = Date.now();
    await triggerAlertSchedulerRun();
    const { deadlineMs } = vi.mocked(evaluateTenantAlerts).mock.calls[0][1]!;
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(deadlineMs).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(deadlineMs).toBeLessThan(before + 600_000);
  });

  it('a failing tenant does not stop the sweep', async () => {
    vi.mocked(evaluateTenantAlerts).mockRejectedValueOnce(new Error('tenant db down')).mockResolvedValueOnce(1);
    expect(await triggerAlertSchedulerRun()).toEqual({ firedCount: 1, processedTenants: 2 });
  });

  it('without the global lock only explicitly assigned rules run on this node', async () => {
    cache.acquireLock.mockResolvedValue(undefined);
    await triggerAlertSchedulerRun();
    const filter = vi.mocked(evaluateTenantAlerts).mock.calls[0][1]!.ruleFilter!;
    expect(await filter({ _id: 'r1' } as never)).toBe(false);
    vi.mocked(findInstanceAssignment).mockResolvedValueOnce({ nodeName: 'node-1' } as never);
    expect(await filter({ _id: 'r2' } as never)).toBe(true);
    vi.mocked(findInstanceAssignment).mockResolvedValueOnce({ nodeName: 'node-2' } as never);
    expect(await filter({ _id: 'r3' } as never)).toBe(false);
    expect(await filter({ _id: '' } as never)).toBe(false);
    expect(cache.releaseLock).not.toHaveBeenCalled();
  });

  it('with the lock, unassigned rules run', async () => {
    await triggerAlertSchedulerRun();
    const filter = vi.mocked(evaluateTenantAlerts).mock.calls[0][1]!.ruleFilter!;
    expect(await filter({ _id: 'r1' } as never)).toBe(true);
  });

  it('stops taking tenants once the sweep budget (lock TTL minus 30 s) is used up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    mainDb.listTenants.mockResolvedValue(tenants(3));
    vi.mocked(evaluateTenantAlerts).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 9 * 60_000);
      return 0;
    });
    const result = await triggerAlertSchedulerRun();
    expect(result.processedTenants).toBe(2);
    expect(evaluateTenantAlerts).toHaveBeenCalledTimes(2);
  });

  it('overlapping runs are skipped while one is in flight', async () => {
    let release!: () => void;
    vi.mocked(evaluateTenantAlerts).mockImplementationOnce(() => new Promise<number>((resolve) => { release = () => resolve(0); }));
    const first = triggerAlertSchedulerRun();
    await vi.waitFor(() => expect(getAlertSchedulerStatus().running).toBe(true));
    // The sweep awaits the tenant's service switch before it evaluates.
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await triggerAlertSchedulerRun()).toEqual({ firedCount: 0, processedTenants: 0 });
    release();
    await first;
    expect(getAlertSchedulerStatus().running).toBe(false);
    expect(cache.acquireLock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock and records the error when the sweep itself fails', async () => {
    mainDb.listTenants.mockRejectedValue(new Error('main db down'));
    await expect(triggerAlertSchedulerRun()).rejects.toThrow('main db down');
    expect(cache.releaseLock).toHaveBeenCalled();
    expect(getAlertSchedulerStatus()).toMatchObject({ lastError: 'main db down', running: false });
  });
});
