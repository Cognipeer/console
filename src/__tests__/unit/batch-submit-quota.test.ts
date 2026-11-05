/**
 * Unit tests — batch submit checks the model's request window with the number
 * of items, and is refused whole before anything is stored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createBatchJob: vi.fn(),
}));

vi.mock('@/lib/services/files/fileService', () => ({ downloadFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => ({
    switchToTenant: vi.fn(async () => {}),
    createBatchJob: mocks.createBatchJob,
  })),
}));

import { createBatch } from '@/lib/services/batch/batchService';

const ctx = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1', userId: 'u1', tokenId: 'tok1' };
const line = (model: string) => ({ body: { model, messages: [{ role: 'user', content: 'hi' }] } });

describe('createBatch quota', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks each model with its item count and refuses with 429 before storing', async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, reason: 'Request limit reached' });

    await expect(createBatch(ctx, {
      endpoint: '/v1/chat/completions',
      requests: [line('gpt'), line('gpt'), line('gpt')],
    })).rejects.toMatchObject({ name: 'QuotaExceededError', status: 429, message: 'Request limit reached' });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'llm', resourceKey: 'gpt', projectId: 'p1' }),
      { requests: 3 },
    );
    expect(mocks.createBatchJob).not.toHaveBeenCalled();
  });
});
