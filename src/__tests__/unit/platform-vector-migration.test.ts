/**
 * A vector migration to or from a platform provider is refused when it is created; between the tenant's own providers
 * it is created as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(async () => undefined),
    findProviderByKey: vi.fn(),
    findVectorIndexByKey: vi.fn(),
    findVectorMigrationByKey: vi.fn(async () => null),
    createVectorMigration: vi.fn(async (input: unknown) => input),
  },
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));
vi.mock('@/lib/services/vector/vectorMigrationJob', () => ({
  enqueueVectorMigration: vi.fn(),
  requestVectorMigrationCancel: vi.fn(),
}));

import {
  VectorMigrationNotAvailableError,
  createVectorMigration,
} from '@/lib/services/vector/vectorMigrationService';

const request = (source: string, destination: string) => ({
  name: 'Move', sourceProviderKey: source, sourceIndexKey: 'a', destinationProviderKey: destination, destinationIndexKey: 'b', createdBy: 'u1',
});

beforeEach(() => {
  vi.clearAllMocks();
  h.db.findProviderByKey.mockImplementation(async (_tenantId: string, key: string) => ({ key, platform: key.startsWith('platform') ? true : undefined }));
  h.db.findVectorIndexByKey.mockImplementation(async (providerKey: string, key: string) => ({ providerKey, key, name: key }));
});

describe('createVectorMigration and platform providers', () => {
  it('refuses a source on a platform provider with 409 and the fixed message', async () => {
    const error = await createVectorMigration('db', 't1', 'p1', 'u1', request('platform-vector', 'own')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VectorMigrationNotAvailableError);
    expect(error).toMatchObject({ status: 409, message: 'Moving an index to or from this provider is not available.' });
    expect(h.db.createVectorMigration).not.toHaveBeenCalled();
  });

  it('refuses a destination on a platform provider', async () => {
    await expect(createVectorMigration('db', 't1', 'p1', 'u1', request('own', 'platform-vector')))
      .rejects.toBeInstanceOf(VectorMigrationNotAvailableError);
    expect(h.db.createVectorMigration).not.toHaveBeenCalled();
  });

  it('refuses a move inside one platform provider too', async () => {
    await expect(createVectorMigration('db', 't1', 'p1', 'u1', request('platform-vector', 'platform-vector')))
      .rejects.toBeInstanceOf(VectorMigrationNotAvailableError);
  });

  it('creates a migration between the tenant\'s own providers as before', async () => {
    await createVectorMigration('db', 't1', 'p1', 'u1', request('own', 'other'));
    expect(h.db.createVectorMigration).toHaveBeenCalledTimes(1);
  });
});
