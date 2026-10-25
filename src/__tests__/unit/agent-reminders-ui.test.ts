// @vitest-environment jsdom
/**
 * Reminders in the studio: the pure rules (when the Reminders view shows,
 * the filters, the time wording) and the pieces a person drives (the Configure
 * card, the session list's markers, the reminders table).
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm';
import AgentRemindersSettings from '@/components/agents/studio/AgentRemindersSettings';
import AgentRemindersTable from '@/components/agents/studio/AgentRemindersTable';
import SessionList from '@/components/agents/studio/SessionList';
import { toItems } from '@/components/agents/studio/SessionDetailDrawer';
import { CONFIG_SECTION_KEYS } from '@/components/agents/studio/configSections';
import {
  filterReminders,
  formatUntil,
  isPendingWake,
  patchReminders,
  reminderOfMessage,
  reminderQueryStatus,
  showRemindersView,
  type AgentReminderView,
} from '@/components/agents/studio/reminderUi';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import { interpretSessionEvent } from '@/components/agents/session/sessionFollow';

// The lists render through DataGrid, whose row navigation needs the app router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/agents/a1',
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const say = (key: string, params?: Record<string, string | number>) => `${key}:${params?.count ?? ''}`;

function reminder(patch: Partial<AgentReminderView> = {}): AgentReminderView {
  return {
    id: 'run_1', object: 'agent.reminder', agent: 'a', session_id: 's1', status: 'scheduled',
    fire_at: Math.floor(Date.now() / 1000) + 3600, message: 'check the deploy', reason: null,
    set_by_run: null, chain: 1, created_at: 1, completed_at: null, error: null, ...patch,
  };
}

describe('reminder rules', () => {
  it('shows the Reminders view only for an agent that uses reminders', () => {
    expect(showRemindersView({ hasAny: false })).toBe(false);
    expect(showRemindersView({ draft: { enabled: false }, published: { enabled: false }, hasAny: false })).toBe(false);
    expect(showRemindersView({ draft: { enabled: true }, hasAny: false })).toBe(true);
    expect(showRemindersView({ published: { enabled: true }, hasAny: false })).toBe(true);
    expect(showRemindersView({ hasAny: true })).toBe(true);
  });

  it('keeps Runtime owning the reminders config key', () => {
    expect(CONFIG_SECTION_KEYS.advanced).toEqual(['runtime', 'reminders']);
  });

  it('watches for a wake while one is still to come, fired or not', () => {
    expect(['scheduled', 'queued', 'running'].map((status) => isPendingWake(reminder({ status: status as AgentReminderView['status'] })))).toEqual([true, true, true]);
    expect(['succeeded', 'failed', 'canceled', 'requires_action'].some((status) => isPendingWake(reminder({ status: status as AgentReminderView['status'] })))).toBe(false);
  });

  it('a followed wake turn opens with the reminder card, not the framed note as a user bubble', () => {
    const frame = (data: Record<string, unknown>) => ({ seq: 7, type: 'user.message', data });
    expect(interpretSessionEvent('user.message', frame({
      content: '[Reminder] You scheduled this for yourself at …',
      origin: 'reminder',
      reminder: { runId: 'run_1', message: 'Check the deploy.', setAt: '2026-10-19T15:00:00.000Z' },
    }))).toEqual({
      kind: 'user',
      content: '[Reminder] You scheduled this for yourself at …',
      reminder: { message: 'Check the deploy.', setAt: '2026-10-19T15:00:00.000Z' },
    });
    expect(interpretSessionEvent('user.message', frame({ content: 'hi', origin: 'reminder' }))).toEqual({ kind: 'user', content: 'hi' });
    expect(interpretSessionEvent('user.message', frame({ content: 'hi' }))).toEqual({ kind: 'user', content: 'hi' });
  });

  it('words a time ahead', () => {
    const now = 1_000_000_000_000;
    expect(formatUntil(now / 1000 - 5, say, now)).toBe('due:');
    expect(formatUntil(now / 1000 + 30, say, now)).toBe('inSeconds:30');
    expect(formatUntil(now / 1000 + 600, say, now)).toBe('inMinutes:10');
    expect(formatUntil(now / 1000 + 3 * 3600, say, now)).toBe('inHours:3');
    expect(formatUntil(now / 1000 + 5 * 86400, say, now)).toBe('inDays:5');
  });

  it('asks the server for active or all and filters finished statuses locally', () => {
    expect(reminderQueryStatus('active')).toBe('active');
    expect(reminderQueryStatus('failed')).toBe('all');
    const list = [reminder({ id: 'a', status: 'failed', owner: { id: 'u1' } }), reminder({ id: 'b', status: 'succeeded', owner: { id: 'u2' } })];
    expect(filterReminders(list, 'failed', null).map((r) => r.id)).toEqual(['a']);
    expect(filterReminders(list, 'all', 'u2').map((r) => r.id)).toEqual(['b']);
  });

  it('drops a cleared field and an empty config', () => {
    expect(patchReminders({ enabled: true, minDelaySeconds: 90 }, { minDelaySeconds: undefined })).toEqual({ enabled: true });
    expect(patchReminders({ instructions: 'x' }, { instructions: '' })).toBeUndefined();
  });

  it('labels a reminder wake-up message in the transcript, not as a user turn', () => {
    const message = {
      role: 'user', content: '[Reminder] framed text', timestamp: '2026-01-01T00:00:00Z',
      metadata: { origin: 'reminder', reminder: { runId: 'run_1', message: 'check the deploy' } },
    } as unknown as ChatMessage;
    expect(reminderOfMessage(message)?.message).toBe('check the deploy');
    expect(reminderOfMessage({ ...message, metadata: undefined } as ChatMessage)).toBeNull();
    const items = toItems([message]);
    expect(items[1]).toMatchObject({ itemType: 'message', roleLabel: 'Reminder', content: 'check the deploy' });
  });
});

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
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const text = () => document.body.textContent ?? '';
const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => json(null, false));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Configure → Reminders card', () => {
  it('is one quiet row while off, and shows the fields once switched on', async () => {
    const onChange = vi.fn();
    mount(h(AgentRemindersSettings, { value: undefined, onChange }));
    expect(text()).toContain('Reminders');
    expect(text()).not.toContain('Limit:');
    const toggle = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
  });

  it('shows the platform limits from the server when on', async () => {
    fetchMock.mockImplementation((url: string) => url.includes('reminder-limits')
      ? json({ limits: { enabled: true, minDelaySeconds: 300, maxHorizonHours: 24, maxActivePerSession: 5, maxFiresPerSession: 50 } })
      : json(null, false));
    mount(h(AgentRemindersSettings, { value: { enabled: true }, onChange: () => undefined }));
    await flush();
    expect(text()).toContain('Limit: 300');
    expect(text()).toContain('Limit: 24');
    expect(text()).toContain('Ask for approval (recommended)');
  });
});

describe('Sessions list markers', () => {
  const base = { _id: 's1', title: 'Deploy watch', source: 'api' };

  it('shows a run badge with a stop button, and a clock for active reminders', () => {
    mount(h(SessionList, {
      agentId: 'a1',
      sessions: [{ ...base, activeRun: { id: 'run_9', status: 'running' }, reminders: { active: 1, nextAt: new Date(Date.now() + 3600_000).toISOString() } }],
      onOpen: () => undefined, onStart: () => undefined,
    }));
    expect(text()).toContain('Running');
    expect(document.body.querySelector('[aria-label="Stop run"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Has active reminders"]')).not.toBeNull();
  });

  it('shows neither on an ordinary row', () => {
    mount(h(SessionList, { agentId: 'a1', sessions: [base], onOpen: () => undefined, onStart: () => undefined }));
    expect(document.body.querySelector('[aria-label="Stop run"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Has active reminders"]')).toBeNull();
  });
});

describe('Reminders table', () => {
  it('lists the reminders and cancels a scheduled one', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({});
      return json({ reminders: [reminder()], summary: { active: 1 } });
    });
    const onCount = vi.fn();
    mount(h(AgentRemindersTable, { agentId: 'a1', onOpenSession: () => undefined, onActiveCountChange: onCount }));
    await flush();
    expect(text()).toContain('check the deploy');
    expect(text()).toContain('Fired and canceled reminders are kept 30 days.');
    expect(onCount).toHaveBeenCalledWith(1);
    const cancel = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!;
    await act(async () => { cancel.click(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/runs/run_1/cancel', { method: 'POST' });
  });
});
