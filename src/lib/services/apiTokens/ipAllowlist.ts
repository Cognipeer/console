/**
 * IP allowlists for API tokens.
 *
 * A token may carry `allowedIpRanges`: a list of CIDR ranges (IPv4 or IPv6, a
 * bare address means /32 or /128). When the list is non-empty the token only
 * authenticates from an address inside one of the ranges; an absent / null /
 * empty list leaves the token unrestricted (every token minted before this
 * feature, and every token minted without a list).
 *
 * The module is pure and dependency-free (no `node:net`, no BigInt), so the
 * dashboard form validates with exactly the code the server enforces with, and
 * it runs on the ES2017 build target.
 *
 * The address that is matched is whatever the caller hands in. The server hands
 * in Fastify's `request.ip`, i.e. the connection address, or the forwarded one
 * ONLY when the immediate peer is listed in `TRUSTED_PROXIES`. A raw
 * X-Forwarded-For header is never read here.
 *
 * Failure direction: this is a security control, so everything ambiguous
 * denies. A restricted token with an unparseable client address is refused, and
 * a stored list whose entries cannot be parsed matches nothing instead of
 * silently turning into "unrestricted".
 */

/** The refusal code for a token used from an address outside its allowlist. */
export const TOKEN_IP_NOT_ALLOWED = 'ip_not_allowed';

/** Upper bound on ranges per token (keeps the auth-cache entry and the form sane). */
export const MAX_ALLOWED_IP_RANGES = 100;

/** Longest accepted range text: a full IPv6 literal plus "/128" fits in 45 + 4. */
const MAX_RANGE_LENGTH = 64;

/** An address as numeric parts: 4 octets (family 4) or 8 sixteen-bit groups (family 6). */
export interface ParsedIp {
  family: 4 | 6;
  parts: number[];
}

export interface ParsedCidr extends ParsedIp {
  prefix: number;
}

const V4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const V4_RE = new RegExp(`^${V4_OCTET}(?:\\.${V4_OCTET}){3}$`);
const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/** Dotted-quad IPv4 (no leading zeros, no short forms) to its four octets, else null. */
export function parseIpv4(text: string): number[] | null {
  if (!V4_RE.test(text)) return null;
  return text.split('.').map(Number);
}

/** IPv6 literal (with `::` compression and an optional dotted IPv4 tail) to eight groups, else null. */
export function parseIpv6(text: string): number[] | null {
  if (text.length === 0 || text.length > 45) return null;
  let s = text;

  // An embedded IPv4 tail (`::ffff:10.0.0.1`) is rewritten as its two hex groups.
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = compressed && halves[1] !== '' ? halves[1].split(':') : [];
  const total = head.length + rest.length;
  if (compressed ? total > 7 : total !== 8) return null;

  const groups = compressed
    ? [...head, ...new Array<string>(8 - total).fill('0'), ...rest]
    : head;
  const parts: number[] = [];
  for (const group of groups) {
    if (!HEX_GROUP_RE.test(group)) return null;
    parts.push(parseInt(group, 16));
  }
  return parts;
}

/** `::ffff:a.b.c.d` (IPv4-mapped) as the plain IPv4 address; every other address unchanged. */
function unmapIpv4(ip: ParsedIp): ParsedIp {
  if (ip.family !== 6) return ip;
  const p = ip.parts;
  const mapped = p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0xffff;
  if (!mapped) return ip;
  return { family: 4, parts: [p[6] >> 8, p[6] & 0xff, p[7] >> 8, p[7] & 0xff] };
}

function parseAddress(text: string): ParsedIp | null {
  const v4 = parseIpv4(text);
  if (v4) return { family: 4, parts: v4 };
  const v6 = parseIpv6(text);
  return v6 ? { family: 6, parts: v6 } : null;
}

/**
 * The address a request came from, as the server resolved it. Tolerates what a
 * socket layer produces: brackets (`[::1]`), a zone id (`fe80::1%eth0`) and
 * IPv4-mapped IPv6 (`::ffff:203.0.113.7`, what a dual-stack listener reports for
 * an IPv4 client), which is returned as the plain IPv4 address so it matches
 * IPv4 ranges. Null when it is not an IP address at all (`unknown`, empty...).
 */
export function parseClientIp(raw: string | null | undefined): ParsedIp | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text === '' || text.length > MAX_RANGE_LENGTH) return null;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const ip = parseAddress(text);
  return ip ? unmapIpv4(ip) : null;
}

export type CidrIssue = 'empty' | 'tooLong' | 'address' | 'prefix';

export type CidrCheck =
  | { ok: true; normalized: string; cidr: ParsedCidr }
  | { ok: false; reason: CidrIssue };

/**
 * Parse one range. A bare address gets its full-length prefix. The normalized
 * text is what is stored: the address as typed (IPv6 lower-cased) plus a
 * canonical decimal prefix. Host bits are allowed (`10.0.0.5/24` is the
 * 10.0.0.0/24 network), as in every common tool.
 */
export function checkCidr(input: string): CidrCheck {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.length > MAX_RANGE_LENGTH) return { ok: false, reason: 'tooLong' };

  const slash = text.indexOf('/');
  const addressText = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? null : text.slice(slash + 1);

  const address = parseAddress(addressText);
  if (!address) return { ok: false, reason: 'address' };

  const maxPrefix = address.family === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (prefixText !== null) {
    if (!/^\d{1,3}$/.test(prefixText)) return { ok: false, reason: 'prefix' };
    prefix = Number(prefixText);
    if (prefix > maxPrefix) return { ok: false, reason: 'prefix' };
  }

  const normalized = `${address.family === 6 ? addressText.toLowerCase() : addressText}/${prefix}`;
  return { ok: true, normalized, cidr: unmapRange({ ...address, prefix }) };
}

/** An IPv4-mapped IPv6 range of /96 or longer is the same set as the IPv4 range it embeds. */
function unmapRange(range: ParsedCidr): ParsedCidr {
  if (range.family !== 6 || range.prefix < 96) return range;
  const unmapped = unmapIpv4(range);
  if (unmapped === range) return range;
  return { ...unmapped, prefix: range.prefix - 96 };
}

/** Whether the first `prefix` bits of two same-family addresses agree. */
function prefixMatches(a: number[], b: number[], prefix: number, groupBits: number): boolean {
  let remaining = prefix;
  for (let i = 0; i < a.length && remaining > 0; i++) {
    const bits = Math.min(groupBits, remaining);
    const shift = groupBits - bits;
    if ((a[i] >> shift) !== (b[i] >> shift)) return false;
    remaining -= bits;
  }
  return true;
}

export function ipMatchesRange(ip: ParsedIp, range: ParsedCidr): boolean {
  if (ip.family !== range.family) return false;
  return prefixMatches(ip.parts, range.parts, range.prefix, ip.family === 4 ? 8 : 16);
}

// ── stored lists ────────────────────────────────────────────────────────────

/**
 * The stored value as a list of range strings, or null when the token is
 * unrestricted. Corrupt shapes do NOT read as unrestricted: a value that is
 * present but not a clean list becomes `['']`, which parses to nothing and so
 * denies every address.
 */
function coerceStoredRanges(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.length === 0 ? null : value.map((item) => (typeof item === 'string' ? item : ''));
  }
  if (typeof value === 'string') return value.trim() === '' ? null : [value];
  return [''];
}

/** True when the token carries an allowlist (the stored value, however malformed, restricts). */
export function hasIpRestriction(value: unknown): boolean {
  return coerceStoredRanges(value) !== null;
}

const PARSED_CACHE = new Map<string, ParsedCidr[]>();
const PARSED_CACHE_MAX = 256;

function parseRanges(list: string[]): ParsedCidr[] {
  const key = list.join('\n');
  const hit = PARSED_CACHE.get(key);
  if (hit) return hit;
  const parsed: ParsedCidr[] = [];
  for (const item of list) {
    const check = checkCidr(item);
    if (check.ok) parsed.push(check.cidr);
  }
  if (PARSED_CACHE.size >= PARSED_CACHE_MAX) PARSED_CACHE.clear();
  PARSED_CACHE.set(key, parsed);
  return parsed;
}

/**
 * Whether `clientIp` may use a token with this allowlist.
 *
 * Unrestricted (null / undefined / empty) is always allowed. Otherwise the
 * address must parse and fall inside at least one parseable range; an unknown
 * address or a list with no usable range denies.
 */
export function isIpAllowed(clientIp: string | null | undefined, allowedIpRanges: unknown): boolean {
  const list = coerceStoredRanges(allowedIpRanges);
  if (list === null) return true;
  const ip = parseClientIp(clientIp);
  if (!ip) return false;
  return parseRanges(list).some((range) => ipMatchesRange(ip, range));
}

/** Whether every address of `child` is also in `parent`. */
export function isRangeWithin(child: ParsedCidr, parent: ParsedCidr): boolean {
  if (child.family !== parent.family || child.prefix < parent.prefix) return false;
  return prefixMatches(child.parts, parent.parts, parent.prefix, child.family === 4 ? 8 : 16);
}

export type ChildAllowlist =
  | { ok: true; ranges: string[] | null }
  | { ok: false; offending: string[] };

/**
 * The allowlist a token minted BY another token may carry. Network scope is
 * privilege like any other and never goes upward: a token confined to some
 * ranges must not mint one that works from anywhere. An unrestricted minter
 * passes the request through; a restricted one makes the child inherit its
 * ranges when none are asked for, and may only narrow them otherwise.
 * `requested` is the already-validated list from the request (null = none).
 */
export function resolveChildAllowlist(parentRanges: unknown, requested: string[] | null): ChildAllowlist {
  const parentList = coerceStoredRanges(parentRanges);
  if (parentList === null) return { ok: true, ranges: requested };
  if (requested === null) return { ok: true, ranges: parentList };
  const parents = parseRanges(parentList);
  const offending = requested.filter((item) => {
    const check = checkCidr(item);
    return !check.ok || !parents.some((parent) => isRangeWithin(check.cidr, parent));
  });
  return offending.length > 0 ? { ok: false, offending } : { ok: true, ranges: requested };
}

// ── request input ───────────────────────────────────────────────────────────

export interface IpRangeIssueDetail {
  /** Position in the submitted array. */
  index: number;
  value: string;
  reason: CidrIssue | 'type';
  message: string;
}

export type AllowedIpRangesResult =
  | { ok: true; ranges: string[] | null }
  | { ok: false; message: string; issues: IpRangeIssueDetail[] };

const ISSUE_MESSAGE: Record<CidrIssue | 'type', string> = {
  empty: 'is empty',
  tooLong: `is longer than ${MAX_RANGE_LENGTH} characters`,
  address: 'is not a valid IPv4 or IPv6 address',
  prefix: 'has an invalid prefix length (IPv4: 0-32, IPv6: 0-128)',
  type: 'must be a string',
};

/**
 * Validate and normalize a submitted allowlist. `null`, `undefined` and `[]` all
 * mean "no restriction" (ranges: null). Duplicates after normalization are
 * collapsed silently (pasting the same range twice is not an error); anything
 * else wrong is reported per entry so a form can point at it.
 */
export function validateAllowedIpRanges(input: unknown): AllowedIpRangesResult {
  if (input === null || input === undefined) return { ok: true, ranges: null };
  if (!Array.isArray(input)) {
    return {
      ok: false,
      message: 'allowedIpRanges must be an array of CIDR ranges',
      issues: [{ index: 0, value: String(input), reason: 'type', message: 'allowedIpRanges must be an array of CIDR ranges' }],
    };
  }
  if (input.length > MAX_ALLOWED_IP_RANGES) {
    return {
      ok: false,
      message: `At most ${MAX_ALLOWED_IP_RANGES} IP ranges are allowed per token`,
      issues: [],
    };
  }

  const issues: IpRangeIssueDetail[] = [];
  const seen = new Set<string>();
  const ranges: string[] = [];
  input.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push({ index, value: String(item), reason: 'type', message: `Entry ${index + 1} ${ISSUE_MESSAGE.type}` });
      return;
    }
    const check = checkCidr(item);
    if (!check.ok) {
      issues.push({ index, value: item, reason: check.reason, message: `"${item}" ${ISSUE_MESSAGE[check.reason]}` });
      return;
    }
    if (seen.has(check.normalized)) return;
    seen.add(check.normalized);
    ranges.push(check.normalized);
  });

  if (issues.length > 0) {
    return { ok: false, message: 'allowedIpRanges contains invalid entries', issues };
  }
  return { ok: true, ranges: ranges.length === 0 ? null : ranges };
}

/**
 * Split free text (a textarea, a pasted list) into range candidates: newlines,
 * commas, semicolons and whitespace all separate entries.
 */
export function splitIpRangeText(text: string): string[] {
  return text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
}
