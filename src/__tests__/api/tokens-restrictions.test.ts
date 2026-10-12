/**
 * Dashboard token routes with expiry + IP allowlist + the tenant token policy:
 *   POST /api/tokens, GET /api/tokens, GET /api/tokens/policy, PUT /api/tokens/:id
 *   POST|GET|PUT /api/projects/:projectId/tokens
 *   POST /api/client/v1/users/:id/tokens (a token minting a token)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({ db: null as unknown, cacheDel: vi.fn() }));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), del: h.cacheDel })),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn().mockResolvedValue({ projectId: 'proj-1' }),
  };
});
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));

import { reloadConfig } from '@/lib/core/config';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { resetIamSettingsCacheForTests } from '@/lib/iam/settings';
import { apiAuthCacheKey } from '@/lib/services/apiTokenAuth';
import { clientUsersApiPlugin } from '@/server/api/plugins/client-users';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
const DAY = 86_400_000;
const NOW = Date.now();

function headers(userId: string, role: string) {
  return {
    'content-type': 'application/json',
    'x-license-type': 'STARTER',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': TENANT,
    'x-tenant-slug': 'acme',
    'x-user-email': `${userId}@acme.test`,
    'x-user-id': userId,
    'x-user-role': role,
  };
}

const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT },
  'pa-1': { _id: 'pa-1', role: 'project_admin', tenantId: TENANT },
  'user-1': { _id: 'user-1', role: 'user', tenantId: TENANT },
  'user-2': { _id: 'user-2', role: 'user', tenantId: TENANT },
  'svc-1': { _id: 'svc-1', role: 'user', tenantId: TENANT, canLogin: false },
};

function setPolicy(db: ReturnType<typeof createMockDb>, tokens: { maxLifetimeDays: number | null; requireExpiry: boolean } | null) {
  db.iamDocGet.mockResolvedValue((tokens ? { id: 'settings', data: { tokens }, updatedAt: new Date() } : null) as never);
}

type TokenReply = Record<string, unknown>;

describe('token routes: expiry, IP allowlist and the tenant policy', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  const store: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    resetIamSettingsCacheForTests();
    store.length = 0;
    db = createMockDb();
    h.db = db;
    setPolicy(db, null);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] ? { ...USERS[id] } : null) as never);
    db.listProjectApiTokens.mockImplementation(async () => store.map((t) => ({ ...t })) as never);
    db.listApiTokens.mockImplementation(async (userId: string) => store.filter((t) => t.userId === userId).map((t) => ({ ...t })) as never);
    db.findApiTokenById.mockImplementation(async (id: string) => {
      const found = store.find((t) => t._id === id);
      return (found ? { ...found } : null) as never;
    });
    db.updateApiToken.mockImplementation(async (id: string, _tenantId: string, patch: Record<string, unknown>) => {
      const found = store.find((t) => t._id === id);
      if (!found) return null as never;
      Object.assign(found, patch);
      return { ...found } as never;
    });
    db.createApiToken.mockImplementation(async (input: Record<string, unknown>) => {
      const created = { _id: `tok-${store.length + 1}`, createdAt: new Date(), ...input };
      store.push(created);
      return created as never;
    });
    db.findProjectById.mockResolvedValue({ _id: 'proj-1', tenantId: TENANT } as never);
    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(tokensApiPlugin);
      await instance.register(projectsApiPlugin);
      await instance.register(clientUsersApiPlugin);
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (who: [string, string], payload: Record<string, unknown>, url = '/api/tokens') =>
    app.inject({ method: 'POST', url, headers: headers(...who), payload: JSON.stringify(payload) });
  const put = (who: [string, string], id: string, payload: unknown, url = `/api/tokens/${id}`) =>
    app.inject({ method: 'PUT', url, headers: headers(...who), payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const bare = (who: [string, string]) => {
    const { 'content-type': _contentType, ...rest } = headers(...who);
    void _contentType;
    return rest;
  };
  const get = (who: [string, string], url = '/api/tokens') =>
    app.inject({ method: 'GET', url, headers: bare(who) });

  const OWNER: [string, string] = ['owner-1', 'owner'];
  const ADMIN: [string, string] = ['admin-1', 'admin'];
  const PA: [string, string] = ['pa-1', 'project_admin'];
  const USER: [string, string] = ['user-1', 'user'];

  // ── create ────────────────────────────────────────────────────────────────

  describe('POST /api/tokens', () => {
    it('stores a normalized allowlist and an expiry, and answers with them', async () => {
      const res = await post(USER, {
        label: 'ci token',
        expiresInDays: 30,
        allowedIpRanges: [' 203.0.113.0/24 ', '198.51.100.9', '203.0.113.0/24', '2001:DB8::/32'],
      });
      expect(res.statusCode).toBe(201);
      const body = parseJsonBody<TokenReply>(res.body);
      expect(body.allowedIpRanges).toEqual(['203.0.113.0/24', '198.51.100.9/32', '2001:db8::/32']);
      const expiresAt = new Date(body.expiresAt as string).getTime();
      expect(expiresAt).toBeGreaterThan(NOW + 29 * DAY);
      expect(expiresAt).toBeLessThan(Date.now() + 31 * DAY);
      expect(body).toMatchObject({ lastUsedAt: null, exceedsTenantPolicy: false });
      expect(typeof body.token).toBe('string');

      const created = db.createApiToken.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(created.allowedIpRanges).toEqual(['203.0.113.0/24', '198.51.100.9/32', '2001:db8::/32']);
      expect(created.expiresAt).toBeInstanceOf(Date);
    });

    it('without the new fields it mints exactly what it always did', async () => {
      const res = await post(USER, { label: 'plain token' });
      expect(res.statusCode).toBe(201);
      const body = parseJsonBody<TokenReply>(res.body);
      expect(body).toMatchObject({ expiresAt: null, allowedIpRanges: null });
      const created = db.createApiToken.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect('expiresAt' in created).toBe(false);
      expect('allowedIpRanges' in created).toBe(false);
    });

    it('accepts an absolute expiresAt', async () => {
      const at = new Date(NOW + 10 * DAY).toISOString();
      const res = await post(USER, { label: 'dated token', expiresAt: at });
      expect(res.statusCode).toBe(201);
      expect(parseJsonBody<TokenReply>(res.body).expiresAt).toBe(at);
    });

    it('refuses bad restrictions and creates nothing', async () => {
      for (const [payload, code] of [
        [{ label: 'bad ranges', allowedIpRanges: ['10.0.0.0/33'] }, 'invalid_ip_ranges'],
        [{ label: 'not array', allowedIpRanges: '10.0.0.0/8' }, 'invalid_ip_ranges'],
        [{ label: 'past expiry', expiresAt: '2020-01-01T00:00:00Z' }, 'token_expiry_invalid'],
        [{ label: 'garbage expiry', expiresAt: 'soon' }, 'token_expiry_invalid'],
        [{ label: 'both fields', expiresAt: new Date(NOW + DAY).toISOString(), expiresInDays: 3 }, 'token_expiry_invalid'],
        [{ label: 'zero days', expiresInDays: 0 }, 'token_expiry_invalid'],
      ] as const) {
        const res = await post(USER, payload as unknown as Record<string, unknown>);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(parseJsonBody<TokenReply>(res.body).code, JSON.stringify(payload)).toBe(code);
      }
      expect(db.createApiToken).not.toHaveBeenCalled();
    });

    it('reports every bad range with its position', async () => {
      const res = await post(USER, { label: 'bad ranges', allowedIpRanges: ['10.0.0.0/8', 'nope', '10.0.0.0/40'] });
      const body = parseJsonBody<{ code: string; details: Array<{ index: number; value: string }> }>(res.body);
      expect(body.code).toBe('invalid_ip_ranges');
      expect(body.details.map((d) => [d.index, d.value])).toEqual([[1, 'nope'], [2, '10.0.0.0/40']]);
    });

    it('requireExpiry: a token without an expiry is refused, with one it is created', async () => {
      setPolicy(db, { maxLifetimeDays: null, requireExpiry: true });
      const refused = await post(USER, { label: 'eternal token' });
      expect(refused.statusCode).toBe(400);
      expect(parseJsonBody<TokenReply>(refused.body).code).toBe('token_expiry_required');
      expect(db.createApiToken).not.toHaveBeenCalled();
      const ok = await post(USER, { label: 'dated token', expiresInDays: 3650 });
      expect(ok.statusCode).toBe(201);
    });

    it('maximum lifetime: refuses a longer token (and an unlimited one), accepts the maximum', async () => {
      setPolicy(db, { maxLifetimeDays: 30, requireExpiry: false });
      const tooLong = await post(USER, { label: 'long token', expiresInDays: 31 });
      expect(tooLong.statusCode).toBe(400);
      const body = parseJsonBody<{ code: string; details: { maxLifetimeDays: number; latestExpiresAt: string } }>(tooLong.body);
      expect(body.code).toBe('token_expiry_too_long');
      expect(body.details.maxLifetimeDays).toBe(30);
      expect(Number.isNaN(Date.parse(body.details.latestExpiresAt))).toBe(false);

      const unlimited = await post(USER, { label: 'eternal token' });
      expect(unlimited.statusCode).toBe(400);
      expect(parseJsonBody<TokenReply>(unlimited.body).code).toBe('token_expiry_required');

      const exact = await post(USER, { label: 'monthly token', expiresInDays: 30 });
      expect(exact.statusCode).toBe(201);
      expect(parseJsonBody<TokenReply>(exact.body).exceedsTenantPolicy).toBe(false);
    });

    it('applies to a token an admin mints for another user too', async () => {
      setPolicy(db, { maxLifetimeDays: 30, requireExpiry: false });
      const refused = await post(ADMIN, { label: 'svc token', userId: 'svc-1' });
      expect(refused.statusCode).toBe(400);
      const ok = await post(ADMIN, { label: 'svc token', userId: 'svc-1', expiresInDays: 10, allowedIpRanges: ['10.0.0.0/8'] });
      expect(ok.statusCode).toBe(201);
      expect(parseJsonBody<TokenReply>(ok.body)).toMatchObject({ userId: 'svc-1', allowedIpRanges: ['10.0.0.0/8'] });
    });

    it('fails closed with 503 when the policy cannot be read', async () => {
      db.iamDocGet.mockRejectedValue(new Error('iam_meta unreachable'));
      const res = await post(USER, { label: 'any token', expiresInDays: 1 });
      expect(res.statusCode).toBe(503);
      expect(parseJsonBody<TokenReply>(res.body).code).toBe('policy_unavailable');
      expect(db.createApiToken).not.toHaveBeenCalled();
    });

    it('keeps the label rule', async () => {
      const res = await post(USER, { label: 'ab' });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<TokenReply>(res.body).error).toBe('Label must be at least 3 characters');
    });
  });

  // ── policy + list ─────────────────────────────────────────────────────────

  describe('GET /api/tokens/policy', () => {
    it('returns the rules and the address the server sees', async () => {
      setPolicy(db, { maxLifetimeDays: 90, requireExpiry: false });
      const res = await app.inject({
        method: 'GET', url: '/api/tokens/policy', remoteAddress: '203.0.113.9', headers: bare(USER),
      });
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<TokenReply>(res.body)).toEqual({
        maxLifetimeDays: 90,
        requireExpiry: false,
        expiryRequired: true,
        maxIpRanges: 100,
        clientIp: '203.0.113.9',
        trustsForwardedHeaders: expect.any(Boolean),
      });
    });

    it('defaults to "no rule"', async () => {
      const res = await get(USER, '/api/tokens/policy');
      expect(parseJsonBody<TokenReply>(res.body)).toMatchObject({ maxLifetimeDays: null, requireExpiry: false, expiryRequired: false });
    });

    it('says whether the server trusts forwarded headers from everyone (no TRUSTED_PROXIES)', async () => {
      const previous = process.env.TRUSTED_PROXIES;
      try {
        delete process.env.TRUSTED_PROXIES;
        reloadConfig();
        expect(parseJsonBody<TokenReply>((await get(USER, '/api/tokens/policy')).body).trustsForwardedHeaders).toBe(true);
        process.env.TRUSTED_PROXIES = '10.0.0.0/8';
        reloadConfig();
        expect(parseJsonBody<TokenReply>((await get(USER, '/api/tokens/policy')).body).trustsForwardedHeaders).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.TRUSTED_PROXIES;
        else process.env.TRUSTED_PROXIES = previous;
        reloadConfig();
      }
    });
  });

  describe('GET /api/tokens', () => {
    it('lists expiry, allowlist, lastUsedAt, edit rights and the policy flag of the caller\'s own tokens', async () => {
      store.push(
        { _id: 'old', userId: 'user-1', tenantId: TENANT, projectId: 'proj-1', label: 'old token', tokenPrefix: 'cpeer_a', createdAt: new Date(NOW - 5 * DAY), tokenHash: 'h1' },
        {
          _id: 'new', userId: 'user-1', tenantId: TENANT, projectId: 'proj-1', label: 'new token', tokenPrefix: 'cpeer_b',
          createdAt: new Date(NOW - DAY), expiresAt: new Date(NOW + 20 * DAY), allowedIpRanges: ['10.0.0.0/8'],
          lastUsed: new Date(NOW - 3_600_000), tokenHash: 'h2',
        },
        // somebody else's token: not part of this person's list
        { _id: 'theirs', userId: 'owner-1', tenantId: TENANT, projectId: 'proj-1', label: 'owner secret', tokenPrefix: 'cpeer_c', createdAt: new Date(NOW - DAY), allowedIpRanges: ['192.0.2.0/24'], tokenHash: 'h3' },
      );
      setPolicy(db, { maxLifetimeDays: null, requireExpiry: true });
      const res = await get(USER);
      expect(res.statusCode).toBe(200);
      const { tokens } = parseJsonBody<{ tokens: TokenReply[] }>(res.body);
      const byId = Object.fromEntries(tokens.map((t) => [t._id as string, t]));
      expect(Object.keys(byId).sort()).toEqual(['new', 'old']);
      expect(byId.old).toMatchObject({ expiresAt: null, allowedIpRanges: null, lastUsedAt: null, exceedsTenantPolicy: true, canEdit: true, canDelete: true });
      // everything listed is editable by the caller, so the ranges are shown to them
      expect(byId.new).toMatchObject({ allowedIpRanges: ['10.0.0.0/8'], ipRestricted: true, allowedIpRangeCount: 1, exceedsTenantPolicy: false, canEdit: true, canDelete: true });
      expect(byId.old).toMatchObject({ ipRestricted: false, allowedIpRangeCount: 0 });
      expect(typeof byId.new.lastUsedAt).toBe('string');
      expect(JSON.stringify(tokens)).not.toContain('owner secret');
      expect(JSON.stringify(tokens)).not.toContain('192.0.2.0');
      expect(JSON.stringify(tokens)).not.toContain('"h1"');
      expect(JSON.stringify(tokens)).not.toContain('tokenHash');
    });

    it('lists only the caller\'s own tokens, whatever the role', async () => {
      store.push(
        { _id: 'o', userId: 'owner-1', tenantId: TENANT, projectId: 'proj-1', label: 'owner token', createdAt: new Date() },
        { _id: 'a', userId: 'admin-1', tenantId: TENANT, projectId: 'proj-1', label: 'admin token', createdAt: new Date() },
        { _id: 'p', userId: 'pa-1', tenantId: TENANT, projectId: 'proj-1', label: 'pa token', createdAt: new Date() },
        { _id: 'u', userId: 'user-1', tenantId: TENANT, projectId: 'proj-1', label: 'user token', createdAt: new Date() },
      );
      for (const [who, expected] of [[OWNER, 'o'], [ADMIN, 'a'], [PA, 'p'], [USER, 'u']] as const) {
        const res = await get(who);
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody<{ tokens: TokenReply[] }>(res.body).tokens.map((t) => t._id)).toEqual([expected]);
      }
    });

    it('an admin who opens a user by id (?userId=) does see the ranges of that user\'s token', async () => {
      store.push({ _id: 'tok-r', userId: 'user-1', tenantId: TENANT, projectId: 'proj-1', label: 'restricted', allowedIpRanges: ['10.0.0.0/8', '192.0.2.1/32'], createdAt: new Date() });
      const res = await get(ADMIN, '/api/tokens?userId=user-1');
      const tok = parseJsonBody<{ tokens: TokenReply[] }>(res.body).tokens.find((t) => t._id === 'tok-r')!;
      expect(tok).toMatchObject({ canEdit: true, allowedIpRanges: ['10.0.0.0/8', '192.0.2.1/32'], ipRestricted: true, allowedIpRangeCount: 2 });
    });

    it('a project_admin opens service-account tokens by id, and nobody else\'s', async () => {
      store.push(
        { _id: 'own', userId: 'pa-1', tenantId: TENANT, projectId: 'proj-1', label: 'own token', createdAt: new Date() },
        { _id: 'svc', userId: 'svc-1', tenantId: TENANT, projectId: 'proj-1', label: 'svc token', createdAt: new Date() },
        { _id: 'adm', userId: 'admin-1', tenantId: TENANT, projectId: 'proj-1', label: 'admin token', createdAt: new Date() },
      );
      const ids = async (url: string) => parseJsonBody<{ tokens: TokenReply[] }>((await get(PA, url)).body).tokens.map((t) => t._id);
      expect(await ids('/api/tokens')).toEqual(['own']);
      expect(await ids('/api/tokens?userId=svc-1')).toEqual(['svc']);
      const refused = await get(PA, '/api/tokens?userId=admin-1');
      expect(refused.statusCode).toBe(403);
      expect(refused.body).not.toContain('admin token');
    });

    it('an unreadable policy never breaks the listing (no flags)', async () => {
      store.push({ _id: 'old', userId: 'user-1', tenantId: TENANT, projectId: 'proj-1', label: 'old token', createdAt: new Date() });
      db.iamDocGet.mockRejectedValue(new Error('down'));
      const res = await get(USER);
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<{ tokens: TokenReply[] }>(res.body).tokens[0].exceedsTenantPolicy).toBe(false);
    });
  });

  // ── edit ──────────────────────────────────────────────────────────────────

  describe('PUT /api/tokens/:id', () => {
    const seed = (extra: Record<string, unknown> = {}, owner = 'user-1') => {
      store.push({
        _id: 'tok-x', userId: owner, tenantId: TENANT, projectId: 'proj-1', label: 'my token', tokenHash: 'a'.repeat(64),
        createdAt: new Date(NOW - 10 * DAY), expiresAt: new Date(NOW + 20 * DAY), ...extra,
      });
    };

    it('changes only what is sent and evicts the cached token record', async () => {
      seed();
      const res = await put(USER, 'tok-x', { allowedIpRanges: ['10.0.0.0/8', '10.0.0.0/8', '192.0.2.1'] });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<TokenReply>(res.body);
      expect(body).toMatchObject({ _id: 'tok-x', label: 'my token', allowedIpRanges: ['10.0.0.0/8', '192.0.2.1/32'], canEdit: true });
      expect(db.updateApiToken).toHaveBeenCalledWith('tok-x', TENANT, { allowedIpRanges: ['10.0.0.0/8', '192.0.2.1/32'] });
      expect(h.cacheDel).toHaveBeenCalledWith(apiAuthCacheKey('a'.repeat(64)));
      expect(JSON.stringify(body)).not.toContain('tokenHash');
    });

    it('renames, clears the allowlist and shortens the expiry in one call', async () => {
      seed({ allowedIpRanges: ['10.0.0.0/8'] });
      const shorter = new Date(NOW + 5 * DAY).toISOString();
      const res = await put(USER, 'tok-x', { label: 'renamed token', allowedIpRanges: null, expiresAt: shorter });
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<TokenReply>(res.body)).toMatchObject({ label: 'renamed token', allowedIpRanges: null, expiresAt: shorter });
    });

    it('an empty body is a no-op (nothing written, nothing evicted)', async () => {
      seed();
      const res = await put(USER, 'tok-x', {});
      expect(res.statusCode).toBe(200);
      expect(db.updateApiToken).not.toHaveBeenCalled();
      expect(h.cacheDel).not.toHaveBeenCalled();
    });

    it('rejects a body that is not a JSON object', async () => {
      seed();
      for (const payload of ['[1]', '"text"', 'null', '{not json']) {
        const res = await put(USER, 'tok-x', payload);
        expect(res.statusCode, payload).toBe(400);
      }
      expect(db.updateApiToken).not.toHaveBeenCalled();
    });

    it('extending the expiry beyond the tenant maximum is refused; staying inside it works', async () => {
      seed(); // created 10 days ago -> with a 30-day maximum the latest expiry is now + 20 days
      setPolicy(db, { maxLifetimeDays: 30, requireExpiry: false });
      const tooLate = await put(USER, 'tok-x', { expiresAt: new Date(NOW + 25 * DAY).toISOString() });
      expect(tooLate.statusCode).toBe(400);
      expect(parseJsonBody<TokenReply>(tooLate.body).code).toBe('token_expiry_too_long');
      expect(db.updateApiToken).not.toHaveBeenCalled();
    });

    it('extending to a date inside the maximum works; the policy flag follows', async () => {
      seed({ expiresAt: new Date(NOW + 2 * DAY) });
      setPolicy(db, { maxLifetimeDays: 30, requireExpiry: false });
      const ok = await put(USER, 'tok-x', { expiresAt: new Date(NOW + 19 * DAY).toISOString() });
      expect(ok.statusCode).toBe(200);
      expect(parseJsonBody<TokenReply>(ok.body).exceedsTenantPolicy).toBe(false);
    });

    it('removing the expiry is refused while the tenant requires one', async () => {
      seed();
      setPolicy(db, { maxLifetimeDays: null, requireExpiry: true });
      const res = await put(USER, 'tok-x', { expiresAt: null });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<TokenReply>(res.body).code).toBe('token_expiry_required');
    });

    it('a stricter tenant policy never blocks an unrelated edit', async () => {
      seed({ expiresAt: new Date(NOW + 200 * DAY) });
      setPolicy(db, { maxLifetimeDays: 30, requireExpiry: true });
      const res = await put(USER, 'tok-x', { label: 'renamed token', allowedIpRanges: ['10.0.0.0/8'] });
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<TokenReply>(res.body).exceedsTenantPolicy).toBe(true);
    });

    it('never upward: only the owner edits their own token unless the actor outranks them', async () => {
      seed({}, 'user-1');
      expect((await put(['user-2', 'user'], 'tok-x', { label: 'hijacked' })).statusCode).toBe(403);
      expect((await put(PA, 'tok-x', { label: 'hijacked' })).statusCode).toBe(403); // a project_admin only edits service accounts
      expect((await put(ADMIN, 'tok-x', { label: 'admin edit' })).statusCode).toBe(200);
      expect((await put(OWNER, 'tok-x', { label: 'owner edit' })).statusCode).toBe(200);
    });

    it('a project_admin may edit a service account\'s token; an admin may not edit the owner\'s', async () => {
      seed({ _id: 'tok-svc' }, 'svc-1');
      expect((await put(PA, 'tok-svc', { label: 'svc relabel' })).statusCode).toBe(200);
      store.push({ _id: 'tok-owner', userId: 'owner-1', tenantId: TENANT, projectId: 'proj-1', label: 'owner token', createdAt: new Date() });
      expect((await put(ADMIN, 'tok-owner', { label: 'nope nope' })).statusCode).toBe(403);
      expect((await put(OWNER, 'tok-owner', { label: 'mine mine' })).statusCode).toBe(200);
    });

    it('404 for a token that does not exist or lives in another project', async () => {
      seed({ projectId: 'proj-other' });
      expect((await put(USER, 'tok-x', { label: 'whatever' })).statusCode).toBe(404);
      expect((await put(USER, 'missing', { label: 'whatever' })).statusCode).toBe(404);
    });

    describe('audit of a restriction change', () => {
      // The audit write is scheduled in the request's own tick: draining the pending tasks is a barrier, not a guess.
      const flush = () => drainPendingTasks(2000);
      const auditRows = () => db.createAuditLog.mock.calls
        .map((call) => call[0] as unknown as Record<string, unknown>)
        .filter((row) => row.event === 'token.restrictions.updated');

      it('records before and after when the allowlist changes, and nothing for a rename', async () => {
        seed();
        await put(USER, 'tok-x', { label: 'renamed token' });
        await flush();
        expect(auditRows()).toHaveLength(0);

        await put(USER, 'tok-x', { allowedIpRanges: ['10.0.0.0/8', '192.0.2.1'] });
        await flush();
        const rows = auditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          tenantId: TENANT,
          actorType: 'user',
          actorUserId: 'user-1',
          actorRole: 'user',
          service: 'tokens',
          action: 'security',
          outcome: 'success',
          resourceType: 'api_token',
          resourceId: 'tok-x',
          method: 'PUT',
          path: '/api/tokens/tok-x',
          metadata: {
            label: 'renamed token',
            ownerUserId: 'user-1',
            before: { allowedIpRanges: null, allowedIpRangeCount: 0 },
            after: { allowedIpRanges: ['10.0.0.0/8', '192.0.2.1/32'], allowedIpRangeCount: 2 },
          },
        });
      });

      it('records the old and the new expiry', async () => {
        const before = new Date(NOW + 20 * DAY);
        seed({ expiresAt: before });
        const after = new Date(NOW + 5 * DAY).toISOString();
        await put(USER, 'tok-x', { expiresAt: after });
        await flush();
        const [row] = auditRows();
        expect(row.metadata).toMatchObject({
          before: { expiresAt: before.toISOString() },
          after: { expiresAt: after },
        });
      });

      it('an edit that changes nothing writes no row, and a refused edit writes none either', async () => {
        seed({ allowedIpRanges: ['10.0.0.0/8'] });
        await put(USER, 'tok-x', { allowedIpRanges: ['10.0.0.0/8'] });
        await put(USER, 'tok-x', { allowedIpRanges: ['nope'] });
        await flush();
        expect(auditRows()).toHaveLength(0);
      });

      it('long allowlists are cut in the row but keep their count', async () => {
        seed();
        const many = Array.from({ length: 60 }, (_, i) => `10.${i}.0.0/16`);
        await put(USER, 'tok-x', { allowedIpRanges: many });
        await flush();
        const [row] = auditRows();
        const after = (row.metadata as { after: { allowedIpRanges: string[]; allowedIpRangeCount: number } }).after;
        expect(after.allowedIpRangeCount).toBe(60);
        expect(after.allowedIpRanges).toHaveLength(25);
        expect(after.allowedIpRanges[0]).toBe('10.0.0.0/16');
      });
    });

    it('validates the same way as create', async () => {
      seed();
      for (const [payload, code] of [
        [{ allowedIpRanges: ['nope'] }, 'invalid_ip_ranges'],
        [{ expiresAt: 'tomorrow' }, 'token_expiry_invalid'],
        [{ label: 'x' }, 'invalid_label'],
      ] as const) {
        const res = await put(USER, 'tok-x', payload);
        expect(res.statusCode).toBe(400);
        expect(parseJsonBody<TokenReply>(res.body).code).toBe(code);
      }
    });
  });

  // ── project routes ────────────────────────────────────────────────────────

  describe('project token routes', () => {
    it('POST honours the policy and stores the restrictions', async () => {
      setPolicy(db, { maxLifetimeDays: 30, requireExpiry: false });
      const refused = await post(ADMIN, { label: 'proj token' }, '/api/projects/proj-1/tokens');
      expect(refused.statusCode).toBe(400);
      expect(parseJsonBody<TokenReply>(refused.body).code).toBe('token_expiry_required');
      const ok = await post(ADMIN, { label: 'proj token', expiresInDays: 7, allowedIpRanges: ['10.0.0.0/8'] }, '/api/projects/proj-1/tokens');
      expect(ok.statusCode).toBe(201);
      expect(parseJsonBody<TokenReply>(ok.body)).toMatchObject({ allowedIpRanges: ['10.0.0.0/8'], exceedsTenantPolicy: false });
    });

    it('GET lists only what the caller may manage ("never upward"): an admin never sees the owner\'s tokens', async () => {
      store.push(
        { _id: 'own', userId: 'admin-1', tenantId: TENANT, projectId: 'proj-1', label: 'own token', createdAt: new Date() },
        { _id: 'usr', userId: 'user-1', tenantId: TENANT, projectId: 'proj-1', label: 'user token', createdAt: new Date(), allowedIpRanges: ['10.0.0.0/8'] },
        { _id: 'own-er', userId: 'owner-1', tenantId: TENANT, projectId: 'proj-1', label: 'owner token', createdAt: new Date(), allowedIpRanges: ['192.0.2.0/24'] },
      );
      const byId = (res: { body: string }) => Object.fromEntries(parseJsonBody<{ tokens: TokenReply[] }>(res.body).tokens.map((t) => [t._id as string, t]));
      // an admin manages their own and a user's, but the workspace owner's tokens are not shown at all
      const adminRes = await get(ADMIN, '/api/projects/proj-1/tokens');
      const asAdmin = byId(adminRes);
      expect(Object.keys(asAdmin).sort()).toEqual(['own', 'usr']);
      expect(asAdmin.own.canEdit).toBe(true);
      expect(asAdmin.usr).toMatchObject({ canEdit: true, canDelete: true, allowedIpRanges: ['10.0.0.0/8'], ipRestricted: true });
      expect(adminRes.body).not.toContain('owner token');
      expect(adminRes.body).not.toContain('192.0.2.0');
      // ... and the same refusal when it tries to reach them by id
      expect((await put(ADMIN, 'own-er', { label: 'takeover' }, '/api/projects/proj-1/tokens/own-er')).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: '/api/projects/proj-1/tokens/own-er', headers: bare(ADMIN) })).statusCode).toBe(403);
      // the owner sees and edits everything
      const asOwner = byId(await get(OWNER, '/api/projects/proj-1/tokens'));
      expect(Object.keys(asOwner).sort()).toEqual(['own', 'own-er', 'usr']);
      expect(Object.values(asOwner).every((t) => t.canEdit === true)).toBe(true);
    });

    it('GET is a listing, not a mint: it is never refused for the token quota', async () => {
      const { checkResourceQuota } = await import('@/lib/quota/quotaGuard');
      vi.mocked(checkResourceQuota).mockResolvedValue({ allowed: false, reason: 'API token quota exceeded' } as never);
      store.push({ _id: 'p1', userId: 'admin-1', tenantId: TENANT, projectId: 'proj-1', label: 'proj token', createdAt: new Date() });
      try {
        const res = await get(ADMIN, '/api/projects/proj-1/tokens');
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody<{ tokens: TokenReply[] }>(res.body).tokens).toHaveLength(1);
        // minting still is
        expect((await post(ADMIN, { label: 'one more' }, '/api/projects/proj-1/tokens')).statusCode).toBe(429);
      } finally {
        vi.mocked(checkResourceQuota).mockResolvedValue({ allowed: true } as never);
      }
    });

    it('GET lists the new fields', async () => {
      store.push({ _id: 'p1', userId: 'admin-1', tenantId: TENANT, projectId: 'proj-1', label: 'proj token', createdAt: new Date(), allowedIpRanges: ['10.0.0.0/8'] });
      const res = await get(ADMIN, '/api/projects/proj-1/tokens');
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<{ tokens: TokenReply[] }>(res.body).tokens[0]).toMatchObject({
        _id: 'p1', allowedIpRanges: ['10.0.0.0/8'], expiresAt: null, canEdit: true, canDelete: true,
      });
    });

    it('PUT edits through the same rules', async () => {
      store.push({ _id: 'p1', userId: 'admin-1', tenantId: TENANT, projectId: 'proj-1', label: 'proj token', tokenHash: 'b'.repeat(64), createdAt: new Date() });
      const res = await put(ADMIN, 'p1', { allowedIpRanges: ['10.0.0.0/8'] }, '/api/projects/proj-1/tokens/p1');
      expect(res.statusCode).toBe(200);
      expect(h.cacheDel).toHaveBeenCalledWith(apiAuthCacheKey('b'.repeat(64)));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(db.createAuditLog.mock.calls.some((call) => (call[0] as unknown as Record<string, unknown>).event === 'token.restrictions.updated')).toBe(true);
      const missing = await put(ADMIN, 'nope', { label: 'abcd' }, '/api/projects/proj-1/tokens/nope');
      expect(missing.statusCode).toBe(404);
    });

    it('PUT is for owners and admins only', async () => {
      store.push({ _id: 'p1', userId: 'pa-1', tenantId: TENANT, projectId: 'proj-1', label: 'proj token', createdAt: new Date() });
      const res = await put(PA, 'p1', { label: 'abcd' }, '/api/projects/proj-1/tokens/p1');
      expect(res.statusCode).toBe(403);
    });
  });

  // ── a token minting a token ───────────────────────────────────────────────

  describe('POST /api/client/v1/users/:id/tokens', () => {
    // The caller authenticates through the REAL token auth (mocked database), so
    // its own allowlist is enforced on the way in as well.
    const authAs = (tokenRecord: Record<string, unknown>) => {
      db.findApiTokenByHash.mockResolvedValue({
        _id: 'caller-tok', tenantId: TENANT, userId: 'owner-1', projectId: 'proj-1', servicePermissions: null,
        ...tokenRecord,
      } as never);
      db.findTenantById.mockResolvedValue({ _id: TENANT, dbName: 'tenant_acme', licenseType: 'STARTER', slug: 'acme' } as never);
    };
    const mint = (payload: Record<string, unknown>, remoteAddress = '10.0.0.7') => app.inject({
      method: 'POST',
      url: '/api/client/v1/users/svc-1/tokens',
      remoteAddress,
      headers: { authorization: 'Bearer cpeer_caller_token', 'content-type': 'application/json' },
      payload: JSON.stringify({ label: 'svc token', ...payload }),
    });

    it('applies the tenant policy', async () => {
      authAs({});
      setPolicy(db, { maxLifetimeDays: 30, requireExpiry: false });
      expect((await mint({})).statusCode).toBe(400);
      const ok = await mint({ expiresInDays: 30 });
      expect(ok.statusCode).toBe(201);
      expect(parseJsonBody<TokenReply>(ok.body).exceedsTenantPolicy).toBe(false);
    });

    it('an unrestricted caller sets any allowlist or none', async () => {
      authAs({});
      const some = await mint({ allowedIpRanges: ['198.51.100.0/24'] });
      expect(parseJsonBody<TokenReply>(some.body).allowedIpRanges).toEqual(['198.51.100.0/24']);
      const none = await mint({});
      expect(parseJsonBody<TokenReply>(none.body).allowedIpRanges).toBeNull();
    });

    it('a caller confined to ranges cannot mint a token that works from anywhere', async () => {
      authAs({ allowedIpRanges: ['10.0.0.0/16', '2001:db8::/32'] });
      // nothing asked for -> inherits the caller's ranges
      const inherit = await mint({});
      expect(inherit.statusCode).toBe(201);
      expect(parseJsonBody<TokenReply>(inherit.body).allowedIpRanges).toEqual(['10.0.0.0/16', '2001:db8::/32']);
      // a subset is fine
      const subset = await mint({ allowedIpRanges: ['10.0.5.0/24', '2001:db8:1::/48'] });
      expect(subset.statusCode).toBe(201);
      expect(parseJsonBody<TokenReply>(subset.body).allowedIpRanges).toEqual(['10.0.5.0/24', '2001:db8:1::/48']);
    });

    it('refuses ranges outside the caller\'s, and creates nothing', async () => {
      authAs({ allowedIpRanges: ['10.0.0.0/16'] });
      const before = db.createApiToken.mock.calls.length;
      for (const allowedIpRanges of [['0.0.0.0/0'], ['10.0.0.0/8'], ['10.1.0.0/24'], ['10.0.1.0/24', '192.0.2.1']]) {
        const res = await mint({ allowedIpRanges });
        expect(res.statusCode, JSON.stringify(allowedIpRanges)).toBe(403);
        expect(parseJsonBody<TokenReply>(res.body).code).toBe('ip_ranges_exceed_minter');
      }
      expect(db.createApiToken.mock.calls.length).toBe(before);
    });

    it('the caller\'s own allowlist is enforced before any of this', async () => {
      authAs({ allowedIpRanges: ['10.0.0.0/16'] });
      const res = await mint({}, '198.51.100.7');
      expect(res.statusCode).toBe(403);
      expect(parseJsonBody<TokenReply>(res.body).code).toBe('ip_not_allowed');
      expect(db.createApiToken).not.toHaveBeenCalled();
    });
  });
});
