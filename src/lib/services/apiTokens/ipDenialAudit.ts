/**
 * Audit trail for API-token calls refused by the IP allowlist.
 *
 * A refusal happens inside token authentication, before the request has a
 * tenant context, so the regular response-time audit hook (which needs one)
 * writes nothing for it. This records the refusal itself: who (token + owner),
 * from where, to which route.
 *
 * Throttled: a leaked token hammering the API from a blocked address must not
 * turn into one audit row per request. One row per token + address per minute;
 * the response itself is always refused regardless.
 *
 * Fire-and-forget by design: authentication must not wait for, or fail on, the
 * audit write.
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { recordAuditLog } from '@/lib/services/audit';
import { TOKEN_IP_NOT_ALLOWED } from './ipAllowlist';

export interface TokenIpDenialInput {
  tenantId: string;
  tenantDbName: string;
  tokenId?: string;
  userId?: string;
  projectId?: string;
  /** The address the call came from, as the server resolved it. */
  clientIp?: string;
  requestId?: string;
  method: string;
  /** Path only; never the query string. */
  path: string;
  userAgent?: string;
}

const THROTTLE_MS = 60_000;
const MAX_TRACKED = 5_000;
const lastRecorded = new Map<string, number>();

/** True when this token + address has not been recorded within the throttle window. */
export function shouldRecordTokenIpDenial(
  input: Pick<TokenIpDenialInput, 'tenantId' | 'tokenId' | 'clientIp'>,
  now: number = Date.now(),
): boolean {
  const key = `${input.tenantId}\n${input.tokenId ?? ''}\n${input.clientIp ?? ''}`;
  const last = lastRecorded.get(key);
  if (last !== undefined && now - last < THROTTLE_MS) return false;
  if (lastRecorded.size >= MAX_TRACKED) {
    for (const [existing, at] of lastRecorded) {
      if (now - at >= THROTTLE_MS) lastRecorded.delete(existing);
    }
    // Still full of live entries (a flood from many addresses): drop the oldest half.
    if (lastRecorded.size >= MAX_TRACKED) {
      let dropped = 0;
      for (const existing of lastRecorded.keys()) {
        lastRecorded.delete(existing);
        if (++dropped >= MAX_TRACKED / 2) break;
      }
    }
  }
  lastRecorded.set(key, now);
  return true;
}

export function resetTokenIpDenialThrottleForTests(): void {
  lastRecorded.clear();
}

/** Record the refusal (throttled, never throws, never awaited). */
export function recordTokenIpDenial(input: TokenIpDenialInput): void {
  if (!shouldRecordTokenIpDenial(input)) return;
  criticalFireAndForget('token-ip-denied-audit', () =>
    recordAuditLog(
      { tenantDbName: input.tenantDbName, tenantId: input.tenantId },
      {
        actorType: 'api_token',
        actorUserId: input.userId,
        apiTokenId: input.tokenId,
        projectId: input.projectId,
        requestId: input.requestId,
        service: 'tokens',
        action: 'security',
        event: `${input.method} ${input.path}`,
        method: input.method,
        path: input.path,
        statusCode: 403,
        outcome: 'denied',
        ipAddress: input.clientIp,
        userAgent: input.userAgent,
        // `iamEnforce` is what the Authorization center's denials feed selects on: an allowlist
        // refusal is an access denial an administrator looks for there.
        metadata: { code: TOKEN_IP_NOT_ALLOWED, iamEnforce: true },
      },
    ),
  );
}
