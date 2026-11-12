'use client';

/**
 * React Query hooks of Projects (list, detail tabs, members, settings) and of the signed-in session role the
 * project screens read.
 *
 * - Every key starts `['projects', <project>, ...]` (`projectsKeys`); `<project>` is the marker of `useResourceKey`.
 * - Every write invalidates the whole `['projects', <project>]` prefix: the list (with its counts), the overview and
 *   the members of a project all show the same facts, so none of them is left stale.
 * - Reads that need parsing (`parseOverview`, `parseMembers`, `parseProjectRows`) return the raw body: the screen
 *   owns the parser, the hook owns the request.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface ProjectBasic {
  _id: string;
  name: string;
  key: string;
}

export interface ProjectsPayload<TProject = ProjectBasic> {
  projects?: TProject[];
  activeProjectId?: string;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const projectsKeys = {
  all: ['projects'] as const,
  project: (project: string) => ['projects', project] as const,
  list: (project: string, withStats: boolean) => ['projects', project, 'list', withStats ? 'stats' : 'basic'] as const,
  overview: (project: string, id: string) => ['projects', project, 'detail', id, 'overview'] as const,
  members: (project: string, id: string) => ['projects', project, 'detail', id, 'members'] as const,
  /** The role of the signed-in person is not a fact of one project. */
  session: ['session', 'role'] as const,
};

const enc = encodeURIComponent;

/**
 * While the project marker changes (the app made a project active), keep showing what the same read showed a
 * moment ago instead of a spinner. Only the very same read qualifies (same tail after `[resource, marker]`),
 * never another project's overview or members.
 */
function keepWhenSameRead<T>(tail: readonly unknown[]) {
  return (previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }): T | undefined => {
    if (!previousQuery) return undefined;
    const before = previousQuery.queryKey.slice(2);
    return before.length === tail.length && before.every((part, i) => part === tail[i]) ? previous : undefined;
  };
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** The projects of the workspace and the active one. Other screens create and edit projects, so a visit refetches. */
export function useProjects<TProject = ProjectBasic>(options: { stats?: boolean } = {}) {
  const [, project] = useResourceKey('projects');
  const withStats = Boolean(options.stats);
  return useQuery<ProjectsPayload<TProject>, Error>({
    queryKey: projectsKeys.list(project, withStats),
    queryFn: ({ signal }) =>
      apiGet<ProjectsPayload<TProject>>(withStats ? '/api/projects?include=stats' : '/api/projects', { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepWhenSameRead<ProjectsPayload<TProject>>(['list', withStats ? 'stats' : 'basic']),
  });
}

/** The role of the signed-in person (`owner`, `admin`, ...). A failed read leaves it undefined, as before. */
export function useSessionRole() {
  return useQuery({
    queryKey: projectsKeys.session,
    queryFn: async ({ signal }) => (await apiGet<{ role?: string }>('/api/auth/session', { signal }))?.role,
    retry: false,
  });
}

/** The raw overview body of one project (the screen parses it). */
export function useProjectOverview(projectId: string) {
  const [, project] = useResourceKey('projects');
  return useQuery<unknown, Error>({
    queryKey: projectsKeys.overview(project, projectId),
    queryFn: ({ signal }) => apiGet<unknown>(`/api/projects/${enc(projectId)}/overview`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepWhenSameRead<unknown>(['detail', projectId, 'overview']),
  });
}

/** The raw members body of one project (the screen parses it). */
export function useProjectMembers(projectId: string) {
  const [, project] = useResourceKey('projects');
  return useQuery<unknown, Error>({
    queryKey: projectsKeys.members(project, projectId),
    queryFn: ({ signal }) => apiGet<unknown>(`/api/projects/${enc(projectId)}/members`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepWhenSameRead<unknown>(['detail', projectId, 'members']),
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useInvalidateProjects() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: projectsKeys.project(project) });
}

/** Make a project the active one. The result of the call is empty. */
export function useSetActiveProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (projectId: string) => apiPost<unknown>('/api/projects/active', { projectId }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name: string; description: string }) =>
      apiPatch<unknown>(`/api/projects/${enc(id)}`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(`/api/projects/${enc(id)}`),
    onSuccess: () => invalidate(),
  });
}

/** `POST /members/bulk` (add, change role, remove); the result is the raw body (the screen parses it). */
export function useBulkProjectMembers(projectId: string) {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (body: unknown) => apiPost<unknown>(`/api/projects/${enc(projectId)}/members/bulk`, body),
    onSuccess: () => invalidate(),
  });
}

export function useSetMemberPermissions(projectId: string) {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (body: { userId: string; servicePermissions: unknown }) =>
      apiPatch<unknown>(`/api/projects/${enc(projectId)}/members/permissions`, body),
    onSuccess: () => invalidate(),
  });
}
