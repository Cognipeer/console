'use client';

/**
 * React Query hooks of the Crawler dashboard.
 *
 * - Every key starts `['crawler', <project>, ...]` (`crawlerKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's crawlers.
 * - `jobs(project)` is a prefix of every job list and every job's results.
 * - Mutations invalidate what they change.
 *
 * The routes are the dashboard's `/api/crawler` plugin.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { CrawlJobView, CrawlResultPageView, CrawlResultView, CrawlerView } from '@/lib/services/crawler';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface CreateCrawlerInput {
  name: string;
  description?: string;
  seeds?: string[];
  engine: string;
  autoCrawl: boolean;
  maxDepth: number;
  maxPages: number;
}

export interface CrawlerResultsFilter {
  limit: number;
  skip: number;
  type?: string;
  ragStatus?: string;
  search?: string;
}

export interface SyncToRagSummary {
  indexed: number;
  skipped: number;
  failed: number;
  total: number;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const crawlerKeys = {
  all: ['crawler'] as const,
  project: (project: string) => ['crawler', project] as const,
  list: (project: string) => ['crawler', project, 'list'] as const,
  detail: (project: string, crawlerId: string) => ['crawler', project, 'detail', crawlerId] as const,
  /** Every job list and every job's results. */
  jobs: (project: string) => ['crawler', project, 'jobs'] as const,
  jobList: (project: string, crawlerKey: string) => ['crawler', project, 'jobs', 'list', crawlerKey] as const,
  jobResults: (project: string, jobId: string, filter: string, refreshKey: number) =>
    ['crawler', project, 'jobs', 'results', jobId, filter, refreshKey] as const,
  jobResult: (project: string, jobId: string, resultId: string, refreshKey: number) =>
    ['crawler', project, 'jobs', 'result', jobId, resultId, refreshKey] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const crawlerPath = (crawlerId: string) => `/api/crawler/crawlers/${crawlerId}`;

const resultsSearch = (filter: CrawlerResultsFilter) => {
  const params = new URLSearchParams({ limit: String(filter.limit), skip: String(filter.skip) });
  if (filter.type) params.set('type', filter.type);
  if (filter.ragStatus) params.set('ragStatus', filter.ragStatus);
  if (filter.search) params.set('search', filter.search);
  return params.toString();
};

const jobIsActive = (job: CrawlJobView) => job.status === 'queued' || job.status === 'running';

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function useCrawlers() {
  const [, project] = useResourceKey('crawler');
  return useQuery({
    queryKey: crawlerKeys.list(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ crawlers?: CrawlerView[] }>('/api/crawler/crawlers', { signal })).crawlers ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
    meta: { notifyOnError: 'Error' },
  });
}

/**
 * One crawler. Its screen copies the answer into forms, so the query never rereads on its own (no refocus,
 * no reconnect): only a visit and a save (which invalidate it) do.
 */
export function useCrawler(crawlerId: string) {
  const [, project] = useResourceKey('crawler');
  return useQuery({
    queryKey: crawlerKeys.detail(project, crawlerId),
    queryFn: async ({ signal }) => (await apiGet<{ crawler: CrawlerView }>(crawlerPath(crawlerId), { signal })).crawler,
    retry: retryUnlessClientError,
    staleTime: 0,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}

/** The latest jobs of one crawler (the last 50 of the project, narrowed to it); polls while one is queued or running. */
export function useCrawlJobs(crawlerKey: string | undefined, pollMs: number) {
  const [, project] = useResourceKey('crawler');
  return useQuery({
    queryKey: crawlerKeys.jobList(project, crawlerKey ?? ''),
    queryFn: async ({ signal }) => {
      const data = await apiGet<{ jobs?: CrawlJobView[] }>('/api/crawler/jobs?limit=50', { signal });
      return (data.jobs ?? []).filter((job) => job.crawlerKey === crawlerKey);
    },
    enabled: Boolean(crawlerKey),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<CrawlJobView[]>((jobs) => Boolean(jobs?.some(jobIsActive)), pollMs),
  });
}

/** One page of a job's results; the previous page stays while the next one loads. `refreshKey` forces a reread. */
export function useCrawlJobResults(jobId: string | undefined, filter: CrawlerResultsFilter, refreshKey: number) {
  const [, project] = useResourceKey('crawler');
  const search = resultsSearch(filter);
  return useQuery({
    queryKey: crawlerKeys.jobResults(project, jobId ?? '', search, refreshKey),
    queryFn: ({ signal }) =>
      apiGet<CrawlResultPageView>(`/api/crawler/jobs/${jobId}/results?${search}`, { signal }),
    enabled: Boolean(jobId),
    retry: retryUnlessClientError,
    placeholderData: keepPreviousData,
    // A running job keeps adding rows, so opening the list always rereads it.
    staleTime: 0,
  });
}

/** One result with its markdown body, read on demand. */
export function useCrawlJobResult(jobId: string | undefined, resultId: string | null, refreshKey: number) {
  const [, project] = useResourceKey('crawler');
  return useQuery({
    queryKey: crawlerKeys.jobResult(project, jobId ?? '', resultId ?? '', refreshKey),
    queryFn: async ({ signal }) =>
      (await apiGet<{ result: CrawlResultView }>(`/api/crawler/jobs/${jobId}/results/${resultId}`, { signal })).result,
    enabled: Boolean(jobId && resultId),
    retry: retryUnlessClientError,
    // A page body does not change once read; going back to a row shows it at once.
    staleTime: 60_000,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useInvalidateCrawler() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return {
    crawler: (crawlerId: string) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: crawlerKeys.detail(project, crawlerId) }),
        queryClient.invalidateQueries({ queryKey: crawlerKeys.list(project) }),
      ]),
    jobs: () => queryClient.invalidateQueries({ queryKey: crawlerKeys.jobs(project) }),
  };
}

/** Creating a crawler changes the list. */
export function useCreateCrawler() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (input: CreateCrawlerInput) =>
      (await apiPost<{ crawler: CrawlerView }>('/api/crawler/crawlers', input)).crawler,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: crawlerKeys.list(project) }),
  });
}

export function useDeleteCrawler() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (crawlerId: string) => apiDelete(crawlerPath(crawlerId)),
    onSuccess: async (_result, crawlerId) => {
      queryClient.removeQueries({ queryKey: crawlerKeys.detail(project, crawlerId) });
      await queryClient.invalidateQueries({ queryKey: crawlerKeys.list(project) });
    },
  });
}

/** Saving any panel of a crawler (plan, HTTP, integration, schedule) changes its detail and the list. */
export function useUpdateCrawler(crawlerId: string) {
  const invalidate = useInvalidateCrawler();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPatch(crawlerPath(crawlerId), body),
    onSuccess: () => invalidate.crawler(crawlerId),
  });
}

export function useAddCrawlerUrls(crawlerId: string) {
  const invalidate = useInvalidateCrawler();
  return useMutation({
    mutationFn: (urls: string[]) => apiPost(`${crawlerPath(crawlerId)}/urls`, { urls }),
    onSuccess: () => invalidate.crawler(crawlerId),
  });
}

export function useRemoveCrawlerUrls(crawlerId: string) {
  const invalidate = useInvalidateCrawler();
  return useMutation({
    mutationFn: (urls: string[]) => apiDelete(`${crawlerPath(crawlerId)}/urls`, { body: { urls } }),
    onSuccess: () => invalidate.crawler(crawlerId),
  });
}

/** Running the crawler queues a job. */
export function useRunCrawler(crawlerId: string) {
  const invalidate = useInvalidateCrawler();
  return useMutation({
    mutationFn: () => apiPost(`${crawlerPath(crawlerId)}/run`, {}),
    onSuccess: () => invalidate.jobs(),
  });
}

/** Crawling single URLs queues a job. */
export function useCrawlUrls(crawlerId: string) {
  const invalidate = useInvalidateCrawler();
  return useMutation({
    mutationFn: (urls: string[]) => apiPost(`${crawlerPath(crawlerId)}/crawl`, { urls }),
    onSuccess: () => invalidate.jobs(),
  });
}

export function useCancelCrawlJob() {
  const invalidate = useInvalidateCrawler();
  return useMutation({
    mutationFn: (jobId: string) => apiPost(`/api/crawler/jobs/${jobId}/cancel`, {}),
    onSuccess: () => invalidate.jobs(),
  });
}

export function useSyncCrawlJobToRag() {
  return useMutation({
    mutationFn: ({ jobId, ragModuleKey }: { jobId: string; ragModuleKey: string }) =>
      apiPost<SyncToRagSummary>(`/api/crawler/jobs/${jobId}/sync-to-rag`, { ragModuleKey }),
  });
}
