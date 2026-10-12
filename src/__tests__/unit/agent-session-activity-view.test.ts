// @vitest-environment jsdom
/**
 * The session event log and the Sessions drawer, mounted: the log loads a page
 * at a time, only once it is on screen, and appends what a session logs later;
 * the drawer shows a waiting session's approval cards and answers them.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import SessionActivity from '@/components/agents/session/SessionActivity';
import SessionDetailDrawer from '@/components/agents/studio/SessionDetailDrawer';
import { resetViewer } from '@/components/agents/session/useViewer';
import type { SessionLogEvent } from '@/components/agents/session/sessionActivityUi';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
});

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
let routes: Array<(url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined> = [];

beforeEach(() => {
  calls = [];
  routes = [];
  resetViewer();
  (globalThis as { fetch?: unknown }).fetch = async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    for (const route of routes) {
      const hit = route(url, init);
      if (hit) {
        return { ok: (hit.status ?? 200) < 400, status: hit.status ?? 200, json: async () => hit.body, headers: new Headers() };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), headers: new Headers() };
  };
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(MantineProvider, null, node)));
}

const event = (seq: number, type: string, data: Record<string, unknown> = {}): SessionLogEvent => ({ seq, type, data, created_at: '2026-10-11T10:00:00.000Z' });
const text = () => document.body.textContent ?? '';
const eventCalls = () => calls.filter((call) => call.url.includes('/events'));
/** The labels of the badges on screen. */
const badges = () => [...document.querySelectorAll('.mantine-Badge-label')].map((node) => node.textContent);

describe('SessionActivity', () => {
  const page1 = { events: [event(1, 'user.message', { content: 'deploy it' }), event(2, 'action.required', { kind: 'tool_approval', toolName: 'sandbox_exec' })], has_more: true, last_seq: 2 };
  const page2 = { events: [event(3, 'action.resolved', { kind: 'tool_approval', decision: 'deny' }), event(4, 'budget.reached', { spentUsd: 0.6, maxCostUsd: 0.5 })], has_more: false, last_seq: 4 };

  it('loads nothing until it is on screen, then the first page', async () => {
    routes.push((url) => (url.includes('/events') ? { body: page1 } : undefined));
    mount(h(SessionActivity, { agentId: 'a1', sessionId: 's1', active: false, refreshKey: '0' }));
    await flush();
    expect(eventCalls()).toHaveLength(0);

    act(() => root!.render(h(MantineProvider, null, h(SessionActivity, { agentId: 'a1', sessionId: 's1', active: true, refreshKey: '0' }))));
    await flush();
    expect(eventCalls()).toHaveLength(1);
    expect(eventCalls()[0].url).toBe('/api/agents/a1/sessions/s1/events?limit=100');
    expect(text()).toContain('User message');
    expect(text()).toContain('deploy it');
    expect(text()).toContain('Approval requested for sandbox_exec');
  });

  it('pages: Load more asks for what comes after the last event, and the button goes when the log ends', async () => {
    routes.push((url) => {
      if (!url.includes('/events')) return undefined;
      return { body: url.includes('after=2') ? page2 : page1 };
    });
    mount(h(SessionActivity, { agentId: 'a1', sessionId: 's1', active: true, refreshKey: '0' }));
    await flush();
    const more = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Load more');
    expect(more).toBeDefined();

    act(() => { more!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(eventCalls().at(-1)?.url).toBe('/api/agents/a1/sessions/s1/events?limit=100&after=2');
    expect(text()).toContain('Denied');
    expect(text()).toContain('Session budget reached ($0.60 of $0.50)');
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Load more')).toBe(false);
  });

  it('appends what the session logs afterwards instead of reloading the page', async () => {
    const all = [event(1, 'user.message', { content: 'hi' }), event(2, 'session.status_idle', { stopReason: 'end_turn' })];
    routes.push((url) => {
      if (!url.includes('/events')) return undefined;
      return url.includes('after=2')
        ? { body: { events: [event(3, 'user.message', { content: 'and again' })], has_more: false, last_seq: 3 } }
        : { body: { events: all, has_more: false, last_seq: 2 } };
    });
    mount(h(SessionActivity, { agentId: 'a1', sessionId: 's1', active: true, refreshKey: '2:idle' }));
    await flush();
    expect(text()).toContain('Run ended: finished');

    act(() => root!.render(h(MantineProvider, null, h(SessionActivity, { agentId: 'a1', sessionId: 's1', active: true, refreshKey: '3:idle' }))));
    await flush();
    expect(eventCalls().at(-1)?.url).toBe('/api/agents/a1/sessions/s1/events?limit=100&after=2');
    expect(text()).toContain('hi');
    expect(text()).toContain('and again');
  });

  it('says so when the log is empty, and when it cannot be read', async () => {
    routes.push((url) => (url.includes('/events') ? { body: { events: [], has_more: false, last_seq: 0 } } : undefined));
    mount(h(SessionActivity, { agentId: 'a1', sessionId: 's1', active: true, refreshKey: '0' }));
    await flush();
    expect(text()).toContain('Nothing has been recorded for this session yet.');

    act(() => root?.unmount());
    routes = [() => ({ status: 500, body: { error: 'nope' } })];
    mount(h(SessionActivity, { agentId: 'a1', sessionId: 's2', active: true, refreshKey: '0' }));
    await flush();
    expect(text()).toContain('Could not load the activity log');
  });
});

describe('SessionDetailDrawer', () => {
  const action = { id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', args: { command: 'ls' }, status: 'pending' };
  const waiting = {
    _id: 's1', title: 'Deploy', createdBy: 'u1', runtimeStatus: 'requires_action', lastEventSeq: 5,
    messages: [
      { role: 'user', content: 'deploy' },
      { role: 'assistant', content: '', stopReason: 'paused', pendingActions: [action] },
    ],
  };
  const row = { _id: 's1', title: 'Deploy', source: 'console', turns: 1, runtimeStatus: 'requires_action' as const };

  function drawer(extra: Record<string, unknown> = {}) {
    mount(h(SessionDetailDrawer, { agentId: 'a1', session: row, onClose: () => undefined, onContinue: () => undefined, ...extra }));
  }

  it('shows the waiting status and the approval card, answerable from there', async () => {
    let record: unknown = waiting;
    routes.push((url, init) => {
      if (url.endsWith('/actions/act_1/resolve') && init?.method === 'POST') {
        record = { ...waiting, runtimeStatus: 'idle', messages: [{ role: 'user', content: 'deploy' }, { role: 'assistant', content: 'done', pendingActions: [{ ...action, status: 'resolved', resolution: { decision: 'allow' } }] }] };
        return { body: { status: 'resumed' } };
      }
      if (url === '/api/agents/a1/sessions/s1') return { body: { session: record } };
      if (url.includes('/api/auth/session')) return { body: { userId: 'u1', role: 'user' } };
      return undefined;
    });
    const resolved = vi.fn();
    drawer({ onResolved: resolved });
    await flush();
    await flush();

    expect(badges()).toContain('Waiting for you');
    expect(text()).toContain('sandbox_exec');
    const approve = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve'));
    expect(approve).toBeDefined();
    // The viewer started the session: no "only the owner" notice.
    expect(text()).not.toContain('can answer');

    act(() => { approve!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    await flush();

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe('/api/agents/a1/sessions/s1/actions/act_1/resolve');
    expect(post?.body).toEqual({ decision: 'allow' });
    expect(resolved).toHaveBeenCalledTimes(1);
    // The session was read again: the card is gone and the session is idle.
    expect(text()).not.toContain('Approve');
    expect(badges()).toContain('Idle');
    expect(badges()).not.toContain('Waiting for you');
  });

  it('says what the SERVER says about the viewer: the reason they cannot answer, from the session it loaded', async () => {
    routes.push((url) => {
      if (url === '/api/agents/a1/sessions/s1') {
        return { body: { session: waiting, pendingActions: [{ id: 'act_1', canResolve: false, resolveBlockedReason: 'approvers_admin' }] } };
      }
      return undefined;
    });
    drawer();
    await flush();
    await flush();
    expect(text()).toContain('Only the session owner, workspace admins and the admins of the project can approve');
  });

  it('says nothing when the server says the viewer may answer, or says nothing - the page never guesses from the viewer\'s role', async () => {
    routes.push((url) => {
      if (url === '/api/agents/a1/sessions/s1') return { body: { session: waiting, pendingActions: [{ id: 'act_1', canResolve: true }] } };
      // (a different person signed in: it makes no difference to what the page says)
      if (url.includes('/api/auth/session')) return { body: { userId: 'u2', role: 'user' } };
      return undefined;
    });
    drawer();
    await flush();
    await flush();
    expect(text()).not.toContain('can approve');
    expect(text()).not.toContain('rule of your workspace');
  });

  it('shows how a settled session ended, and the event log behind a disclosure', async () => {
    routes.push((url) => {
      if (url === '/api/agents/a1/sessions/s1') {
        return { body: { session: { _id: 's1', createdBy: 'u1', runtimeStatus: 'idle', stopReason: 'cancelled', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'partial', stopReason: 'cancelled' }] } } };
      }
      if (url.includes('/events')) return { body: { events: [event(1, 'user.message', { content: 'hi' })], has_more: false, last_seq: 1 } };
      return undefined;
    });
    drawer({ session: { ...row, runtimeStatus: 'idle' } });
    await flush();
    await flush();
    expect(badges()).toContain('Idle');
    expect(badges()).toContain('cancelled');
    // Not read until opened.
    expect(eventCalls()).toHaveLength(0);

    const toggle = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Session activity'));
    expect(toggle).toBeDefined();
    act(() => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    await flush();
    expect(eventCalls()).toHaveLength(1);
    expect(text()).toContain('User message');
  });

  it('reports a refusal and keeps the card', async () => {
    routes.push((url, init) => {
      if (url.endsWith('/resolve') && init?.method === 'POST') return { status: 403, body: { error: 'You are not allowed to answer this request.' } };
      if (url === '/api/agents/a1/sessions/s1') return { body: { session: waiting } };
      return undefined;
    });
    drawer();
    await flush();
    await flush();
    const approve = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve'));
    act(() => { approve!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    await flush();
    expect(text()).toContain('Approve');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});
