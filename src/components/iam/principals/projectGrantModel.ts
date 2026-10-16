/**
 * Model of "add a person to projects": where a person's project memberships come
 * from, which projects can still be offered, and the request a selection stands for.
 *
 * Pure (no React): covered by unit tests, shared by the person's Projects section,
 * the multi-project form and the add-person form.
 */

import type { UserServicePermissions } from '@/lib/security/rbac';
import type { ProjectRef } from './client';
import type { ProjectChoice, ProjectGrantInput } from './directoryApi';

export type ProjectRoleChoice = 'member' | 'project_admin';

export const PROJECT_ROLE_CHOICES: readonly ProjectRoleChoice[] = ['member', 'project_admin'];

// ── where a membership comes from ─────────────────────────────────────────

export type MembershipSourceKind = 'direct' | 'directory' | 'group' | 'legacy' | 'implicit';

export interface MembershipSource {
  kind: MembershipSourceKind;
  /** `group`: the group that grants the access, and its id (a link to the group's page). */
  groupName?: string;
  groupId?: string;
}

/**
 * How a person got into a project: by hand (direct), through the directory's default
 * project (SSO / LDAP), through a group, an entry of the legacy list, or implicitly
 * (owners and admins reach every project).
 */
export function membershipSource(project: Pick<ProjectRef, 'via' | 'source' | 'groupName' | 'groupId'>): MembershipSource {
  switch (project.via) {
    case 'group':
      return {
        kind: 'group',
        ...(project.groupName ? { groupName: project.groupName } : {}),
        ...(project.groupId ? { groupId: project.groupId } : {}),
      };
    case 'implicit':
      return { kind: 'implicit' };
    case 'legacy':
      return { kind: 'legacy' };
    default:
      return { kind: project.source === 'directory' ? 'directory' : 'direct' };
  }
}

/**
 * The role of a row is managed from its source: a group row's role is the group's
 * (change it on the group), an implicit row has none to change. Direct, directory
 * and legacy rows carry a role the person's page can change.
 */
export function roleEditable(source: MembershipSource): boolean {
  return source.kind === 'direct' || source.kind === 'directory' || source.kind === 'legacy';
}

// ── what can be offered ───────────────────────────────────────────────────

export type OfferState =
  /** Free to pick. */
  | 'free'
  /** Reached through a group or a directory default: picking adds a direct membership of its own. */
  | 'inherited'
  /** Already a member by hand: change the role from the person's Projects section. */
  | 'locked';

export interface ProjectOffer {
  id: string;
  name: string;
  state: OfferState;
  /** `inherited` / `locked`: where the access comes from. */
  source?: MembershipSource;
  /** `inherited` / `locked`: the role they hold now. */
  currentRole?: string | null;
}

const byName = (a: ProjectOffer, b: ProjectOffer) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * Every project of the workspace as an offer: free ones, then those the person
 * reaches through a group or a directory default (still pickable), then the locked
 * ones (a membership of their own already exists), each by name.
 */
export function buildOffers(projects: readonly ProjectChoice[], memberships: readonly ProjectRef[]): ProjectOffer[] {
  const held = new Map(memberships.map((m) => [m.id, m]));
  const offers = projects.map((project): ProjectOffer => {
    const membership = held.get(project.id);
    if (!membership) return { id: project.id, name: project.name, state: 'free' };
    const source = membershipSource(membership);
    const direct = source.kind === 'direct' || source.kind === 'legacy';
    return {
      id: project.id,
      name: project.name,
      state: direct ? 'locked' : 'inherited',
      source,
      currentRole: membership.role,
    };
  });
  const rank: Record<OfferState, number> = { free: 0, inherited: 1, locked: 2 };
  return offers.sort((a, b) => rank[a.state] - rank[b.state] || byName(a, b));
}

export const isPickable = (offer: ProjectOffer): boolean => offer.state !== 'locked';

// ── the selection ─────────────────────────────────────────────────────────

/** Picked projects with the role in each, in the order they were picked. */
export type ProjectSelection = ReadonlyArray<{ projectId: string; role: ProjectRoleChoice }>;

export function toggleProject(selection: ProjectSelection, projectId: string, role: ProjectRoleChoice = 'member'): ProjectSelection {
  return selection.some((s) => s.projectId === projectId)
    ? selection.filter((s) => s.projectId !== projectId)
    : [...selection, { projectId, role }];
}

export function setProjectRole(selection: ProjectSelection, projectId: string, role: ProjectRoleChoice): ProjectSelection {
  return selection.map((s) => (s.projectId === projectId ? { ...s, role } : s));
}

/** The same role in every picked project. */
export function setAllRoles(selection: ProjectSelection, role: ProjectRoleChoice): ProjectSelection {
  return selection.map((s) => ({ ...s, role }));
}

/** Drops picks that are no longer on offer (a project that vanished, or one that got locked). */
export function pruneSelection(selection: ProjectSelection, offers: readonly ProjectOffer[]): ProjectSelection {
  const pickable = new Set(offers.filter(isPickable).map((o) => o.id));
  return selection.filter((s) => pickable.has(s.projectId));
}

export const toGrants = (selection: ProjectSelection): ProjectGrantInput[] =>
  selection.map(({ projectId, role }) => ({ projectId, role }));

export interface AddProjectsRequest {
  projects: ProjectGrantInput[];
  /** null = each project's default; an object = exactly this set in every picked project. */
  servicePermissions: UserServicePermissions | null;
  notify?: boolean;
}

/** The body of `POST /api/users/:id/projects` for a selection. */
export function buildAddRequest(input: {
  selection: ProjectSelection;
  /** The one custom set applied to all picked projects, or null for the project default. */
  custom: UserServicePermissions | null;
  notify: boolean;
}): AddProjectsRequest {
  return {
    projects: toGrants(input.selection),
    servicePermissions: input.custom,
    ...(input.notify ? { notify: true } : {}),
  };
}

// ── the answer ────────────────────────────────────────────────────────────

export interface AddProjectsOutcome {
  added: number;
  updated: number;
  /** Skipped projects with the reason, by project name. */
  skipped: Array<{ projectId: string; name: string; reason: string }>;
}

export function summarizeAddResult(
  result: { added: readonly string[]; updated: readonly string[]; skipped: ReadonlyArray<{ projectId: string; reason: string }> },
  nameOf: (projectId: string) => string,
): AddProjectsOutcome {
  return {
    added: result.added.length,
    updated: result.updated.length,
    skipped: result.skipped.map((s) => ({ projectId: s.projectId, name: nameOf(s.projectId), reason: s.reason })),
  };
}

/** Reasons the server gives for leaving a project out; anything else is worded generically. */
export const SKIP_REASONS = ['already_member', 'project_not_found'] as const;
export const skipReasonKey = (reason: string): string => ((SKIP_REASONS as readonly string[]).includes(reason) ? reason : 'unknown');
