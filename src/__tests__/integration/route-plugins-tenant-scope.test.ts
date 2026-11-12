/**
 * Dashboard route plugins (users, groups, license) open their own tenant scope: two tenants calling
 * them at the same time through the live Fastify plugins each read and write only their own rows,
 * on both real backends.
 *
 * No `switchToTenant` call comes directly from a route plugin; reverting the plugins to a bare
 * switch fails every case. Services further down the same paths are moved off the shared handle
 * in their own changes, so the check looks at the direct caller.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';

const h = vi.hoisted(() => ({ db: null as DatabaseProvider | null }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  const current = async (): Promise<DatabaseProvider> => {
    if (!h.db) throw new Error('database provider not initialised');
    return h.db;
  };
  return {
    ...actual,
    getDatabase: current,
    runWithTenantScope: async <T>(tenantDbName: string, fn: (db: DatabaseProvider) => T | Promise<T>): Promise<T> => {
      const db = await current();
      return db.runWithTenant!(tenantDbName, () => fn(db));
    },
  };
});

import { groupsApiPlugin } from '@/server/api/plugins/groups';
import { licenseApiPlugin } from '@/server/api/plugins/license';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

const apiUnderTest: FastifyPluginAsync = async (app) => {
  await app.register(usersApiPlugin);
  await app.register(groupsApiPlugin);
  await app.register(licenseApiPlugin);
};

interface Tenant {
  name: 'alpha' | 'beta';
  tenantId: string;
  tenantDbName: string;
  slug: string;
  owner: IUser;
  member: IUser;
  groupId: string;
}

/** Records the frame that called `switchToTenant` directly: the first one outside node_modules and this file. */
function recordSwitchCallers(target: DatabaseProvider): string[] {
  const callers: string[] = [];
  const original = target.switchToTenant.bind(target);
  vi.spyOn(target, 'switchToTenant').mockImplementation(async (tenantDbName: string) => {
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    const caller = frames.find((frame) => !frame.includes('node_modules') && !frame.includes('route-plugins-tenant-scope.test'));
    callers.push(caller?.trim() ?? '<unknown>');
    return original(tenantDbName);
  });
  return callers;
}

const fromRoutePlugins = (callers: string[]) => callers.filter((frame) => frame.includes('server/api/plugins/'));

describeForEachProvider('route plugins, two tenants at once', (getDb) => {
  let db: DatabaseProvider;
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let tenants: [Tenant, Tenant];

  async function seedTenant(name: Tenant['name']): Promise<Tenant> {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const slug = `routes-${name}-${suffix}`;
    const tenantDbName = `tenant_routes_${name}_${suffix}`;
    const tenant = await db.createTenant({ companyName: name, slug, dbName: tenantDbName, licenseType: 'ENTERPRISE', ownerId: 'pending' });
    const tenantId = String(tenant._id);
    return db.runWithTenant!(tenantDbName, async () => {
      const mkUser = (who: string, role: IUser['role']) => db.createUser({
        tenantId, email: `${who}@${name}.io`, name: `${who} of ${name}`, password: '$2b$10$x', role, licenseId: 'ENTERPRISE', features: [],
      });
      const owner = await mkUser('owner', 'owner');
      const member = await mkUser('member', 'user');
      const group = await db.createGroup({
        tenantId, name: `${name} seed group`, servicePermissions: {}, source: 'local', createdBy: String(owner._id),
      } as never);
      await db.createProject({ tenantId, key: `${name}-project`, name: `${name} project`, createdBy: String(owner._id) });
      return { name, tenantId, tenantDbName, slug, owner, member, groupId: String(group._id) };
    });
  }

  beforeAll(async () => {
    db = getDb();
    h.db = db;
    tenants = [await seedTenant('alpha'), await seedTenant('beta')];
    app = await createFastifyApiTestApp(apiUnderTest);
    await app.ready();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    h.db = null;
  });

  const headers = (t: Tenant) => ({
    'content-type': 'application/json',
    'x-license-type': 'ENTERPRISE',
    'x-tenant-db-name': t.tenantDbName,
    'x-tenant-id': t.tenantId,
    'x-tenant-slug': t.slug,
    'x-user-email': t.owner.email,
    'x-user-id': String(t.owner._id),
    'x-user-role': 'owner',
  });

  const call = (t: Tenant, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({
    method, url, headers: headers(t), ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

  async function work(t: Tenant, other: Tenant) {
    const created = await call(t, 'POST', '/api/groups', { name: `${t.name} new group` });
    expect(created.statusCode, created.body).toBe(201);
    const responses = await Promise.all([
      call(t, 'GET', '/api/users'),
      call(t, 'GET', `/api/users/${String(t.member._id)}`),
      call(t, 'GET', `/api/users/${String(other.member._id)}`),
      call(t, 'GET', '/api/groups'),
      call(t, 'GET', `/api/groups/${t.groupId}`),
      call(t, 'GET', '/api/license'),
    ]);
    return { created, responses };
  }

  function expectOwnData(t: Tenant, result: Awaited<ReturnType<typeof work>>) {
    const [users, member, foreignMember, groups, group, license] = result.responses;
    for (const response of [users, member, groups, group, license]) expect(response.statusCode, response.body).toBe(200);
    expect(foreignMember.statusCode).toBe(404);

    const userNames = parseJsonBody<{ users: Array<{ name: string }> }>(users.body).users.map((u) => u.name).sort();
    expect(userNames).toEqual([`member of ${t.name}`, `owner of ${t.name}`]);
    expect(parseJsonBody<{ user: { name: string } }>(member.body).user.name).toBe(`member of ${t.name}`);
    const groupNames = parseJsonBody<{ groups: Array<{ name: string }> }>(groups.body).groups.map((g) => g.name);
    expect(groupNames).toContain(`${t.name} seed group`);
    expect(groupNames.every((name) => name.startsWith(`${t.name} `))).toBe(true);
    expect(parseJsonBody<{ group: { name: string } }>(group.body).group.name).toBe(`${t.name} seed group`);
    const licenseBody = parseJsonBody<{ tenantSlug: string; projectCount: number }>(license.body);
    expect(licenseBody).toMatchObject({ tenantSlug: t.slug, projectCount: 1 });
  }

  it('keeps each tenant on its own rows while the calls interleave', async () => {
    const [a, b] = tenants;
    const switchCallers = recordSwitchCallers(db);
    const [ra, rb] = await Promise.all([work(a, b), work(b, a)]);
    expect(fromRoutePlugins(switchCallers)).toEqual([]);
    expectOwnData(a, ra);
    expectOwnData(b, rb);
  });

  it('lands each call in its own tenant inside an enclosing scope bound to the other tenant', async () => {
    const [a, b] = tenants;
    const switchCallers = recordSwitchCallers(db);
    const [ra, rb] = await Promise.all([
      db.runWithTenant!(b.tenantDbName, () => work(a, b)),
      db.runWithTenant!(a.tenantDbName, () => work(b, a)),
    ]);
    expect(fromRoutePlugins(switchCallers)).toEqual([]);
    expectOwnData(a, ra);
    expectOwnData(b, rb);
  });
});
