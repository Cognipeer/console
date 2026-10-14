// @vitest-environment jsdom
/**
 * Configure → Files → "Allowed file types", driven the way a person drives it:
 * typed into the field, a comma or Enter finishing a type. Each finished type
 * becomes a tag and the list is handed up as the setting; emptying the list
 * clears it, so an agent that never restricts types stores nothing.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { AgentFilesPanelView } from '@/components/agents/studio/AgentFilesPanel';
import type { AttachmentBucketOption, AttachmentsSettings } from '@/components/agents/studio/filesSettings';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Mantine reads these from the browser.
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const bucket: AttachmentBucketOption = {
  key: 'docs', name: 'Docs', providerKey: 'builtin', providerLabel: 'Built-in', driver: 's3',
  bucketStatus: 'active', providerStatus: 'active', usable: true, localDisk: false,
};

/** Sets an input's value the way the browser does, so React sees the change. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Presses a key in an input — Mantine's tags input finishes a tag on a key, not on the typed character. */
function press(input: HTMLInputElement, key: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function mount(initial?: AttachmentsSettings) {
  const seen: Array<AttachmentsSettings | undefined> = [];
  function Harness() {
    const [value, setValue] = useState<AttachmentsSettings | undefined>(initial ?? { enabled: true, bucketKey: 'docs' });
    return h(MantineProvider, null, h(AgentFilesPanelView, {
      value,
      onChange: (next: AttachmentsSettings | undefined) => { seen.push(next); setValue(next); },
      agentKey: 'support',
      buckets: { status: 'ready', buckets: [bucket] },
    }));
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness)));
  const field = () => container!.querySelector<HTMLInputElement>('input.mantine-TagsInput-inputField')!;
  return { field, seen };
}

describe('Allowed file types, typed into the Files section', () => {
  it('turns each finished type into a tag, keeps the earlier ones, and clears the setting with the last tag', () => {
    const { field, seen } = mount();
    expect(field()).not.toBeNull();

    type(field(), 'application/pdf');
    press(field(), ',');
    expect(seen.at(-1)?.allowedMimeTypes).toEqual(['application/pdf']);
    expect(container!.textContent).toContain('application/pdf');

    type(field(), 'image/*');
    press(field(), 'Enter');
    expect(seen.at(-1)?.allowedMimeTypes).toEqual(['application/pdf', 'image/*']);

    const removes = () => Array.from(container!.querySelectorAll<HTMLElement>('.mantine-Pill-remove'));
    expect(removes()).toHaveLength(2);
    act(() => { removes()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(seen.at(-1)?.allowedMimeTypes).toEqual(['image/*']);
    act(() => { removes()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // Nothing restricted = nothing stored for it.
    expect(seen.at(-1)).toEqual({ enabled: true, bucketKey: 'docs' });
  }, 60_000);
});
