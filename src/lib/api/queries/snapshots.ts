'use client';

/**
 * React Query hooks of the Snapshot wizard (filter options, the PII category catalog, preview, create and the
 * background job's progress).
 *
 * - Every key starts `['snapshots', <project>, ...]` (`snapshotsKeys`); `<project>` is the marker of `useResourceKey`.
 * - Creating a snapshot makes a dataset: it invalidates the evaluation datasets of this project.
 * - The job is the dataset the queue fills in: `useSnapshotJob` polls it while it is pending or running.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

export interface SnapshotFilterOptions {
  gatewayModels?: string[];
  agents?: string[];
}

export interface SnapshotJobDataset {
  id?: string;
  key?: string;
  name?: string;
  metadata?: { snapshot?: Record<string, unknown> & { status?: string } };
}

export const snapshotsKeys = {
  all: ['snapshots'] as const,
  project: (project: string) => ['snapshots', project] as const,
  filters: (project: string) => ['snapshots', project, 'filters'] as const,
  piiCategories: (project: string, locale: string) => ['snapshots', project, 'pii-categories', locale] as const,
  job: (project: string, datasetId: string) => ['snapshots', project, 'job', datasetId] as const,
};

/** Agents seen by tracing and the gateway's model keys, for the filter dropdowns. A failure leaves them empty. */
export function useSnapshotFilters() {
  const [, project] = useResourceKey('snapshots');
  return useQuery({
    queryKey: snapshotsKeys.filters(project),
    queryFn: ({ signal }) => apiGet<SnapshotFilterOptions>('/api/snapshots/filters', { signal }),
    retry: retryUnlessClientError,
  });
}

/** The built-in PII categories with labels in `locale`. */
export function useSnapshotPiiCategories<TCategory>(locale: string) {
  const [, project] = useResourceKey('snapshots');
  return useQuery({
    queryKey: snapshotsKeys.piiCategories(project, locale),
    queryFn: async ({ signal }) =>
      (await apiGet<{ categories?: TCategory[] }>(`/api/pii/categories?locale=${encodeURIComponent(locale)}`, { signal }))
        .categories ?? [],
    retry: retryUnlessClientError,
  });
}

/** Counts only, no payloads. Nothing is cached: every preview is a fresh question. */
export function usePreviewSnapshot<TPreview>() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<TPreview>('/api/snapshots/preview', body),
  });
}

/** Starts the background job; the result carries the id of the dataset it fills. */
export function useCreateSnapshot() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<{ datasetId: string }>('/api/snapshots', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['evaluation', project] }),
  });
}

const isSettling = (dataset: SnapshotJobDataset | undefined) => {
  const status = dataset?.metadata?.snapshot?.status;
  return status !== 'ready' && status !== 'failed';
};

/** The dataset a snapshot job fills, read every 2.5 s while its status is not `ready` or `failed`. */
export function useSnapshotJob(datasetId: string | null, enabled: boolean) {
  const [, project] = useResourceKey('snapshots');
  return useQuery<SnapshotJobDataset | undefined, Error>({
    queryKey: snapshotsKeys.job(project, datasetId ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ dataset?: SnapshotJobDataset }>(`/api/evaluation/datasets/${datasetId}`, { signal })).dataset,
    enabled: Boolean(datasetId) && enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    ...pollingOptions<SnapshotJobDataset | undefined>(isSettling, 2500),
  });
}
