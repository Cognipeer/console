// @vitest-environment jsdom
/**
 * The search picker behind a limit's "resource" and "provider" targets, rendered
 * for real (jsdom + Mantine) against a fake registry search: the first page on
 * open, the 250 ms pause before a keystroke is sent, loading and empty texts,
 * which answer wins when two overlap, the value that is stored (a key, or the
 * agent name for tracing), a saved value that no longer exists, and the plain
 * field for someone who may not browse the registry.
 */
import { act, createElement, useState } from 'react';
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
import { TargetSelect } from '@/components/quota/TargetSelect';
import type { TargetOption } from '@/components/quota/pickerSources';
import { quotaTargetSource } from '@/lib/quota/targets';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';

beforeAll(() => installDomStubs());

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SEARCH = '/api/resources/search';

const project = (id: string, name: string) => ({ projectId: id, projectName: name, projectDisplay: { kind: 'project', projectId: id, projectName: name } });
const model = (over: Record<string, unknown> = {}) => ({
  type: 'model', id: 'm1', key: 'gpt-4o', name: 'GPT-4o', ...project('proj-1', 'Retail'), status: null,
  attributes: [{ key: 'category', value: 'llm' }, { key: 'providerKey', value: 'openai-prod' }], ...over,
});

const GPT = model();
const MINI = model({ id: 'm2', key: 'gpt-4o-mini', name: 'GPT-4o mini', ...project('proj-2', 'Wholesale') });

interface Seen {
  changes: Array<{ value: string | undefined; option?: TargetOption }>;
  labels: Array<string | undefined>;
}

let mounted: Mounted;
let api: ApiMock;
let seen: Seen;

function Harness(props: { domain: QuotaDomain; scope: QuotaScope; initial?: string; projectId?: string; seen: Seen }) {
  const [value, setValue] = useState<string | undefined>(props.initial);
  return createElement(TargetSelect, {
    source: quotaTargetSource(props.domain, props.scope)!,
    value,
    projectId: props.projectId,
    onChange: (next: string | undefined, option?: TargetOption) => {
      props.seen.changes.push({ value: next, option });
      setValue(next);
    },
    onLabelChange: (label: string | undefined) => props.seen.labels.push(label),
  });
}

interface RenderOptions {
  domain?: QuotaDomain;
  scope?: QuotaScope;
  initial?: string;
  projectId?: string;
}

async function render(handler: (call: { query: Record<string, string> }) => unknown, options: RenderOptions = {}) {
  seen = { changes: [], labels: [] };
  api = installApiMock([['GET', SEARCH, handler as never]]);
  mounted = await mount(
    createElement(Harness, {
      domain: options.domain ?? 'llm',
      scope: options.scope ?? 'resource',
      initial: options.initial,
      projectId: options.projectId,
      seen,
    }),
  );
  await settle(30);
}

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

const searches = () => api.to('GET', SEARCH);
const MODELS = 'Search models by name or key';
const field = (label = MODELS) => q<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const options = () => qa('[role="option"]');
const optionTexts = () => options().map((o) => o.textContent ?? '');
const clearButton = () => q<HTMLButtonElement>('button.mantine-InputClearButton-root');
const checkedOption = () => options().find((o) => o.getAttribute('aria-selected') === 'true');

async function type(input: HTMLInputElement, value: string) {
  await click(input);
  await setInput(input, value);
}

async function press(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
  });
}

describe('what is asked of the registry', () => {
  it('asks for the first page of the right kind of row as soon as it shows, with no query', async () => {
    await render(() => ({ items: [GPT], total: 1 }));
    expect(searches()).toHaveLength(1);
    expect(searches()[0].query).toEqual({ types: 'model', limit: '20', attr: 'category:llm' });
  });

  it('asks for the vector providers only when the limit is for the vector service', async () => {
    await render(() => ({ items: [], total: 0 }), { domain: 'vector', scope: 'provider' });
    expect(searches()[0].query).toEqual({ types: 'provider', limit: '20', attr: 'type:vector' });
  });

  it('searches models, indexes and buckets together for a global limit', async () => {
    await render(() => ({ items: [], total: 0 }), { domain: 'global' });
    expect(searches()[0].query).toEqual({ types: 'model,vector-index,file-bucket', limit: '20' });
  });

  it('waits for the typing to pause (250 ms) and then asks once, for what was typed', async () => {
    await render(() => ({ items: [GPT], total: 1 }));
    const input = field();
    await type(input, 'g');
    await setInput(input, 'gp');
    await setInput(input, 'gpt');
    // Nothing but the first page has gone out while the typing goes on.
    expect(searches()).toHaveLength(1);

    await settle(450);
    expect(searches()).toHaveLength(2);
    expect(searches()[1].query).toEqual({ types: 'model', limit: '20', attr: 'category:llm', q: 'gpt' });
  });

  it('does not ask again for the label it writes into the box after a pick', async () => {
    await render(() => ({ items: [GPT, MINI], total: 2 }));
    await click(field());
    await click(options()[0]);
    await settle(450);
    expect(searches()).toHaveLength(1);
  });
});

describe('what the dropdown shows', () => {
  it('lists the first page: the name, then the key, the facts that tell rows apart, and the project', async () => {
    await render(() => ({ items: [GPT, MINI], total: 2 }));
    await click(field());
    // The category is the same for every row of the llm service, so it is not repeated.
    expect(optionTexts()).toEqual(['GPT-4ogpt-4o · Retail', 'GPT-4o minigpt-4o-mini · Wholesale']);
  });

  it('says which kind a row is when several kinds are searched together', async () => {
    const bucket = { type: 'file-bucket', id: 'b1', key: 'uploads', name: 'Uploads', ...project('proj-1', 'Retail'), status: 'active', attributes: [{ key: 'providerKey', value: 'disk' }] };
    await render(() => ({ items: [GPT, bucket], total: 2 }), { domain: 'global' });
    await click(field('Search models, indexes and buckets'));
    expect(optionTexts()).toEqual([
      'GPT-4oModel · gpt-4o · llm · Retail',
      'UploadsFile bucket · uploads · disk · Retail',
    ]);
  });

  it('says it shows only the first page, and that note can not be picked', async () => {
    const page = Array.from({ length: 20 }, (_, i) => model({ id: `m${i}`, key: `model-${i}`, name: `Model ${i}` }));
    await render(() => ({ items: page, total: 143 }));
    await click(field());
    expect(options()).toHaveLength(21);
    const note = options()[20];
    expect(note.textContent).toBe('Showing the first 20 of 143. Type to narrow the list.');
    expect(note.getAttribute('data-combobox-disabled')).toBe('true');
    await click(note);
    expect(seen.changes).toEqual([]);
  });

  it('shows a loading text, not "nothing found", while the first page is on its way', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await render(() => gate);
    await click(field());
    expect(text()).toContain('Searching…');
    expect(text()).not.toContain('No models found');

    release({ items: [], total: 0 });
    await settle(30);
    expect(text()).toContain('No models found');
    expect(text()).not.toContain('Searching…');
  });

  it('names what a search found nothing for in the words of the kind of target', async () => {
    await render(() => ({ items: [], total: 0 }), { domain: 'vector', scope: 'provider' });
    await click(field('Search providers by name or key'));
    expect(text()).toContain('No providers found');
  });

  it('says so when the search fails, and tries again with the next keystroke', async () => {
    let healthy = false;
    await render(() => (healthy ? { items: [GPT], total: 1 } : jsonResponse({ error: 'boom' }, 500)));
    const input = field();
    await click(input);
    expect(text()).toContain('The search failed. Type again to retry.');

    healthy = true;
    await setInput(input, 'gpt');
    await settle(450);
    expect(optionTexts()).toEqual(['GPT-4ogpt-4o · Retail']);
  });

  it('answers with the newest search when an older one comes back late', async () => {
    const waiting = new Map<string, (value: unknown) => void>();
    await render((call) =>
      call.query.q ? new Promise((resolve) => waiting.set(call.query.q, resolve)) : { items: [GPT, MINI], total: 2 },
    );
    const input = field();
    await type(input, 'gpt');
    await settle(450);
    await setInput(input, 'gpt-4o-mini');
    await settle(450);
    expect([...waiting.keys()]).toEqual(['gpt', 'gpt-4o-mini']);

    // The newer search answers first; the older one is late and must not overwrite it.
    waiting.get('gpt-4o-mini')!({ items: [MINI], total: 1 });
    await settle(30);
    waiting.get('gpt')!({ items: [GPT], total: 1 });
    await settle(30);
    expect(optionTexts()).toEqual(['GPT-4o minigpt-4o-mini · Wholesale']);
  });
});

describe('the value that is stored', () => {
  it('stores the KEY of the picked row, hands over the row, and shows the name', async () => {
    await render(() => ({ items: [GPT, MINI], total: 2 }));
    await click(field());
    await click(options()[1]);
    await settle(30);

    expect(seen.changes).toHaveLength(1);
    expect(seen.changes[0].value).toBe('gpt-4o-mini');
    // The row says where it lives, which the limit's project follows.
    expect(seen.changes[0].option).toMatchObject({ id: 'model:m2', type: 'model', label: 'GPT-4o mini', projectId: 'proj-2' });
    expect(field().value).toBe('GPT-4o mini');
    expect(seen.labels.at(-1)).toBe('GPT-4o mini');
  });

  it('can be driven from the keyboard', async () => {
    await render(() => ({ items: [GPT, MINI], total: 2 }));
    const input = field();
    await click(input);
    await press(input, 'ArrowDown');
    await press(input, 'ArrowDown');
    await press(input, 'Enter');
    await settle(30);
    expect(seen.changes.map((c) => c.value)).toEqual(['gpt-4o-mini']);
  });

  it('can be cleared', async () => {
    await render(() => ({ items: [GPT], total: 1 }));
    await click(field());
    await click(options()[0]);
    await settle(30);
    expect(clearButton()).toBeTruthy();

    await click(clearButton());
    await settle(30);
    expect(seen.changes.at(-1)).toEqual({ value: undefined, option: undefined });
    expect(field().value).toBe('');
  });

  it('stores the agent NAME for a tracing limit, because that is what a trace reports', async () => {
    const agent = { type: 'agent', id: 'a1', key: 'sales-ab12cd', name: 'Sales agent', ...project('proj-1', 'Retail'), status: 'active', attributes: [] };
    await render(() => ({ items: [agent], total: 1 }), { domain: 'tracing' });
    expect(searches()[0].query).toEqual({ types: 'agent', limit: '20' });

    const input = field('Search agents or type a name');
    await click(input);
    expect(optionTexts()).toEqual(['Sales agentsales-ab12cd · Retail']);
    await click(options()[0]);
    await settle(30);
    expect(seen.changes[0].value).toBe('Sales agent');
  });

  it('offers what was typed for a tracing limit, since an SDK can report any agent name', async () => {
    await render(() => ({ items: [], total: 0 }), { domain: 'tracing' });
    const input = field('Search agents or type a name');
    await type(input, 'billing-bot');
    await settle(450);
    expect(optionTexts()).toEqual(['Use "billing-bot"']);

    await click(options()[0]);
    await settle(30);
    expect(seen.changes).toHaveLength(1);
    expect(seen.changes[0].value).toBe('billing-bot');
    // An unregistered name lives in no project, so the limit's project stays as it was.
    expect(seen.changes[0].option?.projectId).toBeUndefined();
    expect(input.value).toBe('billing-bot');
  });

  it('does not offer to use a name that the registry already knows exactly', async () => {
    const agent = { type: 'agent', id: 'a1', key: 'k', name: 'Sales agent', ...project('proj-1', 'Retail'), status: null, attributes: [] };
    await render(() => ({ items: [agent], total: 1 }), { domain: 'tracing' });
    await type(field('Search agents or type a name'), 'Sales agent');
    await settle(450);
    expect(optionTexts()).toEqual(['Sales agentk · Retail']);
  });

  it('tells two rows that share a key apart and selects the one in the limit\'s project', async () => {
    const docs = (id: string, projectId: string, projectName: string) => ({
      type: 'vector-index', id, key: 'docs', name: 'Docs', ...project(projectId, projectName), status: null,
      attributes: [{ key: 'providerKey', value: 'pg-main' }],
    });
    const handler = () => ({ items: [docs('vi-1', 'proj-1', 'Retail'), docs('vi-2', 'proj-2', 'Wholesale')], total: 2 });

    await render(handler, { domain: 'vector', initial: 'docs', projectId: 'proj-2' });
    await click(field('Search vector indexes by name or key'));
    // Both are offered (an option value is the row, not the key)...
    expect(optionTexts()).toEqual(['Docsdocs · pg-main · Retail', 'Docsdocs · pg-main · Wholesale']);
    // ...and the stored key is shown as the one of the project the limit is in.
    expect(checkedOption()?.getAttribute('value')).toBe('vector-index:vi-2');
  });
});

describe('a saved value', () => {
  it('is looked up exactly and shown under the name of the row it stands for', async () => {
    await render(() => ({ items: [MINI, GPT], total: 2 }), { initial: 'gpt-4o' });
    const lookups = searches().filter((call) => call.query.q === 'gpt-4o');
    expect(lookups).toHaveLength(1);
    expect(field().value).toBe('GPT-4o');
    expect(text()).not.toContain('was not found');
    expect(seen.changes).toEqual([]);
  });

  it('that no longer exists stays as it is, with a note, and is never dropped', async () => {
    await render(() => ({ items: [GPT], total: 1 }), { initial: 'retired-model' });
    expect(field().value).toBe('retired-model');
    expect(text()).toContain('"retired-model" was not found.');
    expect(text()).toContain('The limit keeps it, but applies to nothing until a model with that key exists.');
    expect(seen.changes).toEqual([]);
    expect(seen.labels.at(-1)).toBe('retired-model');
  });

  it('is not called "not found" when the registry\'s answer may lack rows', async () => {
    await render(() => ({ items: [GPT], total: 1, errors: [{ type: 'model', message: 'Failed to load this resource type' }] }), { initial: 'retired-model' });
    expect(field().value).toBe('retired-model');
    expect(text()).not.toContain('was not found');
  });

  it('is not called "not found" when the registry could not be asked', async () => {
    await render(() => jsonResponse({ error: 'boom' }, 500), { initial: 'gpt-4o' });
    expect(field().value).toBe('gpt-4o');
    expect(text()).not.toContain('was not found');
  });

  it('may be a name the registry does not know when the target is an agent name', async () => {
    await render(() => ({ items: [], total: 0 }), { domain: 'tracing', initial: 'external-bot' });
    expect(field('Search agents or type a name').value).toBe('external-bot');
    expect(text()).toContain('"external-bot" is not a registered agent.');
    expect(text()).not.toContain('was not found');
  });

  it('is a plain match when it is picked just now (no second lookup)', async () => {
    await render(() => ({ items: [GPT], total: 1 }));
    await click(field());
    await click(options()[0]);
    await settle(450);
    expect(searches().filter((call) => call.query.q)).toEqual([]);
    expect(text()).not.toContain('was not found');
  });
});

describe('someone who may not browse the registry', () => {
  it('gets a plain field for the exact value, and what they type is the value', async () => {
    await render(() => jsonResponse({ error: 'Forbidden' }, 403), { initial: 'gpt-4o' });
    const manual = q<HTMLInputElement>('input[placeholder="Exact value"]')!;
    expect(manual).toBeTruthy();
    expect(manual.value).toBe('gpt-4o');
    expect(text()).toContain('You cannot browse the resource registry, so enter the exact value yourself.');
    expect(q('[role="combobox"], input[aria-haspopup="listbox"]')).toBeNull();

    await setInput(manual, 'claude-sonnet');
    expect(seen.changes.at(-1)?.value).toBe('claude-sonnet');
    expect(manual.value).toBe('claude-sonnet');

    await setInput(manual, '');
    expect(seen.changes.at(-1)?.value).toBeUndefined();
  });

  it('is also what a registry that is not there (404) means', async () => {
    await render(() => jsonResponse({ error: 'Not found' }, 404));
    expect(q('input[placeholder="Exact value"]')).toBeTruthy();
  });
});
