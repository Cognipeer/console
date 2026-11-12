'use client';

/**
 * React Query hooks of the Models screens.
 *
 * - Every key starts `['models', <project>, ...]` (`modelsKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's models.
 *
 * The routes are the dashboard's `/api/models` plugin.
 */

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, apiPut, isApiError } from '@/lib/api/client';
import type { RoutingAnalytics } from '@/lib/services/models/routingAnalytics';
import type { IModel } from '@/lib/database';
import { fetchCreditSpend } from '@/components/usage/creditsApi';
import type { PlatformProviderView } from '@/components/models/catalog/platformProviders';
import type { ModelProviderView } from '@/lib/services/models/types';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

/** A model as a picker needs it. */
export interface ModelOption {
  key: string;
  name: string;
  category?: string;
}

export interface ModelsDashboardOverview {
  totalModels: number;
  llmCount: number;
  embeddingCount: number;
  providerCount: number;
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Prompt-cache READ tokens, a subset of totalInputTokens. */
  totalCachedInputTokens?: number;
  /** Prompt-cache WRITE tokens, a subset of totalInputTokens. */
  totalCachedWriteTokens?: number;
  totalTokens: number;
  totalToolCalls: number;
  /** Semantic (response) cache hits. */
  cacheHits: number;
  /** Semantic cache hit rate (cacheHits / totalCalls), not the prompt cache. */
  cacheHitRate: number;
  /** Prompt cache: cached input tokens / input tokens. */
  promptCacheHitRate?: number;
  avgLatencyMs: number | null;
  totalCost: number;
  currency: string;
  errorRate: number;
}

export interface ModelTopEntry {
  key: string;
  name: string;
  category: 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr' | 'image' | 'moderation' | 'decision';
  callCount: number;
  totalTokens: number;
  totalCost: number;
  errorRate: number;
  avgLatencyMs: number | null;
}

export interface DailyEntry {
  period: string;
  callCount: number;
  totalTokens: number;
}

export interface ModelsDashboardData {
  overview: ModelsDashboardOverview;
  topModels: ModelTopEntry[];
  daily: DailyEntry[];
}

export interface ModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
}

export interface ModelDto {
  _id: string;
  name: string;
  description?: string;
  key: string;
  provider?: string;
  providerKey: string;
  providerDriver: string;
  category: 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr' | 'image' | 'moderation' | 'decision';
  modelId: string;
  isMultimodal?: boolean;
  /** Set on a platform model an operator switched off: listed, but it cannot be called. */
  unavailable?: boolean;
  /** A platform model: deleting it takes it out of this project. */
  platform?: boolean;
  /** A platform model's credit price (it has no per-token price). */
  credits?: { perCall?: number; perMillionTokens?: number };
  /** What the model resolves to (an explicit choice, else detected from its id). */
  capabilities?: { inputModalities?: string[] };
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** What the Models page lists: the project's models, the providers behind them and the platform providers. */
export interface ModelsPageData {
  models: ModelDto[];
  providers: ModelProviderView[];
  platformProviders: PlatformProviderView[];
}

/** Credits spent per platform model in a period. */
export interface ModelCreditSpend {
  total: number;
  byModel: Map<string, number>;
}

/** What a picker shows before its models arrive: one array, so effects keyed on the list do not re-run. */
export const NO_MODEL_OPTIONS: ModelOption[] = [];

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const modelsKeys = {
  all: ['models'] as const,
  project: (project: string) => ['models', project] as const,
  /** The models of one category, as picker options. */
  /** The Models page list (models, providers, platform providers). */
  page: (project: string) => ['models', project, 'page'] as const,
  /** Usage dashboard of the selected period (`params` is its query string). */
  dashboard: (project: string, params: string) => ['models', project, 'dashboard', params] as const,
  creditSpend: (project: string, params: string) => ['models', project, 'credit-spend', params] as const,
  detail: (project: string, id: string) => ['models', project, 'detail', id] as const,
  providers: (project: string) => ['models', project, 'providers'] as const,
  drivers: (project: string) => ['models', project, 'provider-drivers'] as const,
  driverForm: (project: string, driver: string) => ['models', project, 'provider-drivers', driver, 'form'] as const,
  routingAnalytics: (project: string, id: string, days: string) =>
    ['models', project, 'detail', id, 'routing-analytics', days] as const,
  priceSuggestion: (project: string, name: string) => ['models', project, 'price-suggestion', name] as const,
  /** Rows other screens own (guardrails, vector providers and indexes, identities) that the model forms pick from. */
  pickers: (project: string, ...rest: string[]) => ['models', project, 'pickers', ...rest] as const,
  options: (project: string, category: string) => ['models', project, 'options', category] as const,
};

/* ── Queries ─────────────────────────────────────────────────────────────── */

/**
 * The models of a category (`llm`, `embedding`, `rerank`...) for a picker. An empty category reads nothing.
 * Models are also created from other screens, so opening a picker always reads them again.
 */
export function useModelOptions(category: string | undefined, enabled = true) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.options(project, category ?? ''),
    queryFn: async ({ signal }) =>
      ((await apiGet<{ models?: ModelOption[] }>(`/api/models?category=${category}`, { signal })).models ?? []).map(
        (m) => ({ key: m.key, name: m.name, category: m.category }),
      ),
    enabled: Boolean(category) && enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The Models page list. Models are also created and removed from other screens, so a visit always refetches. */
export function useModelsPageData() {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.page(project),
    queryFn: async ({ signal }): Promise<ModelsPageData> => {
      const data = await apiGet<Partial<ModelsPageData>>(
        '/api/models?includeProviders=true&includePlatform=true&includeUnavailable=true',
        { signal },
      );
      return {
        models: data.models ?? [],
        providers: data.providers ?? [],
        platformProviders: data.platformProviders ?? [],
      };
    },
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Usage numbers of the selected period; the previous period's numbers stay visible while the next one loads. */
export function useModelsDashboard(params: string) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.dashboard(project, params),
    queryFn: ({ signal }) => apiGet<ModelsDashboardData>(`/api/models/dashboard?${params}`, { signal }),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/**
 * Credits spent per platform model (hosted plans only; elsewhere, or without access to the ledger, the request
 * fails and the data stays undefined).
 */
export function useModelCreditSpend(params: string) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.creditSpend(project, params),
    queryFn: async (): Promise<ModelCreditSpend> => {
      const spend = await fetchCreditSpend(new URLSearchParams(params));
      const byModel = new Map<string, number>();
      for (const row of spend.models) if (row.model) byModel.set(row.model, row.credits);
      return { total: spend.total, byModel };
    },
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  });
}

/* ── Mutations and cache edits ───────────────────────────────────────────── */

/** Deleting a model (or taking a platform model out of the project) leaves the list and changes the usage numbers. */
export function useDeleteModel() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(`/api/models/${id}`),
    onSuccess: async (_result, id) => {
      queryClient.setQueryData<ModelsPageData>(modelsKeys.page(project), (current) =>
        current ? { ...current, models: current.models.filter((m) => m._id !== id) } : current,
      );
      await queryClient.invalidateQueries({ queryKey: [...modelsKeys.project(project), 'dashboard'] });
    },
  });
}

/** Writes a just-created model or provider into the Models page list before the list is read again. */
export function useModelsListCache() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  const edit = (update: (current: ModelsPageData) => ModelsPageData) =>
    queryClient.setQueryData<ModelsPageData>(modelsKeys.page(project), (current) => (current ? update(current) : current));
  return {
    addModel: (model: ModelDto) =>
      edit((current) => ({ ...current, models: [model, ...current.models.filter((m) => m._id !== model._id)] })),
    addProvider: (provider: ModelProviderView) =>
      edit((current) =>
        current.providers.some((p) => p.key === provider.key)
          ? current
          : { ...current, providers: [...current.providers, provider] },
      ),
  };
}

/**
 * The server's own error text of a failed call (`{ error: '...' }`), when it sent one; undefined otherwise, so a
 * screen can fall back to its own wording.
 */
export function serverErrorText(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const payload = error.payload as { error?: unknown } | undefined;
  return typeof payload?.error === 'string' && payload.error ? payload.error : undefined;
}

/* ── Model records ───────────────────────────────────────────────────────── */

/** One model record. `T` is the shape the screen reads (the record carries more than the list rows do). */
export function useModelRecord<T = ModelDto>(id: string | null | undefined, enabled = true) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.detail(project, id ?? ''),
    queryFn: async ({ signal }) => (await apiGet<{ model: T }>(`/api/models/${id}`, { signal })).model,
    enabled: Boolean(id) && enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
    // A form fills itself from the record once: reopening it reads the record again instead of reusing a copy.
    gcTime: 0,
  });
}

/** Everything about a model can change on any save (list row, usage numbers, detail, pickers). */
function useInvalidateModels() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: modelsKeys.project(project) });
}

/**
 * `POST /api/models`. A caller that creates many in a row passes `refresh: false` and refreshes once at the end
 * (every create would otherwise read the lists again).
 */
export function useCreateModel(options: { refresh?: boolean } = {}) {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: (body: object) => apiPost<{ model: IModel }>('/api/models', body),
    onSuccess: () => (options.refresh === false ? undefined : invalidate()),
  });
}

/** The text to show for a failed call: the server's own message, else `fallback` (a lost connection keeps its text). */
export function failureText(error: unknown, fallback: string): string {
  return serverErrorText(error) ?? (isApiError(error) || !(error instanceof Error) ? fallback : error.message);
}

/** `PUT /api/models/:id` with a partial body; answers the server's payload. */
export function useUpdateModel() {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiPut<{ model?: unknown }>(`/api/models/${id}`, body),
    onSuccess: () => invalidate(),
  });
}

/** Creates a Dynamic LLM (`POST /api/models/dynamic`), or saves an edit of one (`PUT /api/models/:id`). */
export function useSaveDynamicModel() {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) =>
      id ? apiPut<unknown>(`/api/models/${id}`, body) : apiPost<unknown>('/api/models/dynamic', body),
    onSuccess: () => invalidate(),
  });
}

/** Adds platform models (records that exist already) to the active project. */
export function useAddPlatformModels() {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: (keys: string[]) => apiPost<{ added?: string[] }>('/api/models/platform/add', { keys }),
    onSuccess: () => invalidate(),
  });
}

/* ── Model providers ─────────────────────────────────────────────────────── */

/** The project's model providers (platform providers carry `platform: true`). */
export function useModelProviders<T = Record<string, string> & { platform?: boolean }>(enabled = true) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.providers(project),
    queryFn: async ({ signal }) => (await apiGet<{ providers?: T[] }>('/api/models/providers', { signal })).providers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The providers a model form can create against, as `GET /api/models?includeProviders=true` lists them. */
export function useListedModelProviders(enabled: boolean) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.pickers(project, 'listed-providers'),
    queryFn: async ({ signal }) =>
      (await apiGet<{ providers?: ModelProviderView[] }>('/api/models?includeProviders=true', { signal })).providers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useModelProviderDrivers<T = unknown>(enabled: boolean) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.drivers(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ drivers?: T[] }>('/api/models/providers/drivers', { signal })).drivers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useModelProviderDriverForm<T = unknown>(driver: string, enabled: boolean) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.driverForm(project, driver),
    queryFn: async ({ signal }) =>
      (await apiGet<{ schema?: T | null }>(`/api/models/providers/drivers/${driver}/form`, { signal })).schema ?? null,
    enabled: enabled && Boolean(driver),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useCreateModelProvider() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiPost<{ provider: ModelProviderView }>('/api/models/providers', body)).provider,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: modelsKeys.providers(project) }),
        queryClient.invalidateQueries({ queryKey: modelsKeys.pickers(project, 'listed-providers') }),
      ]);
    },
  });
}

/* ── Routing analytics and price lookups ─────────────────────────────────── */

export function useRoutingAnalytics(modelId: string, days: string) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.routingAnalytics(project, modelId, days),
    queryFn: async ({ signal }) =>
      (await apiGet<{ analytics: RoutingAnalytics }>(`/api/models/${modelId}/routing-analytics?days=${days}`, { signal }))
        .analytics,
    // The previous window stays on screen while the next one loads.
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** What the built-in price catalog says about a model id (`suggestions[0].match`, when it has an entry). */
export interface PriceCatalogMatch {
  catalogKey: string;
  confidence: string;
  pricing?: Record<string, unknown>;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
}

const fetchPriceSuggestion = async (name: string, signal?: AbortSignal): Promise<PriceCatalogMatch | null> => {
  const payload = await apiGet<{ suggestions?: Array<{ match?: PriceCatalogMatch | null }> }>(
    `/api/model-price-catalog/suggest?names=${encodeURIComponent(name)}`,
    { signal },
  );
  return payload.suggestions?.[0]?.match ?? null;
};

/** "Fill from catalog": looks one model id up on demand. */
export function useSuggestModelPrice() {
  return useMutation({ mutationFn: (name: string) => fetchPriceSuggestion(name) });
}

/** The same lookup as a value for a form: read while `enabled`; a failed lookup is "no entry". */
export function useModelPriceSuggestion(name: string, enabled: boolean) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.priceSuggestion(project, name),
    queryFn: ({ signal }) => fetchPriceSuggestion(name, signal),
    enabled: enabled && Boolean(name),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/* ── Pickers over rows other screens own ─────────────────────────────────── */

/** Guardrails, unfiltered on purpose: one disabled after it was bound must still resolve to its name. */
export function useGuardrailPickerRows<T = unknown>(enabled: boolean) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.pickers(project, 'guardrails'),
    queryFn: async ({ signal }) => (await apiGet<{ guardrails?: T[] }>('/api/guardrails', { signal })).guardrails ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useVectorProviderPickerRows<T = { key: string; label: string }>(enabled: boolean) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.pickers(project, 'vector-providers'),
    queryFn: async ({ signal }) => (await apiGet<{ providers?: T[] }>('/api/vector/providers', { signal })).providers ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useVectorIndexPickerRows<T = { key: string; name: string }>(providerKey: string) {
  const [, project] = useResourceKey('models');
  return useQuery({
    queryKey: modelsKeys.pickers(project, 'vector-indexes', providerKey),
    queryFn: async ({ signal }) =>
      (await apiGet<{ indexes?: T[] }>(`/api/vector/indexes?providerKey=${encodeURIComponent(providerKey)}`, { signal })).indexes ?? [],
    enabled: Boolean(providerKey),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The rows of the identity lists a Dynamic LLM caller condition picks from (users, groups, agents, tokens, projects). */
export function useIdentityPickerRows(enabled: boolean) {
  const [, project] = useResourceKey('models');
  const sources: Array<[string, string, string]> = [
    ['users', '/api/users', 'users'],
    ['groups', '/api/groups', 'groups'],
    ['agents', '/api/agents', 'agents'],
    ['tokens', '/api/tokens?scope=project', 'tokens'],
    ['projects', '/api/projects', 'projects'],
  ];
  return useQueries({
    queries: sources.map(([name, url, listKey]) => ({
      queryKey: modelsKeys.pickers(project, 'identity', name),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Array<Record<string, unknown>>> => {
        // Each failure just leaves that list empty.
        try {
          const data = await apiGet<Record<string, unknown>>(url, { signal });
          return Array.isArray(data[listKey]) ? (data[listKey] as Array<Record<string, unknown>>) : [];
        } catch {
          return [];
        }
      },
      enabled,
      staleTime: 0,
    })),
  });
}
