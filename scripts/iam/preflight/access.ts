/**
 * Project ACCESS (which project a person can open), before and after the
 * upgrade - not the service levels inside a project.
 *
 * The previous release let a member open the projects listed in their legacy
 * `projectIds` and in their own project assignments. Assignments made to a GROUP
 * were shown in the project switcher but not honoured when the project was
 * opened: a member who reached a project only through a group got
 * "403 No project assigned". The upgrade honours them.
 *
 * This file is a small, pure copy of the selection in
 * src/lib/services/projects/projectContext.ts (`resolveProjectContext`) for a
 * member who is not an owner or admin, once with and once without the group
 * assignments. It exists so the report can say who gains a project, without
 * touching the database for its own writes (resolveProjectContext creates the
 * default project when it is missing).
 */

export interface MemberProjectRows {
  /** `projectIds` on the user row (assignments made before project memberships had their own table). */
  legacyProjectIds: readonly string[];
  /** The person's own assignments, in the order the database returns them. */
  directProjectIds: readonly string[];
  /** The assignments of the person's groups, in membership order. */
  groupProjectIds: readonly string[];
}

/** The projects a member can open, in the order the first one wins when the requested one is not among them. */
export function accessibleProjectIds(rows: MemberProjectRows, includeGroups: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => {
    const value = String(id);
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };
  rows.legacyProjectIds.forEach(add);
  rows.directProjectIds.forEach(add);
  if (includeGroups) rows.groupProjectIds.forEach(add);
  return out;
}

export type AccessOutcome =
  | { ok: true; projectId: string }
  | { ok: false; status: number; error: string };

/**
 * The project a member lands in: the requested one (the cookie), else the
 * workspace's default one, when they can open it; otherwise their first.
 */
export function resolveAccess(args: {
  accessible: readonly string[];
  cookie: string | null | undefined;
  defaultProjectId: string | null;
  /** Ids of the projects that exist (an assignment can outlive its project). */
  existingProjectIds: ReadonlySet<string>;
}): AccessOutcome {
  if (args.accessible.length === 0) return { ok: false, status: 403, error: 'No project assigned' };
  let projectId: string | undefined = args.cookie || args.defaultProjectId || undefined;
  if (!projectId || !args.accessible.includes(projectId)) projectId = args.accessible[0];
  if (!projectId) return { ok: false, status: 403, error: 'Forbidden' };
  if (!args.existingProjectIds.has(projectId)) return { ok: false, status: 404, error: 'Project not found' };
  return { ok: true, projectId };
}

export type AccessChange =
  | 'same'
  | 'gains-project-access'
  | 'loses-project-access'
  | 'different-active-project'
  | 'different-result';

export function compareAccess(before: AccessOutcome, after: AccessOutcome): AccessChange {
  if (before.ok) {
    if (!after.ok) return 'loses-project-access';
    return before.projectId === after.projectId ? 'same' : 'different-active-project';
  }
  if (after.ok) return 'gains-project-access';
  return before.status === after.status && before.error === after.error ? 'same' : 'different-result';
}

export interface AccessScenario {
  /** The project cookie of the scenario (null = none). */
  cookie: string | null;
  before: AccessOutcome;
  after: AccessOutcome;
  change: AccessChange;
}

/**
 * Every scenario worth comparing for one member: no cookie, and a cookie for
 * each project they can open after the upgrade. (A cookie for a project they
 * cannot open falls back to their first project in both worlds.)
 */
export function accessScenarios(args: {
  rows: MemberProjectRows;
  defaultProjectId: string | null;
  existingProjectIds: ReadonlySet<string>;
}): AccessScenario[] {
  const accessibleBefore = accessibleProjectIds(args.rows, false);
  const accessibleAfter = accessibleProjectIds(args.rows, true);
  const cookies: Array<string | null> = [null, ...accessibleAfter];
  return cookies.map((cookie) => {
    const before = resolveAccess({
      accessible: accessibleBefore,
      cookie,
      defaultProjectId: args.defaultProjectId,
      existingProjectIds: args.existingProjectIds,
    });
    const after = resolveAccess({
      accessible: accessibleAfter,
      cookie,
      defaultProjectId: args.defaultProjectId,
      existingProjectIds: args.existingProjectIds,
    });
    return { cookie, before, after, change: compareAccess(before, after) };
  });
}
