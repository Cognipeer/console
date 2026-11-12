// @vitest-environment jsdom
/**
 * The Resources query hooks: their keys, the request they send and what a refresh does to the cache.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  healthQueryString,
  listQueryString,
  resourcesKeys,
  useRefreshResourceList,
  useResourceDetail,
  useResourceHealth,
  useResourceList,
} from '@/lib/api/queries/resources';
import { getProjectScope } from '@/lib/api/queries/projectScope';
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

describe('Resources hooks', () => {
  let calls: Array<{ method: string; path: string; search: string }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const url = new URL(input, 'http://localhost');
        calls.push({ method, path: url.pathname, search: url.search });
        if (url.pathname === '/api/resources') {
          return jsonResponse({ items: [], refreshed: url.searchParams.get('refresh') === '1' });
        }
        if (url.pathname === '/api/resources/health') return jsonResponse({ summary: { error: 1, warning: 0 }, issues: [] });
        if (url.pathname === '/api/resources/agent/a1') return jsonResponse({ resource: { id: 'a1', name: 'Agent' } });
        return jsonResponse({ error: 'Resource not found' }, 404);
      }),
    );
  });

  it('builds the list query string in the order the explorer always sent it', () => {
    expect(listQueryString({ limit: 50, offset: 0 })).toBe('limit=50&offset=0');
    expect(
      listQueryString({ type: 'agent', projectId: 'p1', q: ' x ', status: 'ok', onlyIssues: true, limit: 25, offset: 50 }, true),
    ).toBe('type=agent&projectId=p1&q=x&status=ok&health=issues&limit=25&offset=50&refresh=1');
    expect(healthQueryString({ severity: 'error', type: 'agent' })).toBe('severity=error&type=agent');
    expect(healthQueryString({})).toBe('');
  });

  it('keys start with the resource and the project marker', () => {
    const prefix = [...resourcesKeys.project('project:2')];
    expect(resourcesKeys.list('project:2', 'limit=1').slice(0, 2)).toEqual(prefix);
    expect(resourcesKeys.health('project:2', '').slice(0, 2)).toEqual(prefix);
    expect(resourcesKeys.detail('project:2', 'agent', 'a1')).toEqual(['resources', 'project:2', 'detail', 'agent', 'a1']);
  });

  it('a refresh asks for refresh=1, puts the answer in the list cache and reads the health report again', async () => {
    const client = newTestQueryClient();
    const params = { limit: 50, offset: 0 };
    const probe = await renderHook(client, () => ({
      list: useResourceList<{ refreshed?: boolean }>(params),
      health: useResourceHealth<{ summary: { error: number } }>(),
      refresh: useRefreshResourceList<{ refreshed?: boolean }>(),
    }));
    await settle();
    expect(probe.current.list.data?.refreshed).toBe(false);
    expect(probe.current.health.data?.summary.error).toBe(1);

    await act(async () => {
      await probe.current.refresh.mutateAsync(params);
    });
    await settle();
    expect(calls.some((c) => c.path === '/api/resources' && c.search === '?limit=50&offset=0&refresh=1')).toBe(true);
    expect(client.getQueryData(resourcesKeys.list(getProjectScope(), listQueryString(params)))).toMatchObject({ refreshed: true });
    expect(calls.filter((c) => c.path === '/api/resources/health')).toHaveLength(2);
    // the refresh itself did not start a second ordinary list read
    expect(calls.filter((c) => c.path === '/api/resources' && !c.search.includes('refresh'))).toHaveLength(1);
  });

  it('reads one resource only when it is selected, and a missing one is an error with the status', async () => {
    const client = newTestQueryClient();
    const none = await renderHook(client, () => useResourceDetail<{ id: string }>(undefined, undefined));
    await settle();
    expect(calls).toHaveLength(0);
    expect(none.current.isPending).toBe(true);

    await act(async () => root?.unmount());
    host?.remove();
    const found = await renderHook(client, () => useResourceDetail<{ id: string }>('agent', 'a1'));
    await settle();
    expect(found.current.data).toEqual({ id: 'a1', name: 'Agent' });

    await act(async () => root?.unmount());
    host?.remove();
    const missing = await renderHook(client, () => useResourceDetail<{ id: string }>('agent', 'zzz'));
    await settle();
    expect(missing.current.error).toMatchObject({ status: 404 });
  });
});
