'use client';

/**
 * React Query hooks of the agents screens (list, create/connect, templates, versions, limits, reminders, runs,
 * feedback, attachment buckets).
 *
 * - Every key starts `['agents', <project>, ...]` (`agentsKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's agents.
 * - Mutations invalidate what they change (the agent list, the reminder and run lists of the agent).
 * - The chat / stream calls of the session view stay raw; they are not here.
 *
 * The routes are the dashboard's `/api/agents` plugin (`src/server/api/plugins/agents.ts`).
 */

import { useCallback } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage, isApiError } from '@/lib/api/client';
import type { ReminderPlatformLimits } from '@/lib/services/agents/agentRemindersConfig';
import type { serializeAgentRun } from '@/lib/services/agents/agentRunService';
import type { AgentTemplateDetail, AgentTemplateSummary } from '@/lib/services/agents/templates/types';
import { withoutOwnedAgents } from '@/lib/utils/ownedAgents';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Text of a failed request ────────────────────────────────────────────── */

/**
 * The message a refused request shows: the server's `error` text, else `fallback`. A request that never got an
 * answer (a lost connection) keeps the error's own message.
 */
export function serverErrorOr(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    const body = error.payload as { error?: unknown } | undefined;
    return typeof body?.error === 'string' && body.error ? body.error : fallback;
  }
  return errorMessage(error, fallback);
}

/** The server's `error` text of a refused request, else `HTTP <status>`; any other failure keeps its own message. */
export function httpErrorOr(error: unknown): string {
  if (isApiError(error)) {
    const body = error.payload as { error?: unknown } | undefined;
    return typeof body?.error === 'string' && body.error ? body.error : `HTTP ${error.status}`;
  }
  return errorMessage(error);
}

/** The fixed `fallback` for any refused request (the server's reason is not shown); a lost connection keeps its own message. */
export function refusalOr(error: unknown, fallback: string): string {
  return isApiError(error) ? fallback : errorMessage(error, fallback);
}

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface AgentLlmModel {
  _id: string;
  key: string;
  name: string;
  modelId: string;
  category: string;
}

export interface TenantProvider {
  _id?: string;
  key: string;
  label?: string;
  name?: string;
}

export interface AgentVersionOptionsData {
  versions: Array<{ version: number; published: boolean }>;
  publishedVersion: number | null;
}

export interface ConsoleIdentityInfo {
  issuer: string;
  jwksUri: string;
  [key: string]: unknown;
}

export type AgentRunRow = ReturnType<typeof serializeAgentRun>;

export interface AgentRemindersPage<T> {
  reminders: T[];
  summary?: { active?: number };
  scope?: { viewOthers?: boolean };
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const agentsKeys = {
  all: ['agents'] as const,
  project: (project: string) => ['agents', project] as const,
  list: (project: string) => ['agents', project, 'list'] as const,
  llmModels: (project: string) => ['agents', project, 'llm-models'] as const,
  tenantProviders: (project: string) => ['agents', project, 'tenant-providers'] as const,
  versionOptions: (project: string, agentKey: string) => ['agents', project, 'version-options', agentKey] as const,
  templates: (project: string) => ['agents', project, 'templates'] as const,
  template: (project: string, key: string) => ['agents', project, 'template', key] as const,
  consoleIdentity: (project: string) => ['agents', project, 'console-identity'] as const,
  reminderLimits: (project: string) => ['agents', project, 'reminder-limits'] as const,
  runLimits: (project: string) => ['agents', project, 'run-limits'] as const,
  tracingOverview: (project: string, agentName: string, days: number) =>
    ['agents', project, 'tracing-overview', agentName, days] as const,
  attachmentBuckets: (project: string) => ['agents', project, 'attachment-buckets'] as const,
  /** Everything an agent owns that is listed under it (reminders, runs, feedback). */
  agent: (project: string, agentId: string) => ['agents', project, 'agent', agentId] as const,
  reminders: (project: string, agentId: string, status: string) =>
    ['agents', project, 'agent', agentId, 'reminders', status] as const,
  sessionReminders: (project: string, agentId: string, sessionId: string, status: string) =>
    ['agents', project, 'agent', agentId, 'session-reminders', sessionId, status] as const,
  runs: (project: string, agentId: string, query: string) => ['agents', project, 'agent', agentId, 'runs', query] as const,
  feedbackSummary: (project: string, agentId: string, query: string) =>
    ['agents', project, 'agent', agentId, 'feedback-summary', query] as const,
  feedback: (project: string, agentId: string, query: string) =>
    ['agents', project, 'agent', agentId, 'feedback', query] as const,
};

/* ── Fetchers ────────────────────────────────────────────────────────────── */

const agentPath = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

/* ── Agent list, models and providers ────────────────────────────────────── */

/** The project's agents. Agents a flow owns are never listed. */
export function useAgentList() {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.list(project),
    queryFn: async ({ signal }) =>
      withoutOwnedAgents<AgentListItem>((await apiGet<{ agents?: AgentListItem[] }>('/api/agents', { signal })).agents ?? []),
    retry: retryUnlessClientError,
    // Agents are also written outside these hooks (the agent studio), so a visit always refetches.
    staleTime: 0,
  });
}

/** The row shape the agents table reads; the API sends more. */
export interface AgentListItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  config: {
    modelKey?: string;
    additionalModels?: Array<{ modelKey: string }>;
    kind?: 'native' | 'external' | 'flow';
    connection?: { protocol?: string };
    toolBindings?: Array<{ toolNames?: string[] }>;
    knowledgeEngineKey?: string;
    memory?: { enabled?: boolean };
    subagents?: unknown[];
  };
  status: string;
  publishedVersion?: number | null;
  createdAt: string;
  updatedAt?: string;
}

/** The project's LLM models (the create form's picker). A failure leaves the list empty. */
export function useAgentLlmModels() {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.llmModels(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ models?: AgentLlmModel[] }>('/api/models?category=llm', { signal })).models ?? [],
    retry: retryUnlessClientError,
  });
}

/** The tenant's providers (the connect form's credential picker). A failure leaves the list empty. */
export function useTenantProviders() {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.tenantProviders(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ providers?: TenantProvider[] }>('/api/providers?scope=tenant', { signal })).providers ?? [],
    retry: retryUnlessClientError,
  });
}

/** Create (`id` undefined) or update an agent; the answer carries the agent. */
export function useSaveAgent() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: unknown }) =>
      id ? apiPatch<{ agent: { _id: string } }>(agentPath(id), body) : apiPost<{ agent: { _id: string } }>('/api/agents', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentsKeys.list(project) }),
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete(agentPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: agentsKeys.agent(project, id) });
      await queryClient.invalidateQueries({ queryKey: agentsKeys.list(project) });
    },
  });
}

/** Importing a document creates an agent (or overwrites the target); `preview` only reads the document. */
export function usePreviewAgentImport<TPreview>() {
  return useMutation({
    mutationFn: (body: { content: string; format: string }) =>
      apiPost<TPreview>('/api/agents/import/document/preview', body),
  });
}

export function useImportAgentDocument() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (body: unknown) => apiPost<{ agent: { _id: unknown } }>('/api/agents/import/document', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentsKeys.list(project) }),
  });
}

/**
 * The published versions of the agent with this KEY (the agents list maps the key to the id the versions route
 * needs). Resolves to nothing usable (empty options) when the agent is unknown; a refused call is an error.
 */
export function useAgentVersionOptionsQuery(agentKey: string | null | undefined, enabled: boolean) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.versionOptions(project, agentKey ?? ''),
    queryFn: async ({ signal }): Promise<AgentVersionOptionsData> => {
      const agents = (await apiGet<{ agents?: Array<{ _id: string; key: string }> }>('/api/agents', { signal })).agents ?? [];
      const agentId = agents.find((a) => a.key === agentKey)?._id;
      if (!agentId) return { versions: [], publishedVersion: null };
      // Fetched per agent rather than bundled into the list: an agent's history can run to dozens of entries.
      const data = await apiGet<{ publishedVersion?: number | null; versions?: Array<{ version: number }> }>(
        `${agentPath(agentId)}/versions?limit=100`,
        { signal },
      );
      const publishedVersion = data.publishedVersion ?? null;
      return {
        publishedVersion,
        versions: (data.versions ?? []).map((entry) => ({ version: entry.version, published: entry.version === publishedVersion })),
      };
    },
    enabled: enabled && Boolean(agentKey),
    retry: false,
  });
}

/* ── Templates ───────────────────────────────────────────────────────────── */

export function useAgentTemplates() {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.templates(project),
    queryFn: async ({ signal }) => {
      const data = await apiGet<{ templates?: AgentTemplateSummary[]; catalogVersion?: number }>('/api/agents/templates', { signal });
      return { templates: data.templates ?? [], catalogVersion: data.catalogVersion ?? 0 };
    },
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useAgentTemplate(templateKey: string | null) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.template(project, templateKey ?? ''),
    queryFn: async ({ signal }) =>
      (await apiGet<{ template: AgentTemplateDetail }>(`/api/agents/templates/${encodeURIComponent(templateKey as string)}`, { signal })).template,
    enabled: Boolean(templateKey),
    retry: false,
  });
}

/* ── Connect (external agent) ────────────────────────────────────────────── */

/** The issuer details of the Console identity option, read once it is chosen. */
export function useConsoleIdentityInfo(enabled: boolean) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.consoleIdentity(project),
    queryFn: async ({ signal }) => {
      const data = await apiGet<ConsoleIdentityInfo | null>('/api/agents/console-identity', { signal });
      return data?.issuer && data?.jwksUri ? data : null;
    },
    enabled,
    retry: false,
  });
}

/* ── Platform limits ─────────────────────────────────────────────────────── */

/** The platform ceilings of reminders, for the hints; the caller keeps its defaults while this has no data. */
export function useReminderLimits(enabled: boolean) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.reminderLimits(project),
    queryFn: async ({ signal }) => (await apiGet<{ limits?: ReminderPlatformLimits } | null>('/api/agents/reminder-limits', { signal }))?.limits ?? null,
    enabled,
    retry: false,
  });
}

export function useRunLimits<T>() {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.runLimits(project),
    queryFn: ({ signal }) => apiGet<T | null>('/api/agents/execution/limits', { signal }),
    retry: false,
  });
}

/* ── Attachment buckets ──────────────────────────────────────────────────── */

export type AttachmentBucketsResult<B> =
  | { status: 'ready'; buckets: B[] }
  | { status: 'forbidden'; message?: string };

/**
 * The project's Document Store buckets for the file picker. A 403 is a result (the viewer has no access; the
 * server says why), every other failure is an error.
 */
export function useAttachmentBucketsQuery<B>(enabled: boolean) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.attachmentBuckets(project),
    queryFn: async ({ signal }): Promise<AttachmentBucketsResult<B>> => {
      try {
        const data = await apiGet<{ buckets?: B[] }>('/api/agents/attachments/buckets', { signal });
        return { status: 'ready', buckets: Array.isArray(data.buckets) ? data.buckets : [] };
      } catch (error) {
        if (isApiError(error) && error.status === 403) {
          const body = error.payload as { error?: unknown } | undefined;
          return { status: 'forbidden', ...(typeof body?.error === 'string' && body.error ? { message: body.error } : {}) };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
    // Every mount rereads: a reload after a failure must ask again.
    staleTime: 0,
  });
}

/* ── Tracing overview ────────────────────────────────────────────────────── */

/**
 * The tracing overview of an agent (by NAME) over the last `days` days. A failed read has no data: the caller shows
 * the empty overview.
 */
export function useAgentTracingOverview<T>(agentName: string, days: number) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.tracingOverview(project, agentName, days),
    queryFn: ({ signal }) => {
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      return apiGet<T>(`/api/tracing/agents/${encodeURIComponent(agentName)}/overview?from=${encodeURIComponent(from)}`, { signal });
    },
    retry: false,
  });
}

/* ── Reminders ───────────────────────────────────────────────────────────── */

const REMINDER_POLL_MS = 15_000;

/**
 * The reminders of one agent, polled while any is `scheduled`. Switching `status` keeps the rows of the earlier
 * filter on screen until the new ones arrive.
 */
export function useAgentReminders<T extends { status: string }>(agentId: string, status: string) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.reminders(project, agentId, status),
    queryFn: ({ signal }) =>
      apiGet<AgentRemindersPage<T>>(`${agentPath(agentId)}/reminders?status=${status}&limit=200`, { signal }),
    retry: false,
    staleTime: 0,
    placeholderData: keepPreviousData,
    ...pollingOptions<AgentRemindersPage<T>>((data) => (data?.reminders ?? []).some((r) => r.status === 'scheduled'), REMINDER_POLL_MS),
  });
}

/**
 * One session's reminders. Does not call the server while `enabled` is false. Polls while a wake is still to
 * come (`isPending` decides). `reminders` is null until the first answer; a failed read reads as none.
 */
export function useSessionRemindersQuery<T>(
  agentId: string,
  sessionId: string | null | undefined,
  enabled: boolean,
  status: 'active' | 'all',
  isPending: (reminders: T[]) => boolean,
) {
  const [, project] = useResourceKey('agents');
  const query = useQuery({
    queryKey: agentsKeys.sessionReminders(project, agentId, sessionId ?? '', status),
    queryFn: async ({ signal }) =>
      (await apiGet<AgentRemindersPage<T>>(
        `${agentPath(agentId)}/reminders?sessionId=${encodeURIComponent(sessionId as string)}&status=${status}`,
        { signal },
      )).reminders ?? [],
    enabled: enabled && Boolean(sessionId),
    retry: false,
    staleTime: 0,
    ...pollingOptions<T[]>((reminders) => isPending(reminders ?? []), REMINDER_POLL_MS),
  });
  const { refetch } = query;
  const reload = useCallback(async () => {
    if (!enabled || !sessionId) return;
    await refetch();
  }, [enabled, sessionId, refetch]);
  const reminders = query.data ?? (query.isPending ? null : []);
  return { reminders, reload };
}

/* ── Runs ────────────────────────────────────────────────────────────────── */

export const RUN_POLL_MS = 5_000;
const ACTIVE_RUN = new Set(['scheduled', 'queued', 'running']);

/** The runs of one agent (or of one conversation / trigger), polled while one can still change. */
export function useAgentRuns(agentId: string, query: string) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.runs(project, agentId, query),
    queryFn: async ({ signal }) =>
      (await apiGet<{ runs?: AgentRunRow[] }>(`${agentPath(agentId)}/runs?${query}`, { signal })).runs ?? [],
    retry: false,
    staleTime: 0,
    ...pollingOptions<AgentRunRow[]>((runs) => (runs ?? []).some((run) => ACTIVE_RUN.has(run.status)), RUN_POLL_MS),
  });
}

/** Cancel a run; the run lists of the agent are reread. */
export function useCancelRun(agentId: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (runId: string) => apiPost(`${agentPath(agentId)}/runs/${encodeURIComponent(runId)}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentsKeys.agent(project, agentId) }),
  });
}

/* ── Feedback ────────────────────────────────────────────────────────────── */

/** The totals of the rating feedback an agent got (the window and filters are in `query`). */
export function useAgentFeedbackSummary<T>(agentId: string, query: string) {
  const [, project] = useResourceKey('agents');
  return useQuery({
    queryKey: agentsKeys.feedbackSummary(project, agentId, query),
    queryFn: async ({ signal }) => (await apiGet<{ summary: T }>(`${agentPath(agentId)}/feedback/summary?${query}`, { signal })).summary,
    retry: false,
    staleTime: 0,
  });
}

/** The feedback items, a page at a time (`pageQuery(skip)` builds the query string of a page). */
export function useAgentFeedbackPages<TItem>(agentId: string, filterKey: string, pageQuery: (skip: number) => string) {
  const [, project] = useResourceKey('agents');
  return useInfiniteQuery({
    queryKey: agentsKeys.feedback(project, agentId, filterKey),
    queryFn: ({ pageParam, signal }) =>
      apiGet<{ items: TItem[]; total: number; canReadComments: boolean }>(`${agentPath(agentId)}/feedback?${pageQuery(pageParam)}`, { signal }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => pages.reduce((sum, page) => sum + page.items.length, 0) || undefined,
    retry: false,
    staleTime: 0,
  });
}
