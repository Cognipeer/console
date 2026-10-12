// @vitest-environment jsdom
/**
 * The limit editor with its search pickers, rendered for real (jsdom + Mantine)
 * against a fake registry: what the target field is called and searches per
 * service, what the project does when a model / index / bucket / provider is
 * picked, what is forgotten when the service changes, and that an existing
 * limit keeps a target the registry no longer has.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  click,
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { QuotaPolicyModal, type QuotaPolicyFormData } from '@/components/quota/QuotaPolicyModal';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import type { QuotaDomain } from '@/lib/quota/types';

beforeAll(() => installDomStubs());

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PROJECTS = [
  { value: 'proj-1', label: 'Retail (retail)' },
  { value: 'proj-2', label: 'Wholesale (wholesale)' },
];

const project = (id: string, name: string) => ({ projectId: id, projectName: name, projectDisplay: { kind: 'project', projectId: id, projectName: name } });

/** The registry, as `GET /api/resources/search` would answer for the types asked. */
const REGISTRY: Record<string, unknown[]> = {
  model: [
    { type: 'model', id: 'm1', key: 'gpt-4o', name: 'GPT-4o', ...project('proj-1', 'Retail'), status: null, attributes: [{ key: 'category', value: 'llm' }] },
    { type: 'model', id: 'm2', key: 'claude-sonnet', name: 'Claude Sonnet', ...project('proj-2', 'Wholesale'), status: null, attributes: [{ key: 'category', value: 'llm' }] },
  ],
  'vector-index': [
    { type: 'vector-index', id: 'vi-1', key: 'docs', name: 'Docs', ...project('proj-2', 'Wholesale'), status: null, attributes: [{ key: 'providerKey', value: 'pg-main' }] },
  ],
  provider: [
    { type: 'provider', id: 'p-pg', key: 'pg-main', name: 'Postgres main', ...project('proj-1', 'Retail'), status: 'active', attributes: [{ key: 'type', value: 'vector' }, { key: 'driver', value: 'pgvector' }] },
    {
      type: 'provider', id: 'p-disk', key: 'disk', name: 'Local disk', projectId: 'proj-1', projectName: 'Retail',
      projectDisplay: { kind: 'multi-project', projectIds: ['proj-1', 'proj-2'], projectNames: ['Retail', 'Wholesale'] },
      status: 'active', attributes: [{ key: 'type', value: 'file' }, { key: 'driver', value: 'local' }],
    },
  ],
  agent: [
    { type: 'agent', id: 'a1', key: 'sales-ab12cd', name: 'Sales agent', ...project('proj-1', 'Retail'), status: 'active', attributes: [] },
  ],
};

let mounted: Mounted;
let api: ApiMock;
let submitted: QuotaPolicyFormData[];

function registry(call: { query: Record<string, string> }) {
  const types = (call.query.types ?? '').split(',');
  const needle = (call.query.q ?? '').toLowerCase();
  const items = types
    .flatMap((type) => REGISTRY[type] ?? [])
    .filter((row) => {
      const r = row as { key: string; name: string };
      return !needle || r.key.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle);
    });
  return { items, total: items.length };
}

interface Props {
  policy?: Partial<IQuotaPolicy> | null;
  seed?: Partial<QuotaPolicyFormData> | null;
  defaultDomain?: QuotaDomain;
  /** What `GET /api/iam/principals` answers (people / groups / tokens). */
  principals?: unknown[];
}

async function open({ policy = null, seed = null, defaultDomain = 'llm', principals = [] }: Props = {}) {
  submitted = [];
  api = installApiMock([
    ['GET', '/api/resources/search', registry as never],
    // The agent-run picker (unchanged) reads the registry's plain list.
    ['GET', '/api/resources', () => ({ items: REGISTRY.agent, projects: [{ id: 'proj-1', name: 'Retail' }] })],
    ['GET', '/api/iam/principals', () => ({ items: principals, nextCursor: null })],
  ]);
  mounted = await mount(
    createElement(QuotaPolicyModal, {
      opened: true,
      onClose: () => {},
      onSubmit: async (data: QuotaPolicyFormData) => {
        submitted.push(data);
      },
      policy: policy as IQuotaPolicy | null,
      defaultDomain,
      projects: PROJECTS,
      seed,
      allowedDomains: ['global', 'llm', 'embedding', 'vector', 'file', 'tracing', 'agent'],
      allowedScopes: ['tenant', 'group', 'user', 'token', 'resource', 'provider'],
    }),
  );
  // FormShell mounts its portal one effect later; the first search answers after that.
  await settle(30);
}

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

const primary = () => qa<HTMLButtonElement>('.form-footer button').find((b) => /^(Create|Update)$/.test(b.textContent ?? ''));
const targetField = (placeholder: string) => q<HTMLInputElement>(`input[aria-label="${placeholder}"]`);
const projectField = () => q<HTMLInputElement>('input[placeholder="Choose a project"]');
const fieldLabels = () => qa('.form-field-label').map((l) => l.textContent?.replace(/\s*\*$/, '') ?? '');
const hints = () => qa('.form-field-hint').map((h) => h.textContent ?? '');

/** Types into a Mantine searchable Select and clicks the option containing `optionText`. */
async function choose(input: HTMLInputElement | null | undefined, optionText: string, search = '') {
  if (!input) throw new Error('select not found');
  await click(input);
  if (search) {
    await setInput(input, search);
    await settle(450);
  }
  const option = qa('[role="option"]').find((o) => o.textContent?.includes(optionText));
  expect(option, `option "${optionText}"`).toBeTruthy();
  await click(option);
  await settle(30);
}

const domainField = () => qa<HTMLInputElement>('input').find((i) => i.value === 'LLM / Chat' || i.value === 'Embeddings' || i.value === 'Vector Store' || i.value === 'Global');

describe('a resource limit', () => {
  it('is called after what it points at, and says what the key means', async () => {
    await open({ seed: { scope: 'resource', domain: 'llm', label: 'Cap' } });
    expect(fieldLabels()).toContain('Model');
    expect(hints()).toContain('The limit applies to calls to this model (by its key), in the project it lives in.');
    expect(targetField('Search models by name or key')).toBeTruthy();

    // A global limit meets every service, so it says "resource"; tracing limits are on agent names.
    await choose(domainField(), 'Vector Store');
    expect(fieldLabels()).toContain('Vector index');
    await choose(domainField(), 'Global');
    expect(fieldLabels()).toContain('Resource');
  });

  it('stores the key of the picked model and takes the project the model lives in', async () => {
    await open({ seed: { scope: 'resource', domain: 'llm', label: 'Cap' } });
    expect(primary()?.disabled).toBe(true);

    await choose(targetField('Search models by name or key'), 'Claude Sonnet');
    // The project follows the model, and the picker says why it can no longer be changed.
    expect(projectField()?.value).toBe('Wholesale (wholesale)');
    expect(projectField()?.disabled).toBe(true);
    expect(hints()).toContain('Taken from the chosen target.');
    expect(primary()?.disabled).toBe(false);

    await click(primary());
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ scope: 'resource', scopeId: 'claude-sonnet', domain: 'llm', projectId: 'proj-2', label: 'Cap' });
  });

  it('lets the project go again when the target is cleared', async () => {
    await open({ seed: { scope: 'resource', domain: 'llm', label: 'Cap' } });
    await choose(targetField('Search models by name or key'), 'GPT-4o');
    expect(projectField()?.disabled).toBe(true);

    await click(q('button.mantine-InputClearButton-root'));
    await settle(30);
    expect(projectField()?.disabled).toBe(false);
    expect(primary()?.disabled).toBe(true);
  });

  it('searches as you type and finds what was typed, by name or key', async () => {
    await open({ seed: { scope: 'resource', domain: 'llm', label: 'Cap' } });
    await choose(targetField('Search models by name or key'), 'Claude Sonnet', 'sonnet');
    expect(api.to('GET', '/api/resources/search').map((c) => c.query.q).filter(Boolean)).toEqual(['sonnet']);
    await click(primary());
    expect(submitted[0].scopeId).toBe('claude-sonnet');
  });

  it('forgets the target when the service moves to another kind of value', async () => {
    await open({ seed: { scope: 'resource', domain: 'llm', label: 'Cap', scopeId: 'gpt-4o', projectId: 'proj-1' } });
    expect(primary()?.disabled).toBe(false);

    // A chat model is not an embedding model...
    await choose(domainField(), 'Embeddings');
    expect(primary()?.disabled).toBe(true);
    expect(targetField('Search models by name or key')?.value).toBe('');
    // ...and certainly not a vector index.
    await choose(domainField(), 'Vector Store');
    expect(targetField('Search vector indexes by name or key')).toBeTruthy();
  });

  it('is stored by agent NAME for tracing, and a name nobody registered can be typed', async () => {
    await open({ seed: { scope: 'resource', domain: 'tracing', label: 'Cap', projectId: 'proj-1' } });
    expect(fieldLabels()).toContain('Agent name');
    expect(hints().join(' ')).toContain('Console agents report their own name');

    await choose(targetField('Search agents or type a name'), 'Use "external-bot"', 'external-bot');
    // A name that lives in no project leaves the project alone.
    expect(projectField()?.disabled).toBe(false);
    expect(projectField()?.value).toBe('Retail (retail)');
    await click(primary());
    expect(submitted[0]).toMatchObject({ scope: 'resource', scopeId: 'external-bot', domain: 'tracing', projectId: 'proj-1' });
  });

  it('keeps the agent flow as it was: the agent key is stored and the project follows', async () => {
    await open({ seed: { scope: 'resource', domain: 'agent', label: 'Runs' } });
    await choose(q<HTMLInputElement>('input[placeholder="Search agents"]'), 'Sales agent');
    // (the agent picker is the principal search, which reads the same registry)
    expect(projectField()?.value).toBe('Retail (retail)');
    expect(projectField()?.disabled).toBe(true);
    await click(primary());
    expect(submitted[0]).toMatchObject({ scope: 'resource', scopeId: 'sales-ab12cd', domain: 'agent', projectId: 'proj-1' });
  });
});

describe('a provider limit', () => {
  it('stores the key of the picked provider and takes its project when it has exactly one', async () => {
    await open({ seed: { scope: 'provider', domain: 'vector', label: 'Cap' } });
    expect(fieldLabels()).toContain('Provider');
    expect(text()).not.toContain('never applies');

    await choose(targetField('Search providers by name or key'), 'Postgres main');
    expect(projectField()?.value).toBe('Retail (retail)');
    expect(projectField()?.disabled).toBe(true);
    await click(primary());
    expect(submitted[0]).toMatchObject({ scope: 'provider', scopeId: 'pg-main', domain: 'vector', projectId: 'proj-1' });
  });

  it('leaves the project to the person when the provider is assigned to several', async () => {
    await open({ seed: { scope: 'provider', domain: 'file', label: 'Cap', projectId: 'proj-2' } });
    await choose(targetField('Search providers by name or key'), 'Local disk');
    expect(projectField()?.disabled).toBe(false);
    expect(projectField()?.value).toBe('Wholesale (wholesale)');
    await click(primary());
    expect(submitted[0]).toMatchObject({ scopeId: 'disk', projectId: 'proj-2' });
  });

  it('warns that the limit could never apply to a service whose calls report no provider, and stops when the service changes', async () => {
    await open({ seed: { scope: 'provider', domain: 'llm', label: 'Cap' } });
    expect(text()).toContain('LLM / Chat calls do not report a provider, so a limit on a provider never applies to them.');

    await choose(domainField(), 'Vector Store');
    expect(text()).not.toContain('never applies');
  });

  it('searches only the providers the service reports', async () => {
    await open({ seed: { scope: 'provider', domain: 'file', label: 'Cap' } });
    expect(api.to('GET', '/api/resources/search')[0].query).toMatchObject({ types: 'provider', attr: 'type:file' });
  });
});

describe('an existing limit', () => {
  const stored = (over: Partial<IQuotaPolicy> = {}): Partial<IQuotaPolicy> => ({
    _id: 'p1', scope: 'resource', scopeId: 'gpt-4o', domain: 'llm', priority: 5, enabled: true, label: 'GPT cap',
    limits: { rateLimit: { requests: { perMinute: 60 } } }, projectId: 'proj-1', ...over,
  });

  it('shows the name of the model it points at, and sends the key back unchanged', async () => {
    await open({ policy: stored() });
    expect(targetField('Search models by name or key')?.value).toBe('GPT-4o');
    expect(text()).not.toContain('was not found');

    await click(primary());
    expect(submitted[0]).toMatchObject({ scopeId: 'gpt-4o', projectId: 'proj-1' });
  });

  it('keeps a model that no longer exists, says so, and still saves it as it is', async () => {
    await open({ policy: stored({ scopeId: 'retired-model' }) });
    expect(targetField('Search models by name or key')?.value).toBe('retired-model');
    expect(text()).toContain('"retired-model" was not found.');
    expect(primary()?.disabled).toBe(false);

    await click(primary());
    expect(submitted[0]).toMatchObject({ scope: 'resource', scopeId: 'retired-model', projectId: 'proj-1' });
  });

  it('keeps its project editable: nothing was picked just now', async () => {
    await open({ policy: stored() });
    expect(projectField()?.disabled).toBe(false);
  });
});

describe('an existing limit whose person, group, token or agent is gone', () => {
  const gone = (scope: 'user' | 'group' | 'token', over: Record<string, unknown> = {}): Partial<IQuotaPolicy> =>
    ({
      _id: 'p2', scope, scopeId: 'u-deleted', domain: 'llm', priority: 5, enabled: true, label: 'Old cap',
      limits: { rateLimit: { requests: { perMinute: 10 } } }, projectId: 'proj-1',
      target: { type: scope, id: 'u-deleted', label: 'u-deleted', missing: true },
      ...over,
    }) as Partial<IQuotaPolicy>;

  it('keeps the id, says it was not found, and saves it as it is', async () => {
    await open({ policy: gone('user') });
    expect(text()).toContain('This person was not found. The limit keeps their id but applies to nobody.');
    expect(primary()?.disabled).toBe(false);

    await click(primary());
    expect(submitted[0]).toMatchObject({ scope: 'user', scopeId: 'u-deleted', projectId: 'proj-1' });
  });

  it('stops saying so once another person is chosen', async () => {
    await open({ policy: gone('user'), principals: [{ id: 'u-ann', label: 'Ann Lee', sublabel: 'ann@acme.test' }] });
    await choose(q<HTMLInputElement>('input[placeholder="Select user"]'), 'Ann Lee');
    expect(text()).not.toContain('was not found');
    await click(primary());
    expect(submitted[0]).toMatchObject({ scope: 'user', scopeId: 'u-ann' });
  });

  it('says it for a deleted agent of an agent-run limit', async () => {
    await open({
      policy: gone('user', { scope: 'resource', domain: 'agent', scopeId: 'old-bot', target: { type: 'agent', id: 'old-bot', label: 'old-bot', missing: true } }),
    });
    expect(text()).toContain('This agent was not found. The limit keeps its key but applies to no run.');
  });

  it('says nothing for a person who exists', async () => {
    await open({ policy: gone('user', { target: { type: 'user', id: 'u-deleted', label: 'Ann Lee' } }) });
    expect(text()).not.toContain('was not found');
  });
});
