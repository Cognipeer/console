'use client';

/**
 * React Query hooks of the Inference Monitoring screens.
 *
 * - Every key starts `['inference', <project>, ...]` (`inferenceKeys`); `<project>` is the marker of
 *   `useResourceKey` (see `projectScope.ts`), so a project switch never shows the old project's servers.
 * - The server list, its dashboard and a server's record and metrics are refreshed on a timer while the tab is
 *   visible (`pollingOptions`): the scheduler polls the servers in the background.
 *
 * The routes are the dashboard's `/api/inference-monitoring` plugin.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api/client';
import { isClientError, retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface InferenceServerView {
  _id: string;
  key: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
  status: 'active' | 'disabled' | 'errored';
  pollIntervalSeconds: number;
  lastPolledAt?: string;
  lastError?: string;
  createdAt: string;
}

export interface InferenceLatestMetrics {
  gpuCacheUsagePercent?: number;
  numRequestsRunning?: number;
  numRequestsWaiting?: number;
  promptTokensThroughput?: number;
  generationTokensThroughput?: number;
  requestsPerSecond?: number;
  runningModels?: string[];
  timestamp?: string;
}

export interface InferenceDashboardData {
  overview: {
    totalServers: number;
    activeServers: number;
    erroredServers: number;
    disabledServers: number;
    avgGpuCacheUsage: number | null;
    totalRunningRequests: number;
    totalWaitingRequests: number;
    runningModelsCount: number;
  };
  typeBreakdown: Array<{ type: string; count: number }>;
  servers: Array<{
    key: string;
    name: string;
    type: string;
    status: string;
    lastPolledAt?: string;
    lastError?: string;
    latestMetrics: InferenceLatestMetrics | null;
  }>;
}

export interface InferenceMetricsRecord {
  _id: string;
  timestamp: string;
  numRequestsRunning?: number;
  numRequestsWaiting?: number;
  gpuCacheUsagePercent?: number;
  cpuCacheUsagePercent?: number;
  promptTokensThroughput?: number;
  generationTokensThroughput?: number;
  timeToFirstTokenSeconds?: number;
  timePerOutputTokenSeconds?: number;
  e2eRequestLatencySeconds?: number;
  requestsPerSecond?: number;
  runningModels?: string[];
}

export interface CreateInferenceServerInput {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  pollIntervalSeconds: number;
}

export interface UpdateInferenceServerInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  pollIntervalSeconds: number;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const inferenceKeys = {
  all: ['inference'] as const,
  project: (project: string) => ['inference', project] as const,
  list: (project: string) => ['inference', project, 'list'] as const,
  dashboard: (project: string, params: string) => ['inference', project, 'dashboard', params] as const,
  /** The server and its metrics. */
  detail: (project: string, key: string) => ['inference', project, 'detail', key] as const,
  metrics: (project: string, key: string, params: string) => ['inference', project, 'detail', key, 'metrics', params] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const serverPath = (key: string) => `/api/inference-monitoring/servers/${encodeURIComponent(key)}`;

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** The servers, refreshed every 30 s so status and `lastPolledAt` stay current. */
export function useInferenceServers() {
  const [, project] = useResourceKey('inference');
  return useQuery({
    queryKey: inferenceKeys.list(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ servers?: InferenceServerView[] }>('/api/inference-monitoring/servers', { signal })).servers ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions(() => true, 30_000),
  });
}

/** Overview numbers of the selected period; the previous period's numbers stay visible while the next one loads. */
export function useInferenceDashboard(params: string) {
  const [, project] = useResourceKey('inference');
  return useQuery({
    queryKey: inferenceKeys.dashboard(project, params),
    queryFn: ({ signal }) => apiGet<InferenceDashboardData>(`/api/inference-monitoring/dashboard?${params}`, { signal }),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions(() => true, 30_000),
  });
}

/** One server, refreshed on its own poll interval (at least every 15 s). */
export function useInferenceServer(key: string) {
  const [, project] = useResourceKey('inference');
  return useQuery({
    queryKey: inferenceKeys.detail(project, key),
    queryFn: async ({ signal }) => (await apiGet<{ server: InferenceServerView }>(serverPath(key), { signal })).server,
    retry: retryUnlessClientError,
    staleTime: 0,
    refetchInterval: (query) =>
      isClientError(query.state.error) ? false : Math.max(15, query.state.data?.pollIntervalSeconds ?? 30) * 1000,
    refetchIntervalInBackground: false,
  });
}

/** The metrics snapshots of a server in the selected period (`params`), newest first. */
export function useInferenceMetrics(key: string, params: string, pollIntervalSeconds: number | undefined) {
  const [, project] = useResourceKey('inference');
  return useQuery({
    queryKey: inferenceKeys.metrics(project, key, params),
    queryFn: async ({ signal }) =>
      (await apiGet<{ metrics?: InferenceMetricsRecord[] }>(`${serverPath(key)}/metrics?${params}`, { signal })).metrics ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions(() => true, Math.max(15, pollIntervalSeconds ?? 30) * 1000),
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

export function useCreateInferenceServer() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (input: CreateInferenceServerInput) => apiPost<unknown>('/api/inference-monitoring/servers', input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inferenceKeys.list(project) }),
        queryClient.invalidateQueries({ queryKey: [...inferenceKeys.project(project), 'dashboard'] }),
      ]);
    },
  });
}

export function useUpdateInferenceServer(key: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (input: UpdateInferenceServerInput) => apiPut<unknown>(serverPath(key), input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inferenceKeys.detail(project, key) }),
        queryClient.invalidateQueries({ queryKey: inferenceKeys.list(project) }),
      ]);
    },
  });
}

export function useDeleteInferenceServer(key: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: () => apiDelete<unknown>(serverPath(key)),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: inferenceKeys.detail(project, key) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inferenceKeys.list(project) }),
        queryClient.invalidateQueries({ queryKey: [...inferenceKeys.project(project), 'dashboard'] }),
      ]);
    },
  });
}

/** "Poll now": the server is polled at once, which adds a metrics snapshot and moves its status. */
export function usePollInferenceServer(key: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: () => apiPost<unknown>(`${serverPath(key)}/poll`),
    // A failed poll still stores the error on the server: both outcomes show the record again.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inferenceKeys.detail(project, key) }),
        queryClient.invalidateQueries({ queryKey: inferenceKeys.list(project) }),
      ]);
    },
  });
}
