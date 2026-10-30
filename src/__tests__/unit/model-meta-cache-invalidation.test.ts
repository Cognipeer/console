import { describe, it, expect, vi, beforeEach } from 'vitest';

const del = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(() => Promise.resolve({ del })),
}));

import { invalidateModelMetaCache } from '@/lib/services/models/modelService';

describe('invalidateModelMetaCache', () => {
  beforeEach(() => {
    del.mockClear();
  });

  it('drops model-meta and both AI App Gateway price keys per distinct key', async () => {
    await invalidateModelMetaCache('tenant_db', 'proj1', ['gpt', 'gpt', undefined, '']);
    const keys = del.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual(
      [
        'model-meta:tenant_db:proj1:gpt',
        'appgw:price:tenant_db:proj1:gpt',
        'appgw:price:tenant_db::gpt',
      ].sort(),
    );
  });

  it('never throws when the cache is unreachable', async () => {
    del.mockRejectedValueOnce(new Error('down'));
    await expect(invalidateModelMetaCache('t', 'p', ['k'])).resolves.toBeUndefined();
  });
});
