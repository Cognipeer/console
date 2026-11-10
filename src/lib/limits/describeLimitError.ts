/**
 * Client-safe reading of a plan-limit refusal: turns an error response (any dialect the server
 * sends) into a small value, and that value into a `usageLimits` message key plus placeholder
 * values. Imports only the code table from errors.ts (no server modules).
 */
import { PLAN_LIMIT_STATUS, type PlanLimitErrorCode } from './errors';
import type { PlanLimitKind } from './types';

export interface LimitErrorInfo {
  code: PlanLimitErrorCode;
  kind?: PlanLimitKind;
  dimension?: string;
  limit?: number;
  used?: number;
  retryAfterMs?: number;
  /** ISO timestamp the allowance resets at. */
  resetAt?: string;
}

function isPlanLimitCode(value: unknown): value is PlanLimitErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLAN_LIMIT_STATUS, value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads a refusal from a response. Accepts the dashboard envelope `{ error: string, code, ... }`,
 * the OpenAI one `{ error: { code, ... } }` and the Anthropic one `{ type: 'error', error: { code, ... } }`.
 * Returns null when the body carries no plan-limit code. `status` is not needed to decide (the code
 * is the contract) and is accepted so call sites can pass what they have.
 */
export function parseLimitError(
  _status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): LimitErrorInfo | null {
  const root = asRecord(body);
  if (!root) return null;
  const inner = asRecord(root.error);
  const source = inner && isPlanLimitCode(inner.code) ? inner : root;
  if (!isPlanLimitCode(source.code)) return null;

  const headerSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const headerMs = Number.isFinite(headerSeconds) && headerSeconds >= 0 ? Math.round(headerSeconds * 1000) : undefined;

  const info: LimitErrorInfo = { code: source.code };
  const kind = str(source.kind);
  if (kind) info.kind = kind as PlanLimitKind;
  const dimension = str(source.dimension);
  if (dimension) info.dimension = dimension;
  const limit = num(source.limit);
  if (limit !== undefined) info.limit = limit;
  const used = num(source.used);
  if (used !== undefined) info.used = used;
  const retryAfterMs = num(source.retry_after_ms) ?? num(source.retryAfterMs) ?? headerMs;
  if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
  const resetAt = str(source.resets_at) ?? str(source.resetAt);
  if (resetAt) info.resetAt = resetAt;
  return info;
}

const SECONDS_CODES: ReadonlySet<PlanLimitErrorCode> = new Set([
  'tenant_rate_limited',
  'tenant_concurrency_limited',
  'credits_unavailable',
]);

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Key of the message text inside the `usageLimits` namespace (title: `limitTitleKey`). */
export function limitMessageKey(info: LimitErrorInfo): string {
  const base = `codes.${info.code}`;
  if (SECONDS_CODES.has(info.code) && info.retryAfterMs === undefined) return `${base}.messageNoWait`;
  if (info.code === 'monthly_allowance_exhausted' && !validDate(info.resetAt)) return `${base}.messageNoDate`;
  return `${base}.message`;
}

/** Key of the title inside the `usageLimits` namespace. */
export function limitTitleKey(info: LimitErrorInfo): string {
  return `codes.${info.code}.title`;
}

/** Key of a dimension label inside the `usageLimits` namespace. */
export function limitDimensionKey(dimension: string | undefined): string {
  switch (dimension) {
    case 'apiRpm': case 'agent': case 'flow': case 'job': case 'crawler': case 'browser': case 'realtime': case 'sandbox':
    case 'searches': case 'flowRuns': case 'crawlerPages': case 'sandboxHours': case 'sandboxSeconds':
      return `dimensions.${dimension}`;
    default:
      return 'dimensions.unknown';
  }
}

/**
 * Placeholder values for the message: {limit}, {used}, {seconds}, {date}, {dimension}.
 * `dimensionLabel` turns a dimension key (see `limitDimensionKey`) into text; without it the raw
 * dimension name is used.
 */
export function limitMessageValues(
  info: LimitErrorInfo,
  options: { dimensionLabel?: (key: string) => string; locale?: string } = {},
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  if (info.limit !== undefined) values.limit = info.limit;
  if (info.used !== undefined) values.used = info.used;
  if (info.retryAfterMs !== undefined) values.seconds = Math.max(1, Math.ceil(info.retryAfterMs / 1000));
  const reset = validDate(info.resetAt);
  if (reset) values.date = reset.toLocaleDateString(options.locale, { year: 'numeric', month: 'short', day: 'numeric' });
  values.dimension = options.dimensionLabel
    ? options.dimensionLabel(limitDimensionKey(info.dimension))
    : (info.dimension ?? '');
  return values;
}
