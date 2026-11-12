'use client';

/**
 * React Query hooks of the workspace's (tenant-scoped) providers: the list the Providers screen, the project
 * creation form and a project's providers tab read, the drivers of a domain, and the writes that follow.
 *
 * - Every key starts `['tenant-providers', <project>, ...]` (`tenantProvidersKeys`); `<project>` is the marker of
 *   `useResourceKey`.
 * - Providers are also written outside these hooks (their own screens), so the lists refetch on every visit.
 * - Every write reloads the whole `['tenant-providers', <project>]` prefix before it resolves.
 * - A read of the list answers 403 as data (`forbidden`): the caller may simply not read providers.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { ProviderDescriptor } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const tenantProvidersKeys = {
  all: ['tenant-providers'] as const,
  project: (project: string) => ['tenant-providers', project] as const,
  list: (project: string) => ['tenant-providers', project, 'list'] as const,
  /** The providers a project's tab shows: the tenant's when the caller may read them, else the project's own. */
  projectView: (project: string, projectId: string) => ['tenant-providers', project, 'project-view', projectId] as const,
  drivers: (project: string, domain: string) => ['tenant-providers', project, 'drivers', domain] as const,
  detail: (project: string, id: string) => ['tenant-providers', project, 'detail', id] as const,
};

const enc = encodeURIComponent;
const TENANT_LIST = '/api/providers?scope=tenant';

/* ── Queries ─────────────────────────────────────────────────────────────── */

export interface TenantProvidersData<TProvider> {
  providers: TProvider[];
  /** The caller may not read the tenant's providers (403). */
  forbidden: boolean;
}

/** The tenant's providers. `enabled` false reads nothing (a form that is closed). */
export function useTenantProviders<TProvider>(options: { enabled?: boolean } = {}) {
  const [, project] = useResourceKey('tenant-providers');
  return useQuery<TenantProvidersData<TProvider>, Error>({
    queryKey: tenantProvidersKeys.list(project),
    queryFn: async ({ signal }) => {
      try {
        const body = await apiGet<{ providers?: TProvider[] }>(TENANT_LIST, { signal });
        return { providers: body?.providers ?? [], forbidden: false };
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) return { providers: [], forbidden: true };
        throw error;
      }
    },
    enabled: options.enabled ?? true,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export interface ProjectProvidersData<TProvider> {
  providers: TProvider[];
  /** The list is the tenant's (providers can be assigned); false: only the project's own providers are shown. */
  tenantScope: boolean;
  /** The caller may not read providers at all. */
  forbidden: boolean;
}

/**
 * The providers of a project's tab: the tenant's when the caller may read them (`tenantScope`), else the ones the
 * project has; a caller who may read neither is `forbidden`.
 */
export function useProjectProviders<TProvider>(projectId: string) {
  const [, project] = useResourceKey('tenant-providers');
  return useQuery<ProjectProvidersData<TProvider>, Error>({
    queryKey: tenantProvidersKeys.projectView(project, projectId),
    queryFn: async ({ signal }) => {
      try {
        const body = await apiGet<{ providers?: TProvider[] }>(TENANT_LIST, { signal });
        return { providers: body?.providers ?? [], tenantScope: true, forbidden: false };
      } catch (error) {
        // Not allowed to read the tenant's providers (or not available): fall back to the project's own.
        if (!(error instanceof ApiError)) throw error;
      }
      try {
        const body = await apiGet<{ providers?: TProvider[] }>('/api/providers', { signal });
        return { providers: body?.providers ?? [], tenantScope: false, forbidden: false };
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) return { providers: [], tenantScope: false, forbidden: true };
        throw error;
      }
    },
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** How a failed read of the drivers says so: `true` a plain notification, a string one with that title, `false` silent. */
type NotifyDriversFailure = boolean | string;

function driversOptions(project: string, domain: string, notify: NotifyDriversFailure) {
  return {
    queryKey: tenantProvidersKeys.drivers(project, domain),
    queryFn: async ({ signal }: { signal?: AbortSignal }) =>
      (await apiGet<{ drivers?: ProviderDescriptor[] }>(`/api/providers/drivers?domain=${enc(domain)}`, { signal }))?.drivers ?? [],
    retry: retryUnlessClientError,
    meta: { notifyOnError: notify },
  };
}

/** The drivers a provider of `domain` can use; nothing is read while `domain` is null. A failed read says so (see `notify`). */
export function useProviderDrivers(domain: string | null, notify: NotifyDriversFailure = true) {
  const [, project] = useResourceKey('tenant-providers');
  return useQuery<ProviderDescriptor[], Error>({
    ...driversOptions(project, domain ?? '', notify),
    enabled: Boolean(domain),
  });
}

/** A function that loads the drivers of a domain into the cache and resolves when they are there (or failed: that says so). */
export function usePreloadProviderDrivers(notify: NotifyDriversFailure = true) {
  const queryClient = useQueryClient();
  const [, project] = useResourceKey('tenant-providers');
  return async (domain: string): Promise<void> => {
    await queryClient.fetchQuery(driversOptions(project, domain, notify)).catch(() => undefined);
  };
}

/** A function that reads one provider's full configuration (always fresh); rejects with the server's answer. */
export function useLoadTenantProvider() {
  const queryClient = useQueryClient();
  const [, project] = useResourceKey('tenant-providers');
  return (id: string): Promise<ProviderConfigView | undefined> =>
    queryClient.fetchQuery({
      queryKey: tenantProvidersKeys.detail(project, id),
      queryFn: async ({ signal }) =>
        (await apiGet<{ provider?: ProviderConfigView }>(`/api/providers/${enc(id)}?scope=tenant`, { signal }))?.provider,
      staleTime: 0,
    });
}

/** A function that puts a provider the caller just created into the cached list at once (when it is not in it yet). */
export function useAddTenantProviderToList<TProvider extends { _id: string }>() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return (provider: TProvider) => {
    queryClient.setQueryData<TenantProvidersData<TProvider>>(tenantProvidersKeys.list(project), (current) =>
      !current || current.providers.some((p) => p._id === provider._id)
        ? current
        : { ...current, providers: [...current.providers, provider] },
    );
  };
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useReloadTenantProviders() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: tenantProvidersKeys.project(project) });
}

export interface CreatedTenantProviderBody {
  provider?: { _id?: string; label?: string; key?: string; type?: string };
}

/** Creates a tenant provider; the answer is the raw body (the new provider is in it). */
export function useCreateTenantProvider() {
  const reload = useReloadTenantProviders();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<CreatedTenantProviderBody>(TENANT_LIST, body),
    onSuccess: () => reload(),
  });
}

/** Edits a tenant provider (its settings, or the projects it is assigned to). */
export function useUpdateTenantProvider() {
  const reload = useReloadTenantProviders();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiPatch<unknown>(`/api/providers/${enc(id)}?scope=tenant`, body),
    onSuccess: () => reload(),
  });
}
