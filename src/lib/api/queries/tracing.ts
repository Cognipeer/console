'use client';

/**
 * React Query hooks of the tracing screens (overview, agents, sessions, threads).
 *
 * - Every key starts `['tracing', <project>, ...]` (`tracingKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's traces.
 * - Traces are written by the agents' SDKs, not by these screens, so every list and detail refetches on a visit
 *   (`staleTime: 0`); a session or thread that is still running is polled.
 * - The response types belong to the screens that draw them: the hooks take the type as a parameter.
 * - The session pages that stream stay on their own transport; nothing here streams.
 *
 * The routes are the dashboard's `/api/tracing` plugin (`src/server/api/plugins/tracing.ts`) and `/api/flows`.
 */

import { useEffect, useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api/client';
import { SkipTrail, type OffsetPageInfo } from '@/lib/shared/offsetPaging';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useResourceKey } from './projectScope';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const tracingKeys = {
  all: ['tracing'] as const,
  project: (project: string) => ['tracing', project] as const,
  dashboard: (project: string, query: string) => ['tracing', project, 'dashboard', query] as const,
  agentHealth: (project: string, query: string) => ['tracing', project, 'agents', 'health', query] as const,
  agentDirectory: (project: string, limit: number) => ['tracing', project, 'agents', 'directory', limit] as const,
  agentOverview: (project: string, agentName: string, query: string) =>
    ['tracing', project, 'agents', 'overview', agentName, query] as const,
  sessions: (project: string, query: string) => ['tracing', project, 'sessions', 'list', query] as const,
  /** The session and its events' details. */
  session: (project: string, sessionId: string) => ['tracing', project, 'sessions', 'detail', sessionId] as const,
  sessionEvent: (project: string, sessionId: string, eventId: string) =>
    ['tracing', project, 'sessions', 'detail', sessionId, 'event', eventId] as const,
  /** A session read with its events in full, as the thread page lists them. */
  threadSession: (project: string, sessionId: string) => ['tracing', project, 'threads', 'session', sessionId] as const,
  threads: (project: string, query: string) => ['tracing', project, 'threads', 'list', query] as const,
  thread: (project: string, threadId: string) => ['tracing', project, 'threads', 'detail', threadId] as const,
  flowOptions: (project: string) => ['tracing', project, 'flow-options'] as const,
};

/* ── Fetchers ────────────────────────────────────────────────────────────── */

const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

/* ── Overview and agents ─────────────────────────────────────────────────── */

/** The tracing overview for a period; `query` is the date filter's search params plus the timezone. */
export function useTracingDashboard<T>(query: string) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.dashboard(project, query),
    queryFn: ({ signal }) => apiGet<T>(`/api/tracing/dashboard?${query}`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    // A filter change keeps the page in place until the new period arrives.
    placeholderData: keepPreviousData,
  });
}

/** The agents' health overview for a period (the agents list). */
export function useTracingAgentsHealth<T>(query: string) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.agentHealth(project, query),
    queryFn: ({ signal }) => apiGet<T>(`/api/tracing/agents/health?${query}`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

/** The agent directory (latest status per agent): independent of the period. */
export function useTracingAgentDirectory<T>(limit: number) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.agentDirectory(project, limit),
    queryFn: ({ signal }) => apiGet<T>(`/api/tracing/agents?limit=${limit}`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** One agent's overview for a period. */
export function useTracingAgentOverview<T>(agentName: string, query: string) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.agentOverview(project, agentName, query),
    queryFn: ({ signal }) =>
      apiGet<T>(`/api/tracing/agents/${encodeURIComponent(agentName)}/overview?${query}`, { signal }),
    enabled: Boolean(agentName),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

/* ── Sessions ────────────────────────────────────────────────────────────── */

/** A page of sessions; `query` carries the filters and `limit` / `skip`. */
export function useTracingSessions<T extends OffsetPageInfo>(query: string) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.sessions(project, query),
    queryFn: ({ signal }) => apiGet<T>(withQuery('/api/tracing/sessions', query), { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    // The rows of the last page stay until the next page (or filter) answers.
    placeholderData: keepPreviousData,
  });
}

/** The flows a session list can be narrowed to. Where Flows are not part of the edition the filter is not offered. */
export function useTracingFlowOptions() {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.flowOptions(project),
    queryFn: async ({ signal }) => {
      // Answers 404 / 402 where Flows are not part of the edition or the license: no options then.
      const result = await apiGet<{ items?: Array<{ id: string; name: string }> }>('/api/flows?limit=200', { signal });
      return (result?.items ?? []).map((flow) => ({ value: flow.id, label: flow.name }));
    },
    retry: false,
  });
}

/**
 * One session without the events' content; a session that is still running (or paused) is read again every 5 s.
 * `isRunning` tells from the data whether it is.
 */
export function useTracingSession<T>(sessionId: string, isRunning: (data: T | undefined) => boolean) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.session(project, sessionId),
    queryFn: ({ signal }) =>
      apiGet<T>(`/api/tracing/sessions/${sessionId}?includeEventContent=false`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<T>(isRunning, 5000),
  });
}

/** One event of a session in full. An event is read once per visit of the page. */
export function useTracingSessionEvent<T>(sessionId: string, eventId: string | null) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.sessionEvent(project, sessionId, eventId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<T>(`/api/tracing/sessions/${sessionId}/events/${encodeURIComponent(eventId as string)}`, { signal }),
    enabled: Boolean(eventId),
    retry: retryUnlessClientError,
    staleTime: Infinity,
    refetchOnMount: 'always',
  });
}

/* ── Threads ─────────────────────────────────────────────────────────────── */

/** A page of threads; `query` carries the filters and `limit` / `skip`. */
export function useTracingThreads<T extends OffsetPageInfo>(query: string) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.threads(project, query),
    queryFn: ({ signal }) => apiGet<T>(withQuery('/api/tracing/threads', query), { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

/** One thread; read again every 4 s while `isRunning` says one of its sessions still is. */
export function useTracingThread<T>(threadId: string, isRunning: (data: T | undefined) => boolean) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.thread(project, threadId),
    queryFn: ({ signal }) => apiGet<T>(`/api/tracing/threads/${encodeURIComponent(threadId)}`, { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<T>(isRunning, 4000),
  });
}

/** A thread's session with its events, read again every 4 s while `isRunning` says it still runs. */
export function useTracingThreadSession<T>(sessionId: string | null, isRunning: (data: T | undefined) => boolean) {
  const [, project] = useResourceKey('tracing');
  return useQuery({
    queryKey: tracingKeys.threadSession(project, sessionId ?? ''),
    queryFn: ({ signal }) => apiGet<T>(`/api/tracing/sessions/${encodeURIComponent(sessionId as string)}`, { signal }),
    enabled: Boolean(sessionId),
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions<T>(isRunning, 4000),
  });
}

/* ── Paging ──────────────────────────────────────────────────────────────── */

/**
 * Where each page of a filtered list starts. `filterKey` stands for the filters: another search is another list,
 * and the pages of the last one no longer say where this one's start.
 */
export function useSkipTrail(filterKey: string): SkipTrail {
  const trail = useRef(new SkipTrail());
  const seenFilter = useRef(filterKey);
  // Idempotent, so it may run on any render: it replaces an effect that would run after the query key was built.
  if (seenFilter.current !== filterKey) {
    trail.current.reset();
    seenFilter.current = filterKey;
  }
  return trail.current;
}

/**
 * Remembers where the page after `page` starts, from each page the server answered (not from the rows that are
 * only kept on screen while the next page loads).
 */
export function useRememberPageStart(
  trail: SkipTrail,
  page: number,
  data: OffsetPageInfo | undefined,
  isPlaceholderData: boolean,
): void {
  useEffect(() => {
    if (data && !isPlaceholderData) trail.remember(page, data);
  }, [trail, page, data, isPlaceholderData]);
}
