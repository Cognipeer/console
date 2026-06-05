/**
 * Unit tests — OCR item runner (`processOcrItem`).
 * Covers idempotency (already-succeeded items), the success path with aggregate
 * roll-up + per-item webhook, exactly-once `job.completed` firing on the final
 * item, the failure path, and the archived-job short-circuit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/services/ocrJobs/ocrJobWebhook', () => ({
  sendOcrJobWebhook: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleOcrRequest: vi.fn(),
  handleChatCompletion: vi.fn(),
}));
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn().mockResolvedValue({ pricing: undefined }),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn().mockReturnValue({ totalCost: 0, currency: 'USD' }),
}));
vi.mock('@/lib/services/files/fileService', () => ({
  downloadFile: vi.fn(),
}));

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  findOcrJobItemById: vi.fn(),
  findOcrJobById: vi.fn(),
  updateOcrJobItem: vi.fn(),
  incrementOcrJobAggregates: vi.fn(),
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

import { processOcrItem } from '@/lib/services/ocrJobs/ocrJobRunner';
import { sendOcrJobWebhook } from '@/lib/services/ocrJobs/ocrJobWebhook';
import { handleOcrRequest } from '@/lib/services/models/inferenceService';

const sendWebhook = sendOcrJobWebhook as unknown as ReturnType<typeof vi.fn>;
const handleOcr = handleOcrRequest as unknown as ReturnType<typeof vi.fn>;

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' };

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'item-1',
    tenantId: 'tenant-1',
    jobId: 'job-1',
    index: 0,
    status: 'pending',
    source: { kind: 'inline', data: Buffer.from('file-bytes').toString('base64'), fileName: 'a.pdf' },
    fileName: 'a.pdf',
    ...overrides,
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'job-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    status: 'active',
    bucketKey: 'bucket',
    ocrModelKey: 'ocr-model',
    outputs: ['full_text'],
    callbackUrl: 'https://hook.example.com/ocr',
    itemsTotal: 1,
    itemsProcessed: 0,
    itemsFailed: 0,
    createdBy: 'user-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendWebhook.mockResolvedValue(true);
  handleOcr.mockResolvedValue({
    response: { text: 'extracted text', usage: { inputTokens: 10, outputTokens: 0, pages: 1 } },
    model: { pricing: undefined },
  });
  db.updateOcrJobItem.mockImplementation(async (id: string, data: Record<string, unknown>) => ({
    ...makeItem(),
    ...data,
    _id: id,
  }));
});

describe('processOcrItem', () => {
  it('returns null and skips when the item belongs to another tenant', async () => {
    db.findOcrJobItemById.mockResolvedValue(makeItem({ tenantId: 'other-tenant' }));
    const res = await processOcrItem(CTX, 'item-1');
    expect(res).toBeNull();
    expect(handleOcr).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-succeeded item is not reprocessed', async () => {
    db.findOcrJobItemById.mockResolvedValue(makeItem({ status: 'succeeded' }));
    const res = await processOcrItem(CTX, 'item-1');
    expect(res).toMatchObject({ status: 'succeeded' });
    expect(handleOcr).not.toHaveBeenCalled();
    expect(db.findOcrJobById).not.toHaveBeenCalled();
    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it('processes a pending item, rolls up aggregates and fires item.succeeded', async () => {
    db.findOcrJobItemById.mockResolvedValue(makeItem());
    db.findOcrJobById.mockResolvedValue(makeJob());
    // Not yet the final item → no job.completed.
    db.incrementOcrJobAggregates.mockResolvedValue(makeJob({ itemsProcessed: 1, itemsFailed: 0, itemsTotal: 2 }));

    await processOcrItem(CTX, 'item-1');

    expect(handleOcr).toHaveBeenCalledTimes(1);
    expect(db.updateOcrJobItem).toHaveBeenCalledWith('item-1', expect.objectContaining({ status: 'running' }));
    expect(db.updateOcrJobItem).toHaveBeenCalledWith('item-1', expect.objectContaining({ status: 'succeeded' }));
    expect(db.incrementOcrJobAggregates).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ itemsProcessed: 1 }),
      expect.any(Object),
    );
    const events = sendWebhook.mock.calls.map((c) => c[0].event);
    expect(events).toContain('item.succeeded');
    expect(events).not.toContain('job.completed');
  });

  it('fires job.completed exactly once when the final item settles', async () => {
    db.findOcrJobItemById.mockResolvedValue(makeItem());
    db.findOcrJobById.mockResolvedValue(makeJob());
    // Final item: processed + failed === total.
    db.incrementOcrJobAggregates.mockResolvedValue(makeJob({ itemsProcessed: 1, itemsFailed: 0, itemsTotal: 1 }));

    await processOcrItem(CTX, 'item-1');

    const completed = sendWebhook.mock.calls.filter((c) => c[0].event === 'job.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0][0].data).toMatchObject({ itemsTotal: 1, itemsProcessed: 1, itemsFailed: 0 });
  });

  it('does not fire job.completed while items remain pending', async () => {
    db.findOcrJobItemById.mockResolvedValue(makeItem());
    db.findOcrJobById.mockResolvedValue(makeJob({ itemsTotal: 3 }));
    db.incrementOcrJobAggregates.mockResolvedValue(makeJob({ itemsProcessed: 1, itemsFailed: 1, itemsTotal: 3 }));

    await processOcrItem(CTX, 'item-1');

    const events = sendWebhook.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('job.completed');
  });

  it('records a failure and fires item.failed when OCR throws', async () => {
    db.findOcrJobItemById.mockResolvedValue(makeItem());
    db.findOcrJobById.mockResolvedValue(makeJob());
    handleOcr.mockRejectedValue(new Error('ocr backend down'));
    db.incrementOcrJobAggregates.mockResolvedValue(makeJob({ itemsProcessed: 0, itemsFailed: 1, itemsTotal: 1 }));

    const res = await processOcrItem(CTX, 'item-1');

    expect(res).toBeNull();
    expect(db.updateOcrJobItem).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ status: 'failed', errorMessage: 'ocr backend down' }),
    );
    expect(db.incrementOcrJobAggregates).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ itemsFailed: 1 }),
      expect.any(Object),
    );
    const events = sendWebhook.mock.calls.map((c) => c[0].event);
    expect(events).toContain('item.failed');
    // The failing item was the last one → completion still fires.
    expect(events).toContain('job.completed');
  });

  it('short-circuits when the parent job is archived', async () => {
    db.findOcrJobItemById.mockResolvedValue(makeItem());
    db.findOcrJobById.mockResolvedValue(makeJob({ status: 'archived' }));
    db.incrementOcrJobAggregates.mockResolvedValue(makeJob({ itemsFailed: 1 }));

    const res = await processOcrItem(CTX, 'item-1');

    expect(res).toBeNull();
    expect(handleOcr).not.toHaveBeenCalled();
    expect(db.updateOcrJobItem).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ status: 'failed', errorMessage: 'Job archived' }),
    );
  });
});
