/**
 * The decision point of the request gates: the policy engine decides, every
 * time, for every workspace.
 *
 *  - The simple settings stay on top (workspace role, per-user service
 *    permissions, group grants, project member permissions, token scope); the
 *    managed policies turn them into decisions, and custom policies handle the
 *    exceptions.
 *  - API tokens include the owner's GROUP grants (the token scope stays a cap).
 *  - Project-level service permissions narrow: min(workspace level, project
 *    level) when the request has a project context (projectNarrowing.ts).
 *  - Undeclared routes are refused: 403 { error, code: 'route_not_declared', message }.
 *  - `public` / `self` routes skip this gate (the handler is responsible),
 *    `authenticated` routes admit any signed-in principal of the tenant.
 *  - An engine denial is 403 { error, code: 'forbidden', message, service,
 *    required, decisionId }. `error` is the human-readable reason
 *    ('Forbidden: mcp requires write permission', see denialReason.ts), the same
 *    sentence `message` repeats; `code`, `service`, `required` and `decisionId`
 *    are the structured part.
 *
 * Failure semantics: if the principal cannot be built or the engine fails, the
 * request is REFUSED - 503 { error: 'Authorization is temporarily unavailable',
 * code: 'authorization_unavailable', decisionId } - never allowed and never
 * decided by some other rule set. The refusal is counted (`unavailable`), logged
 * and audited with its decisionId. Whether an outage is possible at all is
 * checked at boot (selfTest.ts: a server that cannot run the engine does not
 * start).
 *
 * Owner safety: the workspace owner's own signed-in session can always reach the
 * `iam` service (the Authorization center), whatever custom policies say and also
 * when the engine is down, so an owner can always repair the policies. That is a
 * promise about the session: an API token that happens to belong to the owner is
 * an ordinary principal, and a policy can still restrict it.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import type { IGroup } from '@/lib/database';
import {
  getRequiredPermissionLevel,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { gateActionId, serviceActionId } from './actions';
import { serviceDenialReason } from './denialReason';
import { authorizeGate, customPolicyIdsOf, type AuthorizeResult } from './engine';
import { tokenPrincipal, userLevelSets, userPrincipal, type IamPrincipal } from './entities';
import type { RouteAuthzLevel } from './routeAuthz';
import { lookupDefaultProjectId, narrowedLevelSets, projectDenySets, resolveNarrowingMembership, type NarrowingResult } from './projectNarrowing';
import { getProjectLevelsSince } from './projectLevels';
import { getPrincipalContext } from './principalCache';

const logger = createLogger('iam:enforce');

export type EnforceSource = 'engine' | 'owner-safety';

export interface EnforceGateInput {
  subject: 'session' | 'token';
  tenantDbName: string;
  tenantId: string;
  requestId: string;
  method: string;
  route: string;
  /** Session user, or the token OWNER, exactly as the gate loaded it. */
  userId: string;
  user: RbacUserLike & { projectIds?: string[] };
  /**
   * Session: the grants the gate loaded for this request (group edits apply at
   * once). Omitted = the cached principal context's. Token: ignored (the owner's
   * groups are read from the principal context).
   */
  groupGrants?: GroupTenantGrant[];
  /** The groups of the user (a token's owner): the ones behind `groupGrants`, so a cold principal load does not read them again. */
  groups?: IGroup[];
  tokenId?: string;
  tokenScope?: UserServicePermissions | null;
  /** The project the route path names, else cookie `active_project_id` (session) or the token's resolved project. */
  requestedProjectId?: string | null;
  /**
   * `requestedProjectId` came from the route path (`/projects/:projectId/...`): the
   * request acts ON that project, so it is the policy context and the only project
   * whose narrowing applies - never a cookie-chosen or fallback project.
   */
  projectFromPath?: boolean;
  service: PermissionService;
  level?: RouteAuthzLevel;
  /** Caller address as the server's trust-proxy setting resolves it (`request.ip`); policy context `ip`. */
  ip?: string | null;
  /** Canonical request path (no query string); policy context `path`. */
  path?: string;
  /**
   * Evaluate outside any project: no project narrowing and no default-project
   * fallback. Only the Authorization center sets it ("what can this person do in
   * the workspace itself, before a project limits it?"); the gates never do.
   */
  skipProjectNarrowing?: boolean;
  /** Bulk callers (the impact preview): read the principal cache but do not fill it. */
  noStore?: boolean;
}

/** Why no decision could be made. Coarse on purpose: the detailed error goes to the server log only. */
export type EnforceUnavailableReason = 'engine_unavailable' | 'principal_unavailable' | 'evaluation_error';

export interface EnforceDenial {
  allowed: false;
  source: 'engine';
  unavailable?: undefined;
  service: PermissionService;
  required: ServicePermissionLevel;
  decisionId: string;
  /**
   * For the audit row, never for the caller: the gate action that was evaluated,
   * the project context, and what decided it (Cedar ids and the custom policies
   * among them; empty = default deny).
   */
  action?: string;
  projectId?: string | null;
  reasons?: string[];
  policyIds?: string[];
}

/** No decision could be made: the caller is refused with 503, not 403. */
export interface EnforceUnavailable {
  allowed: false;
  source: 'unavailable';
  unavailable: true;
  service: PermissionService;
  required: ServicePermissionLevel;
  decisionId: string;
  reason: EnforceUnavailableReason;
  projectId?: string | null;
}

export type EnforceDecision =
  | { allowed: true; source: EnforceSource }
  | EnforceDenial
  | EnforceUnavailable;

// ── metrics ──────────────────────────────────────────────────────────────

export interface EnforceCounters {
  /** Service decisions taken by the engine. */
  engineDecisions: number;
  engineAllows: number;
  engineDenies: number;
  /** Requests refused with 503 because the engine could not decide. */
  unavailable: number;
  /** Refused because the route is not declared. */
  undeclaredDenies: number;
  /** Decisions made by the owner-safety rule. */
  ownerSafety: number;
  lastUnavailableAt: string | null;
  /**
   * Coarse category of the last refusal. The detailed error (which can name
   * hosts, paths or connection details) goes to the server log only, never to
   * the stats API.
   */
  lastUnavailableReason: EnforceUnavailableReason | null;
}

const zero = (): EnforceCounters => ({
  engineDecisions: 0,
  engineAllows: 0,
  engineDenies: 0,
  unavailable: 0,
  undeclaredDenies: 0,
  ownerSafety: 0,
  lastUnavailableAt: null,
  lastUnavailableReason: null,
});

const MAX_TENANTS = 5_000;
const processCounters = zero();
const tenantCounters = new Map<string, EnforceCounters>();

function counters(tenantDbName: string): EnforceCounters {
  let c = tenantCounters.get(tenantDbName);
  if (!c) {
    if (tenantCounters.size >= MAX_TENANTS) {
      const oldest = tenantCounters.keys().next().value as string | undefined;
      if (oldest !== undefined) tenantCounters.delete(oldest);
    }
    c = zero();
    tenantCounters.set(tenantDbName, c);
  }
  return c;
}

type NumericCounter = Exclude<keyof EnforceCounters, 'lastUnavailableAt' | 'lastUnavailableReason'>;

function bump(tenantDbName: string, key: NumericCounter): void {
  processCounters[key]++;
  counters(tenantDbName)[key]++;
}

export function getEnforceStats(): EnforceCounters {
  return { ...processCounters };
}

export function getTenantEnforceStats(tenantDbName: string): EnforceCounters {
  return { ...(tenantCounters.get(tenantDbName) ?? zero()) };
}

export function resetEnforceStatsForTests(): void {
  Object.assign(processCounters, zero());
  tenantCounters.clear();
  lastUnavailableLogAt = 0;
}

let lastUnavailableLogAt = 0;

/**
 * Count and log a refusal because no decision could be made, and mint the
 * decision id the caller is shown (it is also in the audit row). Returns the id.
 * Used by the decision below and by the gates when loading the caller fails.
 */
export function recordAuthorizationUnavailable(
  tenantDbName: string,
  reason: EnforceUnavailableReason,
  error: unknown,
  context: Record<string, unknown>,
): string {
  const decisionId = randomUUID();
  bump(tenantDbName, 'unavailable');
  const at = new Date().toISOString();
  for (const c of [processCounters, counters(tenantDbName)]) {
    c.lastUnavailableAt = at;
    c.lastUnavailableReason = reason;
  }
  // An engine outage must not turn into a log flood: one line per 10 s per process
  // (every refusal is still counted and audited with its own decision id).
  const now = Date.now();
  if (now - lastUnavailableLogAt >= 10_000) {
    lastUnavailableLogAt = now;
    const detail = error instanceof Error ? error.message : String(error ?? '');
    logger.error('IAM: authorization unavailable, request refused', {
      tenantDbName,
      decisionId,
      reason,
      error: detail.slice(0, 500),
      ...context,
    });
  }
  return decisionId;
}

// ── bodies ───────────────────────────────────────────────────────────────

/** An undeclared route: refused. Counts the denial. */
export function recordUndeclaredDenial(tenantDbName: string, context: Record<string, unknown>): void {
  bump(tenantDbName, 'undeclaredDenies');
  logger.warn('IAM: route is not declared, request refused', { tenantDbName, ...context });
}

/**
 * The 403 body of an undeclared route. `error` carries the reason itself, the
 * same sentence as `message`.
 */
export function undeclaredRouteBody(): { error: string; code: 'route_not_declared'; message: string } {
  const message = 'Forbidden: this route has no authorization declaration';
  return { error: message, code: 'route_not_declared', message };
}

/**
 * The 403 body of an engine denial. `error` is the human-readable reason
 * (serviceDenialReason), so an SDK or the dashboard that shows `body.error`
 * shows the reason; `message` repeats it, and `code`, `service`, `required` and
 * `decisionId` are the structured part.
 */
export function forbiddenBody(denial: Pick<EnforceDenial, 'service' | 'required' | 'decisionId'>): Record<string, unknown> {
  const message = serviceDenialReason(denial.service, denial.required);
  return {
    error: message,
    code: 'forbidden',
    message,
    service: denial.service,
    required: denial.required,
    decisionId: denial.decisionId,
  };
}

export const AUTHORIZATION_UNAVAILABLE_MESSAGE = 'Authorization is temporarily unavailable';

/** The 503 body of a refusal because the engine could not decide. */
export function unavailableBody(decisionId: string): { error: string; code: 'authorization_unavailable'; decisionId: string } {
  return { error: AUTHORIZATION_UNAVAILABLE_MESSAGE, code: 'authorization_unavailable', decisionId };
}

// ── principal ────────────────────────────────────────────────────────────

/** The principal of this request (groups, project narrowing, token cap). */
export async function buildEnforcePrincipal(input: EnforceGateInput): Promise<IamPrincipal> {
  return (await buildEnforcePrincipalWithNarrowing(input)).principal;
}

/** Like buildEnforcePrincipal, plus the project membership that narrowed it (null when nothing did). */
export async function buildEnforcePrincipalWithNarrowing(
  input: EnforceGateInput,
): Promise<{ principal: IamPrincipal; narrowing: NarrowingResult | null }> {
  // The first evaluation for a workspace records when its project-level
  // permissions start counting in full (projectLevels.ts); after that it is a map lookup.
  const [since, ctx] = await Promise.all([
    getProjectLevelsSince(input.tenantDbName),
    getPrincipalContext({
      tenantDbName: input.tenantDbName,
      tenantId: input.tenantId,
      userId: input.userId,
      user: input.user,
      groups: input.groups,
      withProjects: true,
      noStore: input.noStore,
    }),
  ]);
  // Sessions use the grants the gate just loaded (group edits apply at once);
  // tokens use the owner's grants from the principal context.
  const grants = input.subject === 'session' ? (input.groupGrants ?? ctx.groupGrants) : ctx.groupGrants;

  const narrowing = input.skipProjectNarrowing
    ? null
    : await resolveNarrowingMembership({
      tenantDbName: input.tenantDbName,
      tenantId: input.tenantId,
      userId: input.userId,
      role: typeof input.user.role === 'string' ? input.user.role : '',
      user: input.user,
      groupGrants: grants,
      requestedProjectId: input.requestedProjectId,
      exactProject: input.subject === 'token' || input.projectFromPath === true,
      context: ctx,
      since,
    });

  const owner: IamPrincipal = {
    ...userPrincipal({
      userId: input.userId,
      user: input.user,
      groupGrants: grants,
      groupIds: ctx.groupIds,
      projects: ctx.projects,
      adminProjects: ctx.adminProjects,
    }),
    sets: narrowing
      ? narrowedLevelSets(input.user, grants, narrowing.membership)
      : userLevelSets(input.user, grants),
    // The narrowing also as deny sets, so a custom permit cannot exceed it (boundary forbids).
    ...(narrowing ? { projDeny: projectDenySets(narrowing.membership) } : {}),
    // The project the handler will run in: what `context.projectId` means to a policy.
    contextProjectId: narrowing?.projectId ?? input.requestedProjectId ?? null,
  };
  if (!input.skipProjectNarrowing && !owner.contextProjectId && (input.user.role === 'owner' || input.user.role === 'admin')) {
    // Owners and admins without an active project run in the default one (resolveProjectContext). A read error
    // fails the principal (the gate answers 503): a rule that names a project must not silently stop matching.
    owner.contextProjectId = await lookupDefaultProjectId(input.tenantDbName, input.tenantId);
  }
  if (input.subject === 'token') {
    return {
      narrowing,
      principal: tokenPrincipal({
        tokenId: input.tokenId ?? 'unknown',
        owner,
        scope: input.tokenScope,
        projectId: narrowing?.projectId ?? input.requestedProjectId ?? null,
      }),
    };
  }
  return { principal: owner, narrowing };
}

// ── decision ─────────────────────────────────────────────────────────────

/**
 * The level the request needs. A request that cannot even be classified (no
 * usable method) counts as a write for the record; the engine step below
 * refuses it all the same, as it does any request it cannot build.
 */
function requiredLevelOf(input: EnforceGateInput): ServicePermissionLevel {
  if (input.level) return input.level;
  try {
    return getRequiredPermissionLevel(input.method, input.service);
  } catch {
    return 'write';
  }
}

/**
 * The decision for a request that resolves to a permission service. Never
 * throws: a failure of the engine is a refusal with its own decision id
 * (`unavailable: true`), not a guess.
 */
export async function decideEnforced(input: EnforceGateInput): Promise<EnforceDecision> {
  const required = requiredLevelOf(input);

  // The owner must always be able to repair the policies: this is a promise about
  // the owner's own signed-in session, decided before anything can fail.
  if (input.subject === 'session' && input.service === 'iam' && input.user.role === 'owner') {
    bump(input.tenantDbName, 'ownerSafety');
    return { allowed: true, source: 'owner-safety' };
  }

  const context = { requestId: input.requestId, route: input.route, service: input.service };
  const unavailable = (reason: EnforceUnavailableReason, error: unknown, projectId?: string | null): EnforceUnavailable => ({
    allowed: false,
    source: 'unavailable',
    unavailable: true,
    service: input.service,
    required,
    decisionId: recordAuthorizationUnavailable(input.tenantDbName, reason, error, context),
    reason,
    ...(projectId !== undefined ? { projectId } : {}),
  });

  let principal: IamPrincipal;
  try {
    principal = await buildEnforcePrincipal(input);
  } catch (error) {
    return unavailable('principal_unavailable', error);
  }

  let result: AuthorizeResult;
  try {
    result = await authorizeGate({
      tenant: input.tenantDbName,
      principal,
      service: input.service,
      method: input.method,
      level: input.level,
      context: {
        projectId: principal.contextProjectId,
        channel: input.subject === 'session' ? 'dashboard' : 'api',
        ip: input.ip,
        method: input.method,
        path: input.path,
      },
    });
  } catch (error) {
    return unavailable('evaluation_error', error, principal.contextProjectId ?? null);
  }

  if (result.failed) {
    return unavailable('engine_unavailable', result.errors.join(' | ') || 'engine failure', principal.contextProjectId ?? null);
  }

  bump(input.tenantDbName, 'engineDecisions');
  if (result.allowed) {
    bump(input.tenantDbName, 'engineAllows');
    return { allowed: true, source: 'engine' };
  }

  bump(input.tenantDbName, 'engineDenies');
  const denial: EnforceDenial = {
    allowed: false,
    source: 'engine',
    service: input.service,
    required,
    decisionId: randomUUID(),
    action: input.level ? serviceActionId(input.service, input.level) : gateActionId(input.service, input.method),
    projectId: principal.contextProjectId ?? null,
    reasons: result.reasons.slice(0, 10),
    policyIds: customPolicyIdsOf(result.reasons).slice(0, 10),
  };
  logger.info('IAM: request denied', {
    tenantDbName: input.tenantDbName,
    decisionId: denial.decisionId,
    requestId: input.requestId,
    userId: input.userId,
    subject: input.subject,
    tokenId: input.tokenId,
    service: input.service,
    required,
    method: input.method,
    route: input.route,
    reasons: result.reasons,
    errors: result.errors.length ? result.errors : undefined,
  });
  return denial;
}
