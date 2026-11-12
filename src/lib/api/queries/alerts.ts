'use client';

/**
 * React Query hooks of the alert screens (rules, templates, history, the channel library and the lookups the
 * incident screens share). The incident hooks are in `alertIncidents.ts`.
 *
 * - Every key starts `['alerts', <project>, ...]` (`alertsKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's rules or incidents.
 * - A key is a prefix of the keys below it: `rules(project)` reaches every rule list and rule.
 * - The create/edit form of a rule (`AlertRuleForm`) writes rules with its own request and then asks its page to
 *   reload, so the rule lists and the template list are read with `staleTime: 0`: a visit always refetches.
 *
 * The routes are the dashboard's `/api/alerts` plugin (`src/server/api/plugins/alerts.ts`).
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type {
  AlertEventDto,
  AlertMeta,
  AlertRuleDto,
  AlertTemplateApplyResultDto,
  AlertTemplateListDto,
  BacktestResultDto,
  ChannelTestResult,
  LibraryChannelDto,
  RuleDerivedDto,
  RuleKpisDto,
  RuleStatsDto,
  StateCounts,
} from '@/components/alerts/alertTypes';
import type { EntityHealthSeriesPayload } from '@/components/tracing/health';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface AlertRulesResponse {
  rules?: AlertRuleDto[];
  meta?: AlertMeta;
  states?: Record<string, StateCounts>;
  derived?: Record<string, RuleDerivedDto>;
  stats?: Record<string, RuleStatsDto>;
  statsCapped?: boolean;
  kpis?: RuleKpisDto;
  total?: number;
}

export interface AlertHistoryResponse {
  events?: AlertEventDto[];
  activeCount?: number;
}

export interface UserDirectory {
  meId: string | null;
  meName: string | null;
  names: Record<string, string>;
}

export interface EntitySuggestion {
  key: string;
  requests: number;
  lastSeenMs: number;
}

export interface ScopeItem {
  key: string;
  name?: string;
}

export interface EntityRef {
  type: string;
  key: string;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const alertsKeys = {
  all: ['alerts'] as const,
  project: (project: string) => ['alerts', project] as const,
  /** The server's metric catalog and mode availability (`meta` of the rules answer). */
  meta: (project: string) => ['alerts', project, 'meta'] as const,
  /** Every rule list and every rule. */
  rules: (project: string) => ['alerts', project, 'rules'] as const,
  rulesList: (project: string, query: string) => ['alerts', project, 'rules', 'list', query] as const,
  rule: (project: string, id: string) => ['alerts', project, 'rules', 'detail', id] as const,
  templates: (project: string) => ['alerts', project, 'templates'] as const,
  history: (project: string, query: string) => ['alerts', project, 'history', query] as const,
  historyAll: (project: string) => ['alerts', project, 'history'] as const,
  library: (project: string) => ['alerts', project, 'channels', 'library'] as const,
  entities: (project: string, type: string, search: string) => ['alerts', project, 'entities', type, search] as const,
  /** The links known so far (one entry, grown by every lookup) and one lookup per set of entities. */
  entityLinks: (project: string, scope: string) => ['alerts', project, 'entity-links', scope] as const,
  entityLinkLookup: (project: string, scope: string, signature: string) =>
    ['alerts', project, 'entity-links', scope, 'lookup', signature] as const,
  scope: (project: string, url: string) => ['alerts', project, 'scope', url] as const,
  directory: (project: string) => ['alerts', project, 'directory'] as const,
  me: (project: string) => ['alerts', project, 'me'] as const,
  health: (project: string, agent: string, from: string, to: string) => ['alerts', project, 'health', agent, from, to] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const rulePath = (id: string) => `/api/alerts/rules/${encodeURIComponent(id)}`;
const libraryPath = (id: string) => `/api/alerts/channels/library/${encodeURIComponent(id)}`;

/* ── Shared cache helpers ────────────────────────────────────────────────── */

/** Changes `rule` inside every cached rule list of the project (the lists the screen holds are keyed by their filters). */
function patchRuleInLists(
  queryClient: QueryClient,
  project: string,
  id: string,
  patch: (rules: AlertRuleDto[]) => AlertRuleDto[],
): void {
  queryClient.setQueriesData<AlertRulesResponse>({ queryKey: [...alertsKeys.rules(project), 'list'] }, (current) =>
    current?.rules?.some((rule) => rule._id === id) ? { ...current, rules: patch(current.rules) } : current,
  );
}

/* ── Meta ────────────────────────────────────────────────────────────────── */

/**
 * The `meta` of `GET /alerts/rules` for the screens that do not list rules themselves. Kept for a minute; a failed
 * request is an error (not an answer), so the next screen asks again.
 */
export function useAlertMetaQuery(enabled: boolean) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.meta(project),
    queryFn: async ({ signal }) => {
      const data = await apiGet<{ meta?: AlertMeta }>('/api/alerts/rules', { signal });
      if (!data.meta) throw new Error('no meta');
      return data.meta;
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** The rules page already holds the meta; handing it over saves the other screens a request. */
export function usePrimeAlertMeta(): (meta: AlertMeta | null | undefined) => void {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useCallback(
    (meta) => {
      if (meta) queryClient.setQueryData(alertsKeys.meta(project), meta);
    },
    [queryClient, project],
  );
}

/* ── Rules ───────────────────────────────────────────────────────────────── */

/** `query` is the filter string of `buildRulesQuery`. A new filter keeps the rows on screen until its answer lands. */
export function useAlertRules(query: string) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.rulesList(project, query),
    queryFn: ({ signal }) => apiGet<AlertRulesResponse>(`/api/alerts/rules?${query}`, { signal }),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useAlertRule(ruleId: string | undefined) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.rule(project, ruleId ?? ''),
    queryFn: async ({ signal }) => (await apiGet<{ rule?: AlertRuleDto }>(rulePath(ruleId as string), { signal })).rule ?? null,
    enabled: Boolean(ruleId),
    retry: false,
    staleTime: 0,
  });
}

/** Replaces the cached rule behind an incident (the mute menu hands the server's answer back). */
export function useSetAlertRule(): (rule: AlertRuleDto | null) => void {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useCallback(
    (rule) => {
      if (rule) queryClient.setQueryData(alertsKeys.rule(project, rule._id), rule);
    },
    [queryClient, project],
  );
}

/** Switching a rule on or off shows at once and is undone when the server refuses. */
export function useToggleAlertRule() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  const flip = (id: string, enabled: boolean) =>
    patchRuleInLists(queryClient, project, id, (rules) => rules.map((rule) => (rule._id === id ? { ...rule, enabled } : rule)));
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiPatch<unknown>(rulePath(id), { enabled }),
    onMutate: ({ id, enabled }) => flip(id, enabled),
    onError: (_error, { id, enabled }) => flip(id, !enabled),
  });
}

export function useDeleteAlertRule() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(rulePath(id)),
    onSuccess: (_result, id) => {
      patchRuleInLists(queryClient, project, id, (rules) => rules.filter((rule) => rule._id !== id));
      queryClient.removeQueries({ queryKey: alertsKeys.rule(project, id) });
    },
  });
}

/** Mute / unmute: the server's rule replaces the cached one and the rule lists reload. */
export function useMuteAlertRule() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ id, until, reason }: { id: string; until: string | null; reason?: string }) =>
      (await apiPost<{ rule?: AlertRuleDto }>(`${rulePath(id)}/mute`, { until, ...(reason?.trim() ? { reason: reason.trim() } : {}) })).rule,
    onSuccess: (rule, { id }) => {
      if (rule) queryClient.setQueryData(alertsKeys.rule(project, id), rule);
      void queryClient.invalidateQueries({ queryKey: [...alertsKeys.rules(project), 'list'] });
    },
  });
}

/** Runs a rule over the last `days` days without saving it. */
export function useBacktestAlertRule() {
  return useMutation({
    mutationFn: ({ rule, days }: { rule: unknown; days: number }) => apiPost<BacktestResultDto>('/api/alerts/rules/backtest', { rule, days }),
  });
}

/* ── Templates ───────────────────────────────────────────────────────────── */

export function useAlertTemplates(options: { enabled?: boolean } = {}) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.templates(project),
    queryFn: ({ signal }) => apiGet<AlertTemplateListDto>('/api/alerts/templates', { signal }),
    enabled: options.enabled ?? true,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Admins of the active project that alert emails can reach (`null` while unknown). */
export function useProjectAdminRecipients(enabled: boolean): number | null {
  const query = useAlertTemplates({ enabled });
  return typeof query.data?.projectAdminRecipients === 'number' ? query.data.projectAdminRecipients : null;
}

export function useApplyAlertTemplates() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (keys: string[]) => apiPost<AlertTemplateApplyResultDto>('/api/alerts/templates', { keys }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: alertsKeys.templates(project) });
      void queryClient.invalidateQueries({ queryKey: alertsKeys.rules(project) });
    },
  });
}

/* ── History ─────────────────────────────────────────────────────────────── */

export function useAlertHistory(query: string) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.history(project, query),
    queryFn: ({ signal }) => apiGet<AlertHistoryResponse>(`/api/alerts/history?${query}`, { signal }),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useAcknowledgeAlertEvent() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiPatch<unknown>(`/api/alerts/history/${encodeURIComponent(id)}/acknowledge`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: alertsKeys.historyAll(project) }),
  });
}

/* ── Channel library ─────────────────────────────────────────────────────── */

/** `GET /alerts/channels/library` (masked entries with the rules that use them). */
export function useChannelLibraryQuery(enabled: boolean) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.library(project),
    queryFn: async ({ signal }) => (await apiGet<{ channels?: LibraryChannelDto[] }>('/api/alerts/channels/library', { signal })).channels ?? [],
    enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useSaveLibraryChannel() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: unknown }) =>
      id ? apiPatch<unknown>(libraryPath(id), body) : apiPost<unknown>('/api/alerts/channels/library', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: alertsKeys.library(project) }),
  });
}

export function useDeleteLibraryChannel() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(libraryPath(id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: alertsKeys.library(project) }),
  });
}

/**
 * Sends a test message: through a stored library entry (`id`, the server holds the secret) or with the destination
 * as typed (`body`). Resolves to the delivery result, or throws with the server's message.
 */
export function useTestChannel() {
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body?: unknown }): Promise<ChannelTestResult> => {
      const data = id
        ? await apiPost<{ result?: ChannelTestResult } | undefined>(`${libraryPath(id)}/test`, {})
        : await apiPost<{ result?: ChannelTestResult } | undefined>('/api/alerts/channels/test', body);
      // No result in the answer: the caller words it (an empty message falls back to its own text).
      if (!data?.result) throw new Error('');
      return data.result;
    },
  });
}

/* ── Who and what ────────────────────────────────────────────────────────── */

/** `GET /auth/me`: the signed-in user (any role). */
export function useAuthMe() {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.me(project),
    queryFn: ({ signal }) => apiGet<{ userId?: string; name?: string; role?: string }>('/api/auth/me', { signal }),
    retry: false,
    staleTime: 0,
  });
}

async function tryGet<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    return await apiGet<T>(url, { signal });
  } catch {
    return null;
  }
}

/**
 * Who the ids on an incident are: the signed-in user (`GET /auth/me`, any role) and, when the viewer may list people
 * (`GET /users`, administrators), everyone else. A lookup without even the viewer is a failure, so the next screen
 * asks again; a good one is kept for the session.
 */
export function useUserDirectoryQuery() {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.directory(project),
    queryFn: async ({ signal }): Promise<UserDirectory> => {
      const [me, users] = await Promise.all([
        tryGet<{ userId?: string; name?: string }>('/api/auth/me', signal),
        tryGet<{ users?: Array<{ _id?: unknown; name?: string; email?: string }> }>('/api/users', signal),
      ]);
      const names: Record<string, string> = {};
      for (const user of users?.users ?? []) {
        const id = user._id == null ? '' : String(user._id);
        const label = user.name || user.email;
        if (id && label) names[id] = label;
      }
      if (!me?.userId) throw new Error('no user');
      return { meId: me.userId, meName: me.name ?? null, names };
    },
    retry: false,
    staleTime: Infinity,
  });
}

/** The entities that have data in this project (`GET /alerts/entities`), searched server-side. */
export function useAlertEntities(entityType: string, search: string) {
  const [, project] = useResourceKey('alerts');
  const q = search.trim();
  return useQuery({
    queryKey: alertsKeys.entities(project, entityType, q),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ entityType, limit: '50' });
      if (q) params.set('q', q);
      const data = await apiGet<{ entities?: EntitySuggestion[] }>(`/api/alerts/entities?${params.toString()}`, { signal });
      return Array.isArray(data.entities) ? data.entities : [];
    },
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** One of the per-service lists behind the scope pickers of a legacy rule (`list` names the answer's property). */
export function useScopeItems(url: string, list: string) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.scope(project, url),
    queryFn: async ({ signal }) => {
      const data = await apiGet<Record<string, unknown>>(url, { signal });
      const items = Array.isArray(data[list]) ? (data[list] as ScopeItem[]) : [];
      return items.filter((item) => typeof item?.key === 'string' && item.key);
    },
    retry: false,
  });
}

const NO_ANSWERS: Record<string, string | null> = {};
const KNOWN_LINK_TYPES = new Set(['agent', 'model', 'kb', 'mcp', 'tool']);
const MAX_LINK_LOOKUP = 100;

/**
 * Where entities live (`POST /alerts/entities/links`): models, MCP servers and tools are addressed by record id, which
 * only the server can look up. The answers of every lookup collect in one cache entry per project and scope (a null
 * answer is kept: no console record); only entities not answered yet are asked for. `linkKey` builds the key of an
 * entity (`entityLinkKey`).
 */
export function useEntityLinkLookup(
  entities: EntityRef[],
  scope: string | undefined,
  linkKey: (type: string, key: string) => string,
): Record<string, string | null> {
  const queryClient = useQueryClient();
  const [, project] = useResourceKey('alerts');
  const scopeKey = scope ?? '';
  const baseKey = alertsKeys.entityLinks(project, scopeKey);

  const wanted = useMemo(() => {
    const seen = new Map<string, EntityRef>();
    for (const entity of entities) {
      if (!entity.key || !KNOWN_LINK_TYPES.has(entity.type)) continue;
      seen.set(linkKey(entity.type, entity.key), entity);
    }
    return [...seen.values()];
  }, [entities, linkKey]);

  // The shared entry: it holds the answers, and re-renders every screen that reads it when a lookup adds to it.
  const known = useQuery({
    queryKey: baseKey,
    queryFn: () => ({}) as Record<string, string | null>,
    enabled: false,
    staleTime: Infinity,
  });
  const answers = known.data ?? NO_ANSWERS;
  const missing = wanted.filter((entity) => !(linkKey(entity.type, entity.key) in answers)).slice(0, MAX_LINK_LOOKUP);
  const signature = [scopeKey, ...missing.map((entity) => linkKey(entity.type, entity.key))].join('\n');

  useQuery({
    queryKey: alertsKeys.entityLinkLookup(project, scopeKey, signature),
    queryFn: async ({ signal }) => {
      const body = {
        ...(scope ? { projectId: scope } : {}),
        entities: missing.map((entity) => ({ type: entity.type, key: entity.key })),
      };
      const data = await apiPost<{ links?: Record<string, string | null> }>('/api/alerts/entities/links', body, { signal });
      const links = data?.links ?? {};
      const merged = { ...(queryClient.getQueryData<Record<string, string | null>>(baseKey) ?? {}) };
      for (const [key, href] of Object.entries(links)) merged[key] = href ?? null;
      queryClient.setQueryData(baseKey, merged);
      return links;
    },
    enabled: missing.length > 0,
    retry: false,
    staleTime: Infinity,
  });

  return useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const entity of wanted) {
      const key = linkKey(entity.type, entity.key);
      if (key in answers) out[key] = answers[key] ?? null;
    }
    return out;
  }, [wanted, answers, linkKey]);
}

/** The entity-health series of an agent over a window (`GET /tracing/agents/:agent/health`). */
export function useIncidentHealthSeries(agent: string, from: string, to: string, enabled: boolean) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertsKeys.health(project, agent, from, to),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ from, to });
      return apiGet<EntityHealthSeriesPayload>(`/api/tracing/agents/${encodeURIComponent(agent)}/health?${query.toString()}`, { signal });
    },
    enabled: enabled && Boolean(agent),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  });
}
