/**
 * Unit tests — resuming a paused OCR job re-enqueues the items it held.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  publish: vi.fn().mockResolvedValue(undefined),
  db: {
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    findOcrJobById: vi.fn(),
    updateOcrJob: vi.fn(),
    listOcrJobItems: vi.fn(),
    updateOcrJobItem: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => mocks.db) }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: mocks.publish })) }));
vi.mock('@/lib/services/files/fileService', () => ({ uploadFile: vi.fn() }));
vi.mock('@/lib/services/ocrJobs/ocrJobRunner', () => ({ processOcrItem: vi.fn(), OCR_ITEM_HELD_WHILE_PAUSED: 'held' }));

import { setOcrJobStatus } from '@/lib/services/ocrJobs/ocrJobService';

const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.updateOcrJob.mockImplementation(async (_id: string, patch: { status: string }) => ({ _id: 'job-1', ...patch }));
  mocks.db.listOcrJobItems.mockResolvedValue([
    { _id: 'i1', errorMessage: 'held' },
    { _id: 'i2', errorMessage: 'held' },
    // Still waiting in the queue (never reached the consumer): enqueuing it again would run it twice.
    { _id: 'i3' },
  ]);
});

describe('setOcrJobStatus', () => {
  it('enqueues the items held while the job was paused when it is resumed', async () => {
    mocks.db.findOcrJobById.mockResolvedValue({ _id: 'job-1', tenantId: 'tenant-1', status: 'paused' });

    await setOcrJobStatus(CTX, 'job-1', 'active');

    expect(mocks.db.listOcrJobItems).toHaveBeenCalledWith('job-1', { status: 'pending' });
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls[0][2]).toMatchObject({ itemId: 'i1', ctx: { tenantId: 'tenant-1' } });
    expect(mocks.publish.mock.calls.map((call) => (call[2] as { itemId: string }).itemId)).not.toContain('i3');
    expect(mocks.db.updateOcrJobItem).toHaveBeenCalledWith('i1', { errorMessage: '' });
  });

  it('enqueues nothing when pausing', async () => {
    mocks.db.findOcrJobById.mockResolvedValue({ _id: 'job-1', tenantId: 'tenant-1', status: 'active' });

    await setOcrJobStatus(CTX, 'job-1', 'paused');

    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
