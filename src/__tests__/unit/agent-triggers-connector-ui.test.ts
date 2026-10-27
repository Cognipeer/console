// @vitest-environment jsdom
/**
 * The agent triggers panel with connector triggers, driven the way a person drives it (jsdom). The enterprise parts
 * (catalog hook, picker, status) are replaced by small fakes through the seam file, so what is checked here is the
 * community side: when the Connector choice shows, what a save sends for the picker's value, the Retired badge and the
 * conversion of a retired vendor trigger, the Settings / Test / Deliveries tabs of a saved connector trigger and the
 * hint about unattended runs.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm';
import AgentTriggersPanel from '@/components/agents/studio/AgentTriggersPanel';

const catalog = vi.hoisted(() => ({
  available: true,
  connectors: [] as unknown[],
}));

// The fakes build elements through the React the test puts on globalThis (a factory cannot import it before it is hoisted).
vi.mock('@/components/enterprise/EnterpriseConnectorTriggerUi', () => {
  const el = (...args: unknown[]) => (globalThis as unknown as { React: { createElement: (...a: unknown[]) => unknown } }).React.createElement(...args);
  return {
    useConnectorTriggerCatalog: () => ({ available: catalog.available, loading: false, error: null, connectors: catalog.connectors, reload: () => undefined }),
    ConnectorTriggerPicker: (props: { value: { connectorId: string; trigger: string } | null; onChange: (value: unknown) => void; errors?: Record<string, string> }) => el(
      'div',
      { 'data-testid': 'picker' },
      el('button', {
        type: 'button',
        onClick: () => props.onChange({
          connectorId: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'], scheduleCron: '', scheduleTimezone: 'UTC',
        }),
      }, 'Pick GitHub pull requests'),
      el('span', null, props.value ? `picked:${props.value.connectorId}/${props.value.trigger}` : 'nothing picked'),
      el('span', null, `errors:${JSON.stringify(props.errors ?? {})}`),
    ),
    ConnectorTriggerStatus: (props: { subscription: { status: string } | null; onChanged: () => void }) => el(
      'div',
      null,
      el('span', null, `status:${props.subscription?.status ?? 'none'}`),
      el('button', { type: 'button', onClick: props.onChanged }, 'Reload status'),
    ),
  };
});

// The lists render through DataGrid, whose row navigation needs the app router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/agents/a1',
  useSearchParams: () => new URLSearchParams(),
}));

// The full timezone list makes a jsdom render take seconds.
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

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
const tab = (label: string) => [...document.body.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.trim() === label) as HTMLElement | undefined;
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); await flush(); };
const typeInto = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
/** The "When" choices as the segmented control labels them. */
const typeChoices = () => [...document.body.querySelectorAll('input[type="radio"]')].map((input) => (input as HTMLInputElement).value);

const json = (body: unknown, ok = true, status = ok ? 200 : 500) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[];
let routes: Array<(url: string, method: string) => Promise<Response> | null>;

beforeEach(() => {
  calls = [];
  routes = [];
  catalog.available = true;
  catalog.connectors = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : null });
    for (const route of routes) {
      const answer = route(url, method);
      if (answer) return answer;
    }
    return json({ data: [] });
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const common = {
  object: 'agent.trigger', agent: 'a', description: null, enabled: true, prompt: 'Review {{payload.number}}', variables: null, version: null, class: 'default',
  metadata: {}, callback: null, response_format: null, next_fire_at: null, last_fire_at: null, last_run_id: null, last_status: null, last_error: null,
  created_at: null, updated_at: null,
};
const connectorRow = (overrides: Record<string, unknown> = {}, connector: Record<string, unknown> = {}) => ({
  ...common, id: 'r2', name: 'PR review', type: 'connector', connector_available: true,
  connector: {
    connector_id: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, schedule: null, events: ['pull_request.opened'], filter: [],
    include_payload: true, subscription_id: 'sub1', package_id: 'cognipeer.github', kind: 'webhook', label: 'GitHub · Pull request', ...connector,
  },
  ...overrides,
});
const retiredRow = () => ({
  ...common, id: 'r1', name: 'Old GitHub hook', type: 'webhook', variables: { region: 'eu' },
  webhook: {
    url: 'https://console.example.com/api/public/hooks/t/wh_x', preset: 'github', auth: 'github_signature', retired: true, events: ['pull_request'],
    filter: [{ path: 'payload.sender.type', op: 'eq', value: 'User' }], include_payload: false,
  },
});
const listOf = (...rows: unknown[]) => routes.push((url, method) => (method === 'GET' && /\/triggers$/.test(url) ? json({ data: rows }) : null));

const panel = () => h(AgentTriggersPanel, {
  agentId: 'a1', agentName: 'Support', versions: [], declaredVariables: [{ name: 'region', type: 'string' }], onShowRuns: () => undefined,
});

describe('the Connector choice', () => {
  it('is not offered without the Connectors module', async () => {
    catalog.available = false;
    mount(panel());
    await flush();
    await click(button('Add trigger'));
    expect(typeChoices()).toEqual(['schedule', 'once', 'manual', 'webhook']);
    expect(text()).not.toContain('nothing picked');
  });

  it('is offered with it, and shows the picker, the filter, the payload switch and the unattended hint once chosen', async () => {
    mount(panel());
    await flush();
    await click(button('Add trigger'));
    expect(typeChoices()).toEqual(['schedule', 'once', 'manual', 'webhook', 'connector']);
    await click(document.querySelector('input[type="radio"][value="connector"]'));
    expect(text()).toContain('nothing picked');
    expect(text()).toContain('Add rule');
    expect(text()).toContain('Include the event payload');
    expect(text()).toContain('{{connector.name}}');
    expect(text()).not.toContain('{{headers.…}}');
    expect(text()).toContain('starts an unattended run');
    expect(text()).toContain('Never ask');
  });

  it('sends the picker’s value in the API’s spelling and stays open on the saved row with its status', async () => {
    const saved = connectorRow({ connector_subscription: { subscription_id: 'sub1', status: 'manual', kind: 'webhook', bindings: 1 } });
    routes.push((url, method) => (method === 'POST' && /\/triggers$/.test(url) ? json(saved, true, 201) : null));
    mount(panel());
    await flush();
    await click(button('Add trigger'));
    await click(document.querySelector('input[type="radio"][value="connector"]'));
    await click(button('Pick GitHub pull requests'));
    expect(text()).toContain('picked:c1/pull_request');
    typeInto(document.querySelector<HTMLInputElement>('input[placeholder="Nightly digest"]')!, 'PR review');
    typeInto(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Review {{payload.number}}');
    await click(button('Add rule'));
    typeInto(document.querySelectorAll<HTMLInputElement>('input[aria-label="Value"]')[0]!, 'main');
    await click(button('Save trigger'));

    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe('/api/agents/a1/triggers');
    expect(post.body).toMatchObject({
      name: 'PR review', type: 'connector', prompt: 'Review {{payload.number}}', enabled: true,
      connector: {
        connector_id: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'],
        filter: [{ path: 'payload.', op: 'eq', value: 'main' }], include_payload: true,
      },
    });
    expect(post.body).not.toHaveProperty('webhook');
    expect(post.body!.connector).not.toHaveProperty('schedule');
    // The editor stays on the saved trigger: the subscription from the answer shows (no extra read), with the three tabs.
    expect(text()).toContain('status:manual');
    expect(tab('Test')).toBeDefined();
    expect(tab('Deliveries')).toBeDefined();
    expect(calls.filter((call) => call.method === 'GET' && /triggers\/r2$/.test(call.url))).toHaveLength(0);
  });

  it('refuses to save without a pick, saying so on the picker', async () => {
    mount(panel());
    await flush();
    await click(button('Add trigger'));
    await click(document.querySelector('input[type="radio"][value="connector"]'));
    typeInto(document.querySelector<HTMLInputElement>('input[placeholder="Nightly digest"]')!, 'PR review');
    await click(button('Save trigger'));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(text()).toContain('Pick a connector and one of its triggers');
  });

  it('hands the server’s field errors to the picker', async () => {
    routes.push((url, method) => (method === 'POST' && /\/triggers$/.test(url)
      ? json({ error: { type: 'invalid_request_error', code: 'invalid_trigger', message: 'Invalid trigger - connector.params.repository: is required', errors: [
        { field: 'connector.params.repository', message: 'is required' }, { field: 'prompt', message: 'ignored here' },
      ] } }, false, 400)
      : null));
    mount(panel());
    await flush();
    await click(button('Add trigger'));
    await click(document.querySelector('input[type="radio"][value="connector"]'));
    await click(button('Pick GitHub pull requests'));
    typeInto(document.querySelector<HTMLInputElement>('input[placeholder="Nightly digest"]')!, 'PR review');
    await click(button('Save trigger'));
    expect(text()).toContain('errors:{"connector.params.repository":"is required"}');
  });
});

describe('the list', () => {
  it('names a connector trigger by its connector and says whether it is pushed or polled', async () => {
    listOf(
      connectorRow(),
      connectorRow({ id: 'r3', name: 'Daily issues' }, { kind: 'poll', trigger: 'issues', label: 'GitHub · Issues', events: [], schedule: { cron: '*/10 * * * *', timezone: 'UTC' } }),
    );
    mount(panel());
    await flush();
    expect(text()).toContain('GitHub · Pull request · pull_request.opened');
    expect(text()).toContain('GitHub · Issues · every event · */10 * * * *');
    expect(document.querySelector('[role="img"][aria-label="Connector · the service pushes events (webhook)"]')).not.toBeNull();
    expect(document.querySelector('[role="img"][aria-label="Connector · checked on a schedule (poll)"]')).not.toBeNull();
    expect(text()).not.toContain('Needs Connectors');
  });

  it('marks a stored connector trigger that has no module to run it, and offers no Run now', async () => {
    catalog.available = false;
    listOf(connectorRow({ connector_available: false }));
    mount(panel());
    await flush();
    expect(text()).toContain('Needs Connectors');
    expect(button('Run now')).toBeUndefined();
  });
});

describe('a retired vendor webhook trigger', () => {
  it('shows the Retired badge, cannot be run, and offers the conversion', async () => {
    listOf(retiredRow());
    mount(panel());
    await flush();
    expect(text()).toContain('Retired');
    expect(text()).toContain('GitHub · pull_request');
    expect(button('Run now')).toBeUndefined();
    expect(button('Convert to connector trigger')).toBeDefined();
  });

  it('is only marked, not convertible, when the module is missing', async () => {
    catalog.available = false;
    listOf(retiredRow());
    mount(panel());
    await flush();
    expect(text()).toContain('Retired');
    expect(button('Convert to connector trigger')).toBeUndefined();
    expect(button('Edit')).toBeDefined();
  });

  it('converts into the editor as a connector trigger carrying prompt, variables, filter and payload choice, and saves over the same row', async () => {
    listOf(retiredRow());
    routes.push((url, method) => (method === 'PATCH' && /\/triggers\/r1$/.test(url) ? json(connectorRow({ id: 'r1', connector_subscription: null })) : null));
    mount(panel());
    await flush();
    await click(button('Convert to connector trigger'));
    expect(text()).toContain('nothing picked');
    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Review {{payload.number}}');
    expect(document.querySelector<HTMLInputElement>('input[placeholder="Nightly digest"]')!.value).toBe('Old GitHub hook');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Path"]')!.value).toBe('payload.sender.type');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Value"]')!.value).toBe('User');
    // The retired-webhook warning belongs to the plain Edit, not to the conversion.
    expect(text()).not.toContain('re-creates it as a generic webhook');
    // Nothing to save until a connector is picked.
    await click(button('Save trigger'));
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    await click(button('Pick GitHub pull requests'));
    await click(button('Save trigger'));

    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.url).toBe('/api/agents/a1/triggers/r1');
    expect(patch.body).toMatchObject({
      type: 'connector', prompt: 'Review {{payload.number}}', variables: { region: 'eu' },
      connector: { connector_id: 'c1', filter: [{ path: 'payload.sender.type', op: 'eq', value: 'User' }], include_payload: false },
    });
    expect(patch.body).not.toHaveProperty('webhook');
  });

  it('warns that a plain edit re-creates it as a generic webhook, and has no Connect card or Test tab', async () => {
    listOf(retiredRow());
    mount(panel());
    await flush();
    await click(button('Edit'));
    expect(text()).toContain('re-creates it as a generic webhook');
    expect(tab('Test')).toBeUndefined();
    expect(text()).not.toContain('Connect the sender');
  });
});

describe('a saved connector trigger', () => {
  const sample = { type: 'pull_request.opened', data: { number: 7, action: 'opened' } };
  const subscription = { subscription_id: 'sub1', status: 'active', kind: 'webhook', bindings: 2 };

  beforeEach(() => {
    catalog.connectors = [{
      id: 'c1', key: 'github', name: 'GitHub (acme)', packageId: 'cognipeer.github', packageName: 'GitHub', status: 'active', accountStatus: 'active',
      triggers: [{ name: 'pull_request', title: 'Pull request', description: '', kind: 'webhook', events: [], params: {}, autoSubscribe: true, sample }],
    }];
    listOf(connectorRow());
    routes.push((url, method) => (method === 'GET' && /\/triggers\/r2$/.test(url) ? json(connectorRow({ connector_subscription: subscription })) : null));
  });

  it('reads the subscription (lists do not carry it) and hands it to the status, which can ask for a reload', async () => {
    mount(panel());
    await flush();
    await click(button('Edit'));
    expect(calls.filter((call) => call.method === 'GET' && /triggers\/r2$/.test(call.url))).toHaveLength(1);
    expect(text()).toContain('status:active');
    expect(tab('Settings')).toBeDefined();
    routes.unshift((url, method) => (method === 'GET' && /\/triggers\/r2$/.test(url) ? json(connectorRow({ connector_subscription: { ...subscription, status: 'failed' } })) : null));
    await click(button('Reload status'));
    expect(text()).toContain('status:failed');
  });

  it('tests with the package’s sample event: preview is a dry run through the Run now route, run starts the trigger', async () => {
    routes.push((url, method) => (method === 'POST' && /\/triggers\/r2\/run$/.test(url)
      ? json({ matched: true, reason: null, event: 'pull_request.opened', delivery_id: null, prompt: 'Review 7', variables: null, errors: [], id: 'run_9' })
      : null));
    mount(panel());
    await flush();
    await click(button('Edit'));
    await click(tab('Test'));
    expect(document.querySelector<HTMLInputElement>('input[placeholder="e.g. pull_request.opened"]')!.value).toBe('pull_request.opened');
    expect(JSON.parse(document.querySelector<HTMLTextAreaElement>('textarea')!.value)).toEqual(sample.data);

    await click(button('Preview'));
    const preview = calls.find((call) => call.method === 'POST')!;
    expect(preview.url).toBe('/api/agents/a1/triggers/r2/run');
    expect(preview.body).toEqual({ payload: sample.data, event: 'pull_request.opened', dry_run: true });
    expect(text()).toContain('Would start a run');
    expect(text()).toContain('Review 7');

    await click(button('Run with this payload'));
    const run = calls.filter((call) => call.method === 'POST').at(-1)!;
    expect(run.body).toEqual({ payload: sample.data, event: 'pull_request.opened' });
  });

  it('lets the payload stay empty, so the connector’s own sample is used, and refuses a bad event type or JSON', async () => {
    catalog.connectors = [];
    routes.push((url, method) => (method === 'POST' && /\/triggers\/r2\/run$/.test(url)
      ? json({ matched: false, reason: 'event_not_selected', event: null, delivery_id: null, prompt: null, variables: null, errors: [] })
      : null));
    mount(panel());
    await flush();
    await click(button('Edit'));
    await click(tab('Test'));
    await click(button('Preview'));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ dry_run: true });

    typeInto(document.querySelector<HTMLInputElement>('input[placeholder="e.g. pull_request.opened"]')!, 'not an event!');
    expect(text()).toContain('Letters, digits and . _ : - only');
    expect(button('Preview')!.hasAttribute('disabled') || button('Preview')!.getAttribute('data-disabled') !== null).toBe(true);
    typeInto(document.querySelector<HTMLInputElement>('input[placeholder="e.g. pull_request.opened"]')!, '');
    typeInto(document.querySelector<HTMLTextAreaElement>('textarea')!, '{oops');
    expect(text()).toContain('Not valid JSON');
  });

  it('reads the delivery log of the trigger in the Deliveries tab', async () => {
    routes.push((url) => (/\/triggers\/r2\/deliveries/.test(url)
      ? json({ data: [{ id: 'd1', received_at: 1_760_000_000, outcome: 'accepted', http_status: 202, event: 'pull_request.opened', delivery_id: 'ev1', run_id: 'run_1', reason: null }], has_more: false })
      : null));
    mount(panel());
    await flush();
    await click(button('Edit'));
    await click(tab('Deliveries'));
    expect(text()).toContain('events this trigger received from its connector');
    expect(text()).toContain('pull_request.opened');
    expect(text()).toContain('Accepted');
  });
});
