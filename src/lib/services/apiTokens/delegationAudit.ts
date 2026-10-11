/**
 * Audit trail for changes of what an API token may act for (its delegation, lib/iam/tokenDelegation.ts).
 *
 * The response-time audit hook already records THAT someone called `PUT /api/tokens/:id/delegation`. It cannot say what
 * changed, and who is allowed to vouch for people is exactly what a security review asks about ("who let this application
 * act for which users, trusting which issuer, and when"). This writes one extra row with the before and after, linked to
 * the request by `requestId`. The snapshots hold the issuer, the audience, the algorithms and which kinds of key were
 * configured - never a shared secret or a key.
 *
 * Fire-and-forget: the change has already succeeded and must not fail on audit.
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { recordAuditLog } from '@/lib/services/audit';

/** The event name; the IAM audit feed lists it among the access-rule changes. */
export const TOKEN_DELEGATION_EVENT = 'token.delegation.updated';

export type TokenDelegationChangeKind = 'created' | 'updated' | 'removed';

export interface TokenDelegationAuditInput {
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
  tokenId: string;
  label: string;
  ownerUserId: string;
  projectId?: string;
  change: TokenDelegationChangeKind;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export function recordTokenDelegationChange(input: TokenDelegationAuditInput): void {
  criticalFireAndForget('token-delegation-audit', () =>
    recordAuditLog(
      { tenantDbName: input.tenantDbName, tenantId: input.tenantId },
      {
        actorType: 'user',
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        requestId: input.requestId,
        service: 'tokens',
        action: 'security',
        event: TOKEN_DELEGATION_EVENT,
        method: input.method,
        path: input.path,
        statusCode: 200,
        outcome: 'success',
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        resourceType: 'api_token',
        resourceId: input.tokenId,
        metadata: {
          label: input.label,
          ownerUserId: input.ownerUserId,
          change: input.change,
          before: input.before,
          after: input.after,
        },
      },
    ),
  );
}
