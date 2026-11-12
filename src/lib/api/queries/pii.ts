'use client';

/**
 * React Query hooks of the PII service.
 *
 * - Every key starts `['pii', <project>, ...]` (`piiKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's policies.
 * - A key is a prefix of the keys below it: `detail(project, id)` reaches the policy.
 * - Mutations invalidate what they change (the list, the policy that was edited).
 *
 * The routes are the dashboard's `/api/pii` plugin (`src/server/api/plugins/pii.ts`).
 */

import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { PiiPolicyOption, PiiPolicyOptions } from '@/components/pii/piiProtectionForm';
import type { PiiCustomPatternForm } from '@/components/pii/PiiPolicyEditor';
import type { CategoryCatalogEntry, PiiAction, PiiEngine } from '@/lib/services/pii/types';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

/** A policy as the list route sends it. */
export interface PiiPolicyView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  defaultAction: PiiAction;
  categories: Record<string, boolean>;
  languages?: string[];
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** A policy as the detail route sends it. */
export interface PiiPolicyDetail {
  id: string;
  key: string;
  name: string;
  description?: string;
  defaultAction: PiiAction;
  /** Absent on any policy created before this field existed = 'regex'. */
  engine?: PiiEngine;
  categories: Record<string, boolean>;
  customPatterns?: PiiCustomPatternForm[];
  languages?: string[];
  enabled: boolean;
  detection?: { minConfidence?: number; contextBoost?: boolean };
}

export interface PiiCategoryCatalog {
  categories: CategoryCatalogEntry[];
  defaults: Record<string, boolean>;
}

export interface CreatePiiPolicyInput {
  name: string;
  description?: string;
  defaultAction: PiiAction;
  engine: PiiEngine;
  enabled: boolean;
}

/** The body of a policy edit: any of the policy's fields. */
export type UpdatePiiPolicyInput = Partial<Omit<PiiPolicyDetail, 'id' | 'key'>>;

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const piiKeys = {
  all: ['pii'] as const,
  project: (project: string) => ['pii', project] as const,
  list: (project: string) => ['pii', project, 'list'] as const,
  detail: (project: string, id: string) => ['pii', project, 'detail', id] as const,
  /** The built-in catalog is the same for every project: it depends on the locale and the engine only. */
  catalog: (project: string, locale: string, engine: PiiEngine) => ['pii', project, 'catalog', locale, engine] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const policyPath = (id: string) => `/api/pii/policies/${encodeURIComponent(id)}`;

const fetchPolicies = async <T = Record<string, unknown>>(signal?: AbortSignal): Promise<T[]> =>
  (await apiGet<{ policies?: T[] }>('/api/pii/policies', { signal })).policies ?? [];

const fetchPolicy = async (id: string, signal?: AbortSignal) =>
  (await apiGet<{ policy: PiiPolicyDetail }>(policyPath(id), { signal })).policy;

const fetchCatalog = async (locale: string, engine: PiiEngine, signal?: AbortSignal): Promise<PiiCategoryCatalog> => {
  const data = await apiGet<{ categories?: CategoryCatalogEntry[]; defaults?: Record<string, boolean> }>(
    `/api/pii/categories?locale=${encodeURIComponent(locale)}&engine=${engine}`,
    { signal },
  );
  return { categories: data.categories ?? [], defaults: data.defaults ?? {} };
};

/** A policy of the list as the protection pickers use it: enabled or not, and only the ones that have a key. */
function toPolicyOption(p: Record<string, unknown>): PiiPolicyOption {
  return {
    id: String(p.id ?? p._id ?? p.key),
    key: String(p.key),
    name: typeof p.name === 'string' && p.name ? p.name : String(p.key),
    enabled: p.enabled !== false,
    engine: typeof p.engine === 'string' ? (p.engine as PiiPolicyOption['engine']) : undefined,
  };
}

const toPolicyOptions = (rows: Array<Record<string, unknown>>): PiiPolicyOption[] =>
  rows.filter((p) => typeof p.key === 'string' && p.key).map(toPolicyOption);

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** `meta.notifyOnError` shows `loadErrorTitle` in a notification when the list fails to load. */
export function usePiiPolicyList(options: { loadErrorTitle?: string } = {}) {
  const [, project] = useResourceKey('pii');
  return useQuery({
    queryKey: piiKeys.list(project),
    queryFn: ({ signal }) => fetchPolicies<PiiPolicyView>(signal),
    retry: retryUnlessClientError,
    // A visit always rereads the policies.
    staleTime: 0,
    meta: options.loadErrorTitle ? { notifyOnError: options.loadErrorTitle } : undefined,
  });
}

/**
 * The project's PII policies, for the protection picker. Unfiltered on purpose: a policy switched off AFTER it was
 * chosen must still resolve to its name, and be flagged, instead of reading as deleted.
 */
export function usePiiPolicyOptions(enabled = true): PiiPolicyOptions {
  const [, project] = useResourceKey('pii');
  const query = useQuery({
    queryKey: piiKeys.list(project),
    queryFn: ({ signal }) => fetchPolicies(signal),
    select: toPolicyOptions,
    enabled,
    retry: retryUnlessClientError,
  });
  return useMemo(
    () => ({
      policies: query.data ?? [],
      loading: enabled && query.isPending,
      failed: query.isError,
    }),
    [query.data, query.isPending, query.isError, enabled],
  );
}

export function usePiiPolicy(id: string | undefined) {
  const [, project] = useResourceKey('pii');
  return useQuery({
    queryKey: piiKeys.detail(project, id ?? ''),
    queryFn: ({ signal }) => fetchPolicy(id as string, signal),
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    // The editor copies the policy into its form: always start from what the server has now.
    staleTime: 0,
  });
}

/** The category catalog of `engine` in `locale`; `engine` undefined waits. */
export function usePiiCatalog(locale: string, engine: PiiEngine | undefined) {
  const [, project] = useResourceKey('pii');
  return useQuery({
    queryKey: piiKeys.catalog(project, locale, engine ?? 'regex'),
    queryFn: ({ signal }) => fetchCatalog(locale, engine as PiiEngine, signal),
    enabled: Boolean(engine),
    retry: retryUnlessClientError,
    // Switching engines keeps the old catalog on screen until the new one is here.
    placeholderData: keepPreviousData,
  });
}

/** Reads (and caches) the catalog of an engine on demand: the editor does so when the person switches engines. */
export function useLoadPiiCatalog() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return (locale: string, engine: PiiEngine) =>
    queryClient.fetchQuery({
      queryKey: piiKeys.catalog(project, locale, engine),
      queryFn: ({ signal }) => fetchCatalog(locale, engine, signal),
    });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

export function useCreatePiiPolicy() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (input: CreatePiiPolicyInput) =>
      (await apiPost<{ policy: PiiPolicyView }>('/api/pii/policies', input)).policy,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: piiKeys.list(project) });
    },
  });
}

/**
 * Saving an edit changes the policy and the list. The policy is read again (not taken from the answer) so the
 * editor shows what the server stored.
 */
export function useUpdatePiiPolicy() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePiiPolicyInput & { id: string }) =>
      apiPatch<{ policy: PiiPolicyDetail }>(policyPath(id), input),
    onSuccess: async (_result, { id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: piiKeys.detail(project, id) }),
        queryClient.invalidateQueries({ queryKey: piiKeys.list(project) }),
      ]);
    },
  });
}

/**
 * Switching a policy on or off. Only the list is refreshed: a detail page that is open keeps the edits in its form
 * (it applies the switch to its own state).
 */
export function useTogglePiiPolicy() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiPatch<{ policy: PiiPolicyDetail }>(policyPath(id), { enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: piiKeys.list(project) });
    },
  });
}

export function useDeletePiiPolicy() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success?: boolean }>(policyPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: piiKeys.detail(project, id) });
      await queryClient.invalidateQueries({ queryKey: piiKeys.list(project) });
    },
  });
}

/**
 * A test run of a (possibly unsaved) policy draft against sample text: `op` is `detect`, `redact`, `mask` or
 * `tokenize`. Nothing is stored, so no cache is touched.
 */
export function usePiiScan<TResult>() {
  return useMutation({
    mutationFn: ({ op, body }: { op: string; body: Record<string, unknown> }) =>
      apiPost<TResult>(`/api/pii/${op}`, body),
  });
}
