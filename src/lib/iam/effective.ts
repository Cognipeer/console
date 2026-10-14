/**
 * Effective levels: what a principal can do with each service, as the engine
 * decides it.
 *
 * A service level is the highest of read -> write -> admin that is allowed when
 * every lower one is (a custom policy that forbids reading leaves nothing
 * usable, however much it allows above). Two ways to get it:
 *
 *  - a workspace without custom policies is decided by the managed rules alone,
 *    and those are pure arithmetic over the principal's level sets - which is how
 *    the engine itself reads them (managedPolicies.ts) - so the level comes
 *    straight from the principal, no Cedar call at all;
 *  - a workspace with custom policies is probed through the engine, one decision
 *    per level and service (up to three per service), memoised for a few
 *    seconds: the answer is a pure function of the policy set, the principal and
 *    the context.
 *
 * Used by the session payload (`GET /api/auth/session` -> effectivePermissions,
 * for navigation) and by the Authorization center's effective-permissions table.
 */

import { createHash } from 'node:crypto';
import type { IUser } from '@/lib/database';
import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { serviceActionId } from './actions';
import type { IamRequestContext } from './context';
import { authorize, describeTenantPolicySet } from './engine';
import { buildEnforcePrincipalWithNarrowing } from './enforce';
import { isAdminService, type IamPrincipal } from './entities';

export type EffectiveLevel = 'none' | 'read' | 'write' | 'admin';

const LEVELS: ReadonlyArray<'read' | 'write' | 'admin'> = ['read', 'write', 'admin'];

/** Services a level is reported for: everything but the retired ones. */
export const EFFECTIVE_SERVICES: readonly string[] = RBAC_SERVICE_DEFINITIONS.filter((d) => !d.deprecated).map((d) => d.id);

/** The managed rules' answer for one service, from the principal's level sets (no custom policy considered). */
export function managedLevel(principal: IamPrincipal, service: string): EffectiveLevel {
  const owner = principal.sets;
  const adminService = isAdminService(service);
  let read: boolean;
  let write: boolean;
  let admin: boolean;
  if (principal.kind === 'token' && principal.token) {
    const t = principal.token;
    read = owner.readSvcs.includes(service) && (!t.scoped || t.capRead.includes(service));
    admin = owner.adminSvcs.includes(service) && (!t.scoped || t.capAdmin.includes(service));
    write = owner.writeSvcs.includes(service) && (!t.scoped || t.capWrite.includes(service)) && (!adminService || admin);
  } else {
    read = owner.readSvcs.includes(service);
    admin = owner.adminSvcs.includes(service);
    write = owner.writeSvcs.includes(service) && (!adminService || admin);
  }
  return read ? (write ? (admin ? 'admin' : 'write') : 'read') : 'none';
}

/** One service, probed through the engine: the level reached and the Cedar ids that took part. */
export async function probeServiceLevel(
  tenantDbName: string,
  principal: IamPrincipal,
  service: string,
  context: IamRequestContext,
): Promise<{ level: EffectiveLevel; reasons: string[] }> {
  let level: EffectiveLevel = 'none';
  const reasons: string[] = [];
  for (const candidate of LEVELS) {
    const res = await authorize({
      tenant: tenantDbName,
      principal,
      action: serviceActionId(service, candidate),
      resource: { kind: 'service', service },
      context,
    });
    reasons.push(...res.reasons);
    if (res.failed) throw new Error(res.errors.join('; ') || 'the engine could not decide');
    if (!res.allowed) break;
    level = candidate;
  }
  return { level, reasons };
}

// ── memo ─────────────────────────────────────────────────────────────────

const MEMO_TTL_MS = 15_000;
const MEMO_MAX = 1_000;
const memo = new Map<string, { levels: Record<string, EffectiveLevel>; expiresAt: number }>();

export function resetEffectiveLevelsForTests(): void {
  memo.clear();
}

export interface EffectiveLevels {
  levels: Record<string, EffectiveLevel>;
  /** `managed`: computed from the principal alone (no custom policy in force); `engine`: probed through the engine. */
  source: 'managed' | 'engine';
}

/**
 * The level of every service for this principal. Throws when the engine cannot
 * decide (the caller decides what a missing answer means: the session payload
 * leaves the field out, a refusal elsewhere is a 503).
 */
export async function computeEffectiveLevels(
  tenantDbName: string,
  principal: IamPrincipal,
  context: IamRequestContext = {},
): Promise<EffectiveLevels> {
  const policySet = await describeTenantPolicySet(tenantDbName);
  if (policySet.custom === 0) {
    const levels: Record<string, EffectiveLevel> = {};
    for (const service of EFFECTIVE_SERVICES) levels[service] = managedLevel(principal, service);
    return { levels, source: 'managed' };
  }

  // `now` is left out of the key on purpose (it moves every call); the TTL bounds how stale a time-window rule can be.
  const key = `${tenantDbName}|${policySet.setId}|${policySet.version}|${createHash('sha1')
    .update(JSON.stringify([principal, context.projectId ?? null, context.channel ?? null, context.ip ?? null]))
    .digest('hex')}`;
  const hit = memo.get(key);
  if (hit && hit.expiresAt > Date.now()) return { levels: { ...hit.levels }, source: 'engine' };

  const levels: Record<string, EffectiveLevel> = {};
  for (const service of EFFECTIVE_SERVICES) {
    levels[service] = (await probeServiceLevel(tenantDbName, principal, service, context)).level;
  }
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value as string | undefined;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, { levels, expiresAt: Date.now() + MEMO_TTL_MS });
  return { levels: { ...levels }, source: 'engine' };
}

// ── the signed-in user ───────────────────────────────────────────────────

export interface SessionEffectivePermissions {
  /** Level of every (non-retired) service for the active project, as the engine decides it. */
  levels: Record<string, EffectiveLevel>;
  /** The project the levels were computed for (the one the request runs in); null = none. */
  projectId: string | null;
  source: EffectiveLevels['source'];
}

/**
 * The levels the signed-in user has in their active project (the session cookie's
 * project, else the one the gate would pick) - the data behind project-aware
 * navigation. Built the way the session gate builds the principal, from the
 * CACHED principal context: nothing is read from the database when it is warm.
 * Throws when the engine cannot decide.
 */
export async function computeSessionEffectivePermissions(input: {
  tenantDbName: string;
  tenantId: string;
  /** The user row (the caller loaded it). */
  user: IUser;
  activeProjectId?: string | null;
  ip?: string | null;
}): Promise<SessionEffectivePermissions> {
  const { principal } = await buildEnforcePrincipalWithNarrowing({
    subject: 'session',
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    requestId: 'session-permissions',
    method: 'GET',
    route: '/api/auth/session',
    userId: String(input.user._id),
    user: input.user,
    requestedProjectId: input.activeProjectId ?? null,
    service: 'iam',
    ip: input.ip,
  });
  const { levels, source } = await computeEffectiveLevels(input.tenantDbName, principal, {
    projectId: principal.contextProjectId,
    channel: 'dashboard',
    ip: input.ip,
  });
  // Owner safety (enforce.ts): the workspace owner's own session always reaches the Authorization center, whatever
  // a rule says, so the menu must not hide it from the one person who can repair the rules.
  if (input.user.role === 'owner') levels.iam = 'admin';
  return { levels, projectId: principal.contextProjectId ?? null, source };
}
