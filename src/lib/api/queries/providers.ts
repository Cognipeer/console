'use client';

/**
 * React Query hooks of the provider screens (the provider detail page, its forms and the assignment step).
 *
 * - Every key starts `['providers', <project>, ...]` (`providersKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's providers.
 * - Saving a provider invalidates the whole `['providers', <project>]` branch: the record, its usage and the project
 *   lists all describe the same assignment. Deleting one does the same except for the deleted record's own queries.
 *
 * The routes are the dashboard's `/api/providers` plugin.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { mergeProjectIds } from '@/components/models/catalog/platformProviders';
import type { AccessProject, ProviderUsageEntry } from '@/components/providers/providerAccessModel';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const providersKeys = {
  all: ['providers'] as const,
  project: (project: string) => ['providers', project] as const,
  detail: (project: string, id: string) => ['providers', project, 'detail', id] as const,
  usage: (project: string, id: string) => ['providers', project, 'detail', id, 'usage'] as const,
  drivers: (project: string, domain: string) => ['providers', project, 'drivers', domain] as const,
  driverForm: (project: string, driver: string) => ['providers', project, 'driver-form', driver] as const,
  tenantProjects: (project: string) => ['providers', project, 'tenant-projects'] as const,
  ofType: (project: string, type: string) => ['providers', project, 'of-type', type] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const providerPath = (id: string) => `/api/providers/${encodeURIComponent(id)}?scope=tenant`;

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** One provider record. `T` is the record shape the screen reads. */
export function useProvider<T>(id: string | undefined) {
  const [, project] = useResourceKey('providers');
  return useQuery({
    queryKey: providersKeys.detail(project, id ?? ''),
    queryFn: async ({ signal }) => {
      const data = await apiGet<{ provider?: T }>(providerPath(id as string), { signal });
      if (!data.provider) throw new Error('Provider not found');
      return data.provider;
    },
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    meta: { notifyOnError: 'Provider' },
    staleTime: 0,
  });
}

/** `GET /api/providers/:id/usage`: every tenant project, with what uses the provider in it. */
export function useProviderUsageQuery(id: string | undefined) {
  const [, project] = useResourceKey('providers');
  return useQuery({
    queryKey: providersKeys.usage(project, id ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ projects?: ProviderUsageEntry[] }>(`/api/providers/${encodeURIComponent(id as string)}/usage`, { signal }))
        .projects ?? [],
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useProviderDrivers<T>(domain: string | undefined, enabled: boolean) {
  const [, project] = useResourceKey('providers');
  return useQuery({
    queryKey: providersKeys.drivers(project, domain ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ drivers?: T[] }>(`/api/providers/drivers?domain=${encodeURIComponent(domain as string)}`, { signal })).drivers ?? [],
    enabled: enabled && Boolean(domain),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useProviderDriverForm<T>(driver: string, enabled: boolean) {
  const [, project] = useResourceKey('providers');
  return useQuery({
    queryKey: providersKeys.driverForm(project, driver),
    queryFn: async ({ signal }) =>
      (await apiGet<{ schema?: T | null }>(`/api/providers/drivers/${driver}/form`, { signal })).schema ?? null,
    enabled: enabled && Boolean(driver),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The tenant's projects with their per-domain provider counts (`GET /api/projects?include=stats`). */
export function useTenantProjectsQuery(enabled: boolean) {
  const [, project] = useResourceKey('providers');
  return useQuery({
    queryKey: providersKeys.tenantProjects(project),
    queryFn: ({ signal }) =>
      apiGet<{ projects?: AccessProject[]; activeProjectId?: string }>('/api/projects?include=stats', { signal }),
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The providers of one domain (`GET /api/providers?type=`), as the project sees them. */
export function useProvidersOfType<T>(type: string, enabled: boolean) {
  const [, project] = useResourceKey('providers');
  return useQuery({
    queryKey: providersKeys.ofType(project, type),
    queryFn: async ({ signal }) =>
      (await apiGet<{ providers?: T[] }>(`/api/providers?type=${encodeURIComponent(type)}`, { signal })).providers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useInvalidateProviders() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: providersKeys.project(project) });
}

/** `POST /api/providers?scope=tenant`; answers the created provider. */
export function useCreateProvider() {
  const invalidate = useInvalidateProviders();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiPost<{ provider?: { _id?: string; key?: string; label?: string } }>('/api/providers?scope=tenant', body)).provider,
    onSuccess: () => invalidate(),
  });
}

/** `PATCH /api/providers/:id` (an edit, or the assignment to projects). */
export function useUpdateProvider() {
  const invalidate = useInvalidateProviders();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiPatch<{ provider?: unknown }>(providerPath(id), body),
    onSuccess: () => invalidate(),
  });
}

/**
 * `DELETE /api/providers/:id`. The deleted record's own queries (the record and its usage) are left alone: the page
 * still has them mounted, and reading a deleted record again would answer 404 before the page navigates away.
 */
export function useDeleteProvider() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(providerPath(id)),
    onSuccess: (_result, id) =>
      queryClient.invalidateQueries({
        queryKey: providersKeys.project(project),
        predicate: (query) => {
          const key = query.queryKey;
          return !(key[2] === 'detail' && key[3] === id);
        },
      }),
  });
}

/**
 * A connection test. With a saved provider's id it goes through the provider's own route (what is typed is laid
 * over what is stored, nothing is saved); without one the draft is tested as given.
 */
export function useTestProvider<T>() {
  const invalidate = useInvalidateProviders();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body?: Record<string, unknown> }) =>
      id ? apiPost<T>(`/api/providers/${encodeURIComponent(id)}/test`, body) : apiPost<T>('/api/providers/test', body),
    // A stored test result changes what the record shows.
    onSuccess: (_result, { id }) => (id ? invalidate() : undefined),
  });
}

/** Makes another project the active one (a cookie the whole shell reads). */
export function useSwitchActiveProject() {
  return useMutation({
    mutationFn: (projectId: string) => apiPost<unknown>('/api/projects/active', { projectId }),
  });
}

/**
 * "Use in this project": adds the active project to the provider's projects. The provider's projects are read
 * again so a change made meanwhile is not overwritten; the record at hand is the fallback when that read fails.
 */
export function useAssignProviderToActiveProject() {
  const invalidate = useInvalidateProviders();
  return useMutation({
    mutationFn: async ({
      provider,
      failedMessage,
    }: {
      provider: { _id?: unknown; projectId?: unknown; projectIds?: unknown };
      failedMessage: string;
    }) => {
      const projects = await apiGet<{ activeProjectId?: string }>('/api/projects').catch(() => null);
      const activeProjectId = projects?.activeProjectId;
      if (!activeProjectId) throw new Error(failedMessage);

      let current: { projectId?: unknown; projectIds?: unknown } = provider;
      try {
        const list = await apiGet<{
          providers?: Array<{ _id?: unknown; projectId?: unknown; projectIds?: unknown }>;
        }>('/api/providers?scope=tenant');
        const fresh = list.providers?.find((entry) => String(entry._id) === String(provider._id));
        if (fresh) current = fresh;
      } catch {
        // keep the record at hand
      }

      return apiPatch<unknown>(providerPath(String(provider._id)), {
        projectIds: mergeProjectIds(current, activeProjectId),
      });
    },
    onSuccess: () => invalidate(),
  });
}
