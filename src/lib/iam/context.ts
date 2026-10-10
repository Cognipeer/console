/**
 * Request context of an authorization decision (A3).
 *
 * What the gate (and the simulator) knows about the request that a policy may
 * condition on. Always optional: a call supplies only what it knows and a
 * policy guards with `context has ip && ...`.
 *
 *   projectId  the project the request runs in (resolved the way the handler
 *              resolves it, not the raw cookie)
 *   channel    'dashboard' (cookie session), 'api' (API token), 'portal' (a person using a
 *              portal: opening it, running its agents - resourceAuthz.ts)
 *   ip         the caller's address as the server's trust-proxy setting sees it
 *              (Cedar `ipaddr` extension); never a raw X-Forwarded-For
 *   now        the decision time (Cedar `datetime` extension); filled in by the
 *              engine when the caller does not provide one
 *   method     HTTP method
 *   path       canonical request path (no query string)
 *
 * Why the care around `ip` and `now`: Cedar evaluates a request atomically. A
 * context attribute that does not parse (`ip("unknown")`, an IPv4-mapped IPv6
 * address, a malformed date) does not just fail one policy, it fails the whole
 * authorization call, which the gate would answer with 503 "authorization
 * unavailable". So every value is parsed here first and an unusable one (an odd
 * forwarded address, say) is simply left out of the context.
 */

import { isIP } from 'node:net';

export const IAM_CHANNELS = ['dashboard', 'api', 'portal'] as const;
export type IamChannel = typeof IAM_CHANNELS[number];

export function isIamChannel(value: unknown): value is IamChannel {
  return typeof value === 'string' && (IAM_CHANNELS as readonly string[]).includes(value);
}

export interface IamRequestContext {
  projectId?: string | null;
  channel?: string | null;
  ip?: string | null;
  now?: Date | string | number | null;
  method?: string | null;
  path?: string | null;
}

/** The context of a Cedar request: plain strings and extension values. */
export type CedarContextValue = string | { __extn: { fn: string; arg: string } };
export type CedarContext = Record<string, CedarContextValue>;

const MAX_STRING = 512;

// ── addresses ────────────────────────────────────────────────────────────

/** Canonical (compressed, lower-case) form of an IPv6 literal, or null. Uses the WHATWG URL parser. */
function canonicalIpv6(address: string): string | null {
  try {
    const host = new URL(`http://[${address}]/`).hostname; // "[::1]"
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : null;
  } catch {
    return null;
  }
}

/** `::ffff:a00:1` (what the URL parser makes of `::ffff:10.0.0.1`) -> `10.0.0.1`. */
function unmapIpv4(canonical: string): string | null {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!m) return null;
  const hi = Number.parseInt(m[1], 16);
  const lo = Number.parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * A request address in the form Cedar's `ip()` accepts, or null.
 *
 *  - IPv4-mapped IPv6 (`::ffff:10.0.0.1`, also reported by dual-stack sockets)
 *    becomes plain IPv4, so a policy written for `10.0.0.0/8` matches it;
 *  - a zone id (`fe80::1%eth0`) and surrounding brackets are dropped;
 *  - anything that is not an address (`unknown`, a hostname, a list) is null.
 */
export function normalizeIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value || value.length > 64) return null;
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind === 6) {
    const canonical = canonicalIpv6(value);
    if (!canonical) return null;
    return unmapIpv4(canonical) ?? canonical;
  }
  return null;
}

export type CidrParse = { ok: true; cidr: string } | { ok: false; error: string };

/**
 * Validate and normalise a CIDR range (or a single address) for `ip("...")`.
 * `10.0.0.0/8`, `192.168.1.7` (= /32), `2001:db8::/32` are accepted; the
 * prefix length must fit the address family.
 */
export function parseCidr(input: unknown): CidrParse {
  if (typeof input !== 'string') return { ok: false, error: 'An IP range must be text such as 10.0.0.0/8' };
  const text = input.trim();
  if (!text || text.length > 64) return { ok: false, error: 'Not a valid IP range' };
  const slash = text.indexOf('/');
  const addressPart = slash === -1 ? text : text.slice(0, slash);
  const prefixPart = slash === -1 ? null : text.slice(slash + 1);
  const kind = isIP(addressPart);
  if (kind === 0) return { ok: false, error: `"${text}" is not a valid IP address or CIDR range` };
  let address = addressPart;
  if (kind === 6) {
    const canonical = canonicalIpv6(addressPart);
    // Cedar refuses IPv4 embedded in IPv6; a mapped address has no CIDR meaning here either.
    if (!canonical || canonical.includes('.') || unmapIpv4(canonical)) {
      return { ok: false, error: `"${text}" is not a supported IPv6 range` };
    }
    address = canonical;
  }
  const max = kind === 4 ? 32 : 128;
  if (prefixPart === null) return { ok: true, cidr: address };
  if (!/^\d{1,3}$/.test(prefixPart)) return { ok: false, error: `"${text}" has an invalid prefix length` };
  const prefix = Number.parseInt(prefixPart, 10);
  if (prefix < 0 || prefix > max) return { ok: false, error: `The prefix length of "${text}" must be between 0 and ${max}` };
  return { ok: true, cidr: `${address}/${prefix}` };
}

// ── time ─────────────────────────────────────────────────────────────────

/** Cedar `datetime("...")` literal text for an instant: `2026-10-09T12:00:00.000Z`. */
export function toCedarDatetime(value: Date | string | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  const year = date.getUTCFullYear();
  if (year < 1970 || year > 9999) return null;
  return date.toISOString();
}

// ── context ──────────────────────────────────────────────────────────────

const clip = (value: string): string => (value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value);

/**
 * The Cedar context for a request. Only usable values are included; `now`
 * defaults to the current time (a policy set is cached, a decision is not).
 */
export function buildCedarContext(context: IamRequestContext | undefined | null, now: Date = new Date()): CedarContext {
  const out: CedarContext = {};
  const c = context ?? {};
  if (typeof c.projectId === 'string' && c.projectId) out.projectId = clip(c.projectId);
  if (typeof c.channel === 'string' && c.channel) out.channel = clip(c.channel);
  if (typeof c.method === 'string' && c.method) out.method = clip(c.method.toUpperCase());
  if (typeof c.path === 'string' && c.path) out.path = clip(c.path);
  const ip = normalizeIp(c.ip);
  if (ip) out.ip = { __extn: { fn: 'ip', arg: ip } };
  const at = toCedarDatetime(c.now ?? now) ?? toCedarDatetime(now);
  if (at) out.now = { __extn: { fn: 'datetime', arg: at } };
  return out;
}
