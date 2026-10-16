/**
 * Model of "Add people" to a project: which search results can be picked (and why
 * the others are locked) and the requests a selection stands for. Pure.
 */

import type { PrincipalSummary } from '@/components/iam/principals/client';
import type { ProjectRoleValue } from './membersModel';

export type LockReason = 'member' | 'group' | 'admin' | 'external' | 'disabled';

export interface ExistingAccess {
  /** People who already reach the project directly (rows, legacy list). */
  userIds: ReadonlySet<string>;
  /** Groups already granted the project. */
  groupIds: ReadonlySet<string>;
  /** Owners and admins: implicit access. */
  adminIds: ReadonlySet<string>;
}

/** Why a search result cannot be picked, or null when it can. */
export function lockReason(
  type: 'user' | 'group',
  principal: Pick<PrincipalSummary, 'id' | 'kind' | 'status'>,
  existing: ExistingAccess,
): LockReason | null {
  if (type === 'group') return existing.groupIds.has(principal.id) ? 'group' : null;
  if (existing.adminIds.has(principal.id)) return 'admin';
  if (existing.userIds.has(principal.id)) return 'member';
  if (principal.kind === 'external') return 'external';
  if (principal.status === 'disabled') return 'disabled';
  return null;
}

export interface PickedEntry {
  key: string;
  type: 'user' | 'group';
  id: string;
  label: string;
  sublabel: string | null;
  role: ProjectRoleValue;
}

export const pickKey = (type: 'user' | 'group', id: string) => `${type}:${id}`;

export function togglePick(
  picked: readonly PickedEntry[],
  entry: Omit<PickedEntry, 'key' | 'role'>,
  defaultRole: ProjectRoleValue = 'member',
): PickedEntry[] {
  const key = pickKey(entry.type, entry.id);
  if (picked.some((p) => p.key === key)) return picked.filter((p) => p.key !== key);
  return [...picked, { ...entry, key, role: defaultRole }];
}

export function setPickRole(picked: readonly PickedEntry[], key: string, role: ProjectRoleValue): PickedEntry[] {
  return picked.map((p) => (p.key === key ? { ...p, role } : p));
}

export function setAllRoles(picked: readonly PickedEntry[], role: ProjectRoleValue): PickedEntry[] {
  return picked.map((p) => ({ ...p, role }));
}

export interface AddRequests {
  users: Array<{ userId: string; role: ProjectRoleValue }>;
  groups: Array<{ groupId: string; role: ProjectRoleValue }>;
}

export function buildAddRequests(picked: readonly PickedEntry[]): AddRequests {
  return {
    users: picked.filter((p) => p.type === 'user').map((p) => ({ userId: p.id, role: p.role })),
    groups: picked.filter((p) => p.type === 'group').map((p) => ({ groupId: p.id, role: p.role })),
  };
}

export function countByType(picked: readonly PickedEntry[]): { users: number; groups: number } {
  let users = 0;
  for (const p of picked) if (p.type === 'user') users += 1;
  return { users, groups: picked.length - users };
}
