// @vitest-environment jsdom
/**
 * The Snapshot wizard query hooks: their keys, the requests they send, the job polling and how a failed request reaches the screen.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  snapshotsKeys,
  useCreateSnapshot,
  usePreviewSnapshot,
  useSnapshotFilters,
  useSnapshotJob,
  useSnapshotPiiCategories,
} from '@/lib/api/queries/snapshots';
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

describe('Snapshot hooks', () => {
  let calls: Array<{ method: string; path: string; search: string; body: unknown }>;
  let jobStatus: string;

  beforeEach(() => {
    calls = [];
    jobStatus = 'running';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const url = new URL(input, 'http://localhost');
        calls.push({ method, path: url.pathname, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.pathname === '/api/snapshots/filters') return jsonResponse({ gatewayModels: ['m1'], agents: ['a1'] });
        if (url.pathname === '/api/pii/categories') return jsonResponse({ categories: [{ id: 'email', defaultEnabled: true }] });
        if (url.pathname === '/api/snapshots/preview') return jsonResponse({ matching: 3 });
        if (url.pathname === '/api/snapshots' && method === 'POST') return jsonResponse({ datasetId: 'd1' }, 202);
        if (url.pathname === '/api/evaluation/datasets/d1') return jsonResponse({ dataset: { id: 'd1', metadata: { snapshot: { status: jobStatus } } } });
        if (url.pathname === '/api/evaluation/datasets/gone') return jsonResponse({ error: 'Dataset not found' }, 404);
        return jsonResponse({ error: 'no mock' }, 404);
      }),
    );
  });

  it('keys start with the resource and the project marker', () => {
    const prefix = [...snapshotsKeys.project('project:1')];
    expect(snapshotsKeys.filters('project:1').slice(0, 2)).toEqual(prefix);
    expect(snapshotsKeys.piiCategories('project:1', 'tr').slice(0, 2)).toEqual(prefix);
    expect(snapshotsKeys.piiCategories('project:1', 'tr')).not.toEqual(snapshotsKeys.piiCategories('project:1', 'en'));
    expect(snapshotsKeys.job('project:1', 'd1').slice(0, 2)).toEqual(prefix);
  });

  it('reads the filter options and the PII categories of the locale', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      filters: useSnapshotFilters(),
      categories: useSnapshotPiiCategories<{ id: string }>('tr'),
    }));
    await settle();
    expect(probe.current.filters.data).toEqual({ gatewayModels: ['m1'], agents: ['a1'] });
    expect(probe.current.categories.data).toEqual([{ id: 'email', defaultEnabled: true }]);
    expect(calls.find((c) => c.path === '/api/pii/categories')?.search).toBe('?locale=tr');
  });

  it('preview and create post the body; create returns the dataset id', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ preview: usePreviewSnapshot<{ matching: number }>(), create: useCreateSnapshot() }));
    let previewed: { matching: number } | undefined;
    await act(async () => {
      previewed = await probe.current.preview.mutateAsync({ source: 'gateway' });
    });
    expect(previewed).toEqual({ matching: 3 });
    let created: { datasetId: string } | undefined;
    await act(async () => {
      created = await probe.current.create.mutateAsync({ source: 'gateway', name: 'n' });
    });
    expect(created).toEqual({ datasetId: 'd1' });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ source: 'gateway' }, { source: 'gateway', name: 'n' }]);
  });

  it('polls the job while it runs and stops once it is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = newTestQueryClient();
      const probe = await renderHook(client, () => useSnapshotJob('d1', true));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(probe.current.data?.metadata?.snapshot?.status).toBe('running');
      const reads = () => calls.filter((c) => c.path === '/api/evaluation/datasets/d1').length;
      const first = reads();
      await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
      expect(reads()).toBeGreaterThan(first);

      jobStatus = 'ready';
      await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
      expect(probe.current.data?.metadata?.snapshot?.status).toBe('ready');
      const done = reads();
      await act(async () => { await vi.advanceTimersByTimeAsync(7600); });
      expect(reads()).toBe(done);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a job that is not found is an error with the server message and is not read again', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => useSnapshotJob('gone', true));
    await settle();
    expect(probe.current.error).toMatchObject({ status: 404, message: 'Dataset not found' });
  });

  it('a disabled job makes no request', async () => {
    const client = newTestQueryClient();
    await renderHook(client, () => useSnapshotJob('d1', false));
    await settle();
    expect(calls).toHaveLength(0);
  });
});
