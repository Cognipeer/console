// @vitest-environment jsdom
/**
 * A disabled control that says why: the row "…" menu of a list (`disabledReason` on a DataGridRowAction) and
 * the footer's primary button of a form (`disabledReason` on FormShell's primaryAction). The reason is shown
 * in a tooltip, and a native `disabled` swallows the hover the tooltip listens to, so a control that carries
 * one is only marked disabled (`data-disabled`) and its click is ignored. One without a reason keeps the
 * native `disabled`.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The grid prefetches through the Next router, which a DOM render has none of.
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { Menu } from '@mantine/core';
import { RowActionItems, type DataGridRowAction } from '@/components/common/ui/DataGrid';
import FormShell from '@/components/common/ui/FormShell';
import { click, installDomStubs, mount, q, qa, type Mounted } from '../helpers/iamCenterUi';

beforeAll(() => {
  installDomStubs();
});

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const item of mounted.splice(0)) await item.unmount();
});

type Row = { id: string };

/** The open dropdown, in the page (no portal) so a DOM render has it. */
async function showMenu(actions: DataGridRowAction<Row>[]) {
  mounted.push(
    await mount(
      h(Menu, { opened: true, withinPortal: false },
        h(Menu.Target, null, h('button', null, 'open')),
        h(Menu.Dropdown, null, h(RowActionItems<Row>, { actions, row: { id: 'r1' } }))),
    ),
  );
  return qa<HTMLButtonElement>('[role="menuitem"]');
}

describe('a row action that says why it is disabled', () => {
  it('is marked disabled, not natively disabled, so the tooltip still gets the hover; its click does nothing', async () => {
    const onClick = vi.fn();
    const [item] = await showMenu([{ id: 'run', label: 'Run', disabled: true, disabledReason: 'Needs Write access', onClick }]);
    expect(item!.getAttribute('data-disabled')).toBe('true');
    expect(item!.getAttribute('aria-disabled')).toBe('true');
    expect(item!.hasAttribute('disabled')).toBe(false);
    await click(item);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('works when the disabled state is decided per row', async () => {
    const onClick = vi.fn();
    const [item] = await showMenu([
      { id: 'run', label: 'Run', disabled: (row) => row.id === 'r1', disabledReason: 'Needs Write access', onClick },
    ]);
    expect(item!.getAttribute('data-disabled')).toBe('true');
    await click(item);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('runs normally while it is enabled, even though it carries a reason', async () => {
    const onClick = vi.fn();
    const [item] = await showMenu([{ id: 'run', label: 'Run', disabled: false, disabledReason: 'Needs Write access', onClick }]);
    expect(item!.hasAttribute('data-disabled')).toBe(false);
    expect(item!.hasAttribute('aria-disabled')).toBe(false);
    expect(item!.hasAttribute('disabled')).toBe(false);
    await click(item);
    expect(onClick).toHaveBeenCalledWith({ id: 'r1' });
  });

  it('keeps the native disabled for an action without a reason', async () => {
    const onClick = vi.fn();
    const [item] = await showMenu([{ id: 'run', label: 'Run', disabled: true, onClick }]);
    expect(item!.hasAttribute('disabled')).toBe(true);
    await click(item);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('the primary button of a form that says why it is disabled', () => {
  async function showForm(primaryAction: { disabled?: boolean; disabledReason?: string; onClick: () => void }) {
    mounted.push(
      await mount(
        h(FormShell, {
          open: true,
          onClose: () => undefined,
          title: 'T',
          primaryAction: { label: 'Save', ...primaryAction },
          children: h('div', null, 'body'),
        }),
      ),
    );
    return q<HTMLButtonElement>('.form-footer button:last-child')!;
  }

  it('is marked disabled, not natively disabled, so the tooltip still gets the hover; its click does nothing', async () => {
    const onClick = vi.fn();
    const button = await showForm({ disabled: true, disabledReason: 'Needs Write access', onClick });
    expect(button.textContent).toBe('Save');
    expect(button.getAttribute('data-disabled')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    await click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('saves normally while it is enabled, even though it carries a reason', async () => {
    const onClick = vi.fn();
    const button = await showForm({ disabled: false, disabledReason: 'Needs Write access', onClick });
    expect(button.hasAttribute('data-disabled')).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    await click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the native disabled for a button without a reason, and an enabled one as it was', async () => {
    const onClick = vi.fn();
    const disabled = await showForm({ disabled: true, onClick });
    expect(disabled.hasAttribute('disabled')).toBe(true);
    await click(disabled);
    expect(onClick).not.toHaveBeenCalled();
    await mounted.pop()!.unmount();

    const enabled = await showForm({ onClick });
    expect(enabled.hasAttribute('disabled')).toBe(false);
    await click(enabled);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
