/**
 * Address matching and counter keys for `ip`-scoped quota policies.
 *
 * Pure (no I/O): the policy API and the editor validate with the same code the
 * guard matches with. Range parsing is the token allowlist's (`checkCidr`), so a
 * range means the same thing in both places.
 *
 * The address handed in must be the one the server resolved through its proxy
 * trust boundary (`getAuthzClientIp`), never a raw forwarded-for header. With
 * TRUSTED_PROXIES unset that is the direct peer, so behind a proxy every caller
 * shares the proxy's address (the editor warns about it).
 */
import {
  checkCidr,
  parseClientIp,
  ipMatchesRange,
  validateAllowedIpRanges,
  type ParsedCidr,
  type ParsedIp,
  type IpRangeIssueDetail,
} from '@/lib/services/apiTokens/ipAllowlist';
import { MAX_QUOTA_IP_RANGES } from './types';

export { parseClientIp };
export type { ParsedIp };

/** The shared counter of every caller whose address could not be read. */
export const INVALID_ADDRESS_KEY = 'invalid';

/** How many leading IPv6 groups identify one client: a /64 is one site's (or one host's) block. */
const IPV6_CLIENT_GROUPS = 4;

/**
 * The counter key of one client address for a `perAddress` IP limit: an IPv4
 * address as is, an IPv6 address by its /64 (a host can pick any address in its
 * own /64, so counting single addresses would not limit it).
 */
export function quotaAddressKey(ip: ParsedIp | null): string {
  if (!ip) return INVALID_ADDRESS_KEY;
  if (ip.family === 4) return ip.parts.join('.');
  return `${ip.parts.slice(0, IPV6_CLIENT_GROUPS).map((group) => group.toString(16)).join(':')}::/64`;
}

const PARSED = new Map<string, ParsedCidr[]>();
const PARSED_MAX = 512;

function parsedRanges(ranges: readonly string[]): ParsedCidr[] {
  const key = ranges.join('\n');
  const hit = PARSED.get(key);
  if (hit) return hit;
  const out: ParsedCidr[] = [];
  for (const range of ranges) {
    const check = checkCidr(range);
    if (check.ok) out.push(check.cidr);
  }
  if (PARSED.size >= PARSED_MAX) PARSED.clear();
  PARSED.set(key, out);
  return out;
}

/**
 * Whether a client address falls in a policy's ranges. An address that could
 * not be read matches only a policy that covers every address (`0.0.0.0/0` or
 * `::/0`): such a caller is still limited by "everyone" policies, through the
 * shared `invalid` counter, and by nothing narrower.
 */
export function addressMatchesRanges(ip: ParsedIp | null, ranges: readonly string[] | undefined): boolean {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  const parsed = parsedRanges(ranges);
  if (!ip) return parsed.some((range) => range.prefix === 0);
  return parsed.some((range) => ipMatchesRange(ip, range));
}

export type QuotaIpRangesResult =
  | { ok: true; ranges: string[] }
  | { ok: false; message: string; issues: IpRangeIssueDetail[] };

/** Validate and normalize the ranges of an `ip` policy: at least one, at most MAX_QUOTA_IP_RANGES. */
export function validateQuotaIpRanges(input: unknown): QuotaIpRangesResult {
  if (Array.isArray(input) && input.length > MAX_QUOTA_IP_RANGES) {
    return { ok: false, message: `At most ${MAX_QUOTA_IP_RANGES} IP ranges are allowed per limit`, issues: [] };
  }
  const result = validateAllowedIpRanges(input);
  if (!result.ok) return { ok: false, message: result.message.replace('allowedIpRanges', 'ipRanges'), issues: result.issues };
  if (!result.ranges || result.ranges.length === 0) {
    return { ok: false, message: 'An IP limit needs at least one range in ipRanges', issues: [] };
  }
  return { ok: true, ranges: result.ranges };
}
