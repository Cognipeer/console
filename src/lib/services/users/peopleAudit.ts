/**
 * Audit rows of the people endpoints (users, groups, tokens): what changed, who
 * did it, to whom. The request-level audit hook only knows THAT a route was
 * called; these say what it did. Routes that write them are declared with
 * `skipAuditOnSuccess`, so the generic `METHOD /path` row is not written twice.
 *
 * Fire-and-forget like the status-change rows (userLifecycle.ts): the change has
 * already happened and must not fail on its audit. Nothing sensitive is logged:
 * no invitation links, no passwords, only the names of the fields that changed.
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { runWithTenantScope } from '@/lib/database';
import type { PermissionService } from '@/lib/security/rbac';
import { recordAuditLog } from '@/lib/services/audit/auditService';

export type PeopleAuditEvent =
  | 'user.profile.update'
  | 'user.role.change'
  | 'user.permissions.update'
  | 'user.delete'
  | 'user.bulk'
  | 'group.member.add'
  | 'group.member.remove'
  | 'token.revoke';

export interface PeopleAuditActor {
  type: 'user' | 'api_token';
  userId: string;
  email?: string;
  role?: string;
  apiTokenId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** The request that caused the change, as the generic audit row would have recorded it. */
  method?: string;
  path?: string;
}

export interface PeopleAuditEntry {
  event: PeopleAuditEvent;
  resourceType: 'user' | 'group' | 'token';
  resourceId: string;
  outcome?: 'success' | 'failure' | 'denied';
  metadata?: Record<string, unknown>;
}

/** The permission service whose area a resource type belongs to. */
const SERVICE_OF: Record<PeopleAuditEntry['resourceType'], PermissionService> = {
  user: 'members',
  group: 'members',
  token: 'tokens',
};

export function recordPeopleAudit(
  tenant: { tenantDbName: string; tenantId: string },
  actor: PeopleAuditActor,
  entry: PeopleAuditEntry,
): void {
  criticalFireAndForget('people-audit', () => runWithTenantScope(tenant.tenantDbName, () => recordAuditLog(
    { tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId },
    {
      action: 'security',
      actorType: actor.type,
      actorUserId: actor.userId,
      actorEmail: actor.email,
      actorRole: actor.role,
      apiTokenId: actor.apiTokenId,
      event: entry.event,
      ipAddress: actor.ipAddress,
      ...(actor.method ? { method: actor.method } : {}),
      ...(actor.path ? { path: actor.path } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      outcome: entry.outcome ?? 'success',
      requestId: actor.requestId,
      resourceId: entry.resourceId,
      resourceType: entry.resourceType,
      service: SERVICE_OF[entry.resourceType],
      userAgent: actor.userAgent,
    },
  )));
}
