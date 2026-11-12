'use client';

/**
 * React Query hooks of the Reranker screens.
 *
 * - Every key starts `['reranker', <project>, ...]` (`rerankerKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's rerankers.
 * - `detail(project, key)` reaches the reranker and its runs.
 *
 * The routes are the dashboard's `/api/reranker` plugin.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export type RerankerStrategy = 'dedicated-model' | 'llm-judge' | 'llm-listwise' | 'heuristic' | 'fusion';

export interface RerankerConfig {
  modelKey?: string;
  topN?: number;
  scoreThreshold?: number;
  batchSize?: number;
  temperature?: number;
  promptTemplate?: string;
  scoreNormalization?: 'none' | 'minmax';
}

export interface RerankerView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  strategy: RerankerStrategy;
  config: RerankerConfig;
  status: 'active' | 'disabled';
  totalRuns?: number;
  avgLatencyMs?: number;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RerankerRunLog {
  _id: string;
  query: string;
  inputCount: number;
  outputCount: number;
  latencyMs?: number;
  status: string;
  errorMessage?: string;
  createdAt?: string;
}

export interface RerankerRunResultItem {
  index: number;
  id?: string;
  score: number;
  originalScore?: number;
  content: string;
}

export interface RerankerRunResult {
  rerankerKey: string;
  strategy: string;
  modelKey?: string;
  results: RerankerRunResultItem[];
  latencyMs: number;
  inputCount: number;
  outputCount: number;
}

export interface CreateRerankerInput {
  name: string;
  description?: string;
  strategy: string;
  config: Record<string, unknown>;
}

export interface UpdateRerankerInput {
  key: string;
  name: string;
  description?: string;
  strategy: string;
  config: RerankerConfig;
  status: string;
}

export interface RunRerankerInput {
  key: string;
  query: string;
  documents: Array<{ content: string }>;
  topN?: number;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const rerankerKeys = {
  all: ['reranker'] as const,
  project: (project: string) => ['reranker', project] as const,
  list: (project: string) => ['reranker', project, 'list'] as const,
  /** The reranker and its runs. */
  detail: (project: string, key: string) => ['reranker', project, 'detail', key] as const,
  runs: (project: string, key: string) => ['reranker', project, 'detail', key, 'runs'] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const rerankerPath = (key: string) => `/api/reranker/${encodeURIComponent(key)}`;

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function useRerankerList() {
  const [, project] = useResourceKey('reranker');
  return useQuery({
    queryKey: rerankerKeys.list(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ rerankers?: RerankerView[] }>('/api/reranker', { signal })).rerankers ?? [],
    retry: retryUnlessClientError,
    meta: { notifyOnError: 'Unable to load rerankers' },
    staleTime: 0,
  });
}

export function useReranker(key: string | undefined) {
  const [, project] = useResourceKey('reranker');
  return useQuery({
    queryKey: rerankerKeys.detail(project, key ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ reranker: RerankerView }>(rerankerPath(key as string), { signal })).reranker,
    enabled: Boolean(key),
    retry: retryUnlessClientError,
    meta: { notifyOnError: 'Unable to load reranker' },
    staleTime: 0,
  });
}

/** The last 50 runs of a reranker, read when the Runs tab is opened. */
export function useRerankerRuns(key: string | undefined, enabled: boolean) {
  const [, project] = useResourceKey('reranker');
  return useQuery({
    queryKey: rerankerKeys.runs(project, key ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ logs?: RerankerRunLog[] }>(`${rerankerPath(key as string)}/runs?limit=50`, { signal })).logs ?? [],
    enabled: Boolean(key) && enabled,
    retry: retryUnlessClientError,
    // Runs are written by every caller of the reranker: opening the tab always reads them again.
    staleTime: 0,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

export function useCreateReranker() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (input: CreateRerankerInput) =>
      (await apiPost<{ reranker: RerankerView }>('/api/reranker', input)).reranker,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: rerankerKeys.list(project) });
    },
  });
}

export function useUpdateReranker() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ key, ...input }: UpdateRerankerInput) =>
      (await apiPatch<{ reranker: RerankerView }>(rerankerPath(key), input)).reranker,
    onSuccess: async (reranker, { key }) => {
      queryClient.setQueryData(rerankerKeys.detail(project, key), reranker);
      await queryClient.invalidateQueries({ queryKey: rerankerKeys.list(project) });
    },
  });
}

export function useDeleteReranker() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (key: string) => apiDelete<unknown>(rerankerPath(key)),
    onSuccess: async (_result, key) => {
      queryClient.removeQueries({ queryKey: rerankerKeys.detail(project, key) });
      await queryClient.invalidateQueries({ queryKey: rerankerKeys.list(project) });
    },
  });
}

/** A playground run: it adds a log row and moves the run counters of the reranker. */
export function useRunReranker() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ key, ...input }: RunRerankerInput) =>
      (await apiPost<{ result: RerankerRunResult }>(`${rerankerPath(key)}/run`, input)).result,
    onSuccess: async (_result, { key }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: rerankerKeys.runs(project, key) }),
        queryClient.invalidateQueries({ queryKey: rerankerKeys.list(project) }),
      ]);
    },
  });
}
