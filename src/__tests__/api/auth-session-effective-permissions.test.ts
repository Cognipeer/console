/**
 * GET /api/auth/session carries what the engine allows the signed-in user in their
 * active project (`effectivePermissions`, `effectiveProjectId`), so the dashboard
 * can draw project-aware navigation. The REAL session endpoint, gate and engine, on
 * BOTH SQLite and MongoDB.
 *
 * The figures are a hint for the menu - the gates decide every request on their own -
 * so when the engine cannot answer both fields are null and the rest of the payload is
 * untouched.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), policySetFails: false }));

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
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    describeTenantPolicySet: (...args: Parameters<typeof actual.describeTenantPolicySet>) => {
      if (hoisted.policySetFails) return Promise.reject(new Error('the policy store is unreachable'));
      return actual.describeTenantPolicySet(...args);
    },
  };
});

import type { FastifyInstance } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEffectiveLevelsForTests } from '@/lib/iam/effective';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { createPolicy, deletePolicy } from '@/lib/iam/store';
import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

const LIVE_SERVICES = RBAC_SERVICE_DEFINITIONS.filter((d) => !d.deprecated);
const ADMIN_SERVICES = RBAC_SERVICE_DEFINITIONS.filter((d) => d.adminService).map((d) => d.id);
const ORDINARY_SERVICES = LIVE_SERVICES.filter((d) => !d.adminService && !d.defaultMemberLevel).map((d) => d.id);
/** Ordinary services whose member default is lower than write (e.g. `flows`: read). */
const LOWER_DEFAULT_SERVICES = LIVE_SERVICES.filter((d) => !d.adminService && d.defaultMemberLevel);

interface SessionBody {
  authenticated: boolean;
  role: string;
  projectCount: number;
  servicePermissions: Record<string, string>;
  effectivePermissions: Record<string, string> | null;
  effectiveProjectId: string | null;
}

describeForEachProvider('GET /api/auth/session: effective permissions', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let dbName: string;
  let tenantId: string;
  const users: Record<string, IUser> = {};
  let pj1: string;
  let pj2: string;
  let team: string;

  const inTenant = <T>(fn: () => Promise<T>) => db.runWithTenant!(dbName, fn);

  async function mk(key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) {
    users[key] = await inTenant(() => db.createUser({ tenantId, email: `${key}@sess.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra }));
  }

  async function session(user: IUser, project?: string) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        'x-tenant-db-name': dbName,
        'x-tenant-id': tenantId,
        'x-tenant-slug': 'sess',
        'x-user-id': String(user._id),
        'x-user-role': String(user.role),
        'x-user-email': String(user.email),
        'x-license-type': 'FREE',
        ...(project ? { cookie: `active_project_id=${project}` } : {}),
      },
    });
    return { status: res.statusCode, body: parseJsonBody<SessionBody>(res.body) };
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    dbName = `tenant_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const row = await db.createTenant({ companyName: 'Session', slug: dbName.replace(/_/g, '-'), dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);

    await mk('owner', 'owner');
    await mk('admin', 'admin');
    await mk('plain', 'user');
    // an explicit service grant per level; `members` is an administration service, where write is not a level of its own
    await mk('granted', 'user', { servicePermissions: { agents: 'read', members: 'write', models: 'admin' } });
    await mk('dave', 'user');
    await mk('gm', 'user');

    const p1 = await inTenant(() => db.createProject({ tenantId, key: 'pj1', name: 'Project One', createdBy: 'x' }));
    const p2 = await inTenant(() => db.createProject({ tenantId, key: 'pj2', name: 'Project Two', createdBy: 'x' }));
    pj1 = String(p1._id);
    pj2 = String(p2._id);
    // dave: agents limited to read in Project One, nothing said in Project Two
    await inTenant(() => db.upsertUserProject({ tenantId, userId: String(users.dave._id), projectId: pj1, role: 'member', servicePermissions: { agents: 'read' } } as never));
    await inTenant(() => db.upsertUserProject({ tenantId, userId: String(users.dave._id), projectId: pj2, role: 'member' } as never));

    // gm gets members:read through a group
    const g = await inTenant(() => db.createGroup({ tenantId, name: 'Auditors', createdBy: 't', source: 'local', servicePermissions: { members: 'read' } } as never));
    team = String(g._id);
    await inTenant(() => db.addGroupMember({ groupId: team, userId: String(users.gm._id), tenantId, role: 'member' }));

    app = await createFastifyApiTestApp(authApiPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    hoisted.policySetFails = false;
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    resetEffectiveLevelsForTests();
    configureIamEngine({ validateRequests: false });
    resetProjectNarrowingCachesForTests();
  });

  it('keeps the payload it always had and adds the levels of every live service', async () => {
    const { status, body } = await session(users.plain);
    expect(status).toBe(200);
    expect(body).toMatchObject({ authenticated: true, role: 'user', servicePermissions: {} });
    expect(Object.keys(body.effectivePermissions ?? {}).sort()).toEqual(LIVE_SERVICES.map((d) => d.id).sort());
    expect(body.effectivePermissions).not.toHaveProperty('aegis'); // retired services are not listed
    for (const level of Object.values(body.effectivePermissions ?? {})) expect(['none', 'read', 'write', 'admin']).toContain(level);
  });

  it('an owner and an admin reach admin level everywhere', async () => {
    for (const who of ['owner', 'admin']) {
      const { body } = await session(users[who]);
      expect(Object.values(body.effectivePermissions ?? {}), who).toEqual(Array(LIVE_SERVICES.length).fill('admin'));
    }
  });

  it('a plain member writes ordinary services and has nothing in the administration ones', async () => {
    const { body } = await session(users.plain);
    for (const service of ORDINARY_SERVICES) expect(body.effectivePermissions![service], service).toBe('write');
    for (const d of LOWER_DEFAULT_SERVICES) expect(body.effectivePermissions![d.id], d.id).toBe(d.defaultMemberLevel);
    for (const service of ADMIN_SERVICES.filter((s) => LIVE_SERVICES.some((d) => d.id === s))) expect(body.effectivePermissions![service], service).toBe('none');
  });

  it('explicit grants count per service; write is not a level of an administration service', async () => {
    const { body } = await session(users.granted);
    expect(body.servicePermissions).toMatchObject({ agents: 'read', members: 'write', models: 'admin' });
    expect(body.effectivePermissions).toMatchObject({ agents: 'read', models: 'admin', members: 'read' });
    expect(body.effectivePermissions!.prompts).toBe('write'); // everything not named keeps the role default
  });

  it('a group grant raises the level of its members', async () => {
    expect((await session(users.gm)).body.effectivePermissions!.members).toBe('read');
    expect((await session(users.plain)).body.effectivePermissions!.members).toBe('none');
  });

  it('follows the active project: its limits narrow, and the answer names the project', async () => {
    const inOne = (await session(users.dave, pj1)).body;
    expect(inOne.effectiveProjectId).toBe(pj1);
    expect(inOne.effectivePermissions!.agents).toBe('read');
    expect(inOne.effectivePermissions!.prompts).toBe('write'); // the project says nothing about it

    const inTwo = (await session(users.dave, pj2)).body;
    expect(inTwo.effectiveProjectId).toBe(pj2);
    expect(inTwo.effectivePermissions!.agents).toBe('write');

    // without an active project the user runs where the gate would put them: one of their projects, consistently
    const none = (await session(users.dave)).body;
    expect([pj1, pj2]).toContain(none.effectiveProjectId);
    expect(none.effectivePermissions!.agents).toBe(none.effectiveProjectId === pj1 ? 'read' : 'write');
    // a cookie naming a project the user is not in does not widen anything
    const foreign = (await session(users.dave, '0123456789abcdef01234567')).body;
    expect([pj1, pj2]).toContain(foreign.effectiveProjectId);
  });

  it('owners and admins are never narrowed by a project', async () => {
    await inTenant(() => db.upsertUserProject({ tenantId, userId: String(users.admin._id), projectId: pj1, role: 'member', servicePermissions: { agents: 'none' } } as never));
    const { body } = await session(users.admin, pj1);
    expect(body.effectivePermissions!.agents).toBe('admin');
    expect(body.effectiveProjectId).toBe(pj1);
  });

  it('shows what a custom policy takes away (and nothing before it exists)', async () => {
    expect((await session(users.plain)).body.effectivePermissions!.agents).toBe('write');
    await createPolicy(dbName, {
      policyId: 'no-agent-writes',
      name: 'no agent writes',
      cedar: 'forbid(principal, action == Action::"agents.write", resource);',
    }, 'test');
    try {
      const { body } = await session(users.plain);
      expect(body.effectivePermissions!.agents).toBe('read');
      expect(body.effectivePermissions!.prompts).toBe('write');
      // nobody is exempt but the owner's access to the Authorization center: other services are decided for the owner too
      expect((await session(users.owner)).body.effectivePermissions!.agents).toBe('read');
    } finally {
      await deletePolicy(dbName, 'no-agent-writes');
    }
    expect((await session(users.plain)).body.effectivePermissions!.agents).toBe('write');
  });

  it('is null when the engine cannot answer, and the rest of the payload is untouched', async () => {
    // a workspace with a custom policy has to ask the engine; without one the levels come from the principal alone
    await createPolicy(dbName, { policyId: 'any-policy', name: 'any policy', cedar: 'forbid(principal, action == Action::"agents.admin", resource);' }, 'test');
    try {
      hoisted.policySetFails = true;
      const { status, body } = await session(users.plain);
      expect(status).toBe(200);
      expect(body).toMatchObject({ authenticated: true, role: 'user', effectivePermissions: null, effectiveProjectId: null });
    } finally {
      hoisted.policySetFails = false;
      await deletePolicy(dbName, 'any-policy');
    }
  });
});
