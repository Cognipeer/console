/**
 * Two tenants served at the same time through the catalog services (prompts,
 * config, projects, audit), on the real data layer of both providers.
 *
 * The services open their own tenant scope. Two properties pin that, both
 * deterministic:
 *  - they never move the shared handle (`switchToTenant`), which a concurrent
 *    request for another tenant could overwrite between a switch and a query;
 *  - each call lands in its own tenant even when it runs inside an enclosing
 *    scope bound to the other tenant.
 * Reverting any of these services to a bare `switchToTenant` fails the first.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn(async () => dbRef.current),
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = dbRef.current as any;
      return db.runWithTenant ? db.runWithTenant(tenantDbName, () => fn(db)) : fn(db);
    },
  };
});

import { createPrompt, getPromptByKey, listPrompts } from '@/lib/services/prompts/promptService';
import { createConfigGroup, listConfigGroups } from '@/lib/services/config/configService';
import { ensureDefaultProject, listAccessibleProjects } from '@/lib/services/projects/projectService';
import { listAuditLogs, recordAuditLog } from '@/lib/services/audit/auditService';

interface TenantFixture {
  name: 'alpha' | 'beta';
  tenantId: string;
  tenantDbName: string;
  projectId: string;
}

describeForEachProvider('Catalog services under concurrent tenants', (getDb) => {
  let db: DatabaseProvider;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  async function seedTenant(name: TenantFixture['name']): Promise<TenantFixture> {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tenantDbName = `tenant_catalog_${name}_${suffix}`;
    const tenant = await db.createTenant({
      companyName: name,
      slug: `${name}-${suffix}`,
      dbName: tenantDbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    const tenantId = String(tenant._id);
    const project = await ensureDefaultProject(tenantDbName, tenantId, 'seed');
    return { name, tenantId, tenantDbName, projectId: String(project._id) };
  }

  beforeEach(async () => {
    db = getDb();
    dbRef.current = db;
    alpha = await seedTenant('alpha');
    beta = await seedTenant('beta');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function work(t: TenantFixture) {
    await createPrompt(t.tenantDbName, t.tenantId, t.projectId, 'u1', {
      name: `${t.name} prompt`,
      key: `${t.name}-prompt`,
      template: `hello from ${t.name}`,
    });
    await createConfigGroup(t.tenantDbName, t.tenantId, t.projectId, {
      name: `${t.name} group`,
      key: `${t.name}-group`,
      createdBy: 'u1',
    });
    await recordAuditLog(
      { tenantDbName: t.tenantDbName, tenantId: t.tenantId },
      {
        action: 'write',
        actorType: 'user',
        event: `POST /${t.name}`,
        method: 'POST',
        outcome: 'success',
        path: `/${t.name}`,
        service: 'prompts',
        statusCode: 201,
      },
    );

    const [prompts, byKey, groups, projects, audit] = await Promise.all([
      listPrompts(t.tenantDbName, t.projectId),
      getPromptByKey(t.tenantDbName, t.projectId, `${t.name}-prompt`),
      listConfigGroups(t.tenantDbName, t.tenantId, t.projectId),
      listAccessibleProjects(t.tenantDbName, t.tenantId, { role: 'owner', projectIds: [] }),
      listAuditLogs({ tenantDbName: t.tenantDbName, tenantId: t.tenantId }),
    ]);
    return { prompts, byKey, groups, projects, audit };
  }

  function expectOwnData(fixture: TenantFixture, result: Awaited<ReturnType<typeof work>>) {
    expect(result.prompts.map((p) => p.key)).toEqual([`${fixture.name}-prompt`]);
    expect(result.byKey?.template).toBe(`hello from ${fixture.name}`);
    expect(result.groups.map((g) => g.key)).toEqual([`${fixture.name}-group`]);
    expect(result.projects.map((p) => String(p._id))).toEqual([fixture.projectId]);
    expect(result.audit.map((row) => row.path)).toEqual([`/${fixture.name}`]);
  }

  it('keeps each tenant on its own data while their calls interleave, without moving the shared handle', async () => {
    const switches = vi.spyOn(db, 'switchToTenant');
    const [a, b] = await Promise.all([work(alpha), work(beta)]);
    expect(switches).not.toHaveBeenCalled();
    expectOwnData(alpha, a);
    expectOwnData(beta, b);
  });

  it('lands each call in its own tenant inside an enclosing scope bound to the other tenant', async () => {
    const enclosing = <T>(tenantDbName: string, fn: () => Promise<T>): Promise<T> =>
      (db as unknown as { runWithTenant: (name: string, run: () => Promise<T>) => Promise<T> }).runWithTenant(tenantDbName, fn);
    const switches = vi.spyOn(db, 'switchToTenant');
    const [a, b] = await Promise.all([
      enclosing(beta.tenantDbName, () => work(alpha)),
      enclosing(alpha.tenantDbName, () => work(beta)),
    ]);
    expect(switches).not.toHaveBeenCalled();
    expectOwnData(alpha, a);
    expectOwnData(beta, b);
  });
});
