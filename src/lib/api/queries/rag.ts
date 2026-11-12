'use client';

/**
 * React Query hooks of the Knowledge Engine (RAG) dashboard.
 *
 * - Every key starts `['rag', <project>, ...]` (`ragKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's modules.
 * - `module(project, key)` is a prefix of the module's detail, re-index runs and documents: invalidating it rereads all.
 * - Mutations invalidate what they change.
 *
 * Besides the module hooks this file holds the small lookups (models, rerankers) that the RAG and Memory forms
 * offer in their pickers.
 *
 * The routes are the dashboard's `/api/rag` plugin.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { IRagChunkConfig } from '@/lib/database';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';
import type { OcrSettings } from '@/components/extraction/ocrForm';
import type { ScoreBucket } from '@/components/rag/ScoreDistributionChart';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface RagModuleListItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  chunkConfig: {
    strategy: string;
    chunkSize: number;
    chunkOverlap: number;
  };
  status: string;
  /** Stored vectors no longer match the module's chunking or embedding model. */
  reindexRequired?: boolean;
  totalDocuments?: number;
  totalChunks?: number;
  createdAt?: string;
}

export interface RagModuleView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  fileBucketKey?: string;
  fileProviderKey?: string;
  chunkConfig: IRagChunkConfig;
  extraction?: { ocr?: OcrSettings | null } | null;
  /** Document-level access control; absent or null = off. */
  access?: { enabled: boolean; adminBypass?: boolean } | null;
  status: string;
  hybrid?: { enabled: boolean; mode?: 'rrf' | 'weighted'; alpha?: number; k?: number } | null;
  isolateByModule?: boolean | null;
  reindexRequired?: boolean;
  rerankerKey?: string | null;
  rerankerOversample?: number | null;
  defaultTopK?: number | null;
  defaultMinScore?: number | null;
  defaultFilter?: Record<string, unknown> | null;
  filterableFields?: string[] | null;
  responseDetail?: 'full' | 'text' | null;
  totalDocuments?: number;
  totalChunks?: number;
  createdAt?: string;
  updatedAt?: string;
  lastReindexAt?: string;
}

export interface RagDocumentView {
  _id: string;
  ragModuleKey: string;
  fileKey?: string;
  fileName: string;
  status: string;
  chunkCount?: number;
  errorMessage?: string;
  lastIndexedAt?: string;
  createdAt?: string;
  /** The folder the document sits in; absent = the top level. */
  folderId?: string;
  /** The document has permissions of its own (absent = it follows its folder). */
  aclMode?: 'own';
  /** A connected source owns the document's folder and permissions. */
  aclManaged?: 'sync';
  /** How the text was read (OCR pages) and, while the file is still being read, where that stands. */
  extraction?: {
    sourceType?: string;
    pageCount?: number;
    ocrPages?: number;
    ocrImages?: number;
    stage?: 'queued' | 'running';
    progress?: { completed: number; total: number };
    warnings?: string[];
  };
}


/**
 * A match as the query endpoint returns it — not as the service produced it.
 * A module set to `responseDetail: 'text'` has every field but `content`
 * stripped by shapeRagQueryResponse, so nothing here may be assumed present.
 */
export interface RagQueryMatch {
  id?: string;
  score?: number;
  content?: string;
  fileName?: string;
  chunkIndex?: number;
  metadata?: Record<string, unknown>;
}

export interface RagQueryResult {
  matches: RagQueryMatch[];
  query: string;
  latencyMs: number;
}

export interface RagQueryLogView {
  _id: string;
  query: string;
  topK: number;
  matchCount: number;
  /** Matches the store returned before the minScore filter, when it was recorded. */
  preFilterMatchCount?: number;
  topScore?: number;
  minScoreApplied?: number;
  /** Absent on logs written before latency was recorded. */
  latencyMs?: number;
  createdAt?: string;
}

export interface UsageTotals {
  total: number;
  avgLatencyMs: number;
  zeroMatchCount: number;
  minScoreFilteredCount: number;
}


/** One page of a module's documents. */
export interface RagDocumentPage {
  documents: RagDocumentView[];
  total: number;
}

export interface RagDocumentsFilter {
  limit: number;
  offset: number;
  search?: string;
  status?: string;
  folderId?: string;
}

export interface RagUsage {
  logs: RagQueryLogView[];
  scope: 'all' | 'own';
  totals: UsageTotals | null;
}

export interface RagInsights {
  buckets: ScoreBucket[];
  zeroQueries: RagQueryLogView[];
  zeroQueriesScope: 'all' | 'own';
}

export interface RagQueryInput {
  query: string;
  topK: number;
  minScore?: number;
  filter?: Record<string, unknown>;
}

/** An entry of `GET /api/models?category=...` as the pickers read it. */
export interface ModelLookup {
  key: string;
  name?: string;
  modelId?: string;
}

export interface RerankerLookup {
  key: string;
  name: string;
}

export type RagReindexReasonInput = 'chunk-config' | 'embedding-model' | 'manual';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const ragKeys = {
  all: ['rag'] as const,
  project: (project: string) => ['rag', project] as const,
  list: (project: string) => ['rag', project, 'list'] as const,
  /** The module, its re-index runs and everything else read about it. */
  module: (project: string, key: string) => ['rag', project, 'module', key] as const,
  detail: (project: string, key: string) => ['rag', project, 'module', key, 'detail'] as const,
  reindexRuns: (project: string, key: string) => ['rag', project, 'module', key, 'reindex'] as const,
  /** Every page of the module's documents, in every place. */
  documents: (project: string, key: string) => ['rag', project, 'module', key, 'documents'] as const,
  documentPage: (project: string, key: string, location: string, filter: RagDocumentsFilter) =>
    ['rag', project, 'module', key, 'documents', location, filter] as const,
  usage: (project: string, key: string) => ['rag', project, 'module', key, 'usage'] as const,
  insights: (project: string, key: string) => ['rag', project, 'module', key, 'insights'] as const,
  models: (project: string, category: string) => ['rag', project, 'lookup', 'models', category] as const,
  rerankers: (project: string) => ['rag', project, 'lookup', 'rerankers'] as const,
  moduleOptions: (project: string, status: string) => ['rag', project, 'lookup', 'modules', status] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

export const ragModulePath = (key: string) => `/api/rag/modules/${encodeURIComponent(key)}`;

/* ── Queries ─────────────────────────────────────────────────────────────── */

export function useRagModules() {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.list(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ modules?: RagModuleListItem[] }>('/api/rag/modules', { signal })).modules ?? [],
    retry: retryUnlessClientError,
    // Modules are also created and changed from other screens (the agent studio, the crawler), so a visit refetches.
    staleTime: 0,
    meta: { notifyOnError: 'Unable to load Knowledge Engine modules' },
  });
}

/** The models of one category (`embedding`, `llm`, ...) for a picker; pass `enabled` to read only while it is open. */
export function useModelsByCategory(category: string, enabled = true) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.models(project, category),
    queryFn: async ({ signal }): Promise<ModelLookup[]> => {
      const data = await apiGet<{ models?: ModelLookup[] } | ModelLookup[]>(
        `/api/models?category=${encodeURIComponent(category)}`,
        { signal },
      );
      return Array.isArray(data) ? data : (data.models ?? []);
    },
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useActiveRerankers(enabled = true) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.rerankers(project),
    queryFn: async ({ signal }): Promise<RerankerLookup[]> =>
      (await apiGet<{ rerankers?: RerankerLookup[] }>('/api/reranker?status=active', { signal })).rerankers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Key and name of the modules with `status` (a picker such as the crawler's "send to Knowledge Engine" choice). */
export function useRagModuleOptions(status: string) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.moduleOptions(project, status),
    queryFn: async ({ signal }): Promise<Array<{ key: string; name: string }>> => {
      const data = await apiGet<{ modules?: Array<{ key: string; name: string }> }>(
        `/api/rag/modules?status=${encodeURIComponent(status)}`,
        { signal },
      );
      return (data.modules ?? []).map((m) => ({ key: m.key, name: m.name }));
    },
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** One module (the detail page). `null` while it does not exist. */
export function useRagModule(moduleKey: string | undefined) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.detail(project, moduleKey ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ module?: RagModuleView | null }>(ragModulePath(moduleKey as string), { signal })).module ?? null,
    enabled: Boolean(moduleKey),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

const documentIsSettling = (doc: RagDocumentView) =>
  doc.status === 'pending' || doc.status === 'processing' || Boolean(doc.extraction?.stage);

/**
 * One page of the module's documents in one place (`location`: a folder id, `root`, or `*` for every folder).
 * A document sits in `pending`/`processing` until its ingest job finishes, so the page is reread every `pollMs`
 * while one does. Moving to another page of the same place keeps the rows; moving to another place does not.
 */
export function useRagDocuments(
  moduleKey: string | undefined,
  location: string,
  filter: RagDocumentsFilter,
  pollMs: number,
) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.documentPage(project, moduleKey ?? '', location, filter),
    queryFn: async ({ signal }): Promise<RagDocumentPage> => {
      const params = new URLSearchParams({ limit: String(filter.limit), offset: String(filter.offset) });
      if (filter.search) params.set('search', filter.search);
      if (filter.status) params.set('status', filter.status);
      if (filter.folderId) params.set('folderId', filter.folderId);
      const data = await apiGet<{ documents?: RagDocumentView[]; total?: number }>(
        `${ragModulePath(moduleKey as string)}/documents?${params.toString()}`,
        { signal },
      );
      const documents = data.documents ?? [];
      return { documents, total: typeof data.total === 'number' ? data.total : documents.length };
    },
    enabled: Boolean(moduleKey),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery && previousQuery.queryKey[5] === location ? previous : undefined,
    ...pollingOptions<RagDocumentPage>((page) => Boolean(page?.documents.some(documentIsSettling)), pollMs),
  });
}

/** The module's latest queries and their totals. */
export function useRagUsage(moduleKey: string | undefined) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.usage(project, moduleKey ?? ''),
    queryFn: async ({ signal }): Promise<RagUsage> => {
      const data = await apiGet<{
        logs?: RagQueryLogView[];
        scope?: string;
        total?: number;
        avgLatencyMs?: number;
        zeroMatchCount?: number;
        minScoreFilteredCount?: number;
      }>(`${ragModulePath(moduleKey as string)}/usage?limit=50`, { signal });
      return {
        logs: data.logs ?? [],
        scope: data.scope === 'own' ? 'own' : 'all',
        totals:
          typeof data.total === 'number' && typeof data.avgLatencyMs === 'number'
            ? {
              total: data.total,
              avgLatencyMs: data.avgLatencyMs,
              zeroMatchCount: data.zeroMatchCount ?? 0,
              minScoreFilteredCount: data.minScoreFilteredCount ?? 0,
            }
            : null,
      };
    },
    enabled: Boolean(moduleKey),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The score distribution and the queries that found nothing. */
export function useRagInsights(moduleKey: string | undefined) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.insights(project, moduleKey ?? ''),
    queryFn: async ({ signal }): Promise<RagInsights> => {
      const base = ragModulePath(moduleKey as string);
      const [distribution, zero] = await Promise.all([
        apiGet<{ buckets?: ScoreBucket[] }>(`${base}/score-distribution`, { signal }),
        apiGet<{ logs?: RagQueryLogView[]; scope?: string }>(`${base}/queries?zeroOnly=true&limit=25`, { signal }),
      ]);
      return {
        buckets: distribution.buckets ?? [],
        zeroQueries: zero.logs ?? [],
        zeroQueriesScope: zero.scope === 'own' ? 'own' : 'all',
      };
    },
    enabled: Boolean(moduleKey),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

const reindexRunIsActive = (run: IRagReindexRun) =>
  run.status === 'pending' || run.status === 'queued' || run.status === 'running';

/** The module's re-index runs, newest first; reread every `pollMs` while one is not finished. */
export function useRagReindexRuns(moduleKey: string | undefined, pollMs: number) {
  const [, project] = useResourceKey('rag');
  return useQuery({
    queryKey: ragKeys.reindexRuns(project, moduleKey ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ runs?: IRagReindexRun[] }>(`${ragModulePath(moduleKey as string)}/reindex`, { signal })).runs ??
      [],
    enabled: Boolean(moduleKey),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<IRagReindexRun[]>((runs) => Boolean(runs?.some(reindexRunIsActive)), pollMs),
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/** Creating a module changes the list. */
export function useCreateRagModule() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiPost<{ module: Record<string, unknown> }>('/api/rag/modules', body)).module,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ragKeys.list(project) }),
  });
}

/** Saving a module changes its detail and the list. */
export function useUpdateRagModule(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiPatch<{ module: RagModuleView }>(ragModulePath(moduleKey), body)).module,
    onSuccess: (updated) => {
      queryClient.setQueryData(ragKeys.detail(project, moduleKey), updated);
      return queryClient.invalidateQueries({ queryKey: ragKeys.list(project) });
    },
  });
}

export function useDeleteRagModule() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (key: string) => apiDelete(ragModulePath(key)),
    onSuccess: async (_result, key) => {
      queryClient.removeQueries({ queryKey: ragKeys.module(project, key) });
      await queryClient.invalidateQueries({ queryKey: ragKeys.list(project) });
    },
  });
}

/** Starting a run changes the runs, the module (`reindexRequired`) and the list. */
export function useStartRagReindex(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (reason?: RagReindexReasonInput) =>
      apiPost(`${ragModulePath(moduleKey)}/reindex`, reason ? { reason } : undefined),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ragKeys.reindexRuns(project, moduleKey) }),
        queryClient.invalidateQueries({ queryKey: ragKeys.detail(project, moduleKey) }),
        queryClient.invalidateQueries({ queryKey: ragKeys.list(project) }),
      ]),
  });
}

export function useCancelRagReindex(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (runKey: string) => apiPost(`${ragModulePath(moduleKey)}/reindex/${encodeURIComponent(runKey)}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ragKeys.reindexRuns(project, moduleKey) }),
  });
}

function useInvalidateModuleDocuments(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ragKeys.documents(project, moduleKey) }),
      queryClient.invalidateQueries({ queryKey: ragKeys.detail(project, moduleKey) }),
      queryClient.invalidateQueries({ queryKey: ragKeys.list(project) }),
    ]);
}

/** Ingesting text or a file (a data URL) adds a document: the pages and the module's counters are read again. */
export function useIngestRagDocument(moduleKey: string) {
  const invalidate = useInvalidateModuleDocuments(moduleKey);
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost(`${ragModulePath(moduleKey)}/documents`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteRagDocument(moduleKey: string) {
  const invalidate = useInvalidateModuleDocuments(moduleKey);
  return useMutation({
    mutationFn: (documentId: string) => apiDelete(`${ragModulePath(moduleKey)}/documents/${encodeURIComponent(documentId)}`),
    onSuccess: invalidate,
  });
}

/** Re-ingesting a document from its stored text, or (`reextract`) reading its stored original again. */
export function useReingestRagDocument(moduleKey: string) {
  const invalidate = useInvalidateModuleDocuments(moduleKey);
  return useMutation({
    mutationFn: ({ documentId, reextract }: { documentId: string; reextract?: boolean }) =>
      apiPost(`${ragModulePath(moduleKey)}/documents/${encodeURIComponent(documentId)}`, reextract ? { reextract: true } : {}),
    onSuccess: invalidate,
  });
}

/** One JSONL batch of an export being imported; the screen reads the documents once the last batch is in. */
export function useImportRagBatch(moduleKey: string) {
  return useMutation({
    mutationFn: (data: string) =>
      apiPost<{ imported: number; failed: number }>(`${ragModulePath(moduleKey)}/import`, { data }),
  });
}

/** Asking the module a question (the Playground) adds a line to the usage and insight panels. */
export function useQueryRagModule(moduleKey: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (input: RagQueryInput) =>
      (await apiPost<{ result?: RagQueryResult | null }>(`${ragModulePath(moduleKey)}/query`, input)).result ?? null,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ragKeys.usage(project, moduleKey) }),
        queryClient.invalidateQueries({ queryKey: ragKeys.insights(project, moduleKey) }),
      ]),
  });
}
