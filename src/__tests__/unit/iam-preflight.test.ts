/**
 * The rules of the pre-upgrade access report (scripts/iam/preflight-diff.ts):
 * command line and data-source safety, the previous release's answers, project
 * access, the independent arithmetic, causes, sampling order and redaction.
 * Pure parts only; the report that is built from them is iam-preflight-report.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPermissionServiceForPath, RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import {
  accessScenarios,
  accessibleProjectIds,
  compareAccess,
  resolveAccess,
} from '../../../scripts/iam/preflight/access';
import { previousAnswers } from '../../../scripts/iam/preflight/before';
import { buildCensus, grantsOfUser } from '../../../scripts/iam/preflight/census';
import type { TenantData } from '../../../scripts/iam/preflight/data';
import {
  addedServices,
  classifyCheck,
  comparedServices,
  directionOf,
  directionOfLevels,
  levelOfChecks,
  mergeCauses,
} from '../../../scripts/iam/preflight/model';
import { orderTokensForSampling, orderUsersForSampling } from '../../../scripts/iam/preflight/order';
import {
  UsageError,
  assertMongoTargetAllowed,
  describeMongoUri,
  isLocalMongoUri,
  mongoHosts,
  parseOptions,
} from '../../../scripts/iam/preflight/options';
import {
  highestPerService,
  ignoredNoneEntries,
  isNeverNarrowed,
  oracleChecks,
  oracleMembership,
  rowLevels,
  savedBefore,
  type OracleInput,
} from '../../../scripts/iam/preflight/oracle';
import { DecisionMemo, decisionSignature, type SignedPrincipal } from '../../../scripts/iam/preflight/memo';
import { makeRedactor, tokenLabel, userLabel } from '../../../scripts/iam/preflight/redact';
import { prepareEnvironment } from '../../../scripts/iam/preflight/run';
import { NEWLY_GATED_SURFACES, surfaceAllowed } from '../../../scripts/iam/preflight/surfaces';

const T0 = Date.parse('2026-10-10T00:00:00Z');
const OLD = new Date('2026-09-01T00:00:00Z');
const NEW = new Date('2026-10-11T00:00:00Z');

describe('preflight options', () => {
  const sqlite = ['--sqlite-dir', '/data/copy'];

  it('needs an explicit data source and never reads the ambient database settings', () => {
    expect(() => parseOptions([], {})).toThrow(UsageError);
    expect(() => parseOptions([], { SQLITE_DATA_DIR: '/live/data', MONGODB_URI: 'mongodb://127.0.0.1/x' })).toThrow(/Name the data to read/);
    expect(() => parseOptions([...sqlite, '--mongodb-uri', 'mongodb://127.0.0.1'], {})).toThrow(/not both/);
  });

  it('reads flags, "--flag=value" and the IAM_PREFLIGHT_* environment', () => {
    const o = parseOptions([...sqlite, '--tenants=acme, globex', '--max-principals', '25', '--redact', '--since', '2026-10-12T09:00:00Z'], {}, '/work');
    expect(o.source).toMatchObject({ kind: 'sqlite', dir: '/data/copy', mainDbName: 'console_main', copy: true });
    expect(o.tenants).toEqual(['acme', 'globex']);
    expect(o.maxPrincipals).toBe(25);
    expect(o.redact).toBe(true);
    expect(o.since).toBe(Date.parse('2026-10-12T09:00:00Z'));
    expect(o.out).toBe('/work/iam-preflight-report');

    const fromEnv = parseOptions([], { IAM_PREFLIGHT_SQLITE_DIR: '/e/data', IAM_PREFLIGHT_NO_COPY: '1', IAM_PREFLIGHT_OUT: 'reports/pre.json', IAM_PREFLIGHT_MAX_LISTED: '10' }, '/work');
    expect(fromEnv.source).toMatchObject({ dir: '/e/data', copy: false });
    expect(fromEnv.out).toBe('/work/reports/pre');
    expect(fromEnv.maxListed).toBe(10);
  });

  it('rejects bad numbers, dates and unknown flags', () => {
    expect(() => parseOptions([...sqlite, '--max-principals', '0'], {})).toThrow(/positive whole number/);
    expect(() => parseOptions([...sqlite, '--max-listed', 'many'], {})).toThrow(/positive whole number/);
    expect(() => parseOptions([...sqlite, '--since', 'yesterday'], {})).toThrow(/ISO 8601/);
    expect(() => parseOptions([...sqlite, '--bogus'], {})).toThrow(/Unknown option/);
    expect(() => parseOptions([...sqlite, '--tenants'], {})).toThrow(/expects a value/);
    expect(() => parseOptions(['--mongodb-uri', 'mongodb://127.0.0.1', '--no-copy'], {})).toThrow(/SQLite only/);
  });

  it('answers --help without a data source', () => {
    expect(parseOptions(['--help'], {}).help).toBe(true);
  });

  it('keeps the diagnostics switches off by default', () => {
    const o = parseOptions(sqlite, {});
    expect(o).toMatchObject({ verifyAll: false, noMemo: false, summaryOnly: false, failOnDifferences: false, redact: false, dump: null, maxPrincipals: null, since: null });
    const on = parseOptions([...sqlite, '--verify-all', '--no-memo', '--summary-only', '--fail-on-differences', '--dump', 'd.jsonl'], {}, '/w');
    expect(on).toMatchObject({ verifyAll: true, noMemo: true, summaryOnly: true, failOnDifferences: true, dump: '/w/d.jsonl' });
  });

  describe('MongoDB target safety', () => {
    it('lists every host of a seed list', () => {
      expect(mongoHosts('mongodb://user:pw@a.example:27017,b.example:27018/db?replicaSet=rs')).toEqual(['a.example', 'b.example']);
      expect(mongoHosts('mongodb://[::1]:27017/db')).toEqual(['::1']);
      expect(mongoHosts('not a uri')).toEqual([]);
    });

    it('accepts this machine only', () => {
      expect(isLocalMongoUri('mongodb://localhost:27017')).toBe(true);
      expect(isLocalMongoUri('mongodb://127.0.0.1:27633/seed')).toBe(true);
      expect(isLocalMongoUri('mongodb://[::1]:27017')).toBe(true);
      expect(isLocalMongoUri('mongodb://localhost,prod-replica.example.net/db')).toBe(false);
      expect(isLocalMongoUri('mongodb://cluster.example.net')).toBe(false);
      expect(isLocalMongoUri('mongodb+srv://localhost/db')).toBe(false);
      expect(isLocalMongoUri('')).toBe(false);
    });

    it('refuses other hosts unless IAM_PREFLIGHT_ALLOW_REMOTE=1', () => {
      const uri = 'mongodb://admin:secret@db.corp.example:27017/console';
      expect(() => assertMongoTargetAllowed(uri, {})).toThrow(/Refusing to connect to mongodb:\/\/db\.corp\.example/);
      expect(() => parseOptions(['--mongodb-uri', uri], {})).toThrow(UsageError);
      expect(() => assertMongoTargetAllowed(uri, { IAM_PREFLIGHT_ALLOW_REMOTE: '1' })).not.toThrow();
      expect(() => assertMongoTargetAllowed(uri, { IAM_PREFLIGHT_ALLOW_REMOTE: '0' })).toThrow();
      expect(() => assertMongoTargetAllowed('mongodb://127.0.0.1:27017', {})).not.toThrow();
    });

    it('never prints credentials', () => {
      const message = (() => {
        try {
          assertMongoTargetAllowed('mongodb://admin:secret@db.corp.example:27017/console', {});
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(message).not.toContain('secret');
      expect(message).not.toContain('admin');
      expect(describeMongoUri('mongodb://admin:secret@db.corp.example:27017/console?x=1')).toBe('mongodb://db.corp.example');
    });
  });
});

describe('levels, causes and directions', () => {
  it('reads a level from the three answers', () => {
    expect(levelOfChecks({ read: false, write: false, admin: false })).toBe('none');
    expect(levelOfChecks({ read: true, write: false, admin: false })).toBe('read');
    expect(levelOfChecks({ read: true, write: true, admin: false })).toBe('write');
    expect(levelOfChecks({ read: true, write: true, admin: true })).toBe('admin');
    // a write that is allowed without a read is not a level: the chain stops at the first "no"
    expect(levelOfChecks({ read: false, write: true, admin: true })).toBe('none');
  });

  it('knows which way an answer moved', () => {
    expect(directionOf(true, false)).toBe('tighten');
    expect(directionOf(false, true)).toBe('loosen');
    expect(directionOf(true, true)).toBe('none');
    expect(directionOfLevels('write', 'read')).toBe('tighten');
    expect(directionOfLevels('none', 'admin')).toBe('loosen');
    expect(directionOfLevels('read', 'read')).toBe('none');
  });

  it('attributes a difference to the rule that moved it', () => {
    const attribution = (previous: boolean, noProject: boolean, ownerGroups: boolean) => ({
      engineWithPreviousInputs: previous,
      engineWithoutProjectLevels: noProject,
      arithmeticWithOwnerGroups: ownerGroups,
    });
    const base = { customPolicies: false };
    // the engine matches the previous rules, and a project level lowers the answer
    expect(classifyCheck({ ...base, before: true, after: false, attribution: attribution(true, true, true) })).toBe('project-narrowing');
    // a token's owner group raises the answer, nothing else moves it
    expect(classifyCheck({ ...base, before: false, after: true, attribution: attribution(false, true, true) })).toBe('token-groups');
    // the group grant raises it and a project level lowers it again: same answer as before
    expect(classifyCheck({ ...base, before: false, after: false, attribution: attribution(false, true, true) })).toBe('masked');
    // unchanged, with and without the attribution inputs
    expect(classifyCheck({ ...base, before: true, after: true })).toBe('same');
    expect(classifyCheck({ ...base, before: true, after: true, attribution: attribution(true, true, true) })).toBe('same');
  });

  it('flags the engine disagreeing with the rules it is checked against', () => {
    const base = { customPolicies: false, before: true, after: true };
    // fed the previous inputs, the engine should reproduce the previous rules
    expect(classifyCheck({ ...base, attribution: { engineWithPreviousInputs: false, engineWithoutProjectLevels: true, arithmeticWithOwnerGroups: true } })).toBe('parity-mismatch');
    // without project levels, the engine should equal the arithmetic with the owner's groups
    expect(classifyCheck({ ...base, attribution: { engineWithPreviousInputs: true, engineWithoutProjectLevels: false, arithmeticWithOwnerGroups: true } })).toBe('unexplained');
    // a difference nobody attributed is never silently "same"
    expect(classifyCheck({ customPolicies: false, before: true, after: false })).toBe('unexplained');
  });

  it('blames custom policies, not the engine, when the copy has some', () => {
    expect(classifyCheck({ customPolicies: true, before: true, after: false })).toBe('custom-policies');
    expect(classifyCheck({ customPolicies: true, before: true, after: true, attribution: { engineWithPreviousInputs: false, engineWithoutProjectLevels: true, arithmeticWithOwnerGroups: true } })).toBe('custom-policies');
  });

  it('combines the causes of a service\'s checks', () => {
    expect(mergeCauses(['same', 'same', 'same'])).toBe('same');
    expect(mergeCauses(['same', 'masked', 'same'])).toBe('masked');
    expect(mergeCauses(['project-narrowing', 'same', 'project-narrowing'])).toBe('project-narrowing');
    expect(mergeCauses(['token-groups', 'project-narrowing', 'same'])).toBe('token-groups+project-narrowing');
    expect(mergeCauses(['token-groups', 'same', 'same'])).toBe('token-groups');
    expect(mergeCauses(['token-groups', 'parity-mismatch', 'unexplained'])).toBe('parity-mismatch');
    expect(mergeCauses(['project-narrowing', 'custom-policies'])).toBe('custom-policies');
  });

  it('compares the services that have something to compare', () => {
    const compared = comparedServices().map((s) => s.id);
    expect(addedServices().sort()).toEqual(['iam', 'portals', 'resources']);
    for (const id of addedServices()) expect(compared).not.toContain(id);
    // retired aliases route nowhere
    expect(compared).not.toContain('aegis');
    expect(compared).toContain('models');
    expect(comparedServices().find((s) => s.id === 'audit')?.adminService).toBe(true);
  });
});

describe('the previous release\'s answers', () => {
  const member = { role: 'user' };
  const groupAdmin = [{ tenantRole: 'admin' as const }];

  it('gives a member write on a normal service and nothing on an administration service', () => {
    expect(previousAnswers({ user: member, groupGrants: [] }, 'models')).toEqual({ read: true, write: true, admin: false });
    expect(previousAnswers({ user: member, groupGrants: [] }, 'audit')).toEqual({ read: false, write: false, admin: false });
  });

  it('lets a person\'s groups raise their level', () => {
    expect(previousAnswers({ user: member, groupGrants: groupAdmin }, 'audit')).toEqual({ read: true, write: true, admin: true });
  });

  it('caps a token at its scope and gives it no group grants', () => {
    expect(previousAnswers({ user: member, groupGrants: [], tokenScope: { models: 'read' } }, 'models')).toEqual({ read: true, write: false, admin: false });
    expect(previousAnswers({ user: member, groupGrants: [], tokenScope: {} }, 'models')).toEqual({ read: false, write: false, admin: false });
    expect(previousAnswers({ user: member, groupGrants: [], tokenScope: null }, 'models').write).toBe(true);
  });

  it('honours an explicit lower permission on the person', () => {
    expect(previousAnswers({ user: { role: 'user', servicePermissions: { models: 'read' } }, groupGrants: [] }, 'models')).toEqual({ read: true, write: false, admin: false });
  });
});

describe('project access', () => {
  const existing = new Set(['p1', 'p2', 'p3']);

  it('keeps the order the first project wins in, without duplicates', () => {
    const rows = { legacyProjectIds: ['p2'], directProjectIds: ['p1', 'p2'], groupProjectIds: ['p3', 'p1'] };
    expect(accessibleProjectIds(rows, false)).toEqual(['p2', 'p1']);
    expect(accessibleProjectIds(rows, true)).toEqual(['p2', 'p1', 'p3']);
  });

  it('opens the requested project, else the default, else the first', () => {
    const accessible = ['p1', 'p2'];
    expect(resolveAccess({ accessible, cookie: 'p2', defaultProjectId: 'p1', existingProjectIds: existing })).toEqual({ ok: true, projectId: 'p2' });
    expect(resolveAccess({ accessible, cookie: null, defaultProjectId: 'p2', existingProjectIds: existing })).toEqual({ ok: true, projectId: 'p2' });
    expect(resolveAccess({ accessible, cookie: 'p3', defaultProjectId: 'p3', existingProjectIds: existing })).toEqual({ ok: true, projectId: 'p1' });
    expect(resolveAccess({ accessible: [], cookie: null, defaultProjectId: 'p1', existingProjectIds: existing })).toEqual({ ok: false, status: 403, error: 'No project assigned' });
    expect(resolveAccess({ accessible: ['gone'], cookie: null, defaultProjectId: null, existingProjectIds: existing })).toMatchObject({ ok: false, status: 404 });
  });

  it('shows a member who reaches a project only through a group gaining it', () => {
    const scenarios = accessScenarios({
      rows: { legacyProjectIds: [], directProjectIds: [], groupProjectIds: ['p1'] },
      defaultProjectId: 'p3',
      existingProjectIds: existing,
    });
    expect(scenarios.map((s) => s.cookie)).toEqual([null, 'p1']);
    expect(scenarios.every((s) => s.change === 'gains-project-access')).toBe(true);
    expect(scenarios[0].before).toEqual({ ok: false, status: 403, error: 'No project assigned' });
    expect(scenarios[0].after).toEqual({ ok: true, projectId: 'p1' });
  });

  it('shows a mixed member landing in the group\'s project when they ask for it', () => {
    const scenarios = accessScenarios({
      rows: { legacyProjectIds: [], directProjectIds: ['p1'], groupProjectIds: ['p2'] },
      defaultProjectId: 'p1',
      existingProjectIds: existing,
    });
    const asked = scenarios.find((s) => s.cookie === 'p2');
    expect(asked?.change).toBe('different-active-project');
    expect(scenarios.find((s) => s.cookie === 'p1')?.change).toBe('same');
    expect(scenarios.find((s) => s.cookie === null)?.change).toBe('same');
  });

  it('compares outcomes', () => {
    const a = { ok: true as const, projectId: 'p1' };
    const refused = { ok: false as const, status: 403, error: 'No project assigned' };
    expect(compareAccess(a, a)).toBe('same');
    expect(compareAccess(refused, a)).toBe('gains-project-access');
    expect(compareAccess(a, refused)).toBe('loses-project-access');
    expect(compareAccess(refused, refused)).toBe('same');
    expect(compareAccess(refused, { ...refused, status: 404 })).toBe('different-result');
  });
});

describe('the independent arithmetic', () => {
  const base = (over: Partial<OracleInput> = {}): OracleInput => ({
    user: { role: 'user', projectIds: [] },
    kind: 'session',
    groupGrants: [],
    tokenScope: null,
    requestedProjectId: 'alpha',
    defaultProjectId: 'alpha',
    direct: [{ projectId: 'alpha', servicePermissions: { models: 'read' }, updatedAt: NEW }],
    group: [],
    since: T0,
    ...over,
  });

  it('ignores an explicit "No access" saved before the activation instant, and nothing else', () => {
    expect(savedBefore(OLD, T0)).toBe(true);
    expect(savedBefore(NEW, T0)).toBe(false);
    expect(savedBefore(null, T0)).toBe(true);
    expect(savedBefore('not a date', T0)).toBe(true);
    const row = { projectId: 'alpha', servicePermissions: { models: 'none', prompts: 'read', agents: 'admin' }, updatedAt: OLD };
    expect(rowLevels(row, T0)).toEqual({ prompts: 'read', agents: 'admin' });
    expect(rowLevels({ ...row, updatedAt: NEW }, T0)).toEqual({ models: 'none', prompts: 'read', agents: 'admin' });
    expect(ignoredNoneEntries(row, T0)).toEqual(['models']);
    expect(ignoredNoneEntries({ ...row, updatedAt: NEW }, T0)).toEqual([]);
  });

  it('keeps the highest level any assignment names', () => {
    expect(highestPerService([{ models: 'none' }, { models: 'read', prompts: 'write' }, { prompts: 'read' }])).toEqual({ models: 'read', prompts: 'write' });
  });

  it('lets a project level lower the workspace level, never raise it', () => {
    const input = base();
    const membership = oracleMembership(input);
    expect(membership).toEqual({ projectId: 'alpha', levels: { models: 'read' } });
    expect(oracleChecks(input, 'models', membership)).toEqual({ read: true, write: false, admin: false });
    // an administration service stays closed to a member whatever the project says
    const raised = base({ direct: [{ projectId: 'alpha', servicePermissions: { audit: 'admin' }, updatedAt: NEW }] });
    expect(oracleChecks(raised, 'audit', oracleMembership(raised))).toEqual({ read: false, write: false, admin: false });
  });

  it('never narrows owners, admins or people who are admin through a group', () => {
    expect(isNeverNarrowed({ role: 'owner' }, [])).toBe(true);
    expect(isNeverNarrowed({ role: 'admin' }, [])).toBe(true);
    expect(isNeverNarrowed({ role: 'user' }, [{ tenantRole: 'admin' }])).toBe(true);
    expect(isNeverNarrowed({ role: 'user' }, [{ tenantRole: 'project_admin' }])).toBe(false);
    const admin = base({ user: { role: 'admin' } });
    expect(oracleMembership(admin)).toBeNull();
    expect(oracleChecks(admin, 'models', null).write).toBe(true);
  });

  it('uses the exact project for a token and the fallback project for a session', () => {
    const rows = {
      direct: [
        { projectId: 'alpha', servicePermissions: { models: 'read' }, updatedAt: NEW },
        { projectId: 'beta', servicePermissions: { models: 'none' }, updatedAt: NEW },
      ],
    };
    // a session asking for a project it cannot open lands in its first one
    expect(oracleMembership(base({ ...rows, requestedProjectId: 'elsewhere', defaultProjectId: null }))?.projectId).toBe('alpha');
    // a token for a project its owner is not in is not narrowed at all
    expect(oracleMembership(base({ ...rows, kind: 'token', requestedProjectId: 'elsewhere' }))).toBeNull();
    expect(oracleMembership(base({ ...rows, kind: 'token', requestedProjectId: 'beta' }))?.levels).toEqual({ models: 'none' });
  });

  it('gives a token its owner\'s group grants, capped by its scope', () => {
    const token = base({
      kind: 'token',
      groupGrants: [{ tenantRole: 'admin' }],
      direct: [],
      requestedProjectId: null,
      defaultProjectId: null,
    });
    expect(oracleChecks(token, 'audit', null)).toEqual({ read: true, write: true, admin: true });
    const capped = { ...token, tokenScope: { audit: 'read' as const } };
    expect(oracleChecks(capped, 'audit', null)).toEqual({ read: true, write: false, admin: false });
  });

  it('lets a group assignment lift a direct "No access" when both name the same project', () => {
    const input = base({
      direct: [{ projectId: 'alpha', servicePermissions: { models: 'none' }, updatedAt: NEW }],
      group: [{ projectId: 'alpha', servicePermissions: { models: 'read' }, updatedAt: NEW }],
    });
    expect(oracleMembership(input)?.levels).toEqual({ models: 'read' });
  });

  it('counts a legacy project id as a membership that says nothing', () => {
    const input = base({ user: { role: 'user', projectIds: ['alpha'] }, direct: [], group: [] });
    expect(oracleMembership(input)).toEqual({ projectId: 'alpha', levels: {} });
  });
});

describe('newly gated surfaces', () => {
  it('names real services at levels a gate can ask', () => {
    const ids = new Set(RBAC_SERVICE_DEFINITIONS.map((d) => d.id));
    for (const surface of NEWLY_GATED_SURFACES) {
      expect(ids.has(surface.service)).toBe(true);
      expect(['read', 'write']).toContain(surface.level);
      expect(surface.routes.length).toBeGreaterThan(0);
    }
  });

  it('matches the route-to-service map where a route is mapped by prefix', () => {
    expect(getPermissionServiceForPath('/api/skills')).toBe('agents');
    expect(getPermissionServiceForPath('/api/skills/abc')).toBe('agents');
    expect(getPermissionServiceForPath('/api/prompt-optimizer/runs')).toBe('prompts');
    const skills = NEWLY_GATED_SURFACES.filter((s) => s.id.startsWith('skills'));
    expect(skills.every((s) => s.service === 'agents')).toBe(true);
    expect(NEWLY_GATED_SURFACES.filter((s) => s.id.startsWith('prompt-optimizer')).every((s) => s.service === 'prompts')).toBe(true);
  });

  it('is lost by a person without the service level it asks for', () => {
    const playground = NEWLY_GATED_SURFACES.find((s) => s.id === 'model-playgrounds')!;
    const answers = (read: boolean) => new Map([['models', { read, write: read, admin: false }]]);
    expect(surfaceAllowed(playground, answers(true))).toBe(true);
    expect(surfaceAllowed(playground, answers(false))).toBe(false);
    // a service that was not compared cannot take a surface away
    expect(surfaceAllowed(playground, new Map())).toBe(true);
  });
});

describe('census', () => {
  const data: TenantData = {
    users: [
      { id: 'owner', email: 'o@x', name: 'O', role: 'owner' },
      { id: 'a', email: 'a@x', name: 'A', role: 'user', projectIds: ['p1'] },
      { id: 'b', email: 'b@x', name: 'B', role: 'user' },
      { id: 'c', email: 'c@x', name: 'C', role: 'user', canLogin: false },
      { id: 'd', email: 'd@x', name: 'D', role: 'user', status: 'disabled' },
    ],
    projects: [{ id: 'p1', key: 'default', name: 'Default' }, { id: 'p2', key: 'beta', name: 'Beta' }],
    groups: [
      { id: 'g1', name: 'Admins', tenantRole: 'admin' },
      { id: 'g2', name: 'Plain' },
    ],
    groupIdsByUser: new Map([['b', ['g1']], ['c', ['g2']]]),
    userProjects: new Map([
      ['a', [
        { projectId: 'p1', servicePermissions: { models: 'read' }, updatedAt: OLD },
        { projectId: 'p2', servicePermissions: { prompts: 'none' }, updatedAt: OLD },
        { projectId: 'p2', servicePermissions: {}, updatedAt: OLD },
      ]],
    ]),
    groupProjects: new Map([['g1', [{ projectId: 'p2', servicePermissions: { agents: 'none' }, updatedAt: OLD }, { projectId: 'gone', updatedAt: OLD }]]]),
    tokens: [
      { id: 't1', label: 'ci', userId: 'a', servicePermissions: null },
      { id: 't2', label: 'scoped', userId: 'b', servicePermissions: { models: 'read' }, projectId: 'p1' },
      { id: 't3', label: 'empty', userId: 'a', servicePermissions: {} },
      { id: 't4', label: 'orphan', userId: 'nobody', servicePermissions: null },
      { id: 't5', label: 'old', userId: 'a', servicePermissions: null, expiresAt: OLD },
    ],
    defaultProjectId: 'p1',
  };

  it('collects the grants of a person\'s groups, skipping groups that grant nothing', () => {
    expect(grantsOfUser(data, 'b')).toEqual([{ tenantRole: 'admin', servicePermissions: undefined }]);
    expect(grantsOfUser(data, 'c')).toEqual([]);
    expect(grantsOfUser(data, 'a')).toEqual([]);
  });

  it('counts what the upgrade touches', () => {
    const census = buildCensus(data, T0, T0);
    expect(census.users).toMatchObject({ total: 5, programmatic: 1, disabled: 1, byRole: { owner: 1, user: 4 } });
    expect(census.userProjects).toMatchObject({
      rows: 3,
      withServiceLevels: 2,
      narrowingFromDayOne: 1, // models: write -> read in p1; the "No access" row is ignored on day one
      withIgnoredNoAccess: 1,
      ignoredNoAccessEntries: 1,
      narrowingIfResaved: 1,
    });
    expect(census.groups).toMatchObject({ total: 2, withWorkspaceRole: 1, projectAssignments: 2, assignmentsWithServiceLevels: 1, assignmentsWithIgnoredNoAccess: 1, assignmentsToMissingProject: 1 });
    expect(census.tokens).toMatchObject({ total: 5, unscoped: 3, scoped: 2, scopedEmpty: 1, projectBound: 1, ownerMissing: 1, expired: 1 });
    // the person with a group that grants admin owns a token that now gains it
    expect(census.tokens.ownerInAGroupWithGrants).toBe(1);
  });
});

describe('sampling order', () => {
  it('evaluates whoever the upgrade can touch first and keeps ties in database order', () => {
    const data: TenantData = {
      users: [
        { id: 'owner', email: '', name: '', role: 'owner' },
        { id: 'plain1', email: '', name: '', role: 'user' },
        { id: 'withRows', email: '', name: '', role: 'user' },
        { id: 'plain2', email: '', name: '', role: 'user' },
        { id: 'grouped', email: '', name: '', role: 'user' },
      ],
      projects: [],
      groups: [],
      groupIdsByUser: new Map([['grouped', ['g']]]),
      userProjects: new Map([['withRows', [{ projectId: 'p', servicePermissions: { models: 'read' } }]]]),
      groupProjects: new Map([['g', [{ projectId: 'p' }]]]),
      tokens: [
        { id: 'scopedNoProject', label: '', userId: 'plain1', servicePermissions: {} },
        { id: 'plain', label: '', userId: 'plain1', servicePermissions: null, projectId: 'p' },
        { id: 'gainsFromGroup', label: '', userId: 'grouped', servicePermissions: null, projectId: 'p' },
      ],
      defaultProjectId: null,
    };
    expect(orderUsersForSampling(data).map((u) => u.id)).toEqual(['withRows', 'grouped', 'plain1', 'plain2', 'owner']);
    expect(orderTokensForSampling({ ...data, groups: [{ id: 'g', name: '', tenantRole: 'admin' }] }).map((t) => t.id)).toEqual(['gainsFromGroup', 'plain', 'scopedNoProject']);
  });
});

describe('re-using engine answers', () => {
  const member = (over: Partial<SignedPrincipal> = {}): SignedPrincipal => ({
    kind: 'user',
    sets: { readSvcs: ['models'], writeSvcs: ['models'], adminSvcs: [] },
    ...over,
  });

  it('gives people with the same levels the same signature, whoever they are', () => {
    expect(decisionSignature('dashboard', member())).toBe(decisionSignature('dashboard', member()));
  });

  it('tells apart everything the built-in policies read', () => {
    const base = decisionSignature('dashboard', member());
    expect(decisionSignature('api', member())).not.toBe(base);
    expect(decisionSignature('dashboard', member({ kind: 'token' }))).not.toBe(base);
    expect(decisionSignature('dashboard', member({ sets: { readSvcs: ['models', 'prompts'], writeSvcs: ['models'], adminSvcs: [] } }))).not.toBe(base);
    expect(decisionSignature('dashboard', member({ projDeny: { read: [], write: ['models'], admin: ['models'] } }))).not.toBe(base);
    expect(decisionSignature('dashboard', member({ token: { scoped: true, capRead: ['models'], capWrite: [], capAdmin: [] } }))).not.toBe(base);
    expect(
      decisionSignature('dashboard', member({ token: { scoped: false, capRead: [], capWrite: [], capAdmin: [] } })),
    ).not.toBe(base);
  });

  it('keeps answers per service and hands out copies', () => {
    const memo = new DecisionMemo();
    expect(memo.get('sig', 'models')).toBeUndefined();
    memo.set('sig', 'models', { read: true, write: false, admin: false });
    const hit = memo.get('sig', 'models')!;
    expect(hit).toEqual({ read: true, write: false, admin: false });
    hit.write = true;
    expect(memo.get('sig', 'models')).toEqual({ read: true, write: false, admin: false });
    expect(memo.get('sig', 'prompts')).toBeUndefined();
    expect(memo.get('other', 'models')).toBeUndefined();
    expect(memo.hits).toBe(2);
  });

  it('stops growing at its bound', () => {
    const memo = new DecisionMemo(2);
    for (const sig of ['a', 'b', 'c']) memo.set(sig, 'models', { read: true, write: true, admin: true });
    expect(memo.signatures).toBe(2);
    expect(memo.get('c', 'models')).toBeUndefined();
    memo.set('a', 'prompts', { read: true, write: false, admin: false });
    expect(memo.get('a', 'prompts')).toBeDefined();
  });
});

describe('the environment of a run', () => {
  const made: string[] = [];
  const fakeData = (mainDb = 'console_main'): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam-preflight-test-'));
    made.push(dir);
    fs.writeFileSync(path.join(dir, `${mainDb}.db`), 'x');
    fs.writeFileSync(path.join(dir, 'tenant_acme.db'), 'y');
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const quiet = () => undefined;

  it('works on a temporary copy of a SQLite directory and removes it afterwards', () => {
    const source = fakeData();
    const env: Record<string, string | undefined> = {
      DB_PROVIDER: 'mongodb',
      MONGODB_URI: 'mongodb://prod.example.net/live',
      SQLITE_DATA_DIR: '/live/data',
      MONGODB_SINGLE_DATABASE: 'true',
      JWT_SECRET: 'short',
    };
    const options = parseOptions(['--sqlite-dir', source], {});
    const prepared = prepareEnvironment(options, env, quiet);
    try {
      expect(env.DB_PROVIDER).toBe('sqlite');
      expect(env.SQLITE_DATA_DIR).not.toBe(source);
      expect(env.SQLITE_DATA_DIR).not.toBe('/live/data');
      expect(env.MONGODB_URI).toBeUndefined();
      expect(env.MONGODB_SINGLE_DATABASE).toBeUndefined();
      expect(env.MAIN_DB_NAME).toBe('console_main');
      expect(env.CACHE_PROVIDER).toBe('memory');
      expect((env.JWT_SECRET ?? '').length).toBeGreaterThanOrEqual(32);
      expect((env.PROVIDER_ENCRYPTION_SECRET ?? '').length).toBeGreaterThanOrEqual(32);
      expect(env.PROVIDER_ENCRYPTION_SECRET).not.toBe(env.JWT_SECRET);
      expect(fs.readdirSync(env.SQLITE_DATA_DIR!).sort()).toEqual(['console_main.db', 'tenant_acme.db']);
      expect(prepared.location).toBe(`copy of ${source}`);
    } finally {
      const copy = env.SQLITE_DATA_DIR!;
      prepared.cleanup();
      expect(fs.existsSync(copy)).toBe(false);
    }
    expect(fs.existsSync(path.join(source, 'console_main.db'))).toBe(true); // the original is untouched
  });

  it('refuses a directory that is not a Console SQLite directory', () => {
    const source = fakeData('other_main');
    const options = parseOptions(['--sqlite-dir', source], {});
    expect(() => prepareEnvironment(options, {}, quiet)).toThrow(/no console_main\.db/);
    expect(() => prepareEnvironment(parseOptions(['--sqlite-dir', '/does/not/exist'], {}), {}, quiet)).toThrow(/does not exist/);
    const prepared = prepareEnvironment(parseOptions(['--sqlite-dir', source, '--main-db', 'other_main'], {}), {}, quiet);
    expect(prepared.provider).toBe('sqlite');
    prepared.cleanup(); // the working copy it made goes away with the test
  });

  it('reads a directory in place only when asked to, and says so', () => {
    const source = fakeData();
    const messages: string[] = [];
    const env: Record<string, string | undefined> = {};
    const prepared = prepareEnvironment(parseOptions(['--sqlite-dir', source, '--no-copy'], {}), env, (m) => messages.push(m));
    expect(env.SQLITE_DATA_DIR).toBe(source);
    expect(messages.join(' ')).toMatch(/in place/);
    prepared.cleanup();
    expect(fs.existsSync(source)).toBe(true); // cleanup never removes what it did not create
  });

  it('points a MongoDB run at the given copy, without credentials in the report', () => {
    const env: Record<string, string | undefined> = { SQLITE_DATA_DIR: '/live/data', MONGODB_SINGLE_DATABASE: 'false' };
    const options = parseOptions(['--mongodb-uri', 'mongodb://admin:secret@127.0.0.1:27633/seed', '--main-db', 'seed_main', '--single-database'], {});
    const prepared = prepareEnvironment(options, env, quiet);
    expect(env).toMatchObject({ DB_PROVIDER: 'mongodb', MONGODB_URI: 'mongodb://admin:secret@127.0.0.1:27633/seed', MAIN_DB_NAME: 'seed_main', MONGODB_SINGLE_DATABASE: 'true' });
    expect(env.SQLITE_DATA_DIR).toBeUndefined();
    expect(prepared.location).toBe('mongodb://127.0.0.1');
    expect(prepared.location).not.toContain('secret');
  });

  it('shares only the directory name of a redacted run', () => {
    const source = fakeData();
    const prepared = prepareEnvironment(parseOptions(['--sqlite-dir', source, '--redact'], {}), {}, quiet);
    try {
      expect(prepared.location).toBe(`copy of ${path.basename(source)}`);
    } finally {
      prepared.cleanup();
    }
  });
});

describe('redaction', () => {
  it('leaves names alone unless asked', () => {
    const off = makeRedactor(false);
    expect(userLabel(off, { id: '1', email: 'alice@corp.example' })).toBe('user:alice@corp.example');
    expect(tokenLabel(off, { id: 'abcdef123', label: 'ci' })).toBe('token:ci#abcdef');
  });

  it('replaces them by short stable hashes', () => {
    const on = makeRedactor(true, 'salt');
    const a = userLabel(on, { id: '1', email: 'alice@corp.example' });
    expect(a).toMatch(/^user:h:[0-9a-f]{10}$/);
    expect(userLabel(on, { id: '1', email: 'alice@corp.example' })).toBe(a);
    expect(userLabel(on, { id: '2', email: 'bob@corp.example' })).not.toBe(a);
    expect(a).not.toContain('alice');
    expect(on('project', 'Payroll')).not.toContain('Payroll');
  });

  it('is comparable between runs only with the same salt', () => {
    const x = makeRedactor(true, 'same')('user', 'alice@corp.example');
    expect(makeRedactor(true, 'same')('user', 'alice@corp.example')).toBe(x);
    expect(makeRedactor(true, 'other')('user', 'alice@corp.example')).not.toBe(x);
    expect(makeRedactor(true)('user', 'alice@corp.example')).not.toBe(makeRedactor(true)('user', 'alice@corp.example'));
  });
});
