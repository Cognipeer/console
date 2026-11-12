'use client';

/**
 * React Query hooks of the incident screens (the inbox, an incident, its delivery log and similar incidents).
 * The keys (`alertIncidentKeys`) are under `['alerts', <project>, 'incidents', ...]`, the prefix of the other alert
 * hooks in `alerts.ts`.
 *
 * The inbox keeps itself current the way it did before: a cheap probe every 15 s asks whether anything changed since
 * the last answer (`useIncidentProbe`), a change reloads the list and the stats, and the stats refresh every minute.
 * Every action that changes an incident reloads the lists and the stats the screen shows.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type {
  IncidentCounts,
  IncidentDto,
  IncidentStatsDto,
  SimilarIncidentsDto,
} from '@/components/alerts/alertTypes';
import type { DeliveryDto } from '@/components/alerts/incident/incidentModel';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/** How often the inbox asks whether anything changed, and how often its stats refresh. */
export const INCIDENT_POLL_MS = 15_000;
export const INCIDENT_STATS_REFRESH_MS = 60_000;

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface IncidentListResponse {
  incidents?: IncidentDto[];
  total?: number;
  hasMore?: boolean;
  counts?: IncidentCounts;
  /** Incidents open right now (the overview card reads it). */
  openCount?: number;
  serverTime?: string;
}

export interface BulkIncidentResult {
  updated?: number;
  failed?: Array<{ id: string; error: string }>;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

const incidentsPrefix = (project: string) => ['alerts', project, 'incidents'] as const;

export const alertIncidentKeys = {
  all: incidentsPrefix,
  lists: (project: string) => [...incidentsPrefix(project), 'list'] as const,
  list: (project: string, query: string) => [...incidentsPrefix(project), 'list', query] as const,
  stats: (project: string, range: string) => [...incidentsPrefix(project), 'stats', range] as const,
  probe: (project: string) => [...incidentsPrefix(project), 'probe'] as const,
  /** An incident, its delivery log and its similar incidents. */
  detail: (project: string, id: string) => [...incidentsPrefix(project), 'detail', id] as const,
  deliveries: (project: string, id: string, refreshKey: string) =>
    [...incidentsPrefix(project), 'detail', id, 'deliveries', refreshKey] as const,
  similar: (project: string, id: string) => [...incidentsPrefix(project), 'detail', id, 'similar'] as const,
};

const incidentPath = (id: string) => `/api/alerts/incidents/${encodeURIComponent(id)}`;

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** `query` is the string of `listQuery` (filters, page, size). A new filter keeps the rows until its answer lands. */
export function useIncidentList(query: string) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertIncidentKeys.list(project, query),
    queryFn: ({ signal }) => apiGet<IncidentListResponse>(`/api/alerts/incidents?${query}`, { signal }),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

export function useIncidentStats(range: string) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertIncidentKeys.stats(project, range),
    queryFn: ({ signal }) => apiGet<IncidentStatsDto>(`/api/alerts/incidents/stats?range=${range}`, { signal }),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
    ...pollingOptions<IncidentStatsDto>(() => true, INCIDENT_STATS_REFRESH_MS),
  });
}

/**
 * "Anything changed since `getSince()`?": one row at most, every 15 s while the tab is visible and `live` holds.
 * The screen reads the answer (`data`, `dataUpdatedAt`) and reloads its list when a row came back.
 */
export function useIncidentProbe(options: { live: boolean; ready: boolean; getSince: () => string | null }) {
  const [, project] = useResourceKey('alerts');
  const { live, ready, getSince } = options;
  return useQuery({
    queryKey: alertIncidentKeys.probe(project),
    queryFn: ({ signal }) => {
      const since = getSince();
      if (!since) return Promise.resolve<IncidentListResponse>({});
      return apiGet<IncidentListResponse>(`/api/alerts/incidents?updatedAfter=${encodeURIComponent(since)}&limit=1`, { signal });
    },
    enabled: live && ready,
    // Seeded as "just asked, nothing changed": the first probe comes one interval after the list loaded, as it always did.
    initialData: {} as IncidentListResponse,
    initialDataUpdatedAt: () => Date.now(),
    staleTime: INCIDENT_POLL_MS,
    retry: false,
    gcTime: 0,
    ...pollingOptions<IncidentListResponse>(() => live, INCIDENT_POLL_MS),
  });
}

/** One incident. `enabled: false` waits (the inbox only asks for a highlighted incident that is not on its page). */
export function useIncident(id: string | undefined, enabled = true) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertIncidentKeys.detail(project, id ?? ''),
    queryFn: async ({ signal }) => (await apiGet<{ incident: IncidentDto }>(incidentPath(id as string), { signal })).incident,
    enabled: Boolean(id) && enabled,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The notification attempts of an incident; `refreshKey` changes with the incident, and the old log stays until the new one lands. */
export function useIncidentDeliveries(id: string, refreshKey: string) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertIncidentKeys.deliveries(project, id, refreshKey),
    queryFn: async ({ signal }) => (await apiGet<{ deliveries?: DeliveryDto[] }>(`${incidentPath(id)}/deliveries`, { signal })).deliveries ?? [],
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  });
}

export function useSimilarIncidents(id: string) {
  const [, project] = useResourceKey('alerts');
  return useQuery({
    queryKey: alertIncidentKeys.similar(project, id),
    queryFn: ({ signal }) => apiGet<SimilarIncidentsDto>(`${incidentPath(id)}/similar`, { signal }),
    retry: false,
    staleTime: 0,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useReloadIncidentLists() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: alertIncidentKeys.lists(project) }),
      queryClient.invalidateQueries({ queryKey: [...alertIncidentKeys.all(project), 'stats'] }),
    ]);
}

/** A status change, an assignment or a snooze: the server's incident replaces the cached one, the lists and stats reload. */
export function useUpdateIncident() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  const reload = useReloadIncidentLists();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      (await apiPatch<{ incident: IncidentDto }>(incidentPath(id), body)).incident,
    onSuccess: (incident, { id }) => {
      queryClient.setQueryData(alertIncidentKeys.detail(project, id), incident);
      void reload();
    },
  });
}

export function useAddIncidentNote() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) =>
      (await apiPost<{ incident: IncidentDto }>(`${incidentPath(id)}/notes`, { content })).incident,
    onSuccess: (incident, { id }) => {
      queryClient.setQueryData(alertIncidentKeys.detail(project, id), incident);
    },
  });
}

/** One action on several incidents: every cached incident may have changed, and the lists and stats reload. */
export function useBulkIncidents() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  const reload = useReloadIncidentLists();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<BulkIncidentResult>('/api/alerts/incidents/bulk', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...alertIncidentKeys.all(project), 'detail'], refetchType: 'none' });
      void reload();
    },
  });
}
