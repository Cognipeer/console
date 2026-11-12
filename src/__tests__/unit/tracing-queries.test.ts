// @vitest-environment jsdom
/**
 * The tracing query hooks: project-scoped keys, the request each hook makes, the error that reaches the screen,
 * and the trail of page starts the session and thread lists page with.
 */

import { act, createElement as h, useReducer, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  tracingKeys,
  useRememberPageStart,
  useSkipTrail,
  useTracingAgentOverview,
  useTracingDashboard,
  useTracingFlowOptions,
  useTracingSessionEvent,
  useTracingSessions,
  useTracingThreadSession,
} from '@/lib/api/queries/tracing';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { jsonResponse } from '../helpers/iamCenterUi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

async function renderHook<T>(client: QueryClient, hook: () => T): Promise<{ current: T }> {
  const result = { current: undefined as T };
  function Probe() {
    useReducer((n: number) => n + 1, 0);
    result.current = hook();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(QueryClientProvider, { client }, h(Probe)));
  });
  return result;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe('tracing hooks', () => {
  let calls: Array<{ method: string; url: string }>;
  let respond: (url: URL) => Response;

  beforeEach(() => {
    calls = [];
    respond = () => jsonResponse({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url: input });
        return respond(new URL(input, 'http://localhost'));
      }),
    );
  });

  it('keys start with the resource and the project marker, and a session is a prefix of its events', () => {
    expect(tracingKeys.dashboard('project:2', 'period=last_day')).toEqual(['tracing', 'project:2', 'dashboard', 'period=last_day']);
    const session = tracingKeys.session('project:2', 's1');
    expect(tracingKeys.sessionEvent('project:2', 's1', 'e1').slice(0, session.length)).toEqual([...session]);
    for (const key of [
      tracingKeys.agentHealth('p', 'q'),
      tracingKeys.agentDirectory('p', 200),
      tracingKeys.agentOverview('p', 'a', 'q'),
      tracingKeys.sessions('p', 'q'),
      tracingKeys.threads('p', 'q'),
      tracingKeys.thread('p', 't'),
      tracingKeys.threadSession('p', 's'),
      tracingKeys.flowOptions('p'),
    ]) {
      expect(key.slice(0, 2)).toEqual(['tracing', 'p']);
    }
  });

  it('caches under the current project marker', async () => {
    respond = () => jsonResponse({ analytics: null });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useTracingDashboard('period=last_day'));
    await settle();
    expect(probe.current.data).toEqual({ analytics: null });
    expect(client.getQueryData(tracingKeys.dashboard(getProjectScope(), 'period=last_day'))).toEqual({ analytics: null });
    expect(calls[0].url).toBe('/api/tracing/dashboard?period=last_day');
  });

  it('asks for an agent by its encoded name, and a failed read carries the server message', async () => {
    respond = () => jsonResponse({ error: 'overview exploded' }, 500);
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useTracingAgentOverview('Pulse Main', 'period=last_day'));
    await settle();
    expect(calls[0].url).toBe('/api/tracing/agents/Pulse%20Main/overview?period=last_day');
    expect(probe.current.isError).toBe(true);
    expect((probe.current.error as Error).message).toBe('overview exploded');
  });

  it('does not ask for an event until one is selected, and reads each event once', async () => {
    respond = (url) => jsonResponse({ event: { id: url.pathname.split('/').pop() } });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      none: useTracingSessionEvent('s1', null),
      one: useTracingSessionEvent('s1', 'e 1'),
    }));
    await settle();
    expect(calls.map((c) => c.url)).toEqual(['/api/tracing/sessions/s1/events/e%201']);
    expect(probe.current.none.fetchStatus).toBe('idle');
    expect(probe.current.one.data).toEqual({ event: { id: 'e%201' } });
  });

  it('reads a thread session only for the selected session', async () => {
    respond = () => jsonResponse({ events: [] });
    const client = newTestQueryClient();
    await renderHook(client, () => ({
      off: useTracingThreadSession<unknown>(null, () => false),
      on: useTracingThreadSession<unknown>('s/1', () => false),
    }));
    await settle();
    expect(calls.map((c) => c.url)).toEqual(['/api/tracing/sessions/s%2F1']);
  });

  it('offers no flow filter when the flows are not part of the edition', async () => {
    respond = () => jsonResponse({ error: 'not found' }, 404);
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useTracingFlowOptions());
    await settle();
    expect(probe.current.data).toBeUndefined();
    expect(calls).toHaveLength(1); // a refusal is final: no retry

    respond = () => jsonResponse({ items: [{ id: 'f1', name: 'Flow One' }] });
    const other = newTestQueryClient();
    const second = await renderHook(other, () => useTracingFlowOptions());
    await settle();
    expect(second.current.data).toEqual([{ value: 'f1', label: 'Flow One' }]);
  });

  it('pages with the starts the server gave, and starts the trail over with the filters', async () => {
    respond = (url) => {
      const skip = url.searchParams.get('skip');
      return jsonResponse({ sessions: [{ id: `row-${skip}` }], hasMore: true, nextSkip: skip === '0' ? 40 : 80 });
    };
    const client = newTestQueryClient();
    let setPage: (page: number) => void = () => undefined;
    let setFilter: (filter: string) => void = () => undefined;
    const probe = await renderHook(client, () => {
      const [page, setPageState] = useState(1);
      const [filter, setFilterState] = useState('a');
      setPage = setPageState;
      setFilter = setFilterState;
      const trail = useSkipTrail(filter);
      const skip = trail.skipFor(page, 25);
      const query = useTracingSessions<{ sessions: Array<{ id: string }>; hasMore?: boolean; nextSkip?: number | null }>(
        `limit=25&skip=${skip}&status=${filter}`,
      );
      useRememberPageStart(trail, page, query.data, query.isPlaceholderData);
      return { skip, query, trail };
    });
    await settle();
    expect(probe.current.query.data?.sessions).toEqual([{ id: 'row-0' }]);

    // The server said page 2 starts at 40, not at 25.
    await act(async () => setPage(2));
    expect(probe.current.skip).toBe(40);
    await settle();
    expect(probe.current.query.data?.sessions).toEqual([{ id: 'row-40' }]);
    expect(calls.map((c) => new URL(c.url, 'http://localhost').searchParams.get('skip'))).toEqual(['0', '40']);

    // Another filter is another list: page 2 starts where arithmetic says again.
    await act(async () => setFilter('b'));
    expect(probe.current.skip).toBe(25);
  });
});
