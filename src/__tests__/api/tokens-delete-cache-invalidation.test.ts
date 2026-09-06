/**
 * Regression test for F-08 (finance-institution assessment, 2026-09-05):
 * the API-token auth cache (requireApiTokenFromHeader, 60s TTL) had no
 * invalidation path on delete -- a deleted token stayed valid on every
 * replica for up to the cache's own TTL after the delete already succeeded.
 * DELETE /tokens/:id now looks up the deleted token's stored hash and
 * evicts the same cache entry the auth check would have hit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  listApiTokens: vi.fn(),
  listProjectApiTokens: vi.fn(),
  deleteApiToken: vi.fn(),
  deleteProjectApiToken: vi.fn(),
}));

const mockCacheDel = vi.hoisted(() => vi.fn());

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn().mockResolvedValue({ del: mockCacheDel, get: vi.fn(), set: vi.fn() }),
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn().mockReturnValue(null),
  authorizeServiceRequest: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock('@/lib/services/projects/projectContext', () => ({
  resolveProjectContext: vi.fn(),
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));

import { resolveProjectContext } from '@/lib/services/projects/projectContext';
import { apiAuthCacheKey } from '@/lib/services/apiTokenAuth';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const SESSION_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-email': 'owner@acme.test',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
  'x-license-type': 'enterprise',
};

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

async function buildApp() {
  return createFastifyApiTestApp(tokensApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(resolveProjectContext).mockResolvedValue({ projectId: 'proj-1' });
});

describe('DELETE /api/tokens/:id — invalidates the auth cache entry', () => {
  it('evicts the cache entry for the deleted project-scoped token (admin/owner path)', async () => {
    mockDb.listProjectApiTokens.mockResolvedValue([
      { _id: 'token-1', tenantId: 'tenant-1', projectId: 'proj-1', tokenHash: 'a'.repeat(64) },
    ]);
    mockDb.deleteProjectApiToken.mockResolvedValue(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tokens/token-1',
      headers: SESSION_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCacheDel).toHaveBeenCalledWith(apiAuthCacheKey('a'.repeat(64)));
  });

  it('evicts the cache entry for a self-owned token (user path)', async () => {
    mockDb.listApiTokens.mockResolvedValue([
      { _id: 'token-2', tenantId: 'tenant-1', projectId: 'proj-1', tokenHash: 'b'.repeat(64) },
    ]);
    mockDb.deleteApiToken.mockResolvedValue(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tokens/token-2',
      headers: { ...SESSION_HEADERS, 'x-user-role': 'user' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCacheDel).toHaveBeenCalledWith(apiAuthCacheKey('b'.repeat(64)));
  });

  it('does not touch the cache when the delete target was not found', async () => {
    mockDb.listProjectApiTokens.mockResolvedValue([]);
    mockDb.deleteProjectApiToken.mockResolvedValue(false);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tokens/does-not-exist',
      headers: SESSION_HEADERS,
    });

    expect(res.statusCode).toBe(404);
    expect(mockCacheDel).not.toHaveBeenCalled();
  });

  it('still deletes successfully even if the cache eviction itself fails (best-effort)', async () => {
    mockDb.listProjectApiTokens.mockResolvedValue([
      { _id: 'token-3', tenantId: 'tenant-1', projectId: 'proj-1', tokenHash: 'c'.repeat(64) },
    ]);
    mockDb.deleteProjectApiToken.mockResolvedValue(true);
    mockCacheDel.mockRejectedValueOnce(new Error('cache unavailable'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tokens/token-3',
      headers: SESSION_HEADERS,
    });

    expect(res.statusCode).toBe(200);
  });
});
