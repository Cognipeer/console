/**
 * A project lead who is in one project does not reach the tokens of another one -
 * neither by editing (PUT /api/tokens/:id?projectId=) nor by revoking
 * (POST /api/tokens/revoke) - through the real data layer of BOTH providers
 * (SQLite and, when mongodb-memory-server is installed, MongoDB).
 *
 * The rules are covered against an in-memory fake in api/tokens-project-override.test.ts
 * and api/tokens-revoke.test.ts. What only a real provider shows is that the project
 * lookup they lean on (direct memberships, the legacy list, groups) answers the same
 * way on both backends, so the same request ends the same way.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const ref = vi.hoisted(() => ({ db: null as unknown, activeProject: 'unset' }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn(async () => ref.db),
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = ref.db as any;
      return db.runWithTenant ? db.runWithTenant(tenantDbName, () => fn(db)) : fn(db);
    },
  };
});
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
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
    // the project the request runs in: the one the suite says is active
    resolveProjectContext: vi.fn(async () => ({ projectId: ref.activeProject })),
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

type Role = 'owner' | 'admin' | 'project_admin' | 'user';
type Who = 'owner' | 'admin' | 'lead' | 'svc';

describeForEachProvider('Tokens of a project the caller is not in', (getDb) => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  let people: Record<Who, { id: string; role: Role }>;
  let projects: { a: string; b: string };
  let tokenIds: Record<'svcA' | 'svcB' | 'leadB', string>;

  const headersFor = (who: Who) => ({
    'content-type': 'application/json',
    'x-license-type': 'STARTER',
    'x-tenant-db-name': tenantDbName,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'acme',
    'x-user-id': people[who].id,
    'x-user-role': people[who].role,
  });
  const edit = (who: Who, id: string, label: string, projectId?: string) => app.inject({
    method: 'PUT',
    url: `/api/tokens/${id}${projectId ? `?projectId=${projectId}` : ''}`,
    headers: headersFor(who),
    payload: JSON.stringify({ label }),
  });
  const revoke = (who: Who, ids: string[]) => app.inject({
    method: 'POST', url: '/api/tokens/revoke', headers: headersFor(who), payload: JSON.stringify({ ids }),
  });
  const labelOf = async (id: string) => (await db.findApiTokenById(id, tenantId))?.label ?? null;
  const exists = async (id: string) => (await db.findApiTokenById(id, tenantId)) !== null;

  beforeEach(async () => {
    db = getDb();
    ref.db = db;
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tenantDbName = `tenant_reach_${suffix}`;
    const tenant = await db.createTenant({
      companyName: 'Acme', slug: `acme-${suffix}`, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending',
    });
    tenantId = String(tenant._id);

    await db.runWithTenant!(tenantDbName, async () => {
      const mkUser = async (name: string, role: Role, extra: { canLogin?: boolean; email?: string } = {}) => {
        const user = await db.createUser({
          tenantId, email: extra.email ?? `${name}@example.test`, name, password: 'not-a-real-hash', role, licenseId: 'FREE', features: [], canLogin: extra.canLogin,
        });
        return { id: String(user._id), role };
      };
      people = {
        owner: await mkUser('owner', 'owner'),
        admin: await mkUser('admin', 'admin'),
        lead: await mkUser('lead', 'project_admin'),
        svc: await mkUser('svc', 'user', { canLogin: false, email: '' }),
      };
      const a = await db.createProject({ tenantId, key: 'pja', name: 'Project A', createdBy: 'x' });
      const b = await db.createProject({ tenantId, key: 'pjb', name: 'Project B', createdBy: 'x' });
      projects = { a: String(a._id), b: String(b._id) };
      // the lead is in A only
      await db.upsertUserProject({ tenantId, userId: people.lead.id, projectId: projects.a, role: 'member' });
    });
    ref.activeProject = projects.a;

    let n = 0;
    const mkToken = async (label: string, userId: string, projectId: string) =>
      String((await db.createApiToken({
        label, userId, tenantId, projectId, tokenHash: `${suffix}-hash-${(n += 1)}`, tokenPrefix: `cpeer_${label}`, createdBy: userId,
      }))._id);
    tokenIds = {
      svcA: await mkToken('svc-in-a', people.svc.id, projects.a),
      svcB: await mkToken('svc-in-b', people.svc.id, projects.b),
      leadB: await mkToken('lead-in-b', people.lead.id, projects.b),
    };

    app = await createFastifyApiTestApp(tokensApiPlugin);
  });

  afterEach(async () => {
    // the audit rows of a revoke are written off the response path: let them land before the database goes
    await drainPendingTasks();
    await app.close();
  });

  it('is not edited by the lead of another project - and nothing says whether the token exists', async () => {
    const res = await edit('lead', tokenIds.svcB, 'reached across', projects.b);
    expect(res.statusCode).toBe(403);
    expect(await labelOf(tokenIds.svcB)).toBe('svc-in-b');
    // an id nobody has is told the same
    expect((await edit('lead', '0'.repeat(24), 'reached across', projects.b)).statusCode).toBe(403);
    expect((await edit('lead', 'not-an-id', 'reached across', projects.b)).statusCode).toBe(403);
  });

  it('is edited in the project the lead is in, and by an owner or an admin anywhere', async () => {
    expect((await edit('lead', tokenIds.svcA, 'renamed by the lead')).statusCode).toBe(200);
    expect(await labelOf(tokenIds.svcA)).toBe('renamed by the lead');
    expect((await edit('lead', tokenIds.svcA, 'renamed again', projects.a)).statusCode).toBe(200);

    for (const who of ['owner', 'admin'] as const) {
      const res = await edit(who, tokenIds.svcB, `renamed by ${who}`, projects.b);
      expect(res.statusCode, who).toBe(200);
      expect(await labelOf(tokenIds.svcB)).toBe(`renamed by ${who}`);
    }
  });

  it('is edited by the lead once they are in that project too', async () => {
    await db.runWithTenant!(tenantDbName, () =>
      db.upsertUserProject({ tenantId, userId: people.lead.id, projectId: projects.b, role: 'member' }));
    expect((await edit('lead', tokenIds.svcB, 'now in both', projects.b)).statusCode).toBe(200);
    expect(await labelOf(tokenIds.svcB)).toBe('now in both');
  });

  it('is the lead\'s own wherever it lives', async () => {
    expect((await edit('lead', tokenIds.leadB, 'my own key', projects.b)).statusCode).toBe(200);
    expect(await labelOf(tokenIds.leadB)).toBe('my own key');
  });

  it('is skipped when the lead revokes it - the token in their own project goes, and so does their own anywhere', async () => {
    const res = await revoke('lead', [tokenIds.svcB, tokenIds.svcA, tokenIds.leadB]);
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ revoked: number; skipped: number; results: Array<{ id: string; outcome: string; code?: string }> }>(res.body);
    expect(body).toMatchObject({ revoked: 2, skipped: 1 });
    expect(body.results.find((r) => r.id === tokenIds.svcB)).toMatchObject({ outcome: 'skipped', code: 'token_not_found' });
    expect(await exists(tokenIds.svcB)).toBe(true);
    expect(await exists(tokenIds.svcA)).toBe(false);
    expect(await exists(tokenIds.leadB)).toBe(false);
  });

  it('is revoked by an owner or an admin, whatever project it is in', async () => {
    const first = await revoke('admin', [tokenIds.svcB]);
    expect(parseJsonBody<{ revoked: number }>(first.body).revoked).toBe(1);
    const second = await revoke('owner', [tokenIds.svcA]);
    expect(parseJsonBody<{ revoked: number }>(second.body).revoked).toBe(1);
  });
});
