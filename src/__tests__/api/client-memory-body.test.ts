/**
 * The client memory API answers 400 to a body that is not a JSON object
 * (a literal `null`, a bare string or number), not 500 as for a server fault.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/services/memory/memoryService', () => {
  class MemoryItemNotFoundError extends Error {}
  class MemoryStoreFullError extends Error {}
  class MemoryStoreInputError extends Error {
    statusCode = 400;
  }
  return {
    addMemory: vi.fn(),
    addMemoryBatch: vi.fn(),
    createMemoryStore: vi.fn(),
    deleteMemoryItem: vi.fn(),
    deleteMemoryItemsBulk: vi.fn(),
    deleteMemoryStore: vi.fn(),
    getMemoryItem: vi.fn(),
    getMemoryStore: vi.fn(),
    listMemoryItems: vi.fn(),
    listMemoryStores: vi.fn(),
    recallForChat: vi.fn(),
    searchMemories: vi.fn(),
    updateMemoryItem: vi.fn(),
    updateMemoryStore: vi.fn(),
    MemoryItemNotFoundError,
    MemoryStoreFullError,
    MemoryStoreInputError,
  };
});

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { createMemoryStore, updateMemoryStore, addMemory, addMemoryBatch, searchMemories, recallForChat, updateMemoryItem } from '@/lib/services/memory/memoryService';
import { clientMemoryApiPlugin } from '@/server/api/plugins/client-memory';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-a',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
  mockFn(getDatabase).mockResolvedValue(createMockDb());
});

const ROUTES: Array<[string, string, string]> = [
  ['POST', '/api/client/v1/memory/stores', 'create store'],
  ['PATCH', '/api/client/v1/memory/stores/mem-a', 'update store'],
  ['POST', '/api/client/v1/memory/stores/mem-a/memories', 'add memory'],
  ['POST', '/api/client/v1/memory/stores/mem-a/memories/batch', 'batch add'],
  ['PATCH', '/api/client/v1/memory/stores/mem-a/memories/m-1', 'update memory'],
  ['POST', '/api/client/v1/memory/stores/mem-a/search', 'search'],
  ['POST', '/api/client/v1/memory/stores/mem-a/recall', 'recall'],
];

describe('client memory API — a body that is not a JSON object', () => {
  for (const [method, url, label] of ROUTES) {
    for (const payload of ['null', '"abc"', '5']) {
      it(`${label} (${method}) answers 400 to ${payload}`, async () => {
        const app = await createFastifyApiTestApp(clientMemoryApiPlugin, { rawJsonBody: true });
        const res = await app.inject({
          method: method as 'POST' | 'PATCH',
          url,
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          payload,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'Request body must be a JSON object' });
        for (const fn of [createMemoryStore, updateMemoryStore, addMemory, addMemoryBatch, searchMemories, recallForChat, updateMemoryItem]) {
          expect(fn).not.toHaveBeenCalled();
        }
      });
    }
  }
});
