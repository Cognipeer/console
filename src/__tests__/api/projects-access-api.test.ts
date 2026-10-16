/**
 * Projects access API, real plugin on real SQLite and MongoDB:
 *   GET  /api/projects?include=stats
 *   POST /api/projects                          (members / groups / providerIds + warnings)
 *   GET  /api/projects/:projectId/overview
 *   GET  /api/projects/:projectId/members       (source, groups, tenantAdmins)
 *   POST /api/projects/:projectId/members/bulk
 * and the persistence of IUserProject.source in both providers.
 *
 * Group grants on a project reuse POST/DELETE /api/groups/:id/projects (groups.ts).
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

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

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));

// Default alert rules have their own tests (projects-default-alert-rules.test.ts); here they would reach a real tenant DB.
vi.mock('@/lib/services/alerts/alertTemplates', () => ({
  seedDefaultAlertRules: vi.fn().mockResolvedValue(0),
  defaultAlertRulesOnCreate: () => true,
  defaultSetProgress: () => ({ done: 0, total: 6 }),
}));

import type { FastifyInstance } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { registerDirectoryProjectRulesProvider } from '@/enterprise/external-auth';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

describeForEachProvider('projects access api', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let dbName = '';
  let tenantId = '';
  let alphaId = '';
  let emptyId = '';
  let groupId = '';
  const users: Record<string, IUser> = {};
  const providerIds: Record<string, string> = {};

  const headers = (user: IUser) => ({
    'x-tenant-db-name': dbName,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'projects-access',
    'x-user-id': String(user._id),
    'x-user-role': String(user.role),
    'x-user-email': String(user.email),
    'x-license-type': 'ENTERPRISE',
    'content-type': 'application/json',
  });

  async function call<T = Record<string, any>>(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
    const res = await app.inject({
      method,
      url,
      headers: headers(users[who]),
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return { status: res.statusCode, body: (res.body ? parseJsonBody<T>(res.body) : {}) as T };
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `pacc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Access', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);

    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        users[key] = await db.createUser({ tenantId, email: `${key}@${slug}.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra });
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      await mk('padmin', 'user');
      await mk('plain', 'user');
      await mk('dir', 'user');
      await mk('viaGroup', 'user');
      await mk('newbie', 'user');
      await mk('ext', 'user', { kind: 'external', canLogin: false });

      const alpha = await db.createProject({ tenantId, key: 'alpha', name: 'Alpha', createdBy: 'x' });
      alphaId = String(alpha._id);
      const empty = await db.createProject({ tenantId, key: 'empty', name: 'Empty', createdBy: 'x' });
      emptyId = String(empty._id);

      const base = { tenantId, status: 'active' as const, credentialsEnc: '', settings: {}, createdBy: 'x' };
      const model = await db.createProvider({ ...base, key: 'oai', type: 'model', driver: 'openai', label: 'OpenAI', projectIds: [alphaId] });
      const vector = await db.createProvider({ ...base, key: 'vec', type: 'vector', driver: 'pinecone', label: 'Vec', projectIds: [alphaId] });
      const free = await db.createProvider({ ...base, key: 'free', type: 'model', driver: 'openai', label: 'Free' });
      const legacy = await db.createProvider({ ...base, key: 'legacy', type: 'model', driver: 'openai', label: 'Legacy', projectId: alphaId });
      providerIds.model = String(model._id);
      providerIds.vector = String(vector._id);
      providerIds.free = String(free._id);
      providerIds.legacy = String(legacy._id);

      await db.upsertUserProject({ tenantId, userId: String(users.padmin._id), projectId: alphaId, role: 'project_admin', invitedBy: 'x', source: 'manual' });
      await db.upsertUserProject({ tenantId, userId: String(users.plain._id), projectId: alphaId, role: 'member', invitedBy: 'x' });
      await db.upsertUserProject({ tenantId, userId: String(users.dir._id), projectId: alphaId, role: 'member', invitedBy: 'directory:oidc', source: 'directory' });

      const group = await db.createGroup({ tenantId, name: 'Engineers', createdBy: 'x' });
      groupId = String(group._id);
      await db.addGroupMember({ tenantId, groupId, userId: String(users.viaGroup._id), role: 'member' });
      await db.addGroupMember({ tenantId, groupId, userId: String(users.plain._id), role: 'member' });
      await db.upsertGroupProject({ tenantId, groupId, projectId: alphaId, role: 'member' });
    });

    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(projectsApiPlugin);
    });
    await app.ready();
  });

  afterEach(() => {
    registerDirectoryProjectRulesProvider(null);
  });

  afterAll(async () => {
    registerDirectoryProjectRulesProvider(null);
    await app?.close();
  });

  // ── persistence of IUserProject.source ─────────────────────────────────

  it('persists membership source, reads legacy rows as manual and keeps it on a role-only upsert', async () => {
    await db.runWithTenant!(dbName, async () => {
      const dirRow = await db.findUserProject(String(users.dir._id), alphaId);
      expect(dirRow).toMatchObject({ source: 'directory', invitedBy: 'directory:oidc' });

      const plainRow = await db.findUserProject(String(users.plain._id), alphaId);
      expect(plainRow?.source).toBe('manual');

      // an upsert that does not state a source leaves a directory row a directory row
      await db.upsertUserProject({ tenantId, userId: String(users.dir._id), projectId: alphaId, role: 'project_admin', invitedBy: 'directory:oidc' });
      expect((await db.findUserProject(String(users.dir._id), alphaId))?.source).toBe('directory');
      // stating one takes ownership
      await db.upsertUserProject({ tenantId, userId: String(users.dir._id), projectId: alphaId, role: 'member', invitedBy: 'x', source: 'manual' });
      expect((await db.findUserProject(String(users.dir._id), alphaId))?.source).toBe('manual');
      await db.upsertUserProject({ tenantId, userId: String(users.dir._id), projectId: alphaId, role: 'member', invitedBy: 'directory:oidc', source: 'directory' });

      const byTenant = await db.listUserProjectsByTenant(tenantId);
      expect(byTenant.filter((r) => r.source === 'directory').map((r) => r.userId)).toEqual([String(users.dir._id)]);
      expect((await db.listUserProjectsByProject(alphaId)).find((r) => r.userId === String(users.dir._id))?.source).toBe('directory');
      expect((await db.listUserProjectsByUser(String(users.dir._id)))[0].source).toBe('directory');
    });
  });

  // ── GET /api/projects?include=stats ────────────────────────────────────

  it('GET /api/projects without include keeps the old shape', async () => {
    const { status, body } = await call('owner', 'GET', '/api/projects');
    expect(status).toBe(200);
    const alpha = body.projects.find((p: any) => String(p._id) === alphaId);
    expect(alpha.stats).toBeUndefined();
    expect(alpha.directoryDefault).toBeUndefined();
  });

  it('GET /api/projects?include=stats adds counters and the directory default', async () => {
    registerDirectoryProjectRulesProvider(async () => [
      { source: 'oidc', label: 'Okta', mode: 'fallback', applyOn: 'first_sign_in', projects: [{ projectId: alphaId, role: 'member' }] },
    ]);
    const { status, body } = await call('owner', 'GET', '/api/projects?include=stats');
    expect(status).toBe(200);
    const alpha = body.projects.find((p: any) => String(p._id) === alphaId);
    expect(alpha.stats).toEqual({
      members: 3,
      groups: 1,
      people: 4, // padmin, plain, dir + viaGroup (plain is in the group too)
      providers: 3, // model, vector + the legacy single-project one
      providersByDomain: { model: 2, vector: 1 },
      agents: 0,
      tokens: 0,
    });
    expect(alpha.directoryDefault).toEqual([{ source: 'oidc', label: 'Okta', role: 'member', mode: 'fallback' }]);
    const empty = body.projects.find((p: any) => String(p._id) === emptyId);
    expect(empty.stats).toMatchObject({ members: 0, groups: 0, people: 0, providers: 0 });
    expect(empty.directoryDefault).toEqual([]);
  });

  it('a project member only sees the projects they reach, with stats', async () => {
    const { body } = await call('plain', 'GET', '/api/projects?include=stats');
    expect(body.projects.map((p: any) => String(p._id))).toEqual([alphaId]);
    expect(body.projects[0].stats.members).toBe(3);
  });

  // ── POST /api/projects ─────────────────────────────────────────────────

  it('POST /api/projects applies members, groups and providers and reports what it skipped', async () => {
    const { status, body } = await call('owner', 'POST', '/api/projects', {
      name: 'Created Wide',
      members: [
        { userId: String(users.newbie._id), role: 'project_admin' },
        { userId: String(users.admin._id), role: 'member' }, // implicit access
        { userId: String(users.ext._id), role: 'member' }, // external
        { userId: 'does-not-exist', role: 'member' }, // unknown / foreign
        { userId: String(users.plain._id), role: 'superuser' }, // bad role
      ],
      groups: [{ groupId, role: 'member' }, { groupId: 'no-such-group', role: 'member' }],
      providerIds: [providerIds.free, providerIds.legacy, 'foreign-provider-id'],
    });
    expect(status).toBe(201);
    const id = String(body.project._id);
    expect(body.warnings).toHaveLength(7);
    expect(body.warnings.join('\n')).toMatch(/does-not-exist/);
    expect(body.warnings.join('\n')).toMatch(/no-such-group/);
    expect(body.warnings.join('\n')).toMatch(/foreign-provider-id/);
    expect(body.warnings.join('\n')).toMatch(/another project/);

    await db.runWithTenant!(dbName, async () => {
      const row = await db.findUserProject(String(users.newbie._id), id);
      expect(row).toMatchObject({ role: 'project_admin', source: 'manual', invitedBy: String(users.owner._id) });
      expect(await db.findUserProject(String(users.admin._id), id)).toBeNull();
      expect(await db.findUserProject(String(users.ext._id), id)).toBeNull();
      expect((await db.listGroupProjectsByProject(id)).map((g) => g.groupId)).toEqual([groupId]);
      expect((await db.findProviderById(providerIds.free))?.projectIds).toEqual([id]);
      // the legacy single-project provider is untouched
      expect((await db.findProviderById(providerIds.legacy))?.projectIds ?? []).not.toContain(id);
    });
  });

  it('POST /api/projects without extras still answers with an empty warnings list', async () => {
    const { status, body } = await call('owner', 'POST', '/api/projects', { name: 'Plain Project' });
    expect(status).toBe(201);
    expect(body.warnings).toEqual([]);
  });

  it('POST /api/projects stays owner/admin only', async () => {
    const { status } = await call('padmin', 'POST', '/api/projects', { name: 'Nope' });
    expect(status).toBe(403);
  });

  // ── members extensions ─────────────────────────────────────────────────

  it('GET members carries source per row, the group grants and the tenant admins', async () => {
    const { status, body } = await call('padmin', 'GET', `/api/projects/${alphaId}/members`);
    expect(status).toBe(200);
    const byEmail = (name: string) => body.members.find((m: any) => m.userId === String(users[name]._id));
    expect(byEmail('dir').source).toBe('directory');
    expect(byEmail('plain').source).toBe('manual');
    expect(byEmail('owner').source).toBe('manual');
    expect(body.groups).toEqual([
      { groupId, name: 'Engineers', role: 'member', memberCount: 2, directorySynced: false },
    ]);
    expect(body.tenantAdmins.map((a: any) => a.role).sort()).toEqual(['admin', 'owner']);
    expect(body.tenantAdmins[0]).toHaveProperty('email');
  });

  it('single add / role change write source manual (taking over a directory row)', async () => {
    const add = await call('owner', 'POST', `/api/projects/${emptyId}/members`, { userId: String(users.newbie._id), role: 'member' });
    expect(add.status).toBe(200);
    expect(add.body.userProject.source).toBe('manual');

    await db.runWithTenant!(dbName, () => db.upsertUserProject({ tenantId, userId: String(users.dir._id), projectId: emptyId, role: 'member', invitedBy: 'directory:ldap', source: 'directory' }));
    const patch = await call('owner', 'PATCH', `/api/projects/${emptyId}/members`, { userId: String(users.dir._id), role: 'project_admin' });
    expect(patch.status).toBe(200);
    expect(patch.body.userProject).toMatchObject({ role: 'project_admin', source: 'manual' });
    await db.runWithTenant!(dbName, async () => {
      await db.deleteUserProject(String(users.newbie._id), emptyId);
      await db.deleteUserProject(String(users.dir._id), emptyId);
    });
  });

  // ── bulk ───────────────────────────────────────────────────────────────

  it('POST members/bulk adds, changes roles and removes, with warnings for the impossible ones', async () => {
    const res = await call('owner', 'POST', `/api/projects/${emptyId}/members/bulk`, {
      add: [
        { userId: String(users.plain._id), role: 'member' },
        { userId: String(users.newbie._id), role: 'project_admin' },
        { userId: String(users.owner._id), role: 'member' },
        { userId: String(users.ext._id), role: 'member' },
        { userId: 'nobody', role: 'member' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 2, removed: 0, updated: 0 });
    expect(res.body.warnings).toHaveLength(3);

    const second = await call('owner', 'POST', `/api/projects/${emptyId}/members/bulk`, {
      setRole: [{ userId: String(users.plain._id), role: 'project_admin' }],
      remove: [String(users.newbie._id), String(users.admin._id), String(users.viaGroup._id)],
    });
    expect(second.body).toMatchObject({ added: 0, removed: 1, updated: 1 });
    expect(second.body.warnings).toHaveLength(2);

    await db.runWithTenant!(dbName, async () => {
      expect(await db.findUserProject(String(users.plain._id), emptyId)).toMatchObject({ role: 'project_admin', source: 'manual' });
      expect(await db.findUserProject(String(users.newbie._id), emptyId)).toBeNull();
    });
  });

  it('POST members/bulk needs a project admin and at least one entry', async () => {
    const asMember = await call('plain', 'POST', `/api/projects/${alphaId}/members/bulk`, { add: [{ userId: String(users.newbie._id), role: 'member' }] });
    expect(asMember.status).toBe(403);
    const empty = await call('padmin', 'POST', `/api/projects/${alphaId}/members/bulk`, {});
    expect(empty.status).toBe(400);
    const unknownProject = await call('owner', 'POST', '/api/projects/nope/members/bulk', { remove: ['x'] });
    expect(unknownProject.status).toBe(404);
  });

  // ── overview ───────────────────────────────────────────────────────────

  it('GET overview reports stats, readiness, admins, directory rules and activity', async () => {
    registerDirectoryProjectRulesProvider(async () => [
      { source: 'ldap', label: 'Corp', mode: 'always', applyOn: 'first_sign_in', projects: [{ projectId: alphaId, role: 'member' }, { projectId: emptyId, role: 'member' }] },
      { source: 'oidc', mode: 'fallback', applyOn: 'first_sign_in', projects: [{ projectId: emptyId, role: 'member' }] },
    ]);
    const { status, body } = await call('padmin', 'GET', `/api/projects/${alphaId}/overview`);
    expect(status).toBe(200);
    expect(String(body.project._id)).toBe(alphaId);
    expect(body.stats).toMatchObject({ members: 3, groups: 1, people: 4, providers: 3 });
    expect(body.readiness).toEqual({
      hasModelProvider: true,
      missingDomains: [],
      hasProjectAdmin: true,
      hasLimits: false,
    });
    expect(body.defaultAlerts).toEqual({ done: 0, total: 6 });
    expect(body.admins.map((a: any) => a.kind).sort()).toEqual(['project_admin', 'tenant_admin', 'tenant_owner']);
    expect(body.directory.rules).toEqual([
      { source: 'ldap', label: 'Corp', mode: 'always', applyOn: 'first_sign_in', projects: [{ projectId: alphaId, role: 'member' }] },
    ]);
    expect(body.directory.groups).toEqual([{ groupId, name: 'Engineers', role: 'member', source: 'local' }]);
    expect(body.activity.some((a: any) => a.action === 'members.directory_added')).toBe(true);
    expect(body.activity.some((a: any) => a.action === 'groups.added')).toBe(true);
    expect(body.activity.length).toBeLessThanOrEqual(20);
  });

  it('GET overview of a project with nothing set up says what is missing', async () => {
    const created = await call('owner', 'POST', '/api/projects', { name: 'Bare Project' });
    const id = String(created.body.project._id);
    const { body } = await call('owner', 'GET', `/api/projects/${id}/overview`);
    expect(body.readiness.hasModelProvider).toBe(false);
    expect(body.readiness.hasProjectAdmin).toBe(false);
    expect(body.readiness.missingDomains).toEqual(expect.arrayContaining(['model', 'vector']));
    expect(body.admins.map((a: any) => a.kind).sort()).toEqual(['tenant_admin', 'tenant_owner']);
  });

  it('GET overview is closed to people without access to the project', async () => {
    const forbidden = await call('newbie', 'GET', `/api/projects/${alphaId}/overview`);
    expect(forbidden.status).toBe(403);
    const missing = await call('owner', 'GET', '/api/projects/nope/overview');
    expect(missing.status).toBe(404);
  });
});
