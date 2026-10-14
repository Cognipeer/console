// @vitest-environment jsdom
/**
 * The quota editor as the Limits tab uses it: the group counting mode, the
 * project field and its rules, the agent-run domain's smaller form, and what it
 * hands to the API on save. Rendered for real in jsdom (FormShell portals into
 * document.body once mounted).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaPolicyModal, type QuotaPolicyFormData } from '@/components/quota/QuotaPolicyModal';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mantine's Select needs ~16 s to mount in jsdom (it is only slow here), which
// would make every test of this file crawl. These tests are about the editor's
// logic, so the dropdown is a native <select> with the same value / onChange.
vi.mock('@mantine/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/core')>();
  const { createElement: h } = await import('react');
  type Option = string | { value: string; label: string };
  const Select = (props: {
    data?: Option[];
    value?: string | null;
    onChange?: (value: string | null) => void;
    label?: string;
    placeholder?: string;
    disabled?: boolean;
  }) =>
    h(
      'select',
      {
        'aria-label': props.label ?? props.placeholder ?? 'select',
        value: props.value ?? '',
        disabled: props.disabled,
        onChange: (event: { target: { value: string } }) => props.onChange?.(event.target.value || null),
      },
      h('option', { value: '' }, props.placeholder ?? ''),
      ...(props.data ?? []).map((option) => {
        const { value, label } = typeof option === 'string' ? { value: option, label: option } : option;
        return h('option', { key: value, value }, label);
      }),
    );
  return { ...actual, Select };
});

beforeAll(() => {
  // What Mantine asks the browser for and jsdom does not have.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
  Element.prototype.scrollIntoView = () => {};
});

const PROJECTS = [{ value: 'proj-1', label: 'Retail (retail)' }, { value: 'proj-2', label: 'Wholesale (wholesale)' }];

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  // The pickers search over HTTP; nothing to find is fine for these tests.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], users: [], groups: [], tokens: [] }) })));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

interface Props {
  policy?: Partial<IQuotaPolicy> | null;
  seed?: Partial<QuotaPolicyFormData> | null;
  /** `null` = the editor gets no list of projects at all. */
  projects?: typeof PROJECTS | null;
  defaultDomain?: IQuotaPolicy['domain'];
  onSubmit?: (data: QuotaPolicyFormData) => Promise<void>;
}

async function mount({ policy = null, seed = null, projects = PROJECTS, defaultDomain = 'llm', onSubmit = async () => {} }: Props = {}) {
  await act(async () => {
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(QuotaPolicyModal, {
          opened: true,
          onClose: () => {},
          onSubmit,
          policy: policy as IQuotaPolicy | null,
          defaultDomain,
          projects: projects ?? undefined,
          seed,
          allowedDomains: ['global', 'llm', 'vector', 'file', 'tracing', 'agent'],
          allowedScopes: ['tenant', 'group', 'user', 'token', 'resource', 'provider'],
        }),
      ),
    );
  });
  // FormShell mounts its portal one effect later.
  await act(async () => {});
}

const text = () => document.body.textContent ?? '';
const chip = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button.form-chip')].find((b) => b.textContent === label);
const primary = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>('.form-footer button')].find((b) => /^(Create|Update)$/.test(b.textContent ?? ''));
const domainSelect = () => [...document.body.querySelectorAll<HTMLSelectElement>('select')].find((el) => [...el.options].some((o) => o.value === 'agent'));
const projectSelect = () => document.body.querySelector<HTMLSelectElement>('select[aria-label="Choose a project"]') ?? undefined;
const sectionTitles = () => [...document.body.querySelectorAll('.form-section-title')].map((n) => n.textContent ?? '');

async function choose(el: HTMLSelectElement | undefined, value: string) {
  if (!el) throw new Error('select not found');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error('element not found');
  await act(async () => {
    el.click();
  });
}

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('group limits', () => {
  it('asks how the group is counted, and says what each choice means', async () => {
    await mount({ seed: { scope: 'group', scopeId: 'g1', domain: 'llm' } });

    expect(text()).toContain('How the group is counted');
    expect(chip('Each member')).toBeTruthy();
    expect(chip('The group together')).toBeTruthy();
    expect(text()).toContain('Usage is counted for each person');

    await click(chip('The group together'));
    expect(text()).toContain('The whole group draws from one limit');
    expect(chip('The group together')?.className).toContain('selected');
    expect(text()).toContain('A tenant limit caps what a group limit can give');
  });

  it('does not show the counting mode for other kinds of target', async () => {
    await mount({ seed: { scope: 'user', scopeId: 'u1', domain: 'llm' } });
    expect(text()).not.toContain('How the group is counted');
  });

  it('forgets the chosen target when the kind of target changes', async () => {
    const submitted: QuotaPolicyFormData[] = [];
    await mount({
      seed: { scope: 'user', scopeId: 'u1', domain: 'llm', label: 'x', projectId: 'proj-1' },
      onSubmit: async (d) => { submitted.push(d); },
    });
    expect(primary()?.disabled).toBe(false);

    await click(chip('Group'));
    // The user id is not a group id: the form needs a new target before it can be saved.
    expect(primary()?.disabled).toBe(true);
  });

  it('forgets an agent or model chosen for a resource limit when the domain changes between them', async () => {
    await mount({ seed: { scope: 'resource', scopeId: 'credit-bot', domain: 'agent', label: 'x' } });
    expect(primary()?.disabled).toBe(false);

    await choose(domainSelect(), 'llm');
    // 'credit-bot' is an agent key, not a model key: the form needs a new target.
    expect(primary()?.disabled).toBe(true);
  });

  it('sends a tenant-wide shared group limit without a project', async () => {
    const submitted: QuotaPolicyFormData[] = [];
    await mount({
      seed: { scope: 'group', scopeId: 'g1', groupMode: 'shared', domain: 'agent', label: 'Branch runs' },
      onSubmit: async (d) => { submitted.push(d); },
    });

    expect(primary()?.disabled).toBe(false); // a group limit needs no project
    await click(primary());

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ scope: 'group', scopeId: 'g1', groupMode: 'shared', domain: 'agent', label: 'Branch runs' });
    expect(submitted[0]).not.toHaveProperty('projectId');
  });

  it('defaults to per-member counting', async () => {
    const submitted: QuotaPolicyFormData[] = [];
    await mount({
      seed: { scope: 'group', scopeId: 'g1', domain: 'llm', label: 'Staff', projectId: 'proj-1' },
      onSubmit: async (d) => { submitted.push(d); },
    });
    await click(primary());
    expect(submitted[0]).toMatchObject({ groupMode: 'perMember', projectId: 'proj-1' });
  });
});

describe('the project field', () => {
  it('is required for a kind of limit that only exists inside a project', async () => {
    await mount({ seed: { scope: 'tenant', domain: 'llm', label: 'Quota' } });
    expect(text()).toContain('This kind of limit only applies inside the project you choose.');
    expect(primary()?.disabled).toBe(true);
  });

  it('is optional for an agent-run limit, which then applies to all projects', async () => {
    const submitted: QuotaPolicyFormData[] = [];
    await mount({
      seed: { scope: 'tenant', domain: 'agent', label: 'Runs' },
      onSubmit: async (d) => { submitted.push(d); },
    });
    expect(text()).toContain('Leave on "All projects"');
    expect(primary()?.disabled).toBe(false);
    await click(primary());
    expect(submitted[0]).not.toHaveProperty('projectId');
  });

  it('moves an existing limit out of its project with an empty projectId', async () => {
    const submitted: QuotaPolicyFormData[] = [];
    await mount({
      policy: {
        _id: 'p1', scope: 'group', scopeId: 'g1', groupMode: 'perMember', domain: 'agent', priority: 5, enabled: true,
        label: 'Staff runs', limits: {}, projectId: 'proj-1',
      },
      onSubmit: async (d) => { submitted.push(d); },
    });
    expect(primary()?.textContent).toBe('Update');
    // The stored values come back into the form.
    expect(chip('Each member')?.className).toContain('selected');
    expect(projectSelect()?.value).toBe('proj-1');

    // Saved as is, an edit keeps its project...
    await click(primary());
    expect(submitted[0]).toMatchObject({ projectId: 'proj-1', groupMode: 'perMember' });

    // ...and choosing "All projects" says so explicitly, because leaving the key out would mean "unchanged".
    await choose(projectSelect(), '__all__');
    await click(primary());
    expect(submitted[1].projectId).toBe('');
  });

  it('is not offered at all without a list of projects', async () => {
    await mount({ projects: null, seed: { scope: 'tenant', domain: 'llm', label: 'Quota' } });
    expect(text()).not.toContain('This kind of limit only applies inside the project');
    expect(primary()?.disabled).toBe(false);
  });
});

describe('the agent-run domain', () => {
  it('shows only request and token limits per person', async () => {
    await mount({ seed: { scope: 'tenant', domain: 'agent', label: 'Runs' } });
    const titles = sectionTitles().join('|');
    expect(titles).toContain('Request rate limits');
    expect(titles).toContain('Tokens (LLM/Embedding)');
    // None of the model, vector, file, tracing, resource-cap or budget fields apply to agent runs.
    for (const absent of ['Vectors', 'Files', 'Storage', 'Resource quotas', 'Budget']) {
      expect(titles).not.toContain(absent);
    }
    expect(text()).not.toContain('Max concurrent requests');
    expect(text()).toContain('A run is counted when it starts');
  });

  it('tells a global limit that agent runs are limited separately', async () => {
    await mount({ seed: { scope: 'tenant', domain: 'global', label: 'Quota', projectId: 'proj-1' } });
    expect(text()).toContain('Agent runs are limited separately');
    await mount({ seed: { scope: 'tenant', domain: 'llm', label: 'Quota', projectId: 'proj-1' } });
    expect(text()).not.toContain('Agent runs are limited separately');
  });

  it('keeps the full form for a model domain', async () => {
    await mount({ seed: { scope: 'tenant', domain: 'llm', label: 'Quota', projectId: 'proj-1' } });
    const titles = sectionTitles().join('|');
    expect(titles).toContain('Resource quotas');
    expect(titles).toContain('Budget');
  });

  it('lists the sections that apply, in order', async () => {
    await mount({ seed: { scope: 'tenant', domain: 'agent', label: 'Runs' } });
    expect(sectionTitles()).toEqual(['Identity', 'Scope', 'Request rate limits', 'Tokens (LLM/Embedding)', 'Activation']);
  });
});
