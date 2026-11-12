// @vitest-environment jsdom
/**
 * The Memory query hooks: project-scoped keys, what each mutation rereads, and the error that reaches the screen.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  memoryKeys,
  useAddMemoryItem,
  useDeleteMemoryItem,
  useDeleteMemoryStore,
  useMemoryItems,
  useMemoryStores,
  useSearchMemories,
} from '@/lib/api/queries/memory';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { cleanupHooks, renderHook, settle, stubFetch } from '../helpers/knowledgeQueryHarness';

afterEach(cleanupHooks);

describe('Memory hooks', () => {
  it('keys start with the resource and the project marker; the store key is a prefix of its pages', () => {
    expect(memoryKeys.list('project:2')).toEqual(['memory', 'project:2', 'list']);
    const store = memoryKeys.store('project:2', 's1');
    const items = memoryKeys.items('project:2', 's1', 1, 20, { scope: 'user', scopeId: 'u1' });
    expect(items.slice(0, store.length)).toEqual([...store]);
    expect(memoryKeys.detail('project:2', 's1').slice(0, store.length)).toEqual([...store]);
  });

  it('reads the stores and a page with its filter in the query string', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/memory/stores') return { body: { stores: [{ key: 's1' }] } };
      if (method === 'GET' && path === '/api/memory/stores/s1/memories') return { body: { items: [{ _id: 'm1' }], total: 41 } };
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      stores: useMemoryStores(),
      page: useMemoryItems('s1', 2, 20, { scope: 'user', scopeId: 'u1' }),
    }));
    await settle();
    expect(probe.current.stores.data).toEqual([{ key: 's1' }]);
    expect(probe.current.page.data).toEqual({ items: [{ _id: 'm1' }], total: 41 });
    const read = calls.find((c) => c.path === '/api/memory/stores/s1/memories');
    expect(new URLSearchParams(read?.search).get('page')).toBe('2');
    expect(new URLSearchParams(read?.search).get('scope')).toBe('user');
    expect(new URLSearchParams(read?.search).get('scopeId')).toBe('u1');
  });

  it('adding a memory rereads the store pages and the list; deleting a store drops its queries', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/memory/stores') return { body: { stores: [] } };
      if (method === 'GET' && path === '/api/memory/stores/s1/memories') return { body: { items: [], total: 0 } };
      if (method === 'POST' && path === '/api/memory/stores/s1/memories') return { status: 201, body: { id: 'm2' } };
      if (method === 'DELETE' && path === '/api/memory/stores/s1/memories/m2') return { body: { success: true } };
      if (method === 'DELETE' && path === '/api/memory/stores/s1') return { body: { success: true } };
      return undefined;
    });
    const client = newTestQueryClient();
    const removed = vi.spyOn(client, 'removeQueries');
    const probe = await renderHook(client, () => ({
      stores: useMemoryStores(),
      page: useMemoryItems('s1', 1, 20, {}),
      add: useAddMemoryItem('s1'),
      remove: useDeleteMemoryItem('s1'),
      removeStore: useDeleteMemoryStore('s1'),
    }));
    await settle();
    const reads = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;
    expect(reads('/api/memory/stores/s1/memories')).toBe(1);

    await act(async () => {
      await probe.current.add.mutateAsync({ content: 'x', importance: 0.5, scope: 'global', source: 'manual', tags: [] });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ content: 'x', scope: 'global' });
    expect(reads('/api/memory/stores/s1/memories')).toBe(2);
    expect(reads('/api/memory/stores')).toBe(2);

    await act(async () => {
      await probe.current.remove.mutateAsync('m2');
    });
    await settle();
    expect(reads('/api/memory/stores/s1/memories')).toBe(3);

    await act(async () => {
      await probe.current.removeStore.mutateAsync();
    });
    // The screen is gone by then; a still-mounted observer would only fetch the removed key again.
    expect(removed).toHaveBeenCalledWith({ queryKey: memoryKeys.store(getProjectScope(), 's1') });
  });

  it('the message of a failed request reaches the caller', async () => {
    stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/memory/stores/s1/memories') return { status: 400, body: { error: 'query too long' } };
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => useSearchMemories('s1'));
    await act(async () => {
      await expect(probe.current.mutateAsync({ query: 'q', limit: 10, filter: {} })).rejects.toThrow('query too long');
    });
  });
});
