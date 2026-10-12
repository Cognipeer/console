/**
 * Group memberships that follow a verified assertion (`mapping.groupMap`).
 *
 * The identity provider says which of ITS groups a person is in (the `groups` claim); the administrator maps those to
 * console groups. The console groups involved are groups created FOR THAT ISSUER: they carry the source `delegated`
 * and an external id that names the issuer and the group (`delegated:<issuer>#<name>`), they are created the first
 * time somebody arrives with the claim, and nothing else is ever touched:
 *
 *   - a LOCAL group (or one from LDAP / SSO) is never filled from an assertion and no membership in one is ever removed -
 *     an issuer cannot add anybody to a group an administrator made, whatever its name;
 *   - a membership an administrator added by hand to a group of this issuer cannot exist (the members of a group that
 *     is not local are read-only in the console, 409 `group_directory_managed`);
 *   - a group that grants access (a workspace role or service permissions) is never filled from an assertion: the
 *     issuer must not be able to hand out what a group grants. Such groups are reported as skipped;
 *   - the claim is the truth for the groups of this issuer: leaving the claim removes the membership, and so does
 *     removing the mapping.
 *
 * Every change is written to the audit trail with the issuer as the actor (`delegated:<issuer>`), as the same
 * `group.member.add` / `group.member.remove` rows the screens write.
 *
 * The groups carry no grants of their own; an administrator attaches policies, limits and project access to them
 * like to any other group.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IGroup, IUser } from '@/lib/database';
import { getRequestContext } from '@/lib/core/requestContext';
import { recordPeopleAudit } from '@/lib/services/users/peopleAudit';

const logger = createLogger('iam:delegated-groups');

export const DELEGATED_GROUP_SOURCE = 'delegated' as const;
export const MAX_GROUP_MAP_ENTRIES = 100;
const MAX_IDP_GROUP_LENGTH = 200;
const MAX_CONSOLE_GROUP_NAME_LENGTH = 120;

export interface DelegatedGroupMapEntry {
  /** The group as the identity provider names it in the `groups` claim. */
  idpGroup: string;
  /** The console group it maps to (created for the issuer when the first member arrives). */
  consoleGroupName: string;
}

export interface GroupSyncResult {
  /** Ids of the console groups the person was added to. */
  added: string[];
  /** Ids of the console groups the person was removed from. */
  removed: string[];
  /** Mapped groups that were not filled, by console group name. */
  skipped: Array<{ group: string; reason: 'grants_access' }>;
}

export const EMPTY_GROUP_SYNC: GroupSyncResult = Object.freeze({ added: [], removed: [], skipped: [] }) as GroupSyncResult;

/** The external id prefix of every group created for one issuer. */
export function delegatedGroupPrefix(issuer: string): string {
  return `delegated:${issuer}#`;
}

export function delegatedGroupExternalId(issuer: string, consoleGroupName: string): string {
  return `${delegatedGroupPrefix(issuer)}${consoleGroupName}`;
}

/** A group created for this issuer (the only kind a sync ever changes membership in). */
export function isGroupOfIssuer(group: Pick<IGroup, 'source' | 'externalId'>, issuer: string): boolean {
  return group.source === DELEGATED_GROUP_SOURCE
    && typeof group.externalId === 'string'
    && group.externalId.startsWith(delegatedGroupPrefix(issuer));
}

/** What is wrong with a group map, in plain words (empty = usable). */
export function validateGroupMap(groupMap: unknown): string[] {
  if (!Array.isArray(groupMap)) return ['The group map must be a list'];
  if (groupMap.length > MAX_GROUP_MAP_ENTRIES) return [`The group map can have at most ${MAX_GROUP_MAP_ENTRIES} entries`];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of groupMap) {
    const e = entry as Partial<DelegatedGroupMapEntry> | null;
    if (!e || typeof e !== 'object' || typeof e.idpGroup !== 'string' || e.idpGroup.trim() === '' || e.idpGroup.length > MAX_IDP_GROUP_LENGTH) {
      problems.push(`Every group map entry needs an identity provider group of at most ${MAX_IDP_GROUP_LENGTH} characters`);
      continue;
    }
    if (typeof e.consoleGroupName !== 'string' || e.consoleGroupName.trim() === '' || e.consoleGroupName !== e.consoleGroupName.trim()
      || e.consoleGroupName.length > MAX_CONSOLE_GROUP_NAME_LENGTH) {
      problems.push(`Every group map entry needs a console group name of at most ${MAX_CONSOLE_GROUP_NAME_LENGTH} characters without surrounding spaces`);
    }
    if (seen.has(e.idpGroup)) problems.push(`The identity provider group "${e.idpGroup}" is mapped twice`);
    seen.add(e.idpGroup);
  }
  return problems;
}

const grantsAccess = (group: Pick<IGroup, 'tenantRole' | 'servicePermissions'>): boolean =>
  Boolean(group.tenantRole) || Object.keys(group.servicePermissions ?? {}).length > 0;

/** Groups being created right now, per external id: two people arriving together must not create the group twice. */
const creating = new Map<string, Promise<IGroup>>();

async function groupFor(
  db: DatabaseProvider,
  args: { tenantDbName: string; tenantId: string; issuer: string; name: string },
): Promise<IGroup> {
  const externalId = delegatedGroupExternalId(args.issuer, args.name);
  const existing = await db.findGroupByExternalId(externalId);
  if (existing && isGroupOfIssuer(existing, args.issuer) && String(existing.tenantId) === String(args.tenantId)) return existing;

  const key = `${args.tenantDbName}\u0000${externalId}`;
  const running = creating.get(key);
  if (running) return running;
  const promise = (async () => {
    // Another arrival may have created it while this one was looking (and be done by now): look again, in the turn that
    // creates, so that arrivals of one process never make two.
    const created = await db.findGroupByExternalId(externalId);
    if (created && isGroupOfIssuer(created, args.issuer) && String(created.tenantId) === String(args.tenantId)) return created;
    const group = await db.createGroup({
      tenantId: args.tenantId,
      name: args.name,
      description: `Members follow the group claim of ${args.issuer}`,
      source: DELEGATED_GROUP_SOURCE,
      externalId,
      createdBy: `delegated:${args.issuer}`.slice(0, 600),
    });
    recordPeopleAudit({ tenantDbName: args.tenantDbName, tenantId: args.tenantId }, actorFor(args.issuer), {
      event: 'group.jit.create',
      resourceType: 'group',
      resourceId: String(group._id),
      metadata: { issuer: args.issuer, name: args.name },
    });
    return group;
  })().finally(() => {
    creating.delete(key);
  });
  creating.set(key, promise);
  return promise;
}

function actorFor(issuer: string) {
  const requestId = getRequestContext()?.requestId;
  return { type: 'system' as const, userId: `delegated:${issuer}`.slice(0, 600), ...(requestId ? { requestId } : {}) };
}

export interface SyncDelegatedGroupsArgs {
  db: DatabaseProvider;
  tenantDbName: string;
  tenantId: string;
  user: IUser;
  issuer: string;
  /** The assertion's `groups` claim. */
  claimGroups: readonly string[];
  groupMap: readonly DelegatedGroupMapEntry[] | undefined;
  /** What the previous sync of this person learned (see `key` of the result). */
  hint: { userId: string; groupsKey?: string; groupsSyncedAt?: number } | undefined;
}

/** An unchanged claim is looked at again after this long: an administrator may have deleted a group, a membership may have been lost. */
export const GROUP_RESYNC_MS = 5 * 60_000;

/**
 * Bring the person's memberships in the groups of this issuer in step with the claim. `key` identifies the set of groups the
 * claim asked for; when it equals the previous sync's the work is skipped.
 */
export async function syncDelegatedGroups(args: SyncDelegatedGroupsArgs): Promise<{ result: GroupSyncResult; key?: string; synced: boolean }> {
  const { db, tenantDbName, tenantId, user, issuer, groupMap } = args;
  if (!groupMap || groupMap.length === 0) return { result: EMPTY_GROUP_SYNC, synced: false };

  const claimed = new Set(args.claimGroups);
  const desiredNames = [...new Set(groupMap.filter((entry) => claimed.has(entry.idpGroup)).map((entry) => entry.consoleGroupName))].sort();
  const key = createHash('sha1').update(JSON.stringify(desiredNames)).digest('hex');
  if (
    args.hint
    && String(args.hint.userId) === String(user._id)
    && args.hint.groupsKey === key
    && args.hint.groupsSyncedAt !== undefined
    && Date.now() - args.hint.groupsSyncedAt < GROUP_RESYNC_MS
  ) {
    return { result: EMPTY_GROUP_SYNC, key, synced: false };
  }

  const userId = String(user._id);
  const result: GroupSyncResult = { added: [], removed: [], skipped: [] };
  const actor = actorFor(issuer);
  const memberships = await db.listGroupMembersByUser(userId);
  const memberOf = new Set(memberships.map((m) => String(m.groupId)));
  const desiredGroupIds = new Set<string>();

  for (const name of desiredNames) {
    const group = await groupFor(db, { tenantDbName, tenantId, issuer, name });
    const groupId = String(group._id);
    // A group of this issuer that has been given grants since is no longer the issuer's to fill.
    if (grantsAccess(group)) {
      result.skipped.push({ group: name, reason: 'grants_access' });
      continue;
    }
    desiredGroupIds.add(groupId);
    if (memberOf.has(groupId)) continue;
    await db.addGroupMember({ tenantId, groupId, userId, role: 'member', source: DELEGATED_GROUP_SOURCE, addedBy: actor.userId });
    result.added.push(groupId);
    recordPeopleAudit({ tenantDbName, tenantId }, actor, {
      event: 'group.member.add',
      resourceType: 'group',
      resourceId: groupId,
      metadata: { userId, groupName: group.name, issuer, source: DELEGATED_GROUP_SOURCE },
    });
  }

  // What the issuer put the person in before and the claim no longer names. Only rows of the issuer's own groups.
  for (const membership of memberships) {
    if (membership.source !== DELEGATED_GROUP_SOURCE) continue;
    const groupId = String(membership.groupId);
    if (desiredGroupIds.has(groupId)) continue;
    let group: IGroup | null = null;
    try {
      group = await db.findGroupById(groupId);
    } catch {
      group = null;
    }
    if (!group || !isGroupOfIssuer(group, issuer)) continue;
    if (await db.removeGroupMember(groupId, userId)) {
      result.removed.push(groupId);
      recordPeopleAudit({ tenantDbName, tenantId }, actor, {
        event: 'group.member.remove',
        resourceType: 'group',
        resourceId: groupId,
        metadata: { userId, groupName: group.name, issuer, source: DELEGATED_GROUP_SOURCE },
      });
    }
  }

  if (result.added.length > 0 || result.removed.length > 0 || result.skipped.length > 0) {
    logger.info('Synced the groups of a verified identity', { tenantDbName, issuer, userId, added: result.added.length, removed: result.removed.length, skipped: result.skipped.length });
  }
  return { result, key, synced: true };
}

/** Forget groups being created (tests). */
export function resetDelegatedGroupsForTests(): void {
  creating.clear();
}
