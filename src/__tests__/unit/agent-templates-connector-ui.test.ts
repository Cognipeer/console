// @vitest-environment jsdom
/**
 * "Use template" and the template detail with connector triggers (jsdom): the connector the triggers listen to comes
 * from the project's connectors (the catalog hook of the seam file, faked here), a template whose package has no
 * connector says its triggers are skipped, and the page after creating names what was skipped and shows the callback
 * of a trigger that is set up by hand. Without the Connectors module the form says so and sends no connector.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import UseAgentTemplateShell from '@/components/agents/templates/UseAgentTemplateShell';
import TemplateDetailDrawer from '@/components/agents/templates/TemplateDetailDrawer';
import { AGENT_TEMPLATES } from '@/lib/services/agents/templates/catalog';

const catalog = vi.hoisted(() => ({ available: true, connectors: [] as unknown[] }));
/** The props the fake parameters form of the seam was rendered with, last render per trigger. */
const paramsForms = vi.hoisted(() => ({ renders: [] as Array<Record<string, unknown>>, hasParams: true }));

vi.mock('@/components/enterprise/EnterpriseConnectorTriggerUi', () => ({
  useConnectorTriggerCatalog: () => ({ available: catalog.available, loading: false, error: null, connectors: catalog.connectors, reload: () => undefined }),
  ConnectorTriggerPicker: () => null,
  ConnectorTriggerStatus: () => null,
  // The enterprise form draws the package's parameter fields; here one input for `repository`.
  ConnectorTriggerParamsForm: (props: { label?: string; value: Record<string, unknown>; onChange: (params: Record<string, unknown>) => void } & Record<string, unknown>) => {
    paramsForms.renders.push(props);
    if (!paramsForms.hasParams) return null;
    const react = (globalThis as unknown as { React: typeof React }).React;
    return react.createElement('div', null,
      react.createElement('span', null, props.label),
      react.createElement('input', {
        'aria-label': 'repository', value: String(props.value.repository ?? ''),
        onChange: (event: { currentTarget: { value: string } }) => props.onChange({ ...props.value, repository: event.currentTarget.value }),
      }));
  },
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: ReactNode }) => (globalThis as unknown as { React: typeof React }).React.createElement('a', { href: props.href }, props.children),
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

const wrap = (node: ReactNode) => h(MantineProvider, null, h(I18nProvider, { locale: 'en', children: node }));
function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(wrap(node)));
}
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); await flush(); };

const json = (body: unknown, ok = true, status = ok ? 200 : 500) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[];
let instantiateAnswer: unknown;

const github = (id: string, name: string, status = 'active') => ({
  id, key: id, name, packageId: 'cognipeer.github', packageName: 'GitHub', status, accountStatus: 'active', triggers: [],
});

const template = () => {
  const found = AGENT_TEMPLATES.find((candidate) => candidate.key === 'pr-reviewer')!;
  return {
    key: found.key, version: found.version, category: found.category, icon: found.icon, featured: false, capabilities: found.capabilities, modelHint: found.modelHint,
    requires: found.requires, surfaces: found.surfaces, availability: { status: 'ready', items: [] },
    spec: found.spec, resources: found.resources ?? null, triggers: found.triggers ?? [], tryIt: found.tryIt ?? null,
  };
};

beforeEach(() => {
  calls = [];
  catalog.available = true;
  catalog.connectors = [];
  paramsForms.renders = [];
  paramsForms.hasParams = true;
  instantiateAnswer = null;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : null });
    if (/\/api\/agents\/templates\/pr-reviewer\/instantiate$/.test(url)) return json(instantiateAnswer, true, 201);
    if (/\/api\/agents\/templates\/pr-reviewer$/.test(url)) return json({ template: template() });
    if (url.startsWith('/api/models')) return json({ models: [{ key: 'gpt-main', name: 'GPT', modelId: 'gpt' }] });
    return json({});
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

const openForm = async () => {
  mount(h(UseAgentTemplateShell, { templateKey: 'pr-reviewer', onClose: () => undefined, onOpenAgent: () => undefined }));
  await flush();
  const name = [...document.querySelectorAll<HTMLInputElement>('input')].find((input) => input.placeholder === 'Pull Request Reviewer')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'PR bot');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const create = async () => { await click(button('Create agent')); return calls.find((call) => call.url.endsWith('/instantiate'))!; };
const typeInto = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const repositoryInput = () => document.querySelector<HTMLInputElement>('input[aria-label="repository"]');
const skippedAnswer = (skipped: unknown[]) => ({
  agent: { _id: 'a1', key: 'pr-bot', name: 'PR bot' },
  template: { key: 'pr-reviewer', version: 1, catalogVersion: 1 },
  triggers: [],
  skipped_triggers: skipped,
  setup: [],
  warnings: [],
});

describe('Use template with connector triggers', () => {
  it('lists the trigger as a connector event and, with one connector of the package, picks it without being asked', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)'), github('c2', 'GitHub (disabled)', 'disabled')];
    await openForm();
    expect(text()).toContain('Connector event · cognipeer.github · pull_request');
    expect(text()).toContain('Connector for GitHub');
    const post = await create();
    expect(post.body).toMatchObject({ name: 'PR bot', modelKey: 'gpt-main', createTriggers: true, connector_ids: { 'Review pull requests': 'c1' } });
  });

  it('with several connectors asks which, and sends none until one is picked', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)'), github('c2', 'GitHub (labs)')];
    await openForm();
    expect(text()).toContain('Connector for GitHub');
    expect(document.querySelector('input[placeholder="Pick a connector"]')).not.toBeNull();
    const post = await create();
    expect(post.body).not.toHaveProperty('connector_ids');
  });

  it('says the triggers are skipped when the project has no connector of the package', async () => {
    catalog.connectors = [{ ...github('c9', 'Jira'), packageId: 'cognipeer.jira', packageName: 'Jira' }];
    await openForm();
    expect(text()).toContain('This project has no cognipeer.github connector yet');
    const post = await create();
    expect(post.body).not.toHaveProperty('connector_ids');
  });

  it('says the triggers are skipped without the Connectors module, and sends no connector', async () => {
    catalog.available = false;
    await openForm();
    expect(text()).toContain('Connector triggers need the Connectors module');
    const post = await create();
    expect(post.body).not.toHaveProperty('connector_ids');
  });

  it('names the skipped triggers after creating, and shows the callback of a trigger set up by hand once', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    instantiateAnswer = {
      agent: { _id: 'a1', key: 'pr-bot', name: 'PR bot' },
      template: { key: 'pr-reviewer', version: 1, catalogVersion: 1 },
      triggers: [{
        id: 't1', name: 'Review pull requests', type: 'connector', enabled: false,
        connector: { connectorId: 'c1', trigger: 'pull_request', subscription: { subscription_id: 's1', status: 'manual', kind: 'webhook', callback_url: 'https://console.example.com/api/public/connector-hooks/t/ch_abc', secret: 'sek_once', bindings: 1 } },
      }],
      skipped_triggers: [{ name: 'Triage failed builds', reason: 'connector_required', package: 'cognipeer.github' }],
      setup: [],
      warnings: [],
    };
    await openForm();
    await create();
    expect(text()).toContain('Triggers not created');
    expect(text()).toContain('Triage failed builds needs a GitHub connector');
    expect(text()).toContain('Connector trigger "Review pull requests"');
    expect(text()).toContain('https://console.example.com/api/public/connector-hooks/t/ch_abc');
    expect(text()).toContain('sek_once');
    expect(text()).toContain('The secret is shown only once');
  });
});

describe('Use template: the parameters of the connector triggers', () => {
  it('asks for the parameters of each connector trigger of the picked connector and sends them by the trigger\'s name', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    await openForm();
    expect(text()).toContain('Settings for "Review pull requests"');
    // The seam form is told which connector and which package trigger to draw the fields of.
    expect(paramsForms.renders.at(-1)).toMatchObject({ connectorId: 'c1', trigger: 'pull_request', value: {} });
    typeInto(repositoryInput()!, 'acme/api');
    const post = await create();
    expect(post.body).toMatchObject({
      createTriggers: true,
      connector_ids: { 'Review pull requests': 'c1' },
      connector_params: { 'Review pull requests': { repository: 'acme/api' } },
    });
  });

  it('sends no parameters when none were filled in, or when the field was emptied again', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    await openForm();
    typeInto(repositoryInput()!, 'acme/api');
    typeInto(repositoryInput()!, '');
    const post = await create();
    expect(post.body).toHaveProperty('connector_ids');
    expect(post.body).not.toHaveProperty('connector_params');
  });

  it('asks for nothing until a connector is picked, and drops the parameters of a connector that was cleared', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)'), github('c2', 'GitHub (labs)')];
    await openForm();
    expect(paramsForms.renders).toHaveLength(0);
    expect(repositoryInput()).toBeNull();
    const post = await create();
    expect(post.body).not.toHaveProperty('connector_ids');
    expect(post.body).not.toHaveProperty('connector_params');
  });

  it('draws nothing of its own when the trigger has no parameters', async () => {
    paramsForms.hasParams = false;
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    await openForm();
    expect(text()).not.toContain('Settings for');
    const post = await create();
    expect(post.body).toMatchObject({ connector_ids: { 'Review pull requests': 'c1' } });
    expect(post.body).not.toHaveProperty('connector_params');
  });

  it('asks for no parameters without the Connectors module or with triggers switched off', async () => {
    catalog.available = false;
    await openForm();
    expect(paramsForms.renders).toHaveLength(0);
  });

  it('says which parameters a skipped trigger still needs, and that the trigger can be added from the agent', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    instantiateAnswer = skippedAnswer([{
      name: 'Review pull requests', reason: 'params_required', package: 'cognipeer.github',
      errors: [{ field: 'connector.params.repository', message: 'repository is required' }],
    }]);
    await openForm();
    await create();
    expect(text()).toContain('Triggers not created');
    expect(text()).toContain('Review pull requests needs a value for repository');
    expect(text()).toContain('Add the trigger from the agent\'s Triggers section and fill in what it needs.');
    // It is not a missing connector.
    expect(text()).not.toContain('needs a GitHub connector');
    expect(text()).not.toContain('Once there is a connector');
  });

  it('says what the package refused when the parameters were not valid', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    instantiateAnswer = skippedAnswer([{
      name: 'Review pull requests', reason: 'invalid_params', package: 'cognipeer.github',
      errors: [
        { field: 'connector.params.repository', message: 'repository is not a parameter of this trigger' },
        { field: 'connector.events', message: 'Not an event of this trigger: pull_request.nope' },
      ],
    }]);
    await openForm();
    await create();
    expect(text()).toContain('Review pull requests was refused: repository is not a parameter of this trigger; Not an event of this trigger: pull_request.nope');
    expect(text()).toContain('fill in what it needs');
  });

  it('keeps the connector wording for a missing connector, and shows both hints when the reasons are mixed', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    instantiateAnswer = skippedAnswer([
      { name: 'Triage failed builds', reason: 'connector_required', package: 'cognipeer.github' },
      { name: 'Review pull requests', reason: 'params_required', package: 'cognipeer.github', errors: [{ field: 'connector.params.repository', message: 'repository is required' }] },
    ]);
    await openForm();
    await create();
    expect(text()).toContain('Triage failed builds needs a GitHub connector');
    expect(text()).toContain('Review pull requests needs a value for repository');
    expect(text()).toContain('Once there is a connector');
    expect(text()).toContain('fill in what it needs');
  });

  it('copes with a params skip that names no parameter', async () => {
    catalog.connectors = [github('c1', 'GitHub (acme)')];
    instantiateAnswer = skippedAnswer([{ name: 'Review pull requests', reason: 'params_required', package: 'cognipeer.github' }]);
    await openForm();
    await create();
    expect(text()).toContain('Review pull requests needs a value for its connector settings');
  });
});

describe('the template detail', () => {
  it('describes a connector trigger and says it needs a connector of the project', async () => {
    mount(h(TemplateDetailDrawer, { templateKey: 'pr-reviewer', onClose: () => undefined, onUse: () => undefined }));
    await flush();
    expect(text()).toContain('Connector event · cognipeer.github · pull_request');
    expect(text()).toContain('pull_request.opened');
    expect(text()).toContain('Connector events listen to one of the project\'s connectors');
  });
});
