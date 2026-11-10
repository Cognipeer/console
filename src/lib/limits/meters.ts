/**
 * Calendar-month (UTC) allowances: searches, flow runs, crawler pages, sandbox time.
 */
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { decideLimit } from './decide';
import { PlanLimitError } from './errors';
import { outcomeEventFor } from './events';
import { resolveTenantPlan } from './tenantLimits';
import type { MonthlyMeter, PlanLimitDecision, PlanLimitSource } from './types';

const log = createLogger('limits:meters');

const READ_CACHE_TTL_MS = 10_000;
const READ_CACHE_MAX = 10_000;

export const MONTHLY_METERS: readonly MonthlyMeter[] = ['searches', 'flowRuns', 'crawlerPages', 'sandboxSeconds'];

export type MonthlyUsage = Record<MonthlyMeter, number>;

const readCache = new Map<string, { at: number; usage: MonthlyUsage }>();

export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First instant of the month after `period` (UTC). December rolls into January. */
export function periodEnd(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1));
}

function emptyUsage(): MonthlyUsage {
  return { searches: 0, flowRuns: 0, crawlerPages: 0, sandboxSeconds: 0 };
}

function cacheKey(tenantId: string, period: string): string {
  return `${tenantId}|${period}`;
}

function remember(key: string, usage: MonthlyUsage): void {
  if (readCache.has(key)) readCache.delete(key);
  readCache.set(key, { at: Date.now(), usage });
  while (readCache.size > READ_CACHE_MAX) {
    const oldest = readCache.keys().next().value;
    if (oldest === undefined) break;
    readCache.delete(oldest);
  }
}

/** Adds to a meter. No-op when limits are off for the tenant; never throws. */
export async function addMonthlyUsage(tenantId: string, meter: MonthlyMeter, amount: number): Promise<void> {
  try {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const plan = await resolveTenantPlan(tenantId);
    if (plan.mode === 'off') return;
    const period = currentPeriod();
    const db = await getDatabase();
    await db.incrementPlanUsageMonthly(tenantId, period, { [meter]: amount });
    const hit = readCache.get(cacheKey(tenantId, period));
    if (hit) hit.usage = { ...hit.usage, [meter]: hit.usage[meter] + amount };
  } catch (error) {
    log.warn('Monthly usage could not be recorded', {
      tenantId,
      meter,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getMonthlyUsage(tenantId: string, period: string = currentPeriod()): Promise<MonthlyUsage> {
  const key = cacheKey(tenantId, period);
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return hit.usage;
  const db = await getDatabase();
  const stored = await db.getPlanUsageMonthly(tenantId, period);
  const usage = { ...emptyUsage(), ...stored };
  remember(key, usage);
  return usage;
}

/** The limit in the meter's own unit (sandbox hours are limited in hours, stored in seconds). */
export function monthlyLimitFor(
  monthly: { flowRuns?: number; crawlerPages?: number; sandboxHours?: number },
  meter: MonthlyMeter,
): number | undefined {
  // Web searches are counted for the usage page but paid with credits: never a monthly limit.
  if (meter === 'searches') return undefined;
  if (meter === 'sandboxSeconds') {
    return monthly.sandboxHours === undefined ? undefined : monthly.sandboxHours * 3600;
  }
  return monthly[meter];
}

export async function checkMonthlyAllowance(input: {
  tenantId: string;
  meter: MonthlyMeter;
  amount?: number;
  source?: PlanLimitSource;
}): Promise<PlanLimitDecision> {
  const { tenantId, meter } = input;
  const plan = await resolveTenantPlan(tenantId);
  const limit = plan.limits ? monthlyLimitFor(plan.limits.monthly, meter) : undefined;
  if (plan.mode === 'off' || limit === undefined) {
    return { allowed: true, outcome: 'allowed', kind: 'monthly', dimension: meter, limit };
  }
  let used = 0;
  try {
    used = (await getMonthlyUsage(tenantId))[meter];
  } catch (error) {
    // Cannot read the counter: fail open.
    log.warn('Monthly usage could not be read, failing open', {
      tenantId,
      meter,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true, outcome: 'allowed', kind: 'monthly', dimension: meter, limit };
  }
  const now = new Date();
  const resetAt = periodEnd(currentPeriod(now));
  const decision = decideLimit({
    kind: 'monthly',
    dimension: meter,
    mode: plan.mode,
    limit,
    used,
    amount: input.amount,
    retryAfterMs: Math.max(0, resetAt.getTime() - now.getTime()),
    resetAt,
  });
  if (decision.outcome !== 'allowed') {
    outcomeEventFor(decision, { tenantId, mode: plan.mode === 'on' ? 'on' : 'shadow', source: input.source });
  }
  return decision;
}

export async function assertMonthlyAllowance(input: {
  tenantId: string;
  meter: MonthlyMeter;
  amount?: number;
  source?: PlanLimitSource;
}): Promise<void> {
  const decision = await checkMonthlyAllowance(input);
  if (decision.allowed) return;
  throw new PlanLimitError({
    code: 'monthly_allowance_exhausted',
    message: `Monthly allowance for ${input.meter} is used up (${decision.used} of ${decision.limit}). It resets on ${decision.resetAt?.toISOString().slice(0, 10)}.`,
    kind: 'monthly',
    dimension: input.meter,
    limit: decision.limit,
    used: decision.used,
    retryAfterMs: decision.retryAfterMs,
    resetAt: decision.resetAt,
  });
}

export function clearMeterCacheForTests(): void {
  readCache.clear();
}
