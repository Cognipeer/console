// @vitest-environment jsdom
/**
 * The Reranker query hooks: their keys and what each mutation does to the cache.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  rerankerKeys,
  useCreateReranker,
  useDeleteReranker,
  useReranker,
  useRerankerList,
  useRerankerRuns,
  useRunReranker,
  useUpdateReranker,
} from '@/lib/api/queries/reranker';
import { cleanupHooks, newHookClient, renderHook, settle, stubFetch } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const reranker = (name: string) => ({ _id: 'r1', key: 'r1', name, strategy: 'heuristic', config: {}, status: 'active' });

describe('Reranker hooks', () => {
  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(rerankerKeys.list('project:3')).toEqual(['reranker', 'project:3', 'list']);
    const detail = rerankerKeys.detail('project:3', 'r1');
    expect(rerankerKeys.runs('project:3', 'r1').slice(0, detail.length)).toEqual([...detail]);
  });

  it('create refreshes the list; update puts the saved reranker in the cache; delete drops it', async () => {
    let rerankers = [reranker('One')];
    const calls = stubFetch({
      'GET /api/reranker': () => ({ rerankers }),
      'POST /api/reranker': () => {
        rerankers = [...rerankers, { ...reranker('Two'), _id: 'r2', key: 'r2' }];
        return { status: 201, body: { reranker: rerankers[1] } };
      },
      'PATCH /api/reranker/r1': () => ({ reranker: reranker('Renamed') }),
      'DELETE /api/reranker/r1': () => {
        rerankers = [];
        return { success: true };
      },
    });
    const client = newHookClient();
    const probe = await renderHook(client, () => ({
      list: useRerankerList(),
      create: useCreateReranker(),
      update: useUpdateReranker(),
      remove: useDeleteReranker(),
    }));
    await settle();
    expect(probe.current.list.data).toHaveLength(1);

    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'Two', strategy: 'heuristic', config: {} });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/reranker')).toHaveLength(2);
    expect(probe.current.list.data).toHaveLength(2);

    await act(async () => {
      await probe.current.update.mutateAsync({
        key: 'r1', name: 'Renamed', strategy: 'heuristic', config: {}, status: 'active',
      });
    });
    expect(client.getQueryData(rerankerKeys.detail(getProjectScope(), 'r1'))).toMatchObject({ name: 'Renamed' });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      name: 'Renamed', strategy: 'heuristic', config: {}, status: 'active',
    });

    rerankers = [reranker('One')];
    await act(async () => {
      await probe.current.remove.mutateAsync('r1');
    });
    await settle();
    expect(client.getQueryData(rerankerKeys.detail(getProjectScope(), 'r1'))).toBeUndefined();
    expect(probe.current.list.data).toEqual([]);
  });

  it('reads the runs only when asked, and a run moves the runs and the list', async () => {
    const calls = stubFetch({
      'GET /api/reranker': { rerankers: [reranker('One')] },
      'GET /api/reranker/r1/runs': { logs: [{ _id: 'l1', query: 'q', inputCount: 2, outputCount: 1, status: 'success' }] },
      'POST /api/reranker/r1/run': { result: { rerankerKey: 'r1', strategy: 'heuristic', results: [], latencyMs: 1, inputCount: 2, outputCount: 0 } },
    });
    const probe = await renderHook(newHookClient(), () => ({
      list: useRerankerList(),
      runs: useRerankerRuns('r1', true),
      closed: useRerankerRuns('r2', false),
      run: useRunReranker(),
    }));
    await settle();
    expect(probe.current.runs.data).toHaveLength(1);
    expect(probe.current.closed.fetchStatus).toBe('idle');
    expect(calls.find((c) => c.path === '/api/reranker/r1/runs')?.query).toEqual({ limit: '50' });

    await act(async () => {
      await probe.current.run.mutateAsync({ key: 'r1', query: 'q', documents: [{ content: 'a' }, { content: 'b' }] });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ query: 'q', documents: [{ content: 'a' }, { content: 'b' }] });
    // The runs and the list (its run counters) are read again.
    expect(calls.filter((c) => c.path === '/api/reranker/r1/runs')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/reranker')).toHaveLength(2);
  });

  it('a failed read reaches the screen with the server message', async () => {
    stubFetch({ 'GET /api/reranker/missing': { status: 404, body: { error: 'Reranker not found' } } });
    const probe = await renderHook(newHookClient(), () => useReranker('missing'));
    await settle();
    expect(probe.current.isError).toBe(true);
    expect((probe.current.error as Error).message).toBe('Reranker not found');
  });
});
