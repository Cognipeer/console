'use client';

/**
 * React Query hooks of the Knowledge Engine (RAG) dashboard.
 *
 * - Every key starts `['rag', <project>, ...]` (`ragKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's modules.
 * - `module(project, key)` is a prefix of the module's detail, re-index runs and documents: invalidating it rereads all.
 * - Mutations invalidate what they change.
 *
 * Besides the module hooks this file holds the small lookups (models, rerankers) that the RAG and Memory forms
 * offer in their pickers.
 *
 * The routes are the dashboard's `/api/rag` plugin.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface RagModuleListItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  chunkConfig: {
    strategy: string;
    chunkSize: number;
    chunkOverlap: number;
  };
  status: string;
  /** Stored vectors no longer match the module's chunking or embedding model. */
  reindexRequired?: boolean;
  totalDocuments?: number;
  totalChunks?: number;
  createdAt?: string;
}

/** An entry of `GET /api/models?category=...` as the pickers read it. */
export interface ModelLookup {
  key: string;
  name?: string;
  modelId?: string;
}

export interface RerankerLookup {
  key: string;
  name: string;
}

export type RagReindexReasonInput = 'chunk-config' | 'embedding-model' | 'manual';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const ragKeys = {
  all: ['rag'] as const,
  project: (project: string) => ['rag', project] as const,
  list: (project: string) => ['rag', project, 'list'] as const,
  /** The module, its re-index runs and everything else read about it. */
  module: (project: string, key: string) => ['rag', project, 'module', key] as const,
  detail: (project: string, key: string) => ['rag', project, 'module', key, 'detail'] as const,
  reindexRuns: (project: string, key: string) => ['rag', project, 'module', key, 'reindex'] as const,
  models: (project: string, category: string) => ['rag', project, 'lookup', 'models', category] as const,
  rerankers: (project: string) => ['rag', project, 'lookup', 'rerankers'] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

export const ragModulePath = (key: string) => `/api/rag/modules/${encodeURIComponent(key)}`;

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function useRagModules() {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.list(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ modules?: RagModuleListItem[] }>('/api/rag/modules', { signal })).modules ?? [],
    retry: retryUnlessClientError,
    // Modules are also created and changed from other screens (the agent studio, the crawler), so a visit refetches.
    staleTime: 0,
    meta: { notifyOnError: 'Unable to load Knowledge Engine modules' },
  });
}

/** The models of one category (`embedding`, `llm`, ...) for a picker; pass `enabled` to read only while it is open. */
export function useModelsByCategory(category: string, enabled = true) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.models(project, category),
    queryFn: async ({ signal }): Promise<ModelLookup[]> => {
      const data = await apiGet<{ models?: ModelLookup[] } | ModelLookup[]>(
        `/api/models?category=${encodeURIComponent(category)}`,
        { signal },
      );
      return Array.isArray(data) ? data : (data.models ?? []);
    },
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useActiveRerankers(enabled = true) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.rerankers(project),
    queryFn: async ({ signal }): Promise<RerankerLookup[]> =>
      (await apiGet<{ rerankers?: RerankerLookup[] }>('/api/reranker?status=active', { signal })).rerankers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

const reindexRunIsActive = (run: IRagReindexRun) =>
  run.status === 'pending' || run.status === 'queued' || run.status === 'running';

/** The module's re-index runs, newest first; reread every `pollMs` while one is not finished. */
export function useRagReindexRuns(moduleKey: string | undefined, pollMs: number) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.reindexRuns(project, moduleKey ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ runs?: IRagReindexRun[] }>(`${ragModulePath(moduleKey as string)}/reindex`, { signal })).runs ??
      [],
    enabled: Boolean(moduleKey),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<IRagReindexRun[]>((runs) => Boolean(runs?.some(reindexRunIsActive)), pollMs),
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/** Creating a module changes the list. */
export function useCreateRagModule() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiPost<{ module: Record<string, unknown> }>('/api/rag/modules', body)).module,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ragKeys.list(project) }),
  });
}

/** Saving a module changes its detail and the list. */
export function useUpdateRagModule(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiPatch<{ module: Record<string, unknown> }>(ragModulePath(moduleKey), body)).module,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ragKeys.detail(project, moduleKey) }),
        queryClient.invalidateQueries({ queryKey: ragKeys.list(project) }),
      ]),
  });
}

export function useDeleteRagModule() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (key: string) => apiDelete(ragModulePath(key)),
    onSuccess: async (_result, key) => {
      queryClient.removeQueries({ queryKey: ragKeys.module(project, key) });
      await queryClient.invalidateQueries({ queryKey: ragKeys.list(project) });
    },
  });
}

/** Starting a run changes the runs, the module (`reindexRequired`) and the list. */
export function useStartRagReindex(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (reason?: RagReindexReasonInput) =>
      apiPost(`${ragModulePath(moduleKey)}/reindex`, reason ? { reason } : undefined),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ragKeys.reindexRuns(project, moduleKey) }),
        queryClient.invalidateQueries({ queryKey: ragKeys.detail(project, moduleKey) }),
        queryClient.invalidateQueries({ queryKey: ragKeys.list(project) }),
      ]),
  });
}

export function useCancelRagReindex(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (runKey: string) => apiPost(`${ragModulePath(moduleKey)}/reindex/${encodeURIComponent(runKey)}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ragKeys.reindexRuns(project, moduleKey) }),
  });
}
