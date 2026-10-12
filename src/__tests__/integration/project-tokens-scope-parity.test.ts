/**
 * The project-scoped token routes (/api/projects/:projectId/tokens) through the
 * real data layer of BOTH providers (SQLite and, when mongodb-memory-server is
 * installed, MongoDB).
 *
 * The rules themselves are covered against an in-memory fake in
 * api/project-tokens-scope.test.ts. What only a real provider can show is that
 * they hold for a real project row and real token rows, for an account that is
 * gone, for an account id that is not even well-formed (Mongo's ObjectId
 * constructor throws on it, SQLite just finds nothing), and for a token id that
 * is not well-formed either.
 */
import type { FastifyPluginAsync } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const dbRef = vi.hoisted(() => ({ current: null as unknown }));
/** The project GET /api/tokens resolves as the caller's active one. */
const activeProject = vi.hoisted(() => ({ id: '' }));

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
    resolveProjectContext: vi.fn(async () => ({ projectId: activeProject.id })),
  };
});
vi.mock('@/lib/services/projects/projectService', () => ({
  DEFAULT_PROJECT_KEY: '__default__',
  ensureDefaultProject: vi.fn(),
  generateUniqueProjectKey: vi.fn(),
  listAccessibleProjects: vi.fn(),
}));

import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

/** Well-formed for Mongo, but nobody's account. */
const GONE_ACCOUNT = '0'.repeat(24);
/** Not an ObjectId at all. */
const MALFORMED_ACCOUNT = 'ghost-user';
/** A token id that is not an ObjectId either. */
const MALFORMED_TOKEN_ID = 'not-an-object-id';
/** A project that exists nowhere, only on token rows. */
const OTHER_PROJECT = 'proj-elsewhere';

/** Both token surfaces in one app, so the two can be held against each other. */
const bothSurfaces: FastifyPluginAsync = async (instance) => {
  await instance.register(projectsApiPlugin);
  await instance.register(tokensApiPlugin);
};

type Role = 'owner' | 'admin' | 'project_admin' | 'user';
type ListReply = { tokens: Array<{ _id: string; label: string; userId: string; canDelete: boolean }> };

describeForEachProvider('Project API token routes', (getDb) => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  let project: string;
  let users: Record<'owner' | 'admin' | 'admin2' | 'pa' | 'user' | 'user2' | 'svc', { id: string; role: Role }>;

  const headersFor = (who: keyof typeof users) => ({
    'x-license-type': 'STARTER',
    'x-tenant-db-name': tenantDbName,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'acme',
    'x-user-id': users[who].id,
    'x-user-role': users[who].role,
  });

  const list = (as: keyof typeof users) => app.inject({
    method: 'GET',
    url: `/api/projects/${project}/tokens`,
    headers: headersFor(as),
  });

  const labelsOf = (body: string) => parseJsonBody<ListReply>(body).tokens.map((token) => token.label).sort();

  /** Row of a seeded token, found the way the API would. */
  async function tokenRowOf(label: string) {
    const rows = await db.listProjectApiTokens(tenantId, project);
    const row = rows.find((item) => item.label === label);
    if (!row) throw new Error(`seed token not found: ${label}`);
    return row;
  }

  const removeId = (as: keyof typeof users, id: string, inProject = project) => app.inject({
    method: 'DELETE',
    url: `/api/projects/${inProject}/tokens/${id}`,
    headers: headersFor(as),
  });

  const remove = async (as: keyof typeof users, label: string) =>
    removeId(as, String((await tokenRowOf(label))._id));

  const stillThere = async (label: string) =>
    (await db.listProjectApiTokens(tenantId, project)).some((row) => row.label === label);

  beforeEach(async () => {
    db = getDb();
    dbRef.current = db;
    vi.mocked(invalidateApiTokenAuthCache).mockClear();
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tenantDbName = `tenant_projtokens_${suffix}`;
    const tenant = await db.createTenant({
      companyName: 'Acme',
      slug: `acme-${suffix}`,
      dbName: tenantDbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);

    // Users and projects live in the tenant's database; tokens in the main one.
    const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
      db.runWithTenant ? db.runWithTenant(tenantDbName, fn) : fn();

    const mkUser = async (name: string, role: Role, extra: { canLogin?: boolean; email?: string } = {}) => {
      const user = await inTenant(() => db.createUser({
        tenantId,
        email: extra.email ?? `${name}@example.test`,
        name,
        password: 'not-a-real-hash',
        role,
        licenseId: 'FREE',
        features: [],
        canLogin: extra.canLogin,
      }));
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

    const created = await inTenant(() => db.createProject({
      tenantId,
      key: `proj-${suffix}`,
      name: 'Project',
      createdBy: users.owner.id,
    }));
    project = String(created._id);
    activeProject.id = project;

    let n = 0;
    const mkToken = (label: string, userId: string, extra: { projectId?: string; tenantId?: string } = {}) =>
      db.createApiToken({
        label,
        userId,
        tenantId: extra.tenantId ?? tenantId,
        projectId: extra.projectId ?? project,
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
    await mkToken('tok-owner-elsewhere', users.owner.id, { projectId: OTHER_PROJECT });
    await mkToken('tok-user-tenant2', users.user.id, { tenantId: `${tenantId}-other` });

    app = await createFastifyApiTestApp(bothSurfaces);
  });

  afterEach(async () => {
    await app.close();
  });

  it('gives the owner the whole project, including tokens whose account is gone', async () => {
    const res = await list('owner');
    expect(res.statusCode).toBe(200);
    expect(labelsOf(res.body)).toEqual([
      'tok-admin', 'tok-admin2', 'tok-gone', 'tok-malformed', 'tok-owner', 'tok-pa', 'tok-svc', 'tok-user', 'tok-user2',
    ]);
    expect(parseJsonBody<ListReply>(res.body).tokens.every((token) => token.canDelete)).toBe(true);
  });

  it('gives an admin the project minus the owner\'s tokens and the ones it cannot attribute', async () => {
    const res = await list('admin');
    expect(res.statusCode).toBe(200);
    expect(labelsOf(res.body)).toEqual(['tok-admin', 'tok-admin2', 'tok-pa', 'tok-svc', 'tok-user', 'tok-user2']);
    expect(res.body).not.toContain('tok-owner');
  });

  it('lists what GET /api/tokens?scope=project lists, for the owner and for an admin', async () => {
    for (const as of ['owner', 'admin'] as const) {
      const wide = await app.inject({
        method: 'GET',
        url: '/api/tokens?scope=project',
        headers: headersFor(as),
      });
      expect(wide.statusCode).toBe(200);
      expect(labelsOf((await list(as)).body)).toEqual(labelsOf(wide.body));
    }
  });

  it('refuses a project_admin and a user', async () => {
    for (const as of ['pa', 'user'] as const) {
      const res = await list(as);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('tok-');
    }
  });

  it('answers 404 for a project that is not this tenant\'s', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${'0'.repeat(24)}/tokens`,
      headers: headersFor('owner'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('tok-');
  });

  it('mints for the caller, whoever the body names', async () => {
    const mint = (as: keyof typeof users, userId: string) => app.inject({
      method: 'POST',
      url: `/api/projects/${project}/tokens`,
      headers: { ...headersFor(as), 'content-type': 'application/json' },
      payload: JSON.stringify({ label: 'ci-token', userId }),
    });

    expect((await mint('admin', users.owner.id)).statusCode).toBe(201);
    expect((await db.listApiTokens(users.admin.id)).map((row) => row.label)).toContain('ci-token');
    expect((await db.listApiTokens(users.owner.id)).map((row) => row.label)).not.toContain('ci-token');

    expect((await mint('owner', users.user.id)).statusCode).toBe(201);
    expect((await db.listApiTokens(users.owner.id)).map((row) => row.label)).toContain('ci-token');
    expect((await db.listApiTokens(users.user.id)).map((row) => row.label)).not.toContain('ci-token');
  });

  it('deletes under the never-upward rule and leaves the refused ones in place', async () => {
    // An admin: a member's, a colleague's and its own — not the owner's, nor a
    // token it cannot attribute to any account.
    const colleague = await tokenRowOf('tok-user2');
    expect((await remove('admin', 'tok-user2')).statusCode).toBe(200);
    expect(await stillThere('tok-user2')).toBe(false);
    expect(invalidateApiTokenAuthCache).toHaveBeenCalledWith(colleague.tokenHash);
    vi.mocked(invalidateApiTokenAuthCache).mockClear();

    for (const label of ['tok-admin2', 'tok-svc', 'tok-admin']) {
      expect((await remove('admin', label)).statusCode).toBe(200);
      expect(await stillThere(label)).toBe(false);
    }
    vi.mocked(invalidateApiTokenAuthCache).mockClear();
    for (const label of ['tok-owner', 'tok-gone', 'tok-malformed']) {
      expect((await remove('admin', label)).statusCode).toBe(403);
      expect(await stillThere(label)).toBe(true);
    }
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();

    // A project_admin and a user never reach the delete.
    for (const as of ['pa', 'user'] as const) {
      for (const label of ['tok-owner', 'tok-user', 'tok-pa']) {
        expect((await remove(as, label)).statusCode).toBe(403);
        expect(await stillThere(label)).toBe(true);
      }
    }

    // The owner: anything in the project, including tokens nobody owns any more.
    for (const label of ['tok-owner', 'tok-pa', 'tok-user', 'tok-gone', 'tok-malformed']) {
      expect((await remove('owner', label)).statusCode).toBe(200);
      expect(await stillThere(label)).toBe(false);
    }
  });

  it('deleting a token through the project also deletes what it was set up to act for', async () => {
    const inTenant = <T,>(fn: () => Promise<T>): Promise<T> => (db.runWithTenant ? db.runWithTenant(tenantDbName, fn) : fn());
    const doomed = await tokenRowOf('tok-user2');
    const kept = await tokenRowOf('tok-user');
    for (const row of [doomed, kept]) await inTenant(() => db.iamDocPut('iam_delegations', String(row._id), { enabled: true }));

    expect((await remove('admin', 'tok-user2')).statusCode).toBe(200);
    expect(await inTenant(() => db.iamDocGet('iam_delegations', String(doomed._id)))).toBeNull();
    // (only the deleted token's own document goes)
    expect(await inTenant(() => db.iamDocGet('iam_delegations', String(kept._id)))).not.toBeNull();
    // and a refused delete leaves it where it is
    expect((await remove('admin', 'tok-owner')).statusCode).toBe(403);
    const ownerRow = await tokenRowOf('tok-owner');
    await inTenant(() => db.iamDocPut('iam_delegations', String(ownerRow._id), { enabled: true }));
    expect((await remove('admin', 'tok-owner')).statusCode).toBe(403);
    expect(await inTenant(() => db.iamDocGet('iam_delegations', String(ownerRow._id)))).not.toBeNull();
  });

  it('answers 404 for a token id that is not well-formed, or not this project\'s', async () => {
    const elsewhere = (await db.listApiTokens(users.owner.id)).find((row) => row.label === 'tok-owner-elsewhere');
    expect(elsewhere).toBeDefined();
    const foreignTenant = (await db.listApiTokens(users.user.id)).find((row) => row.label === 'tok-user-tenant2');
    expect(foreignTenant).toBeDefined();

    for (const as of ['owner', 'admin'] as const) {
      for (const id of [MALFORMED_TOKEN_ID, GONE_ACCOUNT, String(elsewhere!._id), String(foreignTenant!._id)]) {
        const res = await removeId(as, id);
        expect(res.statusCode).toBe(404);
      }
    }
    // Neither another project's token nor another tenant's was touched.
    expect((await db.listApiTokens(users.owner.id)).some((row) => row.label === 'tok-owner-elsewhere')).toBe(true);
    expect((await db.listApiTokens(users.user.id)).some((row) => row.label === 'tok-user-tenant2')).toBe(true);
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });
});
