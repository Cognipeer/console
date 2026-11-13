// @vitest-environment jsdom
/**
 * Configure → Sandbox: a sandbox set up now starts without network access ("Block network access" on);
 * one saved earlier keeps its own setting, so turning the sandbox off and on again does not change it.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import AgentSandboxPanel from '@/components/agents/studio/AgentSandboxPanel';
import type { IAgentSandboxConfig } from '@/lib/database/provider/types.domain';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, templates: [] }), { status: 200 })));
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(initial: IAgentSandboxConfig | undefined) {
  const seen: Array<IAgentSandboxConfig | undefined> = [];
  function Harness() {
    const [value, setValue] = useState<IAgentSandboxConfig | undefined>(initial);
    return h(MantineProvider, null, h(AgentSandboxPanel, {
      value,
      onChange: (next: IAgentSandboxConfig | undefined) => { seen.push(next); setValue(next); },
    }));
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness)));
  const switchFor = (text: string) => {
    const label = [...container!.querySelectorAll('label')].find((l) => l.textContent?.includes(text));
    const input = label?.htmlFor ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
    if (!input) throw new Error(`no switch "${text}"`);
    return input;
  };
  return { seen, switchFor, last: () => seen.at(-1) };
}

describe('the sandbox panel, network', () => {
  it('turns "Block network access" on for a sandbox set up now', () => {
    const { switchFor, last } = mount(undefined);
    act(() => switchFor('Give this agent a sandbox').click());
    expect(last()).toMatchObject({ enabled: true, blockNetwork: true });
    expect(switchFor('Block network access').checked).toBe(true);
  });

  it('keeps the network of a sandbox saved with it allowed', () => {
    const { switchFor, last } = mount({ enabled: false, blockNetwork: false });
    act(() => switchFor('Give this agent a sandbox').click());
    expect(last()).toMatchObject({ enabled: true, blockNetwork: false });
    expect(switchFor('Block network access').checked).toBe(false);
  });

  it('leaves the setting of an agent saved before the default alone', () => {
    // Saved with the sandbox on and no network field: the network stays allowed, as it ran.
    const { switchFor, seen } = mount({ enabled: true });
    expect(switchFor('Block network access').checked).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('lets the user allow the network', () => {
    const { switchFor, last } = mount(undefined);
    act(() => switchFor('Give this agent a sandbox').click());
    act(() => switchFor('Block network access').click());
    expect(last()).toMatchObject({ enabled: true, blockNetwork: false });
  });
});
