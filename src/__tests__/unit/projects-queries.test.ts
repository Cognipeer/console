// @vitest-environment jsdom
/**
 * The Projects query hooks: their keys, what each mutation does to the cache and how a failed request reaches the screen.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectsKeys,
  useBulkProjectMembers,
  useDeleteProject,
  useProjectMembers,
  useProjectOverview,
  useProjects,
  useSessionRole,
  useSetActiveProject,
  useSetMemberPermissions,
  useUpdateProject,
} from '@/lib/api/queries/projects';
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

describe('Projects hooks', () => {
  let calls: Array<{ method: string; path: string; search: string; body: unknown }>;
  let sessionFails: boolean;
  let listGate: Promise<void> | null;

  beforeEach(() => {
    calls = [];
    listGate = null;
    sessionFails = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const url = new URL(input, 'http://localhost');
        const path = url.pathname;
        calls.push({ method, path, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'GET' && path === '/api/projects') {
          if (listGate) await listGate;
          return jsonResponse({ projects: [{ _id: 'p1', name: 'One', key: 'one' }], activeProjectId: 'p1' });
        }
        if (method === 'GET' && path === '/api/auth/session') {
          return sessionFails ? jsonResponse({ error: 'no session' }, 401) : jsonResponse({ role: 'admin' });
        }
        if (method === 'GET' && path === '/api/projects/p1/overview') return jsonResponse({ stats: {} });
        if (method === 'GET' && path === '/api/projects/p2/overview') return jsonResponse({ error: 'Project not found' }, 404);
        if (method === 'GET' && path === '/api/projects/p1/members') return jsonResponse({ members: [] });
        if (method === 'POST' && path === '/api/projects/active') return jsonResponse({ success: true });
        if (method === 'PATCH' && path === '/api/projects/p1') return jsonResponse({ project: { _id: 'p1' } });
        if (method === 'DELETE' && path === '/api/projects/p1') return jsonResponse({ success: true });
        if (method === 'POST' && path === '/api/projects/p1/members/bulk') return jsonResponse({ added: 1 });
        if (method === 'PATCH' && path === '/api/projects/p1/members/permissions') return jsonResponse({ ok: true });
        return jsonResponse({ error: `no mock for ${method} ${path}` }, 404);
      }),
    );
  });

  it('keys start with the resource and the project marker, and every read sits under the project prefix', () => {
    const prefix = [...projectsKeys.project('project:3')];
    expect(projectsKeys.list('project:3', true).slice(0, 2)).toEqual(prefix);
    expect(projectsKeys.list('project:3', true)).not.toEqual(projectsKeys.list('project:3', false));
    expect(projectsKeys.overview('project:3', 'p1').slice(0, 2)).toEqual(prefix);
    expect(projectsKeys.members('project:3', 'p1').slice(0, 2)).toEqual(prefix);
    expect(projectsKeys.members('project:3', 'p1')).not.toEqual(projectsKeys.members('project:3', 'p2'));
  });

  it('reads the list with or without the counts', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ plain: useProjects(), stats: useProjects({ stats: true }) }));
    await settle();
    expect(probe.current.plain.data?.activeProjectId).toBe('p1');
    expect(probe.current.stats.data?.projects).toHaveLength(1);
    expect(calls.map((c) => c.search).sort()).toEqual(['', '?include=stats']);
  });

  it('reads the role of the session; a refused session leaves it undefined without retrying', async () => {
    let client = newTestQueryClient();
    let probe = await renderHook(client, () => useSessionRole());
    await settle();
    expect(probe.current.data).toBe('admin');

    await act(async () => root?.unmount());
    host?.remove();
    sessionFails = true;
    client = newTestQueryClient();
    probe = await renderHook(client, () => useSessionRole());
    await settle();
    expect(probe.current.data).toBeUndefined();
    expect(probe.current.isPending).toBe(false);
  });

  it('setting the active project posts it and reads the list again', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ list: useProjects(), activate: useSetActiveProject() }));
    await settle();
    await act(async () => {
      await probe.current.activate.mutateAsync('p1');
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ projectId: 'p1' });
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/projects')).toHaveLength(2);
  });

  it('a member change refreshes the members, the overview and the list together', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      list: useProjects({ stats: true }),
      overview: useProjectOverview('p1'),
      members: useProjectMembers('p1'),
      bulk: useBulkProjectMembers('p1'),
      permissions: useSetMemberPermissions('p1'),
    }));
    await settle();
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path !== '/api/auth/session').length;
    const before = reads();

    await act(async () => {
      await probe.current.bulk.mutateAsync({ add: [{ userId: 'u1', role: 'member' }] });
    });
    await settle();
    expect(calls.find((c) => c.path === '/api/projects/p1/members/bulk')?.body).toEqual({ add: [{ userId: 'u1', role: 'member' }] });
    expect(reads() - before).toBe(3);

    await act(async () => {
      await probe.current.permissions.mutateAsync({ userId: 'u1', servicePermissions: {} });
    });
    await settle();
    expect(calls.find((c) => c.path === '/api/projects/p1/members/permissions')?.body).toEqual({ userId: 'u1', servicePermissions: {} });
    expect(reads() - before).toBe(6);
  });

  it('saving and deleting a project refresh the list', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ list: useProjects(), update: useUpdateProject(), remove: useDeleteProject() }));
    await settle();
    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'p1', name: 'Renamed', description: 'd' });
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed', description: 'd' });
    await act(async () => {
      await probe.current.remove.mutateAsync('p1');
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/projects')).toHaveLength(3);
  });

  it('a deleted project is reported at once: the caller does not wait for the list to be read again', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ list: useProjects(), remove: useDeleteProject() }));
    await settle();
    let release: () => void = () => undefined;
    listGate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      await probe.current.remove.mutateAsync('p1');
    });
    // Reaching this line means the call returned while the list read was still held back.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/projects')).toHaveLength(2);
    release();
    await settle();
  });

  it('a failed read reaches the screen with the status and the server message', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useProjectOverview('p2'));
    await settle();
    expect(probe.current.isError).toBe(true);
    expect(probe.current.error).toMatchObject({ status: 404, message: 'Project not found' });
  });
});
