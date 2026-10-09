/**
 * The global cookie-session hook (fastifyApiPlugin onRequest) re-checks the
 * account on EVERY cookie-authenticated request, mapped to an RBAC service or
 * not. Cookie JWTs are stateless 7-day tokens, so without this a disabled or
 * deleted user would keep full API access until the cookie expired.
 *
 * Runs the real hook on a bare Fastify instance; only the JWT verification,
 * the readiness flag and the account-state lookup are stubbed.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const h = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUserAuthState: vi.fn(),
}));

// Handlers that do run (the "active" control) must not reach a real database.
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  const { createMockDb } = await import('../helpers/db.mock');
  const db = createMockDb();
  return { ...actual, getDatabase: vi.fn(async () => db) };
});
vi.mock('@/server/bootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/bootstrap')>();
  return { ...actual, isApplicationReady: () => true };
});
vi.mock('@/lib/license/token-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/license/token-manager')>();
  return { ...actual, TokenManager: { ...actual.TokenManager, verifyToken: h.verifyToken } };
});
vi.mock('@/lib/services/users/userAuthState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/users/userAuthState')>();
  return { ...actual, getUserAuthState: h.getUserAuthState };
});

import { fastifyApiPlugin } from '@/server/api/plugin';

const payload = {
  userId: 'user-1',
  email: 'a@acme.com',
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  role: 'admin',
  licenseId: 'FREE',
  licenseType: 'FREE',
  features: [],
};

// Mostly paths that are NOT mapped to an RBAC service (loadRbacUser never
// runs there) plus one mapped path, to prove the check is path-independent.
// (The hook only runs for routes that exist; unknown URLs 404 before it.)
const ROUTES: Array<[method: 'GET' | 'POST', url: string]> = [
  ['GET', '/api/dashboard'],
  ['GET', '/api/auth/session'],
  ['POST', '/api/auth/change-password'],
  ['GET', '/api/users'],
];

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(fastifyApiPlugin, { prefix: '/api' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyToken.mockResolvedValue(payload);
});

const call = (url: string, method: 'GET' | 'POST' = 'GET') => app.inject({
  method,
  url,
  headers: { cookie: 'token=jwt; active_project_id=p1' },
});

function clearedCookies(res: Awaited<ReturnType<typeof call>>): string[] {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((c) => /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c)).map((c) => c.split('=')[0]);
}

describe('cookie session hook: account state', () => {
  it.each(ROUTES)('401 account_disabled + cookies cleared on %s %s', async (method, url) => {
    h.getUserAuthState.mockResolvedValue('disabled');
    const res = await call(url, method);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'Unauthorized',
      message: 'Account is disabled',
      code: 'account_disabled',
    });
    expect(clearedCookies(res)).toEqual(expect.arrayContaining(['token', 'active_project_id']));
  });

  it('401 account_missing + cookies cleared for a deleted user', async () => {
    h.getUserAuthState.mockResolvedValue('missing');
    const res = await call('/api/dashboard');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ message: 'Account no longer exists', code: 'account_missing' });
    expect(clearedCookies(res)).toContain('token');
  });

  it('fails closed with 503 (no cookie clearing) when the state cannot be read', async () => {
    h.getUserAuthState.mockRejectedValue(new Error('db down'));
    const res = await call('/api/dashboard');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Service Unavailable', message: 'Unable to verify session' });
    expect(clearedCookies(res)).toEqual([]);
  });

  it('looks the account up with the session claims', async () => {
    h.getUserAuthState.mockResolvedValue('disabled');
    await call('/api/dashboard');
    expect(h.getUserAuthState).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'user-1');
  });

  it('lets an active account through to the route handler', async () => {
    h.getUserAuthState.mockResolvedValue('active');
    const res = await call('/api/auth/session');
    expect(h.getUserAuthState).toHaveBeenCalledTimes(1);
    expect(res.json()).not.toHaveProperty('code', 'account_disabled');
    expect(res.json()).not.toHaveProperty('code', 'account_missing');
    expect(clearedCookies(res)).toEqual([]);
  });

  it('does not run for Bearer client-API paths or public paths', async () => {
    h.getUserAuthState.mockResolvedValue('disabled');
    const client = await app.inject({ method: 'GET', url: '/api/client/v1/models' });
    expect(client.statusCode).toBe(401);
    expect(client.json().message).toMatch(/Authorization header/);
    const health = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(health.statusCode).not.toBe(401);
    expect(h.getUserAuthState).not.toHaveBeenCalled();
  });
});
