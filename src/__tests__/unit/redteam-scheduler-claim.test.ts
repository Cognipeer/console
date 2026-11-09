/**
 * Scheduled red-team scans are claimed per cron slot in the database before they
 * are enqueued, so several replicas ticking at once fire one slot once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  switchToTenant: vi.fn(async () => undefined),
  listRedTeamCampaigns: vi.fn(),
  listRedTeamRuns: vi.fn(),
  claimSchedulerSlot: vi.fn(),
  updateRedTeamRunIf: vi.fn(async () => ({})),
}));
const service = vi.hoisted(() => ({
  createAsyncRun: vi.fn(),
  executeRun: vi.fn(),
}));
const queue = vi.hoisted(() => ({ publish: vi.fn(async () => undefined) }));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getDatabase: vi.fn(async () => db),
}));
vi.mock('@/lib/services/redteam/service', () => service);
vi.mock('@/lib/core/queue', () => ({ getQueue: async () => queue }));

import { enqueueCampaignRun, runScheduledScans, scheduledSlotKey } from '@/lib/services/redteam/campaignJob';

const NOW = new Date('2026-06-04T05:00:00Z'); // after the 03:00 slot
const campaign = { _id: 'c1', key: 'nightly', projectId: 'proj-a', targetKind: 'model', schedule: { cron: '0 3 * * *', enabled: true } };

beforeEach(() => {
  vi.clearAllMocks();
  db.listRedTeamCampaigns.mockResolvedValue([campaign]);
  db.listRedTeamRuns.mockResolvedValue([]);
  service.createAsyncRun.mockResolvedValue({ campaign, run: { id: 'run-1' } });
});

describe('scheduled slot claim', () => {
  it('names the slot by tenant, campaign and the ISO minute of the cron slot', () => {
    expect(scheduledSlotKey('tenant_db', 'c1', new Date('2026-06-04T03:00:00Z'))).toBe('redteam:tenant_db:c1:2026-06-04T03:00');
  });

  it('claims the slot, then enqueues the scan', async () => {
    db.claimSchedulerSlot.mockResolvedValue(true);

    const result = await runScheduledScans('tenant_db', 'tenant-1', NOW);

    expect(db.claimSchedulerSlot).toHaveBeenCalledTimes(1);
    const [key, expiresAt] = db.claimSchedulerSlot.mock.calls[0] as unknown as [string, Date];
    expect(key).toBe('redteam:tenant_db:c1:2026-06-04T03:00');
    expect(expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(service.createAsyncRun).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ fired: ['nightly'], errors: [], claimedElsewhere: [] });
  });

  it('skips the slot when another replica claimed it', async () => {
    db.claimSchedulerSlot.mockResolvedValue(false);

    const result = await runScheduledScans('tenant_db', 'tenant-1', NOW);

    expect(service.createAsyncRun).not.toHaveBeenCalled();
    expect(result).toEqual({ fired: [], errors: [], claimedElsewhere: ['nightly'] });
  });

  it('fires one slot once when two replicas tick together', async () => {
    // The database lets the first insert win and refuses the second.
    db.claimSchedulerSlot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const [a, b] = await Promise.all([
      runScheduledScans('tenant_db', 'tenant-1', NOW),
      runScheduledScans('tenant_db', 'tenant-1', NOW),
    ]);

    expect(service.createAsyncRun).toHaveBeenCalledTimes(1);
    expect(a.fired.length + b.fired.length).toBe(1);
    expect(a.claimedElsewhere.length + b.claimedElsewhere.length).toBe(1);
  });

  it('claims nothing for a campaign that is not due', async () => {
    db.listRedTeamRuns.mockResolvedValue([{ startedAt: new Date('2026-06-04T03:30:00Z'), createdAt: new Date('2026-06-04T03:30:00Z') }]);

    const result = await runScheduledScans('tenant_db', 'tenant-1', NOW);

    expect(db.claimSchedulerSlot).not.toHaveBeenCalled();
    expect(result.fired).toEqual([]);
  });

  it('reports a scan that cannot start (its slot stays claimed)', async () => {
    db.claimSchedulerSlot.mockResolvedValue(true);
    service.createAsyncRun.mockRejectedValue(new Error('A run for campaign "nightly" is already in progress'));

    const result = await runScheduledScans('tenant_db', 'tenant-1', NOW);

    expect(result.fired).toEqual([]);
    expect(result.errors).toEqual(['nightly: A run for campaign "nightly" is already in progress']);
    expect(db.claimSchedulerSlot).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueCampaignRun queue failure', () => {
  it('ends the pending run as failed and rethrows when the publish throws', async () => {
    const boom = new Error('queue down');
    queue.publish.mockRejectedValueOnce(boom);

    await expect(
      enqueueCampaignRun({ tenantDbName: 'tenant_db', tenantId: 'tenant-1', createdBy: 'u1', campaignKey: 'nightly' }),
    ).rejects.toBe(boom);

    expect(db.updateRedTeamRunIf).toHaveBeenCalledTimes(1);
    const [id, guard, patch] = db.updateRedTeamRunIf.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(id).toBe('run-1');
    expect(guard).toEqual({ status: 'pending' });
    expect(patch).toMatchObject({ status: 'failed', error: 'The scan could not be queued; try again.' });
    expect(patch.finishedAt).toBeInstanceOf(Date);
  });
});
