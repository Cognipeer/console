'use client';

/**
 * React Query hooks of Prompt Studio.
 *
 * - Every key starts `['prompts', <project>, ...]` (`promptsKeys`); `<project>` is the marker of
 *   `useResourceKey` (see `projectScope.ts`), so a project switch never shows the old project's prompts.
 * - A key is a prefix of the keys below it: `detail(project, id)` reaches the prompt, its versions and its comments.
 * - Mutations invalidate what they change (the list and its stats, the prompt that was edited).
 *
 * The routes are the dashboard's `/api/prompts` plugin (`src/server/api/plugins/prompts.ts`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { PromptCommentView, PromptVersionView, PromptView } from '@/lib/services/prompts';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface PromptsDashboardData {
  overview: {
    totalPrompts: number;
    totalVersions: number;
    totalVariablePrompts: number;
    avgVersionsPerPrompt: number;
  };
  recentlyUpdated: Array<{ id: string; name: string; key: string; updatedAt: string }>;
  versionDistribution: Array<{ label: string; count: number }>;
}

export interface PromptInput {
  name: string;
  key?: string;
  description?: string;
  template: string;
  versionComment?: string;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const promptsKeys = {
  all: ['prompts'] as const,
  project: (project: string) => ['prompts', project] as const,
  list: (project: string) => ['prompts', project, 'list'] as const,
  stats: (project: string) => ['prompts', project, 'stats'] as const,
  /** The prompt, its versions and its comments. */
  detail: (project: string, id: string) => ['prompts', project, 'detail', id] as const,
  versions: (project: string, id: string) => ['prompts', project, 'detail', id, 'versions'] as const,
  comments: (project: string, id: string) => ['prompts', project, 'detail', id, 'comments'] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const promptPath = (id: string) => `/api/prompts/${encodeURIComponent(id)}`;

const fetchPrompts = async (signal?: AbortSignal) =>
  (await apiGet<{ prompts?: PromptView[] }>('/api/prompts', { signal })).prompts ?? [];

const fetchPromptStats = (signal?: AbortSignal) => apiGet<PromptsDashboardData>('/api/prompts/stats', { signal });

const fetchPrompt = async (id: string, signal?: AbortSignal) =>
  (await apiGet<{ prompt: PromptView }>(promptPath(id), { signal })).prompt;

const fetchVersions = async (id: string, signal?: AbortSignal) =>
  (await apiGet<{ versions?: PromptVersionView[] }>(`${promptPath(id)}/versions`, { signal })).versions ?? [];

const fetchComments = async (id: string, signal?: AbortSignal) =>
  (await apiGet<{ comments?: PromptCommentView[] }>(`${promptPath(id)}/comments`, { signal })).comments ?? [];

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function usePromptList() {
  const [, project] = useResourceKey('prompts');
  return useQuery({
    queryKey: promptsKeys.list(project),
    queryFn: ({ signal }) => fetchPrompts(signal),
    retry: retryUnlessClientError,
  });
}

export function usePromptStats() {
  const [, project] = useResourceKey('prompts');
  return useQuery({
    queryKey: promptsKeys.stats(project),
    queryFn: ({ signal }) => fetchPromptStats(signal),
    retry: retryUnlessClientError,
  });
}

export function usePrompt(id: string | undefined) {
  const [, project] = useResourceKey('prompts');
  return useQuery({
    queryKey: promptsKeys.detail(project, id ?? ''),
    queryFn: ({ signal }) => fetchPrompt(id as string, signal),
    enabled: Boolean(id),
    retry: retryUnlessClientError,
  });
}

export function usePromptVersions(id: string | undefined) {
  const [, project] = useResourceKey('prompts');
  return useQuery({
    queryKey: promptsKeys.versions(project, id ?? ''),
    queryFn: ({ signal }) => fetchVersions(id as string, signal),
    enabled: Boolean(id),
    retry: retryUnlessClientError,
  });
}

export function usePromptComments(id: string | undefined) {
  const [, project] = useResourceKey('prompts');
  return useQuery({
    queryKey: promptsKeys.comments(project, id ?? ''),
    queryFn: ({ signal }) => fetchComments(id as string, signal),
    enabled: Boolean(id),
    retry: retryUnlessClientError,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/** Creating a prompt changes the list and its stats. */
export function useCreatePrompt() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (input: PromptInput) => (await apiPost<{ prompt: PromptView }>('/api/prompts', input)).prompt,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: promptsKeys.list(project) }),
        queryClient.invalidateQueries({ queryKey: promptsKeys.stats(project) }),
      ]);
    },
  });
}

/** Saving an edit changes the prompt (and, with a new version, its versions), the list and its stats. */
export function useUpdatePrompt() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ id, ...input }: PromptInput & { id: string }) =>
      (await apiPatch<{ prompt: PromptView }>(promptPath(id), input)).prompt,
    onSuccess: async (prompt, { id }) => {
      queryClient.setQueryData(promptsKeys.detail(project, id), prompt);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: promptsKeys.list(project) }),
        queryClient.invalidateQueries({ queryKey: promptsKeys.stats(project) }),
        queryClient.invalidateQueries({ queryKey: promptsKeys.versions(project, id) }),
      ]);
    },
  });
}

export function useDeletePrompt() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean }>(promptPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: promptsKeys.detail(project, id) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: promptsKeys.list(project) }),
        queryClient.invalidateQueries({ queryKey: promptsKeys.stats(project) }),
      ]);
    },
  });
}

export function useAddPromptComment(promptId: string | undefined) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (content: string) =>
      (await apiPost<{ comment: PromptCommentView }>(`${promptPath(promptId as string)}/comments`, { content })).comment,
    onSuccess: (comment) => {
      queryClient.setQueryData<PromptCommentView[]>(promptsKeys.comments(project, promptId as string), (current) => [
        comment,
        ...(current ?? []),
      ]);
    },
  });
}

export function useDeletePromptComment(promptId: string | undefined) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (commentId: string) =>
      apiDelete<{ success: boolean }>(`${promptPath(promptId as string)}/comments/${encodeURIComponent(commentId)}`),
    onSuccess: (_result, commentId) => {
      queryClient.setQueryData<PromptCommentView[]>(promptsKeys.comments(project, promptId as string), (current) =>
        (current ?? []).filter((comment) => comment.id !== commentId),
      );
    },
  });
}

/** After something outside these hooks changed a prompt (a version was restored): reread it and the lists. */
export function useInvalidatePrompt() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return (id: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: promptsKeys.detail(project, id) }),
      queryClient.invalidateQueries({ queryKey: promptsKeys.list(project) }),
      queryClient.invalidateQueries({ queryKey: promptsKeys.stats(project) }),
    ]);
}
