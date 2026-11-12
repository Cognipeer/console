'use client';

/**
 * React Query hooks of the Memory dashboard.
 *
 * - Every key starts `['memory', <project>, ...]` (`memoryKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's stores.
 * - `store(project, key)` is a prefix of the store's detail and of its memory pages: invalidating it rereads both.
 * - Mutations invalidate what they change (the store list, the store's counters and its memory pages).
 *
 * The routes are the dashboard's `/api/memory` plugin.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '@/lib/api/client';
import type { MemoryScope } from '@/lib/database';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface MemoryStoreListItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  vectorProviderKey: string;
  embeddingModelKey: string;
  status: string;
  memoryCount: number;
  createdAt?: string;
  lastActivityAt?: string;
}

export interface MemoryStoreDetail extends MemoryStoreListItem {
  vectorIndexKey?: string;
}

export interface MemoryItem {
  _id: string;
  content: string;
  scope: MemoryScope;
  scopeId?: string;
  tags?: string[];
  importance?: number;
  source?: 'chat' | 'api' | 'agent' | 'manual';
  createdAt?: string;
}

export interface MemorySearchMatch {
  id: string;
  content: string;
  score: number;
  scope: MemoryScope;
  scopeId?: string;
  tags: string[];
  importance: number;
  source?: 'chat' | 'api' | 'agent' | 'manual';
  createdAt?: string;
}

export interface MemoryRecallResult {
  context: string;
  memories: MemorySearchMatch[];
  storeKey: string;
}

export interface MemoryScopeFilter {
  scope?: MemoryScope;
  scopeId?: string;
}

export interface MemoryPage {
  items: MemoryItem[];
  total: number;
}

export interface CreateMemoryStoreInput {
  name: string;
  description?: string;
  vectorProviderKey: string;
  embeddingModelKey: string;
  config: {
    deduplication: boolean;
    autoEmbed: boolean;
    defaultTopK: number;
    defaultMinScore: number;
  };
}

export interface CreatedMemoryStore {
  key: string;
  [field: string]: unknown;
}

export interface AddMemoryItemInput {
  content: string;
  importance: number;
  scope: MemoryScope;
  scopeId?: string;
  source: string;
  tags: string[];
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const memoryKeys = {
  all: ['memory'] as const,
  project: (project: string) => ['memory', project] as const,
  list: (project: string) => ['memory', project, 'list'] as const,
  /** The store, its detail and its memory pages. */
  store: (project: string, storeKey: string) => ['memory', project, 'store', storeKey] as const,
  detail: (project: string, storeKey: string) => ['memory', project, 'store', storeKey, 'detail'] as const,
  items: (project: string, storeKey: string, page: number, limit: number, filter: MemoryScopeFilter) =>
    ['memory', project, 'store', storeKey, 'items', page, limit, filter.scope ?? null, filter.scopeId ?? null] as const,
  itemsOfStore: (project: string, storeKey: string) => ['memory', project, 'store', storeKey, 'items'] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const storePath = (storeKey: string) => `/api/memory/stores/${storeKey}`;

function memoryFilterParams(params: URLSearchParams, filter: MemoryScopeFilter): void {
  if (filter.scope) params.set('scope', filter.scope);
  if (filter.scopeId) params.set('scopeId', filter.scopeId);
}

const fetchStores = async (signal?: AbortSignal) =>
  (await apiGet<{ stores?: MemoryStoreListItem[] }>('/api/memory/stores', { signal })).stores || [];

const fetchStore = (storeKey: string, signal?: AbortSignal) => apiGet<MemoryStoreDetail>(storePath(storeKey), { signal });

async function fetchMemoryPage(
  storeKey: string,
  page: number,
  limit: number,
  filter: MemoryScopeFilter,
  signal?: AbortSignal,
): Promise<MemoryPage> {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  memoryFilterParams(params, filter);
  const data = await apiGet<{ items?: MemoryItem[]; total?: number }>(
    `${storePath(storeKey)}/memories?${params.toString()}`,
    { signal },
  );
  return { items: data.items || [], total: data.total || 0 };
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function useMemoryStores() {
  const [, project] = useResourceKey('memory');
  return useQuery({
    queryKey: memoryKeys.list(project),
    queryFn: ({ signal }) => fetchStores(signal),
    retry: retryUnlessClientError,
    // Memory counts also change outside these hooks (agents write memories), so a visit always refetches.
    staleTime: 0,
  });
}

export function useMemoryStore(storeKey: string) {
  const [, project] = useResourceKey('memory');
  return useQuery({
    queryKey: memoryKeys.detail(project, storeKey),
    queryFn: ({ signal }) => fetchStore(storeKey, signal),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** One page of a store's memories; the previous page stays on screen while the next one loads. */
export function useMemoryItems(storeKey: string, page: number, limit: number, filter: MemoryScopeFilter) {
  const [, project] = useResourceKey('memory');
  return useQuery({
    queryKey: memoryKeys.items(project, storeKey, page, limit, filter),
    queryFn: ({ signal }) => fetchMemoryPage(storeKey, page, limit, filter, signal),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/** Semantic search inside a store (a read the user triggers by pressing search). */
export function useSearchMemories(storeKey: string) {
  return useMutation({
    mutationFn: async ({ query, limit, filter }: { query: string; limit: number; filter: MemoryScopeFilter }) => {
      const params = new URLSearchParams();
      params.set('query', query);
      params.set('limit', String(limit));
      memoryFilterParams(params, filter);
      return (await apiGet<{ memories?: MemorySearchMatch[] }>(`${storePath(storeKey)}/memories?${params.toString()}`))
        .memories || [];
    },
  });
}

export function useRecallMemories(storeKey: string) {
  return useMutation({
    mutationFn: (body: { maxTokens: number; query: string; scope?: MemoryScope; scopeId?: string; topK: number }) =>
      apiPost<MemoryRecallResult>(`${storePath(storeKey)}/recall`, body),
  });
}

/** Creating a store changes the store list. */
export function useCreateMemoryStore() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (input: CreateMemoryStoreInput) => apiPost<CreatedMemoryStore | null>('/api/memory/stores', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryKeys.list(project) }),
  });
}

export function useDeleteMemoryStore(storeKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: () => apiDelete(storePath(storeKey)),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: memoryKeys.store(project, storeKey) });
      await queryClient.invalidateQueries({ queryKey: memoryKeys.list(project) });
    },
  });
}

/** Adding, deleting or clearing memories changes the store's counter and its memory pages. */
function useInvalidateStoreMemories(storeKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: memoryKeys.store(project, storeKey) }),
      queryClient.invalidateQueries({ queryKey: memoryKeys.list(project) }),
    ]);
}

export function useAddMemoryItem(storeKey: string) {
  const invalidate = useInvalidateStoreMemories(storeKey);
  return useMutation({
    mutationFn: (input: AddMemoryItemInput) => apiPost(`${storePath(storeKey)}/memories`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteMemoryItem(storeKey: string) {
  const invalidate = useInvalidateStoreMemories(storeKey);
  return useMutation({
    mutationFn: (memoryId: string) => apiDelete(`${storePath(storeKey)}/memories/${memoryId}`),
    onSuccess: invalidate,
  });
}

export function useClearMemoryContext(storeKey: string) {
  const invalidate = useInvalidateStoreMemories(storeKey);
  return useMutation({
    mutationFn: (filter: MemoryScopeFilter) => {
      const params = new URLSearchParams();
      memoryFilterParams(params, filter);
      return apiDelete(`${storePath(storeKey)}/memories?${params.toString()}`);
    },
    onSuccess: invalidate,
  });
}
