/**
 * Project access of API-token owners, against real databases.
 *
 * A token is bound to a project and authorises as its owner there, so the owner
 * must be able to work in that project: owners and admins reach every project,
 * everyone else needs a membership (a UserProject row, the legacy `projectIds`
 * list, or a group assignment) — the rule the dashboard uses. It is resolved
 * against live data on every request, so removing someone from a project (or
 * adding them back) applies on the very next call, whatever the auth cache holds.
 *
 * Runs the token auth path and the member routes on SQLite and, when
 * mongodb-memory-server is installed, MongoDB: the two providers store the
 * legacy list and the membership rows differently, and removal has to clear
 * both on each.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseProvider, IUser, ProjectRole } from '@/lib/database';

const h = vi.hoisted(() => ({ db: null as DatabaseProvider | null }));

// Route every `getDatabase()` / `runWithTenantScope()` in the code under test to
// the provider the parity harness is currently running against.
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  const current = async (): Promise<DatabaseProvider> => {
    if (!h.db) throw new Error('database provider not initialised');
    return h.db;
  };
  return {
    ...actual,
    getDatabase: current,
    getTenantDatabase: async (tenantDbName: string) => {
      const db = await current();
      await db.switchToTenant(tenantDbName);
      return db;
    },
    runWithTenantScope: async <T>(
      tenantDbName: string,
      fn: (db: DatabaseProvider) => T | Promise<T>,
    ): Promise<T> => {
      const db = await current();
      if (typeof db.runWithTenant === 'function') {
        return db.runWithTenant(tenantDbName, () => fn(db));
      }
      await db.switchToTenant(tenantDbName);
      return fn(db);
    },
  };
});

import { ApiTokenAuthError, requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { removeProjectMember } from '@/lib/services/projects/projectMembership';
import { withClientApiRequestContext } from '@/server/api/fastify-utils';
import { clientProjectsApiPlugin } from '@/server/api/plugins/client-projects';
import { clientUsersApiPlugin } from '@/server/api/plugins/client-users';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

/** The routes under test, plus a probe that does nothing but authenticate a token. */
const apiUnderTest: FastifyPluginAsync = async (app) => {
  await app.register(usersApiPlugin);
  await app.register(projectsApiPlugin);
  await app.register(tokensApiPlugin);
  await app.register(clientProjectsApiPlugin);
  await app.register(clientUsersApiPlugin);
  app.get('/client/v1/_probe', withClientApiRequestContext(
    async (_request, reply, auth) => reply.send({ projectId: auth.projectId, userId: String(auth.user?._id) }),
    { rbac: false },
  ));
};

const uid = (): string => Math.random().toString(36).slice(2, 10);

interface Fixture {
  tenantId: string;
  tenantDbName: string;
  /** The project the scenarios work in. */
  alpha: string;
  /** A second project. */
  beta: string;
  /** The tenant's default project. */
  fallback: string;
  owner: IUser;
  admin: IUser;
  ownerToken: string;
}

describeForEachProvider('API token project access', (getDb) => {
  let f: Fixture;
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeAll(async () => {
    const db = getDb();
    h.db = db;

    const suffix = uid();
    const tenantDbName = `tenant_tpa_${suffix}`;
    const tenant = await db.createTenant({
      companyName: 'Token Access Co',
      slug: `tpa-${suffix}`,
      dbName: tenantDbName,
      licenseType: 'enterprise',
    });
    const tenantId = String(tenant._id);
    await db.switchToTenant(tenantDbName);

    const mkUser = (name: string, role: IUser['role']) => db.createUser({
      email: `${name}-${suffix}@example.com`,
      password: 'x',
      name,
      tenantId,
      role,
      licenseId: 'test',
    });
    const owner = await mkUser('owner', 'owner');
    const admin = await mkUser('admin', 'admin');

    const mkProject = (key: string) => db.createProject({
      tenantId,
      key,
      name: key,
      createdBy: String(owner._id),
    });
    const fallback = await mkProject('default');
    const alpha = await mkProject('alpha');
    const beta = await mkProject('beta');

    f = {
      tenantId,
      tenantDbName,
      alpha: String(alpha._id),
      beta: String(beta._id),
      fallback: String(fallback._id),
      owner,
      admin,
      ownerToken: '',
    };
    f.ownerToken = await mintToken(owner, f.alpha);

    app = await createFastifyApiTestApp(apiUnderTest);
    return async () => {
      await app.close();
      h.db = null;
    };
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Stores a token for `user` bound to `projectId` (or to nothing) and returns its secret. */
  async function mintToken(user: IUser, projectId?: string): Promise<string> {
    const secret = createApiTokenSecret();
    await getDb().createApiToken({
      userId: String(user._id),
      tenantId: f.tenantId,
      projectId,
      label: `token-${uid()}`,
      tokenHash: hashApiToken(secret),
      tokenPrefix: getApiTokenPrefix(secret),
    });
    return secret;
  }

  /** A tenant user with the given project access, none by default. */
  async function addUser(options: {
    role?: IUser['role'];
    canLogin?: boolean;
    /** Legacy `projectIds` entries. */
    legacy?: string[];
    /** UserProject rows. */
    rows?: Array<{ projectId: string; role?: ProjectRole }>;
  } = {}): Promise<IUser> {
    const db = getDb();
    const user = await db.createUser({
      email: options.canLogin === false ? '' : `user-${uid()}@example.com`,
      password: 'x',
      name: `user-${uid()}`,
      tenantId: f.tenantId,
      role: options.role ?? 'user',
      licenseId: 'test',
      canLogin: options.canLogin,
      projectIds: options.legacy,
    });
    for (const row of options.rows ?? []) {
      await db.upsertUserProject({
        tenantId: f.tenantId,
        userId: String(user._id),
        projectId: row.projectId,
        role: row.role ?? 'member',
        invitedBy: String(f.owner._id),
      });
    }
    return user;
  }

  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

  const authenticate = (secret: string) => requireApiTokenFromHeader(`Bearer ${secret}`);

  async function refusal(secret: string): Promise<ApiTokenAuthError> {
    const error = await authenticate(secret).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApiTokenAuthError);
    return error as ApiTokenAuthError;
  }

  const sessionHeaders = (user: IUser, extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    'x-license-type': 'ENTERPRISE',
    'x-tenant-db-name': f.tenantDbName,
    'x-tenant-id': f.tenantId,
    'x-tenant-slug': 'tpa',
    'x-user-email': user.email,
    'x-user-id': String(user._id),
    'x-user-role': user.role,
    ...extra,
  });

  const probe = (secret: string) => app.inject({
    method: 'GET',
    url: '/api/client/v1/_probe',
    headers: bearer(secret),
  });

  const removeViaDashboard = (projectId: string, userId: string) => app.inject({
    method: 'DELETE',
    url: `/api/projects/${projectId}/members`,
    headers: sessionHeaders(f.owner),
    payload: JSON.stringify({ userId }),
  });

  const removeViaClientApi = (projectId: string, userId: string) => app.inject({
    method: 'DELETE',
    url: `/api/client/v1/projects/${projectId}/members`,
    headers: { ...bearer(f.ownerToken), 'content-type': 'application/json' },
    payload: JSON.stringify({ userId }),
  });

  const addViaDashboard = (projectId: string, userId: string) => app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/members`,
    headers: sessionHeaders(f.owner),
    payload: JSON.stringify({ userId }),
  });

  const listMembers = async (projectId: string): Promise<string[]> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: sessionHeaders(f.owner),
    });
    expect(res.statusCode).toBe(200);
    return parseJsonBody<{ members: Array<{ userId: string }> }>(res.body).members.map((m) => m.userId);
  };

  // ── who may use a project-bound token ──────────────────────────────────────

  describe('who may use a token bound to a project', () => {
    it('accepts owner and admin tokens in every project, with no membership', async () => {
      for (const user of [f.owner, f.admin]) {
        for (const projectId of [f.alpha, f.beta, f.fallback]) {
          const ctx = await authenticate(await mintToken(user, projectId));
          expect(ctx.projectId).toBe(projectId);
        }
      }
    });

    it('accepts a member through a UserProject row, a legacy list entry or a project_admin row', async () => {
      const viaRow = await addUser({ rows: [{ projectId: f.alpha }] });
      const viaLegacy = await addUser({ legacy: [f.alpha] });
      const viaAdminRow = await addUser({ role: 'project_admin', rows: [{ projectId: f.alpha, role: 'project_admin' }] });
      for (const user of [viaRow, viaLegacy, viaAdminRow]) {
        const ctx = await authenticate(await mintToken(user, f.alpha));
        expect(ctx.projectId).toBe(f.alpha);
        expect(String(ctx.user?._id)).toBe(String(user._id));
      }
    });

    it('accepts a member whose access comes from a group assigned to the project', async () => {
      const db = getDb();
      const user = await addUser();
      const group = await db.createGroup({ tenantId: f.tenantId, name: `g-${uid()}`, createdBy: String(f.owner._id) });
      await db.addGroupMember({ tenantId: f.tenantId, groupId: String(group._id), userId: String(user._id), role: 'member' });
      await db.upsertGroupProject({ tenantId: f.tenantId, groupId: String(group._id), projectId: f.alpha, role: 'member' });

      await expect(authenticate(await mintToken(user, f.alpha))).resolves.toMatchObject({ projectId: f.alpha });
      expect((await refusal(await mintToken(user, f.beta))).status).toBe(403);
    });

    it('refuses a member in a project they do not belong to', async () => {
      const member = await addUser({ rows: [{ projectId: f.alpha }] });
      const error = await refusal(await mintToken(member, f.beta));
      expect(error.status).toBe(403);
      expect(error.message).toBe('API token owner has no access to the token project');
    });

    it('refuses a user with no membership at all', async () => {
      const nobody = await addUser();
      expect((await refusal(await mintToken(nobody, f.alpha))).status).toBe(403);
    });

    it('applies the same rule to the default project for a token that has no project', async () => {
      const unbound = await mintToken(f.owner);
      await expect(authenticate(unbound)).resolves.toMatchObject({ projectId: f.fallback });

      const otherProjectMember = await addUser({ rows: [{ projectId: f.alpha }] });
      expect((await refusal(await mintToken(otherProjectMember))).status).toBe(403);

      const member = await addUser({ rows: [{ projectId: f.fallback }] });
      await expect(authenticate(await mintToken(member))).resolves.toMatchObject({ projectId: f.fallback });
    });

    it('accepts the token of a login-disabled service account that has no membership', async () => {
      const service = await addUser({ canLogin: false });
      await expect(authenticate(await mintToken(service, f.alpha))).resolves.toMatchObject({ projectId: f.alpha });
    });
  });

  // ── membership changes apply on the next request ──────────────────────────

  describe('membership changes', () => {
    it('refuses the token once the owner is removed from the project and accepts it again when added back', async () => {
      const db = getDb();
      const spy = vi.spyOn(db, 'findApiTokenByHash');
      const member = await addUser({ rows: [{ projectId: f.alpha }] });
      const secret = await mintToken(member, f.alpha);

      await expect(authenticate(secret)).resolves.toMatchObject({ projectId: f.alpha });
      expect(spy).toHaveBeenCalledTimes(1);

      const removal = await removeProjectMember({
        db,
        projectId: f.alpha,
        target: (await db.findUserById(String(member._id)))!,
        tenantDbName: f.tenantDbName,
      });
      expect(removal).toBe('removed');
      expect((await refusal(secret)).status).toBe(403);

      await db.upsertUserProject({
        tenantId: f.tenantId,
        userId: String(member._id),
        projectId: f.alpha,
        role: 'member',
        invitedBy: String(f.owner._id),
      });
      await expect(authenticate(secret)).resolves.toMatchObject({ projectId: f.alpha });

      // Every request after the first was answered from the auth cache; the
      // access decision was still made fresh each time.
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('refuses a user who holds both membership sources after a single removal', async () => {
      const db = getDb();
      const invited = await addUser({ legacy: [f.alpha], rows: [{ projectId: f.alpha }] });
      const secret = await mintToken(invited, f.alpha);
      await expect(authenticate(secret)).resolves.toMatchObject({ projectId: f.alpha });

      const result = await removeProjectMember({
        db,
        projectId: f.alpha,
        target: (await db.findUserById(String(invited._id)))!,
        tenantDbName: f.tenantDbName,
      });

      expect(result).toBe('removed');
      expect(await db.findUserProject(String(invited._id), f.alpha)).toBeNull();
      expect((await db.findUserById(String(invited._id)))?.projectIds ?? []).not.toContain(f.alpha);
      expect((await refusal(secret)).status).toBe(403);
    });

    it('keeps the user\'s other projects when one is removed', async () => {
      const db = getDb();
      const user = await addUser({ legacy: [f.alpha, f.beta], rows: [{ projectId: f.alpha }, { projectId: f.beta }] });

      await removeProjectMember({
        db,
        projectId: f.alpha,
        target: (await db.findUserById(String(user._id)))!,
        tenantDbName: f.tenantDbName,
      });

      expect((await db.findUserById(String(user._id)))?.projectIds).toEqual([f.beta]);
      expect((await refusal(await mintToken(user, f.alpha))).status).toBe(403);
      await expect(authenticate(await mintToken(user, f.beta))).resolves.toMatchObject({ projectId: f.beta });
    });

    it('applies group changes on the next request', async () => {
      const db = getDb();
      const user = await addUser();
      const group = await db.createGroup({ tenantId: f.tenantId, name: `g-${uid()}`, createdBy: String(f.owner._id) });
      const groupId = String(group._id);
      await db.addGroupMember({ tenantId: f.tenantId, groupId, userId: String(user._id), role: 'member' });
      await db.upsertGroupProject({ tenantId: f.tenantId, groupId, projectId: f.alpha, role: 'member' });
      const secret = await mintToken(user, f.alpha);

      await expect(authenticate(secret)).resolves.toMatchObject({ projectId: f.alpha });

      await db.removeGroupMember(groupId, String(user._id));
      expect((await refusal(secret)).status).toBe(403);

      await db.addGroupMember({ tenantId: f.tenantId, groupId, userId: String(user._id), role: 'member' });
      await expect(authenticate(secret)).resolves.toMatchObject({ projectId: f.alpha });

      await db.removeGroupProject(groupId, f.alpha);
      expect((await refusal(secret)).status).toBe(403);
    });

    it('answers the removal result for a user who was never a member', async () => {
      const db = getDb();
      const stranger = await addUser();
      const result = await removeProjectMember({
        db,
        projectId: f.alpha,
        target: (await db.findUserById(String(stranger._id)))!,
        tenantDbName: f.tenantDbName,
      });
      expect(result).toBe('not_found');
    });

    it('revokes the tokens of a removed login-disabled account for that project only', async () => {
      const db = getDb();
      const service = await addUser({ canLogin: false, legacy: [f.alpha], rows: [{ projectId: f.alpha }] });
      const inAlpha = await mintToken(service, f.alpha);
      const inBeta = await mintToken(service, f.beta);
      await expect(authenticate(inAlpha)).resolves.toMatchObject({ projectId: f.alpha });
      await expect(authenticate(inBeta)).resolves.toMatchObject({ projectId: f.beta });

      const result = await removeProjectMember({
        db,
        projectId: f.alpha,
        target: (await db.findUserById(String(service._id)))!,
        tenantDbName: f.tenantDbName,
      });

      expect(result).toBe('removed');
      // Gone from the store and from the auth cache the first request filled.
      expect(await db.findApiTokenByHash(hashApiToken(inAlpha))).toBeNull();
      const error = await refusal(inAlpha);
      expect(error.status).toBe(401);
      expect(error.message).toBe('Invalid API token');
      await expect(authenticate(inBeta)).resolves.toMatchObject({ projectId: f.beta });
    });

    it('leaves the tokens of a removed login-capable user in place', async () => {
      const db = getDb();
      const member = await addUser({ rows: [{ projectId: f.alpha }] });
      const secret = await mintToken(member, f.alpha);
      await removeProjectMember({
        db,
        projectId: f.alpha,
        target: (await db.findUserById(String(member._id)))!,
        tenantDbName: f.tenantDbName,
      });
      expect(await db.findApiTokenByHash(hashApiToken(secret))).not.toBeNull();
    });
  });

  // ── over HTTP ──────────────────────────────────────────────────────────────

  describe('token requests over HTTP', () => {
    it('answers 403 once the owner is removed from the project and 200 after they are added back', async () => {
      const member = await addUser({ rows: [{ projectId: f.alpha }] });
      const secret = await mintToken(member, f.alpha);

      const ok = await probe(secret);
      expect(ok.statusCode).toBe(200);
      expect(parseJsonBody<{ projectId: string }>(ok.body).projectId).toBe(f.alpha);

      expect((await removeViaDashboard(f.alpha, String(member._id))).statusCode).toBe(200);
      const refused = await probe(secret);
      expect(refused.statusCode).toBe(403);
      expect(parseJsonBody<{ error: string }>(refused.body).error).toBe('API token owner has no access to the token project');

      expect((await addViaDashboard(f.alpha, String(member._id))).statusCode).toBe(200);
      expect((await probe(secret)).statusCode).toBe(200);
    });

    it('answers 200 to owner and admin tokens and 403 to a user without access', async () => {
      expect((await probe(f.ownerToken)).statusCode).toBe(200);
      expect((await probe(await mintToken(f.admin, f.beta))).statusCode).toBe(200);
      expect((await probe(await mintToken(await addUser(), f.alpha))).statusCode).toBe(403);
    });

    it('refuses to mint a session token for a user who cannot access the project, and mints for one who can', async () => {
      const otherProjectMember = await addUser({ rows: [{ projectId: f.beta }] });
      const member = await addUser({ rows: [{ projectId: f.alpha }] });
      const mint = (userId: string) => app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: sessionHeaders(f.owner, { cookie: `active_project_id=${f.alpha}` }),
        payload: JSON.stringify({ label: 'integration', userId }),
      });

      const refused = await mint(String(otherProjectMember._id));
      expect(refused.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(refused.body).error).toBe('User does not have access to this project');
      expect(await getDb().listApiTokens(String(otherProjectMember._id))).toHaveLength(0);

      const created = await mint(String(member._id));
      expect(created.statusCode).toBe(201);
      const { token } = parseJsonBody<{ token: string }>(created.body);
      expect((await probe(token)).statusCode).toBe(200);
    });

    it('refuses to mint a client-API token for a user who cannot access the token project, and allows a service account', async () => {
      const otherProjectMember = await addUser({ rows: [{ projectId: f.beta }] });
      const service = await addUser({ canLogin: false });
      const mint = (userId: string) => app.inject({
        method: 'POST',
        url: `/api/client/v1/users/${userId}/tokens`,
        headers: { ...bearer(f.ownerToken), 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'integration' }),
      });

      expect((await mint(String(otherProjectMember._id))).statusCode).toBe(400);
      expect(await getDb().listApiTokens(String(otherProjectMember._id))).toHaveLength(0);

      const created = await mint(String(service._id));
      expect(created.statusCode).toBe(201);
      const { token } = parseJsonBody<{ token: string }>(created.body);
      const ok = await probe(token);
      expect(ok.statusCode).toBe(200);
      expect(parseJsonBody<{ projectId: string }>(ok.body).projectId).toBe(f.alpha);
    });
  });

  // ── removing a member removes every record of the membership ───────────────

  describe('DELETE project member', () => {
    type Remove = (projectId: string, userId: string) => ReturnType<typeof removeViaDashboard>;
    const surfaces: Array<[string, () => Remove]> = [
      ['dashboard (/api/projects/:id/members)', () => removeViaDashboard],
      ['client API (/api/client/v1/projects/:id/members)', () => removeViaClientApi],
    ];

    describe.each(surfaces)('%s', (_label, remover) => {
      it('removes a user invited with an initial project in one call', async () => {
        const invite = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: sessionHeaders(f.owner),
          payload: JSON.stringify({ name: 'Invited', role: 'user', canLogin: false, projectId: f.alpha }),
        });
        expect(invite.statusCode).toBe(201);
        const userId = String(parseJsonBody<{ user: { id: string } }>(invite.body).user.id);

        // The invite flow records the project on the user and as a membership row.
        const invited = await getDb().findUserById(userId);
        expect(invited?.projectIds).toContain(f.alpha);
        expect(await getDb().findUserProject(userId, f.alpha)).not.toBeNull();
        expect(await listMembers(f.alpha)).toContain(userId);

        const removed = await remover()(f.alpha, userId);
        expect(removed.statusCode).toBe(200);

        expect(await listMembers(f.alpha)).not.toContain(userId);
        expect(await getDb().findUserProject(userId, f.alpha)).toBeNull();
        expect((await getDb().findUserById(userId))?.projectIds ?? []).not.toContain(f.alpha);

        // Nothing left to remove: the second call says so.
        expect((await remover()(f.alpha, userId)).statusCode).toBe(404);
      });

      it('removes a login-capable invited user, so their token no longer works in the project', async () => {
        const invite = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: sessionHeaders(f.owner),
          payload: JSON.stringify({
            name: 'Invited Person',
            email: `invited-${uid()}@example.com`,
            role: 'user',
            projectId: f.alpha,
            sendInvite: false,
          }),
        });
        expect(invite.statusCode).toBe(201);
        const userId = String(parseJsonBody<{ user: { id: string } }>(invite.body).user.id);
        const secret = await mintToken((await getDb().findUserById(userId))!, f.alpha);
        expect((await probe(secret)).statusCode).toBe(200);

        expect((await remover()(f.alpha, userId)).statusCode).toBe(200);
        expect((await probe(secret)).statusCode).toBe(403);
      });

      it('removes a login-disabled user and deletes the tokens it holds for the project', async () => {
        const service = await addUser({ canLogin: false, legacy: [f.alpha], rows: [{ projectId: f.alpha }] });
        const inAlpha = await mintToken(service, f.alpha);
        const inBeta = await mintToken(service, f.beta);
        expect((await probe(inAlpha)).statusCode).toBe(200);

        expect((await remover()(f.alpha, String(service._id))).statusCode).toBe(200);

        expect(await getDb().findApiTokenByHash(hashApiToken(inAlpha))).toBeNull();
        expect((await probe(inAlpha)).statusCode).toBe(401);
        expect((await probe(inBeta)).statusCode).toBe(200);
      });

      it('removes a user who only has a legacy list entry', async () => {
        const user = await addUser({ legacy: [f.alpha, f.beta] });
        expect((await remover()(f.alpha, String(user._id))).statusCode).toBe(200);
        expect((await getDb().findUserById(String(user._id)))?.projectIds).toEqual([f.beta]);
      });

      it('removes a user who only has a membership row', async () => {
        const user = await addUser({ rows: [{ projectId: f.alpha }] });
        expect((await remover()(f.alpha, String(user._id))).statusCode).toBe(200);
        expect(await getDb().findUserProject(String(user._id), f.alpha)).toBeNull();
      });

      it('answers 404 for a user who is not a member and 400 for an owner or admin', async () => {
        const stranger = await addUser();
        expect((await remover()(f.alpha, String(stranger._id))).statusCode).toBe(404);
        expect((await remover()(f.alpha, String(f.admin._id))).statusCode).toBe(400);
      });
    });
  });
});
