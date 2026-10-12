// @vitest-environment jsdom
/**
 * The full-screen form's "Press ESC to cancel" hint: shown while Escape closes
 * the overlay, gone when the overlay ignores Escape (`disableEscape`, as the
 * one-time webhook secret does so it cannot be dismissed by accident).
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, act } from 'react';
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

function mount(props: { disableEscape?: boolean; onClose?: () => void }) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(MantineProvider, null, h(FormShell, {
    open: true,
    onClose: props.onClose ?? (() => undefined),
    title: 'Webhook created',
    disableEscape: props.disableEscape ?? false,
    children: h('div', null, 'body'),
  }))));
}

const pressEscape = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
const hint = () => document.body.querySelector('.form-header-hint');

describe('FormShell Escape hint', () => {
  it('tells the person Escape cancels, and Escape does', () => {
    const onClose = vi.fn();
    mount({ onClose });
    expect(hint()?.textContent).toContain('ESC');
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows no hint when Escape is disabled, and Escape does nothing', () => {
    const onClose = vi.fn();
    mount({ disableEscape: true, onClose });
    expect(document.body.querySelector('.form-header')).not.toBeNull();
    expect(hint()).toBeNull();
    expect(document.body.textContent).not.toContain('to cancel');
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });
});
