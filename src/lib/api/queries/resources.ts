'use client';

/**
 * React Query hooks of the Resources explorer (the list, the health report and one resource's detail).
 *
 * - Every key starts `['resources', <project>, ...]` (`resourcesKeys`); `<project>` is the marker of `useResourceKey`.
 * - The explorer's refresh asks the server to rebuild its index (`refresh=1`) and puts the answer in the list's
 *   cache; the health report is invalidated with it.
 * - The responses are typed by the screen (`TList`, `THealth`, `TDetail`): the hook owns the request.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

export interface ResourceListParams {
  type?: string;
  projectId?: string;
  q?: string;
  status?: string;
  onlyIssues?: boolean;
  limit: number;
  offset: number;
}

export interface ResourceHealthParams {
  severity?: string;
  kind?: string;
  type?: string;
}

export const resourcesKeys = {
  all: ['resources'] as const,
  project: (project: string) => ['resources', project] as const,
  list: (project: string, query: string) => ['resources', project, 'list', query] as const,
  health: (project: string, query: string) => ['resources', project, 'health', query] as const,
  detail: (project: string, type: string, id: string) => ['resources', project, 'detail', type, id] as const,
};

/** The query string of the list, in the order the explorer always sent it. */
export function listQueryString(params: ResourceListParams, refresh = false): string {
  const search = new URLSearchParams();
  if (params.type) search.set('type', params.type);
  if (params.projectId) search.set('projectId', params.projectId);
  if (params.q?.trim()) search.set('q', params.q.trim());
  if (params.status) search.set('status', params.status);
  if (params.onlyIssues) search.set('health', 'issues');
  search.set('limit', String(params.limit));
  search.set('offset', String(params.offset));
  if (refresh) search.set('refresh', '1');
  return search.toString();
}

export function healthQueryString(params: ResourceHealthParams): string {
  const search = new URLSearchParams();
  if (params.severity) search.set('severity', params.severity);
  if (params.kind) search.set('kind', params.kind);
  if (params.type) search.set('type', params.type);
  return search.toString();
}

/** One page of resources. The rows of the page left stay while the next page loads. */
export function useResourceList<TList>(params: ResourceListParams) {
  const [, project] = useResourceKey('resources');
  const query = listQueryString(params);
  return useQuery({
    queryKey: resourcesKeys.list(project, query),
    queryFn: ({ signal }) => apiGet<TList>(`/api/resources?${query}`, { signal }),
    retry: retryUnlessClientError,
    placeholderData: keepPreviousData,
    // Resources are written all over the console, so a visit always refetches.
    staleTime: 0,
  });
}

/** Ask the server to rebuild its index for this page and show the answer. */
export function useRefreshResourceList<TList>() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (params: ResourceListParams) =>
      apiGet<TList>(`/api/resources?${listQueryString(params, true)}`),
    onSuccess: async (data, params) => {
      queryClient.setQueryData(resourcesKeys.list(project, listQueryString(params)), data);
      await queryClient.invalidateQueries({ queryKey: [...resourcesKeys.project(project), 'health'] });
    },
  });
}

/** The health report. With no filter it is also the explorer's header summary. */
export function useResourceHealth<THealth>(params: ResourceHealthParams = {}, options: { enabled?: boolean } = {}) {
  const [, project] = useResourceKey('resources');
  const query = healthQueryString(params);
  return useQuery({
    queryKey: resourcesKeys.health(project, query),
    queryFn: ({ signal }) => apiGet<THealth>(`/api/resources/health${query ? `?${query}` : ''}`, { signal }),
    enabled: options.enabled ?? true,
    retry: retryUnlessClientError,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

/** One resource for the drawer. Each opening reads it again. */
export function useResourceDetail<TDetail>(type: string | undefined, id: string | undefined) {
  const [, project] = useResourceKey('resources');
  return useQuery({
    queryKey: resourcesKeys.detail(project, type ?? '', id ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ resource: TDetail }>(`/api/resources/${encodeURIComponent(type as string)}/${encodeURIComponent(id as string)}`, { signal }))
        .resource,
    enabled: Boolean(type && id),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}
