/**
 * Minting API tokens for OTHER users (session surface).
 *
 * A token minted in someone's name authorises as that someone on every client
 * route. The two properties under test: nobody below the owner can mint in the
 * owner's name, and nobody below the owner can mint an UNSCOPED token for
 * anyone else — the stored scope is pinned to min(target, minter) per service,
 * so a restricted admin cannot launder its own restrictions through a
 * colleague's identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
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

import { getDatabase } from '@/lib/database';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';

const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, name: 'Owner', email: 'o@x.com' },
  // An admin the owner restricted: audit is off for them.
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT, servicePermissions: { audit: 'none' } },
  'pa-1': { _id: 'pa-1', role: 'project_admin', tenantId: TENANT },
  'user-1': { _id: 'user-1', role: 'user', tenantId: TENANT, canLogin: true },
  'svc-1': { _id: 'svc-1', role: 'user', tenantId: TENANT, canLogin: false, email: '' },
};

function sessionHeaders(userId: string) {
  return {
    'content-type': 'application/json',
    'x-license-type': 'STARTER',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': TENANT,
    'x-tenant-slug': 'acme',
    'x-user-id': userId,
    'x-user-role': String(USERS[userId].role),
  };
}

type MintReply = { servicePermissions: Record<string, string> | null; userId: string; token: string };

describe('POST /api/tokens for another user', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] as never) ?? null);
    db.listProjectApiTokens.mockResolvedValue([]);
    db.listApiTokens.mockResolvedValue([]);
    db.createApiToken.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'tok-new', ...input }) as never);
    app = await createFastifyApiTestApp(tokensApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const mint = (as: string, body: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: sessionHeaders(as),
    payload: JSON.stringify({ label: 'ci-token', ...body }),
  });

  it('refuses a project_admin minting in the owner\'s name', async () => {
    const res = await mint('pa-1', { userId: 'owner-1' });
    expect(res.statusCode).toBe(403);
    expect(db.createApiToken).not.toHaveBeenCalled();
  });

  it('refuses a restricted admin minting in the owner\'s name', async () => {
    const res = await mint('admin-1', { userId: 'owner-1' });
    expect(res.statusCode).toBe(403);
    expect(db.createApiToken).not.toHaveBeenCalled();
  });

  it('never issues an unscoped token when an admin mints for a user — the scope is min(target, minter)', async () => {
    const res = await mint('admin-1', { userId: 'user-1' });
    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<MintReply>(res.body);
    expect(body.userId).toBe('user-1');
    expect(body.servicePermissions).not.toBeNull();
    const scope = body.servicePermissions as Record<string, string>;
    // The minter's own restriction is carried onto the token …
    expect(scope.audit).toBe('none');
    // … and the target's level caps everything else: a `user` is `write` on
    // models, never `admin`, however much the minting admin holds.
    expect(scope.models).toBe('write');
    // Admin-only services a plain user lacks stay closed.
    expect(scope.members).toBe('none');
    expect(Object.values(scope)).not.toContain('admin');
  });

  it('clamps a requested scope by BOTH parties when an admin mints for a user', async () => {
    const res = await mint('admin-1', { userId: 'user-1', servicePermissions: { models: 'admin', audit: 'read', tokens: 'read' } });
    expect(res.statusCode).toBe(201);
    const scope = parseJsonBody<MintReply>(res.body).servicePermissions as Record<string, string>;
    expect(scope.models).toBe('write'); // target cap
    expect(scope.audit).toBe('none');   // minter cap
    expect(scope.tokens).toBe('read');  // requested, within both
    expect(scope.members).toBe('none'); // not requested → none
  });

  it('leaves the owner\'s minting unchanged (unscoped when nothing is requested)', async () => {
    const res = await mint('owner-1', { userId: 'admin-1' });
    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<MintReply>(res.body).servicePermissions).toBeNull();
    expect(db.createApiToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', servicePermissions: null }));
  });

  it('lets a project_admin mint only for login-disabled service accounts', async () => {
    const forService = await mint('pa-1', { userId: 'svc-1' });
    expect(forService.statusCode).toBe(201);
    const scope = parseJsonBody<MintReply>(forService.body).servicePermissions as Record<string, string>;
    expect(scope.models).toBe('write');
    expect(scope.members).toBe('none');

    const forPerson = await mint('pa-1', { userId: 'user-1' });
    expect(forPerson.statusCode).toBe(403);
  });

  it('keeps self-service minting as it was', async () => {
    const res = await mint('user-1', {});
    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<MintReply>(res.body);
    expect(body.userId).toBe('user-1');
    expect(body.servicePermissions).toBeNull();
    expect(body.token).toMatch(/^cpeer_/);
  });
});

describe('GET /api/tokens?userId=', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] as never) ?? null);
    db.listApiTokens.mockResolvedValue([
      { _id: 'tok-o', label: 'owner ci', userId: 'owner-1', tenantId: TENANT, projectId: 'proj-1', tokenPrefix: 'cpeer_ab' },
    ] as never);
    app = await createFastifyApiTestApp(tokensApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const list = (as: string, userId: string) => app.inject({
    method: 'GET',
    url: `/api/tokens?userId=${userId}`,
    headers: sessionHeaders(as),
  });

  it('does not let a project_admin enumerate the owner\'s token metadata', async () => {
    expect((await list('pa-1', 'owner-1')).statusCode).toBe(403);
    expect((await list('admin-1', 'owner-1')).statusCode).toBe(403);
  });

  it('still lets the owner and self-service list', async () => {
    const asOwner = await list('owner-1', 'admin-1');
    expect(asOwner.statusCode).toBe(200);
    const self = await list('owner-1', 'owner-1');
    expect(self.statusCode).toBe(200);
    expect(parseJsonBody<{ tokens: unknown[] }>(self.body).tokens).toHaveLength(1);
  });
});
