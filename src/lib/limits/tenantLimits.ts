/**
 * Resolves the plan limits that apply to a tenant: the license `plan` claim,
 * else the deployment's default plan (seam), through a short in-process cache.
 * A tenant whose stored license lapsed (expired, invalid, or paid without a
 * `plan` claim) gets the restricted plan (seam) instead of the default one.
 * Never throws: when the tenant cannot be loaded the check fails open.
 */
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { getDefaultPlanClaim, getRestrictedPlanClaim } from '@/enterprise/plan-limits';
import { LicenseManager } from '@/lib/license/license-manager';
import type { LicensePlanClaim, LicensePlanMonthlyLimits } from '@/lib/license/planClaim';
import { planStateVersion } from './invalidate';
import { effectivePlanLimitsMode, planLimitsActive } from './mode';
import type { PlanLimitsMode, ResolvedTenantPlan, TenantLimits } from './types';

const log = createLogger('limits:tenant');

type StoredLicense = { licenseId?: string | null; licenseKey?: string | null; licensePayload?: unknown; licenseStatus?: string };

/** A stored license (not the 'FREE' placeholder new and reset tenants carry) that grants no plan. */
function licenseLapsed(tenant: StoredLicense, license: { status?: string; licenseType?: string; plan?: unknown }): boolean {
  const stored = Boolean(tenant.licenseKey || tenant.licensePayload || (tenant.licenseId && tenant.licenseId !== 'FREE'))
    || tenant.licenseStatus === 'expired' || tenant.licenseStatus === 'invalid';
  if (!stored || license.plan) return false;
  return license.status !== 'active' || license.licenseType !== 'FREE';
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;
const LOG_EVERY_MS = 60_000;

const cache = new Map<string, { at: number; value: ResolvedTenantPlan; version?: string }>();
let lastLoadFailureLogAt = 0;

/**
 * The monthly limits of a claim. An older claim may still carry `searches`; it is ignored, because
 * hosted web search is paid per search with credits and has no monthly allowance.
 */
function monthlyLimits(monthly: LicensePlanMonthlyLimits | undefined): TenantLimits['monthly'] {
  const { flowRuns, crawlerPages, sandboxHours } = monthly ?? {};
  return {
    ...(flowRuns !== undefined ? { flowRuns } : {}),
    ...(crawlerPages !== undefined ? { crawlerPages } : {}),
    ...(sandboxHours !== undefined ? { sandboxHours } : {}),
  };
}

export function limitsFromPlanClaim(
  claim: LicensePlanClaim,
  source: 'license' | 'default',
  expiresAt?: Date,
): TenantLimits {
  const limits = claim.limits ?? {};
  const concurrent = limits.concurrent ?? {};
  const concurrency: TenantLimits['concurrency'] = {};
  if (concurrent.agentSessions !== undefined) concurrency.agent = concurrent.agentSessions;
  if (concurrent.flows !== undefined) concurrency.flow = concurrent.flows;
  if (concurrent.jobs !== undefined) concurrency.job = concurrent.jobs;
  if (concurrent.crawlers !== undefined) concurrency.crawler = concurrent.crawlers;
  if (concurrent.browserSessions !== undefined) concurrency.browser = concurrent.browserSessions;
  if (concurrent.realtimeSessions !== undefined) concurrency.realtime = concurrent.realtimeSessions;
  if (concurrent.sandboxes !== undefined) concurrency.sandbox = concurrent.sandboxes;

  return {
    source,
    plan: claim.id,
    planName: claim.name,
    capacityPacks: claim.capacityPacks,
    apiRpm: limits.apiRequestsPerMinute,
    concurrency,
    monthly: monthlyLimits(limits.monthly),
    storageBytes: limits.storageGb !== undefined ? Math.round(limits.storageGb * 1e9) : undefined,
    seats: { ...(claim.seats ?? {}) },
    sandboxMaxSize: limits.sandboxMaxSize ? { ...limits.sandboxMaxSize } : undefined,
    realtimeMaxSessionMinutes: limits.realtimeMaxSessionMinutes,
    credits: { includedPerMonth: claim.credits?.includedPerMonth },
    expiresAt,
  };
}

function remember(tenantId: string, value: ResolvedTenantPlan, version?: string): void {
  if (cache.has(tenantId)) cache.delete(tenantId);
  cache.set(tenantId, { at: Date.now(), value, version });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function resolveTenantPlan(tenantId: string): Promise<ResolvedTenantPlan> {
  if (!planLimitsActive()) return { tenantId, mode: 'off', limits: null };

  const version = await planStateVersion(tenantId);
  const hit = cache.get(tenantId);
  // Another replica changed the license: its bump of the shared version drops this replica's entry too.
  if (hit && Date.now() - hit.at < CACHE_TTL_MS && (version === undefined || hit.version === version)) return hit.value;

  try {
    const db = await getDatabase();
    const tenant = await db.findTenantById(tenantId);
    if (!tenant) throw new Error('tenant not found');
    const license = LicenseManager.getEffectiveLicenseForTenant(tenant);
    const claim = license.plan
      ?? (licenseLapsed(tenant, license) ? getRestrictedPlanClaim() ?? getDefaultPlanClaim() : getDefaultPlanClaim());
    const mode = effectivePlanLimitsMode();
    const value: ResolvedTenantPlan = {
      tenantId,
      mode,
      limits: claim ? limitsFromPlanClaim(claim, license.plan ? 'license' : 'default', license.expiresAt) : null,
    };
    remember(tenantId, value, version);
    return value;
  } catch (error) {
    const now = Date.now();
    if (now - lastLoadFailureLogAt >= LOG_EVERY_MS) {
      lastLoadFailureLogAt = now;
      log.warn('Plan limits: tenant could not be loaded, failing open', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const mode: PlanLimitsMode = effectivePlanLimitsMode();
    return { tenantId, mode, limits: null };
  }
}

export function invalidateTenantPlan(tenantId: string): void {
  cache.delete(tenantId);
}

export function clearTenantPlanCacheForTests(): void {
  cache.clear();
  lastLoadFailureLogAt = 0;
}
