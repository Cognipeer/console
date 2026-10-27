/**
 * Unit tests - `config.maxTokens` of a reranker (the output limit of one LLM scoring call).
 *
 * It is validated when a reranker is created or updated: a whole number from 1 up to 32768, or absent.
 * A bad value is refused before the database is touched.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn(),
}));

vi.mock('@/lib/services/reranker/strategies', () => ({
  getStrategy: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createReranker, updateReranker } from '@/lib/services/reranker/rerankerService';
import type { CreateRerankerRequest } from '@/lib/services/reranker/types';

const getDb = getDatabase as unknown as Mock;

function fakeDb() {
  return {
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    findRerankerByKey: vi.fn().mockResolvedValue(null),
    createReranker: vi.fn().mockImplementation(async (doc: Record<string, unknown>) => doc),
    updateReranker: vi.fn().mockImplementation(async (_id: string, updates: Record<string, unknown>) => updates),
  };
}

const create = (config: Record<string, unknown>, strategy: CreateRerankerRequest['strategy'] = 'llm-judge') =>
  createReranker('tenant_db', 'tenant-1', 'proj-1', {
    name: 'Scorer',
    strategy,
    config: config as CreateRerankerRequest['config'],
    createdBy: 'user-1',
  });

beforeEach(() => {
  getDb.mockReset();
});

describe('reranker config.maxTokens', () => {
  it.each([0, -1, 1.5, 32769, 100000, Number.NaN, Number.POSITIVE_INFINITY, '32', true, {}])(
    'create refuses %s before the database is touched',
    async (value) => {
      await expect(create({ modelKey: 'judge', maxTokens: value })).rejects.toThrow(
        /config\.maxTokens must be a whole number between 1 and 32768/,
      );
      expect(getDb).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 1, 32, 1024, 32768])('create accepts %s', async (value) => {
    const db = fakeDb();
    getDb.mockResolvedValue(db);

    await expect(create({ modelKey: 'judge', maxTokens: value })).resolves.toBeDefined();

    expect(db.createReranker).toHaveBeenCalledTimes(1);
  });

  it('is kept on the stored config', async () => {
    const db = fakeDb();
    getDb.mockResolvedValue(db);

    await create({ modelKey: 'judge', maxTokens: 2048 }, 'llm-listwise');

    expect(db.createReranker.mock.calls[0][0].config).toMatchObject({ modelKey: 'judge', maxTokens: 2048 });
  });

  it('applies to every strategy', async () => {
    await expect(create({ maxTokens: 0 }, 'heuristic')).rejects.toThrow(/config\.maxTokens/);
    await expect(create({ modelKey: 'm', maxTokens: 0 }, 'dedicated-model')).rejects.toThrow(/config\.maxTokens/);
    await expect(create({ modelKey: 'm', maxTokens: 0 }, 'llm-listwise')).rejects.toThrow(/config\.maxTokens/);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('the strategy checks still come first', async () => {
    await expect(create({ maxTokens: 64 }, 'llm-judge')).rejects.toThrow(/requires config\.modelKey/);
  });

  it('update refuses a bad value when it carries the strategy and config', async () => {
    await expect(
      updateReranker('tenant_db', 'rr-1', { strategy: 'llm-judge', config: { modelKey: 'judge', maxTokens: -3 } }),
    ).rejects.toThrow(/config\.maxTokens/);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('update refuses a bad value when it carries only the config', async () => {
    await expect(updateReranker('tenant_db', 'rr-1', { config: { maxTokens: 0 } })).rejects.toThrow(/config\.maxTokens/);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('update with a config that has no limit is left alone', async () => {
    const db = fakeDb();
    getDb.mockResolvedValue(db);

    await updateReranker('tenant_db', 'rr-1', { config: { batchSize: 2 } });

    expect(db.updateReranker).toHaveBeenCalledWith('rr-1', { config: { batchSize: 2 } });
  });

  it('update accepts a good value', async () => {
    const db = fakeDb();
    getDb.mockResolvedValue(db);

    await updateReranker('tenant_db', 'rr-1', { strategy: 'llm-judge', config: { modelKey: 'judge', maxTokens: 512 } });

    expect(db.updateReranker).toHaveBeenCalledWith('rr-1', expect.objectContaining({ config: { modelKey: 'judge', maxTokens: 512 } }));
  });
});
