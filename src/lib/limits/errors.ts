/**
 * The refusal contract for plan limits. Every refusal carries a `code`; clients
 * switch on the code, not on the HTTP status (a provider's own 429 is a
 * different code). One error class for every entry point: the client API turns
 * it into the caller's dialect (sendClientApiError), dashboard routes send
 * `planLimitErrorBody`.
 */
import type { PlanLimitDecision, PlanLimitKind } from './types';

export type PlanLimitErrorCode =
  /** API requests per minute reached. 429 + Retry-After + X-RateLimit-*. */
  | 'tenant_rate_limited'
  /** No free slot (agent session, flow, job, browser, realtime, sandbox). 429 + Retry-After. */
  | 'tenant_concurrency_limited'
  /** Calendar-month allowance used up. 429 + Retry-After (seconds to the next month) + X-Allowance-Name. */
  | 'monthly_allowance_exhausted'
  /** Not enough credits for a managed model or service. 402. */
  | 'insufficient_credits'
  /** The credit balance cannot be read; managed calls stop (fail closed). 503 + Retry-After. */
  | 'credits_unavailable'
  /** The request is larger than a managed model call may be. 413. */
  | 'context_over_credit_cap'
  /** Stored bytes would pass the plan's storage. 413. */
  | 'storage_quota_exceeded'
  /** Seat count reached. 429. */
  | 'seat_limit_reached'
  /** The plan does not include this feature. 402. */
  | 'plan_feature_unavailable';

export const PLAN_LIMIT_STATUS: Readonly<Record<PlanLimitErrorCode, number>> = {
  tenant_rate_limited: 429,
  tenant_concurrency_limited: 429,
  monthly_allowance_exhausted: 429,
  insufficient_credits: 402,
  credits_unavailable: 503,
  context_over_credit_cap: 413,
  storage_quota_exceeded: 413,
  seat_limit_reached: 429,
  plan_feature_unavailable: 402,
};

/** OpenAI-dialect `type` (Anthropic uses the same words where they exist). */
export type PlanLimitErrorType =
  | 'rate_limit_error'
  | 'insufficient_quota'
  | 'invalid_request_error'
  | 'api_error'
  | 'permission_error';

export const PLAN_LIMIT_ERROR_TYPE: Readonly<Record<PlanLimitErrorCode, PlanLimitErrorType>> = {
  tenant_rate_limited: 'rate_limit_error',
  tenant_concurrency_limited: 'rate_limit_error',
  monthly_allowance_exhausted: 'rate_limit_error',
  insufficient_credits: 'insufficient_quota',
  credits_unavailable: 'api_error',
  context_over_credit_cap: 'invalid_request_error',
  storage_quota_exceeded: 'invalid_request_error',
  seat_limit_reached: 'rate_limit_error',
  plan_feature_unavailable: 'permission_error',
};

export interface PlanLimitErrorInput {
  code: PlanLimitErrorCode;
  message: string;
  kind: PlanLimitKind;
  dimension?: string;
  limit?: number;
  used?: number;
  retryAfterMs?: number;
  resetAt?: Date;
}

export class PlanLimitError extends Error {
  readonly status: number;
  readonly code: PlanLimitErrorCode;
  readonly type: PlanLimitErrorType;
  readonly kind: PlanLimitKind;
  readonly dimension?: string;
  readonly limit?: number;
  readonly used?: number;
  readonly retryAfterMs?: number;
  readonly resetAt?: Date;

  constructor(input: PlanLimitErrorInput) {
    super(input.message);
    this.name = 'PlanLimitError';
    this.code = input.code;
    this.status = PLAN_LIMIT_STATUS[input.code];
    this.type = PLAN_LIMIT_ERROR_TYPE[input.code];
    this.kind = input.kind;
    this.dimension = input.dimension;
    this.limit = input.limit;
    this.used = input.used;
    this.retryAfterMs = input.retryAfterMs;
    this.resetAt = input.resetAt;
  }
}

export function isPlanLimitError(error: unknown): error is PlanLimitError {
  return error instanceof PlanLimitError
    || (Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'PlanLimitError'
      && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code in PLAN_LIMIT_STATUS);
}

/** Response headers for a refusal. */
export function planLimitHeaders(error: PlanLimitError): Record<string, string> {
  const headers: Record<string, string> = { 'x-cognipeer-error-code': error.code };
  if (error.retryAfterMs !== undefined && error.retryAfterMs >= 0) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
  }
  if (error.code === 'tenant_rate_limited' && error.limit !== undefined) {
    headers['X-RateLimit-Limit'] = String(error.limit);
    headers['X-RateLimit-Remaining'] = '0';
    if (error.retryAfterMs !== undefined) {
      headers['X-RateLimit-Reset'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
    }
  }
  if (error.code === 'monthly_allowance_exhausted' && error.dimension) {
    headers['X-Allowance-Name'] = error.dimension;
  }
  return headers;
}

/** Fields shared by every body shape. */
function detailFields(error: PlanLimitError): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (error.dimension !== undefined) fields.dimension = error.dimension;
  if (error.limit !== undefined) fields.limit = error.limit;
  if (error.used !== undefined) fields.used = error.used;
  if (error.retryAfterMs !== undefined) fields.retry_after_ms = error.retryAfterMs;
  if (error.resetAt !== undefined) fields.resets_at = error.resetAt.toISOString();
  return fields;
}

/** Dashboard / console routes: `{ error, type, code, ... }`, the envelope every existing parser reads. */
export function planLimitErrorBody(error: PlanLimitError): Record<string, unknown> {
  return { error: error.message, type: error.type, code: error.code, kind: error.kind, ...detailFields(error) };
}

/** OpenAI dialect: `{ error: { type, code, message, ... } }`. */
export function planLimitOpenAiBody(error: PlanLimitError): Record<string, unknown> {
  return { error: { type: error.type, code: error.code, message: error.message, ...detailFields(error) } };
}

/** Anthropic dialect: `{ type: 'error', error: { type, message } }`; the code travels in x-cognipeer-error-code. */
export function planLimitAnthropicBody(error: PlanLimitError): Record<string, unknown> {
  const type = error.type === 'insufficient_quota' ? 'invalid_request_error' : error.type;
  return { type: 'error', error: { type, message: error.message, code: error.code, ...detailFields(error) } };
}

/** Builds the refusal for a decision that was not allowed. */
export function planLimitErrorFromDecision(
  decision: PlanLimitDecision,
  code: PlanLimitErrorCode,
  message: string,
): PlanLimitError {
  return new PlanLimitError({
    code,
    message,
    kind: decision.kind,
    dimension: decision.dimension,
    limit: decision.limit,
    used: decision.used,
    retryAfterMs: decision.retryAfterMs,
    resetAt: decision.resetAt,
  });
}
