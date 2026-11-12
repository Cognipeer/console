// @vitest-environment jsdom
/**
 * The playground hooks: the request each run makes, and the text of a failed run, which names the status when the
 * server gave no message.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import {
  playgroundErrorMessage,
  useDecisionPlayground,
  useEmbeddingPlayground,
  useImagePlayground,
} from '@/lib/api/queries/playground';
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

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe('playground hooks', () => {
  let calls: Array<{ method: string; path: string; body: unknown }>;
  let respond: () => Response;

  beforeEach(() => {
    calls = [];
    respond = () => jsonResponse({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return respond();
      }),
    );
  });

  it('posts each run to its own route and hands the answer back', async () => {
    respond = () => jsonResponse({ ok: true });
    const probe = await renderHook(newTestQueryClient(), () => ({
      decision: useDecisionPlayground<{ ok: boolean }>(),
      embedding: useEmbeddingPlayground<{ ok: boolean }>(),
      image: useImagePlayground<{ ok: boolean }>(),
    }));

    await act(async () => {
      await expect(probe.current.decision.mutateAsync({ input: 'x', questions: [] })).resolves.toEqual({ ok: true });
      await probe.current.embedding.mutateAsync({ model: 'emb', input: ['a', 'b'] });
      await probe.current.image.mutateAsync({ model: 'img', prompt: 'a cat' });
    });
    expect(calls).toEqual([
      { method: 'POST', path: '/api/dashboard/playground/decisions', body: { input: 'x', questions: [] } },
      { method: 'POST', path: '/api/dashboard/playground/embeddings', body: { model: 'emb', input: ['a', 'b'] } },
      { method: 'POST', path: '/api/dashboard/playground/images', body: { model: 'img', prompt: 'a cat' } },
    ]);
  });

  it('a failed run carries the server message to the screen, else names the status', async () => {
    respond = () => jsonResponse({ error: 'Model is not available' }, 400);
    const probe = await renderHook(newTestQueryClient(), () => useEmbeddingPlayground<unknown>());
    let failure: unknown;
    await act(async () => {
      failure = await probe.current.mutateAsync({ model: 'emb', input: ['a'] }).catch((error: unknown) => error);
    });
    expect(playgroundErrorMessage(failure, 'Embedding request failed')).toBe('Model is not available');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(probe.current.isError).toBe(true);

    expect(playgroundErrorMessage(new ApiError('', 502, {}), 'x')).toBe('Request failed (502)');
    expect(playgroundErrorMessage(new ApiError('Bad Gateway', 502, undefined), 'x')).toBe('Request failed (502)');
    expect(playgroundErrorMessage(new Error('offline'), 'x')).toBe('offline');
    expect(playgroundErrorMessage('boom', 'Decision failed')).toBe('Decision failed');
  });
});
