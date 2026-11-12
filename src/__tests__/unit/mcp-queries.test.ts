// @vitest-environment jsdom
/**
 * The MCP server query hooks: their keys, the monitor's refresh, and what each mutation does to the cache.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import { mcpKeys, useDeleteMcpServer, useMcpMonitor, useMcpServerList, useUpdateMcpServer } from '@/lib/api/queries/mcp';
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

describe('MCP hooks', () => {
  const server = { id: 's1', key: 'one', name: 'One', status: 'active', tools: [] };

  it('keys start with the resource and the project marker', () => {
    expect(mcpKeys.list('project:3')).toEqual(['mcp', 'project:3', 'list']);
    expect(mcpKeys.monitor('project:3').slice(0, 2)).toEqual(mcpKeys.project('project:3'));
  });

  it('an edit answers the stored server and rereads the list; a delete rereads it too', async () => {
    let servers: Array<Record<string, unknown>> = [server];
    const calls = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/api/mcp') return jsonResponse({ servers });
      if (method === 'PATCH' && path === '/api/mcp/s1') {
        servers = [{ ...server, ...(body as object) }];
        return jsonResponse({ server: servers[0] });
      }
      if (method === 'DELETE' && path === '/api/mcp/s1') {
        servers = [];
        return jsonResponse({ success: true });
      }
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useMcpServerList(),
      update: useUpdateMcpServer(),
      remove: useDeleteMcpServer(),
    }));
    await settle();
    expect(probe.current.list.data).toHaveLength(1);

    await act(async () => {
      const data = await probe.current.update.mutateAsync({ id: 's1', status: 'disabled' });
      expect(data.server).toMatchObject({ id: 's1', status: 'disabled' });
    });
    await settle();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'disabled' });
    expect(probe.current.list.data?.[0]).toMatchObject({ status: 'disabled' });

    await act(async () => {
      await probe.current.remove.mutateAsync('s1');
    });
    await settle();
    expect(probe.current.list.data).toEqual([]);
  });

  it('the monitor snapshot has empty lists for a missing part, and the server message of a failure reaches the screen', async () => {
    let fail = false;
    stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/mcp/monitor') {
        return fail ? jsonResponse({ error: 'Monitor offline' }, 403) : jsonResponse({ servers: [] });
      }
      return undefined;
    });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useMcpMonitor());
    await settle();
    expect(probe.current.data).toEqual({ servers: [], recentLogs: [], recentAudit: [] });

    fail = true;
    await act(async () => {
      await probe.current.refetch();
    });
    await settle();
    expect(client.getQueryState(mcpKeys.monitor(getProjectScope()))?.error).toMatchObject({ message: 'Monitor offline', status: 403 });
  });
});
