/**
 * The runner of the pre-upgrade access report: reads a COPY of the data, asks
 * the policy engine - through the same functions the request gates use - what it
 * will decide for every person and API token, and sets that against what the
 * previous release decided from the same data.
 *
 * Read-only by construction:
 *  - SQLite: the directory is copied to a temporary one first (the provider adds
 *    columns when it opens a database) and the copy is removed afterwards;
 *  - MongoDB: only a copy on this machine is accepted (the provider creates
 *    indexes when it connects);
 *  - the engine never writes while deciding; the one document it would create on
 *    its first evaluation of a workspace (the activation instant of project
 *    permissions) is pinned in memory instead.
 *
 * The application modules are loaded AFTER the environment is set, because the
 * configuration is read when they first run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseProvider, IApiToken, IGroup, ITenant, IUser } from '@/lib/database';
import type { EnforceGateInput } from '@/lib/iam/enforce';
import type { IamPrincipal } from '@/lib/iam/entities';
import type { GroupTenantGrant, PermissionService, UserServicePermissions } from '@/lib/security/rbac';
import { accessScenarios, accessibleProjectIds, type MemberProjectRows } from './access';
import {
  TenantAccumulator,
  type ContextObservation,
  type PrincipalInfo,
  type ServiceObservation,
} from './accumulate';
import { previousAnswers } from './before';
import { buildCensus, groupGrantOf } from './census';
import { isPrivilegedRole, type GroupRow, type ProjectRow, type TenantData, type TokenRow, type UserRow } from './data';
import {
  CHECKS,
  CHECK_IDS,
  addedServices,
  classifyCheck,
  comparedServices,
  sameChecks,
  type Cause,
  type CheckId,
  type CheckSpec,
  type Checks,
} from './model';
import { DecisionMemo, decisionSignature } from './memo';
import { orderTokensForSampling, orderUsersForSampling } from './order';
import { oracleChecks, oracleMembership, ignoredNoneEntries, type AssignmentRow } from './oracle';
import { describeMongoUri, type Env, type PreflightOptions } from './options';
import { makeRedactor, projectLabel as redactedProjectLabel, tokenLabel as redactedTokenLabel, userLabel as redactedUserLabel } from './redact';
import { REPORT_VERSION, buildTotals, type PreflightReport, type SkippedPrincipal, type TenantReport } from './report';

export type Log = (message: string) => void;

// ── environment ──────────────────────────────────────────────────────────

export interface PreparedEnvironment {
  provider: 'sqlite' | 'mongodb';
  /** What the report says it read (no credentials). */
  location: string;
  cleanup: () => void;
}

const SECRET_A = 'iam-preflight-jwt-secret-not-used-0000000000';
const SECRET_B = 'iam-preflight-encryption-secret-not-used-01';

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(p) : fs.statSync(p).size;
  }
  return total;
}

/**
 * Point the application's configuration at the copy. Ambient database settings
 * of the shell are overwritten, never trusted.
 */
export function prepareEnvironment(options: PreflightOptions, env: Env, log: Log): PreparedEnvironment {
  env.JWT_SECRET = env.JWT_SECRET && env.JWT_SECRET.length >= 32 ? env.JWT_SECRET : SECRET_A;
  env.PROVIDER_ENCRYPTION_SECRET = env.PROVIDER_ENCRYPTION_SECRET && env.PROVIDER_ENCRYPTION_SECRET.length >= 32 && env.PROVIDER_ENCRYPTION_SECRET !== env.JWT_SECRET
    ? env.PROVIDER_ENCRYPTION_SECRET
    : SECRET_B;
  env.LOG_LEVEL = env.LOG_LEVEL || 'error';
  // Nothing in this run may reach a shared cache or rate limiter.
  env.CACHE_PROVIDER = 'memory';
  env.RATE_LIMIT_PROVIDER = 'memory';
  env.MAIN_DB_NAME = options.source.mainDbName;

  if (options.source.kind === 'sqlite') {
    const source = options.source.dir;
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`The SQLite directory does not exist: ${source}`);
    if (!fs.existsSync(path.join(source, `${options.source.mainDbName}.db`))) {
      throw new Error(`${source} has no ${options.source.mainDbName}.db: this does not look like a Console SQLite directory (use --main-db if the main database has another name)`);
    }
    delete env.MONGODB_URI;
    delete env.MONGODB_SINGLE_DATABASE;
    env.DB_PROVIDER = 'sqlite';
    if (!options.source.copy) {
      env.SQLITE_DATA_DIR = source;
      log(`Reading ${source} in place (--no-copy): make sure it is a throwaway copy.`);
      return { provider: 'sqlite', location: `${options.redact ? path.basename(source) : source} (in place)`, cleanup: () => undefined };
    }
    const bytes = directorySize(source);
    log(`Copying ${source} (${(bytes / 1024 / 1024).toFixed(1)} MB) to a temporary directory ...`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iam-preflight-'));
    fs.cpSync(source, tmp, { recursive: true });
    env.SQLITE_DATA_DIR = tmp;
    return {
      provider: 'sqlite',
      // A redacted report is meant to be shared: it gets the directory name, not the path (which can name a person).
      location: `copy of ${options.redact ? path.basename(source) : source}`,
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  }

  delete env.SQLITE_DATA_DIR;
  env.DB_PROVIDER = 'mongodb';
  env.MONGODB_URI = options.source.uri;
  if (options.source.singleDatabase) env.MONGODB_SINGLE_DATABASE = 'true';
  else delete env.MONGODB_SINGLE_DATABASE;
  return { provider: 'mongodb', location: describeMongoUri(options.source.uri), cleanup: () => undefined };
}

// ── application modules ──────────────────────────────────────────────────

async function loadApp() {
  // One after the other: the modules initialise each other, and a failure should name the one that broke.
  const database = await import('@/lib/database');
  const engine = await import('@/lib/iam/engine');
  const enforce = await import('@/lib/iam/enforce');
  const entities = await import('@/lib/iam/entities');
  const projectLevels = await import('@/lib/iam/projectLevels');
  const principalCache = await import('@/lib/iam/principalCache');
  const selfTest = await import('@/lib/iam/selfTest');
  return { database, engine, enforce, entities, projectLevels, principalCache, selfTest };
}

type App = Awaited<ReturnType<typeof loadApp>>;

// ── loading a workspace ──────────────────────────────────────────────────

interface LoadedTenant {
  data: TenantData;
  users: Map<string, IUser>;
  groups: Map<string, IGroup>;
  tokens: IApiToken[];
  storedSince: number | null;
}

const toAssignment = (r: { projectId: string; servicePermissions?: unknown; updatedAt?: Date | null }): AssignmentRow => ({
  projectId: String(r.projectId),
  servicePermissions: r.servicePermissions,
  updatedAt: r.updatedAt ?? null,
});

async function loadTenant(app: App, db: DatabaseProvider, tenant: ITenant): Promise<LoadedTenant> {
  const tenantId = String(tenant._id);
  const loaded = await app.database.runWithTenantScope(tenant.dbName, async (tdb) => {
    const users = await tdb.listUsers();
    const projects = await tdb.listProjects(tenantId);
    const groups = await tdb.listGroups(tenantId);

    const groupIdsByUser = new Map<string, string[]>();
    const userProjects = new Map<string, AssignmentRow[]>();
    const wantedGroups = new Set(groups.map((g) => String(g._id)));
    for (const u of users) {
      const id = String(u._id);
      const memberships = await tdb.listGroupMembersByUser(id);
      const ids = [...new Set(memberships.map((m) => String(m.groupId)))];
      groupIdsByUser.set(id, ids);
      ids.forEach((g) => wantedGroups.add(g));
      userProjects.set(id, (await tdb.listUserProjectsByUser(id)).map(toAssignment));
    }
    const groupProjects = new Map<string, AssignmentRow[]>();
    for (const groupId of wantedGroups) {
      groupProjects.set(groupId, (await tdb.listGroupProjectsByGroup(groupId)).map(toAssignment));
    }

    const defaultProject = await tdb.findProjectByKey(tenantId, 'default');
    const stored = (await tdb.iamDocGet('iam_meta', app.projectLevels.PROJECT_LEVELS_DOC_ID))?.data?.since;
    const storedMs = typeof stored === 'string' ? Date.parse(stored) : Number.NaN;
    return {
      users,
      projects,
      groups,
      groupIdsByUser,
      userProjects,
      groupProjects,
      defaultProjectId: defaultProject?._id ? String(defaultProject._id) : null,
      storedSince: Number.isFinite(storedMs) ? storedMs : null,
    };
  });
  const tokens = await db.listTenantApiTokens(tenantId);

  const userRows: UserRow[] = loaded.users.map((u) => ({
    id: String(u._id),
    email: u.email,
    name: u.name,
    role: String(u.role ?? ''),
    canLogin: u.canLogin,
    status: u.status,
    servicePermissions: u.servicePermissions,
    projectIds: (u.projectIds ?? []).map(String).filter(Boolean),
  }));
  const projectRows: ProjectRow[] = loaded.projects.map((p) => ({ id: String(p._id), key: p.key, name: p.name }));
  const groupRows: GroupRow[] = loaded.groups.map((g) => ({
    id: String(g._id),
    name: g.name,
    source: g.source,
    tenantRole: g.tenantRole,
    servicePermissions: g.servicePermissions,
  }));
  const tokenRows: TokenRow[] = tokens.map((t) => ({
    id: String(t._id),
    label: t.label,
    userId: String(t.userId),
    projectId: t.projectId ? String(t.projectId) : null,
    servicePermissions: t.servicePermissions,
    createdAt: t.createdAt ?? null,
    expiresAt: t.expiresAt ?? null,
  }));

  return {
    data: {
      users: userRows,
      projects: projectRows,
      groups: groupRows,
      groupIdsByUser: loaded.groupIdsByUser,
      userProjects: loaded.userProjects,
      groupProjects: loaded.groupProjects,
      tokens: tokenRows,
      defaultProjectId: loaded.defaultProjectId,
    },
    users: new Map(loaded.users.map((u) => [String(u._id), u])),
    groups: new Map(loaded.groups.map((g) => [String(g._id), g])),
    tokens,
    storedSince: loaded.storedSince,
  };
}

// ── one workspace ────────────────────────────────────────────────────────

interface RunState {
  startedAt: number;
  options: PreflightOptions;
  log: Log;
  redact: ReturnType<typeof makeRedactor>;
  /** File descriptor of the --dump file, or null. */
  dump: number | null;
}

async function runTenant(app: App, db: DatabaseProvider, tenant: ITenant, state: RunState): Promise<TenantReport> {
  const { options, log, redact } = state;
  const tenantDbName = tenant.dbName;
  const tenantId = String(tenant._id);
  const tag = tenant.slug;

  app.principalCache.resetPrincipalCacheForTests();
  const loaded = await loadTenant(app, db, tenant);
  const { data } = loaded;

  // ── activation instant: pinned in memory, never written
  const since = loaded.storedSince ?? options.since ?? state.startedAt;
  const origin: TenantReport['activation']['origin'] = loaded.storedSince !== null ? 'stored' : options.since !== null ? 'option' : 'run-time';
  const pinSince = (ms: number) => app.projectLevels.primeProjectLevelsForTests(tenantDbName, ms);
  pinSince(since);

  // ── custom policies of the copy (a copy of an upgraded workspace may have some)
  let policyCount = 0;
  let policySkipped = 0;
  try {
    const set = await app.engine.describeTenantPolicySet(tenantDbName);
    policyCount = set.custom;
    policySkipped = set.skipped.length;
  } catch (error) {
    log(`[${tag}] the policy set could not be read (${error instanceof Error ? error.message : String(error)}); decisions will report engine failures`);
  }
  const customPolicies = policyCount > 0;

  const acc = new TenantAccumulator({ customPolicies });
  const services = comparedServices();
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const projectLabels = new Map(data.projects.map((p) => [p.id, redactedProjectLabel(redact, p)]));
  const labelOf = (projectId: string | null | undefined): string =>
    projectId ? (projectLabels.get(String(projectId)) ?? `(missing ${String(projectId).slice(0, 8)})`) : '(none)';
  const existingProjectIds = new Set(data.projects.map((p) => p.id));
  const userRowById = new Map(data.users.map((u) => [u.id, u]));
  const userLabelOf = (u: UserRow) => redactedUserLabel(redact, u);
  const grantByGroup = new Map<string, GroupTenantGrant | null>(data.groups.map((g) => [g.id, groupGrantOf(g)]));
  const grantsOf = (userId: string): GroupTenantGrant[] => {
    const out: GroupTenantGrant[] = [];
    for (const groupId of data.groupIdsByUser.get(userId) ?? []) {
      const grant = grantByGroup.get(groupId);
      if (grant) out.push(grant);
    }
    return out;
  };
  const groupsOf = (userId: string): IGroup[] =>
    (data.groupIdsByUser.get(userId) ?? []).map((id) => loaded.groups.get(id)).filter((g): g is IGroup => !!g);
  const groupRowsOf = (userId: string): AssignmentRow[] =>
    (data.groupIdsByUser.get(userId) ?? []).flatMap((id) => data.groupProjects.get(id) ?? []);

  let failures = 0;
  const decide = async (principal: IamPrincipal, channel: 'dashboard' | 'api', service: PermissionService, check: CheckSpec): Promise<boolean> => {
    const res = await app.engine.authorizeGate({
      tenant: tenantDbName,
      principal,
      service,
      method: check.method,
      level: check.level,
      context: { projectId: principal.contextProjectId, channel, method: check.method, path: '/iam-preflight' },
    });
    if (res.failed) failures++;
    return res.allowed;
  };
  // With only the built-in policies in force, people with the same levels get the same answers: ask the engine once per distinct combination.
  const memo = customPolicies || options.noMemo ? null : new DecisionMemo();
  const decideAll = async (principal: IamPrincipal, channel: 'dashboard' | 'api', service: PermissionService): Promise<Checks> => {
    const signature = memo ? decisionSignature(channel, principal) : null;
    if (memo && signature) {
      const hit = memo.get(signature, service);
      if (hit) return hit;
    }
    const out: Checks = { read: false, write: false, admin: false };
    for (const check of CHECKS) out[check.id] = await decide(principal, channel, service, check);
    if (memo && signature) memo.set(signature, service, out);
    return out;
  };

  interface Subject {
    kind: 'session' | 'token';
    info: PrincipalInfo;
    user: IUser;
    tokenId?: string;
    tokenScope?: UserServicePermissions | null;
    requestedProjectId: string | null;
  }

  const evaluate = async (s: Subject): Promise<ContextObservation> => {
    const userId = String(s.user._id);
    const grants = grantsOf(userId);
    const groups = groupsOf(userId);
    const channel = s.kind === 'token' ? 'api' as const : 'dashboard' as const;
    const previousGrants = s.kind === 'token' ? [] : grants;
    const gateInput: EnforceGateInput = {
      subject: s.kind,
      tenantDbName,
      tenantId,
      requestId: 'iam-preflight',
      method: 'GET',
      route: '/iam-preflight',
      userId,
      user: s.user,
      ...(s.kind === 'session' ? { groupGrants: grants } : {}),
      groups,
      ...(s.kind === 'token' ? { tokenId: s.tokenId, tokenScope: s.tokenScope } : {}),
      requestedProjectId: s.requestedProjectId,
      projectFromPath: false,
      service: 'models',
    };

    pinSince(since);
    const target = await app.enforce.buildEnforcePrincipalWithNarrowing(gateInput);
    const projectId = target.principal.contextProjectId ?? null;

    let noNarrowing: IamPrincipal | undefined;
    let previous: IamPrincipal | undefined;
    const getNoNarrowing = async (): Promise<IamPrincipal> => {
      noNarrowing ??= (await app.enforce.buildEnforcePrincipalWithNarrowing({ ...gateInput, skipProjectNarrowing: true })).principal;
      return noNarrowing;
    };
    const getPrevious = async (): Promise<IamPrincipal> => {
      // The engine fed the previous release's inputs: the same principal, with the level sets of the workspace rules alone.
      previous ??= { ...(await getNoNarrowing()), sets: app.entities.userLevelSets(s.user, previousGrants) };
      return previous;
    };

    // Rows that still carry an ignorable "No access" in the project this request narrows by.
    let deferredPrincipal: IamPrincipal | undefined;
    if (target.narrowing) {
      const narrowedBy = target.narrowing.projectId;
      const rows = [
        ...(data.userProjects.get(userId) ?? []).filter((r) => r.projectId === narrowedBy),
        ...groupRowsOf(userId).filter((r) => r.projectId === narrowedBy),
      ];
      if (rows.some((r) => ignoredNoneEntries(r, since).length > 0)) {
        pinSince(0);
        try {
          deferredPrincipal = (await app.enforce.buildEnforcePrincipalWithNarrowing(gateInput)).principal;
        } finally {
          pinSince(since);
        }
      }
    }

    const oracleInput = {
      user: s.user,
      kind: s.kind,
      groupGrants: grants,
      tokenScope: s.tokenScope,
      requestedProjectId: s.requestedProjectId,
      defaultProjectId: data.defaultProjectId,
      direct: data.userProjects.get(userId) ?? [],
      group: groupRowsOf(userId),
      since,
    };
    const membership = oracleMembership(oracleInput);

    const observed: ServiceObservation[] = [];
    for (const service of services) {
      const before = previousAnswers({ user: s.user, groupGrants: previousGrants, tokenScope: s.tokenScope }, service.id);
      const after = await decideAll(target.principal, channel, service.id);

      if (state.dump !== null) {
        for (const id of CHECK_IDS) {
          fs.writeSync(state.dump, `${JSON.stringify({
            tenant: tenant.slug,
            kind: s.kind,
            id: s.kind === 'token' ? s.tokenId : userId,
            requestedProjectId: s.requestedProjectId,
            projectId,
            service: service.id,
            check: id,
            before: before[id],
            after: after[id],
          })}\n`);
        }
      }

      const independent = oracleChecks(oracleInput, service.id, membership);
      if (!customPolicies) {
        for (const id of CHECK_IDS) {
          if (independent[id] !== after[id]) {
            acc.recordOracleMismatch({ principal: s.info.label, project: labelOf(projectId), service: service.id, check: id, engine: after[id], independent: independent[id] });
          }
        }
      }

      const causes: Partial<Record<CheckId, Cause>> = {};
      if (!sameChecks(before, after) || options.verifyAll) {
        const withOwnerGroups = s.kind === 'token'
          ? previousAnswers({ user: s.user, groupGrants: grants, tokenScope: s.tokenScope }, service.id)
          : before;
        const noProject = await decideAll(await getNoNarrowing(), channel, service.id);
        const previousEngine = await decideAll(await getPrevious(), channel, service.id);
        for (const id of CHECK_IDS) {
          causes[id] = classifyCheck({
            before: before[id],
            after: after[id],
            attribution: {
              engineWithPreviousInputs: previousEngine[id],
              engineWithoutProjectLevels: noProject[id],
              arithmeticWithOwnerGroups: withOwnerGroups[id],
            },
            customPolicies,
          });
        }
      }

      const observation: ServiceObservation = { service: service.id, adminService: serviceById.get(service.id)?.adminService ?? false, before, after, causes };
      if (deferredPrincipal) {
        const deferred = await decideAll(deferredPrincipal, channel, service.id);
        if (!sameChecks(deferred, after)) observation.deferred = deferred;
      }
      observed.push(observation);
    }

    return { principal: s.info, projectLabel: labelOf(projectId), services: observed };
  };

  // ── people ──
  const skipped: SkippedPrincipal[] = [];
  const cap = options.maxPrincipals ?? Number.POSITIVE_INFINITY;
  let evaluatedUsers = 0;
  let truncatedUsers = false;
  const startedAt = Date.now();
  let lastProgress = startedAt;
  const progress = (what: string, done: number, total: number) => {
    const now = Date.now();
    if (now - lastProgress < 5_000) return;
    lastProgress = now;
    log(`[${tag}] ${what} ${done}/${total} (${Math.round(((now - startedAt) / 1000))} s)`);
  };

  const orderedUsers = orderUsersForSampling(data);
  for (const user of orderedUsers) {
    const raw = loaded.users.get(user.id);
    if (!raw) continue;
    const label = userLabelOf(user);
    if (user.status === 'disabled' || user.canLogin === false) {
      skipped.push({ label, kind: 'user', reason: user.status === 'disabled' ? 'account is disabled' : 'programmatic account (cannot sign in; its tokens are compared)' });
      continue;
    }
    if (evaluatedUsers >= cap) {
      truncatedUsers = true;
      continue;
    }
    evaluatedUsers++;
    progress('people', evaluatedUsers, Math.min(cap, orderedUsers.length));

    const privileged = isPrivilegedRole(user.role);
    const info: PrincipalInfo = { key: `u:${user.id}`, label, kind: 'user', role: user.role };
    const rows: MemberProjectRows = {
      legacyProjectIds: user.projectIds ?? [],
      directProjectIds: (data.userProjects.get(user.id) ?? []).map((r) => r.projectId),
      groupProjectIds: groupRowsOf(user.id).map((r) => r.projectId),
    };
    if (!privileged) {
      acc.addAccess({ label, role: user.role }, accessScenarios({ rows, defaultProjectId: data.defaultProjectId, existingProjectIds }), labelOf);
    }
    const reachable = privileged ? [] : accessibleProjectIds(rows, true);
    const contexts: Array<string | null> = reachable.length > 0 ? reachable : [null];
    for (const requestedProjectId of contexts) {
      acc.addContext(await evaluate({ kind: 'session', info, user: raw, requestedProjectId }));
    }
  }

  // ── API tokens ──
  let evaluatedTokens = 0;
  let truncatedTokens = false;
  const orderedTokens = orderTokensForSampling(data);
  const tokenById = new Map(loaded.tokens.map((t) => [String(t._id), t]));
  for (const token of orderedTokens) {
    const label = redactedTokenLabel(redact, token);
    const owner = userRowById.get(token.userId);
    const rawOwner = loaded.users.get(token.userId);
    if (!owner || !rawOwner) {
      skipped.push({ label, kind: 'token', reason: 'its owner no longer exists (401)' });
      continue;
    }
    if (owner.status === 'disabled') {
      skipped.push({ label, kind: 'token', reason: 'its owner is disabled (401)' });
      continue;
    }
    if (token.expiresAt && new Date(token.expiresAt as never).getTime() <= state.startedAt) {
      skipped.push({ label, kind: 'token', reason: 'it has expired (401)' });
      continue;
    }
    if (evaluatedTokens >= cap) {
      truncatedTokens = true;
      continue;
    }
    evaluatedTokens++;
    progress('tokens', evaluatedTokens, Math.min(cap, orderedTokens.length));

    const ownerLabel = userLabelOf(owner);
    const record = tokenById.get(token.id);
    const scope = (record?.servicePermissions ?? null) as UserServicePermissions | null;
    if (scope != null) acc.recordScopedToken(label, ownerLabel);
    const info: PrincipalInfo = { key: `t:${token.id}`, label, kind: 'token', role: owner.role, owner: ownerLabel };
    // The token gate runs in the token's own project, else the workspace's default one.
    acc.addContext(await evaluate({
      kind: 'token',
      info,
      user: rawOwner,
      tokenId: token.id,
      tokenScope: scope,
      requestedProjectId: token.projectId ?? data.defaultProjectId,
    }));
  }

  acc.recordEngineFailures(failures);
  const aggregate = acc.finish();
  const census = buildCensus(data, state.startedAt, since);
  log(`[${tag}] ${evaluatedUsers} people, ${evaluatedTokens} tokens, ${aggregate.contexts} contexts, ${aggregate.decisions} decisions, ${aggregate.differs} differ`);

  return {
    slug: tenant.slug,
    dbName: tenantDbName,
    activation: { since: new Date(since).toISOString(), origin },
    customPolicies: { inForce: policyCount, skipped: policySkipped },
    principals: {
      users: evaluatedUsers,
      tokens: evaluatedTokens,
      totalUsers: data.users.length,
      totalTokens: data.tokens.length,
      truncated: truncatedUsers || truncatedTokens,
      skipped,
    },
    ...aggregate,
    projectAccess: acc.accessReport(),
    census,
  };
}

// ── whole run ────────────────────────────────────────────────────────────

/** Leave the per-person lists out (--summary-only); counts stay. */
export function stripLists(report: PreflightReport): PreflightReport {
  return {
    ...report,
    tenants: report.tenants.map((t) => ({
      ...t,
      principalChanges: [],
      deferred: { ...t.deferred, list: [] },
      newlyGated: t.newlyGated.map((s) => ({ ...s, principals: [] })),
      metricsExport: { ...t.metricsExport, tokens: [] },
      projectAccess: { ...t.projectAccess, changes: [] },
      principals: { ...t.principals, skipped: t.principals.skipped.slice(0, 50) },
    })),
  };
}

export async function runPreflight(options: PreflightOptions, log: Log, env: Env = process.env): Promise<PreflightReport> {
  const prepared = prepareEnvironment(options, env, log);
  // Ctrl-C or a termination signal must not leave a copy of the data in the temporary directory.
  const onSignal = (signal: NodeJS.Signals) => {
    prepared.cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let app: App | undefined;
  try {
    app = await loadApp();

    const test = app.selfTest.engineSelfTest();
    if (!test.ok) throw new Error(`The authorization engine does not start in this installation: ${test.error}`);
    log(`Engine self-test passed (Cedar ${test.cedar.sdk}, ${test.checks} canned decisions).`);

    const db = await app.database.getDatabase();
    const all = await db.listTenants();
    const wanted = new Set(options.tenants);
    const tenants = all.filter((t) => wanted.size === 0 || wanted.has(t.slug) || wanted.has(t.dbName));
    if (wanted.size > 0) {
      const found = new Set(tenants.flatMap((t) => [t.slug, t.dbName]));
      const missing = [...wanted].filter((w) => !found.has(w));
      if (missing.length > 0) throw new Error(`No such workspace: ${missing.join(', ')}. Known: ${all.map((t) => t.slug).join(', ') || '(none)'}`);
    }
    if (tenants.length === 0) throw new Error('The copy contains no workspace.');

    const state: RunState = {
      startedAt: Date.now(),
      options,
      log,
      redact: makeRedactor(options.redact, options.redactSalt),
      dump: options.dump ? fs.openSync(options.dump, 'w') : null,
    };
    const reports: TenantReport[] = [];
    try {
      for (const tenant of tenants) {
        log(`Workspace ${tenant.slug} ...`);
        reports.push(await runTenant(app, db, tenant, state));
      }
    } finally {
      if (state.dump !== null) fs.closeSync(state.dump);
    }

    const report: PreflightReport = {
      reportVersion: REPORT_VERSION,
      generatedAt: new Date().toISOString(),
      source: { provider: prepared.provider, location: prepared.location },
      redacted: options.redact,
      options: { tenants: options.tenants, maxPrincipals: options.maxPrincipals, verifyAll: options.verifyAll, noMemo: options.noMemo, summaryOnly: options.summaryOnly },
      services: { compared: comparedServices().length, addedWithEngine: addedServices() },
      totals: buildTotals(reports),
      tenants: reports,
    };
    return report;
  } finally {
    try {
      await app?.database.disconnectDatabase();
    } catch {
      // closing a copy is best effort
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    prepared.cleanup();
  }
}
