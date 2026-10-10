// @vitest-environment jsdom
/**
 * The shared list and form components speak the language of the page. The people and token lists are built on
 * DataGrid and every create / edit screen on FormShell; their own labels ("3 selected", "Refresh", "Rows per
 * page", "Prev" / "Next", "Close", "Press ESC to cancel") used to be English whatever the locale was.
 */
import { createElement, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomStubs, mount, q, qa, text, type Mounted } from '../helpers/iamCenterUi';
import { messages } from '@/lib/i18n/messages';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import DataGrid from '@/components/common/ui/DataGrid';
import FormShellComponent from '@/components/common/ui/FormShell';

/** FormShell with its `children` optional for createElement's typing (the component itself requires them). */
const FormShell = FormShellComponent as unknown as ComponentType<Omit<ComponentProps<typeof FormShellComponent>, 'children'> & { children?: ReactNode }>;

let mounted: Mounted | undefined;
beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

type Row = { id: string; name: string };
const ROWS: Row[] = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];

function grid() {
  return createElement(DataGrid<Row>, {
    records: ROWS,
    rowKey: (row) => row.id,
    columns: [{ key: 'name', label: 'Name', render: (row) => row.name }],
    selectable: true,
    selected: new Set(['a', 'b']),
    onSelectionChange: () => {},
    bulkActions: [{ label: 'Do it', onClick: () => {} }],
    rowActions: () => [{ id: 'open', label: 'Open', onClick: () => {} }],
    onRefresh: () => {},
    pagination: { page: 2, onPageChange: () => {}, pageSize: 25, onPageSizeChange: () => {}, pageSizeOptions: [25, 50], hasMore: true },
  });
}

const labelsOf = () => qa('[aria-label]').map((el) => el.getAttribute('aria-label'));

describe('DataGrid', () => {
  it('speaks English by default', async () => {
    mounted = await mount(grid(), 'en');
    expect(text()).toContain('2 selected');
    expect(text()).toContain('Prev');
    expect(text()).toContain('Next');
    expect(q<HTMLOptionElement>('option')!.textContent).toBe('25 / page');
    expect(labelsOf()).toEqual(expect.arrayContaining(['Refresh', 'Select all rows', 'Select row', 'Actions', 'Rows per page']));
  });

  it('speaks Turkish under the Turkish locale: the toolbar, the pager, the page size and every accessible name', async () => {
    mounted = await mount(grid(), 'tr');
    expect(text()).toContain('2 seçili');
    expect(text()).toContain('Önceki');
    expect(text()).toContain('Sonraki');
    expect(q<HTMLOptionElement>('option')!.textContent).toBe('25 / sayfa');
    expect(labelsOf()).toEqual(expect.arrayContaining(['Yenile', 'Tüm satırları seç', 'Satırı seç', 'İşlemler', 'Sayfa başına satır']));
    // nothing of the English left in the grid's own chrome
    for (const english of ['selected', 'Prev', 'Next', 'Refresh', 'Select all rows', 'Select row', 'Rows per page', '/ page']) {
      expect(text(), english).not.toContain(english);
      expect(labelsOf().join('|'), english).not.toContain(english);
    }
  });

  it('names the row menu trigger (it had no accessible name)', async () => {
    mounted = await mount(grid(), 'en');
    expect(qa('button[aria-label="Actions"]').length).toBe(ROWS.length);
  });
});

describe('FormShell', () => {
  const shell = () => createElement(FormShell, { open: true, onClose: () => {}, title: 'New group' }, createElement('div', null, 'body'));

  it('speaks English by default', async () => {
    mounted = await mount(shell(), 'en');
    expect(q('[aria-label="Close"]')).not.toBeNull();
    expect(text()).toContain('Press ESC to cancel');
    expect(text()).toContain('Cancel');
  });

  it('speaks Turkish under the Turkish locale', async () => {
    mounted = await mount(shell(), 'tr');
    expect(q('[aria-label="Kapat"]')).not.toBeNull();
    expect(text()).toContain('Vazgeçmek için ESC tuşuna basın');
    expect(text()).toContain('Vazgeç');
    expect(text()).not.toContain('Press');
    expect(q('[aria-label="Close"]')).toBeNull();
  });

  it('keeps a label the caller chose', async () => {
    mounted = await mount(
      createElement(FormShell, { open: true, onClose: () => {}, title: 'T', secondaryAction: { label: 'Back', onClick: () => {} } }, createElement('div')),
      'tr',
    );
    expect(text()).toContain('Back');
    expect(text()).not.toContain('Vazgeç ');
  });
});

describe('the two namespaces', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it.each(['dataGrid', 'formShell'] as const)('%s has the same keys and placeholders in English and Turkish, all translated', (ns) => {
    const en = messages.en[ns] as Record<string, string>;
    const tr = messages.tr[ns] as Record<string, string>;
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(placeholders(tr[key]!), `${ns}.${key}`).toEqual(placeholders(en[key]!));
      if (!/^\{count\} \/ (page|sayfa)$/.test(en[key]!)) expect(tr[key], `${ns}.${key} is left in English`).not.toBe(en[key]);
    }
  });
});
