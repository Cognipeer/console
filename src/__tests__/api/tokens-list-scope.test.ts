/**
 * Which API tokens a session sees and may delete.
 *
 *   GET /api/tokens                  the caller's own tokens, for every role;
 *   GET /api/tokens?userId=<id>      another user's tokens, never upward;
 *   GET /api/tokens?scope=project    the project's tokens, owner/admin only
 *                                    (minus the accounts they may not act on);
 *   DELETE /api/tokens/:id           the token's owner always, anyone else under
 *                                    the same never-upward rule.
 *
 * An account id the provider cannot parse is "no such account" (404) wherever
 * an endpoint resolves one from a request, never a 500.
 *
 * The database is an in-memory fake, so the assertions are on what each caller
 * gets back and what is left afterwards, not on which query was issued.
 */
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

import { getDatabase } from '@/lib/database';
import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
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
  // Reachable by id, but not this tenant's.
  'stranger-1': { _id: 'stranger-1', role: 'user', tenantId: 'tenant-2', canLogin: true },
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

/** One project of one tenant, with tokens of every kind of owner in it. */
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
    // The same people, elsewhere: never part of this project's listings.
    tokenRow('tok-user1-proj2', 'user-1', { projectId: 'proj-2' }),
    tokenRow('tok-user1-tenant2', 'user-1', { tenantId: 'tenant-2' }),
    tokenRow('tok-owner-proj2', 'owner-1', { projectId: 'proj-2' }),
  ];
}

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
  db.findUserById.mockImplementation(async (id: string) => {
    if (id.startsWith(MALFORMED_ID)) {
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
  db.deleteApiToken.mockImplementation(async (id: string, userId: string) =>
    removeWhere((row) => row._id === id && row.userId === userId));
  app = await createFastifyApiTestApp(tokensApiPlugin);
});

afterEach(async () => {
  await app.close();
});

const list = (as: string, query = '') => app.inject({
  method: 'GET',
  url: `/api/tokens${query}`,
  headers: sessionHeaders(as),
});

const idsOf = (body: string) => parseJsonBody<ListReply>(body).tokens.map((token) => token._id).sort();

describe('GET /api/tokens (default listing)', () => {
  it.each([
    ['owner-1', ['tok-owner']],
    ['admin-1', ['tok-admin']],
    ['pa-1', ['tok-pa']],
    ['user-1', ['tok-user1']],
  ])('lists only the tokens %s owns, in this project', async (as, expected) => {
    const res = await list(as);
    expect(res.statusCode).toBe(200);
    expect(idsOf(res.body)).toEqual(expected);
  });

  it('shows nothing of anyone else\'s tokens', async () => {
    const res = await list('owner-1');
    for (const other of ['tok-admin', 'tok-pa', 'tok-user1', 'tok-user2', 'tok-svc', 'tok-ghost']) {
      expect(res.body).not.toContain(other);
      expect(res.body).not.toContain(`label of ${other}`);
    }
  });

  it('marks every listed token as deletable and keeps the response shape', async () => {
    const res = await list('user-1');
    const [only] = parseJsonBody<ListReply>(res.body).tokens;
    expect(only).toMatchObject({
      _id: 'tok-user1',
      canDelete: true,
      label: 'label of tok-user1',
      tokenPrefix: 'cpeer_tok-user1',
      userId: 'user-1',
    });
    expect(res.body).not.toContain('hash-of-');
  });

  it('is empty for someone with no tokens in this project', async () => {
    tokens = tokens.filter((row) => row.userId !== 'user-2');
    const res = await list('user-2');
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<ListReply>(res.body).tokens).toEqual([]);
  });

  it('treats an empty userId or scope as absent', async () => {
    const res = await list('user-1', '?userId=&scope=');
    expect(res.statusCode).toBe(200);
    expect(idsOf(res.body)).toEqual(['tok-user1']);
  });
});

describe('GET /api/tokens?userId=', () => {
  it('lets every role open its own tokens by id', async () => {
    for (const as of ['owner-1', 'admin-1', 'pa-1', 'user-1']) {
      const res = await list(as, `?userId=${as}`);
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<ListReply>(res.body).tokens.every((token) => token.userId === as)).toBe(true);
    }
  });

  it('lets the owner open anyone\'s tokens', async () => {
    expect(idsOf((await list('owner-1', '?userId=admin-1')).body)).toEqual(['tok-admin']);
    expect(idsOf((await list('owner-1', '?userId=svc-1')).body)).toEqual(['tok-svc']);
  });

  it('lets an admin open everyone\'s but the owner\'s', async () => {
    expect(idsOf((await list('admin-1', '?userId=user-1')).body)).toEqual(['tok-user1']);
    expect(idsOf((await list('admin-1', '?userId=admin-2')).body)).toEqual(['tok-admin2']);
    const refused = await list('admin-1', '?userId=owner-1');
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain('tok-owner');
  });

  it('lets a project_admin open only login-disabled accounts', async () => {
    expect(idsOf((await list('pa-1', '?userId=svc-1')).body)).toEqual(['tok-svc']);
    for (const target of ['user-1', 'admin-1', 'owner-1']) {
      expect((await list('pa-1', `?userId=${target}`)).statusCode).toBe(403);
    }
  });

  it('never lets a user open anyone else\'s tokens', async () => {
    for (const target of ['user-2', 'svc-1', 'pa-1', 'admin-1', 'owner-1']) {
      const res = await list('user-1', `?userId=${target}`);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('tok-');
    }
  });

  it('answers 404 for an account that does not exist or belongs to another tenant', async () => {
    expect((await list('owner-1', '?userId=nobody')).statusCode).toBe(404);
    expect((await list('owner-1', '?userId=stranger-1')).statusCode).toBe(404);
  });

  it('rejects a userId that is not a single value', async () => {
    const res = await list('owner-1', '?userId=user-1&userId=user-2');
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('tok-');
  });
});

describe('GET /api/tokens?scope=project', () => {
  it('gives the owner every token of the project', async () => {
    const res = await list('owner-1', '?scope=project');
    expect(res.statusCode).toBe(200);
    expect(idsOf(res.body)).toEqual([
      'tok-admin', 'tok-admin2', 'tok-ghost', 'tok-owner', 'tok-pa', 'tok-svc', 'tok-user1', 'tok-user2',
    ]);
    expect(parseJsonBody<ListReply>(res.body).tokens.every((token) => token.canDelete)).toBe(true);
  });

  it('gives an admin every token it may act on — never the owner\'s', async () => {
    const res = await list('admin-1', '?scope=project');
    expect(res.statusCode).toBe(200);
    expect(idsOf(res.body)).toEqual(['tok-admin', 'tok-admin2', 'tok-pa', 'tok-svc', 'tok-user1', 'tok-user2']);
    expect(res.body).not.toContain('tok-owner');
    expect(res.body).not.toContain('label of tok-owner');
    // The same refusal as opening that account by id.
    expect((await list('admin-1', '?userId=owner-1')).statusCode).toBe(403);
  });

  it('leaves out tokens whose account cannot be resolved for anyone but the owner', async () => {
    expect(idsOf((await list('admin-1', '?scope=project')).body)).not.toContain('tok-ghost');
    expect(idsOf((await list('owner-1', '?scope=project')).body)).toContain('tok-ghost');
  });

  it.each(['pa-1', 'user-1'])('refuses %s, however it is asked', async (as) => {
    for (const query of ['?scope=project', '?scope=project&userId=owner-1']) {
      const res = await list(as, query);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('tok-');
    }
  });

  it('does not combine with userId', async () => {
    const res = await list('owner-1', '?scope=project&userId=user-1');
    expect(res.statusCode).toBe(400);
  });

  it('only knows the project scope', async () => {
    for (const scope of ['all', 'tenant', 'Project']) {
      const res = await list('owner-1', `?scope=${scope}`);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('tok-');
    }
    expect((await list('owner-1', '?scope=project&scope=project')).statusCode).toBe(400);
  });
});

describe('DELETE /api/tokens/:id', () => {
  const remove = (as: string, id: string) => app.inject({
    method: 'DELETE',
    url: `/api/tokens/${id}`,
    headers: sessionHeaders(as),
  });
  const stillThere = (id: string) => tokens.some((row) => row._id === id);

  it.each([
    ['owner-1', 'tok-owner'],
    ['admin-1', 'tok-admin'],
    ['pa-1', 'tok-pa'],
    ['user-1', 'tok-user1'],
  ])('lets %s delete its own token %s', async (as, id) => {
    const res = await remove(as, id);
    expect(res.statusCode).toBe(200);
    expect(stillThere(id)).toBe(false);
    expect(invalidateApiTokenAuthCache).toHaveBeenCalledWith(`hash-of-${id}`);
  });

  it('lets the owner delete any token of the project', async () => {
    for (const id of ['tok-admin', 'tok-admin2', 'tok-pa', 'tok-user1', 'tok-svc', 'tok-ghost']) {
      expect((await remove('owner-1', id)).statusCode).toBe(200);
      expect(stillThere(id)).toBe(false);
    }
  });

  it('lets an admin delete a member\'s token or a colleague\'s, but not the owner\'s', async () => {
    for (const id of ['tok-user1', 'tok-svc', 'tok-pa', 'tok-admin2']) {
      expect((await remove('admin-1', id)).statusCode).toBe(200);
      expect(stillThere(id)).toBe(false);
    }
    vi.mocked(invalidateApiTokenAuthCache).mockClear();

    const refused = await remove('admin-1', 'tok-owner');
    expect(refused.statusCode).toBe(403);
    expect(stillThere('tok-owner')).toBe(true);
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });

  it('lets a project_admin delete a login-disabled account\'s token and nobody else\'s', async () => {
    expect((await remove('pa-1', 'tok-svc')).statusCode).toBe(200);
    expect(stillThere('tok-svc')).toBe(false);
    vi.mocked(invalidateApiTokenAuthCache).mockClear();

    for (const id of ['tok-owner', 'tok-admin', 'tok-admin2', 'tok-user1', 'tok-user2', 'tok-ghost']) {
      const res = await remove('pa-1', id);
      expect(res.statusCode).toBe(403);
      expect(stillThere(id)).toBe(true);
    }
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });

  it('does not let a user delete anyone else\'s token, and does not say it exists', async () => {
    for (const id of ['tok-user2', 'tok-svc', 'tok-pa', 'tok-admin', 'tok-owner']) {
      const res = await remove('user-1', id);
      expect(res.statusCode).toBe(404);
      expect(stillThere(id)).toBe(true);
    }
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });

  it('answers 404 for a token that is not in this project, whoever asks', async () => {
    for (const as of ['owner-1', 'admin-1', 'pa-1', 'user-1']) {
      for (const id of ['tok-user1-proj2', 'tok-user1-tenant2', 'tok-owner-proj2', 'tok-missing']) {
        expect((await remove(as, id)).statusCode).toBe(404);
        if (id !== 'tok-missing') expect(stillThere(id)).toBe(true);
      }
    }
    expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
  });

  it('keeps what a refused delete would have removed listed for its owner', async () => {
    expect((await remove('pa-1', 'tok-owner')).statusCode).toBe(403);
    expect(idsOf((await list('owner-1')).body)).toEqual(['tok-owner']);
  });
});

describe('an account id the provider cannot parse', () => {
  const mint = (as: string, userId: string) => app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { ...sessionHeaders(as), 'content-type': 'application/json' },
    payload: JSON.stringify({ label: 'ci-token', userId }),
  });

  it.each(['owner-1', 'admin-1', 'pa-1', 'user-1'])('is a 404, not a 500, for %s opening ?userId=', async (as) => {
    const res = await list(as, `?userId=${MALFORMED_ID}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('tok-');
  });

  it('is a 404 however long it is', async () => {
    const res = await list('owner-1', `?userId=${MALFORMED_ID}${'x'.repeat(4000)}`);
    expect(res.statusCode).toBe(404);
  });

  it('is a 404 when minting for it', async () => {
    for (const as of ['owner-1', 'admin-1', 'pa-1']) {
      const res = await mint(as, MALFORMED_ID);
      expect(res.statusCode).toBe(404);
    }
    expect(db.createApiToken).not.toHaveBeenCalled();
  });

  it('still answers like any other unknown account elsewhere', async () => {
    expect((await list('owner-1', '?userId=nobody')).statusCode).toBe(404);
    expect((await mint('owner-1', 'nobody')).statusCode).toBe(404);
    expect((await mint('pa-1', 'owner-1')).statusCode).toBe(403);
  });

  it('hides the tokens of such an account from everyone but the owner role', async () => {
    tokens.push(tokenRow('tok-bad', MALFORMED_ID));
    expect(idsOf((await list('admin-1', '?scope=project')).body)).not.toContain('tok-bad');
    expect(idsOf((await list('owner-1', '?scope=project')).body)).toContain('tok-bad');
    expect((await app.inject({
      method: 'DELETE',
      url: '/api/tokens/tok-bad',
      headers: sessionHeaders('admin-1'),
    })).statusCode).toBe(403);
    expect(tokens.some((row) => row._id === 'tok-bad')).toBe(true);
  });
});
