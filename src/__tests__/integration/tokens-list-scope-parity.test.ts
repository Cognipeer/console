/**
 * Which API tokens a session sees and may delete — through the real data layer
 * of BOTH providers (SQLite and, when mongodb-memory-server is installed,
 * MongoDB).
 *
 * The API rules themselves are covered against an in-memory fake in
 * api/tokens-list-scope.test.ts. What only a real provider can show is that the
 * three lookups they lean on — a user's tokens, a project's tokens, and the
 * account behind a token — answer the same way on both backends, including for
 * an account that is gone and for an id that is not even well-formed (Mongo's
 * ObjectId constructor throws on it, SQLite just finds nothing) — which is also
 * what `?userId=` and a minted-for `userId` must read as: no such account, 404.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn(async () => dbRef.current),
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = dbRef.current as any;
      return db.runWithTenant ? db.runWithTenant(tenantDbName, () => fn(db)) : fn(db);
    },
  };
});
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    apiAuthCacheKey: vi.fn(),
    invalidateApiTokenAuthCache: vi.fn(),
    requireApiTokenFromHeader: vi.fn(),
  };
});
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

import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const PROJECT = 'proj-1';
/** Well-formed for Mongo, but nobody's account. */
const GONE_ACCOUNT = '0'.repeat(24);
/** Not an ObjectId at all. */
const MALFORMED_ACCOUNT = 'ghost-user';

type Role = 'owner' | 'admin' | 'project_admin' | 'user';
type ListReply = { tokens: Array<{ _id: string; label: string; userId: string; canDelete: boolean }> };

describeForEachProvider('API token visibility', (getDb) => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  let users: Record<'owner' | 'admin' | 'admin2' | 'pa' | 'user' | 'user2' | 'svc', { id: string; role: Role }>;

  const headersFor = (who: keyof typeof users) => ({
    'x-license-type': 'STARTER',
    'x-tenant-db-name': tenantDbName,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'acme',
    'x-user-id': users[who].id,
    'x-user-role': users[who].role,
  });

  const list = (as: keyof typeof users, query = '') => app.inject({
    method: 'GET',
    url: `/api/tokens${query}`,
    headers: headersFor(as),
  });

  const labelsOf = (body: string) => parseJsonBody<ListReply>(body).tokens.map((token) => token.label).sort();

  /** Row id of a seeded token, found the way the API would. */
  async function tokenId(label: string): Promise<string> {
    const rows = await db.listProjectApiTokens(tenantId, PROJECT);
    const row = rows.find((item) => item.label === label);
    if (!row) throw new Error(`seed token not found: ${label}`);
    return String(row._id);
  }

  const remove = async (as: keyof typeof users, label: string) => app.inject({
    method: 'DELETE',
    url: `/api/tokens/${await tokenId(label)}`,
    headers: headersFor(as),
  });

  const stillThere = async (label: string) =>
    (await db.listProjectApiTokens(tenantId, PROJECT)).some((row) => row.label === label);

  beforeEach(async () => {
    db = getDb();
    dbRef.current = db;
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tenantDbName = `tenant_tokens_${suffix}`;
    const tenant = await db.createTenant({
      companyName: 'Acme',
      slug: `acme-${suffix}`,
      dbName: tenantDbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);

    const mkUser = async (name: string, role: Role, extra: { canLogin?: boolean; email?: string } = {}) => {
      const create = () => db.createUser({
        tenantId,
        email: extra.email ?? `${name}@example.test`,
        name,
        password: 'not-a-real-hash',
        role,
        licenseId: 'FREE',
        features: [],
        canLogin: extra.canLogin,
      });
      // Users live in the tenant's database; tokens in the main one.
      const user = await (db.runWithTenant ? db.runWithTenant(tenantDbName, create) : create());
      return { id: String(user._id), role };
    };
    users = {
      owner: await mkUser('owner', 'owner'),
      admin: await mkUser('admin', 'admin'),
      admin2: await mkUser('admin2', 'admin'),
      pa: await mkUser('pa', 'project_admin'),
      user: await mkUser('user', 'user'),
      user2: await mkUser('user2', 'user'),
      svc: await mkUser('svc', 'user', { canLogin: false, email: '' }),
    };

    let n = 0;
    const mkToken = (label: string, userId: string, extra: { projectId?: string; tenantId?: string } = {}) =>
      db.createApiToken({
        label,
        userId,
        tenantId: extra.tenantId ?? tenantId,
        projectId: extra.projectId ?? PROJECT,
        tokenHash: `${suffix}-hash-${(n += 1)}`,
        tokenPrefix: `cpeer_${label}`,
        createdBy: userId,
      });
    await mkToken('tok-owner', users.owner.id);
    await mkToken('tok-admin', users.admin.id);
    await mkToken('tok-admin2', users.admin2.id);
    await mkToken('tok-pa', users.pa.id);
    await mkToken('tok-user', users.user.id);
    await mkToken('tok-user2', users.user2.id);
    await mkToken('tok-svc', users.svc.id);
    await mkToken('tok-gone', GONE_ACCOUNT);
    await mkToken('tok-malformed', MALFORMED_ACCOUNT);
    // The same people, elsewhere: never part of this project's listings.
    await mkToken('tok-user-proj2', users.user.id, { projectId: 'proj-2' });
    await mkToken('tok-user-tenant2', users.user.id, { tenantId: `${tenantId}-other` });

    app = await createFastifyApiTestApp(tokensApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['owner', ['tok-owner']],
    ['admin', ['tok-admin']],
    ['pa', ['tok-pa']],
    ['user', ['tok-user']],
  ] as const)('the default listing is only what %s owns, in this project', async (as, expected) => {
    const res = await list(as);
    expect(res.statusCode).toBe(200);
    expect(labelsOf(res.body)).toEqual(expected);
    expect(parseJsonBody<ListReply>(res.body).tokens.every((token) => token.userId === users[as].id)).toBe(true);
  });

  it('opens another account\'s tokens only where the never-upward rule allows it', async () => {
    expect(labelsOf((await list('owner', `?userId=${users.admin.id}`)).body)).toEqual(['tok-admin']);
    expect(labelsOf((await list('admin', `?userId=${users.user.id}`)).body)).toEqual(['tok-user']);
    expect(labelsOf((await list('pa', `?userId=${users.svc.id}`)).body)).toEqual(['tok-svc']);

    expect((await list('admin', `?userId=${users.owner.id}`)).statusCode).toBe(403);
    expect((await list('pa', `?userId=${users.user.id}`)).statusCode).toBe(403);
    expect((await list('user', `?userId=${users.user2.id}`)).statusCode).toBe(403);
  });

  it('gives the owner the whole project, including tokens whose account is gone', async () => {
    const res = await list('owner', '?scope=project');
    expect(res.statusCode).toBe(200);
    expect(labelsOf(res.body)).toEqual([
      'tok-admin', 'tok-admin2', 'tok-gone', 'tok-malformed', 'tok-owner', 'tok-pa', 'tok-svc', 'tok-user', 'tok-user2',
    ]);
  });

  it('gives an admin the project minus the owner\'s tokens and the ones it cannot attribute', async () => {
    const res = await list('admin', '?scope=project');
    expect(res.statusCode).toBe(200);
    expect(labelsOf(res.body)).toEqual(['tok-admin', 'tok-admin2', 'tok-pa', 'tok-svc', 'tok-user', 'tok-user2']);
  });

  it('refuses the project listing to a project_admin and a user', async () => {
    for (const as of ['pa', 'user'] as const) {
      const res = await list(as, '?scope=project');
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('tok-');
    }
  });

  it('deletes under the never-upward rule and leaves the refused ones in place', async () => {
    // A project_admin: a login-disabled account's token, nobody else's.
    expect((await remove('pa', 'tok-svc')).statusCode).toBe(200);
    expect(await stillThere('tok-svc')).toBe(false);
    for (const label of ['tok-owner', 'tok-admin', 'tok-user', 'tok-gone']) {
      expect((await remove('pa', label)).statusCode).toBe(403);
      expect(await stillThere(label)).toBe(true);
    }

    // An admin: a member's token, not the owner's.
    expect((await remove('admin', 'tok-user2')).statusCode).toBe(200);
    expect(await stillThere('tok-user2')).toBe(false);
    expect((await remove('admin', 'tok-owner')).statusCode).toBe(403);
    expect(await stillThere('tok-owner')).toBe(true);

    // A user: only its own; anyone else's is simply not found.
    expect((await remove('user', 'tok-admin')).statusCode).toBe(404);
    expect(await stillThere('tok-admin')).toBe(true);
    expect((await remove('user', 'tok-user')).statusCode).toBe(200);
    expect(await stillThere('tok-user')).toBe(false);

    // The owner: anything in the project, including tokens nobody owns any more.
    for (const label of ['tok-admin', 'tok-gone', 'tok-malformed']) {
      expect((await remove('owner', label)).statusCode).toBe(200);
      expect(await stillThere(label)).toBe(false);
    }
  });

  it('reads an account id the provider cannot parse as "no such account", like one that is gone', async () => {
    const mint = (as: keyof typeof users, userId: string) => app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { ...headersFor(as), 'content-type': 'application/json' },
      payload: JSON.stringify({ label: 'ci-token', userId }),
    });

    for (const target of [MALFORMED_ACCOUNT, GONE_ACCOUNT, `${MALFORMED_ACCOUNT}${'x'.repeat(2000)}`]) {
      for (const as of ['owner', 'admin', 'pa', 'user'] as const) {
        const res = await list(as, `?userId=${target}`);
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('tok-');
      }
    }
    for (const target of [MALFORMED_ACCOUNT, GONE_ACCOUNT]) {
      for (const as of ['owner', 'admin', 'pa'] as const) {
        expect((await mint(as, target)).statusCode).toBe(404);
      }
    }
    expect(await stillThere('ci-token')).toBe(false);
  });

  it('never deletes a token of another project', async () => {
    const rows = await db.listApiTokens(users.user.id);
    const elsewhere = rows.find((row) => row.label === 'tok-user-proj2');
    expect(elsewhere).toBeDefined();
    for (const as of ['owner', 'admin', 'user'] as const) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tokens/${String(elsewhere!._id)}`,
        headers: headersFor(as),
      });
      expect(res.statusCode).toBe(404);
    }
    expect((await db.listApiTokens(users.user.id)).some((row) => row.label === 'tok-user-proj2')).toBe(true);
  });
});
