'use client';

/**
 * React Query hooks of the Web Search screens.
 *
 * - Every key starts `['websearch', <project>, ...]` (`websearchKeys`); `<project>` is the marker of
 *   `useResourceKey` (see `projectScope.ts`), so a project switch never shows the old project's instances.
 * - `detail(project, key)` reaches the page's subject (an instance, or a provider that has none yet) and its logs.
 *
 * The routes are the dashboard's `/api/websearch` plugin.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { WebSearchListRow } from '@/components/websearch/webSearchModel';
import type { IWebSearchRunLog } from '@/lib/database';
import type { ProviderDescriptor } from '@/lib/providers/types';
import type { WebSearchInstanceView } from '@/lib/services/webSearch/webSearchInstanceView';
import type { WebSearchResult } from '@/lib/services/webSearch/types';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

/**
 * What a detail page is about: an instance, or a provider that has no instance yet (the compatible read answers for
 * it; searches through its key use the provider's own settings).
 */
export type WebSearchTarget =
  | { kind: 'instance'; instance: WebSearchInstanceView }
  | { kind: 'provider'; provider: WebSearchListRow };

export interface WebSearchRunInput {
  query: string;
  /** A provider without an instance is searched through its own key. */
  instance?: string;
  provider?: string;
  count?: number;
  includeAnswer: boolean;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const websearchKeys = {
  all: ['websearch'] as const,
  project: (project: string) => ['websearch', project] as const,
  list: (project: string) => ['websearch', project, 'list'] as const,
  drivers: (project: string) => ['websearch', project, 'drivers'] as const,
  /** The page's subject and its logs. */
  detail: (project: string, key: string) => ['websearch', project, 'detail', key] as const,
  logs: (project: string, key: string, kind: string, from: string, to: string) =>
    ['websearch', project, 'detail', key, 'logs', kind, from, to] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const instancePath = (key: string) => `/api/websearch/instances/${encodeURIComponent(key)}`;

async function fetchTarget(key: string, signal?: AbortSignal): Promise<WebSearchTarget | null> {
  try {
    const { instance } = await apiGet<{ instance: WebSearchInstanceView }>(instancePath(key), { signal });
    return { kind: 'instance', instance };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  try {
    const body = await apiGet<{ provider: WebSearchListRow; instance?: WebSearchInstanceView }>(
      `/api/websearch/providers/${encodeURIComponent(key)}`,
      { signal },
    );
    return body.instance ? { kind: 'instance', instance: body.instance } : { kind: 'provider', provider: body.provider };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** The compatible list: the instances, then the providers whose key no instance has. A 403 reaches the screen as is. */
export function useWebSearchProviders() {
  const [, project] = useResourceKey('websearch');
  return useQuery({
    queryKey: websearchKeys.list(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ providers?: WebSearchListRow[] }>('/api/websearch/providers', { signal })).providers ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The web search drivers, for the provider form and an instance's options. */
export function useWebSearchDrivers(enabled: boolean) {
  const [, project] = useResourceKey('websearch');
  return useQuery({
    queryKey: websearchKeys.drivers(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ drivers?: ProviderDescriptor[] }>('/api/websearch/providers/drivers', { signal })).drivers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The subject of a detail page; `null` when neither an instance nor a provider has that key. */
export function useWebSearchTarget(key: string) {
  const [, project] = useResourceKey('websearch');
  return useQuery({
    queryKey: websearchKeys.detail(project, key),
    queryFn: ({ signal }) => fetchTarget(key, signal),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/**
 * The runs of the subject, newest first. An instance's runs are read through its own route; a provider without an
 * instance through the compatible one. `from` / `to` are ISO timestamps (or empty).
 */
export function useWebSearchLogs(key: string, kind: WebSearchTarget['kind'] | null, from: string, to: string, limit: number) {
  const [, project] = useResourceKey('websearch');
  return useQuery({
    queryKey: websearchKeys.logs(project, key, kind ?? '', from, to),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const base = kind === 'instance' ? '/api/websearch/instances' : '/api/websearch/providers';
      return (await apiGet<{ logs?: IWebSearchRunLog[] }>(`${base}/${encodeURIComponent(key)}/logs?${params.toString()}`, { signal }))
        .logs ?? [];
    },
    enabled: kind !== null,
    retry: retryUnlessClientError,
    // Every caller of the instance writes runs: a visit always reads them again.
    staleTime: 0,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useInvalidateWebSearch() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return (key?: string) =>
    queryClient.invalidateQueries({ queryKey: key ? websearchKeys.detail(project, key) : websearchKeys.project(project) });
}

/** `POST /api/websearch/instances`; answers the created instance. */
export function useCreateWebSearchInstance() {
  const invalidate = useInvalidateWebSearch();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiPost<{ instance: WebSearchInstanceView }>('/api/websearch/instances', body)).instance,
    onSuccess: () => invalidate(),
  });
}

/** `PATCH /api/websearch/instances/:key`; answers the saved instance. */
export function useUpdateWebSearchInstance() {
  const invalidate = useInvalidateWebSearch();
  return useMutation({
    mutationFn: async ({ key, body }: { key: string; body: Record<string, unknown> }) =>
      (await apiPatch<{ instance: WebSearchInstanceView }>(instancePath(key), body)).instance,
    onSuccess: () => invalidate(),
  });
}

export function useDeleteWebSearchInstance() {
  const invalidate = useInvalidateWebSearch();
  return useMutation({
    mutationFn: (key: string) => apiDelete<unknown>(instancePath(key)),
    onSuccess: () => invalidate(),
  });
}

/** A playground search; it adds a log row. */
export function useRunWebSearch() {
  const invalidate = useInvalidateWebSearch();
  return useMutation({
    mutationFn: async (input: WebSearchRunInput) =>
      (await apiPost<{ result: WebSearchResult }>('/api/websearch/search', input)).result,
    // A failed search is logged too.
    onSettled: () => invalidate(),
  });
}
