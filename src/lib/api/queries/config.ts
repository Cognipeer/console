'use client';

/**
 * React Query hooks of Config (groups and items).
 *
 * - Every key starts `['config', <project>, ...]` (`configKeys`); `<project>` is the marker of `useResourceKey`.
 * - Every write invalidates the whole `['config', <project>]` prefix: the groups list, the items list, the group
 *   detail and the picker catalog all show the same rows.
 *
 * The routes are the dashboard's `/api/config` plugin.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface ConfigGroupRow {
  _id: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  updatedAt?: string;
  createdAt?: string;
}

export interface ConfigItemRow {
  _id: string;
  groupId: string;
  isSecret: boolean;
}

export interface ConfigItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  value: string;
  valueType: string;
  isSecret: boolean;
  tags?: string[];
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfigGroup {
  _id: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  items: ConfigItem[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfigGroupInput {
  name: string;
  key?: string;
  description?: string;
  tags?: string[];
}

export interface ConfigItemInput {
  name: string;
  key?: string;
  description?: string;
  value?: string;
  valueType?: string;
  isSecret?: boolean;
  tags?: string[];
}

export interface RawConfigGroup {
  _id?: string;
  id?: string;
  key: string;
  name: string;
  description?: string;
}

export interface RawConfigItem {
  _id?: string;
  id?: string;
  key: string;
  name: string;
  description?: string;
  groupId: string;
  isSecret?: boolean;
  valueType?: string;
  version?: number;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const configKeys = {
  all: ['config'] as const,
  project: (project: string) => ['config', project] as const,
  groups: (project: string) => ['config', project, 'groups'] as const,
  items: (project: string) => ['config', project, 'items'] as const,
  group: (project: string, id: string) => ['config', project, 'group', id] as const,
  /** Groups and items together, for the pickers that let a setting take its value from Config. */
  catalog: (project: string) => ['config', project, 'catalog'] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const fetchGroups = async (signal?: AbortSignal) =>
  (await apiGet<{ groups?: ConfigGroupRow[] }>('/api/config/groups', { signal })).groups ?? [];

const fetchItems = async (signal?: AbortSignal) =>
  (await apiGet<{ items?: ConfigItemRow[] }>('/api/config/items', { signal })).items ?? [];

const fetchGroup = async (id: string, signal?: AbortSignal) =>
  (await apiGet<{ group: ConfigGroup }>(`/api/config/groups/${id}`, { signal })).group;

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function useConfigGroups() {
  const [, project] = useResourceKey('config');
  return useQuery({
    queryKey: configKeys.groups(project),
    queryFn: ({ signal }) => fetchGroups(signal),
    retry: retryUnlessClientError,
    // Config is also written by the pickers of other screens, so a visit always refetches.
    staleTime: 0,
  });
}

export function useConfigItems() {
  const [, project] = useResourceKey('config');
  return useQuery({
    queryKey: configKeys.items(project),
    queryFn: ({ signal }) => fetchItems(signal),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** One group with its items. A 404 reaches the screen as an `ApiError` with `status` 404. */
export function useConfigGroup(id: string | undefined) {
  const [, project] = useResourceKey('config');
  return useQuery({
    queryKey: configKeys.group(project, id ?? ''),
    queryFn: ({ signal }) => fetchGroup(id as string, signal),
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The raw groups and items of the project: the picker catalog's source. A 403 reaches the picker as an `ApiError`. */
export function useConfigCatalogData(enabled: boolean) {
  const [, project] = useResourceKey('config');
  return useQuery({
    queryKey: configKeys.catalog(project),
    queryFn: async ({ signal }) => {
      const [groups, items] = await Promise.all([
        apiGet<{ groups?: RawConfigGroup[] }>('/api/config/groups', { signal }),
        apiGet<{ items?: RawConfigItem[] }>('/api/config/items', { signal }),
      ]);
      return { groups: groups?.groups ?? [], items: items?.items ?? [] };
    },
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Whether a failed catalog read was a refusal (403) rather than a failure. */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useInvalidateConfig() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: configKeys.project(project) });
}

export function useCreateConfigGroup() {
  const invalidate = useInvalidateConfig();
  return useMutation({
    mutationFn: (input: ConfigGroupInput) => apiPost<unknown>('/api/config/groups', input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateConfigGroup() {
  const invalidate = useInvalidateConfig();
  return useMutation({
    mutationFn: ({ id, ...input }: Omit<ConfigGroupInput, 'key'> & { id: string }) =>
      apiPatch<unknown>(`/api/config/groups/${id}`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteConfigGroup() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(`/api/config/groups/${id}`),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: configKeys.group(project, id) });
      await queryClient.invalidateQueries({ queryKey: configKeys.project(project) });
    },
  });
}

export function useCreateConfigItem() {
  const invalidate = useInvalidateConfig();
  return useMutation({
    mutationFn: ({ groupId, ...input }: ConfigItemInput & { groupId: string }) =>
      apiPost<unknown>(`/api/config/groups/${groupId}/items`, input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateConfigItem() {
  const invalidate = useInvalidateConfig();
  return useMutation({
    mutationFn: ({ id, ...input }: ConfigItemInput & { id: string }) =>
      apiPatch<unknown>(`/api/config/items/${id}`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteConfigItem() {
  const invalidate = useInvalidateConfig();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(`/api/config/items/${id}`),
    onSuccess: () => invalidate(),
  });
}
