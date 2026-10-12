// @vitest-environment jsdom
/**
 * The Limits tab with its real data hook, rendered in jsdom against fake quota
 * and registry endpoints: the table names a model, an index or a provider by its
 * NAME with the key underneath once the registry has answered, flags a target
 * that is not in the registry, asks the registry only for what the quota API did
 * not name, and searches case-insensitively the Turkish way.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
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
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import LimitsTab from '@/components/iam/limits/LimitsTab';

beforeAll(() => installDomStubs());

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted;
let api: ApiMock;

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

const policy = (over: Record<string, unknown>) => ({
  _id: 'p', scope: 'user', scopeId: 'u1', domain: 'llm', priority: 10, enabled: true, label: 'A limit', projectId: 'proj-1', projectName: 'Retail',
  limits: { rateLimit: { requests: { perMinute: 5 } } }, target: { type: 'user', id: 'u1', label: 'Alice', sublabel: 'alice@acme.test' }, ...over,
});

/** What `GET /api/quota/policies?include=targets` answers for a model, an index and a provider: the key is all it knows. */
const POLICIES = [
  policy({ _id: 'm', label: 'Flagship cap', scope: 'resource', scopeId: 'gpt-4o', target: { type: 'resource', id: 'gpt-4o', label: 'gpt-4o' } }),
  policy({ _id: 'r', label: 'Retired cap', scope: 'resource', scopeId: 'retired-model', target: { type: 'resource', id: 'retired-model', label: 'retired-model' } }),
  policy({ _id: 'v', label: 'Index cap', scope: 'resource', domain: 'vector', scopeId: 'docs', target: { type: 'resource', id: 'docs', label: 'docs' } }),
  policy({ _id: 'pr', label: 'Provider cap', scope: 'provider', domain: 'vector', scopeId: 'pg-main', target: { type: 'provider', id: 'pg-main', label: 'pg-main' } }),
  policy({ _id: 'u', label: 'Alice cap' }),
  policy({ _id: 'a', label: 'Bot cap', scope: 'resource', domain: 'agent', scopeId: 'credit-bot', target: { type: 'agent', id: 'credit-bot', label: 'Credit assistant', sublabel: 'credit-bot' } }),
];

const project = { projectId: 'proj-1', projectName: 'Retail', projectDisplay: { kind: 'project', projectId: 'proj-1', projectName: 'Retail' } };
const REGISTRY = [
  { type: 'model', id: 'm1', key: 'gpt-4o', name: 'GPT-4o', ...project, status: null, attributes: [{ key: 'category', value: 'llm' }] },
  { type: 'vector-index', id: 'vi1', key: 'docs', name: 'Product docs', ...project, status: null, attributes: [] },
  { type: 'provider', id: 'pv1', key: 'pg-main', name: 'Postgres main', ...project, status: 'active', attributes: [{ key: 'type', value: 'vector' }] },
];

function registry(call: { query: Record<string, string> }) {
  const wanted = call.query.q ?? '';
  const types = (call.query.types ?? '').split(',');
  const items = REGISTRY.filter((r) => types.includes(r.type) && (r.key === wanted || r.name === wanted));
  return { items, total: items.length };
}

async function render(policies: unknown[] = POLICIES, search: Parameters<typeof installApiMock>[0][number][2] = registry as never) {
  api = installApiMock([
    ['GET', '/api/quota/policies', () => ({ policies })],
    ['GET', '/api/projects', () => ({ projects: [{ _id: 'proj-1', name: 'Retail' }] })],
    ['GET', '/api/resources/search', search],
  ]);
  mounted = await mount(createElement(LimitsTab, { canManage: true }));
  await settle(300);
}

const rowOf = (limit: string) => qa('tbody tr').find((tr) => tr.textContent?.includes(limit));
const cellText = (limit: string) => rowOf(limit)?.textContent ?? '';

describe('the Limits table names what a limit points at', () => {
  it('shows a model, an index and a provider by NAME with the key underneath, and what kind of thing each is', async () => {
    await render();
    expect(cellText('Flagship cap')).toMatch(/Model\s*GPT-4ogpt-4o/);
    expect(cellText('Index cap')).toMatch(/Vector index\s*Product docsdocs/);
    expect(cellText('Provider cap')).toMatch(/Provider\s*Postgres mainpg-main/);
    // the people and agents the quota API names itself are untouched
    expect(cellText('Alice cap')).toContain('Alice');
    expect(cellText('Alice cap')).toContain('alice@acme.test');
    expect(cellText('Bot cap')).toMatch(/Agent\s*Credit assistantcredit-bot/);
  });

  it('asks the registry for what the quota API did not name, once per thing, and for nothing else', async () => {
    await render();
    const asked = api.to('GET', '/api/resources/search').map((c) => [c.query.types, c.query.q]);
    expect(asked.sort()).toEqual([
      ['model', 'gpt-4o'],
      ['model', 'retired-model'],
      ['provider', 'pg-main'],
      ['vector-index', 'docs'],
    ]);
  });

  it('says "Not found" for a target the registry answered completely and does not have, and keeps its key', async () => {
    await render();
    expect(cellText('Retired cap')).toContain('retired-model');
    expect(cellText('Retired cap')).toContain('Not found');
    // ...and for nothing that was found
    expect(cellText('Flagship cap')).not.toContain('Not found');
    expect(cellText('Index cap')).not.toContain('Not found');
  });

  it('never says "Not found" when the registry could not be asked or answered with rows missing', async () => {
    await render(POLICIES, (() => jsonResponse({ error: 'boom' }, 500)) as never);
    expect(text()).not.toContain('Not found');
    // the keys stay, as before
    expect(cellText('Flagship cap')).toContain('gpt-4o');
    await mounted.unmount();
    await render(POLICIES, ((call: { query: Record<string, string> }) => ({ ...registry(call), errors: [{ type: 'model', message: 'x' }], items: [] })) as never);
    expect(text()).not.toContain('Not found');
  });

  it('keeps the names it has when a later lookup fails', async () => {
    let healthy = true;
    await render(POLICIES, ((call: { query: Record<string, string> }) => (healthy ? registry(call) : jsonResponse({ error: 'boom' }, 500))) as never);
    expect(cellText('Flagship cap')).toMatch(/Model\s*GPT-4ogpt-4o/);
    // The registry goes away; a refresh of the rows must not take the names back.
    healthy = false;
    const before = api.to('GET', '/api/quota/policies').length;
    await click(q('button[aria-label="Refresh"]'));
    await settle(300);
    expect(api.to('GET', '/api/quota/policies').length).toBe(before + 1);
    expect(cellText('Flagship cap')).toMatch(/Model\s*GPT-4ogpt-4o/);
    // ...and a refresh the registry cannot answer calls nothing "not found" that was found before.
    expect(cellText('Flagship cap')).not.toContain('Not found');
    expect(cellText('Index cap')).toMatch(/Vector index\s*Product docsdocs/);
  });

  it('stops asking a registry the person may not browse, and shows the keys', async () => {
    await render(POLICIES, (() => jsonResponse({ error: 'Forbidden' }, 403)) as never);
    expect(api.to('GET', '/api/resources/search').length).toBeLessThanOrEqual(4);
    expect(text()).not.toContain('Not found');
    expect(cellText('Flagship cap')).toContain('gpt-4o');
  });

  it('still calls a person that no longer exists "Not found"', async () => {
    await render([policy({ _id: 'x', label: 'Orphan', scopeId: 'gone', target: { type: 'user', id: 'gone', label: 'gone', missing: true } })]);
    expect(cellText('Orphan')).toContain('Not found');
    // no registry lookup for a person
    expect(api.to('GET', '/api/resources/search')).toHaveLength(0);
  });

  it('gives each kind of target its own icon and says how many limits are shown', async () => {
    await render();
    const badge = (limit: string) => rowOf(limit)?.querySelector('.ds-badge')?.innerHTML ?? '';
    // A model, an index and a provider no longer share the catch-all "resource" box.
    const icons = ['Flagship cap', 'Index cap', 'Provider cap'].map((limit) => badge(limit).match(/tabler-icon-[\w-]+/)?.[0]);
    expect(new Set(icons).size).toBe(3);
    expect(text()).toContain('Showing 6 of 6 limits');
  });

  it('is worded in Turkish', async () => {
    api = installApiMock([
      ['GET', '/api/quota/policies', () => ({ policies: POLICIES })],
      ['GET', '/api/projects', () => ({ projects: [] })],
      ['GET', '/api/resources/search', registry as never],
    ]);
    mounted = await mount(createElement(LimitsTab, { canManage: true }), 'tr');
    await settle(300);
    expect(cellText('Retired cap')).toContain('Bulunamadı');
    expect(cellText('Flagship cap')).toMatch(/Model\s*GPT-4ogpt-4o/);
    expect(text()).toContain('6 limit içinden 6 tanesi gösteriliyor');
    // The tile labels and column headings are upper-cased by CSS: Turkish text must say it is Turkish ("LİMİTLER").
    expect(q('.ds-stat-label')!.closest('[lang]')!.getAttribute('lang')).toBe('tr');
    expect(q('.ds-tbl th')!.closest('[lang]')!.getAttribute('lang')).toBe('tr');
    expect(text()).not.toContain('Showing');
    expect(text()).not.toMatch(/iamLimits\./);
  });
});

describe('the Limits table search', () => {
  const searchBox = () => q<HTMLInputElement>('.ds-toolbar-search input')!;
  const shown = () => qa('tbody tr').map((tr) => tr.textContent ?? '').filter((t) => !t.includes('No limits match'));

  const TURKISH = [
    policy({ _id: 'ist', label: 'Şube limiti', scope: 'group', scopeId: 'g1', target: { type: 'group', id: 'g1', label: 'İstanbul Şubesi', sublabel: 'Marmara' } }),
    policy({ _id: 'isp', label: 'Bölge limiti', scope: 'group', scopeId: 'g2', target: { type: 'group', id: 'g2', label: 'ISPARTA Bölgesi' } }),
    policy({ _id: 'eng', label: 'Engineering cap', scope: 'group', scopeId: 'g3', target: { type: 'group', id: 'g3', label: 'Engineering' } }),
  ];

  it('finds Turkish names whatever the case of the typed words', async () => {
    await render(TURKISH);
    expect(shown()).toHaveLength(3);
    await setInput(searchBox(), 'istanbul');
    await settle(30);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain('İstanbul Şubesi');

    await setInput(searchBox(), 'İSTANBUL');
    await settle(30);
    expect(shown()).toHaveLength(1);

    await setInput(searchBox(), 'ısparta');
    await settle(30);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain('ISPARTA Bölgesi');

    await setInput(searchBox(), 'ŞUBE');
    await settle(30);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain('Şube limiti');
  });

  it('finds the name the registry gave a model, not only its key', async () => {
    await render();
    await setInput(searchBox(), 'gpt-4o');
    await settle(30);
    expect(shown()).toHaveLength(1);
    await setInput(searchBox(), 'product docs');
    await settle(30);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain('Index cap');
  });

  it('counts what the search leaves', async () => {
    await render(TURKISH);
    await setInput(searchBox(), 'ISPARTA');
    await settle(30);
    expect(text()).toContain('Showing 1 of 1 limits');
  });

  it('shows everything again for a blank search, and a message for no match', async () => {
    await render(TURKISH);
    await setInput(searchBox(), 'zzz');
    await settle(30);
    expect(text()).toContain('No limits match these filters');
    await setInput(searchBox(), '   ');
    await settle(30);
    expect(shown()).toHaveLength(3);
  });
});
