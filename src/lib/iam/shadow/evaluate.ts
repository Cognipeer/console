/**
 * Off-request evaluation of one legacy gate decision (C2 shadow mode).
 *
 * Four independent questions are asked of the engine for every mapped request,
 * each against the REAL legacy outcome (`legacy.allowed`) that rbac.ts already
 * returned to the caller:
 *
 *  1. PARITY   does the managed engine, fed the exact inputs the legacy gate
 *              used, reach the same decision?  A disagreement is a bug in the
 *              engine port (category `parity-mismatch`, must stay 0, logged at
 *              error level). Disagreements explained by the tenant's own custom
 *              policies are not parity bugs and are only counted.
 *  2. T1       API tokens ignore the owner's GROUP grants today. If they were
 *              included, would the decision change?  (`token-groups`)
 *  3. T2       the legacy gate ignores the active project. Candidate rule:
 *              effective = min(tenant level, project level) using
 *              getEffectiveProjectPermission on the user's merged project
 *              membership. Would it change the decision?  (`project-narrowing`)
 *              Owners and admins bypass project checks (as in
 *              resolveEffectivePermission) and are never narrowed.
 *  4. T3       unmapped paths are handled in observer.ts (no engine involved).
 *
 * Everything here runs from the bounded queue; a throw only increments
 * `evaluationFailures`. Nothing in this file can influence a response.
 */

import { createLogger } from '@/lib/core/logger';
import {
  getEffectiveProjectPermission,
  getEffectiveServicePermissionWithGroups,
  minPermission,
  type PermissionService,
} from '@/lib/security/rbac';
import { authorizeGate, customPolicyIdsOf, type AuthorizeResult } from '../engine';
import { levelSets, type IamPrincipal } from '../entities';
import { getPrincipalContext, resolveTokenPrincipal, resolveUserPrincipal } from '../principalCache';
import { recordShadowEvent } from './aggregate';
import { bumpTenantMetric, shadowMetrics } from './metrics';
import { resolveProjectMembershipCached } from './projectMembership';
import type { GateObservation, ShadowCategory } from './types';

const logger = createLogger('iam:shadow');

const ownerOrAdmin = (role: string) => role === 'owner' || role === 'admin';

/** active_project_id comes from a client cookie: only look up plausible ids. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function record(
  o: GateObservation,
  category: ShadowCategory,
  targetAllowed: boolean,
  detail?: string,
): void {
  recordShadowEvent(o.tenantDbName, {
    category,
    service: o.legacy.service,
    method: o.method.toUpperCase(),
    route: o.route,
    legacyAllowed: o.legacy.allowed,
    targetAllowed,
    sample: {
      requestId: o.requestId,
      userId: o.userId,
      tokenId: o.tokenId,
      role: o.role,
      at: new Date().toISOString(),
      detail,
    },
  });
}

function describeResult(result: AuthorizeResult): string {
  const parts = [`engine=${result.allowed ? 'allow' : 'deny'}`];
  if (result.reasons.length) parts.push(`reasons=${result.reasons.join(',')}`);
  if (result.errors.length) parts.push(`errors=${result.errors.join(' | ')}`);
  return parts.join(' ');
}

async function legacyPrincipal(o: GateObservation): Promise<IamPrincipal> {
  if (o.subject === 'token') {
    return resolveTokenPrincipal({
      tenantDbName: o.tenantDbName,
      tenantId: o.tenantId,
      tokenId: o.tokenId ?? 'unknown',
      ownerUserId: o.userId,
      owner: o.user,
      scope: o.tokenScope,
      projectId: o.activeProjectId,
      includeOwnerGroups: false,
    });
  }
  return resolveUserPrincipal({
    tenantDbName: o.tenantDbName,
    tenantId: o.tenantId,
    userId: o.userId,
    user: o.user,
    groupGrants: o.groupGrants,
  });
}

async function checkParity(o: GateObservation, principal: IamPrincipal): Promise<void> {
  const result = await authorizeGate({
    tenant: o.tenantDbName,
    principal,
    service: o.legacy.service,
    method: o.method,
  });
  if (result.allowed === o.legacy.allowed) return;

  if (customPolicyIdsOf(result.reasons).length > 0 && result.errors.length === 0) {
    // A tenant-authored policy decided; that is configuration, not an engine bug.
    shadowMetrics.customPolicyDiffs++;
    return;
  }

  shadowMetrics.parityMismatches++;
  bumpTenantMetric(o.tenantDbName, 'parityMismatches');
  const detail = `legacy=${o.legacy.allowed ? 'allow' : 'deny'} ${describeResult(result)}`;
  logger.error('IAM PARITY MISMATCH: the managed policy engine disagrees with rbac.ts', {
    tenantDbName: o.tenantDbName,
    requestId: o.requestId,
    userId: o.userId,
    service: o.legacy.service,
    method: o.method,
    route: o.route,
    detail,
  });
  record(o, 'parity-mismatch', result.allowed, detail);
}

async function checkTokenGroups(o: GateObservation): Promise<void> {
  const target = await resolveTokenPrincipal({
    tenantDbName: o.tenantDbName,
    tenantId: o.tenantId,
    tokenId: o.tokenId ?? 'unknown',
    ownerUserId: o.userId,
    owner: o.user,
    scope: o.tokenScope,
    projectId: o.activeProjectId,
    includeOwnerGroups: true,
  });
  if (target.groupIds.length === 0) return; // nothing a group could change
  const result = await authorizeGate({
    tenant: o.tenantDbName,
    principal: target,
    service: o.legacy.service,
    method: o.method,
  });
  if (result.allowed !== o.legacy.allowed) record(o, 'token-groups', result.allowed);
}

async function checkProjectNarrowing(o: GateObservation, base: IamPrincipal): Promise<void> {
  if (!o.activeProjectId || !PROJECT_ID_RE.test(o.activeProjectId)) return;
  // Tenant owners/admins bypass project checks, including users who are admin
  // only through a group's tenantRole (session path; tokens ignore groups).
  if (ownerOrAdmin(o.role)) return;
  if (o.subject === 'session' && o.groupGrants.some((g) => g.tenantRole && ownerOrAdmin(g.tenantRole))) return;
  const ctx = await getPrincipalContext({ tenantDbName: o.tenantDbName, tenantId: o.tenantId, userId: o.userId, user: o.user });
  const membership = await resolveProjectMembershipCached({
    tenantDbName: o.tenantDbName,
    userId: o.userId,
    userRole: o.role,
    projectId: o.activeProjectId,
    legacyProjectIds: o.user.projectIds,
    groupIds: ctx.groupIds,
  });
  if (!membership) return; // no project role/permissions there: nothing to narrow with

  // Tenant level exactly as the legacy gate computed it (sessions: with groups, tokens: without).
  const tenantGrants = o.subject === 'session' ? o.groupGrants : [];
  const narrowed: IamPrincipal = {
    ...base,
    sets: levelSets((service: PermissionService) =>
      minPermission(
        getEffectiveServicePermissionWithGroups(o.user, tenantGrants, service),
        getEffectiveProjectPermission(membership, service),
      ),
    ),
  };
  const result = await authorizeGate({
    tenant: o.tenantDbName,
    principal: narrowed,
    service: o.legacy.service,
    method: o.method,
  });
  if (result.allowed !== o.legacy.allowed) record(o, 'project-narrowing', result.allowed);
}

/** Evaluate one observation. Rejects on infrastructure errors (the queue counts them). */
export async function evaluateGateObservation(o: GateObservation): Promise<void> {
  const principal = await legacyPrincipal(o);
  const errors: unknown[] = [];

  const steps: Array<() => Promise<void>> = [
    () => checkParity(o, principal),
    () => (o.subject === 'token' ? checkTokenGroups(o) : Promise.resolve()),
    () => checkProjectNarrowing(o, principal),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  shadowMetrics.evaluated++;
  bumpTenantMetric(o.tenantDbName, 'evaluated');
  if (errors.length > 0) {
    logger.debug('Shadow evaluation step failed', {
      requestId: o.requestId,
      error: errors[0] instanceof Error ? (errors[0] as Error).message : String(errors[0]),
    });
    throw errors[0];
  }
}
