// @vitest-environment jsdom
/**
 * The type-ahead behind the target pickers, without any UI: the pause before a
 * keystroke is sent, the first page that needs no typing, a request that is
 * overtaken, and a stored value that is looked up. Fake timers make the 250 ms
 * exact instead of "long enough".
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@/components/quota/pickerSources';
import {
  SEARCH_DEBOUNCE_MS,
  useTargetResolution,
  useTargetSearch,
  type TargetSearch,
} from '@/components/quota/useTargetSearch';
import { quotaTargetSource } from '@/lib/quota/targets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const llm = quotaTargetSource('llm', 'resource')!;

const row = (id: string, key: string, name = key, projectId = 'p1') => ({
  type: 'model', id, key, name, projectId, projectName: 'Retail',
  projectDisplay: { kind: 'project', projectId, projectName: 'Retail' }, status: null, attributes: [{ key: 'category', value: 'llm' }],
});

interface Call {
  url: URL;
  signal?: AbortSignal;
  respond: (status: number, body: unknown) => void;
}

/** A fetch whose answers are given by the test, one call at a time. */
function controlledFetch() {
  const calls: Call[] = [];
  const fetcher: FetchLike = (url, init) =>
    new Promise((resolve) => {
      calls.push({
        url: new URL(url, 'https://console.test'),
        signal: init?.signal,
        respond: (status, body) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
      });
    });
  return { calls, fetcher, queries: () => calls.map((c) => c.url.searchParams.get('q')) };
}

let root: Root;
let host: HTMLElement;
let latest: TargetSearch;

function Probe(props: { fetcher: FetchLike }) {
  latest = useTargetSearch(llm, { fetcher: props.fetcher });
  return null;
}

async function mountSearch(fetcher: FetchLike) {
  await act(async () => {
    root.render(createElement(Probe, { fetcher }));
  });
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const type = (query: string) => act(async () => { latest.setQuery(query); });

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('useTargetSearch', () => {
  it('asks for the first page at once, with nothing typed', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountSearch(fetcher);
    await advance(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('q')).toBeNull();
    expect(latest.loading).toBe(true);

    calls[0].respond(200, { items: [row('m1', 'gpt-4o', 'GPT-4o')], total: 1 });
    await advance(0);
    expect(latest.loading).toBe(false);
    expect(latest.status).toBe('ok');
    expect(latest.options.map((o) => o.value)).toEqual(['gpt-4o']);
    expect(latest.total).toBe(1);
  });

  it(`sends one request ${SEARCH_DEBOUNCE_MS} ms after the last keystroke, not one per keystroke`, async () => {
    const { calls, fetcher, queries } = controlledFetch();
    await mountSearch(fetcher);
    await advance(0);
    calls[0].respond(200, { items: [], total: 0 });
    await advance(0);

    await type('g');
    await advance(100);
    await type('gp');
    await advance(100);
    await type('gpt');
    await advance(SEARCH_DEBOUNCE_MS - 1);
    expect(queries()).toEqual([null]);

    await advance(1);
    expect(queries()).toEqual([null, 'gpt']);
  });

  it('says it is loading from the keystroke on, and keeps the old options until the new ones arrive', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountSearch(fetcher);
    await advance(0);
    calls[0].respond(200, { items: [row('m1', 'gpt-4o')], total: 1 });
    await advance(0);
    expect(latest.loading).toBe(false);

    await type('claude');
    expect(latest.loading).toBe(true);
    expect(latest.options.map((o) => o.value)).toEqual(['gpt-4o']);

    await advance(SEARCH_DEBOUNCE_MS);
    expect(latest.loading).toBe(true);
    calls[1].respond(200, { items: [row('m2', 'claude-sonnet')], total: 1 });
    await advance(0);
    expect(latest.loading).toBe(false);
    expect(latest.options.map((o) => o.value)).toEqual(['claude-sonnet']);
  });

  it('aborts a search that a newer keystroke overtakes, and ignores its late answer', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountSearch(fetcher);
    await advance(0);
    calls[0].respond(200, { items: [], total: 0 });
    await advance(0);

    await type('gpt');
    await advance(SEARCH_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    await type('gpt-4o');
    // The first search is still running; the new keystroke cancels it.
    expect(calls[1].signal?.aborted).toBe(true);
    await advance(SEARCH_DEBOUNCE_MS);
    expect(calls).toHaveLength(3);

    calls[2].respond(200, { items: [row('m1', 'gpt-4o')], total: 1 });
    await advance(0);
    // The old answer arrives late and must not win.
    calls[1].respond(200, { items: [row('m2', 'gpt-4o-mini')], total: 1 });
    await advance(0);
    expect(latest.options.map((o) => o.value)).toEqual(['gpt-4o']);
    expect(latest.loading).toBe(false);
  });

  it('does not ask again for blanks: they are not a different question', async () => {
    const { calls, fetcher, queries } = controlledFetch();
    await mountSearch(fetcher);
    await advance(0);
    calls[0].respond(200, { items: [], total: 0 });
    await advance(0);

    await type('   ');
    await advance(SEARCH_DEBOUNCE_MS * 2);
    expect(queries()).toEqual([null]);

    await type('gpt');
    await advance(SEARCH_DEBOUNCE_MS);
    expect(queries()).toEqual([null, 'gpt']);
    // A space after the word, or before it, is still the same question.
    await type('gpt ');
    await type(' gpt ');
    await advance(SEARCH_DEBOUNCE_MS * 2);
    expect(queries()).toEqual([null, 'gpt']);
  });

  it('reports a registry it may not browse, and a search that failed', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountSearch(fetcher);
    await advance(0);
    calls[0].respond(403, { error: 'Forbidden' });
    await advance(0);
    expect(latest.status).toBe('unavailable');
    expect(latest.options).toEqual([]);

    await type('x');
    await advance(SEARCH_DEBOUNCE_MS);
    calls[1].respond(500, { error: 'boom' });
    await advance(0);
    expect(latest.status).toBe('failed');
    expect(latest.loading).toBe(false);
  });

  it('abandons its search when the picker goes away', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountSearch(fetcher);
    await advance(0);
    await act(async () => root.unmount());
    expect(calls[0].signal?.aborted).toBe(true);
    // (a late answer then has nobody to update; React would warn about it.)
    calls[0].respond(200, { items: [], total: 0 });
    await advance(0);
    root = createRoot(host);
  });

  it('is not restarted by a new function each render', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountSearch((url, init) => fetcher(url, init));
    await advance(0);
    await mountSearch((url, init) => fetcher(url, init));
    await mountSearch((url, init) => fetcher(url, init));
    await advance(SEARCH_DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(1);
  });
});

describe('useTargetResolution', () => {
  let answer: ReturnType<typeof useTargetResolution>;

  function Resolver(props: { value?: string; skip?: boolean; project?: string; fetcher: FetchLike }) {
    answer = useTargetResolution(llm, props.value, { skip: props.skip, preferProjectId: props.project, fetcher: props.fetcher });
    return null;
  }
  const mountResolver = (props: { value?: string; skip?: boolean; project?: string; fetcher: FetchLike }) =>
    act(async () => {
      root.render(createElement(Resolver, props));
    });

  it('asks nothing when there is no value, or when the value was just picked', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountResolver({ fetcher });
    await mountResolver({ value: 'gpt-4o', skip: true, fetcher });
    await advance(0);
    expect(calls).toHaveLength(0);
    expect(answer).toBeNull();
  });

  it('looks a stored value up by exactly that value and says what it found', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountResolver({ value: 'gpt-4o', fetcher });
    await advance(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('q')).toBe('gpt-4o');
    expect(answer).toBeNull(); // not answered yet

    calls[0].respond(200, { items: [row('m1', 'gpt-4o', 'GPT-4o')], total: 1 });
    await advance(0);
    expect(answer).toMatchObject({ status: 'found', option: { label: 'GPT-4o' } });
  });

  it('calls a value missing only when the registry answered without it', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountResolver({ value: 'retired', fetcher });
    await advance(0);
    calls[0].respond(200, { items: [row('m1', 'gpt-4o')], total: 1 });
    await advance(0);
    expect(answer).toEqual({ status: 'missing' });
  });

  it('forgets an answer that belongs to the value it was asked about, not the one that replaced it', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountResolver({ value: 'one', fetcher });
    await advance(0);
    await mountResolver({ value: 'two', fetcher });
    await advance(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);

    // The answer for "one" arrives late; "two" is the value now.
    calls[0].respond(200, { items: [row('m1', 'one')], total: 1 });
    await advance(0);
    expect(answer).toBeNull();
    calls[1].respond(200, { items: [row('m2', 'two')], total: 1 });
    await advance(0);
    expect(answer).toMatchObject({ status: 'found', option: { value: 'two' } });
  });

  it('prefers the row in the project it was given', async () => {
    const { calls, fetcher } = controlledFetch();
    await mountResolver({ value: 'docs', project: 'p2', fetcher });
    await advance(0);
    calls[0].respond(200, { items: [row('a', 'docs', 'Docs', 'p1'), row('b', 'docs', 'Docs', 'p2')], total: 2 });
    await advance(0);
    expect(answer).toMatchObject({ status: 'found', option: { id: 'model:b', projectId: 'p2' } });
  });
});
