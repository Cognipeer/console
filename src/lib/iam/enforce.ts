/**
 * Enforce mode (C4): the policy engine decides, with the TARGET semantics.
 *
 *  - API tokens include the owner's GROUP grants (the token scope stays a cap).
 *  - Project-level service permissions narrow: min(tenant level, project level)
 *    when the request has a project context (projectNarrowing.ts).
 *  - Undeclared routes are refused: 403 { error: 'Forbidden', code: 'route_not_declared' }.
 *  - `public` / `self` routes skip this gate (the handler is responsible),
 *    `authenticated` routes admit any signed-in principal of the tenant.
 *  - An engine denial is 403 { error: 'Forbidden', code: 'forbidden', service,
 *    required, decisionId }.
 *
 * Never fails open beyond legacy: if the engine is unavailable or throws, the
 * LEGACY decision (the one rbac.ts already computed for the same request) is
 * used, and the fallback is counted and logged.
 *
 * Owner safety: the tenant owner can always reach the `iam` service (the
 * authorization-engine settings, i.e. the switch back to legacy), whatever
 * custom policies say, and also when the engine is down.
 *
 * Only reached when the tenant's stored mode is `enforce` and IAM_ENFORCE_DISABLED
 * is not set (shadow/mode.ts resolveEnforcement); legacy and shadow tenants
 * never load this file.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import {
  getRequiredPermissionLevel,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { gateActionId, serviceActionId } from './actions';
import { authorizeGate, customPolicyIdsOf, type AuthorizeResult } from './engine';
import { tokenPrincipal, userLevelSets, userPrincipal, type IamPrincipal } from './entities';
import type { RouteAuthzLevel } from './routeAuthz';
import { getDefaultProjectId, narrowedLevelSets, projectDenySets, resolveNarrowingMembership, type NarrowingResult } from './projectNarrowing';
import { getPrincipalContext } from './principalCache';
import { recordPolicyMonitor } from './shadow/policyMonitor';

const logger = createLogger('iam:enforce');

export type EnforceSource = 'engine' | 'legacy-fallback' | 'owner-safety';

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
  /** Session: the grants the gate loaded for this request. Token: ignored (the owner's groups are read from the principal context). */
  groupGrants: GroupTenantGrant[];
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
  /** The legacy decision for the same request (fallback + owner safety). */
  legacyAllowed: boolean;
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
}

export type EnforceDecision =
  | { allowed: true; source: EnforceSource }
  | {
      allowed: false;
      source: EnforceSource;
      service: PermissionService;
      required: ServicePermissionLevel;
      decisionId: string;
      /**
       * Engine denials only - for the audit row, never for the caller: the gate
       * action that was evaluated, the project context, and what decided it (Cedar
       * ids and the custom policies among them; empty = default deny).
       */
      action?: string;
      projectId?: string | null;
      reasons?: string[];
      policyIds?: string[];
    };

// ── metrics ──────────────────────────────────────────────────────────────

export interface EnforceCounters {
  /** Service decisions taken by the engine. */
  engineDecisions: number;
  engineAllows: number;
  engineDenies: number;
  /** Engine failed -> legacy decision used. */
  fallbacks: number;
  /** Refused because the route is not declared. */
  undeclaredDenies: number;
  /** Decisions made by the owner-safety rule. */
  ownerSafety: number;
  lastFallbackAt: string | null;
  /**
   * Coarse category of the last fallback. The detailed error (which can name
   * hosts, paths or connection details) goes to the server log only, never to
   * the stats API.
   */
  lastFallbackReason: EnforceFallbackReason | null;
}

export type EnforceFallbackReason = 'engine_unavailable' | 'principal_unavailable' | 'evaluation_error';

const zero = (): EnforceCounters => ({
  engineDecisions: 0,
  engineAllows: 0,
  engineDenies: 0,
  fallbacks: 0,
  undeclaredDenies: 0,
  ownerSafety: 0,
  lastFallbackAt: null,
  lastFallbackReason: null,
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

type NumericCounter = Exclude<keyof EnforceCounters, 'lastFallbackAt' | 'lastFallbackReason'>;

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
  lastFallbackLogAt = 0;
}

let lastFallbackLogAt = 0;

function recordFallback(
  tenantDbName: string,
  reason: EnforceFallbackReason,
  detail: string,
  context: Record<string, unknown>,
): void {
  bump(tenantDbName, 'fallbacks');
  const at = new Date().toISOString();
  for (const c of [processCounters, counters(tenantDbName)]) {
    c.lastFallbackAt = at;
    c.lastFallbackReason = reason;
  }
  // An engine outage must not turn into a log flood: one line per 10 s per process.
  const now = Date.now();
  if (now - lastFallbackLogAt >= 10_000) {
    lastFallbackLogAt = now;
    logger.error('IAM enforce: policy engine unavailable, using the legacy decision', {
      tenantDbName,
      reason,
      error: detail.slice(0, 500),
      ...context,
    });
  }
}

// ── decisions ────────────────────────────────────────────────────────────

/** An undeclared route in enforce mode: refused. Counts the denial. */
export function recordUndeclaredDenial(tenantDbName: string, context: Record<string, unknown>): void {
  bump(tenantDbName, 'undeclaredDenies');
  logger.warn('IAM enforce: route is not declared, request refused', { tenantDbName, ...context });
}

export function undeclaredRouteBody(): { error: 'Forbidden'; code: 'route_not_declared'; message: string } {
  return {
    error: 'Forbidden',
    code: 'route_not_declared',
    message: 'Forbidden: this route has no authorization declaration',
  };
}

export function forbiddenBody(denial: Extract<EnforceDecision, { allowed: false }>): Record<string, unknown> {
  return {
    error: 'Forbidden',
    code: 'forbidden',
    message: `Forbidden: ${denial.service} requires ${denial.required} permission`,
    service: denial.service,
    required: denial.required,
    decisionId: denial.decisionId,
  };
}

/** The target-semantics principal of this request (groups, project narrowing, token cap). */
export async function buildEnforcePrincipal(input: EnforceGateInput): Promise<IamPrincipal> {
  return (await buildEnforcePrincipalWithNarrowing(input)).principal;
}

/** Like buildEnforcePrincipal, plus the project membership that narrowed it (null when nothing did). */
export async function buildEnforcePrincipalWithNarrowing(
  input: EnforceGateInput,
): Promise<{ principal: IamPrincipal; narrowing: NarrowingResult | null }> {
  const ctx = await getPrincipalContext({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    userId: input.userId,
    user: input.user,
    withProjects: true,
  });
  // Sessions use the grants the gate just loaded (group edits apply at once);
  // tokens use the owner's grants from the principal context (decision 1).
  const grants = input.subject === 'session' ? input.groupGrants : ctx.groupGrants;

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
    // Owners and admins without an active project run in the default one (resolveProjectContext).
    owner.contextProjectId = await getDefaultProjectId(input.tenantDbName, input.tenantId);
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

/**
 * The enforce-mode decision for a request that resolves to a permission
 * service. Never throws: any failure of the engine is the legacy decision.
 */
export async function decideEnforced(input: EnforceGateInput): Promise<EnforceDecision> {
  const required = input.level ?? getRequiredPermissionLevel(input.method, input.service);
  const deny = (source: EnforceSource): EnforceDecision => ({
    allowed: false,
    source,
    service: input.service,
    required,
    decisionId: randomUUID(),
  });
  const fromLegacy = (source: EnforceSource): EnforceDecision =>
    input.legacyAllowed ? { allowed: true, source } : deny(source);

  // The owner must always be able to switch the mode back. That is a promise
  // about the owner's own signed-in session: an API token that happens to belong
  // to the owner is an ordinary principal here, so a policy can still restrict it.
  if (input.subject === 'session' && input.service === 'iam' && input.user.role === 'owner') {
    bump(input.tenantDbName, 'ownerSafety');
    return fromLegacy('owner-safety');
  }

  const context = { requestId: input.requestId, route: input.route, service: input.service };
  let principal: IamPrincipal;
  try {
    principal = await buildEnforcePrincipal(input);
  } catch (error) {
    recordFallback(input.tenantDbName, 'principal_unavailable', error instanceof Error ? error.message : String(error), context);
    return fromLegacy('legacy-fallback');
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
    recordFallback(input.tenantDbName, 'evaluation_error', error instanceof Error ? error.message : String(error), context);
    return fromLegacy('legacy-fallback');
  }

  if (result.failed) {
    recordFallback(input.tenantDbName, 'engine_unavailable', result.errors.join(' | ') || 'engine failure', context);
    return fromLegacy('legacy-fallback');
  }

  // A monitor-mode policy that would have changed this decision: count it (per policy / route / direction).
  recordPolicyMonitor(input.tenantDbName, result, {
    service: input.service,
    method: input.method,
    route: input.route,
    requestId: input.requestId,
    userId: input.userId,
    tokenId: input.tokenId,
    role: typeof input.user.role === 'string' ? input.user.role : '',
  });

  bump(input.tenantDbName, 'engineDecisions');
  if (result.allowed) {
    bump(input.tenantDbName, 'engineAllows');
    return { allowed: true, source: 'engine' };
  }

  bump(input.tenantDbName, 'engineDenies');
  const denial = {
    ...(deny('engine') as Extract<EnforceDecision, { allowed: false }>),
    action: input.level ? serviceActionId(input.service, input.level) : gateActionId(input.service, input.method),
    projectId: principal.contextProjectId ?? null,
    reasons: result.reasons.slice(0, 10),
    policyIds: customPolicyIdsOf(result.reasons).slice(0, 10),
  };
  logger.info('IAM enforce: request denied', {
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
    legacyAllowed: input.legacyAllowed,
    reasons: result.reasons,
    errors: result.errors.length ? result.errors : undefined,
  });
  return denial;
}
