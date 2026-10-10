/**
 * The project-scoped token routes (/api/projects/:projectId/tokens) hold the
 * same line as GET and DELETE /api/tokens:
 *
 *   GET     owner and admin only; the owner sees every token of the project, an
 *           admin never the owner's nor those of an account it may not act on;
 *   POST    owner and admin only; the token is always minted for the caller;
 *   DELETE  owner and admin only; the owner may delete any token of the
 *           project, an admin any but the owner's (anything else answers 403),
 *           and the token's auth cache entry is dropped with it.
 *
 * The database is an in-memory fake, so the assertions are on what each caller
 * gets back and what is left afterwards, not on which query was issued.
 */
import type { FastifyPluginAsync } from 'fastify';
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
vi.mock('@/lib/services/projects/projectService', () => ({
  DEFAULT_PROJECT_KEY: '__default__',
  ensureDefaultProject: vi.fn(),
  generateUniqueProjectKey: vi.fn(),
  listAccessibleProjects: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
/** Not 24 hex characters: Mongo's ObjectId constructor throws on it. */
const MALFORMED_ID = 'not-an-id';

const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, canLogin: true },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT, canLogin: true },
  'admin-2': { _id: 'admin-2', role: 'admin', tenantId: TENANT, canLogin: true },
  'pa-1': { _id: 'pa-1', role: 'project_admin', tenantId: TENANT, canLogin: true },
  'user-1': { _id: 'user-1', role: 'user', tenantId: TENANT, canLogin: true },
  'user-2': { _id: 'user-2', role: 'user', tenantId: TENANT, canLogin: true },
  // A login-disabled account that exists only to hold tokens.
  'svc-1': { _id: 'svc-1', role: 'user', tenantId: TENANT, canLogin: false },
};

const PROJECTS: Record<string, { _id: string; tenantId: string }> = {
  'proj-1': { _id: 'proj-1', tenantId: TENANT },
  'proj-2': { _id: 'proj-2', tenantId: TENANT },
  'proj-foreign': { _id: 'proj-foreign', tenantId: 'tenant-2' },
};

interface TokenRow {
  _id: string;
  userId: string;
  tenantId: string;
  projectId: string;
  label: string;
  tokenPrefix: string;
  tokenHash: string;
}

function tokenRow(id: string, userId: string, extra: Partial<TokenRow> = {}): TokenRow {
  return {
    _id: id,
    userId,
    tenantId: TENANT,
    projectId: 'proj-1',
    label: `label of ${id}`,
    tokenPrefix: `cpeer_${id}`,
    tokenHash: `hash-of-${id}`,
    ...extra,
  };
}

/** Two projects of one tenant, with tokens of every kind of owner in the first. */
function seedTokens(): TokenRow[] {
  return [
    tokenRow('tok-owner', 'owner-1'),
    tokenRow('tok-admin', 'admin-1'),
    tokenRow('tok-admin2', 'admin-2'),
    tokenRow('tok-pa', 'pa-1'),
    tokenRow('tok-user1', 'user-1'),
    tokenRow('tok-user2', 'user-2'),
    tokenRow('tok-svc', 'svc-1'),
    // Its account is gone: nothing can resolve who owns it.
    tokenRow('tok-ghost', 'ghost-user'),
    // The same people, elsewhere: never part of proj-1's listings.
    tokenRow('tok-user1-proj2', 'user-1', { projectId: 'proj-2' }),
    tokenRow('tok-owner-proj2', 'owner-1', { projectId: 'proj-2' }),
    tokenRow('tok-user1-tenant2', 'user-1', { tenantId: 'tenant-2' }),
  ];
}

const PROJECT_1_IDS = [
  'tok-admin', 'tok-admin2', 'tok-ghost', 'tok-owner', 'tok-pa', 'tok-svc', 'tok-user1', 'tok-user2',
];

function sessionHeaders(userId: string) {
  return {
    'x-license-type': 'STARTER',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': TENANT,
    'x-tenant-slug': 'acme',
    'x-user-id': userId,
    'x-user-role': String(USERS[userId].role),
  };
}

type ListReply = { tokens: Array<{ _id: string; canDelete: boolean; userId: string }> };

/** Both token surfaces in one app, so the two can be held against each other. */
const bothSurfaces: FastifyPluginAsync = async (instance) => {
  await instance.register(projectsApiPlugin);
  await instance.register(tokensApiPlugin);
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let db: ReturnType<typeof createMockDb>;
let tokens: TokenRow[];

function removeWhere(match: (row: TokenRow) => boolean): boolean {
  const before = tokens.length;
  tokens = tokens.filter((row) => !match(row));
  return tokens.length < before;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tokens = seedTokens();
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findProjectById.mockImplementation(async (id: string) => (PROJECTS[id] as never) ?? null);
  db.findUserById.mockImplementation(async (id: string) => {
    if (id === MALFORMED_ID) {
      throw Object.assign(
        new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'),
        { name: 'BSONError' },
      );
    }
    return (USERS[id] as never) ?? null;
  });
  db.listApiTokens.mockImplementation(async (userId: string) =>
    tokens.filter((row) => row.userId === userId) as never);
  db.listProjectApiTokens.mockImplementation(async (tenantId: string, projectId: string) =>
    tokens.filter((row) => row.tenantId === tenantId && row.projectId === projectId) as never);
  db.createApiToken.mockImplementation(async (input: Record<string, unknown>) =>
    ({ _id: 'tok-new', ...input }) as never);
  // Deleting is per owner (the whole-workspace delete would flush every principal's cache).
  db.deleteApiToken.mockImplementation(async (id: string, userId: string) =>
    removeWhere((row) => row._id === id && row.userId === userId));
  app = await createFastifyApiTestApp(bothSurfaces);
});

afterEach(async () => {
  await app.close();
});

const list = (as: string, project = 'proj-1') => app.inject({
  method: 'GET',
  url: `/api/projects/${project}/tokens`,
  headers: sessionHeaders(as),
});

const idsOf = (body: string) => parseJsonBody<ListReply>(body).tokens.map((token) => token._id).sort();

describe('GET /api/projects/:projectId/tokens', () => {
  it('gives the owner every token of the project', async () => {
    const res = await list('owner-1');
    expect(res.statusCode).toBe(200);
    expect(idsOf(res.body)).toEqual(PROJECT_1_IDS);
    expect(parseJsonBody<ListReply>(res.body).tokens.every((token) => token.canDelete)).toBe(true);
  });

  it('gives an admin every token it may act on — never the owner\'s', async () => {
    const res = await list('admin-1');
    expect(res.statusCode).toBe(200);
    expect(idsOf(res.body)).toEqual(['tok-admin', 'tok-admin2', 'tok-pa', 'tok-svc', 'tok-user1', 'tok-user2']);
    expect(res.body).not.toContain('tok-owner');
    expect(res.body).not.toContain('label of tok-owner');
    expect(parseJsonBody<ListReply>(res.body).tokens.every((token) => token.canDelete)).toBe(true);
  });

  it('lists what GET /api/tokens?scope=project lists, for the owner and for an admin', async () => {
    for (const as of ['owner-1', 'admin-1']) {
      const wide = await app.inject({
        method: 'GET',
        url: '/api/tokens?scope=project',
        headers: sessionHeaders(as),
      });
      expect(wide.statusCode).toBe(200);
      expect(idsOf((await list(as)).body)).toEqual(idsOf(wide.body));
    }
  });

  it('keeps the tokens of an unresolvable account away from an admin, not from the owner', async () => {
    tokens.push(tokenRow('tok-bad', MALFORMED_ID));
    expect(idsOf((await list('admin-1')).body)).not.toContain('tok-ghost');
    expect(idsOf((await list('admin-1')).body)).not.toContain('tok-bad');
    expect(idsOf((await list('owner-1')).body)).toEqual(expect.arrayContaining(['tok-ghost', 'tok-bad']));
  });

  it.each(['pa-1', 'user-1'])('refuses %s', async (as) => {
    const res = await list(as);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('tok-');
  });

  it('lists the tokens of the project in the path, and only those', async () => {
    expect(idsOf((await list('owner-1', 'proj-2')).body)).toEqual(['tok-owner-proj2', 'tok-user1-proj2']);
    expect(idsOf((await list('admin-1', 'proj-2')).body)).toEqual(['tok-user1-proj2']);
  });

  it('answers 404 for a project of another tenant or one that does not exist', async () => {
    for (const project of ['proj-foreign', 'proj-missing']) {
      const res = await list('owner-1', project);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('tok-');
    }
  });

  it('is a listing, not a mint: the token quota is never checked, and a full quota never hides the list', async () => {
    vi.mocked(checkResourceQuota).mockResolvedValue({ allowed: false, reason: 'apiTokens limit reached' } as never);
    try {
      const res = await list('admin-1');
      expect(res.statusCode).toBe(200);
      expect(idsOf(res.body)).toHaveLength(6);
      expect(checkResourceQuota).not.toHaveBeenCalled();
    } finally {
      vi.mocked(checkResourceQuota).mockResolvedValue({ allowed: true } as never);
    }
  });
});

describe('POST /api/projects/:projectId/tokens', () => {
  const mint = (as: string, body: Record<string, unknown>, project = 'proj-1') => app.inject({
    method: 'POST',
    url: `/api/projects/${project}/tokens`,
    headers: { ...sessionHeaders(as), 'content-type': 'application/json' },
    payload: JSON.stringify({ label: 'ci-token', ...body }),
  });

  it.each([
    ['owner-1', 'user-1'],
    ['owner-1', 'admin-1'],
    ['admin-1', 'owner-1'],
    ['admin-1', 'user-1'],
  ])('mints for the caller %s, whoever the body names (%s)', async (as, named) => {
    const res = await mint(as, { userId: named });
    expect(res.statusCode).toBe(201);
    expect(db.createApiToken).toHaveBeenCalledTimes(1);
    expect(db.createApiToken).toHaveBeenCalledWith(expect.objectContaining({
      label: 'ci-token',
      projectId: 'proj-1',
      tenantId: TENANT,
      userId: as,
    }));
  });

  it.each(['pa-1', 'user-1'])('refuses %s', async (as) => {
    const res = await mint(as, {});
    expect(res.statusCode).toBe(403);
    expect(db.createApiToken).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/projects/:projectId/tokens/:id', () => {
  const remove = (as: string, id: string, project = 'proj-1') => app.inject({
    method: 'DELETE',
    url: `/api/projects/${project}/tokens/${id}`,
    headers: sessionHeaders(as),
  });
  const stillThere = (id: string) => tokens.some((row) => row._id === id);

  it('lets the owner delete any token of the project, and drops its auth cache entry', async () => {
    for (const id of ['tok-owner', 'tok-admin', 'tok-pa', 'tok-user1', 'tok-svc', 'tok-ghost']) {
      vi.mocked(invalidateApiTokenAuthCache).mockClear();
      expect((await remove('owner-1', id)).statusCode).toBe(200);
      expect(stillThere(id)).toBe(false);
      expect(invalidateApiTokenAuthCache).toHaveBeenCalledWith(`hash-of-${id}`);
    }
  });

  it('lets an admin delete its own token, a member\'s or a colleague\'s', async () => {
    for (const id of ['tok-admin', 'tok-user1', 'tok-svc', 'tok-pa', 'tok-admin2']) {
      vi.mocked(invalidateApiTokenAuthCache).mockClear();
      expect((await remove('admin-1', id)).statusCode).toBe(200);
      expect(stillThere(id)).toBe(false);
      expect(invalidateApiTokenAuthCache).toHaveBeenCalledWith(`hash-of-${id}`);
    }
  });

  it('does not let an admin delete the owner\'s token', async () => {
    const refused = await remove('admin-1', 'tok-owner');
    expect(refused.statusCode).toBe(403);
    expect(stillThere('tok-owner')).toBe(true);
    expect(db.deleteApiToken).not.toHaveBeenCalled();
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
    // Still the owner's to see.
    expect(idsOf((await list('owner-1')).body)).toContain('tok-owner');
  });

  it('does not let an admin delete a token whose account it cannot resolve', async () => {
    tokens.push(tokenRow('tok-bad', MALFORMED_ID));
    for (const id of ['tok-ghost', 'tok-bad']) {
      expect((await remove('admin-1', id)).statusCode).toBe(403);
      expect(stillThere(id)).toBe(true);
    }
    expect(db.deleteApiToken).not.toHaveBeenCalled();
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });

  it.each(['pa-1', 'user-1'])('refuses %s, whatever the token', async (as) => {
    for (const id of ['tok-pa', 'tok-user1', 'tok-svc', 'tok-owner']) {
      expect((await remove(as, id)).statusCode).toBe(403);
      expect(stillThere(id)).toBe(true);
    }
    expect(db.deleteApiToken).not.toHaveBeenCalled();
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });

  it('answers 404 for a token that is not in this project, whoever asks', async () => {
    for (const as of ['owner-1', 'admin-1']) {
      for (const id of ['tok-user1-proj2', 'tok-owner-proj2', 'tok-user1-tenant2', 'tok-missing', MALFORMED_ID]) {
        expect((await remove(as, id)).statusCode).toBe(404);
        if (id.startsWith('tok-') && id !== 'tok-missing') expect(stillThere(id)).toBe(true);
      }
    }
    expect(db.deleteApiToken).not.toHaveBeenCalled();
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });

  it('checks the project in the path as well as the token', async () => {
    // A token of proj-1 asked for under another project, or under a foreign one.
    for (const project of ['proj-2', 'proj-foreign', 'proj-missing']) {
      expect((await remove('owner-1', 'tok-user1', project)).statusCode).toBe(404);
    }
    expect(stillThere('tok-user1')).toBe(true);
    expect(db.deleteApiToken).not.toHaveBeenCalled();
  });

  it('answers 404 when the token disappears between the lookup and the delete', async () => {
    db.deleteApiToken.mockResolvedValueOnce(false);
    const res = await remove('owner-1', 'tok-user1');
    expect(res.statusCode).toBe(404);
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });
});
