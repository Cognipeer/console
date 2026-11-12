'use client';

/**
 * React Query hooks of the tools list (`/api/tools`). Keys start `['tools', <project>, ...]`; the create modal
 * lives outside these hooks, so the list refetches on every visit.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPut } from '@/lib/api/client';
import type { ToolView } from '@/lib/services/tools';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

export const toolsKeys = {
  all: ['tools'] as const,
  list: (project: string) => ['tools', project, 'list'] as const,
};

export function useToolList() {
  const [, project] = useResourceKey('tools');
  return useQuery({
    queryKey: toolsKeys.list(project),
    queryFn: async ({ signal }) => (await apiGet<{ tools?: ToolView[] }>('/api/tools', { signal })).tools ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Switch a tool on or off. */
export function useSetToolStatus() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      apiPut(`/api/tools/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolsKeys.list(project) }),
  });
}

export function useDeleteTool() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/tools/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolsKeys.list(project) }),
  });
}
