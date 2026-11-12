// @vitest-environment jsdom
/**
 * The Analysis query hooks: keys, the run poll, the review queue, and what each mutation does to the cache.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  analysisKeys,
  useAnalysisConversations,
  useAnalysisDefinition,
  useAnalysisDefinitions,
  useAnalysisEstimate,
  useAnalysisResult,
  useAnalysisResults,
  useAnalysisRun,
  useAnalysisRuns,
  useAgentOptions,
  useAgentSessions,
  useDecisionModelOptions,
  useDeleteAnalysisConversation,
  useDeleteAnalysisDefinition,
  useIngestAnalysisConversations,
  useLlmModelOptions,
  useLoadAnalysisResults,
  useReviewAnalysisResult,
  useRunAnalysisDefinition,
  useSaveAnalysisDefinition,
} from '@/lib/api/queries/analysis';
import { jsonResponse } from '../helpers/iamCenterUi';

/** No retries, and nothing is collected: a cache entry a test sets stays until a mutation removes it. */
const newTestQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });

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

type Call = { method: string; path: string; search: string; body: unknown };

function stubFetch(handler: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const call: Call = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        search: url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call) ?? jsonResponse({ error: `no mock for ${call.method} ${call.path}` }, 404);
    }),
  );
  return calls;
}

describe('Analysis hooks', () => {
  const definition = { id: 'd1', key: 'qa', name: 'QA', fieldSet: [], modes: {} };

  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(analysisKeys.definitionList('project:3')).toEqual(['analysis', 'project:3', 'definitions', 'list']);
    const defs = analysisKeys.definitions('project:3');
    for (const key of [analysisKeys.definition('project:3', 'd1'), analysisKeys.calibration('project:3', 'd1')]) {
      expect(key.slice(0, defs.length)).toEqual([...defs]);
    }
    expect(analysisKeys.run('project:3', 'r1').slice(0, 3)).toEqual([...analysisKeys.runs('project:3')]);
  });

  it('saving a definition creates or edits it and rereads the definitions; deleting drops its cache', async () => {
    let definitions: Array<Record<string, unknown>> = [definition];
    const calls = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/api/analysis/definitions') return jsonResponse({ definitions });
      if (method === 'POST' && path === '/api/analysis/definitions') {
        definitions = [...definitions, { ...definition, id: 'd2', ...(body as object) }];
        return jsonResponse({ definition: definitions[1] }, 201);
      }
      if (method === 'PATCH' && path === '/api/analysis/definitions/d1') {
        definitions = [{ ...definition, ...(body as object) }];
        return jsonResponse({ definition: definitions[0] });
      }
      if (method === 'DELETE' && path === '/api/analysis/definitions/d1') {
        definitions = [];
        return jsonResponse({ success: true });
      }
      return undefined;
    });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      list: useAnalysisDefinitions(),
      save: useSaveAnalysisDefinition(),
      remove: useDeleteAnalysisDefinition(),
    }));
    await settle();
    expect(probe.current.list.data).toHaveLength(1);

    await act(async () => {
      const created = await probe.current.save.mutateAsync({ body: { name: 'Two' } });
      expect(created.id).toBe('d2');
    });
    await settle();
    expect(probe.current.list.data).toHaveLength(2);

    await act(async () => {
      await probe.current.save.mutateAsync({ id: 'd1', body: { name: 'Renamed' } });
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed' });

    client.setQueryData(analysisKeys.definition(getProjectScope(), 'd1'), definition);
    await act(async () => {
      await probe.current.remove.mutateAsync('d1');
    });
    await settle();
    expect(client.getQueryData(analysisKeys.definition(getProjectScope(), 'd1'))).toBeUndefined();
    expect(probe.current.list.data).toEqual([]);
  });

  it('a conversation ingest and a delete reread the conversations', async () => {
    let conversations: Array<Record<string, unknown>> = [{ id: 'c1', key: 'one', transcript: [] }];
    stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/analysis/conversations') return jsonResponse({ conversations });
      if (method === 'POST' && path === '/api/analysis/conversations') {
        conversations = [...conversations, { id: 'c2', key: 'two', transcript: [] }];
        return jsonResponse({ conversations: [conversations[1]] }, 201);
      }
      if (method === 'DELETE' && path === '/api/analysis/conversations/c1') {
        conversations = conversations.filter((c) => c.id !== 'c1');
        return jsonResponse({ success: true });
      }
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useAnalysisConversations(),
      ingest: useIngestAnalysisConversations(),
      remove: useDeleteAnalysisConversation(),
    }));
    await settle();
    await act(async () => {
      const added = await probe.current.ingest.mutateAsync({ conversations: [{ content: 'x' }], tags: ['t'] });
      expect(added).toHaveLength(1);
    });
    await settle();
    expect(probe.current.list.data).toHaveLength(2);
    await act(async () => {
      await probe.current.remove.mutateAsync('c1');
    });
    await settle();
    expect(probe.current.list.data?.map((c) => c.id)).toEqual(['c2']);
  });

  it('starting a run rereads the runs; a run is polled while it is running and not after', async () => {
    let status = 'running';
    const calls = stubFetch(({ method, path }) => {
      if (method === 'POST' && path === '/api/analysis/definitions/qa/run') return jsonResponse({ run: { id: 'r1' } }, 201);
      if (method === 'GET' && path === '/api/analysis/runs') return jsonResponse({ runs: [] });
      if (method === 'GET' && path === '/api/analysis/runs/r1') return jsonResponse({ run: { id: 'r1', status } });
      return undefined;
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const probe = await renderHook(newTestQueryClient(), () => ({
        runs: useAnalysisRuns(),
        run: useAnalysisRun('r1'),
        start: useRunAnalysisDefinition(),
      }));
      await settle();
      const polls = () => calls.filter((c) => c.path === '/api/analysis/runs/r1').length;
      expect(polls()).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(polls()).toBe(2);

      status = 'completed';
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(probe.current.run.data?.status).toBe('completed');
      const settled = polls();
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(polls()).toBe(settled);

      const before = calls.filter((c) => c.method === 'GET' && c.path === '/api/analysis/runs').length;
      await act(async () => {
        const data = await probe.current.start.mutateAsync({ definitionKey: 'qa', payload: { selection: { strategy: 'all' } } });
        expect(data.run?.id).toBe('r1');
      });
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ selection: { strategy: 'all' } });
      expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/analysis/runs').length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the review queue is asked for the flagged results, and a saved review replaces the open result', async () => {
    const detail = { result: { id: 'x1', reviewed: false }, definition: definition, source: { kind: 'conversation', id: 'c1' } };
    const calls = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/api/analysis/results') return jsonResponse({ results: [{ id: 'x1' }], total: 7 });
      if (method === 'GET' && path === '/api/analysis/results/x1') return jsonResponse(detail);
      if (method === 'POST' && path === '/api/analysis/results/x1/review') {
        return jsonResponse({ result: { id: 'x1', reviewed: true, review: body } });
      }
      return undefined;
    });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      queue: useAnalysisResults({ definitionKey: 'qa', needsReview: true, sort: 'confidence', limit: 50, skip: 0 }),
      detail: useAnalysisResult('x1'),
      review: useReviewAnalysisResult(),
      loadNext: useLoadAnalysisResults(),
    }));
    await settle();
    expect(calls[0].search).toBe('?definitionKey=qa&needsReview=true&sort=confidence&limit=50&skip=0');
    expect(probe.current.queue.data).toEqual({ results: [{ id: 'x1' }], total: 7 });

    await act(async () => {
      await probe.current.review.mutateAsync({ id: 'x1', values: { q: 'yes' } });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ values: { q: 'yes' } });
    expect(probe.current.detail.data?.result).toMatchObject({ id: 'x1', reviewed: true });
    expect(probe.current.detail.data?.definition).toEqual(definition);

    const next = await probe.current.loadNext({ definitionKey: 'qa', needsReview: true, limit: 3 });
    expect(next.total).toBe(7);
  });

  it('agent sessions load page by page with the cursor', async () => {
    const calls = stubFetch(({ method, path, search }) => {
      if (method === 'GET' && path === '/api/analysis/sources/agent-sessions') {
        return search.includes('cursor=c2')
          ? jsonResponse({ rows: [{ id: 's2' }, { id: 's3' }] })
          : jsonResponse({ rows: [{ id: 's1' }, { id: 's2' }], nextCursor: 'c2' });
      }
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () =>
      useAgentSessions({ definitionKey: 'qa', agentKey: 'bot', days: '7', limit: 50 }),
    );
    await settle();
    expect(calls[0].search).toBe('?definitionKey=qa&days=7&limit=50&agentKey=bot');
    expect(probe.current.hasNextPage).toBe(true);
    await act(async () => { await probe.current.fetchNextPage(); });
    await settle();
    expect(calls[1].search).toContain('cursor=c2');
    expect(probe.current.data?.pages.flatMap((p) => p.rows).map((r) => r.id)).toEqual(['s1', 's2', 's2', 's3']);
    expect(probe.current.hasNextPage).toBe(false);
  });

  it('the estimate posts the run body and waits without one', async () => {
    const calls = stubFetch(({ method, path }) =>
      method === 'POST' && path === '/api/analysis/definitions/qa/estimate'
        ? jsonResponse({ estimate: { conversations: 4 } })
        : undefined,
    );
    const waiting = await renderHook(newTestQueryClient(), () => useAnalysisEstimate('qa', null));
    await settle();
    expect(calls).toHaveLength(0);
    expect(waiting.current.data).toBeUndefined();
    await act(async () => root?.unmount());

    const body = JSON.stringify({ selection: { strategy: 'all' }, target: { kind: 'conversations' } });
    const probe = await renderHook(newTestQueryClient(), () => useAnalysisEstimate('qa', body));
    await settle();
    expect(calls[0].body).toEqual({ selection: { strategy: 'all' }, target: { kind: 'conversations' } });
    expect(probe.current.data).toEqual({ conversations: 4 });
  });

  it('the pickers read the model and agent lists as options', async () => {
    stubFetch(({ method, path, search }) => {
      if (method === 'GET' && path === '/api/models') {
        return search === '?category=decision'
          ? jsonResponse({ models: [{ key: 'm1', name: 'Native', settings: { decision: { mode: 'native' } } }, { key: 'm2', name: 'Emulated' }] })
          : jsonResponse({ models: [{ key: 'l1', name: 'LLM' }] });
      }
      if (method === 'GET' && path === '/api/agents') return jsonResponse({ agents: [{ key: 'a1', name: 'Agent' }] });
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      llm: useLlmModelOptions(),
      decision: useDecisionModelOptions(true),
      agents: useAgentOptions(true),
    }));
    await settle();
    expect(probe.current.llm.data).toEqual([{ value: 'l1', label: 'LLM' }]);
    expect(probe.current.decision.data).toEqual([
      { value: 'm1', label: 'Native', selfReported: false },
      { value: 'm2', label: 'Emulated', selfReported: true },
    ]);
    expect(probe.current.agents.data).toEqual([{ value: 'a1', label: 'Agent' }]);
  });

  it('the server message of a failed request reaches the screen', async () => {
    stubFetch(({ method, path }) => {
      if (method === 'POST' && path === '/api/analysis/definitions') return jsonResponse({ error: 'Name is required' }, 400);
      if (method === 'GET' && path === '/api/analysis/definitions/zz') return jsonResponse({ error: 'Not found' }, 404);
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({ save: useSaveAnalysisDefinition(), detail: useAnalysisDefinition('zz') }));
    await settle();
    await act(async () => {
      await expect(probe.current.save.mutateAsync({ body: {} })).rejects.toMatchObject({ message: 'Name is required', status: 400 });
    });
    expect(probe.current.detail.error).toMatchObject({ status: 404 });
  });
});
