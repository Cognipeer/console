/**
 * Project display rule. `projectId === null` alone is ambiguous (a tenant-wide
 * tool, a GPU host that has no project concept, a provider nobody was assigned
 * to), so the server classifies every row once and the UI only renders it.
 */
import { getResourceTypeDefinition } from './registry';
import type { ProjectDisplay, ResourceRecord, ResourceScope } from './types';

export interface ProjectDisplayInput {
  scope: ResourceScope;
  projectId: string | null;
  projectIds?: readonly string[];
}

/**
 * Scope of a type for display purposes. A type that is not registered (a stale
 * reference to a type of another edition) is treated as the most lenient scope,
 * so it is never reported as "unassigned" on a guess.
 */
export function scopeOfType(type: string): ResourceScope {
  return getResourceTypeDefinition(type)?.scope ?? 'project-or-tenant';
}

export function computeProjectDisplay(
  input: ProjectDisplayInput,
  projectNames: ReadonlyMap<string, string>,
): ProjectDisplay {
  const ids = [...new Set([...(input.projectId ? [input.projectId] : []), ...(input.projectIds ?? [])])];
  if (ids.length > 1) {
    return {
      kind: 'multi-project',
      projectIds: ids,
      // Falls back to the id so ids and names stay index-aligned for a deleted project.
      projectNames: ids.map((id) => projectNames.get(id) ?? id),
    };
  }
  const only = ids[0];
  if (only) return { kind: 'project', projectId: only, projectName: projectNames.get(only) ?? null };
  switch (input.scope) {
    case 'tenant':
      return { kind: 'tenant-level' };
    case 'project-or-tenant':
      return { kind: 'all-projects' };
    case 'project':
    default:
      return { kind: 'unassigned' };
  }
}

export function projectDisplayOfRecord(
  r: Pick<ResourceRecord, 'type' | 'projectId' | 'projectIds'>,
  projectNames: ReadonlyMap<string, string>,
  scope: ResourceScope = scopeOfType(r.type),
): ProjectDisplay {
  return computeProjectDisplay({ scope, projectId: r.projectId, projectIds: r.projectIds }, projectNames);
}

/** True when the row is not bound to a single project (the `projectId=tenant` filter). */
export function isNotBoundToOneProject(display: ProjectDisplay): boolean {
  return display.kind === 'all-projects' || display.kind === 'tenant-level' || display.kind === 'unassigned';
}

/** True when a project filter value selects this row (the row belongs to, or is usable from, that exact project). */
export function matchesProjectFilter(display: ProjectDisplay, projectId: string): boolean {
  if (projectId === 'tenant') return isNotBoundToOneProject(display);
  if (display.kind === 'project') return display.projectId === projectId;
  if (display.kind === 'multi-project') return display.projectIds.includes(projectId);
  return false;
}
