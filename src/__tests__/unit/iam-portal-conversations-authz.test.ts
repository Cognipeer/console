/**
 * `portal.conversations_view`: reading what the people of a portal said, decided by the policy engine for a request of the
 * dashboard or the API (the route asks it with `service: 'portals'`).
 *
 *   the default   owners and administrators have it (the portals Admin level); an ordinary member who can manage portals
 *                 does not - it is not part of Read or Write
 *   the boundary  an Admin-level action needs the Admin level: a permit cannot lift an ordinary member over it
 *                 (`managed:boundary:project-admin`), an administrator of one project does not hold it either, and a
 *                 forbid takes it from an administrator
 *   the catalog   it is an Admin-level resource action of the portal type, enforced in the dashboard and the API
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { RUNTIME_ENFORCED_ACTIONS } from '@/lib/iam/actions';
import { buildCatalog } from '@/lib/iam/catalog';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { buildEnforcePrincipal, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { portalResource } from '@/lib/iam/portalEntities';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { authorizeResourceForPrincipal, resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import type { IamPrincipal } from '@/lib/iam/entities';
import { describeForEachProvider } from '../integration/db-parity.helper';

describeForEachProvider('portal.conversations_view', (getDb) => {
  let db: DatabaseProvider;
  let dbName = '';
  let tenantId = '';
  let projectId = '';
  const users: Record<string, IUser> = {};
  const idOf = (key: string) => String(users[key]._id);

  async function principalOf(who: string): Promise<IamPrincipal> {
    return db.runWithTenant!(dbName, () => buildEnforcePrincipal({
      subject: 'session',
      tenantDbName: dbName,
      tenantId,
      requestId: 'req-1',
      method: 'GET',
      route: '/portals/p1/conversations',
      userId: idOf(who),
      user: users[who],
      requestedProjectId: projectId,
      projectFromPath: true,
      service: 'portals',
    }));
  }

  const portal = () => portalResource({ id: 'portal-1', key: 'support', access: { mode: 'selected', userIds: [], groupIds: [] } });

  async function ask(who: string) {
    return authorizeResourceForPrincipal({
      tenantDbName: dbName,
      tenantId,
      userId: idOf(who),
      principal: await principalOf(who),
      channel: 'dashboard',
      action: 'portal.conversations_view',
      resource: portal(),
      subject: { portalId: 'portal-1', portalKey: 'support', resourceName: 'Support' },
      client: { ip: '203.0.113.9', requestId: 'req-1', userAgent: 'vitest', method: 'GET', path: '/api/portals/portal-1/conversations' },
    });
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `pconv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Portal conversations', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user') => {
        users[key] = await db.createUser({ tenantId, email: `${key}@pconv.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [] } as never);
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      await mk('member', 'user');
      await mk('padmin', 'user');
      projectId = String((await db.createProject({ tenantId, key: 'pj1', name: 'Project One', createdBy: 'x' }))._id);
      await db.upsertUserProject({
        tenantId, userId: idOf('member'), projectId, role: 'member',
        // may manage portals (write), which is still below the Admin level the action sits at
        servicePermissions: { portals: 'write' },
      } as never);
      await db.upsertUserProject({ tenantId, userId: idOf('padmin'), projectId, role: 'project_admin' } as never);
    });
  });
  afterAll(async () => {
    configureIamEngine({ validateRequests: false });
    await drainPendingTasks();
  });
  beforeEach(() => {
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    resetEnforceStatsForTests();
    resetResourceAuthzThrottleForTests();
    resetResourceAuthzStatsForTests();
  });
  afterEach(async () => {
    await drainPendingTasks();
    for (const p of await listPolicies(dbName)) await deletePolicy(dbName, p.policyId);
  });

  it('is an Admin-level action of the portal type, decided in the dashboard and the API', () => {
    const entry = buildCatalog().actions.find((a) => a.id === 'portal.conversations_view');
    expect(entry).toMatchObject({ kind: 'resource', level: 'admin', resourceType: 'portal', verb: 'conversations_view' });
    expect(RUNTIME_ENFORCED_ACTIONS['portal.conversations_view']).toEqual(['dashboard', 'api']);
  });

  it('is held by the owner and an administrator', async () => {
    expect((await ask('owner')).allowed).toBe(true);
    expect((await ask('admin')).allowed).toBe(true);
  });

  it('is not held by a member who may manage portals - and the refusal has a decision id', async () => {
    const result = await ask('member');
    expect(result.allowed).toBe(false);
    expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is not held by an administrator of one project: it is a decision about the workspace\'s portal', async () => {
    expect((await ask('padmin')).allowed).toBe(false);
  });

  it('is not lifted for an ordinary member by a permit: the project boundary still applies', async () => {
    await createPolicy(dbName, {
      policyId: 'member-reads-portal-conversations',
      name: 'A permit for a member',
      cedar: `permit (principal == User::"${idOf('member')}", action == Action::"portal.conversations_view", resource);`,
    }, 'tester');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetPrincipalCacheForTests();
    const result = await ask('member');
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('managed:boundary:project-admin');
  });

  it('can be taken from an administrator by a policy', async () => {
    await createPolicy(dbName, {
      policyId: 'admin-no-portal-conversations',
      name: 'Administrators do not read portal conversations',
      cedar: `forbid (principal == User::"${idOf('admin')}", action == Action::"portal.conversations_view", resource);`,
    }, 'tester');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetPrincipalCacheForTests();
    expect((await ask('admin')).allowed).toBe(false);
    expect((await ask('owner')).allowed).toBe(true);
  });
});
