// @vitest-environment jsdom
/**
 * The quota editor's query hooks: the key and how the defaults read behaves.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quotaKeys,
  useDeleteQuotaPolicy,
  useQuotaDefaults,
  useQuotaPolicies,
  useSaveQuotaPolicy,
  useSetQuotaPolicyEnabled,
} from '@/lib/api/queries/quota';
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

describe('Quota hooks', () => {
  let calls: string[];
  let fail: boolean;

  beforeEach(() => {
    calls = [];
    fail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        calls.push(new URL(input, 'http://localhost').pathname);
        if (fail) return jsonResponse({ error: 'Forbidden' }, 403);
        return jsonResponse({ domains: ['llm'], jobKinds: ['crawl'], ipScope: { trustedProxiesUnset: true } });
      }),
    );
  });

  it('keys start with the resource and the project marker', () => {
    expect(quotaKeys.defaults('project:1')).toEqual(['quota', 'project:1', 'defaults']);
    expect(quotaKeys.defaults('project:1').slice(0, 2)).toEqual([...quotaKeys.project('project:1')]);
  });

  it('reads the defaults only while the editor is open', async () => {
    const client = newTestQueryClient();
    await renderHook(client, () => useQuotaDefaults(false));
    await settle();
    expect(calls).toHaveLength(0);

    await act(async () => root?.unmount());
    host?.remove();
    const open = await renderHook(client, () => useQuotaDefaults(true));
    await settle();
    expect(open.current.data?.jobKinds).toEqual(['crawl']);
    expect(calls).toEqual(['/api/quota/defaults']);
  });

  it('a refused read is an error with the status and leaves no data', async () => {
    fail = true;
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useQuotaDefaults(true));
    await settle();
    expect(probe.current.data).toBeUndefined();
    expect(probe.current.error).toMatchObject({ status: 403, message: 'Forbidden' });
  });

  it('the policies sit under the project prefix too', () => {
    expect(quotaKeys.policies('project:1')).toEqual(['quota', 'project:1', 'policies']);
    expect(quotaKeys.policies('project:1').slice(0, 2)).toEqual([...quotaKeys.project('project:1')]);
  });

  describe('policies', () => {
    let writes: Array<{ method: string; path: string; search: string; body: unknown }>;
    let writeFails: boolean;

    beforeEach(() => {
      writes = [];
      writeFails = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          const url = new URL(input, 'http://localhost');
          calls.push(`${method} ${url.pathname}`);
          if (method === 'GET') return jsonResponse({ policies: [{ _id: 'q1' }] });
          writes.push({ method, path: url.pathname, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
          if (writeFails) return jsonResponse({ error: 'Not allowed', code: 'forbidden' }, 403);
          return jsonResponse({ warnings: ['w'] });
        }),
      );
    });

    it('reads the policies with their targets', async () => {
      const probe = await renderHook(newTestQueryClient(), () => useQuotaPolicies());
      await settle();
      expect(probe.current.data).toEqual({ policies: [{ _id: 'q1' }] });
      expect(calls).toEqual(['GET /api/quota/policies']);
    });

    it('creating posts, editing patches by id, and both read the list again before they resolve', async () => {
      const probe = await renderHook(newTestQueryClient(), () => ({ list: useQuotaPolicies(), save: useSaveQuotaPolicy() }));
      await settle();
      let created: unknown;
      await act(async () => { created = await probe.current.save.mutateAsync({ id: null, body: { name: 'n' } }); });
      await act(async () => { await probe.current.save.mutateAsync({ id: 'q 1', body: { name: 'm' } }); });
      expect(created).toEqual({ warnings: ['w'] });
      expect(writes).toEqual([
        { method: 'POST', path: '/api/quota/policies', search: '', body: { name: 'n' } },
        { method: 'PATCH', path: '/api/quota/policies/q%201', search: '', body: { name: 'm' } },
      ]);
      expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(3);
    });

    it('a switch reads the list again whether the server accepted it or not; a refusal keeps its status and code', async () => {
      const probe = await renderHook(newTestQueryClient(), () => ({ list: useQuotaPolicies(), enable: useSetQuotaPolicyEnabled() }));
      await settle();
      await act(async () => { await probe.current.enable.mutateAsync({ id: 'q1', enabled: false }); });
      expect(writes[0]).toMatchObject({ method: 'PATCH', body: { enabled: false } });
      expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2);

      writeFails = true;
      await act(async () => { await probe.current.enable.mutateAsync({ id: 'q1', enabled: true }).catch(() => undefined); });
      await settle();
      expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(3);
      expect(probe.current.enable.error).toMatchObject({ status: 403, message: 'Not allowed', payload: { code: 'forbidden' } });
    });

    it('a delete names the project it is in, when it has one, and reads the list again', async () => {
      const probe = await renderHook(newTestQueryClient(), () => ({ list: useQuotaPolicies(), remove: useDeleteQuotaPolicy() }));
      await settle();
      await act(async () => { await probe.current.remove.mutateAsync({ id: 'q1', projectId: 'p 1' }); });
      await act(async () => { await probe.current.remove.mutateAsync({ id: 'q2' }); });
      expect(writes.map((w) => `${w.method} ${w.path}${w.search}`)).toEqual([
        'DELETE /api/quota/policies/q1?projectId=p%201',
        'DELETE /api/quota/policies/q2',
      ]);
      expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(3);
    });
  });
});
