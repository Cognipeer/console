/**
 * The tenant's usage summary behind the usage page and its banner: plan,
 * capacity now and 24 h peak, monthly allowances, storage, seats, credits.
 * Reads only; every source is optional and a failing one is left out rather
 * than failing the page. Hosted (saas) deployments only (see mode.ts).
 */
import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import { getPlanCreditSummary, type PlanCreditSummary } from '@/enterprise/plan-limits';
import { listLimitEvents } from './events';
import { localRatePeek } from './localStore';
import { countPlanLeases } from './leases';
import { currentPeriod, getMonthlyUsage, monthlyLimitFor, periodEnd } from './meters';
import { getPeaks24h } from './peaks';
import { rpmKey } from './rpm';
import { countSeats } from './seats';
import { getStoredBytes } from './storage';
import { resolveTenantPlan } from './tenantLimits';
import type { ConcurrencyPool, PlanLimitsMode } from './types';

const log = createLogger('limits:usage');

export type CapacityDimension = 'apiRpm' | ConcurrencyPool;
export type MonthlyDimension = 'searches' | 'flowRuns' | 'crawlerPages' | 'sandboxHours';

export interface UsageRow<D extends string> {
  dimension: D;
  used: number;
  limit?: number;
  peak24h?: number;
}

export interface UsageBanner {
  id: string;
  severity: 'warning' | 'critical';
  dimension: string;
  used: number;
  limit: number;
}

export interface UsageSummary {
  mode: PlanLimitsMode;
  plan: null | {
    id: string;
    name?: string;
    source: 'license' | 'default';
    capacityPacks?: number;
    expiresAt?: string;
    seats: { console: { used: number; limit?: number }; portal: { used: number; limit?: number } };
  };
  capacity: Array<UsageRow<CapacityDimension>>;
  monthly: Array<UsageRow<MonthlyDimension>>;
  period: string;
  resetsAt: string;
  storage: { usedBytes: number; limitBytes?: number };
  credits: PlanCreditSummary | null;
  banners: UsageBanner[];
  counterScope: 'cluster' | 'pod';
}

export const CAPACITY_DIMENSIONS: readonly CapacityDimension[] = [
  'apiRpm',
  'agent',
  'flow',
  'job',
  'crawler',
  'browser',
  'realtime',
  'sandbox',
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** A capacity row that hit its limit this many times in 24 h raises a warning. */
export const CAPACITY_HIT_THRESHOLD = 3;

/** Percent of the limit in use, or null when there is no (or a zero) limit. */
function percent(used: number, limit: number | undefined): number | null {
  if (limit === undefined || limit <= 0) return null;
  return (used / limit) * 100;
}

export interface BannerInput {
  monthly: Array<UsageRow<MonthlyDimension>>;
  storage: { usedBytes: number; limitBytes?: number };
  credits: PlanCreditSummary | null;
  /** Limit hits in the last 24 h per capacity dimension (sum of event counts). */
  capacityHits: Partial<Record<CapacityDimension, number>>;
  capacity: Array<UsageRow<CapacityDimension>>;
}

/** Banners from already-read numbers (pure). Most severe first. */
export function computeBanners(input: BannerInput): UsageBanner[] {
  const banners: UsageBanner[] = [];
  for (const row of input.monthly) {
    const pct = percent(row.used, row.limit);
    if (pct === null || row.limit === undefined || pct < 80) continue;
    banners.push({
      id: `monthly:${row.dimension}`,
      severity: pct >= 100 ? 'critical' : 'warning',
      dimension: row.dimension,
      used: row.used,
      limit: row.limit,
    });
  }
  const storagePct = percent(input.storage.usedBytes, input.storage.limitBytes);
  if (storagePct !== null && input.storage.limitBytes !== undefined && storagePct >= 80) {
    banners.push({
      id: 'storage',
      severity: storagePct >= 100 ? 'critical' : 'warning',
      dimension: 'storage',
      used: input.storage.usedBytes,
      limit: input.storage.limitBytes,
    });
  }
  const credits = input.credits;
  if (credits) {
    const granted = credits.included.granted;
    // Banner numbers for credits: used = what is left, limit = what the month granted.
    // A plan without included credits that never had a lot or spend is not "out of credits".
    const everHad = granted > 0 || credits.prepaid.lots > 0 || credits.runwayDays !== undefined;
    if (credits.balance <= 0 && everHad) {
      banners.push({ id: 'credits', severity: 'critical', dimension: 'credits', used: credits.balance, limit: granted });
    } else if (granted > 0 && credits.balance <= granted * 0.05) {
      banners.push({ id: 'credits', severity: 'warning', dimension: 'credits', used: credits.balance, limit: granted });
    }
  }
  for (const row of input.capacity) {
    const hits = input.capacityHits[row.dimension] ?? 0;
    if (row.limit !== undefined && hits >= CAPACITY_HIT_THRESHOLD) {
      banners.push({ id: `capacity:${row.dimension}`, severity: 'warning', dimension: row.dimension, used: row.limit, limit: row.limit });
    }
  }
  return banners.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
}

async function softly<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    log.warn(`Usage summary: ${what} could not be read`, { error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

/** The requests counted in the current minute, from the bucket state (read only). */
async function currentRpm(tenantId: string, limit: number): Promise<number> {
  const key = rpmKey(tenantId);
  const now = Date.now();
  let tat: number | undefined;
  const cache = await getCache();
  if (cache.name === 'redis') {
    const stored = await cache.get<number>(key);
    tat = typeof stored === 'number' ? stored : undefined;
  } else {
    tat = localRatePeek(key, now);
  }
  if (tat === undefined || tat <= now) return 0;
  const interval = 60_000 / limit;
  return Math.min(limit, Math.round((tat - now) / interval));
}

/**
 * Builds the summary. Call inside the caller's tenant scope (seat and storage
 * counts read the tenant db). Returns null when plan limits are off for the tenant.
 * Must run inside the tenant's DB scope (runWithTenantScope); the EE provisioning plugin calls it that way.
 */
export async function buildUsageSummary(tenantId: string): Promise<UsageSummary | null> {
  const plan = await resolveTenantPlan(tenantId);
  if (plan.mode === 'off') return null;
  const limits = plan.limits;
  const period = currentPeriod();
  const cache = await getCache();
  const counterScope: 'cluster' | 'pod' = cache.name === 'redis' ? 'cluster' : 'pod';

  const [peaks, monthlyUsage, storedBytes, consoleSeats, portalSeats, credits, events, counts] = await Promise.all([
    softly('peaks', () => getPeaks24h(tenantId), {} as Record<string, number>),
    softly('monthly usage', () => getMonthlyUsage(tenantId, period), { searches: 0, flowRuns: 0, crawlerPages: 0, sandboxSeconds: 0 }),
    softly('storage', () => getStoredBytes(tenantId), 0),
    softly('console seats', () => countSeats(tenantId, 'console'), 0),
    softly('portal seats', () => countSeats(tenantId, 'portal'), 0),
    softly('credits', () => getPlanCreditSummary(tenantId), null),
    softly('events', () => listLimitEvents(tenantId, { since: new Date(Date.now() - DAY_MS), limit: 1000 }), []),
    Promise.all(
      CAPACITY_DIMENSIONS.map((dimension) =>
        softly(
          `${dimension} usage`,
          () =>
            dimension === 'apiRpm'
              ? limits?.apiRpm !== undefined && limits.apiRpm > 0
                ? currentRpm(tenantId, limits.apiRpm)
                : Promise.resolve(0)
              : countPlanLeases(tenantId, dimension),
          0,
        ),
      ),
    ),
  ]);

  const capacity: Array<UsageRow<CapacityDimension>> = CAPACITY_DIMENSIONS.map((dimension, index) => {
    const limit = dimension === 'apiRpm' ? limits?.apiRpm : limits?.concurrency[dimension];
    return {
      dimension,
      used: counts[index],
      ...(limit !== undefined ? { limit } : {}),
      ...(peaks[dimension] !== undefined ? { peak24h: peaks[dimension] } : {}),
    };
  });

  const monthlyLimits = limits?.monthly ?? {};
  const withLimit = <D extends MonthlyDimension>(dimension: D, used: number, limit: number | undefined): UsageRow<D> =>
    limit === undefined ? { dimension, used } : { dimension, used, limit };
  const monthly: Array<UsageRow<MonthlyDimension>> = [
    // Counted only: hosted web search is paid per search with credits.
    { dimension: 'searches', used: monthlyUsage.searches },
    withLimit('flowRuns', monthlyUsage.flowRuns, monthlyLimitFor(monthlyLimits, 'flowRuns')),
    withLimit('crawlerPages', monthlyUsage.crawlerPages, monthlyLimitFor(monthlyLimits, 'crawlerPages')),
    withLimit('sandboxHours', Math.round((monthlyUsage.sandboxSeconds / 3600) * 100) / 100, monthlyLimits.sandboxHours),
  ];

  const storage = { usedBytes: storedBytes, ...(limits?.storageBytes !== undefined ? { limitBytes: limits.storageBytes } : {}) };

  const capacityHits: Partial<Record<CapacityDimension, number>> = {};
  for (const event of events) {
    if (event.kind !== 'api_rpm' && event.kind !== 'concurrency') continue;
    if (event.outcome !== 'refused') continue;
    const dimension = (event.kind === 'api_rpm' ? 'apiRpm' : event.dimension) as CapacityDimension | undefined;
    if (!dimension || !CAPACITY_DIMENSIONS.includes(dimension)) continue;
    capacityHits[dimension] = (capacityHits[dimension] ?? 0) + (event.count || 1);
  }

  return {
    mode: plan.mode,
    plan: limits
      ? {
          id: limits.plan,
          ...(limits.planName ? { name: limits.planName } : {}),
          source: limits.source,
          ...(limits.capacityPacks !== undefined ? { capacityPacks: limits.capacityPacks } : {}),
          ...(limits.expiresAt ? { expiresAt: limits.expiresAt.toISOString() } : {}),
          seats: {
            console: { used: consoleSeats, ...(limits.seats.console !== undefined ? { limit: limits.seats.console } : {}) },
            portal: { used: portalSeats, ...(limits.seats.portal !== undefined ? { limit: limits.seats.portal } : {}) },
          },
        }
      : null,
    capacity,
    monthly,
    period,
    resetsAt: periodEnd(period).toISOString(),
    storage,
    credits,
    banners: computeBanners({ monthly, storage, credits, capacityHits, capacity }),
    counterScope,
  };
}
