// @vitest-environment jsdom
/**
 * The Vector query hooks: project-scoped keys, the polling of migrations and what each mutation rereads.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  useCreateVectorIndex,
  useDeleteVectorIndex,
  useDeleteVectorItem,
  useStartVectorMigration,
  useUpdateVectorIndex,
  useVectorIndex,
  useVectorMigrations,
  useVectorProvidersWithIndexes,
  vectorKeys,
} from '@/lib/api/queries/vector';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { cleanupHooks, renderHook, settle, stubFetch } from '../helpers/knowledgeQueryHarness';

afterEach(cleanupHooks);

describe('Vector hooks', () => {
  it('keys start with the resource and the project marker; providers and indexes are prefixes of their lists', () => {
    expect(vectorKeys.providerList('project:4')).toEqual(['vector', 'project:4', 'providers', 'list']);
    expect(vectorKeys.providersWithIndexes('project:4').slice(0, 3)).toEqual([...vectorKeys.providers('project:4')]);
    expect(vectorKeys.index('project:4', 'p', 'i').slice(0, 3)).toEqual([...vectorKeys.indexes('project:4')]);
    expect(vectorKeys.migrationRunLogs('project:4', 'm', 1, 0).slice(0, 5)).toEqual([...vectorKeys.migration('project:4', 'm')]);
  });

  it('reads providers with their indexes and fills in a provider without any', async () => {
    stubFetch(({ method, path, search }) => {
      if (method === 'GET' && path === '/api/vector/providers' && search === '?includeIndexes=true') {
        return { body: { providers: [{ key: 'a' }, { key: 'b' }], indexesByProvider: { a: [{ key: 'i1' }] } } };
      }
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => useVectorProvidersWithIndexes());
    await settle();
    expect(probe.current.data?.indexesByProvider).toEqual({ a: [{ key: 'i1' }], b: [] });
  });

  it('creating an index rereads the lists; updating puts the saved index in the cache; deleting drops it', async () => {
    let lists = 0;
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/vector/providers') {
        lists += 1;
        return { body: { providers: [], indexesByProvider: {} } };
      }
      if (method === 'GET' && path === '/api/vector/indexes/i1') return { body: { index: { key: 'i1', name: 'One' }, provider: { key: 'p' } } };
      if (method === 'POST' && path === '/api/vector/indexes') return { status: 201, body: { index: { key: 'i2' } } };
      if (method === 'PATCH' && path === '/api/vector/indexes/i1') return { body: { index: { key: 'i1', name: 'Renamed' } } };
      if (method === 'DELETE' && path === '/api/vector/indexes/i1') return { body: { success: true } };
      if (method === 'DELETE' && path === '/api/vector/indexes/i1/vectors') return { body: { success: true } };
      return undefined;
    });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      providers: useVectorProvidersWithIndexes(),
      index: useVectorIndex('p', 'i1'),
      create: useCreateVectorIndex(),
      update: useUpdateVectorIndex(),
      remove: useDeleteVectorIndex(),
      removeItem: useDeleteVectorItem(),
    }));
    await settle();
    expect(probe.current.index.data?.index?.name).toBe('One');
    expect(lists).toBe(1);

    await act(async () => {
      await probe.current.create.mutateAsync({ providerKey: 'p', name: 'Two', createInProvider: true });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ providerKey: 'p', name: 'Two' });
    expect(lists).toBe(2);

    await act(async () => {
      await probe.current.update.mutateAsync({ indexKey: 'i1', providerKey: 'p', name: 'Renamed', metadata: {} });
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.search).toBe('?providerKey=p');
    expect(patch?.body).toEqual({ name: 'Renamed', metadata: {} });

    await act(async () => {
      await probe.current.removeItem.mutateAsync({ indexKey: 'i1', providerKey: 'p', id: 'v1' });
    });
    expect(calls.find((c) => c.path === '/api/vector/indexes/i1/vectors')?.body).toEqual({ ids: ['v1'] });

    await act(async () => {
      await probe.current.remove.mutateAsync({ indexKey: 'i1', providerKey: 'p' });
    });
    expect(client.getQueryData(vectorKeys.index(getProjectScope(), 'p', 'i1'))).toBeUndefined();
  });

  it('rereads the migrations while one is running and stops when none is; the error of a start reaches the caller', async () => {
    let status = 'running';
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/vector/migrations') return { body: { migrations: [{ key: 'm', status }] } };
      if (method === 'POST' && path === '/api/vector/migrations/m/start') return { status: 409, body: { error: 'already running' } };
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useVectorMigrations(15),
      start: useStartVectorMigration(),
    }));
    await settle();
    const reads = () => calls.filter((c) => c.method === 'GET').length;
    expect(reads()).toBeGreaterThan(1);

    status = 'completed';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const settled = reads();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(reads()).toBe(settled);

    await act(async () => {
      await expect(probe.current.start.mutateAsync('m')).rejects.toThrow('already running');
    });
  });
});
