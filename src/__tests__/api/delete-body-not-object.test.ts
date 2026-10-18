/**
 * The vector-delete routes read `ids` off the JSON body: a body that is the JSON literal `null`
 * (or any non-object) answers 400 like an empty one, instead of failing while reading `ids`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

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
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    authorizeServiceForRequest: vi.fn(),
    requireProjectContextForRequest: vi.fn(async () => ({
      projectId: 'proj-1',
      user: { _id: 'user-1', role: 'owner' },
      session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', licenseType: 'ENTERPRISE' },
    })),
  };
});

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientVectorApiPlugin } from '@/server/api/plugins/client-vector';
import { vectorApiPlugin } from '@/server/api/plugins/vector';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const surfaces = [
  {
    label: 'dashboard',
    plugin: vectorApiPlugin,
    url: '/api/vector/indexes/idx/vectors?providerKey=p',
    headers: { 'content-type': 'application/json', 'x-license-type': 'ENTERPRISE', 'x-tenant-db-name': 'tenant_acme', 'x-tenant-id': 'tenant-1', 'x-user-id': 'user-1', 'x-user-role': 'owner' },
  },
  {
    label: 'client API',
    plugin: clientVectorApiPlugin,
    url: '/api/client/v1/vector/providers/p/indexes/idx/vectors',
    headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
  },
];

describe.each(surfaces)('DELETE vectors: $label', ({ plugin, url, headers }) => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: 'tok_abc',
      tokenRecord: { _id: 'tok-1', userId: 'user-1' },
      tenant: { licenseType: 'ENTERPRISE' },
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
      tenantDbName: 'tenant_acme',
      projectId: 'proj-1',
      user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
    });
    // The production JSON parser: the body stays the raw string.
    app = await createFastifyApiTestApp(plugin, { rawJsonBody: true });
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(['null', '"x"', '7', 'true'])('answers 400 for the JSON body %s', async (payload) => {
    const res = await app.inject({ method: 'DELETE', url, headers, payload });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Request body must be valid JSON');
  });
});
