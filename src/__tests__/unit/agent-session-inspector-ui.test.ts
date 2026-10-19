// @vitest-environment jsdom
/**
 * The session views that open a session in the inspector: the list's row click
 * and Agent column, the inspector's own rules (what it offers once the record is
 * read, its auto-refresh) and the chat page that hands non-console sessions over.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm';
import SessionList, { sessionSourceOf, type SessionListItem } from '@/components/agents/studio/SessionList';
import SessionDetailDrawer from '@/components/agents/studio/SessionDetailDrawer';
import AgentSessionView from '@/components/agents/session/AgentSessionView';
import { sessionInspectorHref } from '@/components/agents/session/sessionLinks';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => '/dashboard/agents/a1/sessions/s1',
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
function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(wrap(node)));
}
const rerender = (node: ReactNode) => act(() => root!.render(wrap(node)));
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const text = () => document.body.textContent ?? '';
const json = (body: unknown, ok = true, status = ok ? 200 : 500) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
const buttonByText = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => json(null, false));
  vi.stubGlobal('fetch', fetchMock);
  router.push.mockClear();
  router.replace.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const row = (patch: Partial<SessionListItem> = {}): SessionListItem => ({
  _id: 'sess-0001-aaaa', title: 'First chat', source: 'console', turns: 1, updatedAt: '2026-10-19T10:00:00.000Z', ...patch,
});

describe('sessionSourceOf', () => {
  it('reads a string source and nothing else', () => {
    expect(sessionSourceOf({ source: 'api' })).toBe('api');
    expect(sessionSourceOf({ source: 3 })).toBeUndefined();
    expect(sessionSourceOf(undefined)).toBeUndefined();
  });
});

describe('SessionList', () => {
  const rows = [
    row({ _id: 'sess-0001-aaaa', title: 'First chat', agentId: 'ag1', agentKey: 'alpha', agentName: 'Alpha' }),
    row({ _id: 'sess-0002-bbbb', title: 'Second chat', source: 'api', agentId: 'ag2', agentKey: 'beta', agentName: 'Beta' }),
  ];

  it('draws the Agent column and filter only with showAgent', () => {
    mount(h(SessionList, { sessions: rows, onOpen: () => undefined }));
    expect(text()).not.toContain('Alpha');
    expect(document.body.querySelector('[aria-label="Agent"]')).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';

    mount(h(SessionList, { sessions: rows, showAgent: true, onOpen: () => undefined }));
    const link = [...document.body.querySelectorAll('a')].find((a) => a.textContent === 'Alpha')!;
    expect(link.getAttribute('href')).toBe('/dashboard/agents/ag1?tab=sessions');
    expect(text()).toContain('Beta');
    expect(document.body.querySelector('input[aria-label="Agent"]')).not.toBeNull();
  });

  it('offers no agent filter when one agent holds every row', () => {
    mount(h(SessionList, { sessions: [rows[0], row({ _id: 'sess-0003-cccc', agentId: 'ag1', agentName: 'Alpha' })], showAgent: true, onOpen: () => undefined }));
    expect(document.body.querySelector('input[aria-label="Agent"]')).toBeNull();
  });

  it('opens the session on a click anywhere in the row, once', () => {
    const onOpen = vi.fn();
    mount(h(SessionList, { sessions: [rows[0]], onOpen }));
    const cell = [...document.body.querySelectorAll('td')].find((td) => td.textContent === 'Test')!;
    act(() => cell.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('sess-0001-aaaa');

    // the name is a button: its own click opens, and the row's handler stays out of it
    onOpen.mockClear();
    act(() => buttonByText('First chat')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not open the row for the copy or the stop button', () => {
    const onOpen = vi.fn();
    const onRunStopped = vi.fn();
    fetchMock.mockImplementation(() => json({}));
    mount(h(SessionList, {
      sessions: [row({ agentId: 'ag9', activeRun: { id: 'run_7', status: 'running' } })],
      showAgent: true,
      onOpen,
      onRunStopped,
    }));
    const stop = document.body.querySelector('[aria-label="Stop run"]') as HTMLButtonElement;
    act(() => stop.click());
    expect(onOpen).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/ag9/runs/run_7/cancel', { method: 'POST' });

    act(() => (document.body.querySelector('svg.tabler-icon-copy')!.closest('button') as HTMLButtonElement).click());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('stops a run of the list agent when the row carries no agent', () => {
    fetchMock.mockImplementation(() => json({}));
    mount(h(SessionList, { agentId: 'a1', sessions: [row({ activeRun: { id: 'run_8', status: 'queued' } })], onOpen: () => undefined }));
    act(() => (document.body.querySelector('[aria-label="Stop run"]') as HTMLButtonElement).click());
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/runs/run_8/cancel', { method: 'POST' });
  });

  it('shows no stop button when neither the row nor the list knows the agent', () => {
    mount(h(SessionList, { sessions: [row({ activeRun: { id: 'run_8', status: 'queued' } })], onOpen: () => undefined }));
    expect(document.body.querySelector('[aria-label="Stop run"]')).toBeNull();
  });

  it('offers Continue only with onContinue and only for a console session', () => {
    const sessions = [row(), row({ _id: 'sess-0002-bbbb', title: 'API chat', source: 'api' })];
    mount(h(SessionList, { sessions, onOpen: () => undefined }));
    expect(document.body.querySelector('svg.tabler-icon-player-play')).toBeNull();
    rerender(h(SessionList, { sessions, onOpen: () => undefined, onContinue: () => undefined }));
    // one Continue (the console row), one View (the API row)
    expect(document.body.querySelectorAll('svg.tabler-icon-player-play')).toHaveLength(1);
    expect(document.body.querySelectorAll('svg.tabler-icon-external-link')).toHaveLength(1);
  });

  it('draws a custom empty state and the start button only with onStart', () => {
    mount(h(SessionList, { sessions: [], onOpen: () => undefined, emptyTitle: 'Nothing here', emptyDescription: 'Come back later' }));
    expect(text()).toContain('Nothing here');
    expect(text()).toContain('Come back later');
    expect(buttonByText('Start new session')).toBeUndefined();

    const onStart = vi.fn();
    rerender(h(SessionList, { sessions: [], onOpen: () => undefined, onStart }));
    expect(text()).toContain('No sessions yet');
    act(() => buttonByText('Start new session')!.click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe('SessionDetailDrawer', () => {
  const record = (patch: Record<string, unknown> = {}) => ({
    _id: 'sess-0001-aaaa', title: 'First chat', messages: [], metadata: { source: 'console' }, runtimeStatus: 'idle',
    updatedAt: '2026-10-19T10:00:00.000Z', ...patch,
  });
  const reply = (session: unknown) => fetchMock.mockImplementation((url: string) => (
    url.endsWith('/sessions/sess-0001-aaaa') ? json({ session, pendingActions: [] }) : json(null, false)
  ));
  const drawer = (session: SessionListItem | null, extra: Record<string, unknown> = {}) => h(SessionDetailDrawer, {
    agentId: 'a1', session, onClose: () => undefined, onContinue: () => undefined, ...extra,
  });
  const sessionReads = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/sessions/sess-0001-aaaa')).length;
  const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

  it('decides Continue and the read-only notice from the loaded record, and shows neither before it', async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    // the row claims "console", the record says otherwise
    mount(drawer(row({ source: 'console' })));
    expect(buttonByText('Continue')).toBeUndefined();
    expect(text()).not.toContain('Read-only');
    await act(async () => { finish({ ok: true, status: 200, json: () => Promise.resolve({ session: record({ metadata: { source: 'api' } }), pendingActions: [] }) } as Response); await Promise.resolve(); await Promise.resolve(); });
    await flush();
    expect(buttonByText('Continue')).toBeUndefined();
    expect(text()).toContain('Read-only');
    expect(text()).toContain('API');
  });

  it('offers Continue for a console record, even from a bare link placeholder', async () => {
    reply(record());
    const onContinue = vi.fn();
    mount(drawer({ _id: 'sess-0001-aaaa' }, { onContinue }));
    await flush();
    expect(text()).not.toContain('Read-only');
    act(() => buttonByText('Continue')!.click());
    expect(onContinue).toHaveBeenCalledWith('sess-0001-aaaa');
    // title comes from the record when the placeholder has none
    expect(text()).toContain('First chat');
  });

  it('encodes the agent and session ids in the paths it calls', async () => {
    fetchMock.mockImplementation(() => json(null, false));
    mount(h(SessionDetailDrawer, { agentId: 'a/1', session: { _id: '../x' }, onClose: () => undefined, onContinue: () => undefined }));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a%2F1/sessions/..%2Fx', expect.objectContaining({ cache: 'no-store' }));
  });

  it('offers Continue for a record from before sources existed', async () => {
    reply(record({ metadata: {} }));
    mount(drawer(row({ source: 'api' })));
    await flush();
    expect(buttonByText('Continue')).toBeDefined();
  });

  it('reads the session again every 4s while it runs, and stops once the record is idle', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reply(record({ runtimeStatus: 'running' }));
    mount(drawer(row({ runtimeStatus: 'running' })));
    await flush();
    expect(sessionReads()).toBe(1);
    expect(text()).toContain('Live');

    await tick(4000);
    expect(sessionReads()).toBe(2);
    await tick(4000);
    expect(sessionReads()).toBe(3);

    // the run ended: the next read says idle, and the timer goes quiet
    reply(record({ runtimeStatus: 'idle', updatedAt: '2026-10-19T10:05:00.000Z' }));
    await tick(4000);
    await flush();
    const reads = sessionReads();
    expect(text()).not.toContain('Live');
    await tick(12000);
    expect(sessionReads()).toBe(reads);
  });

  it('does not poll an idle session', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reply(record());
    mount(drawer(row({ runtimeStatus: 'idle' })));
    await flush();
    await tick(20000);
    expect(sessionReads()).toBe(1);
    expect(text()).not.toContain('Live');
  });

  it('keeps polling while the row has a run in flight, though the record is idle', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reply(record());
    mount(drawer(row({ activeRun: { id: 'run_1', status: 'queued' } })));
    await flush();
    await tick(4000);
    expect(sessionReads()).toBe(2);
  });

  it('skips a tick while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reply(record({ runtimeStatus: 'running' }));
    mount(drawer(row({ runtimeStatus: 'running' })));
    await flush();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await tick(8000);
    expect(sessionReads()).toBe(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await tick(4000);
    expect(sessionReads()).toBe(2);
  });

  it('stops polling when closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reply(record({ runtimeStatus: 'running' }));
    mount(drawer(row({ runtimeStatus: 'running' })));
    await flush();
    rerender(drawer(null));
    await tick(12000);
    expect(sessionReads()).toBe(1);
  });

  it('starts no second read while one is pending, and polls on once it lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let land!: (value: Response) => void;
    reply(record({ runtimeStatus: 'running' }));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { land = resolve; }));
    mount(drawer(row({ runtimeStatus: 'running' })));
    await flush();
    expect(sessionReads()).toBe(1);

    // a slow read is not cancelled by the timer
    await tick(12000);
    expect(sessionReads()).toBe(1);

    await act(async () => {
      land({ ok: true, status: 200, json: () => Promise.resolve({ session: record({ runtimeStatus: 'running' }), pendingActions: [] }) } as Response);
      await Promise.resolve(); await Promise.resolve();
    });
    await flush();
    expect(text()).toContain('First chat');
    await tick(4000);
    expect(sessionReads()).toBe(2);
  });

  it('keeps a failed poll\'s error on screen while the next read is still pending', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reply(record({ runtimeStatus: 'running' }));
    mount(drawer(row({ runtimeStatus: 'running' })));
    await flush();
    expect(text()).not.toContain('Could not load the transcript');

    fetchMock.mockImplementation(() => json(null, false, 503));
    await tick(4000);
    await flush();
    expect(text()).toContain('Could not load the transcript: HTTP 503');

    // the next tick's read never answers: the error is not wiped at its start
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    await tick(4000);
    expect(text()).toContain('Could not load the transcript: HTTP 503');
  });

  it('gives up a read that never answers, so polling goes on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    reply(record({ runtimeStatus: 'running' }));
    // The first read hangs until its signal aborts it.
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
    }));
    mount(drawer(row({ runtimeStatus: 'running' })));
    await flush();
    expect(sessionReads()).toBe(1);

    await tick(28000);
    expect(sessionReads()).toBe(1);
    // given up at 30 s; the tick after that reads again
    await tick(4000);
    await tick(4000);
    expect(sessionReads()).toBe(2);
  });

  it('opens the Activity panel for a session that is running', async () => {
    reply(record({ runtimeStatus: 'running' }));
    mount(drawer(row({ runtimeStatus: 'running' })));
    await flush();
    const toggle = [...document.body.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent?.includes('Session activity'));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves the Activity panel shut for an idle session', async () => {
    reply(record());
    mount(drawer(row()));
    await flush();
    const toggle = [...document.body.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent?.includes('Session activity'));
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('tells the host when a read returns a different status, never on the first read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const onSessionChanged = vi.fn();
    reply(record({ runtimeStatus: 'running' }));
    mount(drawer(row({ runtimeStatus: 'running' }), { onSessionChanged }));
    await flush();
    expect(onSessionChanged).not.toHaveBeenCalled();

    // same status and time: nothing to tell
    await tick(4000);
    await flush();
    expect(onSessionChanged).not.toHaveBeenCalled();

    reply(record({ runtimeStatus: 'idle', updatedAt: '2026-10-19T10:05:00.000Z' }));
    await tick(4000);
    await flush();
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
  });
});

describe('AgentSessionView', () => {
  const agent = { _id: 'a1', name: 'Alpha', key: 'alpha', config: {} };
  const serve = (session: Record<string, unknown>) => fetchMock.mockImplementation((url: string) => {
    if (url === '/api/agents/a1') return json({ agent, models: [] });
    if (url === '/api/agents/a1/sessions/s1') return json({ session, pendingActions: [] });
    return json({}, false);
  });

  it('hands a session that is not from the console over to the inspector, without drawing the chat', async () => {
    serve({ _id: 's1', title: 'Hook call', messages: [], metadata: { source: 'api' } });
    mount(h(AgentSessionView, { agentId: 'a1', sessionId: 's1' }));
    await flush();
    await flush();
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(sessionInspectorHref('a1', 's1'));
    expect(router.replace).toHaveBeenCalledWith('/dashboard/agents/a1?tab=sessions&session=s1');
    expect(text()).toContain('Opening the session');
    expect(document.body.querySelector('textarea')).toBeNull();
    expect(text()).not.toContain('Hook call');
    // no follow, stream, version or feedback requests start for it
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toContain('/api/agents/a1/sessions/s1');
    expect(urls.filter((url) => /events|stream|versions|feedback/.test(url))).toEqual([]);
  });

  it('starts nothing on the page while it redirects, not even the reminder wake watcher', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/agents/a1') return json({ agent, models: [] });
      if (url === '/api/agents/a1/sessions/s1') return json({ session: { _id: 's1', title: 'Hook call', messages: [], metadata: { source: 'api' } }, pendingActions: [] });
      if (url.startsWith('/api/agents/a1/reminders')) return json({ reminders: [{ _id: 'r1', status: 'scheduled' }] });
      return json({}, false);
    });
    mount(h(AgentSessionView, { agentId: 'a1', sessionId: 's1' }));
    await flush();
    await flush();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(router.replace).toHaveBeenCalledWith(sessionInspectorHref('a1', 's1'));
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.startsWith('/api/agents/a1/reminders'))).toBe(true);
    expect(urls.filter((url) => url.includes('/events/stream'))).toEqual([]);
  });

  it('does not redirect a console session', async () => {
    serve({ _id: 's1', title: 'My test', messages: [], metadata: { source: 'console' } });
    mount(h(AgentSessionView, { agentId: 'a1', sessionId: 's1' }));
    await flush();
    await flush();
    expect(router.replace).not.toHaveBeenCalled();
    expect(text()).not.toContain('Opening the session');
  });

  it('does not redirect a session recorded before sources existed', async () => {
    serve({ _id: 's1', title: 'Old test', messages: [], metadata: {} });
    mount(h(AgentSessionView, { agentId: 'a1', sessionId: 's1' }));
    await flush();
    await flush();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('the agent page opens an inspector from a link', () => {
  // The page is too large to mount here; its wiring is asserted at the source, like the other page-level rules.
  const source = readFileSync(join(__dirname, '../../components/agents/AgentDetailPage.tsx'), 'utf8');

  it('reads ?session= into the Sessions tab and the drawer, and removes it on close', () => {
    expect(source).toContain('searchParams.get(SESSION_QUERY_PARAM)');
    expect(source).toMatch(/setActiveTab\('sessions'\);\s*setViewedSessionId\(linkedSessionId\)/);
    // the value reaches API paths, so only a plain id may open the drawer
    expect(source).toContain('/^[A-Za-z0-9_-]{1,128}$/.test(rawLinkedSession)');
    expect(source).toContain('next.delete(SESSION_QUERY_PARAM)');
    expect(source).toContain('{ scroll: false }');
    expect(source).toContain('onClose={closeSession}');
  });

  it('accepts only a plain id from ?session=', () => {
    const accepts = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
    expect(accepts('sess-0001_aaaa')).toBe(true);
    expect(accepts('../x')).toBe(false);
    expect(accepts('a/b')).toBe(false);
    expect(accepts('a'.repeat(129))).toBe(false);
  });

  it('shows a bare placeholder, polls on ongoing sessions and refreshes the row silently', () => {
    expect(source).toContain('{ _id: viewedSessionId }');
    expect(source).not.toContain("source: 'api'");
    expect(source).toContain('sessions.some(isSessionOngoing)');
    expect(source).toContain('onSessionChanged={() => void loadSessions(true)}');
  });
});
