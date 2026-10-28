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
import { messages } from '@/lib/i18n/messages';

const catalog = vi.hoisted(() => ({
  available: true,
  /** The first answer of the catalog is on its way. */
  loading: false,
  /** Not available because this person may not read the project's connectors (a 403), not because the module is off. */
  forbidden: false,
  connectors: [] as unknown[],
}));

// The fakes build elements through the React the test puts on globalThis (a factory cannot import it before it is hoisted).
vi.mock('@/components/enterprise/EnterpriseConnectorTriggerUi', () => {
  const el = (...args: unknown[]) => (globalThis as unknown as { React: { createElement: (...a: unknown[]) => unknown } }).React.createElement(...args);
  return {
    useConnectorTriggerCatalog: () => ({
      available: catalog.available, forbidden: catalog.forbidden, loading: catalog.loading, error: null, connectors: catalog.connectors, reload: () => undefined,
    }),
    ConnectorTriggerPicker: (props: {
      value: { connectorId: string; trigger: string; scheduleCron: string; scheduleTimezone: string } | null;
      onChange: (value: unknown) => void;
      errors?: Record<string, string>;
    }) => el(
      'div',
      { 'data-testid': 'picker' },
      el('button', {
        type: 'button',
        onClick: () => props.onChange({
          connectorId: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'], scheduleCron: '', scheduleTimezone: 'UTC',
        }),
      }, 'Pick GitHub pull requests'),
      // A poll trigger (the schedule field starts on the package's default), and what a person does to that field.
      el('button', {
        type: 'button',
        onClick: () => props.onChange({ connectorId: 'c1', trigger: 'issues', params: {}, events: [], scheduleCron: '*/5 * * * *', scheduleTimezone: 'UTC' }),
      }, 'Pick Issues (poll)'),
      el('button', { type: 'button', onClick: () => props.onChange({ ...props.value!, scheduleCron: '0 9 1W * *' }) }, 'Type the schedule 0 9 1W * *'),
      el('button', { type: 'button', onClick: () => props.onChange({ ...props.value!, scheduleCron: '' }) }, 'Clear the schedule'),
      el('span', null, props.value ? `picked:${props.value.connectorId}/${props.value.trigger}` : 'nothing picked'),
      el('span', null, `schedule:${props.value?.scheduleCron ?? ''} (${props.value?.scheduleTimezone ?? ''})`),
      el('span', null, `errors:${JSON.stringify(props.errors ?? {})}`),
    ),
    ConnectorTriggerStatus: (props: {
      subscription: { status: string; subscription_id: string } | null;
      onChanged: () => void;
      reveal?: { secret: string | null; previousValidUntil: number | null } | null;
      onReveal?: (reveal: unknown) => void;
    }) => el(
      'div',
      null,
      el('span', null, `status:${props.subscription?.status ?? 'none'}`),
      el('span', null, `subscription:${props.subscription?.subscription_id ?? 'none'}`),
      el('span', null, `secret:${props.reveal?.secret ?? 'none'}`),
      el('span', null, `until:${props.reveal?.previousValidUntil ?? 'none'}`),
      el('button', { type: 'button', onClick: props.onChanged }, 'Reload status'),
      // A rotation: the card hands the secret it was shown to the editor.
      el('button', {
        type: 'button',
        onClick: () => props.onReveal?.({ subscriptionId: props.subscription!.subscription_id, secret: 'rotated-secret', previousValidUntil: 1_900_000_000 }),
      }, 'Rotate secret'),
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

const wrap = (node: ReactNode, locale: 'en' | 'tr' = 'en') => h(MantineProvider, null, h(I18nProvider, { locale, children: h(ConfirmProvider, null, node) }));

function mount(node: ReactNode, locale: 'en' | 'tr' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(wrap(node, locale)));
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
  catalog.loading = false;
  catalog.forbidden = false;
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
const listOf = (...rows: unknown[]) => routes.push((url, method) => (method === 'GET' && /\/triggers(?:\?|$)/.test(url) ? json({ data: rows }) : null));
/** A subscription as the trigger routes answer it. */
const subscriptionWire = (id: string, status = 'active', over: Record<string, unknown> = {}) => ({ subscription_id: id, status, kind: 'webhook', bindings: 1, ...over });

/** The sentences of the editor, as the reader's language has them. */
const words = (locale: 'en' | 'tr' = 'en') => messages[locale].agents.triggers;
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** The line under a filter row's path field: where the conversion marks a rule that matches nothing or everything. */
const hintUnder = (input: HTMLInputElement) => input.closest('[class*="InputWrapper-root"]')?.querySelector('[class*="InputWrapper-error"]')?.textContent ?? null;

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
    routes.push((url, method) => (method === 'POST' && /\/triggers(?:\?|$)/.test(url) ? json(saved, true, 201) : null));
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
    expect(post.url).toBe('/api/agents/a1/triggers?locale=en');
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
    expect(calls.filter((call) => call.method === 'GET' && /triggers\/r2(?:\?|$)/.test(call.url))).toHaveLength(0);
  });

  it('keeps the secret the saved hook showed once, also when the trigger is read again without it', async () => {
    const secretless = { subscription_id: 'sub1', status: 'manual', kind: 'webhook', bindings: 1 };
    const saved = connectorRow({ connector_subscription: { ...secretless, secret: 'whsec_created' } });
    routes.push((url, method) => (method === 'POST' && /\/triggers(?:\?|$)/.test(url) ? json(saved, true, 201) : null));
    routes.push((url, method) => (method === 'GET' && /\/triggers\/r2(?:\?|$)/.test(url) ? json(connectorRow({ connector_subscription: secretless })) : null));
    mount(panel());
    await flush();
    await click(button('Add trigger'));
    await click(document.querySelector('input[type="radio"][value="connector"]'));
    await click(button('Pick GitHub pull requests'));
    typeInto(document.querySelector<HTMLInputElement>('input[placeholder="Nightly digest"]')!, 'PR review');
    typeInto(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Review {{payload.number}}');
    await click(button('Save trigger'));
    expect(text()).toContain('secret:whsec_created');

    // The editor reads the trigger again: the answer has no secret, the one it was shown is kept.
    await click(button('Reload status'));
    expect(text()).toContain('status:manual');
    expect(text()).toContain('secret:whsec_created');
    // And across the other tabs.
    await click(tab('Test'));
    await click(tab('Settings'));
    expect(text()).toContain('secret:whsec_created');
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
    routes.push((url, method) => (method === 'POST' && /\/triggers(?:\?|$)/.test(url)
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

describe('the schedule of a poll connector trigger', () => {
  const pollRow = () => connectorRow({ id: 'r4', name: 'Daily issues' }, { kind: 'poll', trigger: 'issues', events: [], schedule: { cron: '*/10 * * * *', timezone: 'Europe/Istanbul' } });
  /** What the server stored once the field was empty: the package's own schedule, in UTC. */
  const packageSchedule = { cron: '*/5 * * * *', timezone: 'UTC' };
  const addPoll = async () => {
    await click(button('Add trigger'));
    await click(document.querySelector('input[type="radio"][value="connector"]'));
    await click(button('Pick Issues (poll)'));
    typeInto(document.querySelector<HTMLInputElement>('input[placeholder="Nightly digest"]')!, 'Daily issues');
  };

  it('is sent as it is typed, whatever its syntax: the server asks the Connectors module, and the picker shows the sentence it answers with', async () => {
    const sentence = 'cron uses syntax connector schedules do not support (L, W, # or ?); use numbers, ranges, lists, steps and month or weekday names';
    routes.push((url, method) => (method === 'POST' && /\/triggers(?:\?|$)/.test(url)
      ? json({ error: { type: 'invalid_request_error', code: 'invalid_trigger', message: `Invalid trigger - connector.schedule.cron: ${sentence}`, errors: [
        { field: 'connector.schedule.cron', message: sentence },
      ] } }, false, 400)
      : null));
    mount(panel());
    await flush();
    await addPoll();
    await click(button('Type the schedule 0 9 1W * *'));
    await click(button('Save trigger'));

    // Core's cron-parser does not read `1W`, the connector grammar does not either; neither is the form's to judge.
    const post = calls.find((call) => call.method === 'POST');
    expect(post, 'the form sent the save').toBeDefined();
    expect(post!.body!.connector).toMatchObject({ schedule: { cron: '0 9 1W * *', timezone: 'UTC' } });
    expect(text()).toContain(`errors:${JSON.stringify({ 'connector.schedule.cron': sentence })}`);
    expect(text()).not.toContain(words().previewInvalid);
    // The refused save leaves what was typed where it was.
    expect(text()).toContain('schedule:0 9 1W * * (UTC)');
  });

  it('is the package’s own for a new trigger saved with an empty field (nothing is sent), and the editor then shows the schedule that was stored', async () => {
    routes.push((url, method) => (method === 'POST' && /\/triggers(?:\?|$)/.test(url)
      ? json({ ...pollRow(), connector: { ...pollRow().connector, schedule: packageSchedule }, connector_subscription: subscriptionWire('sub9', 'active', { kind: 'poll' }) }, true, 201)
      : null));
    mount(panel());
    await flush();
    await addPoll();
    await click(button('Clear the schedule'));
    expect(text()).toContain('schedule: (UTC)');
    await click(button('Save trigger'));

    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body!.connector).not.toHaveProperty('schedule');
    expect(text()).toContain('schedule:*/5 * * * * (UTC)');
    expect(text()).toContain('subscription:sub9');
  });

  it('goes back to the package’s own schedule when the field of a saved trigger is cleared: the save says null, and the editor shows what the server stored', async () => {
    listOf(pollRow());
    routes.push((url, method) => (method === 'GET' && /\/triggers\/r4(?:\?|$)/.test(url) ? json({ ...pollRow(), connector_subscription: subscriptionWire('sub9', 'active', { kind: 'poll' }) }) : null));
    routes.push((url, method) => (method === 'PATCH' && /\/triggers\/r4(?:\?|$)/.test(url)
      ? json({ ...pollRow(), connector: { ...pollRow().connector, schedule: packageSchedule }, connector_subscription: subscriptionWire('sub9', 'active', { kind: 'poll' }) })
      : null));
    mount(panel());
    await flush();
    await click(button('Edit'));
    expect(text()).toContain('schedule:*/10 * * * * (Europe/Istanbul)');
    await click(button('Clear the schedule'));
    expect(text()).toContain('schedule: (Europe/Istanbul)');
    await click(button('Save trigger'));

    // An omitted schedule would keep the stored cron; null asks for the package's.
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.body!.connector).toHaveProperty('schedule', null);
    // The field matches the status card again, in the timezone the server applied.
    expect(text()).toContain('schedule:*/5 * * * * (UTC)');
    expect(text()).not.toContain('(Europe/Istanbul)');
  });

  it('is sent again as typed once the field has a cron in it, also on a saved trigger', async () => {
    listOf(pollRow());
    routes.push((url, method) => (method === 'GET' && /\/triggers\/r4(?:\?|$)/.test(url) ? json({ ...pollRow(), connector_subscription: subscriptionWire('sub9', 'active', { kind: 'poll' }) }) : null));
    routes.push((url, method) => (method === 'PATCH' && /\/triggers\/r4(?:\?|$)/.test(url) ? json(pollRow()) : null));
    mount(panel());
    await flush();
    await click(button('Edit'));
    await click(button('Clear the schedule'));
    await click(button('Type the schedule 0 9 1W * *'));
    await click(button('Save trigger'));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch, 'the form sent the save').toBeDefined();
    expect(patch!.body!.connector).toMatchObject({ schedule: { cron: '0 9 1W * *', timezone: 'Europe/Istanbul' } });
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

  it('writes the connector trigger in the words of the reader\'s own catalog, and keeps the stored label where the catalog does not list it', async () => {
    // The stored label is English whoever saved the trigger; the catalog the screen holds is asked in the reader's language.
    catalog.connectors = [{ id: 'c1', key: 'github', name: 'Company GitHub', packageId: 'cognipeer.github', packageName: 'GitHub', status: 'active', accountStatus: 'active', triggers: [{ name: 'pull_request', title: 'Çekme isteği' }] }];
    listOf(
      connectorRow(),
      connectorRow({ id: 'r3', name: 'Elsewhere' }, { connector_id: 'c7', trigger: 'issues', label: 'Tracker · Issues', events: [] }),
    );
    mount(panel());
    await flush();
    expect(text()).toContain('GitHub · Çekme isteği · pull_request.opened');
    expect(text()).not.toContain('GitHub · Pull request');
    expect(text()).toContain('Tracker · Issues · every event');
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
    routes.push((url, method) => (method === 'PATCH' && /\/triggers\/r1(?:\?|$)/.test(url) ? json(connectorRow({ id: 'r1', connector_subscription: null })) : null));
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
    expect(patch.url).toBe('/api/agents/a1/triggers/r1?locale=en');
    expect(patch.body).toMatchObject({
      type: 'connector', prompt: 'Review {{payload.number}}', variables: { region: 'eu' },
      connector: { connector_id: 'c1', filter: [{ path: 'payload.sender.type', op: 'eq', value: 'User' }], include_payload: false },
    });
    expect(patch.body).not.toHaveProperty('webhook');
  });

  it('tells the converting user that the carried-over rules and tags were written for the vendor, and to check them with Preview', async () => {
    listOf(retiredRow());
    mount(panel());
    await flush();
    await click(button('Convert to connector trigger'));
    expect(text()).toContain('written for the vendor\'s own webhook and are kept as they were');
    expect(text()).toContain('payload.draft, payload.number, payload.repository');
    expect(text()).toContain('use Preview on the Test tab');
    // A rule on the carried-over payload path is shown as it is, not marked: only headers / preset can never match.
    expect(text()).not.toContain(words().convertRowHint);
    expect(text()).not.toContain(words().convertRowAlwaysHint);
  });

  it('marks the carried-over rules on headers or preset, keeps them, and sends them unchanged when saved', async () => {
    const row = retiredRow();
    row.webhook.filter = [
      { path: 'headers.x-github-event', op: 'eq', value: 'pull_request' },
      { path: 'payload.sender.type', op: 'eq', value: 'User' },
    ];
    listOf(row);
    routes.push((url, method) => (method === 'PATCH' && /\/triggers\/r1(?:\?|$)/.test(url) ? json(connectorRow({ id: 'r1', connector_subscription: null })) : null));
    mount(panel());
    await flush();
    await click(button('Convert to connector trigger'));
    const paths = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Path"]')];
    expect(paths.map((input) => input.value)).toEqual(['headers.x-github-event', 'payload.sender.type']);
    expect(occurrences(text(), words().convertRowHint)).toBe(1);
    await click(button('Pick GitHub pull requests'));
    await click(button('Save trigger'));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect((patch.body as { connector: { filter: unknown } }).connector.filter).toEqual([
      { path: 'headers.x-github-event', op: 'eq', value: 'pull_request' },
      { path: 'payload.sender.type', op: 'eq', value: 'User' },
    ]);
  });

  it('tells a carried-over rule that matches every connector event from one that matches none, under its own row', async () => {
    const row = retiredRow();
    const filter = [
      { path: 'headers.x-github-event', op: 'eq', value: 'pull_request' },
      { path: 'headers.x-github-event', op: 'neq', value: 'pull_request' },
      { path: 'headers.x-github-event', op: 'exists' },
      { path: 'headers.x-github-event', op: 'not_exists' },
      { path: 'headers.x-github-event', op: 'contains', value: 'pull' },
      { path: 'preset', op: 'eq', value: 'connector' },
      { path: 'preset', op: 'eq', value: 'github' },
      { path: 'preset', op: 'neq', value: 'github' },
      { path: 'payload.sender.type', op: 'eq', value: 'User' },
    ];
    listOf({ ...row, webhook: { ...row.webhook, filter } });
    routes.push((url, method) => (method === 'PATCH' && /\/triggers\/r1(?:\?|$)/.test(url) ? json(connectorRow({ id: 'r1', connector_subscription: null })) : null));
    mount(panel());
    await flush();
    await click(button('Convert to connector trigger'));
    const never = words().convertRowHint;
    const always = words().convertRowAlwaysHint;
    expect(never).not.toBe(always);
    const paths = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Path"]')];
    expect(paths.map(hintUnder)).toEqual([never, never, never, always, never, always, never, always, null]);
    // Nothing is dropped behind the user's back: all nine rows are sent as they were.
    await click(button('Pick GitHub pull requests'));
    await click(button('Save trigger'));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect((patch.body as { connector: { filter: unknown } }).connector.filter).toEqual(filter);
  });

  it('follows the rule as it is edited: a preset rule that matched nothing matches every event once it names the connector preset', async () => {
    const row = retiredRow();
    row.webhook.filter = [{ path: 'preset', op: 'eq', value: 'github' }];
    listOf(row);
    mount(panel());
    await flush();
    await click(button('Convert to connector trigger'));
    expect(text()).toContain('this rule never matches.');
    expect(text()).not.toContain('so it filters nothing');
    typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Value"]')!, 'connector');
    expect(text()).toContain('this rule matches every connector event, so it filters nothing.');
    expect(text()).not.toContain('this rule never matches.');
  });

  it('says of a rule on the preset what a connector event does have: no headers, and the preset “connector”, so the rule never matches', async () => {
    const row = retiredRow();
    row.webhook.filter = [
      { path: 'preset', op: 'eq', value: 'github' },
      { path: 'headers.x-github-event', op: 'eq', value: 'pull_request' },
    ];
    listOf(row);
    mount(panel());
    await flush();
    await click(button('Convert to connector trigger'));
    const hints = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Path"]')].map(hintUnder);
    // One sentence for both: the event has no headers and its preset is “connector”. It does not claim there is no preset.
    const never = 'A connector event has no headers and its preset is always “connector”: this rule never matches.';
    expect(hints).toEqual([never, never]);
    expect(hints[0]).not.toMatch(/no headers or preset/);
    expect(words().convertRowHint).toBe(never);
  });

  it('says it in Turkish too: the preset is “connector”, it is not missing', async () => {
    const row = retiredRow();
    row.webhook.filter = [{ path: 'preset', op: 'eq', value: 'github' }];
    listOf(row);
    mount(panel(), 'tr');
    await flush();
    await click(button('Bağlayıcı tetikleyiciye dönüştür'));
    const never = 'Bağlayıcı olayında başlık (header) yoktur ve hazır ayarı (preset) her zaman “connector”dır: bu kural hiçbir zaman eşleşmez.';
    expect([...document.querySelectorAll<HTMLInputElement>(`input[aria-label="${words('tr').webhookFilterPath}"]`)].map(hintUnder)).toEqual([never]);
    expect(words('tr').convertRowHint).toBe(never);
    expect(never).not.toContain('hazır ayar yoktur');
  });

  it('shows neither the conversion notice nor a mark in a plain edit of a connector trigger or a new one', async () => {
    catalog.connectors = [{
      id: 'c1', key: 'github', name: 'GitHub (acme)', packageId: 'cognipeer.github', packageName: 'GitHub', status: 'active', accountStatus: 'active',
      triggers: [{ name: 'pull_request', title: 'Pull request', description: '', kind: 'webhook', events: [], params: {}, autoSubscribe: true, sample: { type: 'pull_request.opened', data: {} } }],
    }];
    listOf(connectorRow({}, { filter: [{ path: 'headers.x', op: 'eq', value: 'y' }] }));
    routes.push((url, method) => (method === 'GET' && /\/triggers\/r2(?:\?|$)/.test(url) ? json(connectorRow({ connector_subscription: { subscription_id: 'sub1', status: 'active', kind: 'webhook', bindings: 1 } })) : null));
    mount(panel());
    await flush();
    await click(button('Edit'));
    expect(text()).not.toContain('written for the vendor\'s own webhook');
    expect(text()).not.toContain('this rule never matches');
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
    routes.push((url, method) => (method === 'GET' && /\/triggers\/r2(?:\?|$)/.test(url) ? json(connectorRow({ connector_subscription: subscription })) : null));
  });

  it('asks for the subscription in the reader\'s language, English or Turkish, so the module can write its reason in it', async () => {
    mount(panel());
    await flush();
    await click(button('Edit'));
    const read = calls.find((call) => call.method === 'GET' && /triggers\/r2(?:\?|$)/.test(call.url))!;
    expect(read.url).toBe('/api/agents/a1/triggers/r2?locale=en');
    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
    calls.length = 0;

    mount(panel(), 'tr');
    await flush();
    await click(button('Düzenle'));
    expect(calls.find((call) => call.method === 'GET' && /triggers\/r2(?:\?|$)/.test(call.url))!.url).toBe('/api/agents/a1/triggers/r2?locale=tr');
  });

  it('keeps the secret a rotation showed (and until when the old one works) while the editor shows another tab', async () => {
    mount(panel());
    await flush();
    await click(button('Edit'));
    expect(text()).toContain('secret:none');
    await click(button('Rotate secret'));
    expect(text()).toContain('secret:rotated-secret');
    expect(text()).toContain('until:1900000000');

    await click(tab('Test'));
    expect(text()).not.toContain('secret:');
    await click(tab('Settings'));
    expect(text()).toContain('secret:rotated-secret');
    expect(text()).toContain('until:1900000000');
    await click(tab('Deliveries'));
    await click(tab('Settings'));
    expect(text()).toContain('secret:rotated-secret');

    // The card asks the editor to read the trigger again (after the rotation): the secret stays.
    await click(button('Reload status'));
    expect(text()).toContain('secret:rotated-secret');
  });

  it('forgets the secret when the trigger turns out to hang on another subscription', async () => {
    mount(panel());
    await flush();
    await click(button('Edit'));
    await click(button('Rotate secret'));
    expect(text()).toContain('secret:rotated-secret');
    routes.unshift((url, method) => (method === 'GET' && /\/triggers\/r2(?:\?|$)/.test(url) ? json(connectorRow({ connector_subscription: { ...subscription, subscription_id: 'sub2' } })) : null));
    await click(button('Reload status'));
    expect(text()).toContain('status:active');
    expect(text()).toContain('secret:none');
    expect(text()).toContain('until:none');
  });

  it('reads the subscription (lists do not carry it) and hands it to the status, which can ask for a reload', async () => {
    mount(panel());
    await flush();
    await click(button('Edit'));
    expect(calls.filter((call) => call.method === 'GET' && /triggers\/r2(?:\?|$)/.test(call.url))).toHaveLength(1);
    expect(text()).toContain('status:active');
    expect(tab('Settings')).toBeDefined();
    routes.unshift((url, method) => (method === 'GET' && /\/triggers\/r2(?:\?|$)/.test(url) ? json(connectorRow({ connector_subscription: { ...subscription, status: 'failed' } })) : null));
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

describe('a saved connector trigger while the connectors cannot be offered', () => {
  const edit = async (locale: 'en' | 'tr' = 'en') => {
    listOf(connectorRow());
    mount(panel(), locale);
    await flush();
    await click(button(locale === 'tr' ? 'Düzenle' : 'Edit'));
  };
  const placeholders = () => document.querySelector('[data-testid="connector-catalog-loading"]');
  const picker = () => document.querySelector('[data-testid="picker"]');

  it('draws placeholders while the first answer is on its way, not “not available”', async () => {
    catalog.available = false;
    catalog.loading = true;
    await edit();
    expect(placeholders()).not.toBeNull();
    expect(placeholders()!.getAttribute('aria-busy')).toBe('true');
    expect(text()).not.toContain(words().connectorUnavailable);
    expect(text()).not.toContain(words().connectorForbidden);
    expect(picker()).toBeNull();
    // The rest of the editor is there.
    expect(text()).toContain('starts an unattended run');
  });

  it('shows the picker, not the placeholders, when the connectors are there and a reload runs', async () => {
    catalog.available = true;
    catalog.loading = true;
    await edit();
    expect(placeholders()).toBeNull();
    expect(picker()).not.toBeNull();
  });

  it('says the module is not available when it is off, licensed out or missing', async () => {
    catalog.available = false;
    await edit();
    expect(placeholders()).toBeNull();
    expect(text()).toContain(words().connectorUnavailable);
    expect(text()).not.toContain(words().connectorForbidden);
    expect(picker()).toBeNull();
  });

  it('says the person has no access to the connectors, apart from the module being off, when the answer was their own 403', async () => {
    catalog.available = false;
    catalog.forbidden = true;
    await edit();
    expect(placeholders()).toBeNull();
    expect(text()).toContain(words().connectorForbidden);
    expect(text()).not.toContain(words().connectorUnavailable);
    expect(picker()).toBeNull();
    expect(words().connectorForbidden).toContain('Ask a project admin for read access to Connectors');
  });

  it('says both in Turkish', async () => {
    catalog.available = false;
    catalog.forbidden = true;
    await edit('tr');
    expect(text()).toContain(words('tr').connectorForbidden);
    expect(text()).not.toContain(words('tr').connectorUnavailable);
    expect(words('tr').connectorForbidden).not.toBe(words('en').connectorForbidden);
    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
    catalog.forbidden = false;
    await edit('tr');
    expect(text()).toContain(words('tr').connectorUnavailable);
    expect(text()).not.toContain(words('tr').connectorForbidden);
  });
});
