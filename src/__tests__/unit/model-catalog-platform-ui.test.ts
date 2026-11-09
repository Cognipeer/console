// @vitest-environment jsdom
/**
 * Platform providers in "Add model" (jsdom, same harness style as model-catalog-ui.test.ts):
 * the "Not in this project" group, the catalog of a platform provider (locked while it is not in the project; once it is,
 * selectable rows, "Added" locked rows, Unavailable disabled rows, credits, "Add N models", no Configure),
 * "Use in this project" for owners and admins (exactly `{ projectIds }` to the tenant-scoped provider route), the note
 * for everyone else, the info line when assigned, and the create form never offering a platform provider.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { act, createElement as h, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm/ConfirmProvider';
import { DashboardUserProvider } from '@/components/layout/DashboardUserContext';
import CreateModelModal from '@/components/models/CreateModelModal';
import ModelCatalogModal, { type ModelCatalogModalProps } from '@/components/models/catalog/ModelCatalogModal';
import { resetProviderModelCatalogCache } from '@/components/models/catalog/useProviderModelCatalog';
import {
  isPlatformCatalog,
  mergeProjectIds,
  platformCatalogToModels,
  withoutPlatformProviders,
  type PlatformCatalogData,
  type PlatformProviderView,
} from '@/components/models/catalog/platformProviders';
import type { ModelProviderView } from '@/lib/services/models/types';
import { buttonByText, click, installDomStubs, wait } from '../helpers/iamCenterUi';

type Loose = ComponentType<{ locale?: string; children?: ReactNode; env?: string }>;
const Mantine = MantineProvider as unknown as Loose;
const I18n = I18nProvider as unknown as Loose;
const Confirm = ConfirmProvider as unknown as Loose;

const base = (key: string, label: string, extra: Record<string, unknown> = {}) =>
  ({
    _id: key,
    tenantId: 't1',
    key,
    label,
    driver: 'openai',
    type: 'model',
    status: 'active',
    settings: {},
    hasCredentials: true,
    createdBy: 'u1',
    driverCapabilities: { 'model.categories': ['llm'] },
    ...extra,
  }) as unknown as ModelProviderView;

const openai = base('openai-main', 'OpenAI');
const hosted = base('hosted', 'Hosted models', { _id: 'prov-hosted', platform: true, projectIds: ['p-default'], assigned: false }) as unknown as PlatformProviderView;
const hostedAssigned = { ...hosted, assigned: true } as PlatformProviderView;

const platformCatalog = (assigned: boolean): PlatformCatalogData => ({
  platform: true,
  assigned,
  models: [
    { key: 'fast', name: 'Fast model', category: 'llm', unavailable: false, added: false, credits: { perCall: 1, perMillionTokens: 2 } },
    { key: 'big', name: 'Big model', category: 'llm', description: 'Large', unavailable: true, added: false },
    { key: 'mine', name: 'Added model', category: 'llm', unavailable: false, added: true, capabilities: { contextWindow: 128000, supportsToolCalls: true } },
  ],
});

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock: ReturnType<typeof vi.fn>;
let hostedCatalog: PlatformCatalogData;
let routeOptions: { fresh?: string[]; listFails?: boolean; patchStatus?: number };

const catalogCalls = (key: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === `/api/models/providers/${encodeURIComponent(key)}/catalog`).length;
const patches = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH') as Array<[string, RequestInit]>;

beforeAll(() => {
  installDomStubs();
});

beforeEach(() => {
  resetProviderModelCatalogCache();
  hostedCatalog = platformCatalog(false);
  routeOptions = {};
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/models/providers/hosted/catalog') return reply(200, hostedCatalog);
    if (path === '/api/projects') return reply(200, { projects: [], activeProjectId: 'p-active' });
    if (path === '/api/providers?scope=tenant' && !init?.method) {
      return routeOptions.listFails
        ? reply(500, { error: 'down' })
        : reply(200, { providers: [{ _id: 'prov-hosted', key: 'hosted', projectIds: routeOptions.fresh ?? ['p-default'] }] });
    }
    if (path === '/api/providers/prov-hosted?scope=tenant' && init?.method === 'PATCH') {
      return routeOptions.patchStatus ? reply(routeOptions.patchStatus, { error: 'Not allowed' }) : reply(200, {});
    }
    if (path.endsWith('/catalog')) {
      return reply(200, {
        provider: { key: openai.key, label: openai.label, driver: 'openai', status: 'active' },
        source: 'live',
        supported: true,
        models: [],
        fetchedAt: new Date().toISOString(),
        latencyMs: 1,
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

const text = () => document.body.textContent ?? '';

function modal(props: Partial<ModelCatalogModalProps> = {}, role?: 'owner' | 'admin' | 'user') {
  const element = h(ModelCatalogModal, {
    opened: true,
    onClose: vi.fn(),
    providers: [openai],
    platformProviders: [hosted],
    onSelectModel: vi.fn(),
    onCustom: vi.fn(),
    onModelsCreated: vi.fn(),
    ...props,
  });
  return role
    ? h(DashboardUserProvider, { value: { name: 'Ada', email: 'a@example.com', licenseType: 'pro', role }, children: element })
    : element;
}

/** Opens the provider picker and picks the option with this label. */
async function pickProvider(label: string) {
  await click(document.body.querySelector('input[aria-label="Provider"], input[aria-label="Sağlayıcı"]'));
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.includes(label));
  await click(option);
  await wait(0);
}

describe('ModelCatalogModal with platform providers', () => {
  it('lists the platform providers that are not in the project as their own group, next to the assigned ones', async () => {
    await render(modal());
    await click(document.body.querySelector('input[aria-label="Provider"]'));
    expect(text()).toContain('Not in this project');
    expect(text()).toContain('Hosted models');
    expect(text()).toContain('OpenAI');
  });

  it('shows the catalog of a provider that is not in the project locked: nothing can be picked or added yet', async () => {
    await render(modal({ providers: [] }));
    await pickProvider('Hosted models');
    expect(catalogCalls('hosted')).toBe(1);
    expect(text()).toContain('Fast model');
    expect(text()).toContain('Big model');
    expect(text().match(/Unavailable/g)).toHaveLength(1);
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('li input.ds-checkbox')];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.disabled)).toBe(true);
    expect(buttonByText('Configure')).toBeUndefined();
    expect(buttonByText('Enter custom model')).toBeUndefined();
    expect(buttonByText(/^Add \d+ models$/)).toBeUndefined();
    // The side panel says where the models come from and whether they are here, not an API listing or a selection.
    expect(text()).toContain('Managed by the platform');
    expect(text()).toContain('Availability');
    expect(text()).not.toContain('Nothing selected yet.');
  });

  it('lets an owner or admin use the provider in this project: exactly the project ids, then lists and reloads', async () => {
    routeOptions = { fresh: ['p-default', 'p-other'] };
    const onProviderAssigned = vi.fn();
    await render(modal({ providers: [], onProviderAssigned }, 'admin'));
    await pickProvider('Hosted models');
    hostedCatalog = platformCatalog(true);
    await click(buttonByText('Use in this project'));
    await wait(0);
    await wait(0);
    expect(patches()).toHaveLength(1);
    expect(patches()[0][0]).toBe('/api/providers/prov-hosted?scope=tenant');
    expect(JSON.parse(String(patches()[0][1].body))).toEqual({ projectIds: ['p-default', 'p-other', 'p-active'] });
    expect(onProviderAssigned).toHaveBeenCalledTimes(1);
    expect(catalogCalls('hosted')).toBe(2);
    expect(text()).toContain('This provider is available in this project');
  });

  it('falls back to the list at hand when the fresh read fails, keeping a legacy single project id', async () => {
    routeOptions = { listFails: true };
    const legacy = { ...hosted, projectId: 'p-legacy', projectIds: undefined } as unknown as PlatformProviderView;
    await render(modal({ providers: [], platformProviders: [legacy] }, 'owner'));
    await pickProvider('Hosted models');
    await click(buttonByText('Use in this project'));
    await wait(0);
    await wait(0);
    expect(JSON.parse(String(patches()[0][1].body))).toEqual({ projectIds: ['p-legacy', 'p-active'] });
  });

  it('reports a refused assignment, does not reload the page and enables the button again', async () => {
    routeOptions = { patchStatus: 403 };
    const onProviderAssigned = vi.fn();
    await render(modal({ providers: [], onProviderAssigned }, 'admin'));
    await pickProvider('Hosted models');
    await click(buttonByText('Use in this project'));
    await wait(0);
    await wait(0);
    expect(onProviderAssigned).not.toHaveBeenCalled();
    expect(buttonByText('Use in this project')!.disabled).toBe(false);
  });

  it('asks a member to get an owner or admin, with no assign button', async () => {
    await render(modal({ providers: [] }, 'user'));
    await pickProvider('Hosted models');
    expect(text()).toContain('Ask an owner or admin to add this provider to the project');
    expect(buttonByText('Use in this project')).toBeUndefined();
  });

  it('lists an assigned provider like any catalog: selectable rows, Added locked, Unavailable disabled, credits, no Configure', async () => {
    hostedCatalog = platformCatalog(true);
    await render(modal({ providers: [hostedAssigned as unknown as ModelProviderView], platformProviders: [hostedAssigned] }, 'admin'));
    await pickProvider('Hosted models');
    expect(text()).toContain('This provider is available in this project');
    expect(buttonByText('Use in this project')).toBeUndefined();
    expect(buttonByText('Configure')).toBeUndefined();
    expect(buttonByText('Enter custom model')).toBeUndefined();
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('li input.ds-checkbox')];
    expect(boxes.map((box) => box.disabled)).toEqual([false, true, true]);
    expect(text()).toContain('Added');
    expect(text()).toContain('1 credit / call');
    expect(text()).toContain('2 credits / 1M tokens');
    expect(text()).toContain('Nothing selected yet.');
  });

  it('adds the picked platform models with one request, then refreshes the list', async () => {
    hostedCatalog = platformCatalog(true);
    const onProviderAssigned = vi.fn();
    await render(modal({ providers: [hostedAssigned as unknown as ModelProviderView], platformProviders: [hostedAssigned], onProviderAssigned }, 'admin'));
    await pickProvider('Hosted models');
    await click(document.body.querySelector('li input.ds-checkbox'));
    expect(buttonByText('Add 1 model')).toBeDefined();
    fetchMock.mockImplementationOnce(async () => reply(200, {}));
    await click(buttonByText('Add 1 model'));
    await wait(0);
    await wait(0);
    const adds = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/models/platform/add') as Array<[string, RequestInit]>;
    expect(adds).toHaveLength(1);
    expect(adds[0][1].method).toBe('POST');
    expect(JSON.parse(String(adds[0][1].body))).toEqual({ keys: ['fast'] });
    expect(onProviderAssigned).toHaveBeenCalledTimes(1);
  });

  it('speaks Turkish', async () => {
    await render(modal({ providers: [] }, 'admin'), 'tr');
    await pickProvider('Hosted models');
    expect(text()).toContain('Bu projede kullan');
    expect(text()).toContain('Kullanılamıyor');
  });
});

describe('CreateModelModal with platform providers', () => {
  it('never offers a platform provider, nor defaults to one', async () => {
    const platformOne = { ...hosted } as unknown as ModelProviderView;
    await render(h(CreateModelModal, { opened: true, onClose: () => undefined, providers: [platformOne, openai], onCreated: () => undefined }));
    await click(document.body.querySelector('input[placeholder="Select a model provider"]'));
    const labels = [...document.body.querySelectorAll('[role="option"]')].map((node) => node.textContent ?? '');
    expect(labels.some((label) => label.includes('OpenAI'))).toBe(true);
    expect(labels.some((label) => label.includes('Hosted models'))).toBe(false);
    expect(catalogCalls('hosted')).toBe(0);
  });

  it('shows the empty state when only platform providers exist', async () => {
    await render(h(CreateModelModal, { opened: true, onClose: () => undefined, providers: [hosted as unknown as ModelProviderView], onCreated: () => undefined }));
    expect(text()).toContain('No model providers are available in this project yet');
  });
});

describe('platform provider helpers', () => {
  it('merges the project id into the current ones without duplicates, keeping a legacy single id', () => {
    expect(mergeProjectIds({ projectIds: ['a', 'b'] }, 'c')).toEqual(['a', 'b', 'c']);
    expect(mergeProjectIds({ projectIds: ['a', 'b'] }, 'a')).toEqual(['a', 'b']);
    expect(mergeProjectIds({ projectId: 'legacy' }, 'c')).toEqual(['legacy', 'c']);
    expect(mergeProjectIds({ projectId: 'a', projectIds: ['a', 'b'] }, 'c')).toEqual(['a', 'b', 'c']);
    expect(mergeProjectIds({}, 'c')).toEqual(['c']);
  });

  it('turns a platform catalog into rows: key as id, added as registered, unavailable and credits carried', () => {
    const rows = platformCatalogToModels(platformCatalog(true));
    expect(rows.map((row) => row.id)).toEqual(['fast', 'big', 'mine']);
    expect(rows.map((row) => row.registeredModelKeys)).toEqual([undefined, undefined, ['mine']]);
    expect(rows.map((row) => row.unavailable)).toEqual([false, true, false]);
    expect(rows[0].credits).toEqual({ perCall: 1, perMillionTokens: 2 });
    expect(rows[2]).toMatchObject({ contextWindow: 128000, supportsToolCalls: true });
  });

  it('filters platform providers and recognises a platform catalog', () => {
    expect(withoutPlatformProviders([{ key: 'a' }, { key: 'b', platform: true }, { key: 'c', platform: false }]).map((p) => p.key)).toEqual(['a', 'c']);
    expect(isPlatformCatalog({ platform: true, assigned: false, models: [] })).toBe(true);
    expect(isPlatformCatalog({ models: [] })).toBe(false);
    expect(isPlatformCatalog(null)).toBe(false);
  });
});
