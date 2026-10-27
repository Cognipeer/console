// @vitest-environment jsdom
/**
 * The project switcher of the top bar, rendered for real (jsdom + Mantine):
 *
 *  - opening it puts the focus in a search box;
 *  - typing filters by name or key (Turkish-aware folding) and highlights the first match;
 *  - Enter switches to the highlighted project, the arrow keys move the highlight;
 *  - Enter on an untouched search, or on a search with no match, switches nothing.
 */
import { act, createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { click, installApiMock, installDomStubs, mount, q, qa, setInput, settle, text, type ApiMock, type Mounted } from '../helpers/iamCenterUi';
import ProjectPill from '@/components/projects/ProjectPill';

beforeAll(() => installDomStubs());

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PROJECTS = [
  { _id: 'p-default', name: 'Default Project', key: 'default' },
  { _id: 'p-istanbul', name: 'İstanbul Ofisi', key: 'ist-office' },
  { _id: 'p-sales', name: 'Sales', key: 'sales' },
  { _id: 'p-support', name: 'Support', key: 'cs-desk' },
];

let mounted: Mounted;
let api: ApiMock;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
});

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

async function open() {
  api = installApiMock([
    ['GET', '/api/projects', () => ({ projects: PROJECTS, activeProjectId: 'p-default' })],
    ['POST', '/api/projects/active', () => ({ ok: true })],
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted = await mount(createElement(QueryClientProvider, { client }, createElement(ProjectPill)));
  await settle(200);
  await click(q('button[aria-label="Switch project"]'));
  await settle(200);
}

const search = () => q<HTMLInputElement>('input[aria-label="Search projects"]')!;
const optionTexts = () => qa('[role="option"]').map((o) => o.textContent ?? '');
const optionNames = () => optionTexts().map((t) => PROJECTS.find((p) => t.startsWith(p.name))?.name);
const highlighted = () => qa('[role="option"]').find((o) => o.hasAttribute('data-combobox-selected'))?.textContent ?? null;
const switched = () => api.to('POST', '/api/projects/active').map((c) => (c.body as { projectId: string }).projectId);

async function press(key: string) {
  await act(async () => {
    search().dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  });
  await settle(100);
}

describe('the project switcher search', () => {
  it('opens with the focus in the search box and lists every project', async () => {
    await open();
    expect(search()).toBeTruthy();
    expect(document.activeElement).toBe(search());
    expect(optionTexts()).toHaveLength(4);
    expect(highlighted()).toBeNull();
  });

  it('filters by name or key and highlights the first match', async () => {
    await open();
    await setInput(search(), 's');
    await settle(100);
    expect(optionNames()).toEqual(['İstanbul Ofisi', 'Sales', 'Support']);
    expect(highlighted()).toContain('İstanbul');

    await setInput(search(), 'cs-');
    await settle(100);
    expect(optionTexts()).toHaveLength(1);
    expect(highlighted()).toContain('Support');
  });

  it('matches Turkish letters the folded way ("istanbul" finds "İstanbul")', async () => {
    await open();
    await setInput(search(), 'istanbul');
    await settle(100);
    expect(optionTexts()).toHaveLength(1);
    expect(highlighted()).toContain('İstanbul Ofisi');
  });

  it('switches to the highlighted project on Enter', async () => {
    await open();
    await setInput(search(), 'sal');
    await settle(100);
    await press('Enter');
    await settle(200);
    expect(switched()).toEqual(['p-sales']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('moves the highlight with the arrow keys before Enter', async () => {
    await open();
    await setInput(search(), 's');
    await settle(100);
    await press('ArrowDown');
    expect(highlighted()).toContain('Sales');
    await press('Enter');
    await settle(200);
    expect(switched()).toEqual(['p-sales']);
  });

  it('switches nothing on Enter with an empty search or no match', async () => {
    await open();
    await press('Enter');
    await setInput(search(), 'nothing-like-this');
    await settle(100);
    expect(text()).toContain('No project found');
    await press('Enter');
    await settle(200);
    expect(switched()).toEqual([]);
  });
});
