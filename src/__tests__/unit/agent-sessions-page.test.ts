// @vitest-environment jsdom
/**
 * The project-wide Sessions page (Agents > Sessions > Active / All): what it
 * asks the API for, how it keeps itself current, and that a row opens the
 * inspector and never the chat page.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm';
import AgentSessionsPage from '@/components/agents/sessions/AgentSessionsPage';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
const nav = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(nav.query),
  useParams: () => ({}),
  usePathname: () => '/dashboard/agents/sessions',
}));

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => undefined);
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const wrap = (node: ReactNode) => h(MantineProvider, null, h(I18nProvider, { locale: 'en', children: h(ConfirmProvider, null, node) }));
function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(wrap(h(AgentSessionsPage))));
}
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
// Mantine's drawer mounts its content after a transition frame.
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); }); };
const text = () => document.body.textContent ?? '';
const json = (body: unknown, ok = true, status = ok ? 200 : 500) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
const buttonByText = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const setVisibility = (state: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });

let fetchMock: ReturnType<typeof vi.fn>;
const listCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/agents/sessions'));

interface Row {
  _id: string; title?: string; agentId?: string; agentKey?: string; agentName?: string; source?: string;
  updatedAt?: string; runtimeStatus?: string; activeRun?: { id: string; status: string };
}
const row = (patch: Partial<Row> = {}): Row => ({
  _id: 'sess-0001-aaaa', title: 'First chat', agentId: 'ag1', agentKey: 'alpha', agentName: 'Alpha', source: 'console',
  updatedAt: '2026-10-19T10:00:00.000Z', runtimeStatus: 'idle', ...patch,
});
const page = (sessions: Row[], extra: Record<string, unknown> = {}) => ({ sessions, hasMore: false, scope: { viewOthers: true }, ...extra });

beforeEach(() => {
  nav.query = '';
  fetchMock = vi.fn(() => json(null, false));
  vi.stubGlobal('fetch', fetchMock);
  router.push.mockClear();
  router.replace.mockClear();
  setVisibility('visible');
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('AgentSessionsPage loading', () => {
  it('reads the All view by default and lists the rows with their agent', async () => {
    fetchMock.mockImplementation(() => json(page([row(), row({ _id: 'sess-0002-bbbb', title: 'Second chat', agentId: 'ag2', agentName: 'Beta' })])));
    mount();
    await flush();
    expect(listCalls()).toEqual(['/api/agents/sessions?view=all&limit=100']);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/sessions?view=all&limit=100', { cache: 'no-store' });
    expect(text()).toContain('All sessions');
    expect(text()).toContain('First chat');
    expect(text()).toContain('Beta');
  });

  it('reads the Active view from ?view=active', async () => {
    nav.query = 'view=active';
    fetchMock.mockImplementation(() => json(page([])));
    mount();
    await flush();
    expect(listCalls()).toEqual(['/api/agents/sessions?view=active&limit=100']);
    expect(text()).toContain('Active sessions');
    expect(text()).toContain('No active sessions');
    expect(text()).toContain('Refreshes automatically');
    expect(buttonByText('Start new session')).toBeUndefined();
  });

  it('shows the error with a retry, and the retry reads again', async () => {
    fetchMock.mockImplementationOnce(() => json({ error: 'boom' }, false, 500));
    mount();
    await flush();
    expect(text()).toContain('Could not load sessions');
    expect(text()).toContain('boom');
    fetchMock.mockImplementation(() => json(page([row()])));
    await act(async () => { buttonByText('Retry')!.click(); });
    await flush();
    expect(text()).not.toContain('Could not load sessions');
    expect(text()).toContain('First chat');
  });

  it('says so when the viewer sees only their own sessions, and when only for some agents', async () => {
    fetchMock.mockImplementation(() => json(page([row()], { scope: { viewOthers: false } })));
    mount();
    await flush();
    expect(text()).toContain('You see only the sessions you started');

    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
    fetchMock.mockImplementation(() => json(page([row()], { scope: { viewOthers: false, partial: true } })));
    mount();
    await flush();
    expect(text()).toContain('For some agents you see only the sessions you started');
    expect(text()).not.toContain('You see only the sessions you started. Viewing');
  });

  it('says nothing about scope when the viewer sees everyone', async () => {
    fetchMock.mockImplementation(() => json(page([row()])));
    mount();
    await flush();
    expect(document.body.querySelector('[data-testid="sessions-scope-notice"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="sessions-own-only"]')).toBeNull();
  });
});

describe('AgentSessionsPage load more', () => {
  it('appends the next page by cursor and drops a row it already has', async () => {
    fetchMock.mockImplementation((url: string) => (
      url.includes('cursor=')
        ? json(page([row({ _id: 'sess-0002-bbbb', title: 'Second chat', updatedAt: '2026-10-18T10:00:00.000Z' }), row({ title: 'First chat' })]))
        : json(page([row()], { hasMore: true, nextCursor: 'abc+/=' }))
    ));
    mount();
    await flush();
    expect(text()).not.toContain('Second chat');
    await act(async () => { buttonByText('Load more')!.click(); });
    await flush();
    expect(listCalls()[1]).toBe('/api/agents/sessions?view=all&limit=100&cursor=abc%2B%2F%3D');
    expect(text()).toContain('Second chat');
    expect(text().match(/First chat/g)).toHaveLength(1);
    expect(buttonByText('Load more')).toBeUndefined();
  });

  it('offers no Load more in the Active view', async () => {
    nav.query = 'view=active';
    fetchMock.mockImplementation(() => json(page([row({ runtimeStatus: 'running' })], { hasMore: true, nextCursor: 'x' })));
    mount();
    await flush();
    expect(buttonByText('Load more')).toBeUndefined();
  });
});

describe('AgentSessionsPage truncated Active list', () => {
  const note = 'Showing the first 100 active sessions';

  it('says when the Active list was cut, and offers no Load more', async () => {
    nav.query = 'view=active';
    fetchMock.mockImplementation(() => json(page([row({ runtimeStatus: 'running' })], { hasMore: true })));
    mount();
    await flush();
    expect(text()).toContain(note);
    expect(text()).toContain('Older waiting sessions are under All.');
    expect(buttonByText('Load more')).toBeUndefined();
  });

  it('says nothing when the Active list is complete', async () => {
    nav.query = 'view=active';
    fetchMock.mockImplementation(() => json(page([row({ runtimeStatus: 'running' })], { hasMore: false })));
    mount();
    await flush();
    expect(text()).not.toContain(note);
  });

  it('does not use the line for the All view', async () => {
    fetchMock.mockImplementation(() => json(page([row()], { hasMore: true, nextCursor: 'c' })));
    mount();
    await flush();
    expect(text()).not.toContain(note);
  });
});

describe('AgentSessionsPage refresh', () => {
  it('polls the Active view and replaces its rows', async () => {
    vi.useFakeTimers();
    nav.query = 'view=active';
    fetchMock.mockImplementation(() => json(page([row({ runtimeStatus: 'running' })])));
    mount();
    await flush();
    expect(listCalls()).toHaveLength(1);
    fetchMock.mockImplementation(() => json(page([row({ _id: 'sess-0009-zzzz', title: 'Newer chat', runtimeStatus: 'requires_action' })])));
    await advance(5000);
    expect(listCalls()).toHaveLength(2);
    expect(text()).toContain('Newer chat');
    expect(text()).not.toContain('First chat');
  });

  it('polls the All view only while a session in it is ongoing', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => json(page([row()])));
    mount();
    await flush();
    await advance(15000);
    expect(listCalls()).toHaveLength(1);

    // a queued run counts as ongoing even before the session says "running"
    fetchMock.mockImplementation(() => json(page([row({ activeRun: { id: 'run_1', status: 'queued' } })])));
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[aria-label="Refresh sessions"]')!.click(); });
    await flush();
    const before = listCalls().length;
    await advance(5000);
    expect(listCalls().length).toBe(before + 1);

    // the run ended: polling stops again
    fetchMock.mockImplementation(() => json(page([row()])));
    await advance(5000);
    const settled = listCalls().length;
    await advance(15000);
    expect(listCalls().length).toBe(settled);
  });

  it('skips ticks in a hidden tab and refreshes once when it is visible again', async () => {
    vi.useFakeTimers();
    nav.query = 'view=active';
    fetchMock.mockImplementation(() => json(page([row({ runtimeStatus: 'running' })])));
    mount();
    await flush();
    setVisibility('hidden');
    await advance(20000);
    expect(listCalls()).toHaveLength(1);
    setVisibility('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(listCalls()).toHaveLength(2);
  });

  it('keeps the rows when a silent refresh fails, and says it failed', async () => {
    vi.useFakeTimers();
    nav.query = 'view=active';
    fetchMock.mockImplementation(() => json(page([row({ runtimeStatus: 'running' })])));
    mount();
    await flush();
    fetchMock.mockImplementation(() => json({ error: 'gone' }, false, 502));
    await advance(5000);
    expect(text()).toContain('First chat');
    expect(text()).toContain('Could not load sessions');
  });

  it('merges a fresh first page into the All view: fresh rows win, departed rows go, older pages stay', async () => {
    vi.useFakeTimers();
    const stamp = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`;
    // Page 1 of the first read holds days 19..18 (more follow); "Load more" brings day 10.
    fetchMock.mockImplementation((url: string) => (
      url.includes('cursor=')
        ? json(page([row({ _id: 'old', title: 'Old chat', updatedAt: stamp(10) })]))
        : json(page(
          [row({ _id: 'a', title: 'Alpha chat', updatedAt: stamp(19), runtimeStatus: 'running' }), row({ _id: 'b', title: 'Gone chat', updatedAt: stamp(18) })],
          { hasMore: true, nextCursor: 'c1' },
        ))
    ));
    mount();
    await flush();
    await act(async () => { buttonByText('Load more')!.click(); });
    await flush();
    expect(text()).toContain('Old chat');

    // b left the window (absent, yet not older than the page's oldest row); a moved; c is new
    fetchMock.mockImplementation(() => json(page(
      [
        row({ _id: 'c', title: 'Fresh chat', updatedAt: stamp(21) }),
        row({ _id: 'a', title: 'Alpha renamed', updatedAt: stamp(20), runtimeStatus: 'running' }),
        row({ _id: 'd', title: 'Edge chat', updatedAt: stamp(17) }),
      ],
      { hasMore: true, nextCursor: 'c2' },
    )));
    await advance(5000);
    expect(text()).toContain('Fresh chat');
    expect(text()).toContain('Alpha renamed');
    expect(text()).not.toContain('Alpha chat');
    expect(text()).not.toContain('Gone chat');
    expect(text()).toContain('Old chat');
    // rows are shown most recent first
    expect(text().indexOf('Fresh chat')).toBeLessThan(text().indexOf('Alpha renamed'));
    expect(text().indexOf('Alpha renamed')).toBeLessThan(text().indexOf('Old chat'));
  });
});

describe('AgentSessionsPage inspector', () => {
  const detail = (patch: Record<string, unknown> = {}) => ({
    _id: 'sess-0002-bbbb', title: 'API chat', messages: [], metadata: { source: 'api' }, runtimeStatus: 'idle',
    updatedAt: '2026-10-19T10:00:00.000Z', ...patch,
  });

  it('opens the clicked row in the inspector of its own agent and never routes to the chat page', async () => {
    const rows = [row(), row({ _id: 'sess-0002-bbbb', title: 'API chat', source: 'api', agentId: 'ag2', agentName: 'Beta' })];
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/agents/sessions')) return json(page(rows));
      if (url === '/api/agents/ag2/sessions/sess-0002-bbbb') return json({ session: detail(), pendingActions: [] });
      return json(null, false);
    });
    mount();
    await flush();
    await act(async () => { buttonByText('API chat')!.click(); });
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/ag2/sessions/sess-0002-bbbb', expect.objectContaining({ cache: 'no-store' }));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('never offers Continue for a session that is not a console session, and no row has a Continue', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/agents/sessions')) return json(page([row({ _id: 'sess-0002-bbbb', title: 'API chat', source: 'api', agentId: 'ag2' })]));
      if (url === '/api/agents/ag2/sessions/sess-0002-bbbb') return json({ session: detail(), pendingActions: [] });
      return json(null, false);
    });
    mount();
    await flush();
    expect(document.body.querySelector('svg.tabler-icon-player-play')).toBeNull();
    await act(async () => { buttonByText('API chat')!.click(); });
    await flush();
    expect(document.body.querySelector('svg.tabler-icon-player-play')).toBeNull();
  });

  it('continues a console session on its own agent chat page only through the drawer button', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/agents/sessions')) return json(page([row({ agentId: 'ag1' })]));
      if (url === '/api/agents/ag1/sessions/sess-0001-aaaa') {
        return json({ session: detail({ _id: 'sess-0001-aaaa', metadata: { source: 'console' } }), pendingActions: [] });
      }
      return json(null, false);
    });
    mount();
    await flush();
    await act(async () => { buttonByText('First chat')!.click(); });
    await flush();
    expect(router.push).not.toHaveBeenCalled();
    await settle();
    const continueButton = [...document.body.querySelectorAll('button')].find((b) => /^continue/i.test(b.textContent?.trim() ?? ''));
    expect(continueButton).toBeDefined();
    await act(async () => { continueButton!.click(); });
    expect(router.push).toHaveBeenCalledWith('/dashboard/agents/ag1/sessions/sess-0001-aaaa');
  });

  it('keeps the inspector open on a session that left the Active list', async () => {
    vi.useFakeTimers();
    nav.query = 'view=active';
    let listed = [row({ runtimeStatus: 'running' })];
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/agents/sessions')) return json(page(listed));
      if (url === '/api/agents/ag1/sessions/sess-0001-aaaa') return json({ session: detail({ _id: 'sess-0001-aaaa', title: 'First chat', metadata: { source: 'console' } }), pendingActions: [] });
      return json(null, false);
    });
    mount();
    await flush();
    await act(async () => { buttonByText('First chat')!.click(); });
    await flush();
    const reads = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/agents/ag1/sessions/sess-0001-aaaa').length;
    expect(reads()).toBeGreaterThan(0);
    listed = [];
    await advance(5000);
    expect(text()).toContain('No active sessions');
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('stops being Live once the session leaves the Active list and its record is idle', async () => {
    vi.useFakeTimers();
    nav.query = 'view=active';
    let listed = [row({ runtimeStatus: 'requires_action', activeRun: { id: 'run_1', status: 'running' } })];
    let recordStatus = 'requires_action';
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/agents/sessions')) return json(page(listed));
      if (url === '/api/agents/ag1/sessions/sess-0001-aaaa') {
        return json({ session: detail({ _id: 'sess-0001-aaaa', title: 'First chat', metadata: { source: 'console' }, runtimeStatus: recordStatus }), pendingActions: [] });
      }
      return json(null, false);
    });
    const live = () => [...document.body.querySelectorAll('.mantine-Badge-label')].some((el) => el.textContent?.trim() === 'Live');
    const reads = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/agents/ag1/sessions/sess-0001-aaaa').length;
    mount();
    await flush();
    await act(async () => { buttonByText('First chat')!.click(); });
    await flush();
    await advance(100);
    // the row's run keeps it Live though the record alone would not say "running"
    expect(live()).toBe(true);

    // the run finished: the list no longer holds the row, the record is idle
    listed = [];
    recordStatus = 'idle';
    await advance(5000);
    await flush();
    expect(text()).toContain('No active sessions');
    expect(live()).toBe(false);

    // the stale run on the click-time snapshot must not keep the drawer polling
    const settled = reads();
    await advance(12000);
    expect(reads()).toBe(settled);
  });
});
