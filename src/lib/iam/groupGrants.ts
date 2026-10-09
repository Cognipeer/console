/**
 * Group loading for the authorization gate.
 *
 * The legacy gate resolved a user's groups with one `findGroupById` per
 * membership, awaited sequentially. This keeps exactly those point reads (so the
 * cost scales with the user's memberships, never with the number of groups in
 * the tenant) but issues them with a small bounded concurrency, preserving
 * membership order and skipping groups that no longer exist.
 *
 * Behaviour contract (identical to the old loop, relied on by the parity tests):
 *  - a provider without `listGroupMembersByUser` (partial test double) => no groups;
 *  - a non-array membership result => no groups;
 *  - a missing group is skipped;
 *  - a group counts as a GRANT only when it has a tenantRole or a non-empty
 *    servicePermissions map; the membership role is ignored.
 */

import type { DatabaseProvider, IGroup } from '@/lib/database';
import type { GroupTenantGrant } from '@/lib/security/rbac';

/** Point reads in flight at once for one principal. */
export const GROUP_READ_CONCURRENCY = 8;

type GroupDb = Pick<DatabaseProvider, 'listGroupMembersByUser' | 'findGroupById'>;

export async function loadUserGroups(db: GroupDb, userId: string): Promise<IGroup[]> {
  const memberships = typeof db.listGroupMembersByUser === 'function'
    ? await db.listGroupMembersByUser(userId)
    : [];
  if (!Array.isArray(memberships) || memberships.length === 0) return [];

  const groupIds = [...new Set(memberships.map((m) => String(m.groupId)))];
  const groups: Array<IGroup | null> = [];
  for (let i = 0; i < groupIds.length; i += GROUP_READ_CONCURRENCY) {
    const chunk = groupIds.slice(i, i + GROUP_READ_CONCURRENCY);
    groups.push(...(await Promise.all(chunk.map((id) => db.findGroupById(id)))));
  }
  return groups.filter((g): g is IGroup => !!g);
}

export function groupToGrant(group: IGroup): GroupTenantGrant | null {
  const hasServiceGrant = group.servicePermissions && Object.keys(group.servicePermissions).length > 0;
  if (group.tenantRole || hasServiceGrant) {
    return { tenantRole: group.tenantRole, servicePermissions: group.servicePermissions };
  }
  return null;
}

export async function loadGroupGrants(db: GroupDb, userId: string): Promise<GroupTenantGrant[]> {
  const groups = await loadUserGroups(db, userId);
  const grants: GroupTenantGrant[] = [];
  for (const group of groups) {
    const grant = groupToGrant(group);
    if (grant) grants.push(grant);
  }
  return grants;
}
