// @vitest-environment jsdom
/**
 * The Config query hooks: their keys, what each mutation does to the cache and how a failed request reaches the screen.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configKeys,
  isForbidden,
  useConfigCatalogData,
  useConfigGroup,
  useConfigGroups,
  useCreateConfigGroup,
  useDeleteConfigGroup,
  useUpdateConfigItem,
} from '@/lib/api/queries/config';
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

describe('Config hooks', () => {
  let calls: Array<{ method: string; path: string; body: unknown }>;
  let groups: Array<Record<string, unknown>>;
  let forbidden: boolean;

  beforeEach(() => {
    calls = [];
    groups = [{ _id: 'g1', key: 'one', name: 'One' }];
    forbidden = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = new URL(input, 'http://localhost').pathname;
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (forbidden && method === 'GET') return jsonResponse({ error: 'Forbidden' }, 403);
        if (method === 'GET' && path === '/api/config/groups') return jsonResponse({ groups });
        if (method === 'GET' && path === '/api/config/items') return jsonResponse({ items: [{ _id: 'i1', groupId: 'g1', isSecret: false }] });
        if (method === 'GET' && path === '/api/config/groups/g1') return jsonResponse({ group: { _id: 'g1', name: 'One', items: [] } });
        if (method === 'GET' && path === '/api/config/groups/missing') return jsonResponse({ error: 'Config group not found' }, 404);
        if (method === 'POST' && path === '/api/config/groups') {
          groups.push({ _id: 'g2', key: 'two', name: 'Two' });
          return jsonResponse({ group: { _id: 'g2' } }, 201);
        }
        if (method === 'PATCH' && path === '/api/config/items/i1') return jsonResponse({ item: { _id: 'i1' } });
        if (method === 'DELETE' && path === '/api/config/groups/g1') {
          groups.splice(0, groups.length);
          return jsonResponse({ success: true });
        }
        return jsonResponse({ error: `no mock for ${method} ${path}` }, 404);
      }),
    );
  });

  it('keys start with the resource and the project marker', () => {
    const project = configKeys.project('project:3');
    expect(configKeys.groups('project:3').slice(0, 2)).toEqual([...project]);
    expect(configKeys.items('project:3').slice(0, 2)).toEqual([...project]);
    expect(configKeys.group('project:3', 'g1')).toEqual(['config', 'project:3', 'group', 'g1']);
    expect(configKeys.catalog('project:3').slice(0, 2)).toEqual([...project]);
  });

  it('a create refreshes the groups list', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ list: useConfigGroups(), create: useCreateConfigGroup() }));
    await settle();
    expect(probe.current.list.data).toHaveLength(1);

    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'Two', key: 'two' });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Two', key: 'two' });
    expect(probe.current.list.data).toHaveLength(2);
  });

  it('an item update refreshes the group detail, the lists and the catalog together', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      detail: useConfigGroup('g1'),
      catalog: useConfigCatalogData(true),
      update: useUpdateConfigItem(),
    }));
    await settle();
    const reads = () => calls.filter((c) => c.method === 'GET').length;
    const before = reads();

    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'i1', name: 'Renamed', value: 'v' });
    });
    await settle();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed', value: 'v' });
    // detail (1) + catalog (2: groups and items)
    expect(reads() - before).toBe(3);
  });

  it('deleting a group drops its detail from the cache and refreshes the list', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ list: useConfigGroups(), remove: useDeleteConfigGroup() }));
    await settle();
    client.setQueryData(configKeys.group(getProjectScope(), 'g1'), { _id: 'g1' });

    await act(async () => {
      await probe.current.remove.mutateAsync('g1');
    });
    await settle();
    expect(client.getQueryData(configKeys.group(getProjectScope(), 'g1'))).toBeUndefined();
    expect(probe.current.list.data).toEqual([]);
  });

  it('a missing group reaches the screen as a 404 error with the server message', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useConfigGroup('missing'));
    await settle();
    expect(probe.current.isError).toBe(true);
    expect(probe.current.error).toMatchObject({ status: 404, message: 'Config group not found' });
  });

  it('a refused catalog read is told apart from a failure', async () => {
    forbidden = true;
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useConfigCatalogData(true));
    await settle();
    expect(probe.current.isError).toBe(true);
    expect(isForbidden(probe.current.error)).toBe(true);
  });

  it('a disabled catalog makes no request', async () => {
    const client = newTestQueryClient();
    await renderHook(client, () => useConfigCatalogData(false));
    await settle();
    expect(calls).toHaveLength(0);
  });
});
