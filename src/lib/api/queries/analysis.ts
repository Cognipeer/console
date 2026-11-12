'use client';

/**
 * React Query hooks of the Analysis screens (definitions, conversations, runs, results and the review queue).
 *
 * - Every key starts `['analysis', <project>, ...]` (`analysisKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's data.
 * - A key is a prefix of the keys below it: `definitions(project)` reaches the list, a definition and its calibration.
 * - Mutations invalidate what they change. The modals and screens that write these resources all go through the
 *   mutations below, and the lists reread on every visit (`staleTime: 0`) because runs finish in the background.
 *
 * The routes are the dashboard's `/api/analysis` plugin (`src/server/api/plugins/analysis.ts`). The model and agent
 * pickers read `/api/models` and `/api/agents`.
 */

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type {
  AgentSessionRowView,
  AnalysisConversationView,
  AnalysisDefinitionView,
  AnalysisResultDetailResponse,
  AnalysisResultRowView,
  AnalysisRunView,
  CalibrationView,
  DecisionModelOption,
  ModelOption,
  RunEstimateView,
} from '@/components/analysis/types';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

/** A page of the results route. */
export interface AnalysisResultsPage {
  results: AnalysisResultRowView[];
  total: number;
}

export interface AnalysisResultsParams {
  definitionKey: string;
  needsReview?: boolean;
  sort?: string;
  limit?: number;
  skip?: number;
}

export interface AgentSessionsParams {
  definitionKey: string;
  agentKey?: string;
  days: string;
  limit: number;
}

export interface AgentSessionsPage {
  rows: AgentSessionRowView[];
  nextCursor?: string;
}

/** Body of a definition create / edit: the fields the form sends. */
export type SaveAnalysisDefinitionInput = Record<string, unknown>;

/* ── Keys ────────────────────────────────────────────────────────────────── */

const resultsParamsKey = (params: AnalysisResultsParams) => JSON.stringify(params);

export const analysisKeys = {
  all: ['analysis'] as const,
  project: (project: string) => ['analysis', project] as const,
  definitions: (project: string) => ['analysis', project, 'definitions'] as const,
  definitionList: (project: string) => ['analysis', project, 'definitions', 'list'] as const,
  definition: (project: string, id: string) => ['analysis', project, 'definitions', 'detail', id] as const,
  calibration: (project: string, id: string) => ['analysis', project, 'definitions', 'calibration', id] as const,
  estimate: (project: string, definitionKey: string, payload: string) =>
    ['analysis', project, 'definitions', 'estimate', definitionKey, payload] as const,
  conversations: (project: string) => ['analysis', project, 'conversations'] as const,
  conversationList: (project: string) => ['analysis', project, 'conversations', 'list'] as const,
  conversation: (project: string, id: string) => ['analysis', project, 'conversations', 'detail', id] as const,
  runs: (project: string) => ['analysis', project, 'runs'] as const,
  runList: (project: string, definitionKey: string | null) => ['analysis', project, 'runs', 'list', definitionKey] as const,
  run: (project: string, id: string) => ['analysis', project, 'runs', 'detail', id] as const,
  results: (project: string) => ['analysis', project, 'results'] as const,
  resultList: (project: string, params: AnalysisResultsParams) =>
    ['analysis', project, 'results', 'list', resultsParamsKey(params)] as const,
  result: (project: string, id: string) => ['analysis', project, 'results', 'detail', id] as const,
  agentSessions: (project: string, params: Pick<AgentSessionsParams, 'definitionKey' | 'agentKey' | 'days'>) =>
    ['analysis', project, 'agent-sessions', params.definitionKey, params.agentKey ?? '', params.days] as const,
  llmModels: (project: string) => ['analysis', project, 'models', 'llm'] as const,
  decisionModels: (project: string) => ['analysis', project, 'models', 'decision'] as const,
  agents: (project: string) => ['analysis', project, 'agents'] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const encode = encodeURIComponent;

const resultsQuery = (params: AnalysisResultsParams): string => {
  const qs = new URLSearchParams({ definitionKey: params.definitionKey });
  if (params.needsReview !== undefined) qs.set('needsReview', String(params.needsReview));
  if (params.sort) qs.set('sort', params.sort);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.skip !== undefined) qs.set('skip', String(params.skip));
  return qs.toString();
};

const fetchResults = async (params: AnalysisResultsParams, signal?: AbortSignal): Promise<AnalysisResultsPage> => {
  const body = await apiGet<{ results?: AnalysisResultRowView[]; total?: number }>(
    `/api/analysis/results?${resultsQuery(params)}`,
    { signal },
  );
  return { results: body.results ?? [], total: typeof body.total === 'number' ? body.total : 0 };
};

/* ── Definitions ─────────────────────────────────────────────────────────── */

export function useAnalysisDefinitions() {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.definitionList(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ definitions?: AnalysisDefinitionView[] }>('/api/analysis/definitions', { signal })).definitions ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useAnalysisDefinition(id: string | undefined) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.definition(project, id ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ definition?: AnalysisDefinitionView | null }>(`/api/analysis/definitions/${encode(id as string)}`, { signal }))
        .definition ?? null,
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** How well the reviewers' answers match the decision model's confidence; only a definition with a decision model has it. */
export function useAnalysisCalibration(definitionId: string | undefined, enabled: boolean) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.calibration(project, definitionId ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ calibration?: CalibrationView | null }>(`/api/analysis/definitions/${encode(definitionId as string)}/calibration`, { signal }))
        .calibration ?? null,
    enabled: enabled && Boolean(definitionId),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/**
 * What a run with this selection would do and cost. `payload` is the JSON body of the run (selection + target) as a
 * string, so it doubles as the key; a null `payload` waits. The previous estimate stays up while the next one loads.
 */
export function useAnalysisEstimate(definitionKey: string | undefined, payload: string | null) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.estimate(project, definitionKey ?? '', payload ?? ''),
    queryFn: async ({ signal }) =>
      (await apiPost<{ estimate?: RunEstimateView | null }>(
        `/api/analysis/definitions/${encode(definitionKey as string)}/estimate`,
        JSON.parse(payload as string),
        { signal },
      )).estimate ?? null,
    enabled: Boolean(definitionKey) && payload !== null,
    retry: false,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

/** Create (no `id`) or edit (`id`) a definition. The answer carries the stored definition. */
export function useSaveAnalysisDefinition() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: SaveAnalysisDefinitionInput }) =>
      (await (id
        ? apiPatch<{ definition: AnalysisDefinitionView }>(`/api/analysis/definitions/${encode(id)}`, body)
        : apiPost<{ definition: AnalysisDefinitionView }>('/api/analysis/definitions', body))).definition,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: analysisKeys.definitions(project) });
    },
  });
}

export function useDeleteAnalysisDefinition() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success?: boolean }>(`/api/analysis/definitions/${encode(id)}`),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: analysisKeys.definition(project, id) });
      queryClient.removeQueries({ queryKey: analysisKeys.calibration(project, id) });
      await queryClient.invalidateQueries({ queryKey: analysisKeys.definitionList(project) });
    },
  });
}

/**
 * Starts a run of a definition; `payload` is the selection and target (none = the definition's own source). The
 * answer carries the run, whose id the screens navigate to.
 */
export function useRunAnalysisDefinition() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ definitionKey, payload }: { definitionKey: string; payload?: unknown }) =>
      apiPost<{ run?: { id?: string } }>(`/api/analysis/definitions/${encode(definitionKey)}/run`, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: analysisKeys.runs(project) });
    },
  });
}

/* ── Conversations ───────────────────────────────────────────────────────── */

export function useAnalysisConversations() {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.conversationList(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ conversations?: AnalysisConversationView[] }>('/api/analysis/conversations', { signal })).conversations ?? [],
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useAnalysisConversation(id: string | undefined) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.conversation(project, id ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ conversation?: AnalysisConversationView | null }>(`/api/analysis/conversations/${encode(id as string)}`, { signal }))
        .conversation ?? null,
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useIngestAnalysisConversations() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async (body: { conversations: unknown[]; tags?: string[] }) =>
      (await apiPost<{ conversations: AnalysisConversationView[] }>('/api/analysis/conversations', body)).conversations,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: analysisKeys.conversations(project) });
    },
  });
}

export function useDeleteAnalysisConversation() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success?: boolean }>(`/api/analysis/conversations/${encode(id)}`),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: analysisKeys.conversation(project, id) });
      await queryClient.invalidateQueries({ queryKey: analysisKeys.conversationList(project) });
    },
  });
}

/* ── Runs ────────────────────────────────────────────────────────────────── */

/** Runs of every definition, or of one (`definitionKey`); `enabled` false waits (the definition is not loaded yet). */
export function useAnalysisRuns(definitionKey?: string, enabled = true) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.runList(project, definitionKey ?? null),
    queryFn: async ({ signal }) =>
      (await apiGet<{ runs?: AnalysisRunView[] }>(
        definitionKey ? `/api/analysis/runs?definitionKey=${encode(definitionKey)}` : '/api/analysis/runs',
        { signal },
      )).runs ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** One run. It rereads every 2 s while the run is still being processed in the background. */
export function useAnalysisRun(id: string | undefined) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.run(project, id ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ run?: AnalysisRunView | null }>(`/api/analysis/runs/${encode(id as string)}`, { signal })).run ?? null,
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<AnalysisRunView | null>((run) => run?.status === 'pending' || run?.status === 'running', 2000),
  });
}

/* ── Results and the review queue ────────────────────────────────────────── */

/** A page of the review queue (or of the results of a definition); `params` null waits. */
export function useAnalysisResults(params: AnalysisResultsParams | null) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.resultList(project, params ?? { definitionKey: '' }),
    queryFn: ({ signal }) => fetchResults(params as AnalysisResultsParams, signal),
    enabled: params !== null,
    retry: retryUnlessClientError,
    staleTime: 0,
    // Paging keeps the rows on screen until the next page is here.
    placeholderData: keepPreviousData,
  });
}

/** Reads a page of results once, fresh: "Save & next" looks for the next flagged result with it. */
export function useLoadAnalysisResults() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return (params: AnalysisResultsParams) =>
    queryClient.fetchQuery({
      queryKey: analysisKeys.resultList(project, params),
      queryFn: ({ signal }) => fetchResults(params, signal),
      staleTime: 0,
    });
}

export function useAnalysisResult(id: string | undefined) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.result(project, id ?? ''),
    queryFn: ({ signal }) => apiGet<AnalysisResultDetailResponse>(`/api/analysis/results/${encode(id as string)}`, { signal }),
    enabled: Boolean(id),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Records a reviewer's answers. The stored result replaces the one of the open detail; the queue rereads on its visit. */
export function useReviewAnalysisResult() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: Record<string, string | boolean> }) =>
      apiPost<{ result?: AnalysisResultDetailResponse['result'] }>(`/api/analysis/results/${encode(id)}/review`, { values }),
    onSuccess: async (body, { id }) => {
      if (body.result) {
        const result = body.result;
        queryClient.setQueryData<AnalysisResultDetailResponse>(analysisKeys.result(project, id), (prev) =>
          prev ? { ...prev, result } : prev,
        );
      }
      await queryClient.invalidateQueries({ queryKey: analysisKeys.results(project), refetchType: 'none' });
    },
  });
}

/* ── Agent sessions ──────────────────────────────────────────────────────── */

/**
 * The platform's agent sessions of one definition, a page at a time (`fetchNextPage` loads the next). `params` null
 * waits. Rows of earlier pages are kept while a new filter loads.
 */
export function useAgentSessions(params: AgentSessionsParams | null) {
  const [, project] = useResourceKey('analysis');
  return useInfiniteQuery({
    queryKey: analysisKeys.agentSessions(project, params ?? { definitionKey: '', days: '' }),
    queryFn: ({ pageParam, signal }): Promise<AgentSessionsPage> => {
      const p = params as AgentSessionsParams;
      const qs = new URLSearchParams({ definitionKey: p.definitionKey, days: p.days, limit: String(p.limit) });
      if (p.agentKey) qs.set('agentKey', p.agentKey);
      if (pageParam) qs.set('cursor', pageParam);
      return apiGet<{ rows?: AgentSessionRowView[]; nextCursor?: string }>(
        `/api/analysis/sources/agent-sessions?${qs.toString()}`,
        { signal },
      ).then((data) => ({ rows: data.rows ?? [], nextCursor: data.nextCursor || undefined }));
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: params !== null,
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

/* ── Pickers: models and agents ──────────────────────────────────────────── */

interface ApiModel {
  key: string;
  name: string;
  settings?: { decision?: { mode?: string } };
}

/** The project's LLMs, as picker options. */
export function useLlmModelOptions() {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.llmModels(project),
    queryFn: async ({ signal }): Promise<ModelOption[]> =>
      ((await apiGet<{ models?: ApiModel[] }>('/api/models?category=llm', { signal })).models ?? []).map((m) => ({
        value: m.key,
        label: m.name,
      })),
    retry: retryUnlessClientError,
    // Models are written by their own screens: a visit always rereads them.
    staleTime: 0,
  });
}

/** The project's decision models, as picker options; only needed while the definition editor is open. */
export function useDecisionModelOptions(enabled: boolean) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.decisionModels(project),
    queryFn: async ({ signal }): Promise<DecisionModelOption[]> =>
      ((await apiGet<{ models?: ApiModel[] }>('/api/models?category=decision', { signal })).models ?? []).map((m) => ({
        value: m.key,
        label: m.name,
        selfReported: m.settings?.decision?.mode !== 'native',
      })),
    enabled,
    retry: retryUnlessClientError,
    // Models and agents are written by their own screens: each time the editor opens it rereads them.
    staleTime: 0,
  });
}

/** The project's agents, as picker options; only needed while the definition editor is open. */
export function useAgentOptions(enabled: boolean) {
  const [, project] = useResourceKey('analysis');
  return useQuery({
    queryKey: analysisKeys.agents(project),
    queryFn: async ({ signal }): Promise<ModelOption[]> =>
      ((await apiGet<{ agents?: Array<{ key: string; name: string }> }>('/api/agents', { signal })).agents ?? []).map((a) => ({
        value: a.key,
        label: a.name,
      })),
    enabled,
    retry: retryUnlessClientError,
    // Models and agents are written by their own screens: each time the editor opens it rereads them.
    staleTime: 0,
  });
}
