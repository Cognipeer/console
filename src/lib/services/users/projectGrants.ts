/**
 * Giving a person memberships in several projects at once - the shared part of "add to projects", of an invitation and of
 * a service account created with projects.
 *
 *   parseProjectGrants   the `projects: [{projectId, role}]` of a request body, checked
 *   inviteGrantsOf       the grants an invitation / service-account body stands for (new `projects[]` + legacy `projectId`)
 *   loadTenantProjects   the workspace's projects by id, ONE read (a workspace has tens, not thousands)
 *   projectsAdministeredBy / applyProjectGrants
 *
 * Every membership written here is `source: 'manual'` and `invitedBy: <actor>`. The caller decides who may do it and checks
 * that the person is not an owner/admin (implicit access everywhere) or an external account (no memberships, ever).
 */

import type { DatabaseProvider, IProject, IUserProject } from '@/lib/database';
import type { ProjectRole } from '@/lib/database/provider/types.base';
import { normalizeServicePermissions, type UserServicePermissions } from '@/lib/security/rbac';

/** More than this many projects in one request is a script's mistake, not a person's choice. */
export const MAX_PROJECT_GRANTS = 100;

export interface ProjectGrant {
  projectId: string;
  role: ProjectRole;
}

export type ProjectGrantsResult =
  | { ok: true; grants: ProjectGrant[] }
  | { ok: false; error: string };

const PROJECT_ROLES: readonly string[] = ['member', 'project_admin'];

/** Check the `projects` list of a body. A project named twice keeps its last entry. */
export function parseProjectGrants(raw: unknown): ProjectGrantsResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'projects must be a list of { projectId, role }' };
  if (raw.length > MAX_PROJECT_GRANTS) return { ok: false, error: `At most ${MAX_PROJECT_GRANTS} projects at a time` };
  const byProject = new Map<string, ProjectGrant>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'Each project must be an object { projectId, role }' };
    }
    const { projectId, role } = entry as { projectId?: unknown; role?: unknown };
    if (typeof projectId !== 'string' || !projectId.trim()) return { ok: false, error: 'Each project needs a projectId' };
    if (typeof role !== 'string' || !PROJECT_ROLES.includes(role)) {
      return { ok: false, error: 'A project role must be member or project_admin' };
    }
    byProject.set(projectId.trim(), { projectId: projectId.trim(), role: role as ProjectRole });
  }
  return { ok: true, grants: [...byProject.values()] };
}

/**
 * The grants an invitation / service-account body stands for: the `projects` list, plus the legacy single `projectId` (its
 * role is the person's own role: project_admin -> project_admin, user -> member) unless the list already names it.
 * A tenant admin has access everywhere, so an `admin` gets none.
 */
export function inviteGrantsOf(body: { projects?: unknown; projectId?: unknown; role?: unknown }): ProjectGrantsResult {
  if (body.role === 'admin') {
    if (body.projects !== undefined) {
      const parsed = parseProjectGrants(body.projects);
      if (!parsed.ok) return parsed;
    }
    return { ok: true, grants: [] };
  }
  let grants: ProjectGrant[] = [];
  if (body.projects !== undefined && body.projects !== null) {
    const parsed = parseProjectGrants(body.projects);
    if (!parsed.ok) return parsed;
    grants = parsed.grants;
  }
  if (typeof body.projectId === 'string' && body.projectId && (body.role === 'user' || body.role === 'project_admin')
    && !grants.some((grant) => grant.projectId === body.projectId)) {
    grants.push({ projectId: body.projectId, role: body.role === 'project_admin' ? 'project_admin' : 'member' });
  }
  return { ok: true, grants };
}

/** The workspace's projects by id. */
export async function loadTenantProjects(db: Pick<DatabaseProvider, 'listProjects'>, tenantId: string): Promise<Map<string, IProject>> {
  const projects = (await db.listProjects(tenantId)) ?? [];
  return new Map(projects.filter((project) => String(project.tenantId) === String(tenantId)).map((project) => [String(project._id), project]));
}

/** The ids of the grants that name no project of the workspace. */
export function unknownProjectIds(grants: readonly ProjectGrant[], projects: ReadonlyMap<string, IProject>): string[] {
  return grants.filter((grant) => !projects.has(grant.projectId)).map((grant) => grant.projectId);
}

/**
 * Which of these projects the actor administers: everything for an owner/admin, else the projects where the actor is a
 * project admin (a direct row, the legacy list, or a group's grant).
 */
export async function projectsAdministeredBy(
  db: Pick<DatabaseProvider, 'listUserProjectsByUser' | 'listGroupMembersByUser' | 'listGroupProjectsByGroup' | 'findUserById'>,
  actor: { userId: string; role: string },
  projectIds: readonly string[],
): Promise<Set<string>> {
  if (actor.role === 'owner' || actor.role === 'admin') return new Set(projectIds);
  const administered = new Set<string>();
  const wanted = new Set(projectIds);
  // Like the single add under /projects/:id/members: a direct row decides (the legacy list only counts where there is none).
  const direct = new Set<string>();
  for (const row of await db.listUserProjectsByUser(actor.userId)) {
    direct.add(String(row.projectId));
    if (row.role === 'project_admin' && wanted.has(String(row.projectId))) administered.add(String(row.projectId));
  }
  const self = actor.role === 'project_admin' ? await db.findUserById(actor.userId) : null;
  for (const id of self?.projectIds ?? []) {
    if (wanted.has(String(id)) && !direct.has(String(id))) administered.add(String(id));
  }
  const groups = await db.listGroupMembersByUser(actor.userId);
  const grants = await Promise.all(groups.map((group) => db.listGroupProjectsByGroup(String(group.groupId))));
  for (const rows of grants) {
    for (const row of rows) {
      if (row.role === 'project_admin' && wanted.has(String(row.projectId))) administered.add(String(row.projectId));
    }
  }
  return administered;
}

export interface ApplyProjectGrantsInput {
  tenantId: string;
  userId: string;
  grants: readonly ProjectGrant[];
  /** Who grants them (recorded as `invitedBy`). */
  actorId: string;
  /**
   * The service access the person gets in these projects: undefined = leave an existing row as it is and give a new one the
   * project default; null = the project default; an object = exactly this (the caller clamps it to the actor's own level).
   */
  servicePermissions?: UserServicePermissions | null;
}

export interface ApplyProjectGrantsResult {
  added: string[];
  updated: string[];
  skipped: Array<{ projectId: string; reason: 'already_member' }>;
}

const sameService = (a: UserServicePermissions, b: UserServicePermissions): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Write the memberships. A row that already has this role (and this service access) is left alone and reported as skipped. */
export async function applyProjectGrants(
  db: Pick<DatabaseProvider, 'listUserProjectsByUser' | 'upsertUserProject'>,
  input: ApplyProjectGrantsInput,
): Promise<ApplyProjectGrantsResult> {
  const existing = new Map<string, IUserProject>(
    ((await db.listUserProjectsByUser(input.userId)) ?? []).map((row) => [String(row.projectId), row]),
  );
  const result: ApplyProjectGrantsResult = { added: [], updated: [], skipped: [] };
  const requested = input.servicePermissions === undefined ? undefined : normalizeServicePermissions(input.servicePermissions ?? {});

  for (const grant of input.grants) {
    const row = existing.get(grant.projectId);
    if (row) {
      const current = normalizeServicePermissions(row.servicePermissions);
      const sameRole = row.role === grant.role;
      const sameAccess = requested === undefined || sameService(current, requested);
      if (sameRole && sameAccess) {
        result.skipped.push({ projectId: grant.projectId, reason: 'already_member' });
        continue;
      }
      await db.upsertUserProject({
        tenantId: input.tenantId,
        userId: input.userId,
        projectId: grant.projectId,
        role: grant.role,
        servicePermissions: requested ?? current,
        // A directory-made row that a person now sets by hand becomes theirs: it is no longer the directory's to say.
        invitedBy: row.source === 'directory' ? input.actorId : (row.invitedBy ?? input.actorId),
        source: 'manual',
      });
      result.updated.push(grant.projectId);
      continue;
    }
    await db.upsertUserProject({
      tenantId: input.tenantId,
      userId: input.userId,
      projectId: grant.projectId,
      role: grant.role,
      servicePermissions: requested ?? {},
      invitedBy: input.actorId,
      source: 'manual',
    });
    result.added.push(grant.projectId);
  }
  return result;
}
