/**
 * The platform's own per-address request limit for the client and public APIs.
 *
 * It runs before authentication, so it covers what no tenant policy can: calls
 * with a bad or missing API token, and the public endpoints. Off unless
 * CLIENT_API_IP_RATE_LIMIT_PER_MINUTE is set; tenants limit addresses with their
 * own `ip` quota policies, which apply after authentication.
 *
 * The address is the one the server resolved through its proxy trust boundary
 * (`getAuthzClientIp`); IPv6 is counted per /64, like the tenant IP limits. A
 * request whose address cannot be resolved is not counted here.
 */
import { getConfig } from '@/lib/core/config';
import { parseClientIp, quotaAddressKey } from '@/lib/quota/ipScope';
import { RATE_ALLOWED, countRequest, type RateDecision } from '@/lib/services/auth/sharedRateCounter';

const LIMITED_PREFIXES = ['/api/client/', '/api/public/'];

/** Whether the platform IP limit covers this path. */
export function isPlatformIpLimitedPath(pathname: string): boolean {
  return LIMITED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Count one request from `clientIp`; refused once the address is over the configured per-minute limit. */
export async function checkPlatformIpLimit(clientIp: string | undefined): Promise<RateDecision> {
  const limit = getConfig().rateLimit.clientApiIpPerMinute;
  if (!(limit > 0) || !clientIp) return RATE_ALLOWED;
  return countRequest(`platform-ip:${quotaAddressKey(parseClientIp(clientIp))}`, limit);
}

/** The 429 body, in the client API's error shape. */
export function platformIpLimitBody() {
  return {
    error: {
      message: 'Too many requests from this address. Retry later.',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  };
}
