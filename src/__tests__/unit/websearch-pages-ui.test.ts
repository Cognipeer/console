// @vitest-environment jsdom
/**
 * The Web Search pages on instances (the real pages and forms, a mocked API): the list shows the instances and the
 * providers no instance uses yet, owners and admins create and edit instances and nobody else does, an instance on a
 * platform provider gets the hosted search options, an edit keeps the AI answer and the cache, and a platform
 * instance is searched and inspected but never changed.
 */
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  wait,
  type ApiMock,
  type Mounted,
  type RouteHandler,
} from '../helpers/iamCenterUi';
import { DashboardUserProvider, type DashboardUser } from '@/components/layout/DashboardUserContext';
import WebSearchListPage from '@/app/dashboard/websearch/page';
import WebSearchInstancePage from '@/app/dashboard/websearch/[key]/page';
import type { ProviderFormSchema } from '@/lib/providers/types';

const nav = vi.hoisted(() => ({
  key: 'docs',
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => nav.router,
  usePathname: () => '/dashboard/websearch',
  useParams: () => ({ key: nav.key }),
}));

let mounted: Mounted | undefined;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.router.push.mockReset();
  // A form logs a refusal it shows, and a section whose read is not mocked logs its failure.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const OWNER: DashboardUser = { name: 'Owner', email: 'owner@example.com', licenseType: 'test', role: 'owner' };
const MEMBER: DashboardUser = { ...OWNER, role: 'user' };

const SEARX = { key: 'searx', label: 'Searx', driver: 'searxng', status: 'active', platform: false };
const HOSTED = { key: 'hosted', label: 'Hosted search', driver: 'hosted-search', status: 'active', platform: true };
const DOCS_SETTINGS = { engines: 'a', aiAnswer: { enabled: true, modelKey: 'm1' }, cache: { enabled: false } };

const DOCS_ROW = {
  _id: 'i-docs', key: 'docs', kind: 'instance', label: 'Docs search', driver: 'searxng', status: 'active',
  settings: DOCS_SETTINGS, platform: false, tenantWide: false, providerKey: 'searx', provider: SEARX,
};
const PLATFORM_ROW = {
  _id: 'i-web', key: 'web', kind: 'instance', label: 'Web', driver: 'hosted-search', status: 'active',
  settings: {}, platform: true, tenantWide: true, providerKey: 'hosted', provider: HOSTED,
};
/** The compatible list keeps a provider row while no instance has its key: `searx` has an instance under another. */
const PROVIDER_ROWS = [
  { _id: 'p-searx', ...SEARX, kind: 'provider', legacy: true },
  { _id: 'p-new', key: 'new-conn', label: 'New connection', driver: 'searxng', status: 'active', platform: false, kind: 'provider', legacy: true },
];

const DOCS_VIEW = {
  _id: 'i-docs', key: 'docs', name: 'Docs search', providerKey: 'searx', projectId: 'p1', status: 'active',
  settings: DOCS_SETTINGS, platform: false, tenantWide: false, provider: SEARX,
};
const PLATFORM_VIEW = {
  _id: 'i-web', key: 'web', name: 'Web', providerKey: 'hosted', projectId: null, status: 'active',
  settings: {}, platform: true, tenantWide: true, provider: HOSTED,
};

/** The driver form of the searxng driver: the endpoint is the provider's, the rest an instance's. */
const SEARX_FORM: ProviderFormSchema = {
  sections: [
    { title: 'Connection', fields: [{ name: 'baseUrl', label: 'Base URL', type: 'text', scope: 'settings', settingsTarget: 'connection' }] },
    {
      title: 'Search',
      fields: [
        { name: 'engines', label: 'Engines', type: 'text', scope: 'settings', settingsTarget: 'behavior' },
        { name: 'language', label: 'Language', type: 'text', scope: 'settings', settingsTarget: 'behavior' },
      ],
    },
  ],
};

function installApi(extra: Array<[string, string | RegExp, RouteHandler]> = []) {
  api = installApiMock([
    ['GET', '/api/websearch/providers', () => ({ providers: [DOCS_ROW, PLATFORM_ROW, ...PROVIDER_ROWS] })],
    ['GET', '/api/websearch/providers/drivers', () => ({ drivers: [{ id: 'searxng', version: '1.0.0', domains: ['websearch'], display: { label: 'SearxNG' } }] })],
    ['GET', /^\/api\/providers\/drivers\/[^/]+\/form$/, () => ({ schema: SEARX_FORM })],
    ['GET', '/api/providers', () => ({
      providers: [{ _id: 'p-searx', ...SEARX }, { _id: 'p-hosted', ...HOSTED }, PROVIDER_ROWS[1]],
    })],
    ['GET', '/api/projects', () => ({ projects: [], activeProjectId: 'p1' })],
    ['GET', '/api/models', () => ({ models: [{ key: 'm1', name: 'Model one' }] })],
    ['GET', '/api/vector/providers', () => ({ providers: [] })],
    ...extra,
  ]);
}

async function render(page: () => ReactElement | null, user: DashboardUser = OWNER) {
  mounted = await mount(createElement(DashboardUserProvider as never, { value: user } as never, createElement(page)));
  await settle(150);
}

const overlay = () => q('.form-overlay')!;
const labelOf = (el: Element) =>
  el.querySelector('.form-field-label > span')?.textContent?.replace(' · optional', '').replace(/\s*\*$/, '').trim() ?? '';
const formField = (label: string) => qa('.form-field', overlay()).find((candidate) => labelOf(candidate) === label);
const inputOf = (label: string) => formField(label)?.querySelector<HTMLInputElement>('input') ?? null;
const fieldLabels = () => qa('.form-field', overlay()).map(labelOf);

async function choose(label: string, option: RegExp) {
  await click(inputOf(label));
  await wait(30);
  await click(qa('[role="option"]').find((candidate) => option.test(candidate.textContent ?? '')));
  await settle(120);
}

const actionsButton = (rowLabel: string) =>
  qa('tr').find((row) => row.textContent?.includes(rowLabel))?.querySelector('button[aria-label="Actions"]');
const menuItems = () => qa('[role="menuitem"]');

/** The actions a row's menu offers (the menu is closed again). */
async function menuOf(rowLabel: string): Promise<string[]> {
  await click(actionsButton(rowLabel));
  await wait(30);
  const items = menuItems().map((item) => item.textContent?.trim() ?? '');
  await click(actionsButton(rowLabel));
  await wait(30);
  return items;
}

async function rowAction(rowLabel: string, action: string) {
  await click(actionsButton(rowLabel));
  await wait(30);
  await click(menuItems().find((item) => item.textContent?.trim() === action));
  await settle(150);
}

describe('the Web Search list', () => {
  it('lists the instances, then the providers no instance uses yet, with the platform marker', async () => {
    installApi();
    await render(WebSearchListPage);

    expect(text()).toContain('Docs search');
    expect(text()).toContain('New connection');
    expect(text()).toContain('Managed by the platform');
    // `searx` is used by "Docs search": it is not offered as a provider without an instance.
    const noInstance = qa('.ds-badge').filter((badge) => badge.textContent === 'No instance yet');
    expect(noInstance).toHaveLength(1);
    expect(noInstance[0].closest('tr')?.textContent).toContain('new-conn');
    expect(buttonByText('Create instance')).toBeTruthy();
  });

  it('gives an owner the actions each row allows', async () => {
    installApi();
    await render(WebSearchListPage);

    expect(await menuOf('Docs search')).toEqual(['Open', 'Edit', 'Delete']);
    expect(await menuOf('New connection')).toEqual(['Open', 'Create instance']);
  });

  it('keeps a platform instance to opening it', async () => {
    installApi();
    await render(WebSearchListPage);
    expect(await menuOf('Hosted search')).toEqual(['Open']);
  });

  it('offers a member no create, edit or delete', async () => {
    installApi();
    await render(WebSearchListPage, MEMBER);

    expect(buttonByText('Create instance')).toBeUndefined();
    expect(await menuOf('Docs search')).toEqual(['Open']);
  });

  it('tells a role without web search access so, instead of an empty list that offers to create', async () => {
    api = installApiMock([
      ['GET', '/api/websearch/providers', () => new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })],
    ]);
    await render(WebSearchListPage, MEMBER);

    expect(text()).toContain('Web search is not open to your role');
    expect(text()).not.toContain('No web search instances yet');
    expect(buttonByText('Create instance')).toBeUndefined();
  });
});

describe('creating an instance', () => {
  it('on a platform provider: the hosted search options, the key from the name, the instance in this project', async () => {
    installApi([
      ['POST', '/api/websearch/instances', ({ body }) => jsonResponse({
        instance: { ...PLATFORM_VIEW, ...(body as object), platform: false, provider: HOSTED },
      }, 201)],
    ]);
    await render(WebSearchListPage);
    await click(buttonByText('Create instance'));
    await settle(150);

    await choose('Provider', /^Hosted search/);
    expect(fieldLabels()).toEqual(expect.arrayContaining(['Search Depth', 'Language', 'Country', 'Safe Search']));
    await setInput(inputOf('Name')!, 'Docs search EU');
    expect(inputOf('Key')!.value).toBe('docs-search-eu');
    await setInput(inputOf('Language')!, 'tr');
    await click(buttonByText('Create instance', overlay()));
    await settle(150);

    expect(api.to('POST', '/api/websearch/instances')[0]?.body).toEqual({
      key: 'docs-search-eu',
      name: 'Docs search EU',
      providerKey: 'hosted',
      status: 'active',
      settings: { searchDepth: 'basic', language: 'tr', safeSearch: 'moderate' },
      tenantWide: false,
    });
    expect(nav.router.push).toHaveBeenCalledWith('/dashboard/websearch/docs-search-eu');
  });

  it('from a provider that has no instance yet: the provider comes picked', async () => {
    installApi();
    await render(WebSearchListPage);
    await rowAction('New connection', 'Create instance');

    expect(inputOf('Provider')!.value).toMatch(/^New connection/);
  });
});

describe('editing an instance', () => {
  async function openEdit(patch: RouteHandler) {
    installApi([['PATCH', '/api/websearch/instances/docs', patch]]);
    await render(WebSearchListPage);
    await rowAction('Docs search', 'Edit');
  }

  it('shows the search options of the driver, not its connection, and keeps the AI answer and the cache', async () => {
    await openEdit(({ body }) => ({ instance: { ...DOCS_VIEW, ...(body as object) } }));
    expect(fieldLabels()).toEqual(expect.arrayContaining(['Engines', 'Language']));
    expect(fieldLabels()).not.toContain('Base URL');
    expect(inputOf('Key')!.disabled).toBe(true);

    await setInput(inputOf('Language')!, 'de');
    await click(buttonByText('Save changes', overlay()));
    await settle(150);

    expect(api.to('PATCH', '/api/websearch/instances/docs')[0]?.body).toEqual({
      name: 'Docs search',
      description: '',
      status: 'active',
      settings: { engines: 'a', language: 'de', aiAnswer: { enabled: true, modelKey: 'm1' }, cache: { enabled: false } },
    });
    expect(q('.form-overlay')).toBeNull();
  });

  it('marks the option the server refused, with its sentence, and keeps the form open', async () => {
    const refused = 'Use a language code such as en.';
    await openEdit(() => jsonResponse({ error: refused, code: 'provider_settings_invalid', field: 'language' }, 400));
    await setInput(inputOf('Language')!, 'english');
    await click(buttonByText('Save changes', overlay()));
    await settle(150);

    expect(formField('Language')?.textContent).toContain(refused);
    expect(buttonByText('Save changes', overlay())).toBeTruthy();
  });
});

describe('the instance page', () => {
  it('saves the AI answer on the instance, with its other settings, and links its provider', async () => {
    nav.key = 'docs';
    installApi([
      ['GET', '/api/websearch/instances/docs', () => ({ instance: DOCS_VIEW })],
      ['GET', '/api/websearch/instances/docs/logs', () => ({ logs: [] })],
      ['PATCH', '/api/websearch/instances/docs', () => ({ instance: DOCS_VIEW })],
    ]);
    await render(WebSearchInstancePage);
    expect(buttonByText('Edit')).toBeTruthy();

    await click(qa('[role="tab"]').find((tab) => tab.textContent?.includes('Configuration')));
    await settle(150);
    expect(text()).toContain('Search options');
    expect(q<HTMLAnchorElement>('a[href="/dashboard/providers/p-searx"]')?.textContent).toContain('Open provider');

    await click(buttonByText('Save'));
    await settle(150);
    expect(api.to('PATCH', '/api/websearch/instances/docs')[0]?.body).toEqual({
      settings: { engines: 'a', aiAnswer: { enabled: true, modelKey: 'm1' }, cache: { enabled: false } },
    });
    expect(api.to('PATCH', /^\/api\/providers\//)).toHaveLength(0);
  });

  it('keeps a platform instance read-only, and searches and lists its runs through the instance', async () => {
    nav.key = 'web';
    installApi([
      ['GET', '/api/websearch/instances/web', () => ({ instance: PLATFORM_VIEW })],
      ['GET', '/api/websearch/instances/web/logs', () => ({ logs: [] })],
      ['POST', '/api/websearch/search', () => ({ result: { query: 'q', results: [], latencyMs: 3 } })],
    ]);
    await render(WebSearchInstancePage);

    expect(text()).toContain('managed by the platform and cannot be changed');
    expect(buttonByText('Edit')).toBeUndefined();
    expect(api.to('GET', '/api/websearch/instances/web/logs')).toHaveLength(1);

    await setInput(q<HTMLInputElement>('input[aria-label="Search query"]')!, 'news');
    await click(buttonByText('Search'));
    await settle(100);
    expect(api.to('POST', '/api/websearch/search')[0]?.body).toMatchObject({ query: 'news', instance: 'web' });

    await click(qa('[role="tab"]').find((tab) => tab.textContent?.includes('Configuration')));
    await settle(150);
    expect(text()).toContain('Hosted search');
    // Its options are the deployment's: named, read-only, their values not shown.
    expect(text()).toContain('Set by the platform: Search Depth, Language, Country, Safe Search.');
    expect(buttonByText('Edit options')).toBeUndefined();
    expect(text()).not.toContain('AI Answer');
    expect(buttonByText('Delete instance')).toBeUndefined();
    expect(buttonByText('Open provider')).toBeUndefined();
  });

  it('an own instance on a platform provider shows and edits the hosted search options', async () => {
    nav.key = 'eu';
    const EU_VIEW = {
      _id: 'i-eu', key: 'eu', name: 'EU search', providerKey: 'hosted', projectId: 'p1', status: 'active',
      settings: { searchDepth: 'advanced', language: 'tr', aiAnswer: { enabled: false } },
      platform: false, tenantWide: false, provider: HOSTED,
    };
    installApi([
      ['GET', '/api/websearch/instances/eu', () => ({ instance: EU_VIEW })],
      ['GET', '/api/websearch/instances/eu/logs', () => ({ logs: [] })],
      ['PATCH', '/api/websearch/instances/eu', ({ body }) => ({ instance: { ...EU_VIEW, ...(body as object) } })],
    ]);
    await render(WebSearchInstancePage);
    await click(qa('[role="tab"]').find((tab) => tab.textContent?.includes('Configuration')));
    await settle(150);

    expect(text()).toContain('Search Depth');
    expect(text()).toContain('Advanced');
    // A platform provider has no page of its own for the tenant.
    expect(buttonByText('Open provider')).toBeUndefined();

    await click(buttonByText('Edit options'));
    await settle(150);
    expect(fieldLabels()).toEqual(expect.arrayContaining(['Search Depth', 'Language', 'Country', 'Safe Search']));
    await setInput(inputOf('Country')!, 'TR');
    await click(buttonByText('Save changes', overlay()));
    await settle(150);

    expect(api.to('PATCH', '/api/websearch/instances/eu')[0]?.body).toEqual({
      name: 'EU search',
      description: '',
      status: 'active',
      settings: { searchDepth: 'advanced', language: 'tr', country: 'TR', aiAnswer: { enabled: false } },
    });
  });

  it('says a provider has no instance yet, and creates one on it', async () => {
    nav.key = 'new-conn';
    installApi([
      ['GET', '/api/websearch/instances/new-conn', () => jsonResponse({ error: 'Web search instance not found' }, 404)],
      ['GET', '/api/websearch/providers/new-conn', () => ({ provider: PROVIDER_ROWS[1] })],
      ['GET', '/api/websearch/providers/new-conn/logs', () => ({ logs: [] })],
    ]);
    await render(WebSearchInstancePage);

    expect(text()).toContain('This web search provider has no instance');
    expect(api.to('GET', '/api/websearch/providers/new-conn/logs')).toHaveLength(1);
    await click(buttonByText('Create instance'));
    await settle(150);
    expect(inputOf('Provider')!.value).toMatch(/^New connection/);
  });
});
