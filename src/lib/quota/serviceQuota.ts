/**
 * The quota check a service runs at its own entry point.
 *
 * The model routes check quota in their Fastify handlers, where the caller is
 * at hand. The services added with the domain registry (web search, knowledge,
 * MCP, memory...) are reached from several places at once — an HTTP route, an
 * agent tool, a flow node — so they check inside the service, once, and this
 * module builds the guard context there:
 *
 *  - the tenant and project come from the call itself (every service call has
 *    them);
 *  - the caller (user, API token) and the client address come from the call
 *    when it names them, else from the request context the wrappers opened
 *    (`runWithRequestContext`), which an agent run and its tools inherit.
 *
 * A call without a tenant or project is not checked (system work, migrations):
 * project policies are loaded per project, and loading them for "no project"
 * would read every project's.
 *
 * A refusal is thrown as `QuotaExceededError` (status 429), so an HTTP route
 * answers 429 and an agent tool reports the reason to the model.
 */
import { createLogger } from '@/lib/core/logger';
import { getRequestContext } from '@/lib/core/requestContext';
import {
  checkConcurrency,
  checkRateLimit,
  type QuotaContext,
  type RateLimitCost,
} from './quotaGuard';
import type { QuotaDomain } from './types';

const logger = createLogger('service-quota');

export class QuotaExceededError extends Error {
  readonly status = 429;
  readonly statusCode = 429;
  readonly code = 'quota_exceeded';
  readonly type = 'rate_limit_error';

  constructor(message: string, readonly domain: QuotaDomain) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export function isQuotaExceededError(error: unknown): error is QuotaExceededError {
  return error instanceof QuotaExceededError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError');
}

/** The 429 body the client API uses for quota refusals. */
export function quotaExceededBody(error: { message: string }) {
  return { error: { message: error.message, type: 'rate_limit_error', code: 'quota_exceeded' } };
}

/** Who a service call is for. */
export interface ServiceQuotaScope {
  tenantDbName?: string | null;
  tenantId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  tokenId?: string | null;
  /** Only when the call site has the request itself (public routes); otherwise the request context's is used. */
  clientIp?: string | null;
}

export interface ServiceQuotaCheck {
  domain: QuotaDomain;
  resourceKey?: string | null;
  providerKey?: string | null;
  /** What the call costs up front. Defaults to one request. */
  cost?: RateLimitCost;
  /**
   * Counters whose cost is only known afterwards (crawled pages, sandbox
   * minutes): checked for room now, counted with `recordServiceUsage` later.
   */
  headroom?: ReadonlyArray<keyof RateLimitCost>;
  /** Sessions the caller already has open, checked against `maxConcurrentRequests`. */
  concurrency?: { active: number };
}

/**
 * Options of a guarded service function. `quota: false` is for work a service
 * does on behalf of a call that is already counted elsewhere (an agent turn
 * reading its memory, a knowledge query reranking its own matches): that work
 * belongs to the outer call's limits, and refusing it would silently degrade
 * the outer call. Never set it from request input.
 */
export interface ServiceCallOptions {
  quota?: boolean;
}

const str = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** The guard context of a service call, or null when the call is not checked. */
export function serviceQuotaContext(scope: ServiceQuotaScope, check: ServiceQuotaCheck): QuotaContext | null {
  const tenantDbName = str(scope.tenantDbName);
  const tenantId = str(scope.tenantId);
  const request = getRequestContext();
  // The request context only speaks for the tenant it was opened for.
  const sameTenant = request !== undefined && (!request.tenantId || !tenantId || String(request.tenantId) === tenantId);
  const projectId = str(scope.projectId) ?? (sameTenant ? str(request?.projectId) : undefined);
  if (!tenantDbName || !tenantId || !projectId) return null;

  return {
    tenantDbName,
    tenantId,
    projectId,
    domain: check.domain,
    userId: str(scope.userId) ?? (sameTenant ? str(request?.userId) : undefined),
    tokenId: str(scope.tokenId) ?? (sameTenant ? str(request?.apiTokenId) : undefined),
    clientIp: str(scope.clientIp) ?? (sameTenant ? str(request?.clientIp) : undefined),
    resourceKey: str(check.resourceKey),
    providerKey: str(check.providerKey),
  };
}

/**
 * Check (and count) a service call. Returns the context it was checked with,
 * for `recordServiceUsage`, or null when the call is not checked. Throws
 * `QuotaExceededError` when a limit refuses it.
 */
export async function enforceServiceQuota(
  scope: ServiceQuotaScope,
  check: ServiceQuotaCheck,
): Promise<QuotaContext | null> {
  const context = serviceQuotaContext(scope, check);
  if (!context) return null;

  if (check.concurrency) {
    const concurrent = await checkConcurrency(context, check.concurrency.active);
    if (!concurrent.allowed) throw new QuotaExceededError(concurrent.reason || 'Quota exceeded', check.domain);
  }

  const result = await checkRateLimit(context, check.cost ?? { requests: 1 }, { headroom: check.headroom });
  if (!result.allowed) throw new QuotaExceededError(result.reason || 'Quota exceeded', check.domain);
  return context;
}

/**
 * Count usage that was only known once the work ended (pages a crawl fetched,
 * minutes a sandbox ran). Never refuses — the work is done — and never throws.
 */
export async function recordServiceUsage(context: QuotaContext | null, cost: RateLimitCost): Promise<void> {
  if (!context) return;
  const total = Object.values(cost).reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  if (total <= 0) return;
  try {
    await checkRateLimit(context, cost);
  } catch (error) {
    logger.warn('Failed to record service usage', {
      domain: context.domain,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
