import { getDatabase, type IQuotaPolicy } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { getPlanQuotaLimits } from '@/lib/quota/planLimits';
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

export async function resolveEffectiveLimits(
  context: QuotaContext,
): Promise<QuotaLimits> {
  const planDefaults = getPlanQuotaLimits(context.licenseType);
  let effectiveLimits: QuotaLimits = {
    quotas: { ...planDefaults },
    rateLimit: {
      requests: { perMonth: planDefaults.requestsPerMonth },
    },
  };

  const policies = await fetchPolicies(
    context.tenantDbName,
    context.tenantId,
    context.projectId,
  );

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
  resource: 'models' | 'vectorIndexes' | 'apiTokens' | 'users' | 'agents' | 'fileBuckets' | 'tracingSessions' | 'filesTotal',
  currentCount: number,
): Promise<QuotaCheckResult> {
  const effectiveLimits = await resolveEffectiveLimits(context);

  const quotaKeyMap: Record<typeof resource, keyof NonNullable<QuotaLimits['quotas']>> = {
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
  const db = await getDatabase();
  await db.switchToTenant(context.tenantDbName);

  const rateLimit = effectiveLimits.rateLimit;
  if (!rateLimit) return { allowed: true, effectiveLimits };

  const errors: string[] = [];

  const checkWindow = async (
    type: 'requests' | 'tokens' | 'vectors' | 'files' | 'storageBytes',
    windowName: 'perSecond' | 'perMinute' | 'perHour' | 'perDay' | 'perMonth',
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

    const key = keyParts.join(':');

    try {
      const { count } = await db.incrementRateLimit(key, windowSeconds, incrementBy);
      if (count > limit) {
        errors.push(
          `Rate limit exceeded for ${type} ${windowName} (${count}/${limit})`,
        );
      }
    } catch (error) {
      console.error('Rate limit check failed:', error);
    }
  };

  const promises: Promise<void>[] = [];

  if (rateLimit.requests) {
    const r = rateLimit.requests;
    promises.push(
      checkWindow('requests', 'perSecond', r.perSecond, cost.requests || 0),
    );
    promises.push(
      checkWindow('requests', 'perMinute', r.perMinute, cost.requests || 0),
    );
    promises.push(
      checkWindow('requests', 'perHour', r.perHour, cost.requests || 0),
    );
    promises.push(
      checkWindow('requests', 'perDay', r.perDay, cost.requests || 0),
    );
    promises.push(
      checkWindow('requests', 'perMonth', r.perMonth, cost.requests || 0),
    );
  }

  if (rateLimit.tokens) {
    const t = rateLimit.tokens;
    promises.push(
      checkWindow('tokens', 'perSecond', t.perSecond, cost.tokens || 0),
    );
    promises.push(
      checkWindow('tokens', 'perMinute', t.perMinute, cost.tokens || 0),
    );
    promises.push(
      checkWindow('tokens', 'perHour', t.perHour, cost.tokens || 0),
    );
    promises.push(
      checkWindow('tokens', 'perDay', t.perDay, cost.tokens || 0),
    );
    promises.push(
      checkWindow('tokens', 'perMonth', t.perMonth, cost.tokens || 0),
    );
  }

  if (rateLimit.vectors) {
    const v = rateLimit.vectors;
    promises.push(
      checkWindow('vectors', 'perSecond', v.perSecond, cost.vectors || 0),
    );
    promises.push(
      checkWindow('vectors', 'perMinute', v.perMinute, cost.vectors || 0),
    );
    promises.push(
      checkWindow('vectors', 'perHour', v.perHour, cost.vectors || 0),
    );
    promises.push(
      checkWindow('vectors', 'perDay', v.perDay, cost.vectors || 0),
    );
    promises.push(
      checkWindow('vectors', 'perMonth', v.perMonth, cost.vectors || 0),
    );
  }

  if (rateLimit.files) {
    const f = rateLimit.files;
    promises.push(
      checkWindow('files', 'perSecond', f.perSecond, cost.files || 0),
    );
    promises.push(
      checkWindow('files', 'perMinute', f.perMinute, cost.files || 0),
    );
    promises.push(
      checkWindow('files', 'perHour', f.perHour, cost.files || 0),
    );
    promises.push(
      checkWindow('files', 'perDay', f.perDay, cost.files || 0),
    );
    promises.push(
      checkWindow('files', 'perMonth', f.perMonth, cost.files || 0),
    );
  }

  if (rateLimit.storage) {
    const s = rateLimit.storage;
    promises.push(
      checkWindow('storageBytes', 'perSecond', s.perSecond, cost.storageBytes || 0),
    );
    promises.push(
      checkWindow('storageBytes', 'perMinute', s.perMinute, cost.storageBytes || 0),
    );
    promises.push(
      checkWindow('storageBytes', 'perHour', s.perHour, cost.storageBytes || 0),
    );
    promises.push(
      checkWindow('storageBytes', 'perDay', s.perDay, cost.storageBytes || 0),
    );
    promises.push(
      checkWindow('storageBytes', 'perMonth', s.perMonth, cost.storageBytes || 0),
    );
  }

  await Promise.all(promises);

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
      console.error('Budget check failed:', error);
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
