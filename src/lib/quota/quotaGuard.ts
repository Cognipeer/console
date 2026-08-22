import { getDatabase, type IQuotaPolicy } from '@/lib/database';
import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import { LicenseManager } from '@/lib/license/license-manager';

const logger = createLogger('quota-guard');
import type {
  QuotaDomain,
  QuotaLimits,
} from '@/lib/quota/types';

export interface QuotaContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  licenseType: LicenseType;
  userId?: string;
  tokenId?: string;
  domain: QuotaDomain;
  // Resource identification (model key, index key, bucket key, session id)
  resourceKey?: string;
  providerKey?: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  effectiveLimits: QuotaLimits;
}

async function fetchPolicies(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
): Promise<IQuotaPolicy[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listQuotaPolicies(tenantId, projectId);
}

function matchesScope(
  policy: IQuotaPolicy,
  context: QuotaContext,
): boolean {
  if (!policy.enabled) return false;

  switch (policy.scope) {
    case 'tenant':
      return true;
    case 'user':
      return policy.scopeId === context.userId;
    case 'token':
      return policy.scopeId === context.tokenId;
    case 'resource':
      return policy.scopeId === context.resourceKey;
    case 'provider':
      return policy.scopeId === context.providerKey;
    default:
      return false;
  }
}

function matchesDomain(
  policy: IQuotaPolicy,
  context: QuotaContext,
): boolean {
  if (policy.domain === 'global') return true;
  return policy.domain === context.domain;
}

function mergeLimits(base: QuotaLimits, override: QuotaLimits): QuotaLimits {
  const merged: QuotaLimits = { ...base };

  if (override.rateLimit) {
    merged.rateLimit = {
      ...merged.rateLimit,
      ...override.rateLimit,
      requests: override.rateLimit.requests
        ? { ...merged.rateLimit?.requests, ...override.rateLimit.requests }
        : merged.rateLimit?.requests,
      tokens: override.rateLimit.tokens
        ? { ...merged.rateLimit?.tokens, ...override.rateLimit.tokens }
        : merged.rateLimit?.tokens,
      vectors: override.rateLimit.vectors
        ? { ...merged.rateLimit?.vectors, ...override.rateLimit.vectors }
        : merged.rateLimit?.vectors,
      files: override.rateLimit.files
        ? { ...merged.rateLimit?.files, ...override.rateLimit.files }
        : merged.rateLimit?.files,
      storage: override.rateLimit.storage
        ? { ...merged.rateLimit?.storage, ...override.rateLimit.storage }
        : merged.rateLimit?.storage,
    };
  }

  if (override.perRequest) {
    merged.perRequest = { ...merged.perRequest, ...override.perRequest };
  }

  if (override.quotas) {
    merged.quotas = { ...merged.quotas, ...override.quotas };
  }

  if (override.budget) {
    merged.budget = { ...merged.budget, ...override.budget };
  }

  return merged;
}

async function incrementRateLimitCounters(
  context: QuotaContext,
  entries: Array<{ key: string; windowSeconds: number; amount: number }>,
): Promise<Array<{ count: number; resetAt: Date }>> {
  const provider = getConfig().rateLimit.provider;

  if (provider === 'mongodb') {
    const db = await getDatabase();
    await db.switchToTenant(context.tenantDbName);
    return db.incrementRateLimits(entries);
  }

  const cache = await getCache();
  if (cache.name !== provider) {
    throw new Error(
      `RATE_LIMIT_PROVIDER=${provider} requires CACHE_PROVIDER=${provider}`,
    );
  }

  return cache.incrementCounters(
    entries.map((entry) => ({
      key: `${context.tenantDbName}:${entry.key}`,
      ttlSeconds: entry.windowSeconds,
      amount: entry.amount,
    })),
  );
}


/**
 * The tenant license + policy set behind an effective-limit resolution.
 *
 * Cached as the *inputs*, never as the merged result: the merge depends on the
 * caller's user, token, resource, provider and domain, so caching the outcome
 * would need a key per requester and could hand one caller another's limits.
 * Filtering stays on the request path; only the two DB reads are amortized.
 *
 * TREAT AS READ-ONLY. The memory cache provider hands back the stored object
 * itself, so mutating either field would corrupt it for every later request on
 * this node. `mergeLimits` builds new objects rather than writing into its base
 * for exactly this reason.
 */
interface QuotaPolicySource {
  licenseDefaults: QuotaLimits;
  policies: IQuotaPolicy[];
}

export function quotaPolicyCacheKey(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
): string {
  return `quota:policy-src:${tenantDbName}:${tenantId}:${projectId}`;
}

/**
 * Load the tenant license defaults and quota policies, through a short-lived
 * cache.
 *
 * Every guarded request used to re-read the tenant document and the policy
 * collection, and an inference request runs three resolutions before the model
 * is even called — six reads against a 10-connection pool on the hottest path
 * in the product. Policy edits invalidate this explicitly (see quotaService);
 * the TTL is the backstop for edits made elsewhere.
 */
async function loadPolicySource(
  context: QuotaContext,
): Promise<QuotaPolicySource> {
  const ttlSeconds = getConfig().quota.policyCacheTtlSeconds;
  const cacheKey = quotaPolicyCacheKey(
    context.tenantDbName,
    context.tenantId,
    context.projectId,
  );

  if (ttlSeconds > 0) {
    try {
      const cache = await getCache();
      const cached = await cache.get<QuotaPolicySource>(cacheKey);
      if (cached) return cached;
    } catch {
      /* cache miss or unavailable — fall through to the database */
    }
  }

  const db = await getDatabase();
  // Read the tenant before switching databases: fetchPolicies switches the
  // connection to the tenant DB, and the tenant record lives in the main one.
  const tenant = await db.findTenantById(context.tenantId);
  const licenseDefaults = LicenseManager.getQuotaLimitsForTenant(tenant);
  const policies = await fetchPolicies(
    context.tenantDbName,
    context.tenantId,
    context.projectId,
  );

  const source: QuotaPolicySource = { licenseDefaults, policies };

  if (ttlSeconds > 0) {
    try {
      const cache = await getCache();
      await cache.set(cacheKey, source, ttlSeconds);
    } catch {
      /* best-effort cache write */
    }
  }

  return source;
}

export async function resolveEffectiveLimits(
  context: QuotaContext,
): Promise<QuotaLimits> {
  const { licenseDefaults, policies } = await loadPolicySource(context);
  let effectiveLimits: QuotaLimits = {
    ...licenseDefaults,
    quotas: { ...licenseDefaults.quotas },
    rateLimit: licenseDefaults.rateLimit
      ? { ...licenseDefaults.rateLimit }
      : undefined,
  };

  const applicable = policies
    .filter((p) => matchesScope(p, context) && matchesDomain(p, context))
    .sort((a, b) => a.priority - b.priority);

  for (const policy of applicable) {
    effectiveLimits = mergeLimits(effectiveLimits, policy.limits);
  }

  return effectiveLimits;
}

export async function checkQuota(
  context: QuotaContext,
): Promise<QuotaCheckResult> {
  const effectiveLimits = await resolveEffectiveLimits(context);
  return {
    allowed: true,
    effectiveLimits,
  };
}

export async function checkResourceQuota(
  context: QuotaContext,
  resource: 'projects' | 'models' | 'vectorIndexes' | 'apiTokens' | 'users' | 'agents' | 'fileBuckets' | 'tracingSessions' | 'filesTotal',
  currentCount: number,
): Promise<QuotaCheckResult> {
  const effectiveLimits = await resolveEffectiveLimits(context);

  const quotaKeyMap: Record<typeof resource, keyof NonNullable<QuotaLimits['quotas']>> = {
    projects: 'maxProjects',
    models: 'maxModels',
    vectorIndexes: 'maxVectorIndexes',
    apiTokens: 'maxApiTokens',
    users: 'maxUsers',
    agents: 'maxAgents',
    fileBuckets: 'maxFileBuckets',
    tracingSessions: 'maxTracingSessions',
    filesTotal: 'maxFilesTotal',
  };

  const key = quotaKeyMap[resource];
  const limit = effectiveLimits.quotas?.[key];

  if (limit !== undefined && limit !== -1 && currentCount >= limit) {
    return {
      allowed: false,
      reason: `${resource} limit reached (${currentCount}/${limit})`,
      effectiveLimits,
    };
  }

  return { allowed: true, effectiveLimits };
}

export async function checkPerRequestLimits(
  context: QuotaContext,
  request: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    fileSize?: number;
    filesPerRequest?: number;
    vectorCount?: number;
    vectorDimensions?: number;
    queryResults?: number;
    eventsPerSession?: number;
    sessionDurationMs?: number;
  },
): Promise<QuotaCheckResult> {
  const effectiveLimits = await resolveEffectiveLimits(context);
  const perRequest = effectiveLimits.perRequest;

  if (!perRequest) {
    return { allowed: true, effectiveLimits };
  }

  if (
    perRequest.maxInputTokens !== undefined &&
    perRequest.maxInputTokens !== -1 &&
    request.inputTokens !== undefined &&
    request.inputTokens > perRequest.maxInputTokens
  ) {
    return {
      allowed: false,
      reason: `Input tokens (${request.inputTokens}) exceeds limit (${perRequest.maxInputTokens})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxOutputTokens !== undefined &&
    perRequest.maxOutputTokens !== -1 &&
    request.outputTokens !== undefined &&
    request.outputTokens > perRequest.maxOutputTokens
  ) {
    return {
      allowed: false,
      reason: `Output tokens (${request.outputTokens}) exceeds limit (${perRequest.maxOutputTokens})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxTotalTokens !== undefined &&
    perRequest.maxTotalTokens !== -1 &&
    request.totalTokens !== undefined &&
    request.totalTokens > perRequest.maxTotalTokens
  ) {
    return {
      allowed: false,
      reason: `Total tokens (${request.totalTokens}) exceeds limit (${perRequest.maxTotalTokens})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxFileSize !== undefined &&
    perRequest.maxFileSize !== -1 &&
    request.fileSize !== undefined &&
    request.fileSize > perRequest.maxFileSize
  ) {
    return {
      allowed: false,
      reason: `File size (${request.fileSize} bytes) exceeds limit (${perRequest.maxFileSize} bytes)`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxFilesPerRequest !== undefined &&
    perRequest.maxFilesPerRequest !== -1 &&
    request.filesPerRequest !== undefined &&
    request.filesPerRequest > perRequest.maxFilesPerRequest
  ) {
    return {
      allowed: false,
      reason: `Files per request (${request.filesPerRequest}) exceeds limit (${perRequest.maxFilesPerRequest})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxVectorsPerUpsert !== undefined &&
    perRequest.maxVectorsPerUpsert !== -1 &&
    request.vectorCount !== undefined &&
    request.vectorCount > perRequest.maxVectorsPerUpsert
  ) {
    return {
      allowed: false,
      reason: `Vector count (${request.vectorCount}) exceeds limit (${perRequest.maxVectorsPerUpsert})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxDimensions !== undefined &&
    perRequest.maxDimensions !== -1 &&
    request.vectorDimensions !== undefined &&
    request.vectorDimensions > perRequest.maxDimensions
  ) {
    return {
      allowed: false,
      reason: `Vector dimensions (${request.vectorDimensions}) exceeds limit (${perRequest.maxDimensions})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxQueryResults !== undefined &&
    perRequest.maxQueryResults !== -1 &&
    request.queryResults !== undefined &&
    request.queryResults > perRequest.maxQueryResults
  ) {
    return {
      allowed: false,
      reason: `Query results (${request.queryResults}) exceeds limit (${perRequest.maxQueryResults})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxEventsPerSession !== undefined &&
    perRequest.maxEventsPerSession !== -1 &&
    request.eventsPerSession !== undefined &&
    request.eventsPerSession > perRequest.maxEventsPerSession
  ) {
    return {
      allowed: false,
      reason: `Events per session (${request.eventsPerSession}) exceeds limit (${perRequest.maxEventsPerSession})`,
      effectiveLimits,
    };
  }

  if (
    perRequest.maxSessionDurationMs !== undefined &&
    perRequest.maxSessionDurationMs !== -1 &&
    request.sessionDurationMs !== undefined &&
    request.sessionDurationMs > perRequest.maxSessionDurationMs
  ) {
    return {
      allowed: false,
      reason: `Session duration (${request.sessionDurationMs} ms) exceeds limit (${perRequest.maxSessionDurationMs} ms)`,
      effectiveLimits,
    };
  }

  return { allowed: true, effectiveLimits };
}

export async function checkRateLimit(
  context: QuotaContext,
  cost: {
    requests?: number;
    tokens?: number;
    vectors?: number;
    files?: number;
    storageBytes?: number;
  } = { requests: 1, tokens: 0 },
): Promise<QuotaCheckResult> {
  const effectiveLimits = await resolveEffectiveLimits(context);

  const rateLimit = effectiveLimits.rateLimit;
  if (!rateLimit) return { allowed: true, effectiveLimits };

  const errors: string[] = [];

  /**
   * One counter to increment: a metric type in one window.
   *
   * Collected first and issued as a single batch. Sent one at a time these are
   * up to 25 concurrent round trips per request, enough for one caller to hold
   * every connection in the pool while its limits are checked.
   */
  interface PlannedWindow {
    type: 'requests' | 'tokens' | 'vectors' | 'files' | 'storageBytes';
    windowName: 'perSecond' | 'perMinute' | 'perHour' | 'perDay' | 'perMonth';
    limit: number;
    key: string;
    windowSeconds: number;
    amount: number;
  }

  const planned: PlannedWindow[] = [];

  const checkWindow = (
    type: PlannedWindow['type'],
    windowName: PlannedWindow['windowName'],
    limit: number | undefined,
    incrementBy: number,
  ) => {
    if (limit === undefined || limit === -1 || incrementBy === 0) return;

    const windowSeconds = {
      perSecond: 1,
      perMinute: 60,
      perHour: 3600,
      perDay: 86400,
      perMonth: 2592000,
    }[windowName];

    const keyParts = ['rate_limit', context.domain, type, windowName];
    if (context.providerKey) keyParts.push(`prov:${context.providerKey}`);
    if (context.resourceKey) keyParts.push(`res:${context.resourceKey}`);
    if (context.userId) keyParts.push(`user:${context.userId}`);
    else if (context.tokenId) keyParts.push(`token:${context.tokenId}`);
    else keyParts.push(`tenant:${context.tenantId}`);

    planned.push({
      type,
      windowName,
      limit,
      key: keyParts.join(':'),
      windowSeconds,
      amount: incrementBy,
    });
  };

  if (rateLimit.requests) {
    const r = rateLimit.requests;
    checkWindow('requests', 'perSecond', r.perSecond, cost.requests || 0);
    checkWindow('requests', 'perMinute', r.perMinute, cost.requests || 0);
    checkWindow('requests', 'perHour', r.perHour, cost.requests || 0);
    checkWindow('requests', 'perDay', r.perDay, cost.requests || 0);
    checkWindow('requests', 'perMonth', r.perMonth, cost.requests || 0);
  }

  if (rateLimit.tokens) {
    const t = rateLimit.tokens;
    checkWindow('tokens', 'perSecond', t.perSecond, cost.tokens || 0);
    checkWindow('tokens', 'perMinute', t.perMinute, cost.tokens || 0);
    checkWindow('tokens', 'perHour', t.perHour, cost.tokens || 0);
    checkWindow('tokens', 'perDay', t.perDay, cost.tokens || 0);
    checkWindow('tokens', 'perMonth', t.perMonth, cost.tokens || 0);
  }

  if (rateLimit.vectors) {
    const v = rateLimit.vectors;
    checkWindow('vectors', 'perSecond', v.perSecond, cost.vectors || 0);
    checkWindow('vectors', 'perMinute', v.perMinute, cost.vectors || 0);
    checkWindow('vectors', 'perHour', v.perHour, cost.vectors || 0);
    checkWindow('vectors', 'perDay', v.perDay, cost.vectors || 0);
    checkWindow('vectors', 'perMonth', v.perMonth, cost.vectors || 0);
  }

  if (rateLimit.files) {
    const f = rateLimit.files;
    checkWindow('files', 'perSecond', f.perSecond, cost.files || 0);
    checkWindow('files', 'perMinute', f.perMinute, cost.files || 0);
    checkWindow('files', 'perHour', f.perHour, cost.files || 0);
    checkWindow('files', 'perDay', f.perDay, cost.files || 0);
    checkWindow('files', 'perMonth', f.perMonth, cost.files || 0);
  }

  if (rateLimit.storage) {
    const s = rateLimit.storage;
    checkWindow('storageBytes', 'perSecond', s.perSecond, cost.storageBytes || 0);
    checkWindow('storageBytes', 'perMinute', s.perMinute, cost.storageBytes || 0);
    checkWindow('storageBytes', 'perHour', s.perHour, cost.storageBytes || 0);
    checkWindow('storageBytes', 'perDay', s.perDay, cost.storageBytes || 0);
    checkWindow('storageBytes', 'perMonth', s.perMonth, cost.storageBytes || 0);
  }

  if (planned.length > 0) {
    try {
      const counts = await incrementRateLimitCounters(context, planned);
      counts.forEach(({ count }, index) => {
        const window = planned[index];
        if (count > window.limit) {
          errors.push(
            `Rate limit exceeded for ${window.type} ${window.windowName} `
            + `(${count}/${window.limit})`,
          );
        }
      });
    } catch (error) {
      // The batch fails as a unit, where separate calls used to fail one
      // counter at a time. Enforcement being unavailable is the same answer
      // either way, and a partially-applied set of increments would leave the
      // windows disagreeing about how much of this request was counted.
      logger.error('Rate limit check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      errors.push('Rate limit enforcement unavailable');
    }
  }

  if (errors.length > 0) {
    return { allowed: false, reason: errors[0], effectiveLimits };
  }

  return { allowed: true, effectiveLimits };
}

function usdToCents(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.max(0, Math.round(usd * 100));
}

export async function checkBudget(
  context: QuotaContext,
  cost: { usd?: number } = {},
): Promise<QuotaCheckResult> {
  const effectiveLimits = await resolveEffectiveLimits(context);
  const db = await getDatabase();
  await db.switchToTenant(context.tenantDbName);

  const budget = effectiveLimits.budget;
  if (!budget) return { allowed: true, effectiveLimits };

  const costCents = usdToCents(cost.usd ?? 0);
  const errors: string[] = [];

  const checkWindow = async (
    windowName: 'perDay' | 'perMonth',
    limitUsd: number | undefined,
    incrementByCents: number,
  ) => {
    if (limitUsd === undefined || limitUsd === -1) return;

    const limitCents = usdToCents(limitUsd);
    const windowSeconds = windowName === 'perDay' ? 86400 : 2592000;

    const keyParts = ['budget', context.domain, 'usd_cents', windowName];
    if (context.providerKey) keyParts.push(`prov:${context.providerKey}`);
    if (context.resourceKey) keyParts.push(`res:${context.resourceKey}`);
    if (context.userId) keyParts.push(`user:${context.userId}`);
    else if (context.tokenId) keyParts.push(`token:${context.tokenId}`);
    else keyParts.push(`tenant:${context.tenantId}`);

    const key = keyParts.join(':');

    try {
      // Read current value without incrementing.
      const current = await db.incrementRateLimit(key, windowSeconds, 0);
      if (current.count >= limitCents) {
        errors.push(`Budget exceeded for ${windowName} (${current.count}/${limitCents} cents)`);
        return;
      }

      if (incrementByCents > 0) {
        const updated = await db.incrementRateLimit(
          key,
          windowSeconds,
          incrementByCents,
        );
        if (updated.count > limitCents) {
          errors.push(`Budget exceeded for ${windowName} (${updated.count}/${limitCents} cents)`);
        }
      }
    } catch (error) {
      logger.error('Budget check failed', { error });
    }
  };

  await Promise.all([
    checkWindow('perDay', budget.dailySpendLimit, costCents),
    checkWindow('perMonth', budget.monthlySpendLimit, costCents),
  ]);

  if (errors.length > 0) {
    return { allowed: false, reason: errors[0], effectiveLimits };
  }

  return { allowed: true, effectiveLimits };
}

// ── Budget usage introspection (read-only) ────────────────────────────────

export interface BudgetWindowUsage {
  /** Configured limit in USD, or null when no limit applies. */
  limitUsd: number | null;
  /** Spend consumed in the current window, in USD. */
  usedUsd: number;
  /** Remaining headroom in USD, or null when unlimited. */
  remainingUsd: number | null;
}

export interface BudgetUsage {
  /** False when no budget limits are configured for this context. */
  configured: boolean;
  perDay: BudgetWindowUsage;
  perMonth: BudgetWindowUsage;
  alertThresholds?: number[];
}

/** Mirrors the counter key scheme used by `checkBudget`. */
function budgetCounterKey(context: QuotaContext, windowName: 'perDay' | 'perMonth'): string {
  const keyParts = ['budget', context.domain, 'usd_cents', windowName];
  if (context.providerKey) keyParts.push(`prov:${context.providerKey}`);
  if (context.resourceKey) keyParts.push(`res:${context.resourceKey}`);
  if (context.userId) keyParts.push(`user:${context.userId}`);
  else if (context.tokenId) keyParts.push(`token:${context.tokenId}`);
  else keyParts.push(`tenant:${context.tenantId}`);
  return keyParts.join(':');
}

/**
 * Read the current budget consumption for a context without incrementing the
 * counters. Used by the spend/budget reporting surface.
 */
export async function getBudgetUsage(context: QuotaContext): Promise<BudgetUsage> {
  const effectiveLimits = await resolveEffectiveLimits(context);
  const db = await getDatabase();
  await db.switchToTenant(context.tenantDbName);

  const budget = effectiveLimits.budget;

  const readWindow = async (
    windowName: 'perDay' | 'perMonth',
    limitUsd: number | undefined,
  ): Promise<BudgetWindowUsage> => {
    const windowSeconds = windowName === 'perDay' ? 86400 : 2592000;
    let usedUsd = 0;
    try {
      const current = await db.incrementRateLimit(
        budgetCounterKey(context, windowName),
        windowSeconds,
        0,
      );
      usedUsd = current.count / 100;
    } catch (error) {
      logger.error('Budget usage read failed', { error });
    }
    const hasLimit = limitUsd !== undefined && limitUsd !== -1;
    return {
      limitUsd: hasLimit ? limitUsd : null,
      usedUsd,
      remainingUsd: hasLimit ? Math.max(0, limitUsd - usedUsd) : null,
    };
  };

  return {
    configured: Boolean(
      budget
      && ((budget.dailySpendLimit !== undefined && budget.dailySpendLimit !== -1)
        || (budget.monthlySpendLimit !== undefined && budget.monthlySpendLimit !== -1)),
    ),
    perDay: await readWindow('perDay', budget?.dailySpendLimit),
    perMonth: await readWindow('perMonth', budget?.monthlySpendLimit),
    alertThresholds: budget?.alertThresholds,
  };
}
