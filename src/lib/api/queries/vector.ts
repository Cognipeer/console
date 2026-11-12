'use client';

/**
 * React Query hooks of the Vector area (providers, indexes, migrations).
 *
 * - Every key starts `['vector', <project>, ...]` (`vectorKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's providers or indexes.
 * - `providers`/`indexes`/`migrations` are prefixes of the lists below them: invalidating one rereads all of its variants.
 * - Mutations invalidate what they change.
 *
 * The routes are the dashboard's `/api/vector` plugin.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { IVectorMigration, IVectorMigrationLog, IVectorMigrationRunSummary } from '@/lib/database/provider/types.base';
import type {
  VectorIndexRecord,
  VectorIndexView,
  VectorProviderView,
  VectorQueryResponse,
} from '@/lib/services/vector';
import type { ProviderDescriptor, ProviderFormSchema } from '@/lib/providers';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface VectorDashboardData {
  overview: {
    totalProviders: number;
    activeProviders: number;
    disabledProviders: number;
    erroredProviders: number;
    totalIndexes: number;
  };
  providerBreakdown: Array<{ key: string; label: string; driver: string; status: string; indexCount: number }>;
  dimensionDistribution: Array<{ dimension: number; count: number }>;
  metricDistribution: Array<{ metric: string; count: number }>;
  recentIndexes: Array<{
    key: string;
    name: string;
    providerKey: string;
    dimension: number;
    metric: string;
    createdAt?: string;
  }>;
}

export interface VectorProvidersWithIndexes {
  providers: VectorProviderView[];
  indexesByProvider: Record<string, VectorIndexView[]>;
}

export interface VectorIndexDetail {
  index: VectorIndexView | null;
  provider: VectorProviderView | null;
}

export interface MigrationDetailResponse {
  migration: IVectorMigration;
  logs: IVectorMigrationLog[];
  totalLogs: number;
  runs: IVectorMigrationRunSummary[];
}

export interface CreateIndexInput {
  providerKey: string;
  name: string;
  createInProvider: boolean;
  dimension?: number;
  metric?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateProviderInput {
  key: string;
  label: string;
  description?: string;
  driver: string;
  status: 'active' | 'disabled';
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface CreateMigrationInput {
  name: string;
  description?: string;
  sourceProviderKey: string;
  sourceIndexKey: string;
  destinationProviderKey: string;
  destinationIndexKey: string;
  batchSize?: number;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const vectorKeys = {
  all: ['vector'] as const,
  project: (project: string) => ['vector', project] as const,
  /** Every provider list (plain and with indexes). */
  providers: (project: string) => ['vector', project, 'providers'] as const,
  providerList: (project: string) => ['vector', project, 'providers', 'list'] as const,
  providersWithIndexes: (project: string) => ['vector', project, 'providers', 'with-indexes'] as const,
  drivers: (project: string) => ['vector', project, 'providers', 'drivers'] as const,
  driverForm: (project: string, driver: string) => ['vector', project, 'providers', 'drivers', driver, 'form'] as const,
  dashboard: (project: string, params: string) => ['vector', project, 'dashboard', params] as const,
  /** Every index list and every index detail. */
  indexes: (project: string) => ['vector', project, 'indexes'] as const,
  indexList: (project: string, providerKey: string) => ['vector', project, 'indexes', 'list', providerKey] as const,
  index: (project: string, providerKey: string, indexKey: string) =>
    ['vector', project, 'indexes', 'detail', providerKey, indexKey] as const,
  indexStats: (project: string, providerKey: string, indexKey: string, params: string) =>
    ['vector', project, 'indexes', 'detail', providerKey, indexKey, 'stats', params] as const,
  migrations: (project: string) => ['vector', project, 'migrations'] as const,
  migrationList: (project: string) => ['vector', project, 'migrations', 'list'] as const,
  migration: (project: string, key: string) => ['vector', project, 'migrations', 'detail', key] as const,
  migrationRunLogs: (project: string, key: string, attempt: number, offset: number) =>
    ['vector', project, 'migrations', 'detail', key, 'run-logs', attempt, offset] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const indexPath = (indexKey: string, providerKey: string, suffix = '') =>
  `/api/vector/indexes/${encodeURIComponent(indexKey)}${suffix}?providerKey=${encodeURIComponent(providerKey)}`;

const migrationPath = (key: string) => `/api/vector/migrations/${encodeURIComponent(key)}`;

async function fetchProviders(signal?: AbortSignal): Promise<VectorProviderView[]> {
  const data = await apiGet<{ providers?: VectorProviderView[] } | VectorProviderView[]>('/api/vector/providers', {
    signal,
  });
  return Array.isArray(data) ? data : (data.providers ?? []);
}

async function fetchProvidersWithIndexes(signal?: AbortSignal): Promise<VectorProvidersWithIndexes> {
  const data = await apiGet<{
    providers?: VectorProviderView[];
    indexesByProvider?: Record<string, VectorIndexView[]>;
  }>('/api/vector/providers?includeIndexes=true', { signal });
  const providers = data.providers ?? [];
  const indexesByProvider: Record<string, VectorIndexView[]> = {};
  Object.entries(data.indexesByProvider ?? {}).forEach(([key, value]) => {
    indexesByProvider[key] = [...value];
  });
  providers.forEach((provider) => {
    if (!indexesByProvider[provider.key]) indexesByProvider[provider.key] = [];
  });
  return { providers, indexesByProvider };
}

async function fetchIndexes(providerKey: string, signal?: AbortSignal): Promise<VectorIndexRecord[]> {
  const data = await apiGet<{ indexes?: VectorIndexRecord[] }>(
    `/api/vector/indexes?providerKey=${encodeURIComponent(providerKey)}`,
    { signal },
  );
  return data.indexes ?? [];
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** The project's vector providers (a form's picker reads this while it is open: pass `enabled`). */
export function useVectorProviders(enabled = true) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.providerList(project),
    queryFn: ({ signal }) => fetchProviders(signal),
    enabled,
    retry: retryUnlessClientError,
    // Providers are also created from other screens, so opening a picker always rereads them.
    staleTime: 0,
  });
}

/** Providers with all their indexes in one answer (the Vector index list). */
export function useVectorProvidersWithIndexes() {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.providersWithIndexes(project),
    queryFn: ({ signal }) => fetchProvidersWithIndexes(signal),
    retry: retryUnlessClientError,
    staleTime: 0,
    meta: { notifyOnError: 'Unable to load vector data' },
  });
}

/** The indexes of one provider. */
export function useVectorIndexes(providerKey: string | undefined, enabled = true) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.indexList(project, providerKey ?? ''),
    queryFn: ({ signal }) => fetchIndexes(providerKey as string, signal),
    enabled: enabled && Boolean(providerKey),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The indexes of several providers at once, each one best-effort (a failing provider yields no indexes). */
export function useVectorIndexesOfProviders(providerKeys: string[]) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: [...vectorKeys.indexes(project), 'by-providers', providerKeys] as const,
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(
        providerKeys.map(async (key) => {
          try {
            return [key, await fetchIndexes(key, signal)] as const;
          } catch {
            return [key, [] as VectorIndexRecord[]] as const;
          }
        }),
      );
      const map: Record<string, VectorIndexRecord[]> = {};
      entries.forEach(([key, indexes]) => {
        map[key] = indexes;
      });
      return map;
    },
    enabled: providerKeys.length > 0,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useVectorDashboard(params: URLSearchParams) {
  const [, project] = useResourceKey('vector');
  const search = params.toString();
  return useQuery({
    queryKey: vectorKeys.dashboard(project, search),
    queryFn: ({ signal }) => apiGet<VectorDashboardData>(`/api/vector/dashboard?${search}`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    // Changing the date range keeps the previous figures on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
}

export function useVectorIndex(providerKey: string | undefined, indexKey: string | undefined) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.index(project, providerKey ?? '', indexKey ?? ''),
    queryFn: async ({ signal }): Promise<VectorIndexDetail> => {
      const data = await apiGet<{ index?: VectorIndexView | null; provider?: VectorProviderView | null }>(
        indexPath(indexKey as string, providerKey as string),
        { signal },
      );
      return { index: data.index ?? null, provider: data.provider ?? null };
    },
    enabled: Boolean(providerKey && indexKey),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useVectorIndexStats<TStats>(
  providerKey: string | undefined,
  indexKey: string | undefined,
  params: URLSearchParams,
) {
  const [, project] = useResourceKey('vector');
  const search = params.toString();
  return useQuery({
    queryKey: vectorKeys.indexStats(project, providerKey ?? '', indexKey ?? '', search),
    queryFn: ({ signal }) =>
      apiGet<TStats>(`/api/vector/indexes/${encodeURIComponent(indexKey as string)}/stats?${search}`, { signal }),
    enabled: Boolean(providerKey && indexKey),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

export function useVectorDrivers(enabled: boolean) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.drivers(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ drivers?: ProviderDescriptor[] }>('/api/vector/providers/drivers', { signal })).drivers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useVectorDriverForm(driver: string, enabled: boolean) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.driverForm(project, driver),
    queryFn: async ({ signal }) =>
      (await apiGet<{ schema?: ProviderFormSchema | null }>(`/api/vector/providers/drivers/${driver}/form`, { signal }))
        .schema ?? null,
    enabled: enabled && Boolean(driver),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

const migrationIsActive = (migration: IVectorMigration | undefined) =>
  migration?.status === 'running' || migration?.status === 'queued';

/** The migrations; polls while one is queued or running. */
export function useVectorMigrations(pollMs: number) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.migrationList(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ migrations?: IVectorMigration[] }>('/api/vector/migrations', { signal })).migrations ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<IVectorMigration[]>((list) => Boolean(list?.some(migrationIsActive)), pollMs),
  });
}

/** One migration with its latest logs and runs; polls while it is queued or running. */
export function useVectorMigration(key: string, pollMs: number) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.migration(project, key),
    queryFn: ({ signal }) => apiGet<MigrationDetailResponse>(migrationPath(key), { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<MigrationDetailResponse>((detail) => migrationIsActive(detail?.migration), pollMs),
  });
}

/** The logs of one run of a migration, one page; `live` keeps rereading them (the open run is the running one). */
export function useVectorMigrationRunLogs(
  key: string,
  run: { attempt: number; offset: number } | null,
  limit: number,
  live: boolean,
  pollMs: number,
) {
  const [, project] = useResourceKey('vector');
  return useQuery({
    queryKey: vectorKeys.migrationRunLogs(project, key, run?.attempt ?? -1, run?.offset ?? 0),
    queryFn: ({ signal }) =>
      apiGet<MigrationDetailResponse>(
        `${migrationPath(key)}?attempt=${run?.attempt}&logsLimit=${limit}&logsOffset=${run?.offset ?? 0}`,
        { signal },
      ),
    enabled: run !== null,
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepPreviousData,
    ...pollingOptions<MigrationDetailResponse>(() => live, pollMs),
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useInvalidateVector() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return {
    providers: () => queryClient.invalidateQueries({ queryKey: vectorKeys.providers(project) }),
    indexes: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: vectorKeys.indexes(project) }),
        queryClient.invalidateQueries({ queryKey: vectorKeys.providers(project) }),
        queryClient.invalidateQueries({ queryKey: ['vector', project, 'dashboard'] }),
      ]),
    migrations: () => queryClient.invalidateQueries({ queryKey: vectorKeys.migrations(project) }),
  };
}

/** Adding a provider changes the provider lists and the dashboard counters. */
export function useCreateVectorProvider() {
  const invalidate = useInvalidateVector();
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (input: CreateProviderInput) =>
      (await apiPost<{ provider: VectorProviderView }>('/api/vector/providers', input)).provider,
    onSuccess: async () => {
      await Promise.all([
        invalidate.providers(),
        queryClient.invalidateQueries({ queryKey: ['vector', project, 'dashboard'] }),
      ]);
    },
  });
}

/** Creating or attaching an index changes the index lists, the provider lists (they carry indexes) and the dashboard. */
export function useCreateVectorIndex() {
  const invalidate = useInvalidateVector();
  return useMutation({
    mutationFn: (input: CreateIndexInput) => apiPost<{ index: VectorIndexView }>('/api/vector/indexes', input),
    onSuccess: () => invalidate.indexes(),
  });
}

export function useDeleteVectorIndex() {
  const invalidate = useInvalidateVector();
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ indexKey, providerKey }: { indexKey: string; providerKey: string }) =>
      apiDelete(indexPath(indexKey, providerKey)),
    onSuccess: async (_result, { indexKey, providerKey }) => {
      queryClient.removeQueries({ queryKey: vectorKeys.index(project, providerKey, indexKey) });
      await invalidate.indexes();
    },
  });
}

export function useUpdateVectorIndex() {
  const invalidate = useInvalidateVector();
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({
      indexKey,
      providerKey,
      name,
      metadata,
    }: {
      indexKey: string;
      providerKey: string;
      name: string;
      metadata: Record<string, unknown>;
    }) => (await apiPatch<{ index?: VectorIndexView | null }>(indexPath(indexKey, providerKey), { name, metadata })).index ?? null,
    onSuccess: async (index, { indexKey, providerKey }) => {
      queryClient.setQueryData<VectorIndexDetail>(vectorKeys.index(project, providerKey, indexKey), (current) => ({
        provider: current?.provider ?? null,
        index,
      }));
      await invalidate.indexes();
    },
  });
}

/** Querying an index is a read the user triggers with a button. */
export function useQueryVectorIndex() {
  return useMutation({
    mutationFn: async ({
      indexKey,
      providerKey,
      vector,
      topK,
      filter,
    }: {
      indexKey: string;
      providerKey: string;
      vector: number[];
      topK: number;
      filter?: Record<string, unknown>;
    }) =>
      (
        await apiPost<{ result?: VectorQueryResponse | null }>(indexPath(indexKey, providerKey, '/query'), {
          query: { vector, topK, filter },
        })
      ).result ?? null,
  });
}

export function useUpsertVectorItem() {
  const invalidate = useInvalidateVector();
  return useMutation({
    mutationFn: ({
      indexKey,
      providerKey,
      id,
      values,
      metadata,
    }: {
      indexKey: string;
      providerKey: string;
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }) => apiPost(indexPath(indexKey, providerKey, '/upsert'), { vectors: [{ id, values, metadata }] }),
    onSuccess: () => invalidate.indexes(),
  });
}

export function useDeleteVectorItem() {
  const invalidate = useInvalidateVector();
  return useMutation({
    mutationFn: ({ indexKey, providerKey, id }: { indexKey: string; providerKey: string; id: string }) =>
      apiDelete(indexPath(indexKey, providerKey, '/vectors'), { body: { ids: [id] } }),
    onSuccess: () => invalidate.indexes(),
  });
}

export function useCreateVectorMigration() {
  const invalidate = useInvalidateVector();
  return useMutation({
    mutationFn: async (input: CreateMigrationInput) =>
      (await apiPost<{ migration: IVectorMigration }>('/api/vector/migrations', input)).migration,
    onSuccess: () => invalidate.migrations(),
  });
}

export function useStartVectorMigration() {
  const invalidate = useInvalidateVector();
  return useMutation({
    mutationFn: (key: string) => apiPost(`${migrationPath(key)}/start`),
    onSuccess: () => invalidate.migrations(),
  });
}

export function useCancelVectorMigration() {
  const invalidate = useInvalidateVector();
  return useMutation({
    mutationFn: (key: string) => apiPost(`${migrationPath(key)}/cancel`),
    onSuccess: () => invalidate.migrations(),
  });
}

export function useDeleteVectorMigration() {
  const invalidate = useInvalidateVector();
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (key: string) => apiDelete(migrationPath(key)),
    onSuccess: async (_result, key) => {
      queryClient.removeQueries({ queryKey: vectorKeys.migration(project, key) });
      await invalidate.migrations();
    },
  });
}
