/**
 * GET /api/auth/me - who the signed-in person is, and what of it they can change
 * themselves: the account page reads it. (The session payload that drives
 * navigation, GET /api/auth/session, is a different endpoint and is not touched.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({ recordAuditLog: vi.fn() }));

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // the audit write reads the tenant through the scope
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: h.recordAuditLog }));

import { getDatabase } from '@/lib/database';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

interface MeReply {
  userId: string;
  name: string;
  email: string;
  role: string;
  authProvider: string;
  canLogin: boolean;
  canChangePassword: boolean;
  managedFields: string[];
}

const headersFor = (userId: string, role: string) => ({
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': userId,
  'x-user-role': role,
  'x-license-type': 'FREE',
});

describe('GET /api/auth/me', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  const accounts: Record<string, Record<string, unknown>> = {
    'local-1': { _id: 'local-1', email: 'ada@acme.test', name: 'Ada Lovelace', role: 'admin', tenantId: 'tenant-1', password: 'secret-hash' },
    'ldap-1': { _id: 'ldap-1', email: 'lena@acme.test', name: 'Lena Ldap', role: 'user', tenantId: 'tenant-1', password: 'x', authProvider: 'ldap' },
    'sso-1': { _id: 'sso-1', email: 'sam@acme.test', name: 'Sam Sso', role: 'user', tenantId: 'tenant-1', password: 'x', authProvider: 'oidc' },
    'saml-1': { _id: 'saml-1', email: 'sia@acme.test', name: 'Sia Saml', role: 'user', tenantId: 'tenant-1', password: 'x', authProvider: 'saml' },
    'foreign-1': { _id: 'foreign-1', email: 'f@other.test', name: 'Foreign', role: 'user', tenantId: 'tenant-2', password: 'x' },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRateLimitStore();
    h.recordAuditLog.mockResolvedValue(undefined);
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation((async (id: string) => (accounts[id] ? { ...accounts[id] } : null)) as never);
    db.updateUser.mockImplementation((async (id: string, patch: object) => ({ ...accounts[id], ...patch })) as never);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const me = (userId: string, role = 'user') => app.inject({ method: 'GET', url: '/api/auth/me', headers: headersFor(userId, role) });

  it('describes a local account, which can change its password and edit nothing in a directory', async () => {
    const res = await me('local-1', 'admin');
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<MeReply>(res.body)).toEqual({
      userId: 'local-1',
      name: 'Ada Lovelace',
      email: 'ada@acme.test',
      role: 'admin',
      authProvider: 'local',
      canLogin: true,
      canChangePassword: true,
      managedFields: [],
    });
  });

  it.each([['ldap-1', 'ldap'], ['sso-1', 'oidc'], ['saml-1', 'saml']])('describes %s: name, email and password belong to the directory (%s)', async (id, provider) => {
    const body = parseJsonBody<MeReply>((await me(id)).body);
    expect(body).toMatchObject({ authProvider: provider, canChangePassword: false, managedFields: ['name', 'email', 'password'] });
  });

  it('reports the role the account has now, not the one the session was issued with', async () => {
    const body = parseJsonBody<MeReply>((await me('local-1', 'owner')).body);
    expect(body.role).toBe('admin');
  });

  it('never hands out the password hash or anything beyond the profile', async () => {
    const res = await me('local-1', 'admin');
    expect(res.body).not.toContain('secret-hash');
    expect(Object.keys(parseJsonBody<MeReply>(res.body)).sort()).toEqual([
      'authProvider', 'canChangePassword', 'canLogin', 'email', 'managedFields', 'name', 'role', 'userId',
    ]);
  });

  it('is 401 without a session, for an account that is gone and for one of another workspace', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await me('nobody')).statusCode).toBe(401);
    expect((await me('foreign-1')).statusCode).toBe(401);
  });
});

describe('PATCH /api/auth/profile', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  const accounts: Record<string, Record<string, unknown>> = {
    'local-1': { _id: 'local-1', email: 'ada@acme.test', name: 'Ada Lovelace', role: 'admin', tenantId: 'tenant-1', password: 'secret-hash' },
    'ldap-1': { _id: 'ldap-1', email: 'lena@acme.test', name: 'Lena Ldap', role: 'user', tenantId: 'tenant-1', password: 'x', authProvider: 'ldap' },
    'foreign-1': { _id: 'foreign-1', email: 'f@other.test', name: 'Foreign', role: 'user', tenantId: 'tenant-2', password: 'x' },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRateLimitStore();
    h.recordAuditLog.mockResolvedValue(undefined);
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation((async (id: string) => (accounts[id] ? { ...accounts[id] } : null)) as never);
    db.updateUser.mockImplementation((async (id: string, patch: object) => ({ ...accounts[id], ...patch })) as never);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const patch = (userId: string, body: unknown, role = 'user') => app.inject({
    method: 'PATCH', url: '/api/auth/profile', headers: { ...headersFor(userId, role), 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const reply = (res: { body: string }) => parseJsonBody<MeReply & { changed: string[]; code?: string; details?: Array<{ field: string }> }>(res.body);

  it('changes the name of a local account and answers with the account as GET /api/auth/me does', async () => {
    const res = await patch('local-1', { name: '  Ada King  ' }, 'admin');
    expect(res.statusCode).toBe(200);
    expect(reply(res)).toEqual({
      userId: 'local-1', name: 'Ada King', email: 'ada@acme.test', role: 'admin', authProvider: 'local', canLogin: true,
      canChangePassword: true, managedFields: [], changed: ['name'],
    });
    expect(db.updateUser).toHaveBeenCalledWith('local-1', { name: 'Ada King' });
    expect(res.body).not.toContain('secret-hash');
  });

  it('writes nothing when the name is the one it already is', async () => {
    const res = await patch('local-1', { name: 'Ada Lovelace' });
    expect(res.statusCode).toBe(200);
    expect(reply(res).changed).toEqual([]);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('is only for the name: nothing else, and a name of two to 120 characters', async () => {
    for (const body of [{}, { email: 'x@acme.test' }, { name: 'Ada King', role: 'owner' }, [], '"Ada"']) {
      const res = await patch('local-1', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(reply(res).code).toBe('invalid_body');
    }
    for (const name of ['a', ' ', 'x'.repeat(121), 7, null]) {
      const res = await patch('local-1', { name });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(reply(res).details?.[0].field).toBe('name');
    }
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('is not for an account of a directory: the name is the directory\'s', async () => {
    const res = await patch('ldap-1', { name: 'Lena Renamed' });
    expect([res.statusCode, reply(res).code]).toEqual([409, 'directory_managed']);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('is 401 without a session, for an account that is gone and for one of another workspace', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/auth/profile', headers: { 'content-type': 'application/json' }, payload: '{"name":"Ada King"}' })).statusCode).toBe(401);
    expect((await patch('nobody', { name: 'Ada King' })).statusCode).toBe(401);
    expect((await patch('foreign-1', { name: 'Ada King' })).statusCode).toBe(401);
  });

  it('leaves one audit row that names the field - not the name - and no generic one', async () => {
    await patch('local-1', { name: 'Ada King' }, 'admin');
    await vi.waitFor(() => expect(h.recordAuditLog).toHaveBeenCalledTimes(1));
    expect(h.recordAuditLog.mock.calls[0][1]).toMatchObject({
      event: 'user.profile.update', service: 'members', resourceType: 'user', resourceId: 'local-1', actorUserId: 'local-1',
      method: 'PATCH', path: '/api/auth/profile', metadata: { changedFields: ['name'], self: true },
    });
    expect(JSON.stringify(h.recordAuditLog.mock.calls)).not.toContain('Ada King');
  });

  it('is rate limited per person', async () => {
    for (let i = 0; i < 30; i += 1) expect((await patch('local-1', { name: 'Ada Lovelace' })).statusCode).toBe(200);
    const limited = await patch('local-1', { name: 'Ada Lovelace' });
    expect([limited.statusCode, reply(limited).code]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
