// @vitest-environment jsdom
/**
 * The "Add model" catalog in the Model Hub, rendered for real (jsdom):
 *
 * - the create form opened with a catalog pick: the pick survives the form's own open / provider effects (default
 *   category, provider list changes, tool-call clamp), the form is not "edited" until someone edits it, and its
 *   submit posts exactly the body the catalog's bulk "Add N models" posts for the same model;
 * - the Model ID suggestions list only the provider the form settles on (no listing of a provider that is about to
 *   be replaced), and "Back to catalog" asks before throwing edits away;
 * - the catalog overlay's states (rows, already added, unsupported, refused, failed request, no providers, notices),
 *   picking one model, and adding several with the create form's bodies;
 * - one listing per provider shared by every caller, and the Turkish twin of the messages.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { act, createElement as h, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { IntlMessageFormat } from 'intl-messageformat';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm/ConfirmProvider';
import CreateModelModal from '@/components/models/CreateModelModal';
import ModelCatalogModal, { type ModelCatalogModalProps } from '@/components/models/catalog/ModelCatalogModal';
import {
  noteCatalogModelsCreated,
  resetProviderModelCatalogCache,
  useProviderModelCatalog,
} from '@/components/models/catalog/useProviderModelCatalog';
import { catalogModelToCreatePayload, catalogModelToPrefill, type CreateModelPrefill } from '@/components/models/catalog/catalogPrefill';
import { modelCatalogEn } from '@/lib/i18n/messages/modelCatalog.en';
import { modelCatalogTr } from '@/lib/i18n/messages/modelCatalog.tr';
import type { CatalogModel, ProviderModelCatalog } from '@/lib/services/models/catalog/types';
import type { ModelProviderView } from '@/lib/services/models/types';
import { buttonByText, click, installDomStubs, setInput, wait } from '../helpers/iamCenterUi';

type Loose = ComponentType<{ locale?: string; children?: ReactNode; env?: string }>;
const Mantine = MantineProvider as unknown as Loose;
const I18n = I18nProvider as unknown as Loose;
const Confirm = ConfirmProvider as unknown as Loose;

const provider = (key: string, label: string, driver: string, capabilities: Record<string, unknown>, status = 'active') =>
  ({
    _id: key,
    tenantId: 't1',
    key,
    label,
    driver,
    type: 'model',
    status,
    settings: {},
    hasCredentials: true,
    createdBy: 'u1',
    driverCapabilities: capabilities,
  }) as unknown as ModelProviderView;

const openai = provider('openai-main', 'OpenAI', 'openai', {
  'model.categories': ['llm', 'embedding', 'stt'],
  'model.supports.tool_calls': true,
});
// An OpenAI-compatible server whose driver cannot call tools.
const local = provider('local', 'Local vLLM', 'openai-compatible', { 'model.categories': ['llm'] });
const retired = provider('retired', 'Retired', 'openai', { 'model.categories': ['llm'] }, 'disabled');

const entry = (overrides: Partial<CatalogModel> & Pick<CatalogModel, 'id'>): CatalogModel => ({
  name: overrides.id,
  category: 'llm',
  source: 'live',
  ...overrides,
});

const catalogOf = (target: ModelProviderView, models: CatalogModel[], extra: Partial<ProviderModelCatalog> = {}): ProviderModelCatalog => ({
  provider: { key: target.key, label: target.label, driver: target.driver, status: target.status },
  source: 'live',
  supported: true,
  models,
  fetchedAt: new Date().toISOString(),
  latencyMs: 120,
  ...extra,
});

let catalogs: Record<string, { status: number; body: unknown }>;
let posted: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const catalogCalls = (key: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === `/api/models/providers/${encodeURIComponent(key)}/catalog`).length;

beforeAll(() => {
  installDomStubs();
});

beforeEach(() => {
  resetProviderModelCatalogCache();
  catalogs = {};
  posted = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const match = path.match(/^\/api\/models\/providers\/([^/]+)\/catalog$/);
    if (match) {
      const found = catalogs[decodeURIComponent(match[1])];
      return found ? reply(found.status, found.body) : reply(404, { error: 'Provider not found' });
    }
    if (path === '/api/models' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      if (body.modelId === 'fails') return reply(429, { error: 'Model quota exceeded' });
      return reply(201, {
        model: {
          _id: `m${posted.length}`,
          key: String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          name: body.name,
          modelId: body.modelId,
          providerKey: body.providerKey,
          category: body.category,
          pricing: body.pricing,
          settings: body.settings,
        },
      });
    }
    return reply(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);
});

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function render(element: ReactNode, locale = 'en') {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(h(Mantine, { env: 'test' }, h(I18n, { locale }, h(Confirm, null, element))));
  });
  await wait(0);
  await wait(0);
}

const inputs = () => [...document.body.querySelectorAll<HTMLInputElement>('input')];
const inputWithValue = (value: string) => inputs().find((input) => input.value === value);
const text = () => document.body.textContent ?? '';

describe('the create form opened with a catalog pick', () => {
  const pick = entry({
    id: 'my-custom-model',
    name: 'Custom model',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    inputModalities: ['text', 'image'],
    supportsReasoning: false,
    supportsToolCalls: true,
    pricing: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0.3, source: 'provider' },
  });

  function form(props: { opened: boolean; prefill?: CreateModelPrefill | null; providers?: ModelProviderView[]; onBackToCatalog?: (key?: string) => void }) {
    return h(CreateModelModal, {
      opened: props.opened,
      onClose: () => undefined,
      providers: props.providers ?? [local, openai],
      // The list was filtered to embeddings: the pick's category must still win.
      defaultCategory: 'embedding',
      onCreated: () => undefined,
      prefill: props.prefill,
      onBackToCatalog: props.onBackToCatalog,
    });
  }

  async function openWith(prefill: CreateModelPrefill, extra: { onBackToCatalog?: (key?: string) => void } = {}) {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [pick, entry({ id: 'text-embedding-3-small', category: 'embedding' })]) };
    catalogs[local.key] = { status: 200, body: catalogOf(local, [entry({ id: 'qwen2.5-72b-instruct' })]) };
    // Closed first, then opened with the pick in the same update, as the page does.
    await render(form({ opened: false, ...extra }));
    await render(form({ opened: true, prefill, ...extra }));
  }

  async function submit() {
    await click(buttonByText('Create model'));
    await wait(0);
    expect(posted).toHaveLength(1);
    return posted[0];
  }

  it('shows the pick and posts exactly the body "Add N models" posts for it', async () => {
    await openWith(catalogModelToPrefill(pick, openai.key));
    expect(inputWithValue('my-custom-model')).toBeDefined();
    expect(inputWithValue('Custom model')).toBeDefined();
    const body = await submit();
    const expected = catalogModelToCreatePayload(pick, openai).body;
    expect(body).toEqual(expected);
    // Same fields in the same order: the bulk path is the form's submit, not a look-alike.
    expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
    expect(body.category).toBe('llm');
    expect(body.providerKey).toBe('openai-main');
  });

  it('keeps the provider\'s tool-call clamp over the pick', async () => {
    const onLocal = entry({ id: 'qwen2.5-72b-instruct', supportsToolCalls: true });
    await openWith(catalogModelToPrefill(onLocal, local.key));
    const body = await submit();
    expect(body.supportsToolCalls).toBe(false);
    expect(body).toEqual(catalogModelToCreatePayload(onLocal, local).body);
  });

  it('keeps the pick when the provider list changes while the form is open', async () => {
    const prefill = catalogModelToPrefill(pick, openai.key);
    await openWith(prefill);
    // The page reloads its providers (new array): the open effect runs again with the default category.
    await render(form({ opened: true, prefill, providers: [{ ...local }, { ...openai }] }));
    const body = await submit();
    expect(body.category).toBe('llm');
    expect(body.modelId).toBe('my-custom-model');
  });

  it('lists only the provider the form settles on for the Model ID suggestions', async () => {
    await openWith(catalogModelToPrefill(pick, openai.key));
    expect(catalogCalls(openai.key)).toBe(1);
    // `local` is first in the list (the form's value before the pick lands): it is never listed.
    expect(catalogCalls(local.key)).toBe(0);
  });

  it('is not "edited" until someone edits it, and asks before going back to the catalog with edits', async () => {
    const onBack = vi.fn();
    await openWith(catalogModelToPrefill(pick, openai.key), { onBackToCatalog: onBack });
    expect(document.body.querySelector('[data-testid="model-form-dirty"]')).toBeNull();

    await click(buttonByText('Back to catalog'));
    expect(onBack).toHaveBeenCalledWith('openai-main');

    await setInput(inputWithValue('Custom model')!, 'Custom model (EU)');
    expect(document.body.querySelector('[data-testid="model-form-dirty"]')).not.toBeNull();
    await click(buttonByText('Back to catalog'));
    expect(text()).toContain('Discard unsaved changes?');
    expect(onBack).toHaveBeenCalledTimes(1);
    await click(buttonByText('Discard'));
    await wait(0);
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});

describe('ModelCatalogModal', () => {
  const gpt = entry({
    id: 'gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128_000,
    inputModalities: ['text', 'image'],
    supportsToolCalls: true,
    pricing: { currency: 'USD', inputTokenPer1M: 2.5, outputTokenPer1M: 10, source: 'reference', confidence: 'exact', catalogKey: 'gpt-4o' },
  });
  const mini = entry({ id: 'gpt-4o-mini', name: 'GPT-4o mini' });
  const embedding = entry({
    id: 'text-embedding-3-small',
    category: 'embedding',
    pricing: { currency: 'USD', inputTokenPer1M: 0.02, outputTokenPer1M: 0, source: 'reference', confidence: 'fuzzy', catalogKey: 'text-embedding-3' },
  });
  const whisper = entry({ id: 'whisper-1', category: 'stt', registeredModelKeys: ['whisper'] });

  function catalogModal(props: Partial<ModelCatalogModalProps> = {}) {
    return h(ModelCatalogModal, {
      opened: true,
      onClose: vi.fn(),
      providers: [retired, openai],
      onSelectModel: vi.fn(),
      onCustom: vi.fn(),
      onModelsCreated: vi.fn(),
      ...props,
    });
  }

  const rowBoxes = () => [...document.body.querySelectorAll<HTMLInputElement>('li input.ds-checkbox')];
  const box = (name: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`);

  it('lists the first active provider\'s models with their facts, and marks the ones already added', async () => {
    catalogs[openai.key] = {
      status: 200,
      body: catalogOf(openai, [gpt, mini, embedding, whisper], { notices: [{ code: 'excluded_unsupported', count: 3 }] }),
    };
    await render(catalogModal());
    expect(catalogCalls(openai.key)).toBe(1);
    expect(catalogCalls(retired.key)).toBe(0);
    expect(text()).toContain('Live from OpenAI');
    expect(rowBoxes()).toHaveLength(4);
    expect(text()).toContain('128K ctx');
    expect(text()).toContain('$2.50 / $10.00 per 1M');
    // A fuzzy reference match is shown as approximate.
    expect(text()).toContain('≈ $0.02 / $0 per 1M');
    expect(text()).toContain('3 listed models were left out');
    expect(box('whisper-1')!.disabled).toBe(true);
    expect(text()).toContain('Added');
  });

  it('opens on the list\'s category when it has models of it, else on All', async () => {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [gpt, mini, embedding, whisper]) };
    await render(catalogModal({ defaultCategory: 'embedding' }));
    expect(rowBoxes()).toHaveLength(1);
    expect(document.body.querySelector('.form-chip.selected')?.textContent).toBe('Embedding · 1');
    await render(catalogModal({ opened: false }));
    await render(catalogModal({ defaultCategory: 'rerank' }));
    expect(rowBoxes()).toHaveLength(4);
    expect(document.body.querySelector('.form-chip.selected')?.textContent).toBe('All · 4');
  });

  it('searches the list', async () => {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [gpt, mini, embedding, whisper]) };
    await render(catalogModal());
    await setInput(document.body.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!, 'mini');
    expect(rowBoxes()).toHaveLength(1);
    await setInput(document.body.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!, 'nothing like this');
    expect(text()).toContain('No models match');
  });

  it('opens the create form filled in with one model (Configure, or Continue with one selected)', async () => {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [gpt, mini]) };
    const onSelectModel = vi.fn();
    await render(catalogModal({ onSelectModel }));
    const configure = [...document.body.querySelectorAll('button')].filter((button) => button.textContent === 'Configure');
    await click(configure[0]);
    expect(onSelectModel).toHaveBeenLastCalledWith(catalogModelToPrefill(gpt, openai.key));
    // The Configure click did not also pick the row.
    expect(box('GPT-4o')!.checked).toBe(false);

    await click(box('GPT-4o mini'));
    await click(buttonByText('Continue'));
    expect(onSelectModel).toHaveBeenLastCalledWith(catalogModelToPrefill(mini, openai.key));
  });

  it('adds several models with the create form\'s bodies, after saying how many have no price', async () => {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [gpt, mini, embedding]) };
    const onModelsCreated = vi.fn();
    const onClose = vi.fn();
    await render(catalogModal({ onModelsCreated, onClose }));
    await click(box('GPT-4o'));
    await click(box('GPT-4o mini'));
    await click(box('text-embedding-3-small'));
    await click(buttonByText('Add 3 models'));
    // gpt-4o mini has no price; the embedding's fuzzy match is not trusted either.
    expect(text()).toContain('2 of them have no known price');
    await click(buttonByText('Add models'));
    await wait(0);
    expect(posted).toEqual([gpt, mini, embedding].map((model) => catalogModelToCreatePayload(model, openai).body));
    expect(onModelsCreated).toHaveBeenCalledTimes(1);
    expect(onModelsCreated.mock.calls[0][0]).toHaveLength(3);
    expect(onModelsCreated.mock.calls[0][1]).toBe(openai);
    expect(onClose).toHaveBeenCalled();
  });

  it('reports the models that could not be added and keeps the ones that were', async () => {
    const failing = entry({ id: 'fails', name: 'Fails' });
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [gpt, failing]) };
    const onModelsCreated = vi.fn();
    await render(catalogModal({ onModelsCreated }));
    await click(box('GPT-4o'));
    await click(box('Fails'));
    await click(buttonByText('Add 2 models'));
    await click(buttonByText('Add models'));
    await wait(0);
    expect(posted).toHaveLength(2);
    expect(onModelsCreated.mock.calls[0][0]).toHaveLength(1);
  });

  it('goes to custom entry when the provider has no model list', async () => {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [], { supported: false, source: 'none' }) };
    const onCustom = vi.fn();
    await render(catalogModal({ onCustom }));
    expect(text()).toContain('This provider has no model list');
    await click(buttonByText('Enter a model manually'));
    expect(onCustom).toHaveBeenCalledWith('openai-main');
  });

  it('explains a listing the provider refused, with the scrubbed detail', async () => {
    catalogs[openai.key] = {
      status: 200,
      body: catalogOf(openai, [], { error: { code: 'auth_failed', message: 'Incorrect API key provided', status: 401 } }),
    };
    await render(catalogModal());
    expect(text()).toContain('The provider refused the credentials');
    expect(text()).toContain('HTTP 401 · Incorrect API key provided');
    expect(buttonByText('Try again')).toBeDefined();
  });

  it('says when the request itself failed, and lists again on "Try again"', async () => {
    catalogs[openai.key] = { status: 500, body: { error: 'Internal server error' } };
    await render(catalogModal());
    expect(text()).toContain('The model list could not be loaded');
    expect(text()).toContain('Internal server error');
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [gpt]) };
    await click(buttonByText('Try again'));
    await wait(0);
    expect(catalogCalls(openai.key)).toBe(2);
    expect(rowBoxes()).toHaveLength(1);
  });

  it('offers to add a provider when the project has none', async () => {
    const onAddProvider = vi.fn();
    await render(catalogModal({ providers: [], onAddProvider }));
    expect(text()).toContain('No model providers in this project');
    await click(buttonByText('Add provider'));
    expect(onAddProvider).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('speaks Turkish', async () => {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [gpt]) };
    await render(catalogModal(), 'tr');
    expect(text()).toContain('Model ekle');
    expect(text()).toContain('Özel model gir');
  });
});

describe('useProviderModelCatalog', () => {
  let seen: Array<ReturnType<typeof useProviderModelCatalog>>;
  function Probe({ providerKey, slot }: { providerKey?: string; slot: number }) {
    seen[slot] = useProviderModelCatalog(providerKey);
    return null;
  }

  beforeEach(() => {
    seen = [];
  });

  it('makes one request per provider for every caller, lists again on refresh, and follows models created meanwhile', async () => {
    catalogs[openai.key] = { status: 200, body: catalogOf(openai, [entry({ id: 'gpt-4o' })]) };
    await render(h('div', null, h(Probe, { providerKey: openai.key, slot: 0 }), h(Probe, { providerKey: openai.key, slot: 1 })));
    expect(catalogCalls(openai.key)).toBe(1);
    expect(seen[0].data?.models).toHaveLength(1);
    expect(seen[1].data).toBe(seen[0].data);

    await act(async () => seen[0].refresh());
    await wait(0);
    expect(catalogCalls(openai.key)).toBe(2);

    await act(async () => noteCatalogModelsCreated(openai.key, [{ modelId: 'gpt-4o', key: 'gpt-4o-2' }]));
    expect(seen[1].data?.models[0].registeredModelKeys).toEqual(['gpt-4o-2']);
  });

  it('stays idle without a provider and reports a failed request', async () => {
    await render(h(Probe, { slot: 0 }));
    expect(seen[0]).toMatchObject({ loading: false, refreshing: false, data: undefined });
    expect(fetchMock).not.toHaveBeenCalled();

    await render(h(Probe, { providerKey: 'missing', slot: 0 }));
    expect(seen[0].error).toBe('Provider not found');
    expect(seen[0].loading).toBe(false);
  });
});

describe('modelCatalog messages', () => {
  type Tree = { [key: string]: string | Tree };
  const flatten = (tree: Tree, prefix = ''): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(tree)) {
      const full = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') out.set(full, value);
      else for (const [k, v] of flatten(value, full)) out.set(k, v);
    }
    return out;
  };
  const en = flatten(modelCatalogEn as unknown as Tree);
  const tr = flatten(modelCatalogTr as unknown as Tree);
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('has the same keys and placeholders in English and Turkish, and is valid ICU', () => {
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, value] of en) {
      expect(placeholders(tr.get(key) ?? ''), key).toEqual(placeholders(value));
      expect(() => new IntlMessageFormat(value, 'en'), `en: ${key}`).not.toThrow();
      expect(() => new IntlMessageFormat(tr.get(key) ?? '', 'tr'), `tr: ${key}`).not.toThrow();
    }
  });

  it('is translated (only names and bare placeholders read the same)', () => {
    const SAME = /^(LLM|Embedding|OCR|\{label\} · \{count\}|HTTP \{status\}|\{ms\} ms)$/;
    expect([...en].filter(([key, value]) => tr.get(key) === value && !SAME.test(value)).map(([key]) => key)).toEqual([]);
  });

  it('has a message for every listing error and notice code the server sends', () => {
    for (const code of ['auth_failed', 'unreachable', 'timeout', 'upstream_error', 'endpoint_not_allowed', 'credentials_unavailable', 'invalid_settings']) {
      expect(en.has(`errors.${code}.title`), code).toBe(true);
      expect(en.has(`errors.${code}.hint`), code).toBe(true);
    }
    for (const code of ['pricing_reference_unavailable', 'azure_deployments_unlisted', 'excluded_unsupported', 'truncated', 'reference_listing', 'static_listing', 'listing_fallback']) {
      expect(en.has(`notices.${code}`), code).toBe(true);
    }
  });
});
