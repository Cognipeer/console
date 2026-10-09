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
 *  3. T2       the legacy gate ignores the active project. Rule (projectNarrowing.ts,
 *              the same code enforce mode runs): effective = min(tenant level,
 *              the explicit project-level setting of the user's merged project
 *              membership). Would it change the decision?  (`project-narrowing`)
 *              Owners and admins bypass project checks (as in
 *              resolveEffectivePermission) and are never narrowed.
 *  4. T3       unmapped paths are handled in observer.ts (no engine involved).
 *
 * Everything here runs from the bounded queue; a throw only increments
 * `evaluationFailures`. Nothing in this file can influence a response.
 */

import { createLogger } from '@/lib/core/logger';
import { authorizeGate, customPolicyIdsOf, type AuthorizeResult } from '../engine';
import { type IamPrincipal } from '../entities';
import { narrowedLevelSets, projectDenySets, resolveNarrowingMembership } from '../projectNarrowing';
import { resolveTokenPrincipal, resolveUserPrincipal } from '../principalCache';
import type { IamRequestContext } from '../context';
import { recordShadowEvent } from './aggregate';
import { bumpTenantMetric, shadowMetrics } from './metrics';
import { resolveEnforcement } from './mode';
import { recordPolicyMonitor } from './policyMonitor';
import type { GateObservation, ShadowCategory } from './types';

const logger = createLogger('iam:shadow');

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

/** The request context a policy can condition on, as the enforce gate builds it for the same request. */
function gateContext(o: GateObservation, projectId?: string | null): IamRequestContext {
  return {
    projectId: projectId ?? o.activeProjectId ?? undefined,
    channel: o.subject === 'session' ? 'dashboard' : 'api',
    ip: o.ip,
    method: o.method,
    path: o.pathname,
  };
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
    level: o.legacy.level,
    context: gateContext(o),
  });

  // Monitor-mode policies that would change the decision. Enforce tenants record
  // them from the real decision (enforce.ts), so only count them here when this
  // evaluation is all the engine does for the tenant.
  if (result.monitor?.differs && !(await resolveEnforcement(o.tenantDbName))) {
    recordPolicyMonitor(o.tenantDbName, result, {
      service: o.legacy.service,
      method: o.method,
      route: o.route,
      requestId: o.requestId,
      userId: o.userId,
      tokenId: o.tokenId,
      role: o.role,
    });
  }

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
    level: o.legacy.level,
    context: gateContext(o),
  });
  if (result.allowed !== o.legacy.allowed) record(o, 'token-groups', result.allowed);
}

async function checkProjectNarrowing(o: GateObservation, base: IamPrincipal): Promise<void> {
  // Tenant level exactly as the legacy gate computed it (sessions: with groups, tokens: without).
  const tenantGrants = o.subject === 'session' ? o.groupGrants : [];
  const narrowing = await resolveNarrowingMembership({
    tenantDbName: o.tenantDbName,
    tenantId: o.tenantId,
    userId: o.userId,
    role: o.role,
    user: o.user,
    groupGrants: tenantGrants,
    requestedProjectId: o.activeProjectId,
    exactProject: o.subject === 'token' || o.projectFromPath === true,
  });
  if (!narrowing) return; // privileged, no project, or no membership there: nothing to narrow with

  const narrowed: IamPrincipal = {
    ...base,
    sets: narrowedLevelSets(o.user, tenantGrants, narrowing.membership),
    projDeny: projectDenySets(narrowing.membership),
  };
  const result = await authorizeGate({
    tenant: o.tenantDbName,
    principal: narrowed,
    service: o.legacy.service,
    method: o.method,
    level: o.legacy.level,
    context: gateContext(o, narrowing.projectId),
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
