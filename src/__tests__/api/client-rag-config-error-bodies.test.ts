/**
 * Consistent error responses for the client RAG and client config APIs: an unexpected failure answers a
 * constant 500 body (the cause stays in the log), and the config service's own caller-correctable errors
 * keep their status and message.
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
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

// The route-level authorization gate is not under test here: every call is allowed.
vi.mock('@/lib/iam/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/iam/enforce')>()),
  decideEnforced: vi.fn(async () => ({ allowed: true, source: 'engine' })),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

vi.mock('@/lib/services/rag/ragService', () => ({
  createRagModule: vi.fn(),
  deleteRagModule: vi.fn(),
  getRagModule: vi.fn(),
  listRagModules: vi.fn(),
  getRagDocumentFullText: vi.fn(),
  getRagDocumentTextLines: vi.fn(),
  updateRagModule: vi.fn(),
  listRagDocuments: vi.fn(),
  ingestDocument: vi.fn(),
  ingestFile: vi.fn(),
  queryRag: vi.fn(),
  deleteRagDocument: vi.fn(),
  reingestDocument: vi.fn(),
  shapeRagQueryResponse: vi.fn((result: unknown) => result),
}));

vi.mock('@/lib/services/config/configService', () => {
  class ConfigServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ConfigServiceError';
      this.status = status;
    }
  }
  return {
    ConfigServiceError,
    createConfigGroup: vi.fn(),
    createConfigItem: vi.fn(),
    deleteConfigGroup: vi.fn(),
    deleteConfigItem: vi.fn(),
    getConfigGroupByKey: vi.fn(),
    getConfigGroupWithItems: vi.fn(),
    getConfigItem: vi.fn(),
    listConfigAuditLogs: vi.fn(),
    listConfigGroups: vi.fn(),
    listConfigItems: vi.fn(),
    resolveConfigValues: vi.fn(),
    updateConfigGroup: vi.fn(),
    updateConfigItem: vi.fn(),
  };
});

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { listRagModules } from '@/lib/services/rag/ragService';
import { ConfigServiceError, createConfigGroup, listConfigGroups } from '@/lib/services/config/configService';
import { clientRagApiPlugin } from '@/server/api/plugins/client-rag';
import { clientConfigApiPlugin } from '@/server/api/plugins/client-config';
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

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
  mockFn(getDatabase).mockResolvedValue(createMockDb({ runWithTenant } as never));
});

describe('client RAG API error bodies', () => {
  it('answers an unexpected failure with a constant 500 body', async () => {
    mockFn(listRagModules).mockRejectedValue(new Error('connection to db-internal:27017 refused'));
    const app = await createFastifyApiTestApp(clientRagApiPlugin);

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/rag/modules',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('client config API error bodies', () => {
  it('answers an unexpected failure with a constant 500 body', async () => {
    mockFn(listConfigGroups).mockRejectedValue(new Error('connection to db-internal:27017 refused'));
    const app = await createFastifyApiTestApp(clientConfigApiPlugin);

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/config/groups',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal server error' });
  });

  it('keeps the status and message of a request the config service refuses for the caller to correct', async () => {
    mockFn(createConfigGroup).mockRejectedValue(new ConfigServiceError('Config group with key "app" already exists.', 409));
    const app = await createFastifyApiTestApp(clientConfigApiPlugin);

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/config/groups',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { name: 'App', key: 'app' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Config group with key "app" already exists.' });
  });
});
