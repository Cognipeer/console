/**
 * GET /api/projects/:projectId/members names, for every member, the services whose
 * stored "No access" the policy engine reads as not set (`ignoredServices`):
 *
 *   - the engine ignores an explicit `none` in a membership row last saved BEFORE
 *     the workspace's first decision (projectLevels.ts); `read` / `write` / `admin`
 *     entries and every entry of a row saved after it count;
 *   - the member screens take the list to show those entries as Inherit and to drop
 *     them on the next save - also for a project admin, who cannot read the IAM
 *     center and so cannot work it out from the effective permissions;
 *   - what the screens show is what the engine applies.
 *
 * Real plugin, real SQLite and MongoDB.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

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
import { effectiveProjectLevels, primeProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { summarizeStored } from '@/components/projects/projectPermissionsModel';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Member {
  userId: string;
  implicit: boolean;
  projectRole: string | null;
  servicePermissions: Record<string, string> | null;
  ignoredServices?: string[];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeForEachProvider('project members: ignored project levels', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let dbName = '';
  let tenantId = '';
  let projectId = '';
  let since = 0;
  const users: Record<string, IUser> = {};

  const headers = (user: IUser) => ({
    'x-tenant-db-name': dbName,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'members-ignored',
    'x-user-id': String(user._id),
    'x-user-role': String(user.role),
    'x-user-email': String(user.email),
    'x-license-type': 'FREE',
  });

  async function listMembers(who: string): Promise<{ status: number; members: Member[] }> {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/members`, headers: headers(users[who]) });
    const body = res.body ? parseJsonBody<{ members?: Member[] }>(res.body) : {};
    return { status: res.statusCode, members: body.members ?? [] };
  }

  const byName = (members: Member[], name: string) => members.find((m) => m.userId === String(users[name]._id));

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `memign-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Members', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);

    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        users[key] = await db.createUser({ tenantId, email: `${key}@${slug}.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra });
      };
      const project = await db.createProject({ tenantId, key: 'pj', name: 'Retail', createdBy: 'x' });
      projectId = String(project._id);
      await mk('owner', 'owner');
      await mk('padmin', 'user');
      await mk('oldnone', 'user');
      await mk('oldkept', 'user');
      await mk('newnone', 'user');
      await mk('legacy', 'user', { projectIds: [projectId] });

      const assign = (key: string, servicePermissions?: Record<string, string>, role: 'member' | 'project_admin' = 'member') =>
        db.upsertUserProject({ tenantId, userId: String(users[key]._id), projectId, role, ...(servicePermissions ? { servicePermissions } : {}) } as never);

      // saved before the workspace's first decision: a "No access" the engine reads as not set
      await assign('padmin', undefined, 'project_admin');
      await assign('oldnone', { agents: 'none', prompts: 'read', models: 'none' });
      await assign('oldkept', { agents: 'read', tools: 'write' });
      await wait(15);
      since = Date.now();
      primeProjectLevelsForTests(dbName, since);
      await wait(15);
      // saved after it: counts in full
      await assign('newnone', { agents: 'none' });
    });

    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(projectsApiPlugin);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('names the services whose stored "No access" predates the first decision, per member', async () => {
    const { status, members } = await listMembers('owner');
    expect(status).toBe(200);

    expect([...(byName(members, 'oldnone')!.ignoredServices ?? [])].sort()).toEqual(['agents', 'models']);
    // read / write / admin entries are never ignored
    expect(byName(members, 'oldkept')!.ignoredServices).toEqual([]);
    // a row saved after the moment counts in full: nothing is ignored in it
    expect(byName(members, 'newnone')!.ignoredServices).toEqual([]);
    expect(byName(members, 'newnone')!.servicePermissions).toEqual({ agents: 'none' });
    // a row without stored levels
    expect(byName(members, 'padmin')!.ignoredServices).toEqual([]);
  });

  it('every member carries the list: the implicit ones and the ones assigned through the legacy project list too', async () => {
    const { members } = await listMembers('owner');
    expect(members.length).toBeGreaterThanOrEqual(6);
    for (const member of members) {
      expect(Array.isArray(member.ignoredServices), String(member.userId)).toBe(true);
    }
    expect(byName(members, 'owner')).toMatchObject({ implicit: true, ignoredServices: [] });
    expect(byName(members, 'legacy')).toMatchObject({ implicit: false, ignoredServices: [] });
  });

  it('a project admin gets the same list, without any access to the IAM center', async () => {
    const asOwner = (await listMembers('owner')).members;
    const asProjectAdmin = await listMembers('padmin');
    expect(asProjectAdmin.status).toBe(200);
    const ignored = (members: Member[]) => Object.fromEntries(members.map((m) => [m.userId, [...(m.ignoredServices ?? [])].sort()]));
    expect(ignored(asProjectAdmin.members)).toEqual(ignored(asOwner));
  });

  it('what the members table shows is what the engine applies', async () => {
    const { members } = await listMembers('owner');
    const rows = await db.runWithTenant!(dbName, () => db.listUserProjectsByProject(projectId));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const member = members.find((m) => m.userId === String(row.userId))!;
      const summary = summarizeStored(member.servicePermissions, member.ignoredServices ?? []);
      const shown = summary.kind === 'inherits'
        ? {}
        : summary.kind === 'one'
          ? { [summary.service]: summary.level }
          : Object.fromEntries(summary.entries.map((entry) => [entry.service, entry.level]));
      expect(shown, String(row.userId)).toEqual(effectiveProjectLevels(row, since));
    }
  });

  it('with the moment at the start of time every stored "No access" counts, so nothing is named', async () => {
    primeProjectLevelsForTests(dbName, 0);
    try {
      const { members } = await listMembers('owner');
      expect(byName(members, 'oldnone')!.servicePermissions).toEqual({ agents: 'none', prompts: 'read', models: 'none' });
      expect(byName(members, 'oldnone')!.ignoredServices).toEqual([]);
    } finally {
      primeProjectLevelsForTests(dbName, since);
    }
  });
});
