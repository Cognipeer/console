/**
 * The report of the pre-upgrade access tool (scripts/iam/preflight-diff.ts):
 * folding decisions into causes, totals, the Markdown and the summary-only form.
 * The inputs are hand-made observations; nothing here opens a database.
 */
import { describe, expect, it } from 'vitest';
import {
  TenantAccumulator,
  type ContextObservation,
  type PrincipalInfo,
  type ServiceObservation,
} from '../../../scripts/iam/preflight/accumulate';
import { accessScenarios } from '../../../scripts/iam/preflight/access';
import { buildCensus } from '../../../scripts/iam/preflight/census';
import type { Cause, Checks } from '../../../scripts/iam/preflight/model';
import { renderMarkdown, renderSummary } from '../../../scripts/iam/preflight/render';
import { REPORT_VERSION, buildTotals, integrityProblem, type PreflightReport, type TenantReport } from '../../../scripts/iam/preflight/report';
import { stripLists } from '../../../scripts/iam/preflight/run';

const checks = (level: 'none' | 'read' | 'write' | 'admin'): Checks => ({
  read: level !== 'none',
  write: level === 'write' || level === 'admin',
  admin: level === 'admin',
});

const service = (
  id: string,
  before: 'none' | 'read' | 'write' | 'admin',
  after: 'none' | 'read' | 'write' | 'admin',
  cause?: Cause,
  deferred?: 'none' | 'read' | 'write' | 'admin',
): ServiceObservation => {
  const b = checks(before);
  const a = checks(after);
  const causes: ServiceObservation['causes'] = {};
  for (const check of ['read', 'write', 'admin'] as const) {
    if (b[check] !== a[check]) causes[check] = cause ?? 'project-narrowing';
  }
  return { service: id, adminService: false, before: b, after: a, causes, ...(deferred ? { deferred: checks(deferred) } : {}) };
};

const person = (label: string, role = 'user'): PrincipalInfo => ({ key: `u:${label}`, label: `user:${label}`, kind: 'user', role });
const token = (label: string, owner: string): PrincipalInfo => ({ key: `t:${label}`, label: `token:${label}`, kind: 'token', role: 'user', owner: `user:${owner}` });
const context = (principal: PrincipalInfo, projectLabel: string, services: ServiceObservation[]): ContextObservation => ({ principal, projectLabel, services });

describe('TenantAccumulator', () => {
  it('counts unchanged answers and lists nobody', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    acc.addContext(context(person('alice'), 'Alpha', [service('models', 'write', 'write'), service('prompts', 'read', 'read')]));
    const out = acc.finish();
    expect(out).toMatchObject({ contexts: 1, decisions: 6, same: 6, differs: 0, tighten: 0, loosen: 0, principalChanges: [] });
    expect(out.byCause).toEqual({});
  });

  it('reports a project level that lowers a service, once per project', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    const alice = person('alice');
    acc.addContext(context(alice, 'Alpha', [service('models', 'write', 'read')]));
    acc.addContext(context(alice, 'Beta', [service('models', 'write', 'read')]));
    acc.addContext(context(person('bob'), 'Alpha', [service('models', 'write', 'write')]));
    const out = acc.finish();
    expect(out.differs).toBe(2); // the write check, in two contexts
    expect(out.tighten).toBe(2);
    expect(out.byCause['project-narrowing']).toMatchObject({ decisions: 2, principals: 1, principalServicePairs: 1, services: ['models'] });
    expect(out.principalChanges).toEqual([
      {
        principal: 'user:alice',
        kind: 'user',
        role: 'user',
        causes: ['project-narrowing'],
        changes: [{ service: 'models', before: 'write', after: 'read', direction: 'tighten', cause: 'project-narrowing', projects: ['Alpha', 'Beta'] }],
      },
    ]);
    expect(out.principalsChanged).toEqual({ users: 1, tokens: 0 });
    expect(out.serviceChanges).toBe(2);
    expect(out.byProject.Alpha).toMatchObject({ principals: 1, services: 1, tighten: 1, loosen: 0 });
    expect(out.byService.models).toMatchObject({ principals: 1, projects: 2 });
  });

  it('reports a token that gains its owner\'s group grants', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    acc.addContext(context(token('ci', 'alice'), 'Alpha', [service('audit', 'none', 'admin', 'token-groups'), service('models', 'write', 'write')]));
    const out = acc.finish();
    expect(out.loosen).toBe(3);
    expect(out.byCause['token-groups']).toMatchObject({ decisions: 3, loosen: 3, principals: 1 });
    expect(out.principalChanges[0]).toMatchObject({ kind: 'token', owner: 'user:alice', changes: [{ service: 'audit', before: 'none', after: 'admin', direction: 'loosen' }] });
    expect(out.principalsChanged).toEqual({ users: 0, tokens: 1 });
  });

  it('merges two causes on one service into a combined one', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    const s = service('rag', 'write', 'read');
    s.before = checks('write');
    s.after = { read: true, write: false, admin: true }; // read unchanged, write lowered, admin raised
    s.causes = { write: 'project-narrowing', admin: 'token-groups' };
    acc.addContext(context(token('mixed', 'alice'), 'Alpha', [s]));
    const change = acc.finish().principalChanges[0].changes[0];
    expect(change.cause).toBe('token-groups+project-narrowing');
  });

  it('counts a "masked" answer as unchanged', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    const s = service('rag', 'write', 'write');
    s.causes = { write: 'masked' };
    acc.addContext(context(token('cancels', 'alice'), 'Alpha', [s]));
    const out = acc.finish();
    expect(out).toMatchObject({ masked: 1, same: 2, differs: 0, principalChanges: [] });
  });

  it('keeps "No access" entries that are ignored today as a deferred change, not as a day-one one', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    acc.addContext(context(person('carol'), 'Beta', [service('models', 'write', 'write', undefined, 'none'), service('prompts', 'write', 'write', undefined, 'write')]));
    const out = acc.finish();
    expect(out.differs).toBe(0);
    expect(out.deferred).toMatchObject({ principals: 1, entries: 1 });
    expect(out.deferred.list[0].changes).toEqual([{ service: 'models', from: 'write', to: 'none', projects: ['Beta'] }]);
  });

  it('lists who loses a surface that now checks a permission', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    acc.addContext(context(person('dave'), 'Alpha', [service('models', 'write', 'none'), service('agents', 'write', 'write')]));
    acc.addContext(context(person('erin'), 'Alpha', [service('models', 'write', 'write'), service('agents', 'write', 'read')]));
    // a token never reaches the dashboard's surfaces
    acc.addContext(context(token('t', 'dave'), 'Alpha', [service('models', 'write', 'none')]));
    const out = acc.finish();
    const playground = out.newlyGated.find((s) => s.id === 'model-playgrounds')!;
    expect(playground.count).toBe(1);
    expect(playground.principals).toEqual([{ principal: 'user:dave', role: 'user', projects: ['Alpha'] }]);
    const skillsWrite = out.newlyGated.find((s) => s.id === 'skills-write')!;
    expect(skillsWrite.principals.map((p) => p.principal)).toEqual(['user:erin']);
    expect(out.newlyGated.find((s) => s.id === 'skills-read')!.count).toBe(0);
  });

  it('counts integrity problems and keeps a few examples', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    const bad = service('models', 'write', 'write');
    bad.causes = { read: 'parity-mismatch', write: 'unexplained' };
    acc.addContext(context(person('zed'), 'Alpha', [bad]));
    for (let i = 0; i < 15; i++) {
      acc.recordOracleMismatch({ principal: 'user:zed', project: 'Alpha', service: `svc${i}`, check: 'read', engine: true, independent: false });
    }
    acc.recordEngineFailures(2);
    const out = acc.finish();
    expect(out.integrity).toEqual({ engineFailures: 2, oracleMismatches: 15, parityMismatches: 1, unexplained: 1 });
    expect(out.integrityExamples).toHaveLength(10);
    expect(integrityProblem(out.integrity)).toBe(true);
  });

  it('never calls an unattributed difference the engine\'s fault when custom policies exist', () => {
    const plain = new TenantAccumulator({ customPolicies: false });
    const custom = new TenantAccumulator({ customPolicies: true });
    const s = (): ServiceObservation => ({ service: 'models', adminService: false, before: checks('write'), after: checks('read'), causes: {} });
    plain.addContext(context(person('a'), 'P', [s()]));
    custom.addContext(context(person('a'), 'P', [s()]));
    expect(plain.finish().byCause.unexplained?.decisions).toBe(1);
    expect(custom.finish().byCause['custom-policies']?.decisions).toBe(1);
    expect(custom.finish().integrity.unexplained).toBe(0);
  });

  it('records project access scenarios and keeps only the ones that differ', () => {
    const acc = new TenantAccumulator({ customPolicies: false });
    const labels = new Map([['p1', 'Alpha']]);
    const labelOf = (id: string | null) => (id ? labels.get(id) ?? id : '(none)');
    acc.addAccess(
      { label: 'user:gina', role: 'user' },
      accessScenarios({ rows: { legacyProjectIds: [], directProjectIds: [], groupProjectIds: ['p1'] }, defaultProjectId: 'p1', existingProjectIds: new Set(['p1']) }),
      labelOf,
    );
    acc.addAccess(
      { label: 'user:hal', role: 'user' },
      accessScenarios({ rows: { legacyProjectIds: ['p1'], directProjectIds: [], groupProjectIds: [] }, defaultProjectId: 'p1', existingProjectIds: new Set(['p1']) }),
      labelOf,
    );
    const access = acc.accessReport();
    expect(access.members).toBe(2);
    expect(access.summary['gains-project-access']).toBe(2);
    expect(access.summary.same).toBe(2);
    expect(access.changes).toHaveLength(1);
    expect(access.changes[0].scenarios[0]).toMatchObject({ cookie: '(none)', before: '403 No project assigned', after: 'Alpha', change: 'gains-project-access' });
  });
});

function tenantReport(slug: string, acc: TenantAccumulator): TenantReport {
  const aggregate = acc.finish();
  const census = buildCensus(
    { users: [], projects: [], groups: [], groupIdsByUser: new Map(), userProjects: new Map(), groupProjects: new Map(), tokens: [], defaultProjectId: null },
    0,
    0,
  );
  return {
    slug,
    dbName: `tenant_${slug}`,
    activation: { since: '2026-10-10T00:00:00.000Z', origin: 'run-time' },
    customPolicies: { inForce: 0, skipped: 0 },
    principals: { users: 2, tokens: 1, totalUsers: 2, totalTokens: 1, truncated: false, skipped: [] },
    ...aggregate,
    projectAccess: acc.accessReport(),
    census,
  };
}

function sampleReport(): PreflightReport {
  const acc = new TenantAccumulator({ customPolicies: false });
  for (let i = 0; i < 4; i++) acc.addContext(context(person(`member${i}`), 'Alpha', [service('models', 'write', 'read')]));
  acc.addContext(context(token('ci', 'member0'), 'Alpha', [service('audit', 'none', 'admin', 'token-groups')]));
  acc.addContext(context(person('nina'), 'Alpha', [service('models', 'write', 'none')]));
  acc.recordScopedToken('token:ci', 'user:member0');
  const tenants = [tenantReport('acme', acc), tenantReport('globex', new TenantAccumulator({ customPolicies: false }))];
  return {
    reportVersion: REPORT_VERSION,
    generatedAt: '2026-10-10T00:00:00.000Z',
    source: { provider: 'sqlite', location: 'copy of /data/sqlite' },
    redacted: false,
    options: { tenants: [], maxPrincipals: null, verifyAll: false, noMemo: false, summaryOnly: false },
    services: { compared: 39, addedWithEngine: ['portals', 'resources', 'iam'] },
    totals: buildTotals(tenants),
    tenants,
  };
}

describe('report totals and rendering', () => {
  it('adds the workspaces up', () => {
    const report = sampleReport();
    expect(report.totals.tenants).toBe(2);
    expect(report.totals.differs).toBe(report.tenants[0].differs);
    expect(report.totals.byCause['project-narrowing']?.principals).toBe(5);
    expect(report.totals.byCause['token-groups']?.loosen).toBe(3);
    expect(report.totals.scopedTokens).toBe(1);
    expect(report.totals.newlyGated.find((s) => s.id === 'model-playgrounds')?.principals).toBe(1);
    expect(integrityProblem(report.totals.integrity)).toBe(false);
  });

  it('renders the causes, the lists and the surfaces', () => {
    const md = renderMarkdown(sampleReport(), 100);
    expect(md).toContain('# Access changes when the policy engine takes over');
    expect(md).toContain('## Workspace acme');
    expect(md).toContain('## Workspace globex');
    expect(md).toContain('Project permissions now apply');
    expect(md).toContain('models: write -> read (loses) in Alpha');
    expect(md).toContain('audit: none -> admin (gains) in Alpha');
    expect(md).toContain('1 person loses it');
    expect(md).toContain('Tenant-wide metrics export');
    expect(md).toContain('No person or token gets a different answer'); // globex
    expect(md).toContain('Integrity: the engine agrees');
  });

  it('cuts long lists at the limit and says where the rest is', () => {
    const md = renderMarkdown(sampleReport(), 2);
    expect(md).toMatch(/\.\.\. 3 more \(the JSON file lists all\)/);
  });

  it('prints a short summary for the terminal', () => {
    const text = renderSummary(sampleReport());
    expect(text).toContain('Workspaces 2');
    expect(text).toContain('Project permissions now apply');
    expect(text).toContain('Integrity: the engine agrees');
  });

  it('warns loudly when the engine disagrees with the rules it is checked against', () => {
    const report = sampleReport();
    report.totals.integrity.oracleMismatches = 1;
    expect(renderMarkdown(report, 10)).toContain('INTEGRITY PROBLEM');
    expect(renderSummary(report)).toContain('Do not rely on this report');
  });

  it('keeps the counts when the per-person lists are left out', () => {
    const full = sampleReport();
    const stripped = stripLists(full);
    expect(stripped.tenants[0].principalChanges).toEqual([]);
    expect(stripped.totals).toEqual(full.totals);
    expect(stripped.tenants[0].newlyGated.find((s) => s.id === 'model-playgrounds')).toMatchObject({ count: 1, principals: [] });
    expect(stripped.tenants[0].metricsExport).toMatchObject({ count: 1, tokens: [] });
    const md = renderMarkdown(stripped, 100);
    expect(md).toContain('per-person lists are not part of this report');
    expect(md).toContain('1 person loses it');
  });
});
