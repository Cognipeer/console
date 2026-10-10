// @vitest-environment jsdom
/**
 * Configure → Execution → Attachments → "Allowed file types", driven the way a
 * person drives it: typed key by key. The field keeps what is typed (the comma
 * and the space that start the next type), hands the parsed list up as it goes,
 * and tidies the text when it loses focus.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import AgentExecutionPanel from '@/components/agents/studio/AgentExecutionPanel';
import { parseMimeTypes } from '@/components/agents/session/sessionAttachmentsUi';
import type { IAgentAttachmentsConfig } from '@/lib/database/provider/types.domain';

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
  // The panel asks for the server's ceilings on mount.
  (globalThis as { fetch?: unknown }).fetch = () => Promise.resolve({ ok: false, json: async () => null });
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Sets an input's value the way the browser does, so React sees the change. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function mount(initial?: IAgentAttachmentsConfig) {
  const seen: Array<IAgentAttachmentsConfig | undefined> = [];
  function Harness() {
    const [attachments, setAttachments] = useState<IAgentAttachmentsConfig | undefined>(initial);
    return h(MantineProvider, null, h(AgentExecutionPanel, {
      value: undefined,
      onChange: () => undefined,
      attachments,
      onAttachmentsChange: (next) => { seen.push(next); setAttachments(next); },
    }));
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness)));
  const field = () => container!.querySelector<HTMLInputElement>('input[placeholder="application/pdf, image/*"]')!;
  return { field, seen };
}

describe('Allowed file types, typed key by key', () => {
  it('keeps the comma and the space, so a second type can be typed', () => {
    const { field, seen } = mount();
    let text = '';
    for (const char of 'application/pdf, image/*') {
      text += char;
      type(field(), text);
      // What is on screen is what was typed — the separator is not swallowed.
      expect(field().value).toBe(text);
    }
    expect(seen.at(-1)?.allowedMimeTypes).toEqual(['application/pdf', 'image/*']);
  });

  it('stores the list as it is typed, with a trailing separator ignored', () => {
    const { field, seen } = mount();
    type(field(), 'application/pdf, ');
    expect(field().value).toBe('application/pdf, ');
    expect(seen.at(-1)?.allowedMimeTypes).toEqual(['application/pdf']);
  });

  it('tidies the text when the field loses focus', () => {
    const { field } = mount();
    type(field(), ' image/* ,application/pdf ,, ');
    act(() => { field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(field().value).toBe('image/*, application/pdf');
  });

  it('starts from what is stored', () => {
    const { field } = mount({ allowedMimeTypes: ['image/*', 'application/pdf'] });
    expect(field().value).toBe('image/*, application/pdf');
  });

  it('clears the setting when the field is emptied', () => {
    const { field, seen } = mount({ allowedMimeTypes: ['image/*'] });
    type(field(), '');
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe('parseMimeTypes', () => {
  it('splits on commas, trims and drops blanks', () => {
    expect(parseMimeTypes('application/pdf, image/*')).toEqual(['application/pdf', 'image/*']);
    expect(parseMimeTypes(' a ,, b , ')).toEqual(['a', 'b']);
    expect(parseMimeTypes('')).toEqual([]);
  });
});
