// @vitest-environment jsdom
/**
 * Escape inside the full-screen form: with a dropdown open (a Select's list, a menu), the first Escape
 * closes the list and keeps the form with everything typed into it; the next one closes the form.
 *
 * Mantine marks the control with `data-mantine-stop-propagation` while its list is open (its own modals
 * look at the same mark), so the test stands in for an open list with that mark instead of mounting a
 * Select, which is slow in jsdom; a contract test below keeps the mark from disappearing in an upgrade.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, act } from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import FormShell from '@/components/common/ui/FormShell';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(onClose: () => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(MantineProvider, null, h(FormShell, {
    open: true,
    onClose,
    title: 'Add people',
    children: h('input', { 'aria-label': 'Project', defaultValue: '' }),
  }))));
}

const field = () => document.body.querySelector('input[aria-label="Project"]') as HTMLInputElement;
const escapeFrom = (target: EventTarget) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

describe('FormShell Escape with a dropdown open', () => {
  it('leaves the form open while the control carries the open-list mark, and closes it afterwards', () => {
    const onClose = vi.fn();
    mount(onClose);

    field().setAttribute('data-mantine-stop-propagation', 'true');
    escapeFrom(field());
    expect(onClose).not.toHaveBeenCalled();

    field().removeAttribute('data-mantine-stop-propagation');
    escapeFrom(field());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats a focused item inside an open list the same way', () => {
    const onClose = vi.fn();
    mount(onClose);
    const item = document.createElement('div');
    item.setAttribute('data-mantine-stop-propagation', 'true');
    const inner = document.createElement('span');
    item.appendChild(inner);
    document.body.appendChild(item);
    try {
      escapeFrom(inner);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      item.remove();
    }
  });

  it('closes the form on Escape from any other field, and from the window itself', () => {
    const onClose = vi.fn();
    mount(onClose);
    escapeFrom(field());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('relies on a mark Mantine still sets while a combobox list is open', () => {
    const require = createRequire(import.meta.url);
    const core = require.resolve('@mantine/core');
    const target = core.replace(/[\\/]cjs[\\/].*$/, '/esm/components/Combobox/use-combobox-target-props/use-combobox-target-props.mjs');
    expect(readFileSync(target, 'utf8')).toContain('data-mantine-stop-propagation');
  });
});
