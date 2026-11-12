'use client';

/**
 * React Query hooks of the skills list (`/api/skills`). Keys start `['skills', <project>, ...]`; the skill editor
 * lives outside these hooks, so the list refetches on every visit.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch } from '@/lib/api/client';
import type { SkillView } from '@/components/skills/types';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

export const skillsKeys = {
  all: ['skills'] as const,
  list: (project: string) => ['skills', project, 'list'] as const,
};

export function useSkillList() {
  const [, project] = useResourceKey('skills');
  return useQuery({
    queryKey: skillsKeys.list(project),
    queryFn: async ({ signal }) => (await apiGet<{ skills?: SkillView[] }>('/api/skills', { signal })).skills ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Switch a skill on or off. */
export function useSetSkillStatus() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'inactive' }) =>
      apiPatch(`/api/skills/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillsKeys.list(project) }),
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/skills/${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillsKeys.list(project) }),
  });
}
