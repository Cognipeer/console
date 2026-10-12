/**
 * Audit trail for edits of a token's restrictions (expiry, IP allowlist).
 *
 * The response-time audit hook already records THAT someone called
 * `PUT /api/tokens/:id`. It cannot say what changed, and for these two fields
 * the before and after are exactly what a security review asks for ("who opened
 * this token to which network, and when"). This writes one extra row with both
 * values, linked to the request by `requestId`.
 *
 * Fire-and-forget: the edit has already succeeded and must not fail on audit.
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { recordAuditLog } from '@/lib/services/audit';

export interface TokenRestrictionSnapshot {
  expiresAt: string | null;
  allowedIpRanges: string[] | null;
}

export interface TokenRestrictionChange {
  tokenId: string;
  label: string;
  ownerUserId: string;
  projectId: string;
  before: TokenRestrictionSnapshot;
  after: TokenRestrictionSnapshot;
}

export interface TokenRestrictionAuditInput {
  tenantId: string;
  tenantDbName: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  method: string;
  /** Path only; never the query string. */
  path: string;
  change: TokenRestrictionChange;
}

/** The audit row keeps the first ranges and the total, so a 100-entry list cannot bloat it. */
const MAX_LOGGED_RANGES = 25;

function snapshot(value: TokenRestrictionSnapshot) {
  const ranges = value.allowedIpRanges;
  return {
    expiresAt: value.expiresAt,
    allowedIpRanges: ranges ? ranges.slice(0, MAX_LOGGED_RANGES) : null,
    allowedIpRangeCount: ranges ? ranges.length : 0,
  };
}

/** Whether the change touches a restriction at all (a rename alone writes nothing). */
export function restrictionsChanged(change: TokenRestrictionChange): boolean {
  const { before, after } = change;
  if (before.expiresAt !== after.expiresAt) return true;
  const a = before.allowedIpRanges ?? [];
  const b = after.allowedIpRanges ?? [];
  return a.length !== b.length || a.some((range, index) => range !== b[index]);
}

export function recordTokenRestrictionChange(input: TokenRestrictionAuditInput): void {
  if (!restrictionsChanged(input.change)) return;
  const { change } = input;
  criticalFireAndForget('token-restrictions-audit', () =>
    recordAuditLog(
      { tenantDbName: input.tenantDbName, tenantId: input.tenantId },
      {
        actorType: 'user',
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
        projectId: change.projectId,
        requestId: input.requestId,
        service: 'tokens',
        action: 'security',
        event: 'token.restrictions.updated',
        method: input.method,
        path: input.path,
        statusCode: 200,
        outcome: 'success',
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        resourceType: 'api_token',
        resourceId: change.tokenId,
        metadata: {
          label: change.label,
          ownerUserId: change.ownerUserId,
          before: snapshot(change.before),
          after: snapshot(change.after),
        },
      },
    ),
  );
}
