/**
 * Pure model of the API-token screens: the token row as the API returns it,
 * the status badges, the expiry choices a form offers under the tenant policy,
 * the request payload, and the IP allowlist text parsing.
 *
 * No React, no Mantine, no server imports: it runs in the browser and in node
 * tests. The IP rules are the SAME module the server enforces with.
 */

import {
  MAX_ALLOWED_IP_RANGES,
  checkCidr,
  splitIpRangeText,
  type CidrIssue,
} from '@/lib/services/apiTokens/ipAllowlist';

export const DAY_MS = 86_400_000;

/** A token that has not been used for this long gets the "unused" badge. */
export const UNUSED_AFTER_DAYS = 30;

/** Expiry presets offered by the forms (days from now). */
export const EXPIRY_PRESET_DAYS = [7, 30, 90, 180, 365] as const;

/** Mirrors the server's `expiresInDays` ceiling. */
export const MAX_EXPIRY_DAYS = 36_500;

// ── the token as the dashboard API returns it ──────────────────────────────

export interface ApiTokenRow {
  _id: string;
  label: string;
  token?: string;
  tokenPrefix?: string;
  userId?: string;
  createdBy?: string | null;
  canDelete?: boolean;
  canEdit?: boolean;
  createdAt: string;
  lastUsed?: string | null;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  /** The ranges, only for someone who may edit the token (null for everybody else, whatever the token carries). */
  allowedIpRanges?: string[] | null;
  /** Whether the token carries an allowlist, for everybody (the badge); `allowedIpRangeCount` is its size. */
  ipRestricted?: boolean;
  allowedIpRangeCount?: number;
  /** The token is only served on behalf of a verified person (a user token must accompany every call). */
  requireUserToken?: boolean;
  exceedsTenantPolicy?: boolean;
  servicePermissions?: Record<string, string> | null;
}

/** `GET /api/tokens/policy`. */
export interface TokenPolicyView {
  maxLifetimeDays: number | null;
  requireExpiry: boolean;
  /** Effective: required explicitly, or implied by a maximum lifetime. */
  expiryRequired: boolean;
  maxIpRanges: number;
  /** The address the server resolved for the dashboard request (a hint for allowlists). */
  clientIp: string | null;
  /** The server trusts forwarded-for headers from every caller (TRUSTED_PROXIES unset): allowlists can be talked around. */
  trustsForwardedHeaders: boolean;
}

export const NO_POLICY: TokenPolicyView = {
  maxLifetimeDays: null,
  requireExpiry: false,
  expiryRequired: false,
  maxIpRanges: MAX_ALLOWED_IP_RANGES,
  clientIp: null,
  trustsForwardedHeaders: false,
};

export function normalizeTokenPolicy(raw: unknown): TokenPolicyView {
  if (!raw || typeof raw !== 'object') return { ...NO_POLICY };
  const o = raw as Record<string, unknown>;
  const days = o.maxLifetimeDays;
  const maxLifetimeDays = typeof days === 'number' && Number.isFinite(days) && days >= 1 ? Math.floor(days) : null;
  const requireExpiry = o.requireExpiry === true;
  const maxRanges = o.maxIpRanges;
  return {
    maxLifetimeDays,
    requireExpiry,
    expiryRequired: o.expiryRequired === true || requireExpiry || maxLifetimeDays !== null,
    maxIpRanges: typeof maxRanges === 'number' && maxRanges > 0 ? Math.floor(maxRanges) : MAX_ALLOWED_IP_RANGES,
    clientIp: typeof o.clientIp === 'string' && o.clientIp ? displayClientIp(o.clientIp) : null,
    trustsForwardedHeaders: o.trustsForwardedHeaders === true,
  };
}

/** A dual-stack socket reports an IPv4 client as `::ffff:203.0.113.7`; people think of it as `203.0.113.7`. */
export function displayClientIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  return mapped ? mapped[1] : ip.trim();
}

// ── status badges ───────────────────────────────────────────────────────────

export type TokenStatusKind = 'expired' | 'exceedsPolicy' | 'unused' | 'ipRestricted';

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function isTokenExpired(token: Pick<ApiTokenRow, 'expiresAt'>, now: number = Date.now()): boolean {
  const expires = ms(token.expiresAt);
  return expires !== null && expires <= now;
}

/**
 * The badges a token row gets, most important first:
 *  - expired        past its expiry (it no longer authenticates)
 *  - exceedsPolicy  falls outside the tenant's token policy (the server says so;
 *                   never shown together with "expired", which already ends it)
 *  - unused         not used for 30+ days (never used: counted from creation)
 *  - ipRestricted   carries an IP allowlist (informational)
 */
export function tokenStatuses(
  token: Pick<ApiTokenRow, 'expiresAt' | 'exceedsTenantPolicy' | 'lastUsed' | 'lastUsedAt' | 'createdAt' | 'allowedIpRanges' | 'ipRestricted' | 'allowedIpRangeCount'>,
  now: number = Date.now(),
): TokenStatusKind[] {
  const out: TokenStatusKind[] = [];
  const expired = isTokenExpired(token, now);
  if (expired) out.push('expired');
  if (!expired && token.exceedsTenantPolicy === true) out.push('exceedsPolicy');
  if (!expired) {
    const lastActivity = ms(token.lastUsedAt ?? token.lastUsed) ?? ms(token.createdAt);
    if (lastActivity !== null && now - lastActivity >= UNUSED_AFTER_DAYS * DAY_MS) out.push('unused');
  }
  if (token.ipRestricted === true || (token.allowedIpRangeCount ?? 0) > 0 || (Array.isArray(token.allowedIpRanges) && token.allowedIpRanges.length > 0)) out.push('ipRestricted');
  return out;
}

// ── expiry choices ──────────────────────────────────────────────────────────

/**
 * What the user picked for the expiry.
 *  keep   (edit only) leave the stored expiry alone
 *  none   the token never expires
 *  days   expires this many days from now (server clock)
 *  date   expires on a calendar day, `yyyy-mm-dd` in the user's time zone
 */
export type ExpiryChoice =
  | { kind: 'keep' }
  | { kind: 'none' }
  | { kind: 'days'; days: number }
  | { kind: 'date'; date: string };

export interface ExpiryContext {
  policy: Pick<TokenPolicyView, 'maxLifetimeDays' | 'expiryRequired'>;
  /** Edit mode: when the token was created (the lifetime maximum counts from here). */
  createdAt?: string | null;
  now?: number;
}

/** `yyyy-mm-dd` of a local date. */
export function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a `yyyy-mm-dd` value, or null when it is not a date. */
export function fromDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole calendar days from today to `date` (local days; DST safe). */
export function daysFromToday(date: Date, now: number = Date.now()): number {
  const today = startOfDay(now);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
    - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / DAY_MS);
}

export function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/**
 * The most days from now a form may offer, or null for "no maximum". Counted
 * from the token's creation (a new token: now), rounded DOWN so the server's
 * exact comparison can never reject what the form allowed.
 */
export function maxDaysFromNow(ctx: ExpiryContext): number | null {
  const max = ctx.policy.maxLifetimeDays;
  if (max === null) return null;
  const now = ctx.now ?? Date.now();
  const created = ctx.createdAt ? ms(ctx.createdAt) : null;
  if (created === null) return max;
  return Math.max(0, Math.floor((created + max * DAY_MS - now) / DAY_MS));
}

/** Presets that fit under the maximum, plus the maximum itself when it is not a preset. */
export function expiryPresets(ctx: ExpiryContext): number[] {
  const max = maxDaysFromNow(ctx);
  if (max === null) return [...EXPIRY_PRESET_DAYS];
  if (max < 1) return [];
  const fitting: number[] = EXPIRY_PRESET_DAYS.filter((days) => days <= max);
  if (!fitting.includes(max)) fitting.push(max);
  return fitting.sort((a, b) => a - b);
}

/** The first choice of a form: the tenant's rule decides, otherwise nothing changes for the user. */
export function defaultExpiryChoice(ctx: ExpiryContext & { mode: 'create' | 'edit' }): ExpiryChoice {
  if (ctx.mode === 'edit') return { kind: 'keep' };
  if (!ctx.policy.expiryRequired) return { kind: 'none' };
  const presets = expiryPresets(ctx);
  const preferred = presets.filter((d) => d <= 90).pop() ?? presets[0];
  return { kind: 'days', days: preferred ?? 1 };
}

export type ExpiryProblem = 'required' | 'tooLong' | 'invalidDate' | 'notFuture';

/** Why a choice cannot be submitted (null = fine). Mirrors what the server checks. */
export function expiryProblem(choice: ExpiryChoice, ctx: ExpiryContext): ExpiryProblem | null {
  const max = maxDaysFromNow(ctx);
  switch (choice.kind) {
    case 'keep':
      return null;
    case 'none':
      return ctx.policy.expiryRequired ? 'required' : null;
    case 'days':
      if (!Number.isInteger(choice.days) || choice.days < 1) return 'notFuture';
      return max !== null && choice.days > max ? 'tooLong' : null;
    case 'date': {
      const date = fromDateInput(choice.date);
      if (!date) return 'invalidDate';
      const days = daysFromToday(date, ctx.now);
      if (days < 1) return 'notFuture';
      return max !== null && days > max ? 'tooLong' : null;
    }
  }
}

/**
 * The request fields for a choice. `keep` sends nothing. `none` sends nothing on
 * create (a missing expiry means "never") and an explicit null on edit. Dates
 * are sent as "N days from now", counted by the server, so a browser clock that
 * is a little off can never overshoot a maximum lifetime.
 */
export function expiryPayload(
  choice: ExpiryChoice,
  mode: 'create' | 'edit',
  now: number = Date.now(),
): { expiresInDays?: number; expiresAt?: null } {
  switch (choice.kind) {
    case 'keep':
      return {};
    case 'none':
      return mode === 'edit' ? { expiresAt: null } : {};
    case 'days':
      return { expiresInDays: choice.days };
    case 'date': {
      const date = fromDateInput(choice.date);
      return date ? { expiresInDays: Math.max(1, daysFromToday(date, now)) } : {};
    }
  }
}

/** When a choice would expire the token (local), for the summary line. Null = never / unchanged. */
export function expiryPreview(choice: ExpiryChoice, now: number = Date.now()): Date | null {
  switch (choice.kind) {
    case 'keep':
    case 'none':
      return null;
    case 'days':
      return new Date(now + choice.days * DAY_MS);
    case 'date': {
      const date = fromDateInput(choice.date);
      return date ? new Date(now + Math.max(1, daysFromToday(date, now)) * DAY_MS) : null;
    }
  }
}

// ── IP allowlist text ───────────────────────────────────────────────────────

export interface AllowlistIssue {
  /** 1-based position among the entered ranges. */
  position: number;
  value: string;
  reason: CidrIssue;
}

export interface ParsedAllowlist {
  /** Normalized, de-duplicated ranges. */
  ranges: string[];
  issues: AllowlistIssue[];
  tooMany: boolean;
}

export function parseAllowlistText(text: string, maxRanges: number = MAX_ALLOWED_IP_RANGES): ParsedAllowlist {
  const entries = splitIpRangeText(text);
  const ranges: string[] = [];
  const issues: AllowlistIssue[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const check = checkCidr(entry);
    if (!check.ok) {
      issues.push({ position: index + 1, value: entry, reason: check.reason });
      return;
    }
    if (seen.has(check.normalized)) return;
    seen.add(check.normalized);
    ranges.push(check.normalized);
  });
  return { ranges, issues, tooMany: ranges.length > maxRanges };
}

/** The textarea content for a stored list (one range per line). */
export function allowlistToText(ranges: readonly string[] | null | undefined): string {
  return (ranges ?? []).join('\n');
}

/** Whether two normalized lists are the same set in the same order. */
export function sameRanges(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((item, i) => item === right[i]);
}
