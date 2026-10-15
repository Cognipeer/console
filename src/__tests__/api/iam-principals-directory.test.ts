/**
 * The people & access directory behind /api/iam/principals - the REAL plugin, gate
 * and engine on BOTH backends: filters, sort, paging and the optional total for
 * people, groups and API tokens; the "never upward" visibility of tokens; what the
 * detail adds (profile facts, who manages the account, what the viewer may do);
 * and that nobody without the iam service gets into ANY /api/iam route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

import type { FastifyInstance } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { primeProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { enqueueAuditLog } from '@/server/api/plugin';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Workspace {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  groups: Record<string, string>;
  projects: Record<string, string>;
  tokens: Record<string, string>;
}

describeForEachProvider('IAM directory API', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let W: Workspace;
  let OTHER: Workspace;
  const routes: Array<{ method: string; url: string }> = [];

  const headers = (ws: Workspace, user: IUser) => ({
    'x-tenant-db-name': ws.dbName,
    'x-tenant-id': ws.id,
    'x-tenant-slug': 'iam-directory',
    'x-user-id': String(user._id),
    'x-user-role': String(user.role),
    'x-user-email': String(user.email),
    'x-license-type': 'FREE',
  });

  async function call(method: string, url: string, who: string | IUser, body?: unknown, ws: Workspace = W) {
    const actor = typeof who === 'string' ? ws.users[who] : who;
    const h: Record<string, string> = headers(ws, actor);
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await app.inject({ method: method as never, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: any = null;
    if (res.body) {
      try { parsed = parseJsonBody<any>(res.body); } catch { parsed = res.body; }
    }
    return { status: res.statusCode, body: parsed };
  }
  const list = (query: string, who = 'admin') => call('GET', `/api/iam/principals?${query}`, who);
  const labels = (res: { body: { items: Array<{ label: string }> } }) => res.body.items.map((i) => i.label);

  async function build(): Promise<Workspace> {
    const slug = `iamdir-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const tenantRow = await db.createTenant({ companyName: 'Directory', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const ws: Workspace = { dbName, id: String(tenantRow._id), users: {}, groups: {}, projects: {}, tokens: {} };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, name: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        ws.users[key] = await db.createUser({
          tenantId: ws.id, email: `${key}@dir.example`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
        } as never);
      };
      const invitedAt = new Date('2026-02-01T00:00:00Z');
      await mk('owner', 'Olivia Owner', 'owner');
      await mk('admin', 'Adam Admin', 'admin');
      await mk('admin2', 'Ada Admin', 'admin');
      await mk('ssoAdmin', 'Sam Sso', 'admin', { authProvider: 'oidc', externalId: 'sso-1' });
      await mk('reader', 'Rita Reader', 'user', { servicePermissions: { iam: 'read' } });
      await mk('plain', 'Pat Plain', 'user');
      await mk('alice', 'Alice A', 'user');
      await mk('bob', 'Bob B', 'user');
      await mk('carol', 'Carol C', 'user', { status: 'disabled' });
      await mk('ldapUser', 'Lena Ldap', 'user', { authProvider: 'ldap', externalId: 'cn=lena' });
      await mk('invitee', 'Ivy Invitee', 'user', { invitedBy: String(ws.users.owner._id), invitedAt });
      await mk('svc1', 'Svc One', 'user', { canLogin: false, email: '' });
      await mk('svc2', 'Svc Two', 'user', { canLogin: false, email: '', invitedBy: String(ws.users.owner._id), invitedAt });

      const eng = await db.createGroup({ tenantId: ws.id, name: 'Engineering', description: 'All engineers', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      const dirGroup = await db.createGroup({ tenantId: ws.id, name: 'Directory team', createdBy: 't', source: 'ldap' } as never);
      ws.groups = { eng: String(eng._id), dir: String(dirGroup._id) };
      for (const key of ['alice', 'bob', 'ldapUser']) await db.addGroupMember({ groupId: ws.groups.eng, userId: String(ws.users[key]._id), tenantId: ws.id, role: 'member' });
      await db.addGroupMember({ groupId: ws.groups.dir, userId: String(ws.users.carol._id), tenantId: ws.id, role: 'member', source: 'ldap' });

      const p1 = await db.createProject({ tenantId: ws.id, key: 'pj1', name: 'Project One', createdBy: 'x' });
      const p2 = await db.createProject({ tenantId: ws.id, key: 'pj2', name: 'Project Two', createdBy: 'x' });
      ws.projects = { pj1: String(p1._id), pj2: String(p2._id) };
      await db.upsertUserProject({ tenantId: ws.id, userId: String(ws.users.alice._id), projectId: ws.projects.pj1, role: 'member' });
      await db.upsertGroupProject({ tenantId: ws.id, groupId: ws.groups.eng, projectId: ws.projects.pj2, role: 'member' });

      const mkToken = async (key: string, owner: string, extra: Record<string, unknown> = {}) => {
        const token = await db.createApiToken({
          tenantId: ws.id, userId: String(ws.users[owner]._id), label: key, tokenHash: `h-${slug}-${key}`, tokenPrefix: `cp_${key}`, createdBy: String(ws.users[owner]._id), ...extra,
        } as never);
        ws.tokens[key] = String(token._id);
      };
      await mkToken('aliceCi', 'alice', { projectId: ws.projects.pj1 });
      await mkToken('aliceOld', 'alice', { expiresAt: new Date(Date.now() - 60_000) });
      await mkToken('bobScoped', 'bob', { projectId: ws.projects.pj2, servicePermissions: { agents: 'read' } });
      await mkToken('ownerKey', 'owner');
      await mkToken('adminKey', 'admin');
      await mkToken('readerKey', 'reader');
      await mkToken('svcKey', 'svc1');
      // an owner whose account is gone
      await db.createApiToken({
        tenantId: ws.id, userId: '0'.repeat(24), label: 'orphan', tokenHash: `h-${slug}-orphan`, tokenPrefix: 'cp_orphan', createdBy: 'x',
      } as never);
    });
    return ws;
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    W = await build();
    OTHER = await build();
    app = await createFastifyApiTestApp(async (instance) => {
      instance.addHook('onRoute', (route) => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
          if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: route.url });
        }
      });
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      await instance.register(iamApiPlugin);
    });
    await app.ready();
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    configureIamEngine({ validateRequests: false });
    primeProjectLevelsForTests(W.dbName, 0);
    primeProjectLevelsForTests(OTHER.dbName, 0);
  });
  afterAll(async () => {
    await drainPendingTasks();
    await app?.close();
  });

  // ── who gets in ─────────────────────────────────────────────────────────

  describe('who gets in', () => {
    it('refuses people without the iam service on EVERY route of the center - reads and writes', async () => {
      expect(routes.length).toBeGreaterThan(15); // the center was really enumerated
      for (const who of ['plain', 'alice', 'svc1']) {
        for (const route of routes) {
          const url = route.url.replace(/:[A-Za-z]+/g, 'x');
          const body = route.method === 'GET' || route.method === 'DELETE' ? undefined : {};
          const res = await call(route.method, url, who, body);
          expect(res.status, `${who} ${route.method} ${url}`).toBe(403);
        }
      }
    });

    it('refuses a project_admin too: the center is for owners, admins and whoever was granted iam', async () => {
      const pa = { ...W.users.plain, role: 'project_admin' } as IUser;
      for (const route of routes) {
        const url = route.url.replace(/:[A-Za-z]+/g, 'x');
        const res = await call(route.method, url, pa, route.method === 'GET' || route.method === 'DELETE' ? undefined : {});
        expect(res.status, `${route.method} ${url}`).toBe(403);
      }
    });

    it('lets whoever holds iam read browse the directory, and an admin do the same', async () => {
      for (const who of ['reader', 'admin', 'owner']) {
        expect((await list('type=user', who)).status, who).toBe(200);
        expect((await list('type=group', who)).status, who).toBe(200);
        expect((await list('type=token', who)).status, who).toBe(200);
      }
    });
  });

  // ── people ──────────────────────────────────────────────────────────────

  describe('people', () => {
    it('lists them by name with the facts a row needs, and no more than the page asked for', async () => {
      const res = await list('type=user&limit=5');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(5);
      expect(res.body.nextCursor).toBeTruthy();
      expect(res.body.total).toBeUndefined();
      const names = labels(res);
      expect(names).toEqual([...names].sort());
      const ada = (await list('type=user&q=ada%20admin')).body.items[0];
      expect(ada).toMatchObject({
        type: 'user', label: 'Ada Admin', sublabel: 'admin2@dir.example', email: 'admin2@dir.example', role: 'admin', status: 'active',
        kind: 'person', authProvider: 'local', managed: false, policyCount: 0,
      });
      expect(typeof ada.createdAt).toBe('string');
      expect(JSON.stringify(res.body)).not.toContain('password');
    });

    it('pages with the cursor and adds the total only when asked', async () => {
      const first = await list('type=user&limit=5&count=1');
      expect(first.body.total).toBe(13);
      const seen = [...first.body.items.map((i: any) => i.id)];
      let cursor = first.body.nextCursor;
      while (cursor) {
        const page = await list(`type=user&limit=5&cursor=${encodeURIComponent(cursor)}`);
        seen.push(...page.body.items.map((i: any) => i.id));
        cursor = page.body.nextCursor;
      }
      expect(seen).toHaveLength(13);
      expect(new Set(seen).size).toBe(13);
    });

    it('filters by role, status (disabled / invited / active partition the people), kind, source, group and project', async () => {
      expect(labels(await list('type=user&role=owner,admin&sort=name'))).toEqual(['Ada Admin', 'Adam Admin', 'Olivia Owner', 'Sam Sso']);
      expect(labels(await list('type=user&status=disabled'))).toEqual(['Carol C']);
      expect(labels(await list('type=user&status=invited'))).toEqual(['Ivy Invitee']);
      const active = await list('type=user&status=active&count=1');
      expect(active.body.total).toBe(13 - 1 - 1);
      expect(active.body.items.every((i: any) => i.status === 'active')).toBe(true);
      expect(labels(await list('type=user&kind=service&sort=name'))).toEqual(['Svc One', 'Svc Two']);
      expect((await list('type=user&kind=person&count=1')).body.total).toBe(11);
      expect(labels(await list('type=user&source=ldap'))).toEqual(['Lena Ldap']);
      expect(labels(await list('type=user&source=sso'))).toEqual(['Sam Sso']);
      expect(labels(await list('type=user&source=directory&sort=name'))).toEqual(['Lena Ldap', 'Sam Sso']);
      expect((await list('type=user&source=local&count=1')).body.total).toBe(11);
      expect(labels(await list(`type=user&group=${W.groups.eng}&sort=name`))).toEqual(['Alice A', 'Bob B', 'Lena Ldap']);
      expect(labels(await list(`type=user&groupId=${W.groups.eng}&role=user&source=local&sort=name`))).toEqual(['Alice A', 'Bob B']);
      // Project Two through the group, Project One directly
      expect(labels(await list(`type=user&project=${W.projects.pj2}&sort=name`))).toEqual(['Alice A', 'Bob B', 'Lena Ldap']);
      expect(labels(await list(`type=user&projectId=${W.projects.pj1}`))).toEqual(['Alice A']);
    });

    it('classifies a row: invited, service account, managed', async () => {
      const rows = Object.fromEntries((await list('type=user&limit=100')).body.items.map((i: any) => [i.label, i]));
      expect(rows['Ivy Invitee']).toMatchObject({ status: 'invited', kind: 'person', invitedAt: expect.any(String) });
      expect(rows['Svc Two']).toMatchObject({ status: 'active', kind: 'service' }); // a service account has nobody to invite
      expect(rows['Carol C']).toMatchObject({ status: 'disabled' });
      expect(rows['Lena Ldap']).toMatchObject({ authProvider: 'ldap', managed: true });
      expect(rows['Sam Sso']).toMatchObject({ authProvider: 'oidc', managed: true });
    });

    it('sorts by name, email or creation time, either way', async () => {
      const byName = labels(await list('type=user&sort=name&limit=100'));
      expect(labels(await list('type=user&sort=name&dir=desc&limit=100'))).toEqual([...byName].reverse());
      const emails = (await list('type=user&sort=email&limit=100')).body.items.map((i: any) => i.email.toLowerCase());
      expect(emails).toEqual([...emails].sort());
      const created = (await list('type=user&sort=createdAt&dir=desc&limit=100')).body.items.map((i: any) => Date.parse(i.createdAt));
      expect(created).toEqual([...created].sort((a: number, b: number) => b - a));
    });

    it('hydrates a list of ids, still honouring the other filters', async () => {
      const ids = `${W.users.alice._id},${W.users.bob._id},${W.users.carol._id}`;
      expect(labels(await list(`type=user&ids=${ids}&sort=name`))).toEqual(['Alice A', 'Bob B', 'Carol C']);
      expect(labels(await list(`type=user&ids=${ids}&status=disabled`))).toEqual(['Carol C']);
    });

    it('searches name and email', async () => {
      expect(labels(await list('type=user&q=svc')).sort()).toEqual(['Svc One', 'Svc Two']);
      expect(labels(await list('type=user&q=ldapuser@dir'))).toEqual(['Lena Ldap']);
    });

    it('tells the viewer what they may do with each person', async () => {
      const asAdmin = Object.fromEntries((await list('type=user&limit=100', 'admin')).body.items.map((i: any) => [i.label, i.allowedActions]));
      expect(asAdmin['Alice A'].changeRole).toEqual({ allowed: true });
      expect(asAdmin['Alice A'].delete).toEqual({ allowed: true });
      expect(asAdmin['Olivia Owner'].changeRole).toEqual({ allowed: false, reason: 'owner_immutable' });
      expect(asAdmin['Olivia Owner'].disable).toEqual({ allowed: false, reason: 'owner_immutable' });
      expect(asAdmin['Adam Admin'].delete).toEqual({ allowed: false, reason: 'self' });
      expect(asAdmin['Lena Ldap'].delete).toEqual({ allowed: false, reason: 'directory_managed' });
      expect(asAdmin['Lena Ldap'].editProfile).toEqual({ allowed: false, reason: 'directory_managed' });
      expect(asAdmin['Ivy Invitee'].copyInvitationLink).toEqual({ allowed: true });
      // someone who only reads the directory is offered nothing to change
      const asReader = (await list('type=user&limit=100', 'reader')).body.items;
      for (const row of asReader) {
        for (const [name, action] of Object.entries(row.allowedActions as Record<string, { allowed: boolean }>)) {
          if (row.label === 'Rita Reader' && ['mintToken', 'revokeTokens'].includes(name)) continue; // their own tokens are theirs
          expect(action.allowed, `${row.label} ${name}`).toBe(false);
        }
      }
    });
  });

  // ── groups ──────────────────────────────────────────────────────────────

  describe('groups', () => {
    it('lists them with their source, grant and what the viewer may do', async () => {
      const res = await list('type=group&count=1');
      expect(res.body.total).toBe(2);
      expect(res.body.items.map((g: any) => [g.label, g.source, g.managed, g.memberCount])).toEqual([['Directory team', 'ldap', true, 1], ['Engineering', 'local', false, 3]]);
      const eng = res.body.items.find((g: any) => g.label === 'Engineering');
      expect(eng).toMatchObject({ tenantRole: 'user', sublabel: 'All engineers' });
      expect(eng.allowedActions).toEqual({ edit: { allowed: true }, delete: { allowed: true }, manageMembers: { allowed: true }, manageProjects: { allowed: true } });
      const dir = res.body.items.find((g: any) => g.label === 'Directory team');
      expect(dir.allowedActions.delete).toEqual({ allowed: false, reason: 'directory_managed' });
    });

    it('filters by source and by the project they are assigned to', async () => {
      expect(labels(await list('type=group&source=local'))).toEqual(['Engineering']);
      expect(labels(await list('type=group&source=ldap'))).toEqual(['Directory team']);
      expect(labels(await list('type=group&source=directory'))).toEqual(['Directory team']);
      expect(labels(await list(`type=group&project=${W.projects.pj2}`))).toEqual(['Engineering']);
      expect(labels(await list(`type=group&projectId=${W.projects.pj1}`))).toEqual([]);
      expect((await list('type=group&source=ldap&count=1')).body.total).toBe(1);
    });
  });

  // ── tokens ──────────────────────────────────────────────────────────────

  describe('tokens: never upward, applied inside the query', () => {
    const tokenLabels = async (query: string, who: string) => labels(await list(`type=token&${query}`, who));

    it('the owner sees every token, an admin every token but the owner\'s, anyone else their own', async () => {
      expect((await tokenLabels('limit=100', 'owner')).sort()).toEqual(['adminKey', 'aliceCi', 'aliceOld', 'bobScoped', 'orphan', 'ownerKey', 'readerKey', 'svcKey']);
      expect((await tokenLabels('limit=100', 'admin')).sort()).toEqual(['adminKey', 'aliceCi', 'aliceOld', 'bobScoped', 'orphan', 'readerKey', 'svcKey']);
      expect(await tokenLabels('limit=100', 'reader')).toEqual(['readerKey']);
    });

    it('keeps paging and the count consistent with what the viewer may see', async () => {
      const total = (await list('type=token&count=1&limit=2', 'admin')).body;
      expect(total.total).toBe(7);
      const seen: string[] = [];
      let cursor: string | null = total.nextCursor;
      seen.push(...labels({ body: total }));
      while (cursor) {
        const page = await list(`type=token&limit=2&cursor=${encodeURIComponent(cursor)}`, 'admin');
        seen.push(...labels(page));
        cursor = page.body.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(seen).not.toContain('ownerKey');
      expect((await list('type=token&count=1', 'reader')).body.total).toBe(1);
      expect((await list('type=token&count=1', 'owner')).body.total).toBe(8);
    });

    it('a viewer who asks for somebody else\'s tokens gets none, not an error', async () => {
      expect(await tokenLabels(`ownerId=${W.users.alice._id}`, 'reader')).toEqual([]);
      expect(await tokenLabels(`ownerId=${W.users.owner._id}`, 'admin')).toEqual([]);
      expect((await tokenLabels(`ownerId=${W.users.alice._id}`, 'admin')).sort()).toEqual(['aliceCi', 'aliceOld']);
      expect(await tokenLabels(`ownerId=${W.users.reader._id}`, 'reader')).toEqual(['readerKey']);
    });

    it('filters by status, scope, project and owner', async () => {
      expect(await tokenLabels('status=expired', 'admin')).toEqual(['aliceOld']);
      expect((await tokenLabels('status=active', 'admin')).sort()).toEqual(['adminKey', 'aliceCi', 'bobScoped', 'orphan', 'readerKey', 'svcKey']);
      expect(await tokenLabels('scoped=true', 'admin')).toEqual(['bobScoped']);
      expect((await tokenLabels('scoped=false&limit=100', 'admin')).sort()).toEqual(['adminKey', 'aliceCi', 'aliceOld', 'orphan', 'readerKey', 'svcKey']);
      expect(await tokenLabels(`project=${W.projects.pj1}`, 'admin')).toEqual(['aliceCi']);
      expect(await tokenLabels(`projectId=${W.projects.pj2}&scoped=true`, 'admin')).toEqual(['bobScoped']);
      expect(await tokenLabels('q=cp_bob', 'admin')).toEqual(['bobScoped']);
    });

    it('says whose a token is and what the viewer may do with it', async () => {
      const rows = Object.fromEntries((await list('type=token&limit=100', 'admin')).body.items.map((i: any) => [i.label, i]));
      expect(rows.aliceCi).toMatchObject({
        prefix: 'cp_aliceCi', ownerId: String(W.users.alice._id), ownerLabel: 'Alice A', ownerKind: 'person', ownerDisabled: false, ownerMissing: false,
        projectId: W.projects.pj1, projectName: 'Project One', scoped: false, status: 'active', expiresAt: null,
      });
      expect(rows.bobScoped).toMatchObject({ scoped: true, projectName: 'Project Two' });
      expect(rows.svcKey).toMatchObject({ ownerKind: 'service', ownerLabel: 'Svc One' });
      expect(rows.aliceOld).toMatchObject({ status: 'expired', expiresAt: expect.any(String) });
      expect(rows.aliceCi.allowedActions).toEqual({ edit: { allowed: true }, revoke: { allowed: true } });
      // the account behind it is gone: listed, flagged, and an admin cannot attribute it
      expect(rows.orphan).toMatchObject({ ownerMissing: true, ownerLabel: null, ownerKind: null });
      expect(rows.orphan.allowedActions.revoke).toEqual({ allowed: false, reason: 'higher_privileges' });
      const ownerView = Object.fromEntries((await list('type=token&limit=100', 'owner')).body.items.map((i: any) => [i.label, i]));
      expect(ownerView.orphan.allowedActions.revoke).toEqual({ allowed: true });
      expect(JSON.stringify(rows)).not.toContain('h-iamdir');
    });
  });

  // ── a malformed request ─────────────────────────────────────────────────

  describe('a filter with a bad value is refused with the field named', () => {
    it.each([
      ['type=user&role=boss', 'role'],
      ['type=user&role=admin,boss', 'role'],
      ['type=user&status=sleeping', 'status'],
      ['type=user&kind=robot', 'kind'],
      ['type=user&source=github', 'source'],
      ['type=user&sort=popularity', 'sort'],
      ['type=user&dir=sideways', 'dir'],
      ['type=user&group=bad%20id', 'group'],
      ['type=user&project=a%2Fb', 'project'],
      ['type=user&role=admin&role=user', 'role'],
      ['type=group&source=saml', 'source'],
      ['type=group&project=bad%20id', 'project'],
      ['type=token&status=revoked', 'status'],
      ['type=token&scoped=maybe', 'scoped'],
      ['type=token&ownerId=bad%20id', 'ownerId'],
      ['type=user&ids=bad%20id', 'ids'],
    ])('%s', async (query, field) => {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_filter');
      expect(res.body.details.map((d: any) => d.field)).toContain(field);
    });

    it('refuses more ids than a page holds', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `id${i}`).join(',');
      const res = await list(`type=user&ids=${ids}`);
      expect([res.status, res.body.code]).toEqual([400, 'invalid_filter']);
    });

    it('ignores a filter that does not apply to the type asked for', async () => {
      expect((await list('type=group&role=boss&kind=robot&sort=nope')).status).toBe(200);
      expect((await list('type=token&role=boss&source=nope')).status).toBe(200);
      expect((await list('type=user&scoped=maybe&ownerId=bad%20id')).status).toBe(200);
    });
  });

  // ── the detail ──────────────────────────────────────────────────────────

  describe('the detail of a person', () => {
    it('adds the profile, who manages the account and what the viewer may do', async () => {
      const res = await call('GET', `/api/iam/principals/user/${W.users.ldapUser._id}`, 'admin');
      expect(res.status).toBe(200);
      expect(res.body.principal).toMatchObject({
        email: 'ldapUser@dir.example', authProvider: 'ldap', canLogin: true, kind: 'person', pendingInvite: false,
        managed: { directory: true, provider: 'ldap', readOnly: ['name', 'email', 'password'] },
        servicePermissions: {},
      });
      expect(res.body.allowedActions.delete).toEqual({ allowed: false, reason: 'directory_managed' });
      expect(res.body.allowedActions.changeRole).toEqual({ allowed: true });
      expect(res.body.assignableRoles).toEqual(['admin', 'project_admin', 'user']);
      expect(res.body.groups).toEqual([{ id: W.groups.eng, name: 'Engineering', source: 'local', tenantRole: 'user', removable: true }]);
      expect(res.body.projects.map((p: any) => [p.name, p.via, p.removable])).toEqual([['Project Two', 'group', false]]);
    });

    it('marks a membership of a directory group, and a project through a group, as not removable here', async () => {
      const res = await call('GET', `/api/iam/principals/user/${W.users.carol._id}`, 'admin');
      expect(res.body.groups).toEqual([{ id: W.groups.dir, name: 'Directory team', source: 'ldap', tenantRole: null, removable: false }]);
      const alice = await call('GET', `/api/iam/principals/user/${W.users.alice._id}`, 'admin');
      const bySource = Object.fromEntries(alice.body.projects.map((p: any) => [p.name, [p.via, p.removable]]));
      expect(bySource['Project One']).toEqual(['direct', true]);
      expect(bySource['Project Two']).toEqual(['group', false]);
    });

    it('describes a pending invitation and a disabled account', async () => {
      const invited = await call('GET', `/api/iam/principals/user/${W.users.invitee._id}`, 'admin');
      expect(invited.body.principal).toMatchObject({ pendingInvite: true, status: 'invited', invitedAt: expect.any(String) });
      expect(invited.body.allowedActions.copyInvitationLink).toEqual({ allowed: true });
      const disabled = await call('GET', `/api/iam/principals/user/${W.users.carol._id}`, 'admin');
      expect(disabled.body.principal).toMatchObject({ status: 'disabled', pendingInvite: false });
    });

    it('shows the tokens the viewer may see - and says when it hides them', async () => {
      const own = await call('GET', `/api/iam/principals/user/${W.users.alice._id}`, 'admin');
      expect(own.body.tokens.map((t: any) => t.label).sort()).toEqual(['aliceCi', 'aliceOld']);
      expect(own.body).toMatchObject({ tokensHidden: false, tokensTotal: 2, tokensTruncated: false });
      // the owner's tokens are not an admin's to see
      const owner = await call('GET', `/api/iam/principals/user/${W.users.owner._id}`, 'admin');
      expect(owner.body.tokens).toEqual([]);
      expect(owner.body).toMatchObject({ tokensHidden: true, tokensTotal: 0 });
      expect(JSON.stringify(owner.body)).not.toContain('ownerKey');
      // a reader sees nobody else's tokens, but their own
      const hidden = await call('GET', `/api/iam/principals/user/${W.users.alice._id}`, 'reader');
      expect(hidden.body.tokens).toEqual([]);
      expect(hidden.body.tokensHidden).toBe(true);
      const mine = await call('GET', `/api/iam/principals/user/${W.users.reader._id}`, 'reader');
      expect(mine.body.tokens.map((t: any) => t.label)).toEqual(['readerKey']);
      expect(mine.body.tokensHidden).toBe(false);
      // ... and the owner sees all of them
      expect((await call('GET', `/api/iam/principals/user/${W.users.owner._id}`, 'owner')).body.tokens.map((t: any) => t.label)).toEqual(['ownerKey']);
    });

    it('opens the profile without the effective table when asked (effective=0), and with it otherwise', async () => {
      const id = String(W.users.alice._id);
      const lean = await call('GET', `/api/iam/principals/user/${id}?effective=0`, 'admin');
      expect(lean.status).toBe(200);
      expect(lean.body.effective).toEqual([]);
      expect(lean.body.effectiveSkipped).toBe(true);
      expect(lean.body.principal.label).toBe('Alice A');
      expect(lean.body.groups).toHaveLength(1);
      expect(lean.body.projects.length).toBeGreaterThan(0);
      expect(lean.body.allowedActions.changeRole).toEqual({ allowed: true });
      const full = await call('GET', `/api/iam/principals/user/${id}?effective=1`, 'admin');
      expect(full.body.effective.length).toBeGreaterThan(10);
      expect(full.body.effectiveSkipped).toBeUndefined();
      expect((await call('GET', `/api/iam/principals/user/${id}`, 'admin')).body.effective.length).toBeGreaterThan(10);
      // a group and a token too
      const group = await call('GET', `/api/iam/principals/group/${W.groups.eng}?effective=0`, 'admin');
      expect([group.body.effective, group.body.effectiveSkipped]).toEqual([[], true]);
      const token = await call('GET', `/api/iam/principals/token/${W.tokens.aliceCi}?effective=0`, 'admin');
      expect([token.body.effective, token.body.effectiveSkipped]).toEqual([[], true]);
    });

    it('offers a reader nothing to change on someone else', async () => {
      const res = await call('GET', `/api/iam/principals/user/${W.users.bob._id}`, 'reader');
      expect(res.body.assignableRoles).toEqual([]);
      for (const action of Object.values(res.body.allowedActions as Record<string, { allowed: boolean; reason?: string }>)) {
        expect(action).toEqual({ allowed: false, reason: 'forbidden' });
      }
    });
  });

  describe('the detail of a token', () => {
    it('is the token row the forms use, with what the viewer may do', async () => {
      const res = await call('GET', `/api/iam/principals/token/${W.tokens.bobScoped}`, 'admin');
      expect(res.status).toBe(200);
      expect(res.body.principal).toMatchObject({ ownerKind: 'person', ownerMissing: false, projectName: 'Project Two', createdBy: String(W.users.bob._id) });
      expect(res.body.allowedActions).toEqual({ edit: { allowed: true }, revoke: { allowed: true } });
      expect(res.body.tokenRow).toMatchObject({ _id: W.tokens.bobScoped, label: 'bobScoped', canEdit: true, canDelete: true, servicePermissions: { agents: 'read' } });
      expect(JSON.stringify(res.body)).not.toContain('tokenHash');
    });

    it('is not found for a token the viewer may not see - the owner\'s for an admin, anyone\'s for a reader', async () => {
      for (const [id, who] of [[W.tokens.ownerKey, 'admin'], [W.tokens.aliceCi, 'reader'], [W.tokens.adminKey, 'reader']] as const) {
        const res = await call('GET', `/api/iam/principals/token/${id}`, who);
        expect([res.status, res.body.code], `${who} ${id}`).toEqual([404, 'principal_not_found']);
        expect(JSON.stringify(res.body)).not.toContain('Key');
      }
      expect((await call('GET', `/api/iam/principals/token/${W.tokens.readerKey}`, 'reader')).status).toBe(200);
      expect((await call('GET', `/api/iam/principals/token/${W.tokens.ownerKey}`, 'owner')).status).toBe(200);
    });
  });

  // ── the members of a group ──────────────────────────────────────────────

  describe('the activity of a person', () => {
    const dayAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const ISSUER = 'https://idp.activity.example';
    const url = (key: string, query = '') => `/api/iam/principals/user/${String(W.users[key]._id)}/activity${query}`;

    beforeAll(async () => {
      const alice = W.users.alice;
      await db.runWithTenant!(W.dbName, async () => {
        const row = (extra: Record<string, unknown>) => ({
          tenantId: W.id, projectId: W.projects.pj1, userId: String(alice._id), apiTokenId: '', actorType: 'user', source: 'dashboard',
          service: 'models', refKey: 'm1', day: dayAgo(1), requests: 1, errors: 0, totalTokens: 0, costUsd: 0, ...extra,
        });
        await db.incrementUsageDaily([
          row({ requests: 4, errors: 1, totalTokens: 40, costUsd: 0.2 }),
          row({ requests: 6, totalTokens: 60, costUsd: 0.3, apiTokenId: W.tokens.aliceCi, actorType: 'api_token', source: 'api' }),
        ] as never);
        await db.createAuditLog({
          tenantId: W.id, actorType: 'api_token', actorUserId: String(alice._id), actorEmail: alice.email, apiTokenId: W.tokens.aliceCi,
          service: 'models', action: 'write', event: 'POST /api/client/v1/chat/completions', method: 'POST',
          path: '/api/client/v1/chat/completions', outcome: 'success', statusCode: 200, metadata: { via: { kind: 'delegated', issuer: ISSUER } },
        } as never);
      });
    });

    it('reports the usage by service and the actions, naming the token and the issuer behind a call made for the person', async () => {
      const res = await call('GET', url('alice', '?days=7&limit=50'), 'admin');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.windowDays).toBe(7);
      expect(res.body.usage).toEqual([
        expect.objectContaining({
          service: 'models', requests: 10, errors: 1, totalTokens: 100,
          viaTokens: [{ id: W.tokens.aliceCi, label: 'aliceCi', requests: 6 }],
        }),
      ]);
      const viaApp = (res.body.events as Array<{ path?: string }>).find((event) => event.path === '/api/client/v1/chat/completions');
      expect(viaApp).toMatchObject({
        method: 'POST', outcome: 'success', statusCode: 200,
        viaToken: { id: W.tokens.aliceCi, label: 'aliceCi' }, via: { kind: 'delegated', issuer: ISSUER },
      });
      // nothing of anybody else's
      expect(JSON.stringify(res.body)).not.toContain(String(W.users.bob._id));
    });

    it('is a read of the center: open to whoever reads it, closed to everybody else', async () => {
      expect((await call('GET', url('alice'), 'reader')).status).toBe(200);
      expect((await call('GET', url('alice'), 'owner')).status).toBe(200);
      expect((await call('GET', url('alice'), 'plain')).status).toBe(403);
    });

    it('answers 404 for somebody who does not exist or belongs to another workspace', async () => {
      expect((await call('GET', `/api/iam/principals/user/${'0'.repeat(24)}/activity`, 'admin')).status).toBe(404);
      expect((await call('GET', `/api/iam/principals/user/${String(OTHER.users.alice._id)}/activity`, 'admin')).status).toBe(404);
    });

    it('is quiet for somebody who did nothing', async () => {
      const res = await call('GET', url('bob'), 'admin');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ usage: [], hasMoreEvents: false });
    });
  });

  describe('the members of a group', () => {
    const members = (id: string, query = '', who = 'admin', ws: Workspace = W) => call('GET', `/api/iam/principals/group/${id}/members${query}`, who, undefined, ws);

    it('pages them by user id, with the people behind them and the total', async () => {
      const first = await members(W.groups.eng, '?limit=2');
      expect(first.status).toBe(200);
      expect(first.body.total).toBe(3);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBeTruthy();
      const second = await members(W.groups.eng, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();
      const all = [...first.body.items, ...second.body.items];
      expect(all.map((m: any) => m.userId)).toEqual([...all.map((m: any) => m.userId)].sort());
      expect(all.map((m: any) => m.label).sort()).toEqual(['Alice A', 'Bob B', 'Lena Ldap']);
      expect(all.find((m: any) => m.label === 'Lena Ldap')).toMatchObject({
        email: 'ldapUser@dir.example', role: 'user', status: 'active', kind: 'person', membershipSource: 'local',
      });
      expect(JSON.stringify(first.body)).not.toContain('password');
    });

    it('flags a membership whose account is gone, so it can be removed', async () => {
      const ghost = '0'.repeat(23) + 'a';
      await db.runWithTenant!(W.dbName, () => db.addGroupMember({ groupId: W.groups.eng, userId: ghost, tenantId: W.id, role: 'member' }));
      try {
        const res = await members(W.groups.eng, '?limit=100');
        expect(res.body.total).toBe(4);
        expect(res.body.items.find((m: any) => m.userId === ghost)).toEqual({
          userId: ghost, label: ghost, email: null, role: null, status: null, kind: null, membershipSource: 'local', missing: true,
        });
        expect(res.body.items.filter((m: any) => m.missing)).toHaveLength(1);
      } finally {
        await db.runWithTenant!(W.dbName, () => db.removeGroupMember(W.groups.eng, ghost));
      }
    });

    it('says the members of a directory group are the directory\'s', async () => {
      const res = await members(W.groups.dir);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ label: 'Carol C', status: 'disabled', membershipSource: 'ldap' });
    });

    it('is open to whoever reads the center, and closed to a group of another workspace', async () => {
      expect((await members(W.groups.eng, '', 'reader')).status).toBe(200);
      expect((await members(OTHER.groups.eng)).status).toBe(404); // the other workspace's group, asked as this one
      expect((await members(W.groups.eng, '', 'admin', OTHER)).status).toBe(404);
      expect((await members(OTHER.groups.eng, '', 'admin', OTHER)).status).toBe(200);
    });

    it('answers 404 for a group nobody has and 400 for a cursor that is not ours', async () => {
      for (const id of ['nobody', 'not-an-id', '0'.repeat(24)]) {
        const res = await members(id);
        expect([res.status, res.body.code], id).toEqual([404, 'principal_not_found']);
      }
      expect((await members(W.groups.eng, '?cursor=garbage')).body.code).toBe('invalid_cursor');
    });
  });

  // ── a draft of someone's access ─────────────────────────────────────────

  describe('previewing a draft of someone\'s access', () => {
    const preview = (id: string, body: unknown, who = 'admin') => call('POST', `/api/iam/principals/user/${id}/preview`, who, body);

    it('shows the effective access with the draft next to what it is now - and stores nothing', async () => {
      const alice = String(W.users.alice._id);
      const res = await preview(alice, { role: 'admin' });
      expect(res.status).toBe(200);
      const members = res.body.effective.find((row: any) => row.service === 'members');
      expect(members.level).toBe('admin');
      expect(res.body.changes.find((c: any) => c.service === 'members')).toEqual({ service: 'members', from: 'none', to: 'admin' });
      expect(res.body.projects).toEqual({ before: 2, after: 2 }); // an admin is in every project; alice already works in both
      const stored = await db.runWithTenant!(W.dbName, () => db.findUserById(alice));
      expect(stored?.role).toBe('user');
    });

    it('previews direct permission overrides (and drops a service this version does not know)', async () => {
      // (Pat belongs to no group: a group can only RAISE what a person has, so a member of a group that
      // grants more would not drop)
      const res = await preview(String(W.users.plain._id), { servicePermissions: { agents: 'read', nonsense: 'admin' } });
      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([{ service: 'agents', from: 'write', to: 'read' }]);
      expect(res.body.effective.find((row: any) => row.service === 'agents').level).toBe('read');
      // a member of a group that grants write keeps it
      const grouped = await preview(String(W.users.alice._id), { servicePermissions: { agents: 'read' } });
      expect(grouped.body.changes).toEqual([]);
    });

    it('counts the projects a demotion would leave', async () => {
      const res = await preview(String(W.users.admin2._id), { role: 'user' });
      expect(res.body.projects).toEqual({ before: 2, after: 0 });
      expect(res.body.changes.find((c: any) => c.service === 'members')).toEqual({ service: 'members', from: 'admin', to: 'none' });
    });

    it('says nothing changes for a draft that changes nothing', async () => {
      const res = await preview(String(W.users.alice._id), { role: 'user', servicePermissions: {} });
      expect(res.body.changes).toEqual([]);
    });

    it('is a read of the center: it is not clamped to the viewer, and not an administrative event', async () => {
      const res = await preview(String(W.users.bob._id), { role: 'admin' }, 'reader');
      expect(res.status).toBe(200);
      expect(res.body.changes.length).toBeGreaterThan(0);
    });

    it('refuses what it cannot preview', async () => {
      const alice = String(W.users.alice._id);
      for (const [body, code] of [
        [{}, 'invalid_body'], [[], 'invalid_body'], [{ role: 'owner' }, 'invalid_role'], [{ role: 'root' }, 'invalid_role'], [{ role: 7 }, 'invalid_role'],
        [{ servicePermissions: [] }, 'invalid_body'], [{ servicePermissions: null }, 'invalid_body'], [{ nickname: 'x', role: 'user' }, 'invalid_body'],
      ] as const) {
        const res = await preview(alice, body);
        expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, code]);
      }
      const nobody = await preview('nobody', { role: 'user' });
      expect([nobody.status, nobody.body.code]).toEqual([404, 'principal_not_found']);
      const foreign = await preview(String(OTHER.users.alice._id), { role: 'user' });
      expect(foreign.status).toBe(404);
    });

    it('is rate limited per person', async () => {
      const alice = String(W.users.alice._id);
      let limited = false;
      for (let i = 0; i < 40 && !limited; i += 1) limited = (await preview(alice, { role: 'user' }, 'owner')).status === 429;
      expect(limited).toBe(true);
      expect((await preview(alice, { role: 'user' }, 'admin2')).status).toBe(200);
    }, 30_000);
  });

  // ── what the viewer can do here ─────────────────────────────────────────

  describe('capabilities', () => {
    const capabilities = (who: string) => call('GET', '/api/iam/capabilities', who);

    it('an owner and an admin can do everything', async () => {
      for (const who of ['owner', 'admin']) {
        const res = await capabilities(who);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          me: { userId: String(W.users[who]._id), role: who },
          policies: { manage: true },
          people: { manage: true, grantAdmin: true, assignableRoles: ['admin', 'project_admin', 'user'] },
          tokens: { manageOthers: true },
        });
      }
    });

    it('someone who only reads the center can manage nothing', async () => {
      const res = await capabilities('reader');
      expect(res.body).toEqual({
        me: { userId: String(W.users.reader._id), role: 'user' },
        policies: { manage: false },
        people: { manage: false, grantAdmin: false, assignableRoles: [] },
        tokens: { manageOthers: false },
      });
    });

    // `members.write` is what the gate asks of every change to a person (and `iam.write` of every change to the
    // center): the answer here is the same question. iam-capabilities-gate.test.ts checks it against the real gates.
    it('respects a policy: an admin forbidden to write members is told so', async () => {
      const created = await call('POST', '/api/iam/policies', 'owner', {
        name: 'No people administration for Adam', enabled: true,
        spec: { effect: 'forbid', principals: { users: [String(W.users.admin._id)] }, actions: ['members.write'], resources: { any: true } },
      });
      expect(created.status).toBe(201);
      try {
        const res = await capabilities('admin');
        expect(res.body.people).toEqual({ manage: false, grantAdmin: true, assignableRoles: [] });
        expect(res.body.policies.manage).toBe(true);
        expect((await capabilities('owner')).body.people.manage).toBe(true);
      } finally {
        await call('DELETE', `/api/iam/policies/${created.body.policyId}`, 'owner');
      }
      expect((await capabilities('admin')).body.people.manage).toBe(true);
    });

    it('respects a policy: an admin forbidden to write the center is told so', async () => {
      const created = await call('POST', '/api/iam/policies', 'owner', {
        name: 'No policy administration for Adam', enabled: true,
        spec: { effect: 'forbid', principals: { users: [String(W.users.admin._id)] }, actions: ['iam.write'], resources: { any: true } },
      });
      expect(created.status).toBe(201);
      try {
        const res = await capabilities('admin');
        expect(res.body.policies).toEqual({ manage: false });
        expect(res.body.people.manage).toBe(true);
        expect((await capabilities('owner')).body.policies.manage).toBe(true);
      } finally {
        await call('DELETE', `/api/iam/policies/${created.body.policyId}`, 'owner');
      }
      expect((await capabilities('admin')).body.policies.manage).toBe(true);
    });

    it('does not read a rule on an action no gate asks (members.admin) as a loss of the controls', async () => {
      const created = await call('POST', '/api/iam/policies', 'owner', {
        name: 'Nothing the gates ask', enabled: true,
        spec: { effect: 'forbid', principals: { users: [String(W.users.admin._id)] }, actions: ['members.admin', 'iam.admin'], resources: { any: true } },
      });
      expect(created.status).toBe(201);
      try {
        const res = await capabilities('admin');
        expect(res.body.people.manage).toBe(true);
        expect(res.body.policies.manage).toBe(true);
      } finally {
        await call('DELETE', `/api/iam/policies/${created.body.policyId}`, 'owner');
      }
    });

    it('judges the role the account has now', async () => {
      const stale = { ...W.users.admin2, role: 'owner' } as IUser; // the session still says owner
      const res = await call('GET', '/api/iam/capabilities', stale);
      expect(res.status).toBe(200);
      expect(res.body.me.role).toBe('admin');
    });
  });

  describe('the detail of a group', () => {
    it('adds the grant and what the viewer may do', async () => {
      const res = await call('GET', `/api/iam/principals/group/${W.groups.dir}`, 'admin');
      expect(res.status).toBe(200);
      expect(res.body.principal).toMatchObject({ source: 'ldap', managed: true, servicePermissions: {} });
      expect(res.body.allowedActions.delete).toEqual({ allowed: false, reason: 'directory_managed' });
      expect(res.body.allowedActions.edit).toEqual({ allowed: true });
      const eng = await call('GET', `/api/iam/principals/group/${W.groups.eng}`, 'reader');
      expect(eng.body.allowedActions.edit).toEqual({ allowed: false, reason: 'forbidden' });
    });
  });
});
