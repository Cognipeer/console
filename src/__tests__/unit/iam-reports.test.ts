/**
 * Reports in the policy engine: the `reports` service and the report resource (`Report::"<key>"`, `in` its
 * `ReportGroup`), with four actions the reports API (enterprise) asks.
 *
 *   the catalog   report.view / report.export are Read, report.view_all_projects / report.view_people are Admin; a report
 *                 has no create / edit / delete, a report group no action at all; all four are asked in the dashboard
 *                 and the API, and only where the overlay registered the report catalog
 *   the schema    a report sits under its group, so a rule can name a whole group
 *   the defaults  an ordinary member reads Reports (sees and downloads a report); only owners and administrators see a
 *                 report across all projects or its breakdowns that name people
 *   policies      a permit can give a group the people breakdowns of one report group; a forbid can take the download of
 *                 one report away; a member set to `none` on Reports sees none
 *   references    a policy may name a report or a group only if this build has it
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { registerIamReportCatalog, type IamReportFacts } from '@/enterprise/iam-reports';
import { RUNTIME_ENFORCED_ACTIONS, buildActionCatalog, withExtraResourceTypes } from '@/lib/iam/actions';
import { buildCatalog } from '@/lib/iam/catalog';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { buildEnforcePrincipal, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import type { IamPrincipal } from '@/lib/iam/entities';
import { compileSpecToCedar, parsePolicySpec, verifySpecReferences } from '@/lib/iam/policySpec';
import { validateCustomPolicyText } from '@/lib/iam/policyText';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { reportResource, REPORT_ACTIONS } from '@/lib/iam/reportEntities';
import { authorizeResourceForPrincipal, resetResourceAuthzThrottleForTests, type ResourceAuthzAction } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { enforcedChannelsOf } from '@/lib/iam/runtimeEnforced';
import { buildSchema } from '@/lib/iam/schema';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import { describeForEachProvider } from '../integration/db-parity.helper';

const REPORTS: IamReportFacts[] = [
  { key: 'cost-spend', title: 'Cost & Spend', group: 'usage', service: 'models' },
  { key: 'models', title: 'Model Operations', group: 'usage', service: 'models' },
  { key: 'agents', title: 'Agent Sessions', group: 'quality', service: 'tracing' },
  { key: 'overview', title: 'Overview', group: null, service: 'models' },
];
const useCatalog = () => registerIamReportCatalog(() => REPORTS);

describe('reports in the catalog and the schema', () => {
  afterEach(() => registerIamReportCatalog(null));

  it('has four report actions: view and export at Read, all projects and people at Admin; no CRUD, nothing on a group', () => {
    const catalog = buildActionCatalog(withExtraResourceTypes([]));
    const report = catalog.filter((a) => a.resourceType === 'report').map((a) => [a.id, a.level, a.service]);
    expect(report).toEqual([
      ['report.view', 'read', 'reports'],
      ['report.export', 'read', 'reports'],
      ['report.view_all_projects', 'admin', 'reports'],
      ['report.view_people', 'admin', 'reports'],
    ]);
    expect(catalog.some((a) => a.resourceType === 'report-group')).toBe(false);
    for (const id of Object.values(REPORT_ACTIONS)) expect(RUNTIME_ENFORCED_ACTIONS[id]).toEqual(['dashboard', 'api']);
  });

  it('puts a report under its group, and lets a policy name the group', () => {
    const built = buildSchema(withExtraResourceTypes([]));
    const types = (built.schema as unknown as Record<string, { entityTypes: Record<string, { memberOfTypes?: string[] }> }>)[''].entityTypes;
    expect(types.ReportGroup).toBeDefined();
    expect(types.Report.memberOfTypes).toEqual(expect.arrayContaining(['Project', 'ReportGroup']));
    expect(built.resourceEntityTypes['report-group']).toBe('ReportGroup');
  });

  it('builds the resource of a report: in its group, and in the project it is viewed for', () => {
    expect(reportResource({ key: 'cost-spend', group: 'usage', projectId: 'p1' })).toMatchObject({
      kind: 'resource', type: 'report', id: 'cost-spend', service: 'reports', projectId: 'p1',
      parents: [{ type: 'ReportGroup', id: 'usage' }],
    });
    const overview = reportResource({ key: 'overview', group: null });
    expect(overview).toMatchObject({ projectId: null });
    expect('parents' in overview && overview.parents).toBeFalsy();
  });

  it('asks the report actions only where the overlay registered the report catalog', () => {
    expect(enforcedChannelsOf('report.view')).toEqual([]);
    useCatalog();
    expect(enforcedChannelsOf('report.view')).toEqual(['dashboard', 'api']);
    expect(enforcedChannelsOf('report.view_people')).toEqual(['dashboard', 'api']);
  });

  it('offers reports in the editor catalog only where there are reports', () => {
    const without = buildCatalog();
    expect(without.reports).toEqual([]);
    expect(without.resourceTypes.some((t) => t.type === 'report' || t.type === 'report-group')).toBe(false);
    expect(without.actions.some((a) => a.resourceType === 'report')).toBe(false);
    expect(without.services.some((s) => s.id === 'reports')).toBe(true);

    useCatalog();
    const withReports = buildCatalog();
    expect(withReports.reports.map((r) => r.key)).toEqual(['cost-spend', 'models', 'agents', 'overview']);
    expect(withReports.resourceTypes.map((t) => t.type)).toEqual(expect.arrayContaining(['report', 'report-group']));
    expect(withReports.actions.find((a) => a.id === 'report.view_people')).toMatchObject({ level: 'admin', enforcedIn: ['dashboard', 'api'] });
  });

  it('compiles a rule about a report group to `resource in ReportGroup`', () => {
    useCatalog();
    const parsed = parsePolicySpec({
      effect: 'permit',
      principals: { anyUser: true },
      actions: ['report.view_people'],
      resources: { resources: [{ type: 'report-group', id: 'usage' }, { type: 'report', id: 'agents' }] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cedar = compileSpecToCedar(parsed.spec);
    expect(cedar).toContain('ReportGroup::"usage"');
    expect(cedar).toContain('Report::"agents"');
  });

  it('takes a deny rule written about a report as text only where this build has reports', () => {
    const text = 'forbid (principal, action == Action::"report.export", resource in ReportGroup::"usage");';
    const without = validateCustomPolicyText(text);
    expect(without.valid).toBe(false);
    expect(without.errors[0]?.message).toContain('the request gates do not check');

    useCatalog();
    expect(validateCustomPolicyText(text)).toMatchObject({ valid: true, errors: [] });
  });

  it('accepts a named report or group only if this build has it', async () => {
    const tenant = { tenantDbName: 'tenant_x', tenantId: 't1' };
    const spec = (resources: Array<{ type: string; id: string }>) => ({
      effect: 'forbid' as const,
      principals: { any: true as const },
      actions: ['report.export'],
      resources: { resources },
    });
    // Community: no reports at all.
    expect(await verifySpecReferences(spec([{ type: 'report', id: 'cost-spend' }]), tenant)).toHaveLength(1);

    useCatalog();
    expect(await verifySpecReferences(spec([{ type: 'report', id: 'cost-spend' }, { type: 'report-group', id: 'usage' }]), tenant)).toEqual([]);
    const issues = await verifySpecReferences(spec([
      { type: 'report', id: 'no-such-report' },
      { type: 'report-group', id: 'safety' }, // a known heading, but no report of this build sits under it
      { type: 'report-group', id: 'nonsense' },
    ]), tenant);
    expect(issues.map((i) => i.message)).toEqual([
      'The report "no-such-report" does not exist in this workspace',
      'The report-group "safety" does not exist in this workspace',
      'The report-group "nonsense" does not exist in this workspace',
    ]);
  });
});

describeForEachProvider('report actions in the engine', (getDb) => {
  let db: DatabaseProvider;
  let dbName = '';
  let tenantId = '';
  let projectId = '';
  let financeGroupId = '';
  const users: Record<string, IUser> = {};
  const idOf = (key: string) => String(users[key]._id);

  async function principalOf(who: string): Promise<IamPrincipal> {
    return db.runWithTenant!(dbName, () => buildEnforcePrincipal({
      subject: 'session',
      tenantDbName: dbName,
      tenantId,
      requestId: 'req-1',
      method: 'GET',
      route: '/reports/dashboards/:key',
      userId: idOf(who),
      user: users[who],
      requestedProjectId: projectId,
      projectFromPath: false,
      service: 'reports',
    }));
  }

  async function ask(who: string, action: ResourceAuthzAction, key: string) {
    const report = REPORTS.find((r) => r.key === key)!;
    return authorizeResourceForPrincipal({
      tenantDbName: dbName,
      tenantId,
      userId: idOf(who),
      principal: await principalOf(who),
      channel: 'dashboard',
      action,
      resource: reportResource({ key, group: report.group, projectId }),
      subject: { resourceName: report.title },
      client: { ip: '203.0.113.9', requestId: 'req-1', userAgent: 'vitest', method: 'GET', path: `/api/reports/dashboards/${key}` },
      quiet: true,
    });
  }

  async function withPolicy(policyId: string, cedar: string): Promise<void> {
    await createPolicy(dbName, { policyId, name: policyId, cedar }, 'tester');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetPrincipalCacheForTests();
  }

  beforeAll(async () => {
    useCatalog();
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Reports', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        users[key] = await db.createUser({ tenantId, email: `${key}@rep.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra } as never);
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      await mk('member', 'user');
      await mk('analyst', 'user');
      await mk('blocked', 'user', { servicePermissions: { reports: 'none' } });
      projectId = String((await db.createProject({ tenantId, key: 'pj1', name: 'Project One', createdBy: 'x' }))._id);
      for (const who of ['member', 'analyst', 'blocked']) {
        await db.upsertUserProject({ tenantId, userId: idOf(who), projectId, role: 'member' } as never);
      }
      const group = await db.createGroup({ tenantId, name: 'Finance', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      financeGroupId = String((group as { _id: unknown })._id);
      await db.addGroupMember({ groupId: financeGroupId, userId: idOf('analyst'), tenantId, role: 'member' } as never);
    });
  });
  afterAll(async () => {
    registerIamReportCatalog(null);
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

  it('gives owners and administrators every report action', async () => {
    for (const who of ['owner', 'admin']) {
      for (const action of Object.values(REPORT_ACTIONS) as ResourceAuthzAction[]) {
        expect((await ask(who, action, 'cost-spend')).allowed, `${who} ${action}`).toBe(true);
      }
    }
  });

  it('lets an ordinary member see and download a report, not across all projects and not the people breakdowns', async () => {
    expect((await ask('member', 'report.view', 'cost-spend')).allowed).toBe(true);
    expect((await ask('member', 'report.export', 'cost-spend')).allowed).toBe(true);
    expect((await ask('member', 'report.view_all_projects', 'cost-spend')).allowed).toBe(false);
    expect((await ask('member', 'report.view_people', 'cost-spend')).allowed).toBe(false);
  });

  it('shows nothing to a member set to none on Reports', async () => {
    expect((await ask('blocked', 'report.view', 'cost-spend')).allowed).toBe(false);
    expect((await ask('blocked', 'report.export', 'agents')).allowed).toBe(false);
  });

  it('lets a policy give a group the people breakdowns of one report group (today\'s reports and later ones)', async () => {
    await withPolicy('finance-people',
      `permit (principal in Group::"${financeGroupId}", action == Action::"report.view_people", resource in ReportGroup::"usage");`);
    expect((await ask('analyst', 'report.view_people', 'cost-spend')).allowed).toBe(true);
    expect((await ask('analyst', 'report.view_people', 'models')).allowed).toBe(true);
    expect((await ask('analyst', 'report.view_people', 'agents')).allowed).toBe(false);
    expect((await ask('member', 'report.view_people', 'cost-spend')).allowed).toBe(false);
  });

  it('lets a policy take the download of one report away, even from an administrator', async () => {
    await withPolicy('no-cost-csv', 'forbid (principal, action == Action::"report.export", resource == Report::"cost-spend");');
    expect((await ask('admin', 'report.export', 'cost-spend')).allowed).toBe(false);
    expect((await ask('admin', 'report.view', 'cost-spend')).allowed).toBe(true);
    expect((await ask('admin', 'report.export', 'agents')).allowed).toBe(true);
  });
});
