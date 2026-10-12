/**
 * Tenant token policy and the request handling shared by every route that
 * mints or edits an API token.
 *
 * The policy lives in the tenant's IAM settings (`getIamSettings(...).tokens`,
 * see src/lib/iam/settings.ts, which also owns the rule itself:
 * `checkTokenExpiry`):
 *
 *   maxLifetimeDays  null = no limit. A token may live at most this many days
 *                    from the moment it was created.
 *   requireExpiry    every token must carry an expiry. A maximum lifetime
 *                    implies it (a token without expiry would outlive any
 *                    maximum).
 *
 * It applies to NEW tokens and to EXTENDING an expiry. Tokens that already
 * exist are never touched or rejected at authentication time: one that falls
 * outside the policy is only flagged (`exceedsTenantPolicy`) so an admin can
 * find and rotate it. A stricter-or-equal expiry is always accepted on update,
 * because refusing an edit that reduces risk would be perverse.
 *
 * The lifetime is measured from `createdAt`, not from "now": the point of a
 * maximum lifetime is that a secret gets replaced, and measuring from now
 * would let every token be renewed forever with one click.
 *
 * Pure functions plus one loader; the loader is the only thing that touches
 * the database, and it fails CLOSED (a policy that cannot be read blocks the
 * mint instead of silently skipping the rule).
 */

import { createLogger } from '@/lib/core/logger';
import type { IApiToken } from '@/lib/database';
import { checkTokenExpiry, getIamSettings, type IamSettings } from '@/lib/iam/settings';
import { validateAllowedIpRanges, type IpRangeIssueDetail } from './ipAllowlist';

const logger = createLogger('api-token-policy');

export const MS_PER_DAY = 86_400_000;

/** `expiresInDays` ceiling: a century. Anything longer is a typo, not a policy. */
export const MAX_EXPIRES_IN_DAYS = 36_500;

export const MIN_TOKEN_LABEL_LENGTH = 3;

/** The tenant IAM settings the token rules read (only `tokens` matters here). */
export type TokenPolicy = Pick<IamSettings, 'tokens'>;

export const NO_TOKEN_POLICY: Readonly<TokenPolicy> = Object.freeze({
  tokens: Object.freeze({ maxLifetimeDays: null, requireExpiry: false }),
}) as TokenPolicy;

/** Whether a new token must carry an expiry under this policy. */
export function expiryRequired(policy: TokenPolicy): boolean {
  return policy.tokens.requireExpiry || policy.tokens.maxLifetimeDays !== null;
}

// ── errors ──────────────────────────────────────────────────────────────────

export interface TokenRequestErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export interface TokenRequestError {
  status: number;
  body: TokenRequestErrorBody;
}

function requestError(status: number, code: string, error: string, details?: unknown): TokenRequestError {
  return { status, body: details === undefined ? { error, code } : { error, code, details } };
}

// ── policy check ────────────────────────────────────────────────────────────

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Whether `expiresAt` (null = never expires) is acceptable for a token created
 * at `createdAt`. Returns the refusal, or null when it complies.
 */
export function checkExpiryAgainstPolicy(args: {
  policy: TokenPolicy;
  expiresAt: Date | null;
  createdAt: Date;
}): TokenRequestError | null {
  const { policy, expiresAt, createdAt } = args;
  const result = checkTokenExpiry(policy, { expiresAt, createdAt });
  if (result.ok) return null;
  const { maxLifetimeDays } = policy.tokens;
  const latestExpiresAt = result.maxExpiresAt ? result.maxExpiresAt.toISOString() : null;
  if (result.code === 'expiry_required') {
    return requestError(
      400,
      'token_expiry_required',
      maxLifetimeDays !== null
        ? `This organization requires API tokens to expire within ${maxLifetimeDays} days of creation`
        : 'This organization requires every API token to have an expiry',
      { maxLifetimeDays, latestExpiresAt },
    );
  }
  return requestError(
    400,
    'token_expiry_too_long',
    `This organization limits API tokens to ${maxLifetimeDays} days from creation (latest allowed expiry: ${latestExpiresAt})`,
    { maxLifetimeDays, latestExpiresAt },
  );
}

/**
 * Whether an existing token falls outside the tenant policy. Informational (it
 * drives a badge) and false for a token that has already expired: that one can
 * no longer be used, so it is no longer a finding.
 */
export function tokenExceedsPolicy(
  token: Pick<IApiToken, 'createdAt' | 'expiresAt'>,
  policy: TokenPolicy,
  now: Date = new Date(),
): boolean {
  const expiresAt = toDate(token.expiresAt);
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return false;
  const createdAt = toDate(token.createdAt) ?? now;
  return checkExpiryAgainstPolicy({ policy, expiresAt, createdAt }) !== null;
}

// ── request parsing ─────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:$|[T\s])/;

export type ParsedExpiry = { provided: false } | { provided: true; value: Date | null };

/**
 * Read `expiresAt` (ISO 8601 string, or null for "never") and the convenience
 * `expiresInDays` (positive whole number, counted from `now` on the server, so
 * a client with a skewed clock cannot overshoot a maximum lifetime) from a
 * request body. Absent = "not provided" (a create treats it as never, an
 * update leaves the stored value alone). Giving both is ambiguous and refused.
 */
export function parseExpiryInput(
  input: { expiresAt?: unknown; expiresInDays?: unknown },
  now: Date,
): { ok: true; expiry: ParsedExpiry } | { ok: false; error: TokenRequestError } {
  const hasAt = input.expiresAt !== undefined;
  const hasDays = input.expiresInDays !== undefined;
  if (!hasAt && !hasDays) return { ok: true, expiry: { provided: false } };
  if (hasAt && hasDays && input.expiresAt !== null && input.expiresInDays !== null) {
    return {
      ok: false,
      error: requestError(400, 'token_expiry_invalid', 'Send either expiresAt or expiresInDays, not both'),
    };
  }

  let value: Date | null;
  if (hasAt && input.expiresAt !== null) {
    const raw = input.expiresAt;
    if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw.trim())) {
      return {
        ok: false,
        error: requestError(400, 'token_expiry_invalid', 'expiresAt must be an ISO 8601 date-time string or null'),
      };
    }
    const parsed = new Date(raw.trim());
    if (!Number.isFinite(parsed.getTime())) {
      return {
        ok: false,
        error: requestError(400, 'token_expiry_invalid', 'expiresAt is not a valid date'),
      };
    }
    value = parsed;
  } else if (hasDays && input.expiresInDays !== null) {
    const days = input.expiresInDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_IN_DAYS) {
      return {
        ok: false,
        error: requestError(
          400,
          'token_expiry_invalid',
          `expiresInDays must be a whole number between 1 and ${MAX_EXPIRES_IN_DAYS}`,
        ),
      };
    }
    value = new Date(now.getTime() + days * MS_PER_DAY);
  } else {
    value = null;
  }

  if (value && value.getTime() <= now.getTime()) {
    return {
      ok: false,
      error: requestError(400, 'token_expiry_invalid', 'The expiry must be in the future'),
    };
  }
  return { ok: true, expiry: { provided: true, value } };
}

function invalidIpRanges(message: string, issues: IpRangeIssueDetail[]): TokenRequestError {
  return requestError(
    400,
    'invalid_ip_ranges',
    message,
    issues.map(({ index, value, message: detail }) => ({ index, value, message: detail })),
  );
}

// ── policy loading ──────────────────────────────────────────────────────────

/** The policy could not be read. Callers answer 503 rather than minting without the rule. */
export class TokenPolicyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Unable to verify the API token policy');
    this.name = 'TokenPolicyUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export type TokenPolicyReader = (tenantDbName: string) => Promise<TokenPolicy>;

/** The tenant's policy; throws {@link TokenPolicyUnavailableError} when it cannot be read. */
export async function loadTokenPolicy(
  tenantDbName: string,
  reader: TokenPolicyReader = getIamSettings,
): Promise<TokenPolicy> {
  try {
    const settings = await reader(tenantDbName);
    if (!settings || typeof settings !== 'object' || !settings.tokens) {
      throw new Error('IAM settings are malformed');
    }
    return settings;
  } catch (error) {
    logger.error('Failed to read the tenant token policy', {
      tenantDbName,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new TokenPolicyUnavailableError(error);
  }
}

/** For display only (list badges): an unreadable policy shows as "no rule" instead of failing the listing. */
export async function loadTokenPolicyForDisplay(
  tenantDbName: string,
  reader: TokenPolicyReader = getIamSettings,
): Promise<TokenPolicy> {
  try {
    return await loadTokenPolicy(tenantDbName, reader);
  } catch {
    return NO_TOKEN_POLICY;
  }
}

export function policyUnavailableResponse(): TokenRequestError {
  return requestError(
    503,
    'policy_unavailable',
    'The API token policy could not be verified right now. Try again in a moment.',
  );
}

// ── create / update preparation ─────────────────────────────────────────────

export interface PreparedTokenCreate {
  ok: true;
  expiresAt: Date | null;
  allowedIpRanges: string[] | null;
  policy: TokenPolicy;
}

export type TokenPrepareFailure = { ok: false } & TokenRequestError;

export interface TokenRestrictionBody {
  expiresAt?: unknown;
  expiresInDays?: unknown;
  allowedIpRanges?: unknown;
}

/**
 * Validate the restrictions of a token being minted (expiry + IP allowlist)
 * against the request shape and the tenant policy. Every route that creates a
 * user-facing API token goes through this, so the policy cannot be sidestepped
 * by choosing another endpoint.
 */
export async function prepareTokenCreate(args: {
  body: TokenRestrictionBody;
  tenantDbName: string;
  now?: Date;
  reader?: TokenPolicyReader;
}): Promise<PreparedTokenCreate | TokenPrepareFailure> {
  const now = args.now ?? new Date();

  const expiry = parseExpiryInput(args.body, now);
  if (!expiry.ok) return { ok: false, ...expiry.error };

  const ranges = validateAllowedIpRanges(args.body.allowedIpRanges);
  if (!ranges.ok) return { ok: false, ...invalidIpRanges(ranges.message, ranges.issues) };

  let policy: TokenPolicy;
  try {
    policy = await loadTokenPolicy(args.tenantDbName, args.reader);
  } catch {
    return { ok: false, ...policyUnavailableResponse() };
  }

  const expiresAt = expiry.expiry.provided ? expiry.expiry.value : null;
  const violation = checkExpiryAgainstPolicy({ policy, expiresAt, createdAt: now });
  if (violation) return { ok: false, ...violation };

  return { ok: true, expiresAt, allowedIpRanges: ranges.ranges, policy };
}

export interface TokenPatch {
  label?: string;
  expiresAt?: Date | null;
  allowedIpRanges?: string[] | null;
}

export interface PreparedTokenUpdate {
  ok: true;
  patch: TokenPatch;
  /** The tenant policy when it was needed for the decision, else null. */
  policy: TokenPolicy | null;
}

/**
 * Validate an edit of an existing token. Only the fields present in the body
 * change. The tenant policy is consulted only when the expiry is EXTENDED
 * (a later date, or removing it): shortening or re-saving the same expiry is
 * always fine, so an unrelated edit never fails because the policy tightened
 * after the token was created.
 */
export async function prepareTokenUpdate(args: {
  body: TokenRestrictionBody & { label?: unknown };
  tenantDbName: string;
  token: Pick<IApiToken, 'createdAt' | 'expiresAt'>;
  now?: Date;
  reader?: TokenPolicyReader;
}): Promise<PreparedTokenUpdate | TokenPrepareFailure> {
  const now = args.now ?? new Date();
  const patch: TokenPatch = {};

  if (args.body.label !== undefined) {
    const label = typeof args.body.label === 'string' ? args.body.label.trim() : '';
    if (label.length < MIN_TOKEN_LABEL_LENGTH) {
      return {
        ok: false,
        ...requestError(400, 'invalid_label', `Label must be at least ${MIN_TOKEN_LABEL_LENGTH} characters`),
      };
    }
    patch.label = label;
  }

  if (args.body.allowedIpRanges !== undefined) {
    const ranges = validateAllowedIpRanges(args.body.allowedIpRanges);
    if (!ranges.ok) return { ok: false, ...invalidIpRanges(ranges.message, ranges.issues) };
    patch.allowedIpRanges = ranges.ranges;
  }

  const expiry = parseExpiryInput(args.body, now);
  if (!expiry.ok) return { ok: false, ...expiry.error };

  let policy: TokenPolicy | null = null;
  if (expiry.expiry.provided) {
    const next = expiry.expiry.value;
    const current = toDate(args.token.expiresAt);
    const unchanged = (next === null && current === null)
      || (next !== null && current !== null && next.getTime() === current.getTime());
    if (!unchanged) {
      const extending = next === null || (current !== null && next.getTime() > current.getTime());
      if (extending) {
        try {
          policy = await loadTokenPolicy(args.tenantDbName, args.reader);
        } catch {
          return { ok: false, ...policyUnavailableResponse() };
        }
        const violation = checkExpiryAgainstPolicy({
          policy,
          expiresAt: next,
          createdAt: toDate(args.token.createdAt) ?? now,
        });
        if (violation) return { ok: false, ...violation };
      }
      patch.expiresAt = next;
    }
  }

  return { ok: true, patch, policy };
}

// ── presentation ────────────────────────────────────────────────────────────

function iso(value: unknown): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

/** A stored allowlist as a clean array for responses (null = unrestricted). */
export function presentAllowedIpRanges(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return list.length === 0 ? null : list;
}

/**
 * The JSON a token list / detail / update answers with. Never contains the
 * secret or its hash. `lastUsedAt` repeats `lastUsed` under the name the IAM
 * center uses; both stay so existing clients keep working.
 */
export function presentApiToken(
  token: IApiToken,
  options: { policy: TokenPolicy; now?: Date; canDelete?: boolean; canEdit?: boolean },
) {
  const now = options.now ?? new Date();
  return {
    _id: token._id,
    canDelete: options.canDelete ?? false,
    canEdit: options.canEdit ?? false,
    createdAt: token.createdAt,
    createdBy: token.createdBy ?? null,
    label: token.label,
    lastUsed: token.lastUsed,
    lastUsedAt: iso(token.lastUsed),
    expiresAt: iso(token.expiresAt),
    // The list of ranges (an internal network map: office, CI egress...) is for whoever may edit the token.
    // Everybody sees THAT a token is restricted, which is all a badge needs.
    allowedIpRanges: options.canEdit ? presentAllowedIpRanges(token.allowedIpRanges) : null,
    ipRestricted: (presentAllowedIpRanges(token.allowedIpRanges)?.length ?? 0) > 0,
    allowedIpRangeCount: presentAllowedIpRanges(token.allowedIpRanges)?.length ?? 0,
    exceedsTenantPolicy: tokenExceedsPolicy(token, options.policy, now),
    servicePermissions: token.servicePermissions ?? null,
    tokenPrefix: token.tokenPrefix,
    userId: token.userId,
  };
}
