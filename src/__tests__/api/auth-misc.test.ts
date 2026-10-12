import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

import { getDatabase } from '@/lib/database';
import { authApiPlugin } from '@/server/api/plugins/auth';
import {
  createFastifyApiTestApp,
  hasSetCookie,
  parseJsonBody,
} from '../helpers/fastify-api';

describe('auth misc routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  const mockUser = {
    _id: 'user-1',
    email: 'owner@acme.com',
    name: 'Owner',
    role: 'owner' as const,
    licenseId: 'FREE',
    features: ['LLM_CHAT'],
    tenantId: 'tenant-1',
    password: '$hashed',
    mustChangePassword: false,
    projectIds: ['proj-1', 'proj-2'],
  };

  const validHeaders = {
    'x-license-type': 'FREE',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 'tenant-1',
    'x-tenant-slug': 'acme',
    'x-user-id': 'user-1',
    'x-user-role': 'owner',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockResolvedValue(mockUser);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/auth/logout', () => {
    it('returns 200 with logout message', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ message: string }>(res.body);
      expect(body.message).toMatch(/logged out/i);
    });

    it('clears the token cookie', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(hasSetCookie(res.headers['set-cookie'], 'token')).toBe(true);
    });
  });

  describe('GET /api/auth/session', () => {
    async function session(headers: Record<string, string>) {
      return app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers,
      });
    }

    it('returns 401 when tenant-db-name header missing', async () => {
      const res = await session({
        'x-tenant-id': 'tenant-1',
        'x-user-id': 'user-1',
        'x-user-role': 'owner',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when user not found', async () => {
      db.findUserById.mockResolvedValue(null);
      const res = await session(validHeaders);
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with session info for valid user', async () => {
      const res = await session(validHeaders);
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{
        authenticated: boolean;
        role: string;
        projectCount: number;
        effectivePermissions: Record<string, string> | null;
        effectiveProjectId: string | null;
      }>(res.body);
      expect(body.authenticated).toBe(true);
      expect(body.role).toBe('owner');
      expect(body.projectCount).toBe(2);
      // what the engine allows the user, for navigation: an owner reaches admin level everywhere
      expect(body.effectivePermissions).toMatchObject({ agents: 'admin', models: 'admin', members: 'admin', iam: 'admin' });
      expect(Object.values(body.effectivePermissions ?? {}).every((level) => level === 'admin')).toBe(true);
      expect(body).toHaveProperty('effectiveProjectId');
    });

    it('still answers when the engine cannot say what the user may do: the levels are null', async () => {
      // the levels are a hint for the menu; they must never cost the user the session itself
      db.listProjects.mockRejectedValue(new Error('projects unavailable'));
      const res = await session(validHeaders);
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ authenticated: boolean; effectivePermissions: unknown; effectiveProjectId: unknown }>(res.body);
      expect(body).toMatchObject({ authenticated: true, effectivePermissions: null, effectiveProjectId: null });
    });

    it('returns mustChangePassword flag', async () => {
      db.findUserById.mockResolvedValue({ ...mockUser, mustChangePassword: true });
      const res = await session(validHeaders);
      const body = parseJsonBody<{ mustChangePassword: boolean }>(res.body);
      expect(body.mustChangePassword).toBe(true);
    });

    it('binds the tenant database (runWithTenant) before user lookup', async () => {
      await session(validHeaders);
      // The session wrapper binds the tenant for the whole handler via
      // runWithTenant (immune to the concurrent process-global race) rather
      // than a bare switchToTenant.
      expect(db.runWithTenant).toHaveBeenCalledWith('tenant_acme', expect.any(Function));
    });

    it('returns 500 on unexpected error', async () => {
      (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB fail'));
      const res = await session(validHeaders);
      expect(res.statusCode).toBe(500);
    });
  });
});
