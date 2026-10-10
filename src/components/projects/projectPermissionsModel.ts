/**
 * Model of the project permission editor: what a member is given per service
 * INSIDE one project, and how that combines with the member's workspace level.
 *
 * A project level is a ceiling, never a grant: the engine applies
 * `min(workspace level, project level)`. So each service has exactly two states
 * in storage - nothing (the workspace level stands: "inherit") or an explicit
 * level, including an explicit "no access". The editor never renders an unset
 * service as "None" (it used to, which turned every touched-and-put-back service
 * into a real restriction) and saves only what was chosen. Pure (no React);
 * covered by unit tests.
 */

import {
  minPermission,
  normalizeServicePermissions,
  RBAC_SERVICE_DEFINITIONS,
  SERVICE_PERMISSION_LEVELS,
  type RbacServiceDefinition,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';

/** What an admin can choose for one service. `inherit` stores nothing. */
export type ProjectChoice = 'inherit' | ServicePermissionLevel;

export const PROJECT_CHOICES: readonly ProjectChoice[] = ['inherit', ...SERVICE_PERMISSION_LEVELS];

/**
 * What the editor OFFERS. A retired service keeps its definition (`deprecated`)
 * so a stored entry naming it still resolves, but it is not something new to
 * hand out - filtered on the flag, not the id, so the next retirement needs no change.
 */
export const GRANTABLE_SERVICES: readonly RbacServiceDefinition[] = RBAC_SERVICE_DEFINITIONS.filter(
  (service) => !service.deprecated,
);

const GRANTABLE_IDS: ReadonlySet<string> = new Set(GRANTABLE_SERVICES.map((s) => s.id));

export interface StoredChoices {
  /** One entry per offered service (`inherit` when nothing is stored). */
  choices: Record<string, ProjectChoice>;
  /** Stored entries for services the editor does not offer: carried through a save untouched. */
  kept: UserServicePermissions;
}

/**
 * Reads a member's stored project levels.
 *
 * `ignored` names services whose stored "no access" the engine reads as not set
 * (a setting saved before project levels were enforced, when the old screen
 * wrote "None" for services nobody had touched). They show as `inherit`, and a
 * save drops them.
 */
export function readStored(stored: unknown, ignored: readonly string[] = []): StoredChoices {
  const levels = normalizeServicePermissions(stored);
  const skip = new Set(ignored);
  const choices: Record<string, ProjectChoice> = {};
  const kept: UserServicePermissions = {};
  for (const service of GRANTABLE_SERVICES) {
    const level = levels[service.id];
    choices[service.id] = level && !(level === 'none' && skip.has(service.id)) ? level : 'inherit';
  }
  for (const [service, level] of Object.entries(levels) as Array<[keyof UserServicePermissions, ServicePermissionLevel]>) {
    if (!GRANTABLE_IDS.has(service)) kept[service] = level;
  }
  return { choices, kept };
}

/** The services whose stored "no access" is among `ignored` (the entries a save drops). */
export function ignoredEntries(stored: unknown, ignored: readonly string[] = []): string[] {
  const levels = normalizeServicePermissions(stored);
  const skip = new Set(ignored);
  return GRANTABLE_SERVICES.filter((s) => levels[s.id] === 'none' && skip.has(s.id)).map((s) => s.id);
}

/**
 * Which stored "no access" entries have no effect, judged from what a member can
 * do: the engine reads an explicit "no access" saved before project levels were
 * enforced as not set. Such an entry on a service the member reaches in the
 * workspace, which no project setting narrows in the project, is not enforced.
 * (On a service the member does not reach anyway, the entry changes nothing
 * either way, so it is left as stored.)
 *
 * `workspaceLevels`: the member's level per service in the whole workspace.
 * `limitedByProject`: services whose level the project narrows for this member.
 */
export function inferIgnoredNone(
  storedNone: readonly string[],
  workspaceLevels: Readonly<Record<string, string>>,
  limitedByProject: ReadonlySet<string>,
): string[] {
  return storedNone.filter((id) => (workspaceLevels[id] ?? 'none') !== 'none' && !limitedByProject.has(id));
}

/** What is saved: only explicit choices (`inherit` removes the key), plus the entries carried through. */
export function toPermissions(choices: Record<string, ProjectChoice>, kept: UserServicePermissions = {}): UserServicePermissions {
  const out: UserServicePermissions = { ...kept };
  for (const service of GRANTABLE_SERVICES) {
    const choice = choices[service.id];
    if (choice && choice !== 'inherit') out[service.id] = choice;
  }
  return out;
}

/** How many services carry an explicit project level. */
export function limitCount(choices: Record<string, ProjectChoice>): number {
  return GRANTABLE_SERVICES.reduce((n, s) => (choices[s.id] && choices[s.id] !== 'inherit' ? n + 1 : n), 0);
}

/** Services whose choice differs between two states, in the editor's order. */
export function changedServices(before: Record<string, ProjectChoice>, after: Record<string, ProjectChoice>): string[] {
  return GRANTABLE_SERVICES.filter((s) => (before[s.id] ?? 'inherit') !== (after[s.id] ?? 'inherit')).map((s) => s.id);
}

/**
 * The level a member ends up with in the project for one service: the lower of
 * the workspace level and the project level; with no project level, the workspace
 * level. `null` while the workspace level is unknown (then only an explicit
 * choice can be said).
 */
export function effectiveLevel(workspace: ServicePermissionLevel | null, choice: ProjectChoice): ServicePermissionLevel | null {
  if (choice === 'inherit') return workspace;
  return workspace === null ? choice : minPermission(workspace, choice);
}

/** True when an explicit level is above the workspace level, i.e. it changes nothing (a project level never widens). */
export function exceedsWorkspace(workspace: ServicePermissionLevel | null, choice: ProjectChoice): boolean {
  if (workspace === null || choice === 'inherit') return false;
  return SERVICE_PERMISSION_LEVELS.indexOf(choice) > SERVICE_PERMISSION_LEVELS.indexOf(workspace);
}

export type AccessSummary =
  | { kind: 'inherits' }
  | { kind: 'one'; service: string; level: ServicePermissionLevel }
  | { kind: 'many'; count: number; entries: Array<{ service: string; level: ServicePermissionLevel }> };

/**
 * The "service access" cell of the members table: what the project limits for
 * this member. An explicit "no access" counts (it is a real limit now); a stored
 * one the engine ignores does not, and neither does a retired service.
 */
export function summarizeStored(stored: unknown, ignored: readonly string[] = []): AccessSummary {
  const { choices } = readStored(stored, ignored);
  const entries: Array<{ service: string; level: ServicePermissionLevel }> = [];
  for (const service of GRANTABLE_SERVICES) {
    const choice = choices[service.id];
    if (choice && choice !== 'inherit') entries.push({ service: service.id, level: choice });
  }
  if (entries.length === 0) return { kind: 'inherits' };
  if (entries.length === 1) return { kind: 'one', service: entries[0]!.service, level: entries[0]!.level };
  return { kind: 'many', count: entries.length, entries };
}
