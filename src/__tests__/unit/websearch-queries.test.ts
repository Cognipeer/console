// @vitest-environment jsdom
/**
 * The Web Search query hooks: what a detail page is about, and what each mutation does to the cache.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  useCreateWebSearchInstance,
  useDeleteWebSearchInstance,
  useRunWebSearch,
  useUpdateWebSearchInstance,
  useWebSearchLogs,
  useWebSearchProviders,
  useWebSearchTarget,
  websearchKeys,
} from '@/lib/api/queries/websearch';
import { cleanupHooks, newHookClient, renderHook, settle, stubFetch } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const instance = { _id: 'i1', key: 'main', name: 'Main', settings: {} };
const NOT_FOUND = { status: 404, body: { error: 'not found' } };

describe('Web Search hooks', () => {
  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(websearchKeys.list('project:1')).toEqual(['websearch', 'project:1', 'list']);
    const detail = websearchKeys.detail('project:1', 'main');
    expect(websearchKeys.logs('project:1', 'main', 'instance', '', '').slice(0, detail.length)).toEqual([...detail]);
  });

  it('the target is the instance, else the provider that has none, else null', async () => {
    stubFetch({
      'GET /api/websearch/instances/main': { instance },
      'GET /api/websearch/instances/bare': NOT_FOUND,
      'GET /api/websearch/providers/bare': { provider: { kind: 'provider', key: 'bare', label: 'Bare' } },
      'GET /api/websearch/instances/none': NOT_FOUND,
      'GET /api/websearch/providers/none': NOT_FOUND,
      'GET /api/websearch/instances/down': { status: 500, body: { error: 'boom' } },
    });
    const probe = await renderHook(newHookClient(), () => ({
      main: useWebSearchTarget('main'),
      bare: useWebSearchTarget('bare'),
      none: useWebSearchTarget('none'),
      down: useWebSearchTarget('down'),
    }));
    await settle();
    expect(probe.current.main.data).toEqual({ kind: 'instance', instance });
    expect(probe.current.bare.data).toMatchObject({ kind: 'provider', provider: { key: 'bare' } });
    expect(probe.current.none.isSuccess).toBe(true);
    expect(probe.current.none.data).toBeNull();
    expect((probe.current.down.error as Error).message).toBe('boom');
  });

  it('the list keeps a refusal as a status the screen can read', async () => {
    stubFetch({ 'GET /api/websearch/providers': { status: 403, body: { error: 'no access' } } });
    const probe = await renderHook(newHookClient(), () => useWebSearchProviders());
    await settle();
    expect(probe.current.isError).toBe(true);
    expect((probe.current.error as { status?: number }).status).toBe(403);
  });

  it('reads an instance\'s runs through its route and a provider\'s through the compatible one', async () => {
    const calls = stubFetch({
      'GET /api/websearch/instances/main/logs': { logs: [{ _id: 'l1' }] },
      'GET /api/websearch/providers/bare/logs': { logs: [] },
    });
    const probe = await renderHook(newHookClient(), () => ({
      own: useWebSearchLogs('main', 'instance', '2026-01-01T00:00:00.000Z', '', 200),
      bare: useWebSearchLogs('bare', 'provider', '', '', 200),
      waiting: useWebSearchLogs('main', null, '', '', 200),
    }));
    await settle();
    expect(probe.current.own.data).toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/websearch/instances/main/logs')?.query).toEqual({ limit: '200', from: '2026-01-01T00:00:00.000Z' });
    expect(calls.some((c) => c.path === '/api/websearch/providers/bare/logs')).toBe(true);
    expect(probe.current.waiting.fetchStatus).toBe('idle');
  });

  it('saving, creating, deleting and searching read the page\'s data again', async () => {
    const calls = stubFetch({
      'GET /api/websearch/instances/main': { instance },
      'PATCH /api/websearch/instances/main': { instance: { ...instance, name: 'Renamed' } },
      'POST /api/websearch/instances': { status: 201, body: { instance: { ...instance, key: 'two' } } },
      'DELETE /api/websearch/instances/main': { success: true },
      'POST /api/websearch/search': { status: 502, body: { error: 'search failed' } },
    });
    const probe = await renderHook(newHookClient(), () => ({
      target: useWebSearchTarget('main'),
      update: useUpdateWebSearchInstance(),
      create: useCreateWebSearchInstance(),
      remove: useDeleteWebSearchInstance(),
      search: useRunWebSearch(),
    }));
    await settle();
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/websearch/instances/main').length;
    expect(reads()).toBe(1);

    await act(async () => {
      await probe.current.update.mutateAsync({ key: 'main', body: { name: 'Renamed' } });
    });
    await settle();
    expect(reads()).toBe(2);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed' });

    await act(async () => {
      await probe.current.create.mutateAsync({ key: 'two' });
    });
    await settle();
    expect(reads()).toBe(3);

    let failure: unknown;
    await act(async () => {
      await probe.current.search.mutateAsync({ query: 'q', instance: 'main', includeAnswer: false }).catch((error: unknown) => {
        failure = error;
      });
    });
    await settle();
    // A failed search is logged too: the page reads again.
    expect((failure as Error).message).toBe('search failed');
    expect(reads()).toBe(4);

    await act(async () => {
      await probe.current.remove.mutateAsync('main');
    });
    await settle();
    expect(reads()).toBeGreaterThanOrEqual(5);
  });
});
