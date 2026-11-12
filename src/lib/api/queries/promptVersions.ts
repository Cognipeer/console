'use client';

/**
 * React Query hooks of a prompt's version history (the history modal: versions, deployments, compare).
 *
 * The keys sit under the prompt's own (`promptsKeys`, `prompts.ts`): the version list under its `versions` key, the
 * deployments under its `detail` key. So the prompt mutations there that invalidate a prompt's versions or its whole
 * detail reach them, and so does a project switch. The routes are `/api/prompts/:id/{versions,deployments,compare}`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api/client';
import type {
  PromptCompareView,
  PromptDeploymentEventView,
  PromptDeploymentStateView,
  PromptEnvironment,
  PromptVersionView,
} from '@/lib/services/prompts';
import { retryUnlessClientError } from './errors';
import { promptsKeys } from './prompts';
import { useProjectScope, useResourceKey } from './projectScope';

export interface PromptDeploymentsView {
  deployments: Partial<Record<PromptEnvironment, PromptDeploymentStateView>>;
  history: PromptDeploymentEventView[];
}

export type PromptDeploymentAction = 'promote' | 'plan' | 'activate' | 'rollback';

export const promptVersionKeys = {
  /** The versions the history modal lists (under the prompt's `versions` key). */
  history: (project: string, id: string) => [...promptsKeys.versions(project, id), 'history'] as const,
  deployments: (project: string, id: string) => [...promptsKeys.detail(project, id), 'deployments'] as const,
};

const promptPath = (id: string) => `/api/prompts/${encodeURIComponent(id)}`;

/** The versions of a prompt, read on every open of the modal (restoring and deploying change them). */
export function usePromptVersionHistory(id: string | undefined, enabled: boolean) {
  const [, project] = useResourceKey('prompts');
  return useQuery({
    queryKey: promptVersionKeys.history(project, id ?? ''),
    queryFn: async ({ signal }) => (await apiGet<{ versions?: PromptVersionView[] }>(`${promptPath(id as string)}/versions`, { signal })).versions ?? [],
    enabled: Boolean(id) && enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
    meta: { notifyOnError: 'Unable to load versions' },
  });
}

/** Where each environment points, and the deploy events. A failed read leaves the section empty. */
export function usePromptDeployments(id: string | undefined, enabled: boolean) {
  const [, project] = useResourceKey('prompts');
  return useQuery({
    queryKey: promptVersionKeys.deployments(project, id ?? ''),
    queryFn: async ({ signal }): Promise<PromptDeploymentsView> => {
      const data = await apiGet<{ deployments?: PromptDeploymentsView['deployments']; history?: PromptDeploymentEventView[] }>(
        `${promptPath(id as string)}/deployments`,
        { signal },
      );
      return { deployments: data.deployments ?? {}, history: data.history ?? [] };
    },
    enabled: Boolean(id) && enabled,
    retry: false,
    staleTime: 0,
  });
}

/** Both reads changed (a version was restored, a deployment moved): reread them. */
function useReloadVersionHistory(id: string | undefined) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: promptVersionKeys.history(project, id ?? '') }),
      queryClient.invalidateQueries({ queryKey: promptVersionKeys.deployments(project, id ?? '') }),
      queryClient.invalidateQueries({ queryKey: promptsKeys.versions(project, id ?? ''), exact: true }),
    ]);
}

/** Makes an earlier version the latest one (a new version is written). */
export function useRestorePromptVersion(id: string | undefined) {
  const reload = useReloadVersionHistory(id);
  return useMutation({
    mutationFn: (versionId: string) => apiPost<unknown>(`${promptPath(id as string)}/versions`, { versionId }),
    onSuccess: () => reload(),
  });
}

export function usePromptDeploymentAction(id: string | undefined) {
  const reload = useReloadVersionHistory(id);
  return useMutation({
    mutationFn: (input: { action: PromptDeploymentAction; environment: PromptEnvironment; versionId?: string; note?: string }) =>
      apiPost<unknown>(`${promptPath(id as string)}/deployments`, input),
    onSuccess: () => reload(),
  });
}

/** Compares two versions of a prompt (a read the person asks for with a button, so it is a mutation). */
export function useComparePromptVersions(id: string | undefined) {
  return useMutation({
    mutationFn: async ({ fromVersionId, toVersionId }: { fromVersionId: string; toVersionId: string }) => {
      const params = new URLSearchParams({ fromVersionId, toVersionId });
      const data = await apiGet<{ comparison?: PromptCompareView | null }>(`${promptPath(id as string)}/compare?${params.toString()}`);
      return data.comparison ?? null;
    },
  });
}
