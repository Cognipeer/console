/**
 * requireApiTokenFromHeader and the per-token IP allowlist: a token without a
 * list is unrestricted, one with a list authenticates only from inside it,
 * unknown addresses are refused, the check follows the auth cache, and a
 * refused call has no side effects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    findApiTokenByHash: vi.fn(),
    findTenantById: vi.fn(),
    switchToTenant: vi.fn(),
    findUserById: vi.fn(),
    updateTokenLastUsedByHash: vi.fn(),
  },
  ensureDefaultProject: vi.fn(),
  runWithTenantScope: vi.fn(),
  cache: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (dbName: string, fn: (db: unknown) => unknown) => h.runWithTenantScope(dbName, fn)),
}));
vi.mock('@/lib/core/cache', () => ({ getCache: vi.fn(async () => h.cache) }));
vi.mock('@/lib/core/asyncTask', () => ({
  fireAndForget: (_label: string, fn: () => Promise<void>) => { fn().catch(() => undefined); },
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: h.ensureDefaultProject,
}));

import { ApiTokenAuthError, requireApiToken, requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';

const tenant = { _id: 't1', dbName: 'tenant_acme', slug: 'acme', licenseType: 'FREE' };
const AUTH = 'Bearer cpeer_secret';

function tokenWith(extra: Record<string, unknown> = {}) {
  return { _id: 'tok-1', tenantId: 't1', userId: 'u1', projectId: 'p1', ...extra };
}

async function refusal(options?: { clientIp?: string | null }): Promise<ApiTokenAuthError> {
  const error = await requireApiTokenFromHeader(AUTH, options).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ApiTokenAuthError);
  return error as ApiTokenAuthError;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cache.get.mockResolvedValue(undefined);
  h.runWithTenantScope.mockImplementation(async (_dbName: string, fn: (db: unknown) => unknown) => fn(h.db));
  h.db.findApiTokenByHash.mockResolvedValue(tokenWith());
  h.db.findTenantById.mockResolvedValue(tenant);
  h.db.updateTokenLastUsedByHash.mockResolvedValue(undefined);
  // An owner reaches every project: these tests are about the network allowlist, not project membership.
  h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'owner', tenantId: 't1' });
  h.ensureDefaultProject.mockResolvedValue({ _id: 'p-default' });
});

describe('unrestricted tokens (no allowlist)', () => {
  it.each([
    ['absent', {}],
    ['null', { allowedIpRanges: null }],
    ['empty', { allowedIpRanges: [] }],
  ])('authenticate from any address and with no address at all (%s)', async (_label, extra) => {
    h.db.findApiTokenByHash.mockResolvedValue(tokenWith(extra));
    for (const clientIp of [undefined, null, '', 'unknown', '203.0.113.7', '2001:db8::1']) {
      const ctx = await requireApiTokenFromHeader(AUTH, { clientIp });
      expect(ctx.tokenRecord._id).toBe('tok-1');
    }
    // The legacy one-argument form (every existing caller) still works.
    await expect(requireApiTokenFromHeader(AUTH)).resolves.toBeTruthy();
  });
});

describe('restricted tokens', () => {
  beforeEach(() => {
    h.db.findApiTokenByHash.mockResolvedValue(tokenWith({
      allowedIpRanges: ['203.0.113.0/24', '2001:db8:abcd::/48', '198.51.100.9'],
    }));
  });

  it('authenticate from inside any listed range, IPv4 and IPv6', async () => {
    for (const clientIp of ['203.0.113.7', '203.0.113.255', '2001:db8:abcd:1::5', '198.51.100.9']) {
      const ctx = await requireApiTokenFromHeader(AUTH, { clientIp });
      expect(ctx.projectId).toBe('p1');
    }
  });

  it('read an IPv4 client reported as an IPv4-mapped IPv6 address (dual-stack listener)', async () => {
    await expect(requireApiTokenFromHeader(AUTH, { clientIp: '::ffff:203.0.113.7' })).resolves.toBeTruthy();
    const error = await refusal({ clientIp: '::ffff:192.0.2.1' });
    expect(error.code).toBe('ip_not_allowed');
  });

  it('refuse a call from outside every range with 403 ip_not_allowed', async () => {
    for (const clientIp of ['203.0.114.1', '198.51.100.10', '2001:db8:abce::1', '10.0.0.1']) {
      const error = await refusal({ clientIp });
      expect(error.status).toBe(403);
      expect(error.code).toBe('ip_not_allowed');
      expect(error.message).toBe('API token is not allowed from this IP address');
    }
  });

  it('refuse when the caller address is unknown, empty or not an address', async () => {
    for (const clientIp of [undefined, null, '', 'unknown', 'localhost', '203.0.113.7:443', '203.0.113.7, 203.0.113.8']) {
      const error = await refusal({ clientIp });
      expect(error.status).toBe(403);
      expect(error.code).toBe('ip_not_allowed');
    }
    // No options at all behaves like "address unknown": never like "unrestricted".
    const bare = await requireApiTokenFromHeader(AUTH).then(() => null, (e: unknown) => e);
    expect(bare).toBeInstanceOf(ApiTokenAuthError);
    expect((bare as ApiTokenAuthError).code).toBe('ip_not_allowed');
  });

  it('carries who was refused for the audit trail, without putting it in the message', async () => {
    const error = await refusal({ clientIp: '192.0.2.44' });
    expect(error.denial).toEqual({
      tenantId: 't1',
      tenantDbName: 'tenant_acme',
      tokenId: 'tok-1',
      userId: 'u1',
      projectId: 'p1',
      clientIp: '192.0.2.44',
    });
    expect(error.message).not.toContain('192.0.2.44');
  });

  it('leave no trace on a refused call: no tenant binding, owner lookup, default project or last-used stamp', async () => {
    await refusal({ clientIp: '192.0.2.44' });
    expect(h.db.switchToTenant).not.toHaveBeenCalled();
    expect(h.db.findUserById).not.toHaveBeenCalled();
    expect(h.runWithTenantScope).not.toHaveBeenCalled();
    expect(h.ensureDefaultProject).not.toHaveBeenCalled();
    expect(h.db.updateTokenLastUsedByHash).not.toHaveBeenCalled();
  });

  it('are checked on every request, also when the record comes from the auth cache', async () => {
    h.cache.get.mockResolvedValue({
      tokenRecord: tokenWith({ allowedIpRanges: ['203.0.113.0/24'] }),
      tenant,
    });
    await expect(requireApiTokenFromHeader(AUTH, { clientIp: '203.0.113.7' })).resolves.toBeTruthy();
    const error = await refusal({ clientIp: '192.0.2.44' });
    expect(error.code).toBe('ip_not_allowed');
    expect(h.db.findApiTokenByHash).not.toHaveBeenCalled();
  });

  it('do not unlock when the stored list is damaged', async () => {
    for (const allowedIpRanges of [['not-a-range'], [''], 'garbage', { 0: '203.0.113.0/24' }, 42]) {
      h.db.findApiTokenByHash.mockResolvedValue(tokenWith({ allowedIpRanges }));
      h.cache.get.mockResolvedValue(undefined);
      const error = await refusal({ clientIp: '203.0.113.7' });
      expect(error.code).toBe('ip_not_allowed');
    }
  });

  it('an expired token is reported as expired first (401), not as an IP problem', async () => {
    h.db.findApiTokenByHash.mockResolvedValue(tokenWith({
      allowedIpRanges: ['203.0.113.0/24'],
      expiresAt: new Date(Date.now() - 60_000),
    }));
    const error = await refusal({ clientIp: '192.0.2.44' });
    expect(error.status).toBe(401);
    expect(error.code).toBeUndefined();
    expect(error.message).toMatch(/expired/i);
  });

  it('a disabled owner is still refused for the owner reason when the address is fine', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', status: 'disabled' });
    const error = await refusal({ clientIp: '203.0.113.7' });
    expect(error.status).toBe(401);
    expect(error.message).toBe('API token owner is disabled');
  });

  it('the Next-style helper passes request.ip through', async () => {
    const request = (ip?: string) => ({ headers: { get: (name: string) => (name === 'authorization' ? AUTH : null) }, ip });
    await expect(requireApiToken(request('203.0.113.7'))).resolves.toBeTruthy();
    await expect(requireApiToken(request('192.0.2.44'))).rejects.toMatchObject({ code: 'ip_not_allowed' });
    await expect(requireApiToken(request(undefined))).rejects.toMatchObject({ code: 'ip_not_allowed' });
  });
});
