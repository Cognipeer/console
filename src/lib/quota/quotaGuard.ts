import { getDatabase, type IQuotaPolicy } from '@/lib/database';
import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import { LicenseManager } from '@/lib/license/license-manager';
import { onIamInvalidation } from '@/lib/iam/events';
import { formatUsd } from '@/lib/utils/formatUsd';

const logger = createLogger('quota-guard');
import {
  isTenantWideKind,
  type QuotaDomain,
  type QuotaLimits,
  type QuotaRateLimit,
} from '@/lib/quota/types';

export interface QuotaContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Informational: no guard decision depends on it. */
  licenseType?: LicenseType;
  userId?: string;
  tokenId?: string;
  /**
   * The caller's user-group ids, which `group`-scoped policies match against.
   *
   * Optional on purpose. Left out, the guard looks them up itself — one
   * membership read, cached for 15 s and dropped on every membership change
   * (the same events the authorization engine's principal cache listens to) —
   * and only when the tenant actually has a group-scoped policy that could
   * apply, so a tenant without group limits pays nothing and decides exactly as
   * before. A caller that already holds the ids can pass them to skip even that.
   */
  groupIds?: string[];
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
  const projectPolicies = await db.listQuotaPolicies(tenantId, projectId);

  // Group limits and agent-run limits may be tenant-wide (no project). Rows of
  // any other kind without a project stay unloaded, exactly as before — see
  // `isTenantWideKind`.
  const tenantWide = typeof db.listTenantWideQuotaPolicies === 'function'
    ? await db.listTenantWideQuotaPolicies(tenantId)
    : [];
  // (A context with an empty project id reads every policy of the tenant above,
  // tenant-wide ones included; do not count those twice.)
  const known = new Set(projectPolicies.map((policy) => String(policy._id)));
  const applicable = Array.isArray(tenantWide)
    ? tenantWide.filter((policy) => isTenantWideKind(policy) && !known.has(String(policy._id)))
    : [];
  return applicable.length === 0 ? projectPolicies : [...projectPolicies, ...applicable];
}

function matchesScope(
  policy: IQuotaPolicy,
  context: QuotaContext,
  groupIds: readonly string[],
): boolean {
  if (!policy.enabled) return false;

  switch (policy.scope) {
    case 'tenant':
      return true;
    case 'group':
      return policy.scopeId !== undefined && policy.scopeId !== null && groupIds.includes(String(policy.scopeId));
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

/**
 * Domains whose checks ignore `global` policies. A `global` policy is written
 * for "everything a project does" — rate limits and budgets sized for model
 * calls — and the agent domain is new: applying those to agent runs would start
 * refusing runs for tenants that never configured an agent limit.
 */
const DOMAINS_WITHOUT_GLOBAL_FALLBACK: ReadonlySet<QuotaDomain> = new Set<QuotaDomain>(['agent']);

function matchesDomain(
  policy: IQuotaPolicy,
  context: QuotaContext,
): boolean {
  if (policy.domain === 'global') return !DOMAINS_WITHOUT_GLOBAL_FALLBACK.has(context.domain);
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

// ── Group scope, shared pools, tenant ceilings, agent narrowing ─────────────

/** Higher = more specific, so it wins a tie in priority (see `resolveLimits`). */
const SCOPE_SPECIFICITY: Record<IQuotaPolicy['scope'], number> = {
  tenant: 0,
  group: 1,
  resource: 2,
  provider: 2,
  user: 3,
  token: 4,
};

const isSharedGroupPolicy = (policy: IQuotaPolicy): boolean =>
  policy.scope === 'group' && policy.groupMode === 'shared';

/** The part of a policy that is checked per request or per resource count: no counter involved. */
function statelessPart(limits: QuotaLimits): QuotaLimits {
  const part: QuotaLimits = {};
  if (limits.perRequest) part.perRequest = limits.perRequest;
  if (limits.quotas) part.quotas = limits.quotas;
  return part;
}

/** The part of a policy that is counted over time: this is what a shared group pool owns. */
function statefulPart(limits: QuotaLimits): QuotaLimits {
  const part: QuotaLimits = {};
  if (limits.rateLimit) part.rateLimit = limits.rateLimit;
  if (limits.budget) part.budget = limits.budget;
  return part;
}

/**
 * Policies folded into `base` in the order given (callers pass them by ascending
 * priority, so the last one wins a conflict). A shared group policy contributes
 * only its stateless half here: its counted half lives in the group's own pool.
 */
function mergePolicies(base: QuotaLimits, policies: readonly IQuotaPolicy[]): QuotaLimits {
  let merged = base;
  for (const policy of policies) {
    merged = mergeLimits(merged, isSharedGroupPolicy(policy) ? statelessPart(policy.limits) : policy.limits);
  }
  return merged;
}

function numericLeaves(node: unknown, path: string[] = [], out: Array<{ path: string[]; value: number }> = []) {
  if (typeof node === 'number') {
    out.push({ path, value: node });
  } else if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) numericLeaves(value, [...path, key], out);
  }
  return out;
}

function readPath(node: unknown, path: readonly string[]): unknown {
  let current = node;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function writePath(node: Record<string, unknown>, path: readonly string[], value: number): void {
  let current = node;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!next || typeof next !== 'object') return;
    current = next as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

/**
 * Tenant policies are ceilings for what GROUPS hand out.
 *
 * `merged` is the priority merge with the group policies in it, `withoutGroups`
 * the same merge without them. Every number the groups changed is held to the
 * tenant policies' value for that field (-1 meaning "unlimited" never lowers the
 * ceiling and never passes it). Numbers a group did not change are left alone —
 * which is why a tenant that has no group policy, and an explicit user or token
 * policy that outranks a group, decide exactly as they did before groups.
 *
 * A SHARED group pool is not capped here: it counts the whole group, tenant
 * policies count each person, and a number in one unit cannot cap the other.
 */
function applyTenantCeilings(
  merged: QuotaLimits,
  withoutGroups: QuotaLimits,
  ceilings: QuotaLimits,
): QuotaLimits {
  const clamped = structuredClone(merged) as unknown as Record<string, unknown>;
  for (const { path, value } of numericLeaves(merged)) {
    if (readPath(withoutGroups, path) === value) continue;
    const ceiling = readPath(ceilings, path);
    if (typeof ceiling !== 'number' || ceiling === -1) continue;
    if (value === -1 || value > ceiling) writePath(clamped, path, ceiling);
  }
  return clamped as unknown as QuotaLimits;
}

/**
 * One independently-counted slice of the limits a request is checked against.
 *
 * Today's single counter (per caller, scoped by provider/resource key) is the
 * `subject` bucket. A shared group pool and an agent-narrowed limit are the
 * other two kinds; each owns its counter keys, so one request is counted
 * separately — and refused separately — in every bucket that applies to it.
 */
interface LimitBucket {
  id: string;
  /** Only `rateLimit` and `budget` are read from a bucket. */
  limits: QuotaLimits;
  /** Counter-key suffix naming whose usage this counter holds. */
  identity: string;
  /** Whether the context's provider / resource key is part of the counter key. */
  scoped: { provider: boolean; resource: boolean };
  /** Start of the refusal reason. */
  reasonPrefix: string;
}

interface ResolvedLimits {
  /** What `resolveEffectiveLimits` reports: every merge, stateless parts included. */
  effective: QuotaLimits;
  buckets: LimitBucket[];
}

function callerIdentity(context: QuotaContext): string {
  if (context.userId) return `user:${context.userId}`;
  if (context.tokenId) return `token:${context.tokenId}`;
  return `tenant:${context.tenantId}`;
}

function subjectBucket(context: QuotaContext, limits: QuotaLimits): LimitBucket {
  // The agent domain counts a caller's runs across ALL agents; only a policy
  // narrowed to one agent (below) keys its counter by the agent.
  const agent = context.domain === 'agent';
  return {
    id: 'subject',
    limits,
    identity: callerIdentity(context),
    scoped: { provider: !agent, resource: !agent },
    reasonPrefix: 'Rate limit exceeded for',
  };
}

// ── caller's groups ─────────────────────────────────────────────────────────

/**
 * A user's group ids, per (tenant database, user), for a short time.
 *
 * Just the memberships: unlike the authorization engine's principal context this
 * needs neither the user row nor the group documents, so it also works for an
 * actor that has no user row at all (a schedule, the public A2A identity) — such
 * a caller simply has no memberships. A write that changes memberships reaches
 * this cache through the same invalidation events the principal cache hears;
 * another node's write is seen when the entry expires.
 */
const GROUP_IDS_TTL_MS = 15_000;
const GROUP_IDS_MAX_ENTRIES = 5_000;
const groupIdsCache = new Map<string, { expiresAt: number; ids: Promise<string[]> }>();
const groupIdsKey = (tenantDbName: string, userId: string) => `${tenantDbName}\u0000${userId}`;

onIamInvalidation((event) => {
  if (event.kind === 'user') {
    for (const key of [...groupIdsCache.keys()]) {
      const [tenant, user] = key.split('\u0000');
      if (user === event.userId && (event.tenantDbName === null || tenant === event.tenantDbName)) groupIdsCache.delete(key);
    }
  } else if (event.kind === 'tenant-principals') {
    for (const key of [...groupIdsCache.keys()]) {
      if (event.tenantDbName === null || key.startsWith(`${event.tenantDbName}\u0000`)) groupIdsCache.delete(key);
    }
  }
});

/** Test hook: forget every cached membership. */
export function resetQuotaGroupCacheForTests(): void {
  groupIdsCache.clear();
}

async function loadGroupIds(tenantDbName: string, userId: string): Promise<string[]> {
  const db = await getDatabase();
  const read = () => db.listGroupMembersByUser(userId);
  const memberships = db.runWithTenant
    ? await db.runWithTenant(tenantDbName, read)
    : (await db.switchToTenant(tenantDbName), await read());
  return [...new Set((Array.isArray(memberships) ? memberships : []).map((m) => String(m.groupId)))];
}

/**
 * The caller's group ids — from the context when it carries them, else (and
 * only when a group policy could match) from the cached memberships.
 */
async function callerGroupIds(
  context: QuotaContext,
  policies: readonly IQuotaPolicy[],
): Promise<readonly string[]> {
  if (context.groupIds) return context.groupIds;
  if (!context.userId) return [];
  const couldMatch = policies.some(
    (policy) => policy.enabled && policy.scope === 'group' && matchesDomain(policy, context),
  );
  if (!couldMatch) return [];

  const key = groupIdsKey(context.tenantDbName, context.userId);
  const now = Date.now();
  const cached = groupIdsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.ids;

  if (groupIdsCache.size >= GROUP_IDS_MAX_ENTRIES) {
    const oldest = groupIdsCache.keys().next().value;
    if (oldest !== undefined) groupIdsCache.delete(oldest);
  }
  const ids = loadGroupIds(context.tenantDbName, context.userId);
  const entry = { expiresAt: now + GROUP_IDS_TTL_MS, ids };
  groupIdsCache.set(key, entry);
  try {
    return await ids;
  } catch (error) {
    // Never keep a failure around: the next call asks again.
    if (groupIdsCache.get(key) === entry) groupIdsCache.delete(key);
    throw error;
  }
}

async function incrementRateLimitCounter(
  context: QuotaContext,
  key: string,
  windowSeconds: number,
  amount: number,
): Promise<{ count: number; resetAt: Date }> {
  const provider = getConfig().rateLimit.provider;

  if (provider === 'mongodb') {
    const db = await getDatabase();
    await db.switchToTenant(context.tenantDbName);
    return db.incrementRateLimit(key, windowSeconds, amount);
  }

  const cache = await getCache();
  if (cache.name !== provider) {
    throw new Error(
      `RATE_LIMIT_PROVIDER=${provider} requires CACHE_PROVIDER=${provider}`,
    );
  }

  return cache.incrementCounter(
    `${context.tenantDbName}:${key}`,
    windowSeconds,
    amount,
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

/**
 * Everything the guard decides on for one caller: the merged limits and the
 * counters those limits are checked against.
 *
 * Without a group policy and outside the agent domain this is the pre-group
 * algorithm to the letter — license defaults, then every applicable policy by
 * ascending priority, one counter per caller — so a tenant that uses neither
 * decides as it always did. Group policies join the SAME priority merge (a
 * higher-priority explicit user or token policy still wins a conflict); the one
 * addition is that tenant policies cap what a group hands out
 * (`applyTenantCeilings`). A `shared` group policy is the exception to the merge:
 * its counted limits become a pool of their own.
 */
async function resolveLimits(context: QuotaContext): Promise<ResolvedLimits> {
  const { licenseDefaults, policies } = await loadPolicySource(context);
  const base: QuotaLimits = {
    ...licenseDefaults,
    quotas: { ...licenseDefaults.quotas },
    rateLimit: licenseDefaults.rateLimit
      ? { ...licenseDefaults.rateLimit }
      : undefined,
  };

  const groupIds = await callerGroupIds(context, policies);
  const matching = policies.filter((p) => matchesScope(p, context, groupIds) && matchesDomain(p, context));

  const agentDomain = context.domain === 'agent';
  const hasGroupPolicy = matching.some((p) => p.scope === 'group');

  // Ascending priority, the last one wins. Where a group or agent-run limit is
  // involved, two policies of EQUAL priority are ordered by how specific their
  // target is (the editor offers priority 0 to everyone, so ties are the norm):
  // an explicit user or token limit must beat the group it belongs to, whichever
  // was written first. Policies from before groups keep their original order.
  const applicable = matching.sort(
    agentDomain || hasGroupPolicy
      ? (a, b) => a.priority - b.priority || SCOPE_SPECIFICITY[a.scope] - SCOPE_SPECIFICITY[b.scope]
      : (a, b) => a.priority - b.priority,
  );

  if (!agentDomain && !hasGroupPolicy) {
    const effective = mergePolicies(base, applicable);
    return { effective, buckets: [subjectBucket(context, effective)] };
  }

  // Agent domain: a policy narrowed to one agent (scope 'resource') is counted
  // per agent and checked on its own; everything else counts the caller's runs
  // across all agents.
  const narrowed = agentDomain ? applicable.filter((p) => p.scope === 'resource') : [];
  const wide = agentDomain ? applicable.filter((p) => p.scope !== 'resource') : applicable;

  let wideLimits = mergePolicies(base, wide);
  if (wide.some((p) => p.scope === 'group')) {
    wideLimits = applyTenantCeilings(
      wideLimits,
      mergePolicies(base, wide.filter((p) => p.scope !== 'group')),
      mergePolicies({}, wide.filter((p) => p.scope === 'tenant')),
    );
  }

  const buckets: LimitBucket[] = [subjectBucket(context, wideLimits)];
  let effective = wideLimits;

  if (narrowed.length > 0) {
    const narrowedLimits = mergePolicies({}, narrowed);
    effective = mergeLimits(wideLimits, narrowedLimits);
    buckets.push({
      id: 'resource',
      limits: narrowedLimits,
      identity: callerIdentity(context),
      scoped: { provider: false, resource: true },
      reasonPrefix: 'Agent rate limit exceeded for',
    });
  }

  // One pool per group that has a shared policy: every member's usage lands on
  // the same counter. Policies arrive priority-ordered, so the last one wins.
  const pools = new Map<string, IQuotaPolicy[]>();
  for (const policy of wide) {
    if (!isSharedGroupPolicy(policy) || !policy.scopeId) continue;
    const key = String(policy.scopeId);
    pools.set(key, [...(pools.get(key) ?? []), policy]);
  }
  for (const [groupId, members] of pools) {
    const limits = members.reduce<QuotaLimits>(
      (acc, policy) => mergeLimits(acc, statefulPart(policy.limits)),
      {},
    );
    if (!limits.rateLimit && !limits.budget) continue;
    buckets.push({
      id: `group:${groupId}`,
      limits,
      identity: `group:${groupId}`,
      scoped: { provider: !agentDomain, resource: !agentDomain },
      reasonPrefix: 'Group rate limit exceeded for',
    });
  }

  return { effective, buckets };
}

export async function resolveEffectiveLimits(
  context: QuotaContext,
): Promise<QuotaLimits> {
  return (await resolveLimits(context)).effective;
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

export interface RateLimitCost {
  requests?: number;
  tokens?: number;
  vectors?: number;
  files?: number;
  storageBytes?: number;
}

export interface CheckRateLimitOptions {
  /**
   * Counters to inspect WITHOUT counting anything, when their cost is 0: the
   * call is refused once the window has already reached its limit. This is how a
   * run whose size is only known afterwards (an agent run's tokens) is gated up
   * front; the usage itself is recorded when it is known.
   */
  headroom?: ReadonlyArray<keyof RateLimitCost>;
}

/** Per-kind wiring: where the limit sits, what the counter is called, which cost feeds it. */
const RATE_KINDS: ReadonlyArray<{
  limit: keyof QuotaRateLimit;
  counter: string;
  cost: keyof RateLimitCost;
}> = [
  { limit: 'requests', counter: 'requests', cost: 'requests' },
  { limit: 'tokens', counter: 'tokens', cost: 'tokens' },
  { limit: 'vectors', counter: 'vectors', cost: 'vectors' },
  { limit: 'files', counter: 'files', cost: 'files' },
  { limit: 'storage', counter: 'storageBytes', cost: 'storageBytes' },
];

const RATE_WINDOWS = [
  ['perSecond', 1],
  ['perMinute', 60],
  ['perHour', 3600],
  ['perDay', 86400],
  ['perMonth', 2592000],
] as const;

/** The counter-key tail shared by rate and budget keys: provider, resource, then whose usage it is. */
function counterScope(context: QuotaContext, bucket: LimitBucket): string[] {
  const parts: string[] = [];
  if (bucket.scoped.provider && context.providerKey) parts.push(`prov:${context.providerKey}`);
  if (bucket.scoped.resource && context.resourceKey) parts.push(`res:${context.resourceKey}`);
  parts.push(bucket.identity);
  return parts;
}

export async function checkRateLimit(
  context: QuotaContext,
  cost: RateLimitCost = { requests: 1, tokens: 0 },
  options: CheckRateLimitOptions = {},
): Promise<QuotaCheckResult> {
  const { effective: effectiveLimits, buckets } = await resolveLimits(context);

  if (!buckets.some((bucket) => bucket.limits.rateLimit)) {
    return { allowed: true, effectiveLimits };
  }

  const errors: string[] = [];

  const checkWindow = async (
    bucket: LimitBucket,
    kind: (typeof RATE_KINDS)[number],
    windowName: (typeof RATE_WINDOWS)[number][0],
    windowSeconds: number,
    limit: number | undefined,
    incrementBy: number,
  ) => {
    if (limit === undefined || limit === -1) return;
    const inspectOnly = incrementBy === 0;
    if (inspectOnly && !options.headroom?.includes(kind.cost)) return;

    const key = [
      'rate_limit',
      context.domain,
      kind.counter,
      windowName,
      ...counterScope(context, bucket),
    ].join(':');

    try {
      const { count } = await incrementRateLimitCounter(
        context,
        key,
        windowSeconds,
        incrementBy,
      );
      if (inspectOnly ? count >= limit : count > limit) {
        errors.push(
          `${bucket.reasonPrefix} ${kind.counter} ${windowName} (${count}/${limit})`,
        );
      }
    } catch (error) {
      logger.error('Rate limit check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      errors.push('Rate limit enforcement unavailable');
    }
  };

  const promises: Promise<void>[] = [];
  for (const bucket of buckets) {
    const rateLimit = bucket.limits.rateLimit;
    if (!rateLimit) continue;
    for (const kind of RATE_KINDS) {
      const windows = rateLimit[kind.limit];
      if (!windows) continue;
      for (const [windowName, windowSeconds] of RATE_WINDOWS) {
        promises.push(
          checkWindow(bucket, kind, windowName, windowSeconds, windows[windowName], cost[kind.cost] || 0),
        );
      }
    }
  }

  await Promise.all(promises);

  if (errors.length > 0) {
    return { allowed: false, reason: errors[0], effectiveLimits };
  }

  return { allowed: true, effectiveLimits };
}

/**
 * Micro-dollars (1 USD = 1,000,000 micros), the same precision Google/AWS
 * billing APIs use for per-call costs. Whole cents lost calls cheaper than
 * $0.005 entirely: `Math.round(0.004 * 100)` is 0, so 1,000 real $0.004
 * charges — $4 of actual spend — added up to $0 on the counter.
 */
const MICROS_PER_USD = 1_000_000;

/** "Budget exceeded: $0.026 of the $0.02 daily spend limit": the counters are micro-dollars, the message is not. */
function budgetExceededMessage(windowName: 'perDay' | 'perMonth', spentMicros: number, limitMicros: number): string {
  const label = windowName === 'perDay' ? 'daily' : 'monthly';
  return `Budget exceeded: $${formatUsd(spentMicros / MICROS_PER_USD)} of the $${formatUsd(limitMicros / MICROS_PER_USD)} ${label} spend limit`;
}

function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.max(0, Math.round(usd * MICROS_PER_USD));
}

/**
 * Debit a budget window with a call's REALIZED cost, once it is known.
 *
 * `checkBudget()` alone is a pre-flight gate — called before a call runs, or
 * with no `usd` at all it only reads the window without incrementing it.
 * Every caller that later learns the real cost (a stream's terminal usage
 * chunk, an audio/OCR provider response) must feed it back through here, or
 * the budget counter never reflects what actually happened and a hard cap
 * only ever throttles requests, never spend. Swallows its own errors — same
 * failure mode as `checkBudget`'s window-read errors — because a settlement
 * failure must never surface as a user-facing error on a call that already
 * completed and was already billed by the provider.
 */
export async function settleUsageBudget(
  context: QuotaContext,
  cost: { currency: string; totalCost: number },
): Promise<void> {
  if (cost.currency !== 'USD' || !Number.isFinite(cost.totalCost) || cost.totalCost <= 0) {
    return;
  }
  try {
    await checkBudget(context, { usd: cost.totalCost });
  } catch (error) {
    logger.error('Failed to settle realized budget usage', { error });
  }
}

export async function checkBudget(
  context: QuotaContext,
  cost: { usd?: number } = {},
): Promise<QuotaCheckResult> {
  const { effective: effectiveLimits, buckets } = await resolveLimits(context);
  const db = await getDatabase();
  await db.switchToTenant(context.tenantDbName);

  if (!buckets.some((bucket) => bucket.limits.budget)) {
    return { allowed: true, effectiveLimits };
  }

  const costMicros = usdToMicros(cost.usd ?? 0);
  const errors: string[] = [];

  const checkWindow = async (
    bucket: LimitBucket,
    windowName: 'perDay' | 'perMonth',
    limitUsd: number | undefined,
    incrementByMicros: number,
  ) => {
    if (limitUsd === undefined || limitUsd === -1) return;

    const limitMicros = usdToMicros(limitUsd);
    const windowSeconds = windowName === 'perDay' ? 86400 : 2592000;
    const key = budgetCounterKey(context, windowName, bucket);

    try {
      // Read current value without incrementing.
      const current = await db.incrementRateLimit(key, windowSeconds, 0);
      if (current.count >= limitMicros) {
        errors.push(budgetExceededMessage(windowName, current.count, limitMicros));
        return;
      }

      if (incrementByMicros > 0) {
        const updated = await db.incrementRateLimit(
          key,
          windowSeconds,
          incrementByMicros,
        );
        if (updated.count > limitMicros) {
          errors.push(budgetExceededMessage(windowName, updated.count, limitMicros));
        }
      }
    } catch (error) {
      logger.error('Budget check failed', { error });
      // Fail CLOSED, not open: this branch only runs when the tenant has an
      // actual dailySpendLimit/monthlySpendLimit configured (the early return
      // above skips it otherwise) — i.e. only for callers who explicitly
      // opted into a hard cap. Silently letting spend through on a counter
      // lookup failure made that cap meaningless during exactly the kind of
      // outage a hard cap exists to survive; it never affects a tenant that
      // hasn't configured a budget limit at all.
      errors.push(`Budget check unavailable for ${windowName}; failing closed`);
    }
  };

  await Promise.all(
    buckets.flatMap((bucket) => {
      const budget = bucket.limits.budget;
      if (!budget) return [];
      return [
        checkWindow(bucket, 'perDay', budget.dailySpendLimit, costMicros),
        checkWindow(bucket, 'perMonth', budget.monthlySpendLimit, costMicros),
      ];
    }),
  );

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

/**
 * Shared counter key scheme for `checkBudget` and `getBudgetUsage`. The default
 * bucket is the caller's own counter — what a budget has always been counted on.
 */
function budgetCounterKey(
  context: QuotaContext,
  windowName: 'perDay' | 'perMonth',
  bucket: LimitBucket = subjectBucket(context, {}),
): string {
  return ['budget', context.domain, 'usd_micros', windowName, ...counterScope(context, bucket)].join(':');
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
      usedUsd = current.count / MICROS_PER_USD;
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
