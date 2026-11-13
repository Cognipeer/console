// @vitest-environment jsdom
/**
 * The shared pieces under the React Query hooks: the project marker (`useProjectScope`, `useResourceKey`) and the app's
 * query client (opt-in error notifications).
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { createQueryClient } from '@/lib/api/queries/queryClient';
import { getProjectScope, useProjectScope, useResourceKey } from '@/lib/api/queries/projectScope';
import { notifyActiveProjectChanged } from '@/components/layout/useEffectivePermissions';
import { newTestQueryClient } from '../helpers/renderWithQuery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

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

beforeEach(() => notify.show.mockClear());
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe('project scope', () => {
  it('useProjectScope follows the project switch announcement', async () => {
    const probe = await renderHook(newTestQueryClient(), () => useProjectScope());
    const first = probe.current;
    expect(first).toBe(getProjectScope());
    await act(async () => notifyActiveProjectChanged());
    expect(probe.current).not.toBe(first);
    expect(probe.current).toBe(getProjectScope());
  });

  it('useResourceKey is [resource, marker], and drops inactive queries of an earlier project of that resource only', async () => {
    // gcTime Infinity: what disappears is removed by the hook, not collected.
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    client.setQueryData(['widgets', 'project:stale', 'list'], ['left over']);
    client.setQueryData(['gadgets', 'project:stale', 'list'], ['another resource']);

    const probe = await renderHook(client, () => useResourceKey('widgets'));
    expect(probe.current).toEqual(['widgets', getProjectScope()]);
    expect(client.getQueryData(['widgets', 'project:stale', 'list'])).toBeUndefined();
    expect(client.getQueryData(['gadgets', 'project:stale', 'list'])).toEqual(['another resource']);

    const first = probe.current;
    client.setQueryData(['widgets', first[1], 'list'], ['cached']);
    await act(async () => notifyActiveProjectChanged());
    expect(probe.current[1]).not.toBe(first[1]);
    expect(client.getQueryData(['widgets', first[1], 'list'])).toBeUndefined();
  });
});

describe('createQueryClient', () => {
  const failing = new ApiError('Quota exceeded', 429);

  it('keeps the app defaults', () => {
    expect(createQueryClient().getDefaultOptions().queries).toMatchObject({ staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 });
  });

  it('is silent unless the query or mutation asks for a notification', async () => {
    const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery({ queryKey: ['a'], queryFn: () => Promise.reject(failing) }).catch(() => undefined);
    expect(notify.show).not.toHaveBeenCalled();

    await client
      .fetchQuery({ queryKey: ['b'], queryFn: () => Promise.reject(failing), meta: { notifyOnError: true } })
      .catch(() => undefined);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Quota exceeded', color: 'red' }));
  });

  it('uses a string notifyOnError as the title, for mutations too', async () => {
    const client = createQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(failing),
      meta: { notifyOnError: 'Could not save' },
    });
    await mutation.execute(undefined).catch(() => undefined);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not save', message: 'Quota exceeded' }));
  });

  it('does not add a message to a 401, which is being answered by the login redirect', async () => {
    const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    await client
      .fetchQuery({ queryKey: ['c'], queryFn: () => Promise.reject(new ApiError('Unauthorized', 401)), meta: { notifyOnError: true } })
      .catch(() => undefined);
    expect(notify.show).not.toHaveBeenCalled();
  });
});
