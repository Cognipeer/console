'use client';

/**
 * React Query hooks of the OCR Jobs dashboard.
 *
 * - Every key starts `['ocr-jobs', <project>, ...]` (`ocrJobsKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's jobs.
 * - A job's detail (the job and its items together) is polled while one of its documents is pending or running.
 * - Mutations invalidate what they change.
 *
 * The routes are the dashboard's `/api/ocr-jobs` plugin. Types and display helpers stay in
 * `src/app/dashboard/ocr-jobs/_lib/api.ts`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '@/lib/api/client';
import type {
  BucketOption,
  CreateOcrJobBody,
  ItemSourceDraft,
  OcrJobItemView,
  OcrJobView,
} from '@/app/dashboard/ocr-jobs/_lib/api';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

export interface OcrJobDetail {
  job: OcrJobView;
  items: OcrJobItemView[];
}

export const ocrJobsKeys = {
  all: ['ocr-jobs'] as const,
  project: (project: string) => ['ocr-jobs', project] as const,
  list: (project: string) => ['ocr-jobs', project, 'list'] as const,
  detail: (project: string, id: string) => ['ocr-jobs', project, 'detail', id] as const,
  buckets: (project: string) => ['ocr-jobs', project, 'lookup', 'buckets'] as const,
};

const jobPath = (id: string) => `/api/ocr-jobs/${id}`;

/** A job still has documents to process. */
const jobIsBusy = (job: OcrJobView) => job.itemsProcessed + job.itemsFailed < job.itemsTotal;

const itemIsOpen = (item: OcrJobItemView) => item.status === 'pending' || item.status === 'running';

export function useOcrJobs(pollMs: number) {
  const [, project] = useResourceKey('ocr-jobs');
  return useQuery({
    queryKey: ocrJobsKeys.list(project),
    queryFn: async ({ signal }) => (await apiGet<{ jobs?: OcrJobView[] }>('/api/ocr-jobs', { signal })).jobs ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<OcrJobView[]>((jobs) => Boolean(jobs?.some(jobIsBusy)), pollMs),
    meta: { notifyOnError: true },
  });
}

/** One job with its documents; polls while a document is pending or running. */
export function useOcrJob(id: string, pollMs: number) {
  const [, project] = useResourceKey('ocr-jobs');
  return useQuery({
    queryKey: ocrJobsKeys.detail(project, id),
    queryFn: async ({ signal }): Promise<OcrJobDetail> => {
      const [job, items] = await Promise.all([
        apiGet<{ job: OcrJobView }>(jobPath(id), { signal }),
        apiGet<{ items?: OcrJobItemView[] }>(`${jobPath(id)}/items`, { signal }),
      ]);
      return { job: job.job, items: items.items ?? [] };
    },
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<OcrJobDetail>((detail) => Boolean(detail?.items.some(itemIsOpen)), pollMs),
    meta: { notifyOnError: true },
  });
}

/** The storage buckets a job can read from, as picker options. */
export function useOcrBucketOptions(enabled = true) {
  const [, project] = useResourceKey('ocr-jobs');
  return useQuery({
    queryKey: ocrJobsKeys.buckets(project),
    queryFn: async ({ signal }): Promise<BucketOption[]> => {
      const data = await apiGet<{ buckets?: Array<{ key: string; name: string }> }>('/api/files/buckets', { signal });
      return (data.buckets ?? []).map((bucket) => ({ value: bucket.key, label: bucket.name }));
    },
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useCreateOcrJob() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (body: CreateOcrJobBody) => (await apiPost<{ job: OcrJobView }>('/api/ocr-jobs', body)).job,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ocrJobsKeys.list(project) }),
  });
}

export function useDeleteOcrJob() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete(jobPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: ocrJobsKeys.detail(project, id) });
      await queryClient.invalidateQueries({ queryKey: ocrJobsKeys.list(project) });
    },
  });
}

/** Sending documents changes the job's counters and its documents. */
export function useSendOcrJobFiles(id: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ items, mode = 'async' }: { items: ItemSourceDraft[]; mode?: 'sync' | 'async' }) =>
      (await apiPost<{ items?: OcrJobItemView[] }>(`${jobPath(id)}/files`, { items, mode })).items ?? [],
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ocrJobsKeys.detail(project, id) }),
        queryClient.invalidateQueries({ queryKey: ocrJobsKeys.list(project) }),
      ]),
  });
}

/** Pausing or resuming answers the updated job, which goes straight into the cached detail. */
export function useSetOcrJobPaused(id: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (pause: boolean) =>
      (await apiPost<{ job: OcrJobView }>(`${jobPath(id)}/${pause ? 'pause' : 'resume'}`)).job,
    onSuccess: async (job) => {
      queryClient.setQueryData<OcrJobDetail>(ocrJobsKeys.detail(project, id), (current) =>
        current ? { ...current, job } : current,
      );
      await queryClient.invalidateQueries({ queryKey: ocrJobsKeys.list(project) });
    },
  });
}
