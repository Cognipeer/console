/**
 * Group loading for the authorization gate.
 *
 * A user's groups are two reads however many groups there are: the membership
 * rows (`listGroupMembersByUser`), then ONE batched fetch of the group documents
 * by id (`iamListGroups`, tenant-scoped). The older shape - one `findGroupById`
 * per membership, a round trip each - is kept as the fallback for a provider that
 * lacks the batched query (a partial test double); it keeps bounded concurrency,
 * the membership order and the skipping of groups that no longer exist.
 *
 * Behaviour contract (relied on by the parity tests):
 *  - a provider without `listGroupMembersByUser` => no groups;
 *  - a non-array membership result => no groups;
 *  - a missing group is skipped;
 *  - the groups come back in membership order;
 *  - a group counts as a GRANT only when it has a tenantRole or a non-empty
 *    servicePermissions map; the membership role is ignored.
 */

import type { DatabaseProvider, IGroup } from '@/lib/database';
import type { GroupTenantGrant } from '@/lib/security/rbac';

/** Point reads in flight at once for one principal (the fallback path). */
export const GROUP_READ_CONCURRENCY = 8;
/** Ids per batched query (the directory query serves at most this many rows a page). */
export const GROUP_BATCH_SIZE = 200;

type GroupDb = Pick<DatabaseProvider, 'listGroupMembersByUser' | 'findGroupById'>
  & Partial<Pick<DatabaseProvider, 'iamListGroups'>>;

/** Ids of the groups a user belongs to, in membership order. */
export async function listUserGroupIds(db: Pick<DatabaseProvider, 'listGroupMembersByUser'>, userId: string): Promise<string[]> {
  const memberships = typeof db.listGroupMembersByUser === 'function'
    ? await db.listGroupMembersByUser(userId)
    : [];
  if (!Array.isArray(memberships) || memberships.length === 0) return [];
  return [...new Set(memberships.map((m) => String(m.groupId)))];
}

async function fetchGroupsOneByOne(db: Pick<DatabaseProvider, 'findGroupById'>, groupIds: string[]): Promise<IGroup[]> {
  const groups: Array<IGroup | null> = [];
  for (let i = 0; i < groupIds.length; i += GROUP_READ_CONCURRENCY) {
    const chunk = groupIds.slice(i, i + GROUP_READ_CONCURRENCY);
    groups.push(...(await Promise.all(chunk.map((id) => db.findGroupById(id)))));
  }
  return groups.filter((g): g is IGroup => !!g);
}

/**
 * The group documents for these ids, in the given order, missing ones skipped.
 * One round trip per GROUP_BATCH_SIZE ids when the provider can batch (and the
 * tenant is known); point reads otherwise.
 */
export async function fetchGroupsByIds(db: GroupDb, tenantId: string | undefined, groupIds: string[]): Promise<IGroup[]> {
  if (groupIds.length === 0) return [];
  if (tenantId && typeof db.iamListGroups === 'function') {
    try {
      const byId = new Map<string, IGroup>();
      for (let i = 0; i < groupIds.length; i += GROUP_BATCH_SIZE) {
        const page = await db.iamListGroups({ tenantId, ids: groupIds.slice(i, i + GROUP_BATCH_SIZE), limit: GROUP_BATCH_SIZE });
        if (!page || !Array.isArray(page.items)) throw new TypeError('unexpected group page');
        for (const group of page.items) byId.set(String(group._id), group);
      }
      return groupIds.map((id) => byId.get(id)).filter((g): g is IGroup => !!g);
    } catch {
      // Not every provider (or test double) serves the directory queries; the point reads below also surface a real outage.
    }
  }
  return fetchGroupsOneByOne(db, groupIds);
}

/** The groups of a user. `tenantId` enables the batched fetch. */
export async function loadUserGroups(db: GroupDb, userId: string, tenantId?: string): Promise<IGroup[]> {
  return fetchGroupsByIds(db, tenantId, await listUserGroupIds(db, userId));
}

export function groupToGrant(group: IGroup): GroupTenantGrant | null {
  const hasServiceGrant = group.servicePermissions && Object.keys(group.servicePermissions).length > 0;
  if (group.tenantRole || hasServiceGrant) {
    return { tenantRole: group.tenantRole, servicePermissions: group.servicePermissions };
  }
  return null;
}

export function grantsOf(groups: ReadonlyArray<IGroup>): GroupTenantGrant[] {
  const grants: GroupTenantGrant[] = [];
  for (const group of groups) {
    const grant = groupToGrant(group);
    if (grant) grants.push(grant);
  }
  return grants;
}

export async function loadGroupGrants(db: GroupDb, userId: string, tenantId?: string): Promise<GroupTenantGrant[]> {
  return grantsOf(await loadUserGroups(db, userId, tenantId));
}
