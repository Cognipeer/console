/**
 * A token lives in a project. The dashboard's active project is the default, but the
 * Authorization center works on people whatever project it was opened in, so:
 *
 *   POST /api/tokens   body.projectId  mints in that project (it must exist in this
 *                      workspace; owners and admins are in every project, anyone else
 *                      needs access to it)
 *   PUT  /api/tokens/:id?projectId=    edits a token of that project (somebody else's only by
 *                                      someone who is in it; a token of one's own wherever it lives)
 *
 * Who may mint for or edit whom is unchanged ("never upward").
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
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }) }));
// the real lookup, watched: which requests ask about the caller's projects at all
vi.mock('@/lib/services/projects/accessibleProjects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/projects/accessibleProjects')>();
  return { ...actual, collectAccessibleProjectIds: vi.fn(actual.collectAccessibleProjectIds) };
});
vi.mock('@/lib/services/apiTokenAuth', () => ({
  ApiTokenAuthError: class extends Error {},
  apiAuthCacheKey: vi.fn(),
  invalidateApiTokenAuthCache: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
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
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, canLogin: true },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT, canLogin: true },
  'pa-1': { _id: 'pa-1', role: 'project_admin', tenantId: TENANT, canLogin: true },
  'pa-legacy': { _id: 'pa-legacy', role: 'project_admin', tenantId: TENANT, canLogin: true, projectIds: ['proj-2'] },
  'user-1': { _id: 'user-1', role: 'user', tenantId: TENANT, canLogin: true, projectIds: ['proj-legacy'] },
  'user-2': { _id: 'user-2', role: 'user', tenantId: TENANT, canLogin: true },
  'svc-1': { _id: 'svc-1', role: 'user', tenantId: TENANT, canLogin: false },
};
const PROJECTS: Record<string, Record<string, unknown>> = {
  'proj-1': { _id: 'proj-1', tenantId: TENANT },
  'proj-2': { _id: 'proj-2', tenantId: TENANT },
  'proj-legacy': { _id: 'proj-legacy', tenantId: TENANT },
  'proj-foreign': { _id: 'proj-foreign', tenantId: 'tenant-2' },
};

const headersFor = (userId: string) => ({
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': TENANT,
  'x-tenant-slug': 'acme',
  'x-user-id': userId,
  'x-user-role': String(USERS[userId].role),
});

describe('tokens in another project', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  const stored: Array<Record<string, unknown>> = [];
  // direct project memberships; the project_admin is in the active project only
  const memberships: Record<string, string[]> = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    stored.length = 0;
    stored.push(
      { _id: 'tok-p1', userId: 'user-2', tenantId: TENANT, projectId: 'proj-1', label: 'in project one', tokenHash: 'h1', createdAt: new Date() },
      { _id: 'tok-p2', userId: 'user-2', tenantId: TENANT, projectId: 'proj-2', label: 'in project two', tokenHash: 'h2', createdAt: new Date() },
      { _id: 'tok-owner-p2', userId: 'owner-1', tenantId: TENANT, projectId: 'proj-2', label: 'owner key', tokenHash: 'h3', createdAt: new Date() },
      { _id: 'tok-svc-p1', userId: 'svc-1', tenantId: TENANT, projectId: 'proj-1', label: 'service key one', tokenHash: 'h4', createdAt: new Date() },
      { _id: 'tok-svc-p2', userId: 'svc-1', tenantId: TENANT, projectId: 'proj-2', label: 'service key two', tokenHash: 'h5', createdAt: new Date() },
      { _id: 'tok-pa-p2', userId: 'pa-1', tenantId: TENANT, projectId: 'proj-2', label: 'lead key two', tokenHash: 'h6', createdAt: new Date() },
    );
    for (const key of Object.keys(memberships)) delete memberships[key];
    Object.assign(memberships, { 'user-2': ['proj-2'], 'pa-1': ['proj-1'], 'pa-legacy': ['proj-1'] });
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] ? { ...USERS[id] } : null) as never);
    db.findProjectById.mockImplementation(async (id: string) => {
      if (id === 'not-an-id') throw Object.assign(new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'), { name: 'BSONError' });
      return (PROJECTS[id] ? { ...PROJECTS[id] } : null) as never;
    });
    db.listProjectApiTokens.mockImplementation(async (_tenant: string, projectId: string) =>
      stored.filter((t) => t.projectId === projectId) as never);
    db.findApiTokenById.mockImplementation(async (id: string) => (stored.find((t) => t._id === id) ?? null) as never);
    db.updateApiToken.mockImplementation(async (id: string, _tenant: string, patch: Record<string, unknown>) => {
      const found = stored.find((t) => t._id === id);
      if (!found) return null as never;
      Object.assign(found, patch);
      return { ...found } as never;
    });
    db.createApiToken.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'tok-new', createdAt: new Date(), ...input }) as never);
    db.listUserProjectsByUser.mockImplementation(async (userId: string) =>
      (memberships[userId] ?? []).map((projectId) => ({ userId, projectId, role: 'member' })) as never);
    app = await createFastifyApiTestApp(tokensApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const mint = (as: string, body: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/api/tokens', headers: headersFor(as), payload: JSON.stringify({ label: 'new token', ...body }),
  });
  const edit = (as: string, id: string, body: Record<string, unknown>, query = '') => app.inject({
    method: 'PUT', url: `/api/tokens/${id}${query}`, headers: headersFor(as), payload: JSON.stringify(body),
  });

  describe('POST /api/tokens with a projectId', () => {
    it('mints in the active project by default, and says which', async () => {
      const res = await mint('admin-1', {});
      expect(res.statusCode).toBe(201);
      expect(parseJsonBody<{ projectId: string }>(res.body).projectId).toBe('proj-1');
      expect(db.createApiToken).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1' }));
    });

    it('an owner or admin mints in any project of the workspace', async () => {
      for (const as of ['owner-1', 'admin-1']) {
        const res = await mint(as, { projectId: 'proj-2' });
        expect(res.statusCode, as).toBe(201);
        expect(parseJsonBody<{ projectId: string }>(res.body).projectId).toBe('proj-2');
      }
      expect(db.createApiToken).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'proj-2', userId: 'admin-1' }));
    });

    it('can name the person the token is for and the project in one request', async () => {
      const res = await mint('admin-1', { projectId: 'proj-2', userId: 'svc-1' });
      expect(res.statusCode).toBe(201);
      expect(db.createApiToken).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-2', userId: 'svc-1', createdBy: 'admin-1' }));
    });

    it('counts the quota on the project the token goes to', async () => {
      await mint('admin-1', { projectId: 'proj-2' });
      expect(db.listProjectApiTokens).toHaveBeenCalledWith(TENANT, 'proj-2');
      expect((checkResourceQuota as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ projectId: 'proj-2' });
      (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ allowed: false, reason: 'apiTokens limit reached' });
      expect((await mint('admin-1', { projectId: 'proj-2' })).statusCode).toBe(429);
    });

    it('answers 404 for a project that is not this workspace\'s - or does not exist, or cannot be read', async () => {
      for (const projectId of ['proj-foreign', 'proj-missing', 'not-an-id']) {
        const res = await mint('owner-1', { projectId });
        expect(res.statusCode, projectId).toBe(404);
      }
      expect(db.createApiToken).not.toHaveBeenCalled();
    });

    it('a member needs access to the project: a membership, a group, or the legacy list', async () => {
      expect((await mint('user-2', { projectId: 'proj-2' })).statusCode).toBe(201); // a membership
      expect((await mint('user-1', { projectId: 'proj-legacy' })).statusCode).toBe(201); // the legacy list
      const stranger = await mint('user-2', { projectId: 'proj-legacy' });
      expect(stranger.statusCode).toBe(403);
      expect((await mint('pa-1', { projectId: 'proj-2' })).statusCode).toBe(403);
      expect(db.createApiToken).toHaveBeenCalledTimes(2);
    });

    it('naming the active project is no change', async () => {
      expect((await mint('user-2', { projectId: 'proj-1' })).statusCode).toBe(201);
      expect(db.findProjectById).not.toHaveBeenCalled();
    });

    it('keeps the rule about whose token it may be', async () => {
      expect((await mint('admin-1', { projectId: 'proj-2', userId: 'owner-1' })).statusCode).toBe(403);
      expect((await mint('pa-1', { userId: 'user-2' })).statusCode).toBe(403);
      expect((await mint('pa-1', { userId: 'svc-1' })).statusCode).toBe(201);
    });

    it('refuses a projectId or userId that is not text', async () => {
      for (const body of [{ projectId: 7 }, { projectId: ['proj-2'] }, { userId: { id: 'svc-1' } }, { userId: 5 }]) {
        const res = await mint('admin-1', body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(parseJsonBody<{ code: string }>(res.body).code).toBe('invalid_body');
      }
      expect(db.createApiToken).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/tokens/:id?projectId=', () => {
    it('edits a token of the project named, not only of the active one', async () => {
      expect((await edit('admin-1', 'tok-p2', { label: 'renamed token' })).statusCode).toBe(404); // the active project is proj-1
      const res = await edit('admin-1', 'tok-p2', { label: 'renamed token' }, '?projectId=proj-2');
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<{ label: string; canEdit: boolean; canDelete: boolean }>(res.body)).toMatchObject({ label: 'renamed token', canEdit: true, canDelete: true });
      expect(stored.find((t) => t._id === 'tok-p2')?.label).toBe('renamed token');
    });

    it('is still the active project without the query', async () => {
      expect((await edit('admin-1', 'tok-p1', { label: 'renamed token' })).statusCode).toBe(200);
    });

    it('does not find a token in a project it is not in', async () => {
      expect((await edit('owner-1', 'tok-p2', { label: 'renamed token' }, '?projectId=proj-1')).statusCode).toBe(404);
      expect((await edit('owner-1', 'tok-p1', { label: 'renamed token' }, '?projectId=proj-2')).statusCode).toBe(404);
    });

    it('keeps "never upward": an admin cannot edit the owner\'s token in any project', async () => {
      const res = await edit('admin-1', 'tok-owner-p2', { label: 'taken over' }, '?projectId=proj-2');
      expect(res.statusCode).toBe(403);
      expect(stored.find((t) => t._id === 'tok-owner-p2')?.label).toBe('owner key');
      expect((await edit('owner-1', 'tok-owner-p2', { label: 'owner key renamed' }, '?projectId=proj-2')).statusCode).toBe(200);
    });

    it('lets a person edit their own token of another project', async () => {
      expect((await edit('user-2', 'tok-p2', { label: 'my own renamed' }, '?projectId=proj-2')).statusCode).toBe(200);
    });

    it('refuses a query that is not a single value', async () => {
      const res = await edit('admin-1', 'tok-p2', { label: 'renamed token' }, '?projectId=proj-2&projectId=proj-1');
      expect([res.statusCode, parseJsonBody<{ code: string }>(res.body).code]).toEqual([400, 'invalid_filter']);
    });

    describe('a project_admin, who is not in every project', () => {
      const labelOf = (id: string) => stored.find((t) => t._id === id)?.label;

      it('cannot edit a service account\'s token in a project they are not in', async () => {
        const res = await edit('pa-1', 'tok-svc-p2', { label: 'reached across' }, '?projectId=proj-2');
        expect(res.statusCode).toBe(403);
        expect(labelOf('tok-svc-p2')).toBe('service key two');
        expect(db.updateApiToken).not.toHaveBeenCalled();
      });

      it('is told no more for a token that does not exist than for one that does', async () => {
        const res = await edit('pa-1', 'tok-nothing', { label: 'reached across' }, '?projectId=proj-2');
        expect(res.statusCode).toBe(403);
        // and an id of a token that lives somewhere else is no different
        expect((await edit('pa-1', 'tok-svc-p1', { label: 'reached across' }, '?projectId=proj-2')).statusCode).toBe(403);
      });

      it('edits it once they are in that project - by a membership, the legacy list or a group', async () => {
        memberships['pa-1'] = ['proj-1', 'proj-2'];
        expect((await edit('pa-1', 'tok-svc-p2', { label: 'by membership' }, '?projectId=proj-2')).statusCode).toBe(200);
        expect(labelOf('tok-svc-p2')).toBe('by membership');

        expect((await edit('pa-legacy', 'tok-svc-p2', { label: 'by the legacy list' }, '?projectId=proj-2')).statusCode).toBe(200);
        expect(labelOf('tok-svc-p2')).toBe('by the legacy list');

        memberships['pa-1'] = ['proj-1'];
        db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1', userId: 'pa-1' }] as never);
        db.listGroupProjectsByGroup.mockResolvedValue([{ groupId: 'g1', projectId: 'proj-2' }] as never);
        expect((await edit('pa-1', 'tok-svc-p2', { label: 'by a group' }, '?projectId=proj-2')).statusCode).toBe(200);
        expect(labelOf('tok-svc-p2')).toBe('by a group');
      });

      it('still keeps "never upward" inside a project they are in', async () => {
        memberships['pa-1'] = ['proj-1', 'proj-2'];
        const res = await edit('pa-1', 'tok-p2', { label: 'taken over' }, '?projectId=proj-2'); // a member's token
        expect(res.statusCode).toBe(403);
        expect(labelOf('tok-p2')).toBe('in project two');
      });

      it('edits in the active project - named or not - without being asked about its projects again', async () => {
        expect((await edit('pa-1', 'tok-svc-p1', { label: 'in the active project' })).statusCode).toBe(200);
        expect((await edit('pa-1', 'tok-svc-p1', { label: 'named active project' }, '?projectId=proj-1')).statusCode).toBe(200);
        expect(collectAccessibleProjectIds).not.toHaveBeenCalled();
      });

      it('edits a token of their own wherever it lives', async () => {
        const res = await edit('pa-1', 'tok-pa-p2', { label: 'my own key' }, '?projectId=proj-2');
        expect(res.statusCode).toBe(200);
        expect(labelOf('tok-pa-p2')).toBe('my own key');
      });
    });

    it('does not ask an owner or an admin about their projects - they are in every project', async () => {
      for (const as of ['owner-1', 'admin-1']) {
        expect((await edit(as, 'tok-svc-p2', { label: `by ${as}` }, '?projectId=proj-2')).statusCode, as).toBe(200);
      }
      expect(collectAccessibleProjectIds).not.toHaveBeenCalled();
    });
  });
});
