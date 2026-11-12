// @vitest-environment jsdom
/**
 * The Prompt Studio query hooks: their keys and what each mutation does to the cache.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  promptsKeys,
  useAddPromptComment,
  useCreatePrompt,
  useDeletePrompt,
  useDeletePromptComment,
  usePromptComments,
  usePromptList,
  useUpdatePrompt,
} from '@/lib/api/queries/prompts';
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

describe('Prompt Studio hooks', () => {
  let calls: Array<{ method: string; path: string; body: unknown }>;
  let prompts: Array<Record<string, unknown>>;
  let comments: Array<Record<string, unknown>>;

  beforeEach(() => {
    calls = [];
    prompts = [{ id: 'p1', name: 'One' }];
    comments = [{ id: 'c1', content: 'first' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = new URL(input, 'http://localhost').pathname;
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'GET' && path === '/api/prompts') return jsonResponse({ prompts });
        if (method === 'GET' && path === '/api/prompts/p1/comments') return jsonResponse({ comments });
        if (method === 'POST' && path === '/api/prompts') {
          prompts.push({ id: 'p2', name: 'Two' });
          return jsonResponse({ prompt: { id: 'p2', name: 'Two' } }, 201);
        }
        if (method === 'PATCH' && path === '/api/prompts/p1') return jsonResponse({ prompt: { id: 'p1', name: 'Renamed' } });
        if (method === 'DELETE' && path === '/api/prompts/p1') {
          prompts.splice(0, prompts.length);
          return jsonResponse({ success: true });
        }
        if (method === 'POST' && path === '/api/prompts/p1/comments') return jsonResponse({ comment: { id: 'c2', content: 'second' } }, 201);
        if (method === 'DELETE' && path === '/api/prompts/p1/comments/c1') return jsonResponse({ success: true });
        return jsonResponse({ error: `no mock for ${method} ${path}` }, { status: 404 } as never);
      }),
    );
  });

  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(promptsKeys.list('project:3')).toEqual(['prompts', 'project:3', 'list']);
    const detail = promptsKeys.detail('project:3', 'p1');
    expect(promptsKeys.versions('project:3', 'p1').slice(0, detail.length)).toEqual([...detail]);
    expect(promptsKeys.comments('project:3', 'p1').slice(0, detail.length)).toEqual([...detail]);
  });

  it('create refreshes the list; update puts the saved prompt in the cache; delete drops it', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      list: usePromptList(),
      create: useCreatePrompt(),
      update: useUpdatePrompt(),
      remove: useDeletePrompt(),
    }));
    await settle();
    expect(probe.current.list.data).toEqual([{ id: 'p1', name: 'One' }]);

    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'Two', template: 't' });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/prompts')).toHaveLength(2);
    expect(probe.current.list.data).toHaveLength(2);

    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'p1', name: 'Renamed', template: 't' });
    });
    expect(client.getQueryData(promptsKeys.detail(getProjectScope(), 'p1'))).toEqual({ id: 'p1', name: 'Renamed' });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed', template: 't' });

    client.setQueryData(promptsKeys.detail(getProjectScope(), 'p1'), { id: 'p1', name: 'x' });
    await act(async () => {
      await probe.current.remove.mutateAsync('p1');
    });
    await settle();
    expect(client.getQueryData(promptsKeys.detail(getProjectScope(), 'p1'))).toBeUndefined();
    expect(probe.current.list.data).toEqual([]);
  });

  it('adds and deletes a comment in the cached list without rereading it', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      list: usePromptComments('p1'),
      add: useAddPromptComment('p1'),
      remove: useDeletePromptComment('p1'),
    }));
    await settle();
    expect(probe.current.list.data).toEqual([{ id: 'c1', content: 'first' }]);

    await act(async () => {
      await probe.current.add.mutateAsync('second');
    });
    await settle();
    expect(probe.current.list.data?.map((c) => c.id)).toEqual(['c2', 'c1']);

    await act(async () => {
      await probe.current.remove.mutateAsync('c1');
    });
    await settle();
    expect(probe.current.list.data?.map((c) => c.id)).toEqual(['c2']);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/prompts/p1/comments')).toHaveLength(1);
  });
});
