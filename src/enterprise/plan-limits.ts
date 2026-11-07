/**
 * Plan limits seam — COMMUNITY (open-source) edition.
 *
 * The community edition has no default plan and no credits: a hosted tenant
 * without a `plan` claim in its license has no plan limits, and the usage page
 * shows no credit section. The overlay fills both in from its `registry.ts`
 * by calling `registerPlanLimitsContribution(...)` once at load.
 *
 * Leaf module: no imports beyond types, so the overlay can import it at load.
 */
import type { LicensePlanClaim } from '@/lib/license/planClaim';

/** Credit balance shown on the usage page and in the CRM. */
export interface PlanCreditSummary {
  /** Spendable credits now (included this month + prepaid). Can be below 0 by at most one call. */
  balance: number;
  included: {
    /** Calendar month (UTC), `YYYY-MM`. */
    period: string;
    granted: number;
    used: number;
    /** ISO time the included credits end (start of next month, UTC). */
    endsAt: string;
  };
  prepaid: {
    remaining: number;
    /** Open prepaid lots (each redeemed code is one lot). */
    lots: number;
    /** ISO time the earliest lot ends, when any lot ends. */
    nextExpiry?: string;
  };
  /** Days the balance lasts at the last 7 days' spend; absent when there was no spend. */
  runwayDays?: number;
}

export interface PlanLimitsContribution {
  /** The plan a hosted tenant is on when its license has no `plan` claim (or it has no license). */
  defaultPlan?: () => LicensePlanClaim | null;
  /** The tenant's credit balance; null when credits do not apply to it. */
  creditSummary?: (tenantId: string) => Promise<PlanCreditSummary | null>;
}

let contribution: PlanLimitsContribution = {};

/** Called once by the overlay at load. A second call replaces the first. */
export function registerPlanLimitsContribution(next: PlanLimitsContribution): void {
  contribution = { ...next };
}

/** The default plan, or null when none is registered (community edition). */
export function getDefaultPlanClaim(): LicensePlanClaim | null {
  try {
    return contribution.defaultPlan?.() ?? null;
  } catch {
    return null;
  }
}

/** The credit summary, or null when credits are not part of this edition (or do not apply to the tenant). */
export async function getPlanCreditSummary(tenantId: string): Promise<PlanCreditSummary | null> {
  if (!contribution.creditSummary) return null;
  return contribution.creditSummary(tenantId);
}

/** Tests only. */
export function resetPlanLimitsContributionForTests(): void {
  contribution = {};
}
