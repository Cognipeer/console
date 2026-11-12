// @vitest-environment jsdom
/**
 * The PII query hooks: their keys, what each mutation does to the cache, and what a failed request tells the screen.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  piiKeys,
  useCreatePiiPolicy,
  useDeletePiiPolicy,
  useLoadPiiCatalog,
  usePiiCatalog,
  usePiiPolicy,
  usePiiPolicyList,
  usePiiPolicyOptions,
  usePiiScan,
  useTogglePiiPolicy,
  useUpdatePiiPolicy,
} from '@/lib/api/queries/pii';
import { jsonResponse } from '../helpers/iamCenterUi';

/** No retries, and nothing is collected: a cache entry a test sets stays until a mutation removes it. */
const newTestQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });

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

type Call = { method: string; path: string; search: string; body: unknown };

function stubFetch(handler: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const call: Call = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        search: url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call) ?? jsonResponse({ error: `no mock for ${call.method} ${call.path}` }, 404);
    }),
  );
  return calls;
}

describe('PII hooks', () => {
  const policy = { id: 'p1', key: 'tc-only', name: 'TC only', enabled: true, defaultAction: 'detect', categories: {} };

  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(piiKeys.list('project:3')).toEqual(['pii', 'project:3', 'list']);
    expect(piiKeys.detail('project:3', 'p1')).toEqual(['pii', 'project:3', 'detail', 'p1']);
    expect(piiKeys.catalog('project:3', 'en', 'regex').slice(0, 2)).toEqual(['pii', 'project:3']);
  });

  it('create and delete refresh the list; delete drops the policy from the cache', async () => {
    let policies: Array<Record<string, unknown>> = [policy];
    const calls = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/api/pii/policies') return jsonResponse({ policies });
      if (method === 'POST' && path === '/api/pii/policies') {
        policies = [...policies, { ...policy, id: 'p2', key: 'new', name: (body as { name: string }).name }];
        return jsonResponse({ policy: policies[1] }, 201);
      }
      if (method === 'DELETE' && path === '/api/pii/policies/p1') {
        policies = [];
        return jsonResponse({ success: true });
      }
      return undefined;
    });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      list: usePiiPolicyList(),
      create: useCreatePiiPolicy(),
      remove: useDeletePiiPolicy(),
    }));
    await settle();
    expect(probe.current.list.data).toHaveLength(1);

    await act(async () => {
      const created = await probe.current.create.mutateAsync({ name: 'Two', defaultAction: 'detect', engine: 'regex', enabled: true });
      expect(created.id).toBe('p2');
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Two', defaultAction: 'detect', engine: 'regex', enabled: true });
    expect(probe.current.list.data).toHaveLength(2);

    client.setQueryData(piiKeys.detail(getProjectScope(), 'p1'), policy);
    await act(async () => {
      await probe.current.remove.mutateAsync('p1');
    });
    await settle();
    expect(client.getQueryData(piiKeys.detail(getProjectScope(), 'p1'))).toBeUndefined();
    expect(probe.current.list.data).toEqual([]);
  });

  it('an edit rereads the policy and the list; a switch rereads only the list', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/pii/policies') return jsonResponse({ policies: [policy] });
      if (method === 'GET' && path === '/api/pii/policies/p1') return jsonResponse({ policy });
      if (method === 'PATCH' && path === '/api/pii/policies/p1') return jsonResponse({ policy });
      return undefined;
    });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      list: usePiiPolicyList(),
      detail: usePiiPolicy('p1'),
      update: useUpdatePiiPolicy(),
      toggle: useTogglePiiPolicy(),
    }));
    await settle();
    const count = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;
    expect([count('/api/pii/policies'), count('/api/pii/policies/p1')]).toEqual([1, 1]);

    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'p1', name: 'Renamed', categories: { tckn: true } });
    });
    await settle();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed', categories: { tckn: true } });
    expect([count('/api/pii/policies'), count('/api/pii/policies/p1')]).toEqual([2, 2]);

    await act(async () => {
      await probe.current.toggle.mutateAsync({ id: 'p1', enabled: false });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'PATCH')[1].body).toEqual({ enabled: false });
    expect([count('/api/pii/policies'), count('/api/pii/policies/p1')]).toEqual([3, 2]);
  });

  it('the picker options keep a policy that is switched off, and drop one without a key', async () => {
    stubFetch(({ method, path }) =>
      method === 'GET' && path === '/api/pii/policies'
        ? jsonResponse({ policies: [policy, { id: 'p2', key: 'off', name: '', enabled: false }, { id: 'p3', name: 'no key' }] })
        : undefined,
    );
    const probe = await renderHook(newTestQueryClient(), () => usePiiPolicyOptions());
    expect(probe.current.loading).toBe(true);
    await settle();
    expect(probe.current.loading).toBe(false);
    expect(probe.current.failed).toBe(false);
    expect(probe.current.policies).toEqual([
      { id: 'p1', key: 'tc-only', name: 'TC only', enabled: true, engine: undefined },
      { id: 'p2', key: 'off', name: 'off', enabled: false, engine: undefined },
    ]);
  });

  it('the picker options do not load when the host supplies the policies', async () => {
    const calls = stubFetch(() => jsonResponse({ policies: [] }));
    const probe = await renderHook(newTestQueryClient(), () => usePiiPolicyOptions(false));
    await settle();
    expect(calls).toHaveLength(0);
    expect(probe.current.loading).toBe(false);
  });

  it('the catalog is read per locale and engine, and on demand when the engine changes', async () => {
    const calls = stubFetch(({ method, path, search }) =>
      method === 'GET' && path === '/api/pii/categories'
        ? jsonResponse({ categories: [{ id: search.includes('cognipeer') ? 'x' : 'tckn' }], defaults: { a: true } })
        : undefined,
    );
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ catalog: usePiiCatalog('tr', 'regex'), load: useLoadPiiCatalog() }));
    await settle();
    expect(calls[0].search).toBe('?locale=tr&engine=regex');
    expect(probe.current.catalog.data?.defaults).toEqual({ a: true });

    const next = await probe.current.load('tr', 'cognipeer');
    expect(next.categories).toEqual([{ id: 'x' }]);
    expect(calls[1].search).toBe('?locale=tr&engine=cognipeer');
    expect(client.getQueryData(piiKeys.catalog(getProjectScope(), 'tr', 'cognipeer'))).toBeDefined();
  });

  it('a test run posts the draft to the operation and answers its result', async () => {
    const calls = stubFetch(({ method, path }) =>
      method === 'POST' && path === '/api/pii/redact' ? jsonResponse({ findings: [], outputText: 'x', inputLength: 1 }) : undefined,
    );
    const probe = await renderHook(newTestQueryClient(), () => usePiiScan<{ outputText: string }>());
    await act(async () => {
      const result = await probe.current.mutateAsync({ op: 'redact', body: { text: 'a', engine: 'regex' } });
      expect(result.outputText).toBe('x');
    });
    expect(calls[0].body).toEqual({ text: 'a', engine: 'regex' });
  });

  it('the server message of a failed request reaches the screen', async () => {
    stubFetch(({ method, path }) => {
      if (method === 'POST' && path === '/api/pii/policies') return jsonResponse({ error: 'Name already used' }, 409);
      if (method === 'GET' && path === '/api/pii/policies/p9') return jsonResponse({ error: 'Not found' }, 404);
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({ create: useCreatePiiPolicy(), detail: usePiiPolicy('p9') }));
    await settle();
    await act(async () => {
      await expect(
        probe.current.create.mutateAsync({ name: 'x', defaultAction: 'detect', engine: 'regex', enabled: true }),
      ).rejects.toMatchObject({ message: 'Name already used', status: 409 });
    });
    expect(probe.current.detail.error).toMatchObject({ status: 404 });
  });
});
