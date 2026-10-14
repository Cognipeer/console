/**
 * The row "…" menu of every list: an action that carries a label AND `divider`
 * is a divider followed by the item (Webhooks → Delete, OCR jobs → Delete),
 * while a bare `{ divider: true }` stays just a divider.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The grid prefetches through the Next router, which a static render has none of.
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { MantineProvider, Menu } from '@mantine/core';
import { RowActionItems, type DataGridRowAction } from '@/components/common/ui/DataGrid';

(globalThis as { React?: typeof React }).React = React;

type Row = { id: string };

/** The open dropdown, in the page (no portal) so a static render has it. */
function renderMenu(actions: DataGridRowAction<Row>[], row: Row = { id: 'r1' }) {
  return renderToStaticMarkup(
    h(MantineProvider, null,
      h(Menu, { opened: true, withinPortal: false },
        h(Menu.Target, null, h('button', null, 'open')),
        h(Menu.Dropdown, null, h(RowActionItems<Row>, { actions, row })))),
  );
}

const dividers = (html: string) => (html.match(/mantine-Menu-divider/g) ?? []).length;
const items = (html: string) => (html.match(/role="menuitem"/g) ?? []).length;
const noop = () => undefined;

describe('RowActionItems', () => {
  it('keeps the item of an action that also asks for a divider, after the divider', () => {
    const html = renderMenu([
      { id: 'edit', label: 'Edit', onClick: noop },
      { id: 'delete', label: 'Delete', color: 'red', divider: true, onClick: noop },
    ]);
    expect(html).toContain('Edit');
    expect(html).toContain('Delete');
    expect(dividers(html)).toBe(1);
    expect(items(html)).toBe(2);
    expect(html.indexOf('mantine-Menu-divider')).toBeGreaterThan(html.indexOf('Edit'));
    expect(html.indexOf('mantine-Menu-divider')).toBeLessThan(html.indexOf('Delete'));
  });

  it('still renders a bare { divider: true } as a divider and nothing else', () => {
    const html = renderMenu([
      { id: 'edit', label: 'Edit', onClick: noop },
      { divider: true },
      { id: 'delete', label: 'Delete', onClick: noop },
    ]);
    expect(dividers(html)).toBe(1);
    expect(items(html)).toBe(2);
  });

  it('leaves out hidden actions, and a divider asked for by a hidden one', () => {
    const html = renderMenu([
      { id: 'edit', label: 'Edit', onClick: noop },
      { id: 'delete', label: 'Delete', divider: true, hidden: (row) => row.id === 'r1', onClick: noop },
    ]);
    expect(html).not.toContain('Delete');
    expect(dividers(html)).toBe(0);
    expect(items(html)).toBe(1);
  });

  it('marks a disabled action disabled', () => {
    const html = renderMenu([{ id: 'delete', label: 'Delete', divider: true, disabled: true, onClick: noop }]);
    expect(html).toContain('Delete');
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
