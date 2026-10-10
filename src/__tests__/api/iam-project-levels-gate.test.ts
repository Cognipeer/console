/**
 * Project-level service permissions at the REAL request gates and the Authorization
 * center, on BOTH SQLite and MongoDB.
 *
 * A project membership (a person's or a group's assignment to a project) can carry a
 * level per service, and the engine applies it as a ceiling. Before the engine decided
 * anything those levels were only stored, and the member screens also saved a service
 * that was touched and put back as an explicit `none`. So:
 *
 *   - the first decision of a workspace records that moment once (`iam_meta`,
 *     `project_levels_since`);
 *   - an explicit `none` in a row last saved BEFORE it is read as "not set";
 *   - `read` / `write` / `admin` entries, and every entry of a row saved after it, count.
 *
 * Also here: a token without a project runs in the default one, and the gate, the
 * access check and the principal detail agree about it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), tokens: new Map<string, unknown>() }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: async (header: string | null) => {
      const ctx = hoisted.tokens.get(String(header).replace(/^Bearer /, ''));
      if (!ctx) throw new ApiTokenAuthError('Invalid API token', 401);
      return ctx;
    },
  };
});

import type { FastifyInstance } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { PROJECT_LEVELS_DOC_ID } from '@/lib/iam/projectLevels';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import {
  withApiRequestContext,
  withClientApiRequestContext,
} from '@/server/api/fastify-utils';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  owner: IUser;
  pj1: string;
  pj2: string;
  defaultProject: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeForEachProvider('project levels at the gates', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let seq = 0;

  const inTenant = <T>(t: Tenant, fn: () => Promise<T>) => db.runWithTenant!(t.dbName, fn);

  async function build(label: string): Promise<Tenant> {
    const slug = `iamlv-${label}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 6)}`;
    const dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: `Levels ${label}`, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const id = String(row._id);
    return inTenant({ dbName } as Tenant, async () => {
      const owner = await db.createUser({ tenantId: id, email: `owner@${slug}.example`, name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [] });
      const pj1 = await db.createProject({ tenantId: id, key: 'pj1', name: 'Project One', createdBy: 'x' });
      const pj2 = await db.createProject({ tenantId: id, key: 'pj2', name: 'Project Two', createdBy: 'x' });
      const def = await db.createProject({ tenantId: id, key: 'default', name: 'Default', createdBy: 'x' });
      return { dbName, id, owner, pj1: String(pj1._id), pj2: String(pj2._id), defaultProject: String(def._id) };
    });
  }

  /** A plain member of the workspace. */
  async function member(t: Tenant, name: string): Promise<IUser> {
    return inTenant(t, () => db.createUser({ tenantId: t.id, email: `${name}@${t.dbName}.example`, name, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] }));
  }

  const assign = (t: Tenant, user: IUser, projectId: string, servicePermissions?: Record<string, string>, role: 'member' | 'project_admin' = 'member') =>
    inTenant(t, () => db.upsertUserProject({ tenantId: t.id, userId: String(user._id), projectId, role, ...(servicePermissions ? { servicePermissions } : {}) } as never));

  async function token(t: Tenant, user: IUser, tokenId: string, projectId?: string, scope: Record<string, string> | null = null) {
    hoisted.tokens.set(tokenId, {
      token: tokenId,
      tokenRecord: { _id: tokenId, userId: String(user._id), servicePermissions: scope, projectId },
      tenant: { licenseType: 'FREE' },
      tenantId: t.id,
      tenantSlug: 'iam-levels',
      tenantDbName: t.dbName,
      projectId,
      user,
    });
    return tokenId;
  }

  const sessionHeaders = (t: Tenant, user: IUser, cookie?: string) => ({
    'x-tenant-db-name': t.dbName,
    'x-tenant-id': t.id,
    'x-tenant-slug': 'iam-levels',
    'x-user-id': String(user._id),
    'x-user-role': String(user.role),
    'x-user-email': String(user.email),
    'x-license-type': 'FREE',
    ...(cookie ? { cookie } : {}),
  });

  async function session(t: Tenant, user: IUser, method: 'GET' | 'POST', url: string, project?: string) {
    const res = await app.inject({ method, url, headers: sessionHeaders(t, user, project ? `active_project_id=${project}` : undefined) });
    return res.statusCode;
  }
  async function viaToken(tokenId: string, method: 'GET' | 'POST', url: string) {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${tokenId}` } });
    return res.statusCode;
  }
  async function iam(t: Tenant, method: 'GET' | 'POST', url: string, body?: unknown) {
    const res = await app.inject({
      method, url,
      headers: { ...sessionHeaders(t, t.owner), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.statusCode, body: res.body ? parseJsonBody<any>(res.body) : null };
  }

  const activation = (t: Tenant) => inTenant(t, () => db.iamDocGet('iam_meta', PROJECT_LEVELS_DOC_ID));

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    app = await createFastifyApiTestApp(async (instance) => {
      const ok = withApiRequestContext(async (_req, reply) => reply.send({ ok: true }));
      instance.get('/agents/probe', ok);
      instance.post('/agents/probe', ok);
      instance.get('/prompts/probe', ok);
      instance.post('/prompts/probe', ok);
      const okToken = withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true }));
      instance.get('/client/v1/agents/probe', okToken);
      instance.post('/client/v1/agents/probe', okToken);
      instance.get('/client/v1/prompts/probe', okToken);
      instance.post('/client/v1/prompts/probe', okToken);
      await instance.register(iamApiPlugin);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    resetProjectNarrowingCachesForTests();
  });

  it('records the moment once, on the first decision of the workspace, and nothing earlier', async () => {
    const t = await build('moment');
    const m = await member(t, 'm');
    await assign(t, m, t.pj1, { prompts: 'none' });
    expect(await activation(t), 'nothing is written before a workspace is evaluated').toBeNull();
    await wait(10);

    const before = Date.now();
    expect(await session(t, m, 'POST', '/api/prompts/probe', t.pj1)).toBe(200);
    const stored = await activation(t);
    expect(stored).not.toBeNull();
    const since = Date.parse(String((stored!.data as { since: string }).since));
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());

    // later decisions, of other people and by token, read it and never write it again
    const other = await member(t, 'other');
    await assign(t, other, t.pj1);
    await wait(5);
    expect(await session(t, other, 'GET', '/api/prompts/probe', t.pj1)).toBe(200);
    expect(await viaToken(await token(t, m, 'tok-moment', t.pj1), 'POST', '/api/client/v1/prompts/probe')).toBe(200);
    expect((await activation(t))!.data).toEqual(stored!.data);
  });

  it('an explicit none from before the first decision is read as "not set"; read / write / admin are always honoured', async () => {
    const t = await build('old');
    const m = await member(t, 'm');
    // what the member screens used to save: agents limited to read on purpose, prompts "touched and put back" as none
    await assign(t, m, t.pj1, { agents: 'read', prompts: 'none' });
    const tokenId = await token(t, m, 'tok-old', t.pj1);
    await wait(10);

    // sessions
    expect(await session(t, m, 'POST', '/api/prompts/probe', t.pj1)).toBe(200);
    expect(await session(t, m, 'GET', '/api/prompts/probe', t.pj1)).toBe(200);
    expect(await session(t, m, 'GET', '/api/agents/probe', t.pj1)).toBe(200);
    expect(await session(t, m, 'POST', '/api/agents/probe', t.pj1)).toBe(403);
    // tokens
    expect(await viaToken(tokenId, 'POST', '/api/client/v1/prompts/probe')).toBe(200);
    expect(await viaToken(tokenId, 'GET', '/api/client/v1/agents/probe')).toBe(200);
    expect(await viaToken(tokenId, 'POST', '/api/client/v1/agents/probe')).toBe(403);

    // the access check and the principal detail read it the same way
    const prompts = await iam(t, 'POST', '/api/iam/simulate', { principal: { type: 'user', id: String(m._id) }, action: 'prompts.write', resource: { kind: 'service', service: 'prompts' }, context: { projectId: t.pj1 } });
    expect(prompts.body).toMatchObject({ allowed: true, projectId: t.pj1 });
    const detail = await iam(t, 'GET', `/api/iam/principals/user/${m._id}?projectId=${t.pj1}`);
    expect(detail.body.effective.find((e: any) => e.service === 'prompts').level).toBe('write');
    expect(detail.body.effective.find((e: any) => e.service === 'agents').level).toBe('read');
  });

  it('a none saved after the first decision counts in full - for a person, for their token and for a group', async () => {
    const t = await build('new');
    const starter = await member(t, 'starter');
    await assign(t, starter, t.pj1);
    await wait(10);
    expect(await session(t, starter, 'GET', '/api/prompts/probe', t.pj1)).toBe(200); // the workspace's first decision
    await wait(10);

    const m = await member(t, 'm');
    await assign(t, m, t.pj1, { prompts: 'none' });
    const tokenId = await token(t, m, 'tok-new', t.pj1);
    expect(await session(t, m, 'POST', '/api/prompts/probe', t.pj1)).toBe(403);
    expect(await session(t, m, 'GET', '/api/prompts/probe', t.pj1)).toBe(403); // none stops reading too
    expect(await viaToken(tokenId, 'GET', '/api/client/v1/prompts/probe')).toBe(403);
    // another project of the same person is not limited
    await assign(t, m, t.pj2);
    expect(await session(t, m, 'POST', '/api/prompts/probe', t.pj2)).toBe(200);
    // ... and the access check says the same
    const sim = await iam(t, 'POST', '/api/iam/simulate', { principal: { type: 'user', id: String(m._id) }, action: 'prompts.read', resource: { kind: 'service', service: 'prompts' }, context: { projectId: t.pj1 } });
    expect(sim.body).toMatchObject({ allowed: false });
    expect(sim.body.reasons.map((r: any) => r.cedarId)).toEqual(['managed:boundary:project-read']);

    // a group's project assignment saved after the first decision limits its members as well
    const g = await inTenant(t, () => db.createGroup({ tenantId: t.id, name: 'Team', createdBy: 't', source: 'local' } as never));
    const gm = await member(t, 'gm');
    await inTenant(t, () => db.addGroupMember({ groupId: String(g._id), userId: String(gm._id), tenantId: t.id, role: 'member' }));
    await inTenant(t, () => db.upsertGroupProject({ tenantId: t.id, groupId: String(g._id), projectId: t.pj1, role: 'member', servicePermissions: { prompts: 'none' } } as never));
    expect(await session(t, gm, 'POST', '/api/prompts/probe', t.pj1)).toBe(403);
  });

  it('a group assignment from before the first decision follows the same rule', async () => {
    const t = await build('group');
    const g = await inTenant(t, () => db.createGroup({ tenantId: t.id, name: 'Team', createdBy: 't', source: 'local' } as never));
    const gm = await member(t, 'gm');
    await inTenant(t, () => db.addGroupMember({ groupId: String(g._id), userId: String(gm._id), tenantId: t.id, role: 'member' }));
    await inTenant(t, () => db.upsertGroupProject({ tenantId: t.id, groupId: String(g._id), projectId: t.pj1, role: 'member', servicePermissions: { agents: 'read', prompts: 'none' } } as never));
    await wait(10);
    expect(await session(t, gm, 'POST', '/api/prompts/probe', t.pj1)).toBe(200); // the old none is not read ...
    expect(await session(t, gm, 'POST', '/api/agents/probe', t.pj1)).toBe(403); // ... the read ceiling is
  });

  it('an unrelated later save of an old row makes its old none count from then on (documented edge)', async () => {
    const t = await build('edge');
    const m = await member(t, 'm');
    await assign(t, m, t.pj1, { prompts: 'none' });
    await wait(10);
    expect(await session(t, m, 'POST', '/api/prompts/probe', t.pj1)).toBe(200);
    await wait(10);
    // the member's project role changes: the row is saved again, now after the first decision
    await assign(t, m, t.pj1, { prompts: 'none' }, 'project_admin');
    expect(await session(t, m, 'POST', '/api/prompts/probe', t.pj1)).toBe(403);
  });

  it('a token without a project runs in the default project: the gate, the access check and the principal detail agree', async () => {
    const t = await build('default');
    const dave = await member(t, 'dave');
    // the DEFAULT project limits agents to read; dave's other project says nothing
    await assign(t, dave, t.defaultProject, { agents: 'read' });
    await assign(t, dave, t.pj2);
    // what apiTokenAuth does for a token that carries no project: it runs in the default one
    const open = await inTenant(t, () => db.createApiToken({
      tenantId: t.id, userId: String(dave._id), label: 'dave-open', tokenHash: `h-${t.dbName}`, tokenPrefix: 'cp_dave', createdBy: String(dave._id),
    } as never));
    const tokenId = await token(t, dave, String(open._id), t.defaultProject);

    // the gate
    expect(await viaToken(tokenId, 'GET', '/api/client/v1/agents/probe')).toBe(200);
    expect(await viaToken(tokenId, 'POST', '/api/client/v1/agents/probe')).toBe(403);
    // the access check, asked without a project
    const write = await iam(t, 'POST', '/api/iam/simulate', { principal: { type: 'token', id: String(open._id) }, action: 'agents.write', resource: { kind: 'service', service: 'agents' } });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ allowed: false, projectId: t.defaultProject });
    const read = await iam(t, 'POST', '/api/iam/simulate', { principal: { type: 'token', id: String(open._id) }, action: 'agents.read', resource: { kind: 'service', service: 'agents' } });
    expect(read.body).toMatchObject({ allowed: true, projectId: t.defaultProject });
    // the principal detail
    const detail = await iam(t, 'GET', `/api/iam/principals/token/${open._id}`);
    expect(detail.body.effective.find((e: any) => e.service === 'agents').level).toBe('read');
  });
});
