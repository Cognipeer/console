// @vitest-environment jsdom
/**
 * The quota editor's query hooks: the key and how the defaults read behaves.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quotaKeys, useQuotaDefaults } from '@/lib/api/queries/quota';
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
});
