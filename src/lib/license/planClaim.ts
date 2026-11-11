/**
 * The optional `plan` claim of a license: the plan a hosted tenant is on and the
 * limits that come with it. Every value is written by the issuer as a plain
 * number, so this code never needs to know how a plan is priced or how its
 * values are derived. A limit that is absent means "no limit"; 0 means "none
 * allowed".
 *
 * Read only on hosted (saas) deployments, and only while plan limits are on
 * (see `src/lib/limits`). Unknown keys are ignored, so a license issued for a
 * newer release still activates on an older one.
 */

export interface LicensePlanConcurrentLimits {
  /** Agent turns in progress started from the console, a portal, a channel or a schedule. */
  agentSessions?: number;
  /** Flow runs in progress. */
  flows?: number;
  /** Background jobs in progress (evaluations, red-team, analysis, OCR, batch). */
  jobs?: number;
  /** Crawler jobs in progress. */
  crawlers?: number;
  /** Open browser sessions. */
  browserSessions?: number;
  /** Open realtime sessions. */
  realtimeSessions?: number;
  /** Running sandboxes. */
  sandboxes?: number;
}

export interface LicensePlanMonthlyLimits {
  /**
   * Accepted so older licenses still activate; not enforced. Hosted web search is paid per search
   * with credits and has no monthly allowance.
   */
  searches?: number;
  /** Flow runs per calendar month (UTC). */
  flowRuns?: number;
  /** Crawler pages per calendar month (UTC). */
  crawlerPages?: number;
  /** Sandbox hours per calendar month (UTC). */
  sandboxHours?: number;
}

export interface LicensePlanLimits {
  /** Requests per minute across every API entry point of the tenant. */
  apiRequestsPerMinute?: number;
  concurrent?: LicensePlanConcurrentLimits;
  monthly?: LicensePlanMonthlyLimits;
  /** Stored bytes the tenant may hold, in GB (10^9 bytes). */
  storageGb?: number;
  /** Longest realtime session, in minutes. */
  realtimeMaxSessionMinutes?: number;
  /** Largest sandbox size. */
  sandboxMaxSize?: { cpu: number; memoryMb: number };
}

export interface LicensePlanClaim {
  /** Claim format version. */
  v?: number;
  /** Plan id, e.g. `team`. */
  id: string;
  /** Display name. */
  name?: string;
  /** Capacity packs included in the limits below (shown to the tenant; limits are already multiplied). */
  capacityPacks?: number;
  /** Seats: console members (owner, admin, project_admin, user + pending invites) and portal users. */
  seats?: { console?: number; portal?: number };
  limits?: LicensePlanLimits;
  /**
   * Credits granted at the start of every calendar month (UTC), and what one is worth in USD as it was sold
   * (`usdPerCredit`, set by the CRM): spend is shown in USD at that rate. Absent rate = not known.
   */
  credits?: { includedPerMonth?: number; usdPerCredit?: number };
}

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Larger values are refused: they are almost certainly a typo. */
const MAX_LIMIT_VALUE = 1_000_000_000;
/** The highest USD per credit a license may carry (a guard against a typo, not a price policy). */
export const MAX_USD_PER_CREDIT = 1000;

class PlanClaimError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function limitValue(value: unknown, path: string, opts: { integer?: boolean } = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  const integer = opts.integer ?? true;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_LIMIT_VALUE) {
    throw new PlanClaimError(`License plan.${path} must be a number from 0 to ${MAX_LIMIT_VALUE}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new PlanClaimError(`License plan.${path} must be a whole number`);
  }
  return value;
}

function section(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new PlanClaimError(`License plan.${path} must be an object`);
  return value;
}

/** Drops keys whose value is undefined, so an empty section reads as absent. */
function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/**
 * Validates the `plan` claim at activation. A malformed claim is refused with a
 * message naming the field, so a bad license never reaches a tenant.
 */
export function normalizePlanClaim(value: unknown): LicensePlanClaim | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new PlanClaimError('License plan must be an object');

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!PLAN_ID_RE.test(id)) {
    throw new PlanClaimError('License plan.id must be a lowercase id (letters, digits, "-" or "_", at most 40)');
  }

  const claim: LicensePlanClaim = { id };

  if (value.v !== undefined) claim.v = limitValue(value.v, 'v');

  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 60) {
      throw new PlanClaimError('License plan.name must be a non-empty string of at most 60 characters');
    }
    claim.name = value.name.trim();
  }

  if (value.capacityPacks !== undefined) claim.capacityPacks = limitValue(value.capacityPacks, 'capacityPacks');

  // `enforcement` (shadow | on), written by older CRM releases, is ignored: a saas deployment always enforces.

  const seats = section(value.seats, 'seats');
  if (seats) {
    const normalized = compact({
      console: limitValue(seats.console, 'seats.console'),
      portal: limitValue(seats.portal, 'seats.portal'),
    });
    if (normalized) claim.seats = normalized;
  }

  const limits = section(value.limits, 'limits');
  if (limits) {
    const concurrent = section(limits.concurrent, 'limits.concurrent');
    const monthly = section(limits.monthly, 'limits.monthly');
    const sandboxMaxSize = section(limits.sandboxMaxSize, 'limits.sandboxMaxSize');

    const normalizedLimits: LicensePlanLimits = {};
    const apiRequestsPerMinute = limitValue(limits.apiRequestsPerMinute, 'limits.apiRequestsPerMinute');
    if (apiRequestsPerMinute !== undefined) normalizedLimits.apiRequestsPerMinute = apiRequestsPerMinute;

    if (concurrent) {
      const normalized = compact({
        agentSessions: limitValue(concurrent.agentSessions, 'limits.concurrent.agentSessions'),
        flows: limitValue(concurrent.flows, 'limits.concurrent.flows'),
        jobs: limitValue(concurrent.jobs, 'limits.concurrent.jobs'),
        crawlers: limitValue(concurrent.crawlers, 'limits.concurrent.crawlers'),
        browserSessions: limitValue(concurrent.browserSessions, 'limits.concurrent.browserSessions'),
        realtimeSessions: limitValue(concurrent.realtimeSessions, 'limits.concurrent.realtimeSessions'),
        sandboxes: limitValue(concurrent.sandboxes, 'limits.concurrent.sandboxes'),
      });
      if (normalized) normalizedLimits.concurrent = normalized;
    }

    if (monthly) {
      const normalized = compact({
        searches: limitValue(monthly.searches, 'limits.monthly.searches'),
        flowRuns: limitValue(monthly.flowRuns, 'limits.monthly.flowRuns'),
        crawlerPages: limitValue(monthly.crawlerPages, 'limits.monthly.crawlerPages'),
        sandboxHours: limitValue(monthly.sandboxHours, 'limits.monthly.sandboxHours'),
      });
      if (normalized) normalizedLimits.monthly = normalized;
    }

    const storageGb = limitValue(limits.storageGb, 'limits.storageGb', { integer: false });
    if (storageGb !== undefined) normalizedLimits.storageGb = storageGb;

    const realtimeMaxSessionMinutes = limitValue(limits.realtimeMaxSessionMinutes, 'limits.realtimeMaxSessionMinutes');
    if (realtimeMaxSessionMinutes !== undefined) normalizedLimits.realtimeMaxSessionMinutes = realtimeMaxSessionMinutes;

    if (sandboxMaxSize) {
      const cpu = limitValue(sandboxMaxSize.cpu, 'limits.sandboxMaxSize.cpu', { integer: false });
      const memoryMb = limitValue(sandboxMaxSize.memoryMb, 'limits.sandboxMaxSize.memoryMb');
      if (cpu === undefined || memoryMb === undefined) {
        throw new PlanClaimError('License plan.limits.sandboxMaxSize needs both cpu and memoryMb');
      }
      normalizedLimits.sandboxMaxSize = { cpu, memoryMb };
    }

    if (Object.keys(normalizedLimits).length > 0) claim.limits = normalizedLimits;
  }

  const credits = section(value.credits, 'credits');
  if (credits) {
    const usdPerCredit = limitValue(credits.usdPerCredit, 'credits.usdPerCredit', { integer: false });
    if (usdPerCredit !== undefined && usdPerCredit > MAX_USD_PER_CREDIT) {
      throw new PlanClaimError(`License plan.credits.usdPerCredit must be a number from 0 to ${MAX_USD_PER_CREDIT}`);
    }
    const normalized = compact({ includedPerMonth: limitValue(credits.includedPerMonth, 'credits.includedPerMonth'), usdPerCredit });
    if (normalized) claim.credits = normalized;
  }

  return claim;
}

/**
 * The stored claim, read defensively: it was validated at activation, but a bad
 * record must not break a request. A claim that no longer validates reads as
 * absent (the tenant falls back to the default plan).
 */
export function readStoredPlanClaim(value: unknown): LicensePlanClaim | undefined {
  try {
    return normalizePlanClaim(value);
  } catch {
    return undefined;
  }
}
