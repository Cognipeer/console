/**
 * Seat limits. Console seats = accounts that can sign in with owner, admin,
 * project_admin or user; portal seats = portal_user. Pending invitations are
 * user rows (status active, not yet accepted), so the user count already
 * includes them. Disabled accounts, service accounts and external (host
 * application) people are not seats. Counted through `iamCountUsers`, which
 * reads the TENANT db: call inside the caller's tenant scope.
 */
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { decideLimit } from './decide';
import { PlanLimitError } from './errors';
import { outcomeEventFor } from './events';
import { resolveTenantPlan } from './tenantLimits';
import type { PlanLimitDecision, PlanLimitSource } from './types';

const log = createLogger('limits:seats');

export type SeatKind = 'console' | 'portal';

export const CONSOLE_SEAT_ROLES = ['owner', 'admin', 'project_admin', 'user'] as const;
export const PORTAL_SEAT_ROLES = ['portal_user'] as const;

/** Seats in use for one kind (people who can sign in, invited ones included). */
export async function countSeats(tenantId: string, kind: SeatKind): Promise<number> {
  const db = await getDatabase();
  return db.iamCountUsers({
    tenantId,
    roles: [...(kind === 'portal' ? PORTAL_SEAT_ROLES : CONSOLE_SEAT_ROLES)],
    status: 'active',
    canLogin: true,
    external: false,
  });
}

export async function checkSeats(input: {
  tenantId: string;
  kind: SeatKind;
  adding?: number;
  source?: PlanLimitSource;
}): Promise<PlanLimitDecision> {
  const { tenantId, kind } = input;
  const plan = await resolveTenantPlan(tenantId);
  const limit = plan.limits?.seats[kind];
  if (plan.mode === 'off' || limit === undefined) {
    return { allowed: true, outcome: 'allowed', kind: 'seats', dimension: kind, limit };
  }
  let used: number;
  try {
    used = await countSeats(tenantId, kind);
  } catch (error) {
    log.warn('Seats could not be counted, failing open', {
      tenantId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true, outcome: 'allowed', kind: 'seats', dimension: kind, limit };
  }
  const decision = decideLimit({
    kind: 'seats',
    dimension: kind,
    mode: plan.mode,
    limit,
    used,
    amount: input.adding ?? 1,
  });
  if (decision.outcome !== 'allowed') {
    outcomeEventFor(decision, { tenantId, source: input.source });
  }
  return decision;
}

export async function assertSeats(input: {
  tenantId: string;
  kind: SeatKind;
  adding?: number;
  source?: PlanLimitSource;
}): Promise<void> {
  const decision = await checkSeats(input);
  if (decision.allowed) return;
  throw new PlanLimitError({
    code: 'seat_limit_reached',
    message: `All ${decision.limit} ${input.kind} seats are in use.`,
    kind: 'seats',
    dimension: input.kind,
    limit: decision.limit,
    used: decision.used,
  });
}

/** The seat kind an account takes (portal users: portal; every other role: console). */
export function seatKindOfRole(role: string | undefined): SeatKind {
  return role === 'portal_user' ? 'portal' : 'console';
}

/**
 * Re-enabling a disabled account puts it back among the seats: refused (on) when none is left. Accounts
 * that cannot sign in, external people and accounts that are not disabled take no seat, so nothing is checked.
 */
export async function assertSeatForReEnable(input: {
  tenantId: string;
  user: { role?: string; status?: string; canLogin?: boolean; kind?: string } | null | undefined;
  source?: PlanLimitSource;
}): Promise<void> {
  const { user } = input;
  if (!user || user.status !== 'disabled' || user.canLogin === false || user.kind === 'external') return;
  await assertSeats({ tenantId: input.tenantId, kind: seatKindOfRole(user.role), source: input.source });
}
