// @vitest-environment jsdom
/**
 * How the limit editor's searchable pickers behave under the keyboard, rendered
 * for real (jsdom + Mantine) against fake searches:
 *
 *  - Enter picks the FIRST (best-ranked) result of what was typed, waits for a
 *    search that is still on its way, and never clears the choice that is held;
 *  - typing into a box that holds a choice starts a fresh search instead of
 *    extending the name;
 *  - the saved value that is not among the results is not offered while somebody
 *    searches for something else;
 *  - a list the browser holds is filtered case-insensitively the Turkish way.
 */
import { act, createElement, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  click,
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  setInput,
  settle,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { PrincipalSelect } from '@/components/quota/PrincipalSelect';
import { SearchableSelect } from '@/components/quota/SearchableSelect';
import { TargetSelect } from '@/components/quota/TargetSelect';
import type { PickerOption, PickerType, TargetOption } from '@/components/quota/pickerSources';
import { quotaTargetSource } from '@/lib/quota/targets';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';

beforeAll(() => installDomStubs());

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted;
let api: ApiMock;

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

const options = () => qa('[role="option"]');
const optionTexts = () => options().map((o) => o.textContent ?? '');
const highlighted = () => options().findIndex((o) => o.hasAttribute('data-combobox-selected'));

async function press(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    input.dispatchEvent(event);
  });
  return event;
}

// ── the registry picker (models, indexes, buckets, providers) ───────────────

const SEARCH = '/api/resources/search';
const project = (id: string, name: string) => ({ projectId: id, projectName: name, projectDisplay: { kind: 'project', projectId: id, projectName: name } });
const model = (key: string, name: string, id = key) => ({
  type: 'model', id, key, name, ...project('proj-1', 'Retail'), status: null, attributes: [{ key: 'category', value: 'llm' }],
});
const GPT = model('gpt-4o', 'GPT-4o');
const MINI = model('gpt-4o-mini', 'GPT-4o mini');
const CLAUDE = model('claude-sonnet', 'Claude Sonnet');

interface Seen {
  changes: Array<{ value: string | undefined; option?: TargetOption }>;
}
let seen: Seen;
const MODELS = 'Search models by name or key';
const modelInput = () => q<HTMLInputElement>(`input[aria-label="${MODELS}"]`)!;

function TargetHarness(props: { domain: QuotaDomain; scope: QuotaScope; initial?: string; seen: Seen }) {
  const [value, setValue] = useState<string | undefined>(props.initial);
  return createElement(TargetSelect, {
    source: quotaTargetSource(props.domain, props.scope)!,
    value,
    onChange: (next: string | undefined, option?: TargetOption) => {
      props.seen.changes.push({ value: next, option });
      setValue(next);
    },
  });
}

async function renderTarget(
  handler: (call: { query: Record<string, string> }) => unknown,
  options: { domain?: QuotaDomain; scope?: QuotaScope; initial?: string } = {},
) {
  seen = { changes: [] };
  api = installApiMock([['GET', SEARCH, handler as never]]);
  mounted = await mount(
    createElement(TargetHarness, { domain: options.domain ?? 'llm', scope: options.scope ?? 'resource', initial: options.initial, seen }),
  );
  await settle(30);
}

/** A registry whose answer depends on what was asked: `rank` lists, for a query, the rows best first. */
const ranked = (byQuery: Record<string, unknown[]>, fallback: unknown[] = [GPT, MINI, CLAUDE]) => (call: { query: Record<string, string> }) => {
  const items = byQuery[call.query.q ?? ''] ?? fallback;
  return { items, total: items.length };
};

describe('Enter in a registry picker', () => {
  it('picks the first, best-ranked result of what was typed, with nothing highlighted by hand', async () => {
    await renderTarget(ranked({ mini: [MINI, GPT] }));
    const input = modelInput();
    await click(input);
    await setInput(input, 'mini');
    await settle(450);
    expect(optionTexts()[0]).toContain('GPT-4o mini');

    const enter = await press(input, 'Enter');
    await settle(30);
    expect(enter.defaultPrevented).toBe(true);
    expect(seen.changes.map((c) => c.value)).toEqual(['gpt-4o-mini']);
    expect(input.value).toBe('GPT-4o mini');
  });

  it('shows what Enter will pick: the first result is highlighted once the answer is in', async () => {
    await renderTarget(ranked({ gpt: [GPT, MINI] }));
    const input = modelInput();
    await click(input);
    // The first page, with nothing typed, highlights nothing.
    expect(highlighted()).toBe(-1);
    await setInput(input, 'gpt');
    await settle(450);
    expect(highlighted()).toBe(0);
  });

  it('waits for a search that is still on its way instead of picking from the stale list', async () => {
    const waiting = new Map<string, (value: unknown) => void>();
    await renderTarget((call) =>
      call.query.q ? new Promise((resolve) => waiting.set(call.query.q, resolve)) : { items: [GPT, MINI], total: 2 },
    );
    const input = modelInput();
    await click(input);
    await setInput(input, 'mini');
    // Enter before the search has even been sent (the 250 ms pause) and while it is on its way.
    const early = await press(input, 'Enter');
    expect(early.defaultPrevented).toBe(true);
    await settle(450);
    expect([...waiting.keys()]).toEqual(['mini']);
    await press(input, 'Enter');
    // Nothing was picked from the stale first page (GPT-4o).
    expect(seen.changes).toEqual([]);

    waiting.get('mini')!({ items: [MINI], total: 1 });
    await settle(30);
    expect(seen.changes.map((c) => c.value)).toEqual(['gpt-4o-mini']);
  });

  it('forgets a waiting Enter when the words change', async () => {
    const waiting = new Map<string, (value: unknown) => void>();
    await renderTarget((call) =>
      call.query.q ? new Promise((resolve) => waiting.set(call.query.q, resolve)) : { items: [GPT, MINI], total: 2 },
    );
    const input = modelInput();
    await click(input);
    await setInput(input, 'mini');
    await press(input, 'Enter');
    await setInput(input, 'claude');
    await settle(450);
    waiting.get('mini')?.({ items: [MINI], total: 1 });
    waiting.get('claude')!({ items: [CLAUDE], total: 1 });
    await settle(30);
    expect(seen.changes).toEqual([]);
  });

  it('still picks the first result when the highlight could not be drawn', async () => {
    await renderTarget(ranked({ mini: [MINI, GPT] }));
    const input = modelInput();
    // Swallow the key that draws the highlight: Enter must not depend on it.
    const dispatch = input.dispatchEvent.bind(input);
    input.dispatchEvent = (event: Event) => (event instanceof KeyboardEvent && event.key === 'ArrowDown' ? true : dispatch(event));
    await click(input);
    await setInput(input, 'mini');
    await settle(450);
    expect(highlighted()).toBe(-1);

    const enter = await press(input, 'Enter');
    await settle(30);
    expect(enter.defaultPrevented).toBe(true);
    expect(seen.changes.map((c) => c.value)).toEqual(['gpt-4o-mini']);
  });

  it('does nothing special when nothing was typed', async () => {
    await renderTarget(ranked({}));
    const input = modelInput();
    await click(input);
    const enter = await press(input, 'Enter');
    await settle(30);
    expect(enter.defaultPrevented).toBe(false);
    expect(seen.changes).toEqual([]);
  });

  it('leaves a highlighted option to the arrow keys: Enter picks the one the person moved to', async () => {
    await renderTarget(ranked({ gpt: [GPT, MINI] }));
    const input = modelInput();
    await click(input);
    await setInput(input, 'gpt');
    await settle(450);
    expect(highlighted()).toBe(0);
    await press(input, 'ArrowDown');
    expect(highlighted()).toBe(1);
    await press(input, 'Enter');
    await settle(30);
    expect(seen.changes.map((c) => c.value)).toEqual(['gpt-4o-mini']);
  });

  it('picks nothing when the search found nothing', async () => {
    await renderTarget(ranked({ zzz: [] }));
    const input = modelInput();
    await click(input);
    await setInput(input, 'zzz');
    await settle(450);
    const enter = await press(input, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(seen.changes).toEqual([]);
  });

  it('never clears the choice that is held, by Enter or by choosing it again', async () => {
    await renderTarget(ranked({}), { initial: 'gpt-4o' });
    const input = modelInput();
    expect(input.value).toBe('GPT-4o');
    await click(input);
    await press(input, 'Enter');
    await settle(30);
    // ...and picking the option that is already chosen is not a way to clear it either.
    await click(options().find((o) => (o.textContent ?? '').startsWith('GPT-4o') && !(o.textContent ?? '').includes('mini'))!);
    await settle(30);
    expect(seen.changes).toEqual([]);
    expect(modelInput().value).toBe('GPT-4o');
  });

  it('puts the name back when the best match is the choice that is already held', async () => {
    await renderTarget(ranked({ gpt: [GPT, MINI] }), { initial: 'gpt-4o' });
    const input = modelInput();
    await click(input);
    await setInput(input, 'gpt');
    await settle(450);
    expect(input.value).toBe('gpt');
    await press(input, 'Enter');
    await settle(30);
    // Nothing changed, so Mantine writes nothing back: the words typed to find it must not stay in the box.
    expect(seen.changes).toEqual([]);
    expect(input.value).toBe('GPT-4o');
    // ...and that is not a question for the server either.
    expect(api.to('GET', SEARCH).map((c) => c.query.q)).not.toContain('GPT-4o');
  });

  it('picks the registry\'s best row before the words as typed, for a name an SDK may report', async () => {
    const agent = { type: 'agent', id: 'a1', key: 'billing-ab12', name: 'Billing bot', ...project('proj-1', 'Retail'), status: null, attributes: [] };
    await renderTarget(ranked({ bill: [agent] }, []), { domain: 'tracing' });
    const input = q<HTMLInputElement>('input[aria-label="Search agents or type a name"]')!;
    await click(input);
    await setInput(input, 'bill');
    await settle(450);
    // The row first, the typed words after it.
    expect(optionTexts()).toEqual(['Billing botbilling-ab12 · Retail', 'Use "bill"']);
    await press(input, 'Enter');
    await settle(30);
    expect(seen.changes.map((c) => c.value)).toEqual(['Billing bot']);
  });
});

describe('typing into a registry picker that holds a choice', () => {
  it('selects the shown name first, so the first character replaces it', async () => {
    await renderTarget(ranked({}), { initial: 'gpt-4o' });
    const input = modelInput();
    await click(input);
    input.setSelectionRange(input.value.length, input.value.length);
    await press(input, 'x');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('does not select a text that is the person\'s own words, nor for keys that are not text', async () => {
    await renderTarget(ranked({}));
    const input = modelInput();
    await click(input);
    await setInput(input, 'gp');
    input.setSelectionRange(2, 2);
    await press(input, 'x');
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
    // Keys that are not text leave the box alone, whatever it holds.
    await press(input, 'ArrowLeft');
    await press(input, 'Backspace');
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
  });

  it('searches for what was typed, never for the name plus it', async () => {
    await renderTarget(ranked({ x: [CLAUDE] }), { initial: 'gpt-4o' });
    const input = modelInput();
    expect(input.value).toBe('GPT-4o');
    await click(input);
    // The keyboard path selects the name, so the character replaces it...
    await setInput(input, 'x');
    await settle(450);
    expect(api.to('GET', SEARCH).map((c) => c.query.q)).toContain('x');
    expect(api.to('GET', SEARCH).map((c) => c.query.q)).not.toContain('GPT-4ox');
    expect(optionTexts()).toEqual(['Claude Sonnetclaude-sonnet · Retail']);
  });

  it('repairs an edit that only added to the name (a soft keyboard, a script)', async () => {
    await renderTarget(ranked({ x: [CLAUDE] }), { initial: 'gpt-4o' });
    const input = modelInput();
    await click(input);
    await setInput(input, 'GPT-4ox');
    await settle(450);
    expect(input.value).toBe('x');
    const asked = api.to('GET', SEARCH).map((c) => c.query.q);
    expect(asked).toContain('x');
    expect(asked).not.toContain('GPT-4ox');
    expect(asked).not.toContain('gpt-4ox');
  });

  it('keeps the name when nothing was typed, and puts it back on blur', async () => {
    await renderTarget(ranked({ x: [CLAUDE] }), { initial: 'gpt-4o' });
    const input = modelInput();
    await act(async () => {
      input.focus();
    });
    await click(input);
    await setInput(input, 'x');
    await settle(450);
    await act(async () => {
      input.blur();
    });
    await settle(30);
    expect(input.value).toBe('GPT-4o');
    // Putting the name back is not a question for the server.
    expect(api.to('GET', SEARCH).map((c) => c.query.q)).not.toContain('GPT-4o');
  });

  it('does not offer the saved value among the results of a search for something else', async () => {
    await renderTarget(ranked({ claude: [CLAUDE] }), { initial: 'gpt-4o' });
    const input = modelInput();
    await click(input);
    // Nothing typed: the saved value is there (it may be beyond the first page).
    expect(optionTexts().some((t) => t.startsWith('GPT-4o'))).toBe(true);
    await setInput(input, 'claude');
    await settle(450);
    expect(optionTexts()).toEqual(['Claude Sonnetclaude-sonnet · Retail']);
  });

  it('pastes over the name too', async () => {
    await renderTarget(ranked({}), { initial: 'gpt-4o' });
    const input = modelInput();
    await click(input);
    input.setSelectionRange(2, 2);
    await act(async () => {
      input.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  });
});

// ── the principal picker (people, groups, tokens, agents) ───────────────────

const PRINCIPALS = '/api/iam/principals';
const person = (id: string, label: string, sublabel = `${id}@acme.test`) => ({ type: 'user', id, label, sublabel });
const ANN = person('u-ann', 'Ann Lee');
const BOB = person('u-bob', 'Bob Ray');

function PrincipalHarness(props: { type: PickerType; initial?: string; seen: Array<{ value?: string; option?: PickerOption }> }) {
  const [value, setValue] = useState<string | undefined>(props.initial);
  return createElement(PrincipalSelect, {
    type: props.type,
    value,
    valueLabel: undefined,
    placeholder: 'Pick one',
    nothingFoundMessage: 'Nobody',
    onChange: (next: string | undefined, option?: PickerOption) => {
      props.seen.push({ value: next, option });
      setValue(next);
    },
  });
}

let picked: Array<{ value?: string; option?: PickerOption }>;
const principalInput = () => q<HTMLInputElement>('input[placeholder="Pick one"]')!;

async function renderPrincipal(
  handler: (call: { query: Record<string, string> }) => unknown,
  options: { type?: PickerType; initial?: string } = {},
) {
  picked = [];
  api = installApiMock([
    ['GET', PRINCIPALS, handler as never],
    ['GET', /^\/api\/iam\/principals\/user\/[^/]+$/, (call) => ({ principal: { type: 'user', id: call.path.split('/').pop(), label: call.path.endsWith('u-ann') ? 'Ann Lee' : 'Somebody' } })],
  ]);
  mounted = await mount(createElement(PrincipalHarness, { type: options.type ?? 'user', initial: options.initial, seen: picked }));
  await settle(30);
}

const people = (byQuery: Record<string, unknown[]>, fallback: unknown[] = [ANN, BOB]) => (call: { query: Record<string, string> }) => ({
  items: byQuery[call.query.q ?? ''] ?? fallback,
  nextCursor: null,
});

describe('the principal picker', () => {
  it('asks for the first page as soon as it shows, then for what is typed after a pause', async () => {
    await renderPrincipal(people({ bo: [BOB] }));
    expect(api.to('GET', PRINCIPALS).map((c) => c.query.q)).toEqual([undefined]);
    const input = principalInput();
    await click(input);
    await setInput(input, 'b');
    await setInput(input, 'bo');
    expect(api.to('GET', PRINCIPALS)).toHaveLength(1);
    await settle(450);
    expect(api.to('GET', PRINCIPALS).map((c) => c.query.q)).toEqual([undefined, 'bo']);
    expect(optionTexts()).toEqual(['Bob Rayu-bob@acme.test']);
  });

  it('picks the first result on Enter, and highlights it first', async () => {
    await renderPrincipal(people({ lee: [ANN, BOB] }));
    const input = principalInput();
    await click(input);
    await setInput(input, 'lee');
    await settle(450);
    expect(highlighted()).toBe(0);
    await press(input, 'Enter');
    await settle(30);
    expect(picked.map((p) => p.value)).toEqual(['u-ann']);
    expect(input.value).toBe('Ann Lee');
  });

  it('waits for the answer when Enter comes first', async () => {
    const waiting = new Map<string, (value: unknown) => void>();
    await renderPrincipal((call) =>
      call.query.q ? new Promise((resolve) => waiting.set(call.query.q, resolve)) : { items: [ANN, BOB], nextCursor: null },
    );
    const input = principalInput();
    await click(input);
    await setInput(input, 'bob');
    const enter = await press(input, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    await settle(450);
    expect(picked).toEqual([]);
    waiting.get('bob')!({ items: [BOB], nextCursor: null });
    await settle(30);
    expect(picked.map((p) => p.value)).toEqual(['u-bob']);
  });

  it('starts a fresh search when typing into a box that holds a choice', async () => {
    await renderPrincipal(people({ bo: [BOB] }));
    const input = principalInput();
    await click(input);
    await click(options()[0]);
    await settle(30);
    expect(picked.map((p) => p.value)).toEqual(['u-ann']);
    expect(input.value).toBe('Ann Lee');
    // Choosing and the name Mantine writes into the box are not questions for the server.
    await settle(450);
    expect(api.to('GET', PRINCIPALS).map((c) => c.query.q)).toEqual([undefined]);

    await click(input);
    await setInput(input, 'Ann Leebo');
    await settle(450);
    expect(input.value).toBe('bo');
    expect(api.to('GET', PRINCIPALS).map((c) => c.query.q)).toEqual([undefined, 'bo']);
    expect(optionTexts()).toEqual(['Bob Rayu-bob@acme.test']);
  });

  it('shows the whole first page again when it is opened with a choice held (the name is not a filter)', async () => {
    await renderPrincipal(people({ 'Ann Lee': [ANN] }), { initial: 'u-ann' });
    expect(principalInput().value).toBe('Ann Lee');
    await click(principalInput());
    await settle(30);
    expect(optionTexts()).toHaveLength(2);
    expect(api.to('GET', PRINCIPALS).map((c) => c.query.q)).not.toContain('Ann Lee');
  });

  it('puts the name back when the best match is the choice that is already held', async () => {
    await renderPrincipal(people({ ann: [ANN, BOB] }), { initial: 'u-ann' });
    const input = principalInput();
    await click(input);
    await setInput(input, 'ann');
    await settle(450);
    await press(input, 'Enter');
    await settle(30);
    expect(picked).toEqual([]);
    expect(input.value).toBe('Ann Lee');
  });

  it('does not clear the choice when it is chosen again', async () => {
    await renderPrincipal(people({}), { initial: 'u-ann' });
    await click(principalInput());
    await click(options().find((o) => (o.textContent ?? '').startsWith('Ann Lee'))!);
    await settle(30);
    expect(picked).toEqual([]);
    expect(principalInput().value).toBe('Ann Lee');
  });

  it('empties the box when the kind of target changes', async () => {
    let type: PickerType = 'user';
    function Switch() {
      const [t, setT] = useState<PickerType>(type);
      return createElement(
        'div',
        null,
        createElement('button', { id: 'to-groups', onClick: () => setT('group') }, 'groups'),
        createElement(PrincipalHarness, { type: t, seen: picked }),
      );
    }
    picked = [];
    api = installApiMock([['GET', PRINCIPALS, people({}) as never]]);
    mounted = await mount(createElement(Switch));
    await settle(30);
    const input = principalInput();
    await click(input);
    await setInput(input, 'an');
    await settle(450);
    await click(q('#to-groups'));
    await settle(450);
    expect(principalInput().value).toBe('');
    expect(api.to('GET', PRINCIPALS).map((c) => [c.query.type, c.query.q])).toContainEqual(['group', undefined]);
    type = 'user';
  });
});

// ── a list the browser holds ────────────────────────────────────────────────

const PROJECTS = [
  { value: 'p1', label: 'İstanbul Şubesi' },
  { value: 'p2', label: 'Isparta Şubesi' },
  { value: 'p3', label: 'Retail (retail)' },
];

function ListHarness(props: { seen: Array<string | null>; initial?: string | null }) {
  const [value, setValue] = useState<string | null>(props.initial ?? null);
  return createElement(SearchableSelect, {
    data: PROJECTS,
    value,
    placeholder: 'Choose a project',
    onChange: (next: string | null) => {
      props.seen.push(next);
      setValue(next);
    },
  });
}

describe('a list the browser holds (the project field)', () => {
  const listInput = () => q<HTMLInputElement>('input[placeholder="Choose a project"]')!;
  let changes: Array<string | null>;

  async function renderList(initial?: string) {
    changes = [];
    mounted = await mount(createElement(ListHarness, { seen: changes, initial }));
    await settle(30);
  }

  it('finds a Turkish name whatever the case of the typed words', async () => {
    await renderList();
    await click(listInput());
    await setInput(listInput(), 'ISTANBUL');
    await settle(30);
    expect(optionTexts()).toEqual(['İstanbul Şubesi']);
    await setInput(listInput(), 'ıspart');
    await settle(30);
    expect(optionTexts()).toEqual(['Isparta Şubesi']);
    await setInput(listInput(), 'ŞUBESİ');
    await settle(30);
    expect(optionTexts()).toEqual(['İstanbul Şubesi', 'Isparta Şubesi']);
  });

  it('highlights the first match so Enter picks it', async () => {
    await renderList();
    await click(listInput());
    await setInput(listInput(), 'şube');
    await settle(30);
    expect(highlighted()).toBe(0);
    await press(listInput(), 'Enter');
    await settle(30);
    expect(changes).toEqual(['p1']);
    expect(listInput().value).toBe('İstanbul Şubesi');
  });

  it('starts a fresh search when typing into a box that holds a choice', async () => {
    await renderList('p3');
    expect(listInput().value).toBe('Retail (retail)');
    await click(listInput());
    // Showing the name filters nothing...
    expect(optionTexts()).toHaveLength(3);
    // ...and the first thing typed replaces it.
    await setInput(listInput(), 'Retail (retail)ısp');
    await settle(30);
    expect(listInput().value).toBe('ısp');
    expect(optionTexts()).toEqual(['Isparta Şubesi']);
  });

  it('does not clear the choice when it is chosen again', async () => {
    await renderList('p3');
    await click(listInput());
    await click(options().find((o) => o.textContent === 'Retail (retail)')!);
    await settle(30);
    expect(changes).toEqual([]);
    expect(listInput().value).toBe('Retail (retail)');
  });
});
