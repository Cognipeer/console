/**
 * Whether the server has been told which proxies to trust (`TRUSTED_PROXIES`).
 *
 * Unset (the default) the server runs Fastify with `trustProxy: true`, i.e. it
 * believes the forwarded-for header of EVERY caller - including one that reaches the
 * process directly. Address-based rules (a token's IP allowlist, a policy's `ip`
 * condition) therefore use the connection's own peer in that state
 * (server/api/fastify-utils.ts getAuthzClientIp) and say so wherever someone writes
 * such a rule.
 */

import { getConfig } from '@/lib/core/config';

/** True when no trusted proxy is configured. An unreadable configuration reads as "none". */
export function trustsEveryHop(): boolean {
  try {
    return getConfig().network.trustedProxies.length === 0;
  } catch {
    return true;
  }
}
