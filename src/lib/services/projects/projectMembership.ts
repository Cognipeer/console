/**
 * Batch membership operations for a project: the optional people / groups /
 * providers of "create project", and the bulk members endpoint.
 *
 * Every id in a request body is re-validated against the caller's tenant here
 * (the database handle is already bound to that tenant, but a row of another
 * tenant must still never be touched). Problems with one entry never fail the
 * batch: the entry is skipped and a human-readable warning is returned.
 *
 * `removeProjectMember` removes one user from a project for the dashboard and
 * the client API: a direct membership lives in the UserProject row and the
 * legacy `projectIds` list, and removal clears both in one call. Access
 * inherited through a group is managed on the group and is not touched here.
 */
import type { DatabaseProvider, IUser, ProjectRole } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { revokeUserApiTokensInProject } from '@/lib/services/users/userLifecycle';
import { getLegacyProjectIds, isProgrammaticUser } from './projectAccess';
import { providerProjectIds } from './projectStats';

const logger = createLogger('service:projects:membership');

/** Entries accepted per list in one request. */
export const MAX_BATCH_ENTRIES = 500;

export function parseProjectRole(value: unknown): ProjectRole | null {
  return value === 'project_admin' || value === 'member' ? value : null;
}

interface RoleEntry {
  id: string;
  role: ProjectRole;
}

/** Reads `[{ <idKey>, role }]` from an untrusted body value; bad entries become warnings. */
export function parseRoleEntries(
  value: unknown,
  idKey: string,
  label: string,
  warnings: string[],
): RoleEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${label}: expected a list, ignored.`);
    return [];
  }
  if (value.length > MAX_BATCH_ENTRIES) {
    warnings.push(`${label}: only the first ${MAX_BATCH_ENTRIES} entries are processed.`);
  }
  const seen = new Set<string>();
  const out: RoleEntry[] = [];
  for (const raw of value.slice(0, MAX_BATCH_ENTRIES)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const id = typeof entry[idKey] === 'string' ? (entry[idKey] as string).trim() : '';
    const role = parseProjectRole(entry.role);
    if (!id) {
      warnings.push(`${label}: an entry without ${idKey} was skipped.`);
      continue;
    }
    if (!role) {
      warnings.push(`${label}: "${id}" was skipped (role must be "member" or "project_admin").`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, role });
  }
  return out;
}

export function parseIdList(value: unknown, label: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${label}: expected a list, ignored.`);
    return [];
  }
  if (value.length > MAX_BATCH_ENTRIES) {
    warnings.push(`${label}: only the first ${MAX_BATCH_ENTRIES} entries are processed.`);
  }
  return [...new Set(
    value
      .slice(0, MAX_BATCH_ENTRIES)
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim()),
  )];
}

function displayName(user: Pick<IUser, 'name' | 'email'> | undefined, fallback: string): string {
  return user?.email || user?.name || fallback;
}

/** Why a user can not hold a direct project membership, or null when they can. */
function memberBlocker(user: IUser | undefined, tenantId: string): string | null {
  if (!user || String(user.tenantId) !== String(tenantId)) return 'user not found';
  if (user.role === 'owner' || user.role === 'admin') {
    return 'owners and admins already have access to every project';
  }
  if (user.kind === 'external') return 'external users cannot be project members';
  return null;
}

async function loadUserIndex(db: DatabaseProvider): Promise<Map<string, IUser>> {
  const users = await db.listUsers({ includeExternal: true });
  return new Map(users.map((u) => [String(u._id), u]));
}

export interface ProjectExtrasInput {
  tenantId: string;
  actorUserId: string;
  projectId: string;
  members: Array<{ id: string; role: ProjectRole }>;
  groups: Array<{ id: string; role: ProjectRole }>;
  providerIds: string[];
}

/** Applies the people / groups / providers chosen on the create screen. Returns the warnings. */
export async function applyProjectExtras(
  db: DatabaseProvider,
  input: ProjectExtrasInput,
): Promise<string[]> {
  const { tenantId, actorUserId, projectId } = input;
  const warnings: string[] = [];

  if (input.members.length > 0) {
    const users = await loadUserIndex(db);
    for (const member of input.members) {
      const user = users.get(member.id);
      const blocker = memberBlocker(user, tenantId);
      if (blocker) {
        warnings.push(`${displayName(user, member.id)} was skipped: ${blocker}.`);
        continue;
      }
      try {
        await db.upsertUserProject({
          tenantId,
          userId: member.id,
          projectId,
          role: member.role,
          servicePermissions: undefined,
          invitedBy: actorUserId,
          source: 'manual',
        });
      } catch {
        warnings.push(`${displayName(user, member.id)} could not be added.`);
      }
    }
  }

  if (input.groups.length > 0) {
    const groups = new Map((await db.listGroups(tenantId)).map((g) => [String(g._id), g]));
    for (const entry of input.groups) {
      const group = groups.get(entry.id);
      if (!group || String(group.tenantId) !== String(tenantId)) {
        warnings.push(`Group "${entry.id}" was skipped: group not found.`);
        continue;
      }
      try {
        await db.upsertGroupProject({
          tenantId,
          groupId: entry.id,
          projectId,
          role: entry.role,
          servicePermissions: undefined,
        });
      } catch {
        warnings.push(`Group "${group.name}" could not be added.`);
      }
    }
  }

  if (input.providerIds.length > 0) {
    const providers = new Map((await db.listProviders(tenantId)).map((p) => [String(p._id), p]));
    for (const providerId of input.providerIds) {
      const provider = providers.get(providerId);
      if (!provider || String(provider.tenantId) !== String(tenantId)) {
        warnings.push(`Provider "${providerId}" was skipped: provider not found.`);
        continue;
      }
      // A provider created for one specific project (legacy single `projectId`) is not shareable.
      if (provider.projectId) {
        warnings.push(`Provider "${provider.label}" was skipped: it belongs to another project.`);
        continue;
      }
      const assigned = providerProjectIds(provider);
      if (assigned.includes(projectId)) continue;
      try {
        await db.updateProvider(providerId, {
          projectIds: [...assigned, projectId],
          updatedBy: actorUserId,
        });
      } catch {
        warnings.push(`Provider "${provider.label}" could not be assigned.`);
      }
    }
  }

  return warnings;
}

export interface BulkMembersInput {
  tenantId: string;
  tenantDbName: string;
  actorUserId: string;
  projectId: string;
  add: RoleEntry[];
  remove: string[];
  setRole: RoleEntry[];
}

export interface BulkMembersResult {
  added: number;
  removed: number;
  updated: number;
  addedIds: string[];
  removedIds: string[];
  updatedIds: string[];
  warnings: string[];
}

/** Add / remove / change-role in one call. Each entry is independent; failures become warnings. */
export async function applyBulkMembers(
  db: DatabaseProvider,
  input: BulkMembersInput,
): Promise<BulkMembersResult> {
  const { tenantId, actorUserId, projectId } = input;
  const warnings: string[] = [];
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const updatedIds: string[] = [];

  const users = await loadUserIndex(db);
  const existingRows = new Map(
    (await db.listUserProjectsByProject(projectId)).map((row) => [String(row.userId), row]),
  );

  for (const entry of input.add) {
    const user = users.get(entry.id);
    const blocker = memberBlocker(user, tenantId);
    if (blocker) {
      warnings.push(`${displayName(user, entry.id)} was not added: ${blocker}.`);
      continue;
    }
    if (existingRows.has(entry.id)) {
      warnings.push(`${displayName(user, entry.id)} is already a member; use a role change instead.`);
      continue;
    }
    try {
      await db.upsertUserProject({
        tenantId,
        userId: entry.id,
        projectId,
        role: entry.role,
        servicePermissions: undefined,
        invitedBy: actorUserId,
        source: 'manual',
      });
      addedIds.push(entry.id);
    } catch {
      warnings.push(`${displayName(user, entry.id)} could not be added.`);
    }
  }

  for (const entry of input.setRole) {
    const user = users.get(entry.id);
    if (!user || String(user.tenantId) !== String(tenantId)) {
      warnings.push(`"${entry.id}" was not updated: user not found.`);
      continue;
    }
    if (user.role === 'owner' || user.role === 'admin') {
      warnings.push(`${displayName(user, entry.id)} was not updated: owners and admins have implicit access.`);
      continue;
    }
    const existing = existingRows.get(entry.id);
    const legacy = (user.projectIds ?? []).map(String).includes(projectId);
    if (!existing && !legacy) {
      warnings.push(`${displayName(user, entry.id)} was not updated: not a direct member of this project.`);
      continue;
    }
    // Hand-editing a directory-applied row makes it a manual one.
    try {
      await db.upsertUserProject({
        tenantId,
        userId: entry.id,
        projectId,
        role: entry.role,
        servicePermissions: existing?.servicePermissions,
        invitedBy: existing?.invitedBy ?? actorUserId,
        source: 'manual',
      });
      updatedIds.push(entry.id);
    } catch {
      warnings.push(`${displayName(user, entry.id)} could not be updated.`);
    }
  }

  for (const userId of input.remove) {
    const user = users.get(userId);
    if (!user || String(user.tenantId) !== String(tenantId)) {
      warnings.push(`"${userId}" was not removed: user not found.`);
      continue;
    }
    if (user.role === 'owner' || user.role === 'admin') {
      warnings.push(`${displayName(user, userId)} was not removed: owners and admins have implicit access.`);
      continue;
    }
    try {
      const outcome = await removeProjectMember({
        db,
        projectId,
        target: user,
        tenantDbName: input.tenantDbName,
      });
      if (outcome === 'removed') {
        removedIds.push(userId);
        continue;
      }
      if (outcome === 'failed') {
        warnings.push(`${displayName(user, userId)} could not be removed.`);
        continue;
      }
    } catch {
      warnings.push(`${displayName(user, userId)} could not be removed.`);
      continue;
    }
    warnings.push(`${displayName(user, userId)} was not removed: not a direct member (access may come from a group).`);
  }

  return {
    added: addedIds.length,
    removed: removedIds.length,
    updated: updatedIds.length,
    addedIds,
    removedIds,
    updatedIds,
    warnings,
  };
}

export type RemoveProjectMemberResult = 'removed' | 'not_found' | 'failed';

export async function removeProjectMember(params: {
  db: DatabaseProvider;
  tenantDbName: string;
  target: Pick<IUser, '_id' | 'canLogin' | 'projectIds'>;
  projectId: string;
}): Promise<RemoveProjectMemberResult> {
  const { db, tenantDbName, target } = params;
  const projectId = String(params.projectId);
  const userId = String(target._id);

  const removedRow = await db.deleteUserProject(userId, projectId);

  const legacyIds = getLegacyProjectIds(target.projectIds);
  const remainingIds = legacyIds.filter((id) => id !== projectId);
  const hadLegacyEntry = remainingIds.length !== legacyIds.length;
  if (hadLegacyEntry) {
    const updated = await db.updateUser(userId, { projectIds: remainingIds });
    if (!updated) return 'failed';
  }

  if (!removedRow && !hadLegacyEntry) return 'not_found';

  // A programmatic account has no session and no membership-based path back in:
  // the tokens minted for it in this project are its access, so they go with
  // the membership. Login-capable users keep theirs; those tokens are checked
  // against the user's project access on every request instead.
  if (isProgrammaticUser(target)) {
    try {
      const { revoked, failed } = await revokeUserApiTokensInProject(tenantDbName, userId, projectId);
      if (revoked > 0 || failed > 0) {
        logger.info('Revoked API tokens of a programmatic user removed from a project', {
          failed,
          projectId,
          revoked,
          userId,
        });
      }
    } catch (error) {
      logger.error('Failed to revoke API tokens of a programmatic user removed from a project', {
        error,
        projectId,
        userId,
      });
    }
  }

  return 'removed';
}
