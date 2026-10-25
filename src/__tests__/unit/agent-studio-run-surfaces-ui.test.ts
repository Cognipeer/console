// @vitest-environment jsdom
/**
 * Studio run surfaces, driven the way a person drives them (jsdom):
 *  - Callback & budget: clearing the callback URL drops the callback (and its stored secret);
 *  - the runs table treats a scheduled run as pending work (label, Cancel, polling);
 *  - the webhook Connect card follows the stored secret hint and grace after a re-save;
 *  - the triggers and deliveries panels say a load failed (with a retry) instead of "nothing here";
 *  - the cron presets and filter examples are buttons.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm';
import AgentRunSettingsPanel from '@/components/agents/studio/AgentRunSettingsPanel';
import AgentRunsTable, { ACTIVE_RUN_STATUSES } from '@/components/agents/studio/AgentRunsTable';
import AgentTriggersPanel from '@/components/agents/studio/AgentTriggersPanel';
import { WebhookConnectCard, WebhookDeliveriesPanel, WebhookFields } from '@/components/agents/studio/TriggerWebhookParts';
import { emptyTriggerForm } from '@/components/agents/studio/triggerForm';
import StatusBadge from '@/components/common/ui/StatusBadge';
import type { IAgentCallbackConfig } from '@/lib/database/provider/types.domain';

// The lists render through DataGrid, whose row navigation needs the app router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/agents/a1',
  useSearchParams: () => new URLSearchParams(),
}));

// The full timezone list makes a jsdom render take seconds; two zones are enough for what is checked here.
vi.mock('@/components/agents/studio/triggerForm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/agents/studio/triggerForm')>()),
  timezoneOptions: () => ['UTC', 'Europe/Istanbul'],
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
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Callback & budget: removing the callback', () => {
  const MASK = '••••••';
  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('clearing the URL of a callback with a stored secret drops the whole callback', () => {
    const seen: Array<IAgentCallbackConfig | undefined | 'none'> = [];
    mount(h(AgentRunSettingsPanel, {
      callback: { url: 'https://hooks.example.com/agent', secret: MASK },
      onCallbackChange: (next: IAgentCallbackConfig | undefined) => seen.push(next ?? 'none'),
      budget: undefined,
      onBudgetChange: () => undefined,
    }));
    const url = document.querySelector<HTMLInputElement>('input[placeholder="https://example.com/hooks/agent-runs"]')!;
    setValue(url, '');
    expect(seen.at(-1)).toBe('none');
  });

  it('editing the URL keeps the secret as it is', () => {
    const seen: Array<IAgentCallbackConfig | undefined> = [];
    mount(h(AgentRunSettingsPanel, {
      callback: { url: 'https://hooks.example.com/agent', secret: MASK },
      onCallbackChange: (next: IAgentCallbackConfig | undefined) => seen.push(next),
      budget: undefined,
      onBudgetChange: () => undefined,
    }));
    const url = document.querySelector<HTMLInputElement>('input[placeholder="https://example.com/hooks/agent-runs"]')!;
    setValue(url, 'https://hooks.example.com/other');
    expect(seen.at(-1)).toEqual({ url: 'https://hooks.example.com/other', secret: MASK });
  });

  it('words the deployment limits with the localized units', async () => {
    fetchMock.mockImplementation(() => json({ syncWaitSeconds: 90, maxDurationMinutes: 30 }));
    mount(h(AgentRunSettingsPanel, { callback: undefined, onCallbackChange: () => undefined, budget: undefined, onBudgetChange: () => undefined }));
    await flush();
    expect(text()).toContain('waits up to 90s, a run may take up to 30 min');
  });
});

describe('the runs table and a scheduled run', () => {
  const run = (overrides: Record<string, unknown>) => ({
    id: 'run_1', status: 'scheduled', conversation_id: 'c1', created_at: 1_760_000_000, started_at: null, completed_at: null,
    cancel_requested_at: null, callback: null, error: null, scheduled_for: 1_760_003_600, ...overrides,
  });

  it('counts a scheduled run as pending work', () => {
    expect([...ACTIVE_RUN_STATUSES].sort()).toEqual(['queued', 'running', 'scheduled']);
  });

  it('shows it as Scheduled with a Cancel button, and keeps polling while it waits', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => json({ runs: [run({})] }));
    mount(h(AgentRunsTable, { agentId: 'a1', onOpenConversation: () => undefined }));
    await flush();
    expect(text()).toContain('Scheduled');
    expect(text()).toContain('Starts');
    expect(button('Cancel run')).toBeDefined();
    const before = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it('names the statuses it has no color for in words, not as raw codes', () => {
    mount(h('div', null, h(StatusBadge, { status: 'scheduled' }), h(StatusBadge, { status: 'requires_action' })));
    expect(text()).toContain('Scheduled');
    expect(text()).toContain('Needs action');
    expect(text()).not.toContain('requires_action');
  });
});

describe('the webhook Connect card', () => {
  const webhook = (overrides: Record<string, unknown> = {}) => ({ url: 'https://example.com/hook', preset: 'generic', auth: 'standard_webhooks', secret_hint: 'aaaa', previous_secret_valid_until: null, ...overrides });
  const card = (stored: ReturnType<typeof webhook>) => h(WebhookConnectCard, { agentId: 'a1', triggerId: 'r1', webhook: stored, revealedSecret: null, onSecret: () => undefined });

  it('shows the hint and the grace of the trigger as it is stored now, after a re-save with a new secret', () => {
    mount(card(webhook()));
    expect(text()).toContain('…aaaa');
    expect(text()).not.toContain('still accepted');
    rerender(card(webhook({ secret_hint: 'bbbb' })));
    expect(text()).toContain('…bbbb');
    expect(text()).not.toContain('…aaaa');
    rerender(card(webhook({ secret_hint: 'cccc', previous_secret_valid_until: 1_760_000_000 })));
    expect(text()).toContain('…cccc');
    expect(text()).toContain('still accepted');
    rerender(card(webhook({ secret_hint: 'dddd', previous_secret_valid_until: null })));
    expect(text()).toContain('…dddd');
    expect(text()).not.toContain('still accepted');
  });
});

describe('a failed load is not an empty list', () => {
  it('triggers: shows the error with a retry, then the list once it loads', async () => {
    mount(h(AgentTriggersPanel, { agentId: 'a1', agentName: 'Support', versions: [], onShowRuns: () => undefined }));
    await flush();
    expect(text()).toContain('Could not load the triggers.');
    expect(text()).not.toContain('No triggers yet');
    const retry = button('Try again')!;
    expect(retry).toBeDefined();
    fetchMock.mockImplementation(() => json({ data: [] }));
    await act(async () => { retry.click(); await Promise.resolve(); });
    await flush();
    expect(text()).toContain('No triggers yet');
    expect(text()).not.toContain('Could not load the triggers.');
  });

  it('triggers: a saved list reads in full — type as text with an icon, status as a dot and a word', async () => {
    fetchMock.mockImplementation(() => json({ data: [{
      id: 'r1', object: 'agent.trigger', agent: 'a', name: 'github-pr-review-with-a-rather-long-name', description: null, enabled: true,
      type: 'webhook', webhook: { preset: 'github', events: ['pull_request'] }, prompt: 'x', variables: null, version: null, class: 'default',
      metadata: {}, callback: null, response_format: null, next_fire_at: null, last_fire_at: 1_760_000_000, last_run_id: 'run_1', last_status: 'failed', last_error: 'boom',
      created_at: null, updated_at: null,
    }] }));
    mount(h(AgentTriggersPanel, { agentId: 'a1', agentName: 'Support', versions: [], onShowRuns: () => undefined }));
    await flush();
    expect(document.querySelector('table')).toBeNull();
    expect(text()).toContain('GitHub · pull_request');
    expect(text()).toContain('Failed');
    expect(document.querySelector('[role="img"][aria-label="Webhook"]')).not.toBeNull();
    expect(document.querySelector('[title="github-pr-review-with-a-rather-long-name"]')).not.toBeNull();
  });

  it('deliveries: shows the error with a retry, not "no deliveries"', async () => {
    mount(h(WebhookDeliveriesPanel, { agentId: 'a1', triggerId: 'r1', onShowRuns: () => undefined }));
    await flush();
    expect(text()).toContain('Could not load the deliveries.');
    expect(text()).not.toContain('No deliveries yet');
    fetchMock.mockImplementation(() => json({ data: [], has_more: false }));
    await act(async () => { button('Try again')!.click(); await Promise.resolve(); });
    await flush();
    expect(text()).not.toContain('Could not load the deliveries.');
  });

  it('deliveries: each outcome is a dot and its full word, with no truncation', async () => {
    fetchMock.mockImplementation(() => json({ data: [
      { id: 'd1', received_at: 1_760_000_000, outcome: 'unauthorized', http_status: 401, event: null, delivery_id: null, run_id: null, reason: 'signature mismatch' },
      { id: 'd2', received_at: 1_760_000_001, outcome: 'ignored', http_status: 200, event: 'ping', delivery_id: null, run_id: null, reason: 'ping' },
    ], has_more: false }));
    mount(h(WebhookDeliveriesPanel, { agentId: 'a1', triggerId: 'r1', onShowRuns: () => undefined }));
    await flush();
    expect(text()).toContain('Unauthorized');
    expect(text()).toContain('Ignored');
    expect(document.querySelector('.mantine-Badge-root')).toBeNull();
  });
});

describe('chips a keyboard can reach', () => {
  it('the filter examples are buttons', () => {
    const form = { ...emptyTriggerForm(), type: 'webhook' as const, webhookPreset: 'github' as const };
    const markup = renderToStaticMarkup(wrap(h(WebhookFields, { form, set: () => undefined, storedStandardSecret: false, errorOf: () => undefined })));
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>(<span[^>]*>)*Opened \/ synchronize/);
  });

  // One editor session for both checks.
  it('in the trigger editor: the cron presets are buttons that say which one is selected, and a save that fails on the network says so', async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => (init?.method === 'POST' ? Promise.reject(new Error('offline')) : json({ data: [] })));
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
    window.addEventListener('unhandledrejection', onRejection);
    mount(h(AgentTriggersPanel, { agentId: 'a1', agentName: 'Support', versions: [], onShowRuns: () => undefined }));
    await flush();
    await act(async () => { button('Add trigger')!.click(); await Promise.resolve(); });

    const hourly = button('Every hour')!;
    expect(hourly.tagName).toBe('BUTTON');
    const weekdays = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') !== null && b.textContent?.includes('Weekdays'))!;
    expect(weekdays.getAttribute('aria-pressed')).toBe('true');
    expect(hourly.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { hourly.click(); await Promise.resolve(); });
    expect(button('Every hour')!.getAttribute('aria-pressed')).toBe('true');

    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="Nightly digest"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(nameInput, 'Digest'); nameInput.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { button('Save trigger')!.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush();
    window.removeEventListener('unhandledrejection', onRejection);
    expect(fetchMock.mock.calls.some((call) => (call[1] as { method?: string } | undefined)?.method === 'POST')).toBe(true);
    expect(rejections).toEqual([]);
  });
});
