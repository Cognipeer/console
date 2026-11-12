// @vitest-environment jsdom
/**
 * The Browser query hooks: project-scoped keys, what each mutation does to the cache, the error that reaches the
 * screen, and the workbench's calls that report an error answer instead of throwing.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  browserKeys,
  fetchSessionSnapshot,
  openWorkbenchSession,
  postSessionAction,
  useBrowserFlow,
  useBrowserFlowRun,
  useBrowserFlows,
  useBrowserSessions,
  useBrowsers,
  useCloseBrowserSession,
  useCreateBrowser,
  useDeleteBrowser,
  useRecordBrowserFlow,
  useUpdateBrowser,
  useUpdateBrowserFlow,
} from '@/lib/api/queries/browser';
import ArtifactBucketSelect from '@/components/browser/ArtifactBucketSelect';
import { isApiError } from '@/lib/api/client';
import { newTestQueryClient, renderWithQuery } from '../helpers/renderWithQuery';
import { installDomStubs, jsonResponse, settle as settleDom, text } from '../helpers/iamCenterUi';

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

describe('browser hooks', () => {
  let calls: Array<{ method: string; path: string; search: string; body: unknown }>;
  let browsers: Array<Record<string, unknown>>;
  let respond: ((method: string, url: URL) => Response | undefined) | undefined;

  beforeEach(() => {
    calls = [];
    browsers = [{ id: 'b1', name: 'One' }];
    respond = undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const url = new URL(input, 'http://localhost');
        calls.push({ method, path: url.pathname, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const custom = respond?.(method, url);
        if (custom) return custom;
        if (method === 'GET' && url.pathname === '/api/browser/browsers') return jsonResponse({ browsers });
        if (method === 'POST' && url.pathname === '/api/browser/browsers') {
          browsers.push({ id: 'b2', name: 'Two' });
          return jsonResponse({ browser: { id: 'b2', name: 'Two' } }, 201);
        }
        if (method === 'PATCH' && url.pathname === '/api/browser/browsers/b1') return jsonResponse({ browser: { id: 'b1', name: 'Renamed' } });
        if (method === 'DELETE' && url.pathname === '/api/browser/browsers/b1') {
          browsers.splice(0, browsers.length);
          return jsonResponse({ success: true });
        }
        return jsonResponse({ error: `no mock for ${method} ${url.pathname}` }, 404);
      }),
    );
  });

  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(browserKeys.browserList('project:3', 'active')).toEqual(['browser', 'project:3', 'browsers', 'list', 'active']);
    const browsersKey = browserKeys.browsers('project:3');
    expect(browserKeys.browser('project:3', 'b1').slice(0, 3)).toEqual([...browsersKey]);
    expect(browserKeys.sessionEvents('project:3', 's1').slice(0, 3)).toEqual([...browserKeys.sessions('project:3')]);
    expect(browserKeys.flowRuns('project:3', 'f1').slice(0, 3)).toEqual([...browserKeys.flows('project:3')]);
    expect(browserKeys.flowList('project:3', '').slice(0, 4)).toEqual([...browserKeys.flowLists('project:3')]);
  });

  it('create refreshes the list; update puts the saved browser in the cache; delete drops it', async () => {
    // Keeps entries nobody observes: the saved browser's detail entry is read back below, and a
    // zero gcTime could collect it first on a slow runner.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity }, mutations: { retry: false } } });
    const probe = await renderHook(client, () => ({
      list: useBrowsers(),
      create: useCreateBrowser(),
      update: useUpdateBrowser(),
      remove: useDeleteBrowser(),
    }));
    await settle();
    expect(probe.current.list.data).toEqual([{ id: 'b1', name: 'One' }]);

    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'Two' });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/browser/browsers')).toHaveLength(2);
    expect(probe.current.list.data).toHaveLength(2);

    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'b1', name: 'Renamed' });
    });
    expect(client.getQueryData(browserKeys.browser(getProjectScope(), 'b1'))).toEqual({ id: 'b1', name: 'Renamed' });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed' });

    client.setQueryData(browserKeys.browser(getProjectScope(), 'b1'), { id: 'b1', name: 'x' });
    await act(async () => {
      await probe.current.remove.mutateAsync('b1');
    });
    await settle();
    expect(client.getQueryData(browserKeys.browser(getProjectScope(), 'b1'))).toBeUndefined();
    expect(probe.current.list.data).toEqual([]);
  });

  it('asks only for the active browsers when told to', async () => {
    const client = newTestQueryClient();
    await renderHook(client, () => useBrowsers({ status: 'active' }));
    await settle();
    expect(calls[0].search).toBe('?status=active');
    expect(client.getQueryData(browserKeys.browserList(getProjectScope(), 'active'))).toEqual([{ id: 'b1', name: 'One' }]);
  });

  it('a failed save keeps the server message, and the saved flow lands in the cache', async () => {
    respond = (method, url) =>
      method === 'PATCH' && url.pathname === '/api/browser/flows/f1'
        ? jsonResponse({ flow: { id: 'f1', name: 'Saved' } })
        : method === 'GET' && url.pathname === '/api/browser/flows/f1'
          ? jsonResponse({ error: 'Flow not found' }, 404)
          : undefined;
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ flow: useBrowserFlow('f1'), save: useUpdateBrowserFlow('f1') }));
    await settle();
    expect(probe.current.flow.isError).toBe(true);
    expect((probe.current.flow.error as Error).message).toBe('Flow not found');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1); // a refusal is final: no retry

    await act(async () => {
      await probe.current.save.mutateAsync({ status: 'active' });
    });
    expect(client.getQueryData(browserKeys.flow(getProjectScope(), 'f1'))).toEqual({ id: 'f1', name: 'Saved' });
  });

  it('closing a session reads the session lists again; recording a flow reads the flows again', async () => {
    respond = (method, url) => {
      if (method === 'GET' && url.pathname === '/api/browser/sessions') return jsonResponse({ sessions: [] });
      if (method === 'GET' && url.pathname === '/api/browser/flows') return jsonResponse({ flows: [] });
      if (method === 'DELETE' && url.pathname === '/api/browser/sessions/key-1') return jsonResponse({ success: true });
      if (method === 'POST' && url.pathname === '/api/browser/flows/record') return jsonResponse({ flow: { id: 'f9', steps: [] } }, 201);
      return undefined;
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity }, mutations: { retry: false } } });
    const probe = await renderHook(client, () => ({
      sessions: useBrowserSessions('browserId=b1'),
      flows: useBrowserFlows(),
      close: useCloseBrowserSession(),
      record: useRecordBrowserFlow(),
    }));
    await settle();
    const gets = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;
    expect(gets('/api/browser/sessions')).toBe(1);
    expect(calls[0].search).toBe('?browserId=b1');
    expect(gets('/api/browser/flows')).toBe(1);

    await act(async () => {
      await probe.current.close.mutateAsync('key-1');
    });
    await settle();
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/browser/sessions/key-1');
    expect(gets('/api/browser/sessions')).toBe(2);
    expect(gets('/api/browser/flows')).toBe(1);

    await act(async () => {
      await probe.current.record.mutateAsync({ sessionId: 's1', name: 'Recorded' });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ sessionId: 's1', name: 'Recorded' });
    expect(gets('/api/browser/flows')).toBe(2);
    expect(gets('/api/browser/sessions')).toBe(2);
  });

  it('reads a run only while one is watched', async () => {
    respond = () => jsonResponse({ run: { id: 'r1', status: 'succeeded' } });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ idle: useBrowserFlowRun(null), watched: useBrowserFlowRun('r1') }));
    await settle();
    expect(calls.map((c) => c.path)).toEqual(['/api/browser/flow-runs/r1']);
    expect(probe.current.idle.fetchStatus).toBe('idle');
    expect(probe.current.watched.data).toEqual({ id: 'r1', status: 'succeeded' });
  });

  describe('the workbench calls', () => {
    it('hand back a failed action answer instead of throwing', async () => {
      respond = () => jsonResponse({ result: { ok: false, errorMessage: 'Element not found' } }, 422);
      await expect(postSessionAction('k 1', 'actions', { type: 'click' })).resolves.toEqual({
        ok: false,
        data: { result: { ok: false, errorMessage: 'Element not found' } },
      });
      expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/browser/sessions/k%201/actions', body: { type: 'click' } });
    });

    it('read no snapshot from a session that answers an error, and say why a session could not open', async () => {
      respond = (method, url) =>
        url.pathname.endsWith('/snapshot')
          ? jsonResponse({ error: 'closed' }, 409)
          : jsonResponse({ code: 'plan_limit_exceeded', error: 'No free browser session' }, 429);
      await expect(fetchSessionSnapshot('k1')).resolves.toBeNull();
      const failure = await openWorkbenchSession('b1', 'playground').catch((error: unknown) => error);
      expect(isApiError(failure)).toBe(true);
      expect(isApiError(failure) && failure.status).toBe(429);
      expect(isApiError(failure) && failure.payload).toMatchObject({ code: 'plan_limit_exceeded' });
    });
  });

  describe('the artifact bucket picker', () => {
    beforeEach(() => installDomStubs());

    it('says why the buckets could not be read, with the server message', async () => {
      respond = () => jsonResponse({ error: 'Files are off for this plan' }, 403);
      const rendered = await renderWithQuery(h(ArtifactBucketSelect, { value: '', onChange: () => undefined, emptyLabel: 'Default bucket' }));
      await settleDom(50);
      expect(text()).toContain('Files are off for this plan');
      expect(calls[0].path).toBe('/api/files/buckets');
      await rendered.unmount();
    });

    it('offers the project buckets', async () => {
      respond = () => jsonResponse({ buckets: [{ key: 'docs', name: 'Docs' }] });
      const rendered = await renderWithQuery(h(ArtifactBucketSelect, { value: 'docs', onChange: () => undefined, emptyLabel: 'Default bucket' }));
      await settleDom(50);
      expect(text()).not.toContain('Loading buckets');
      await rendered.unmount();
    });
  });
});
