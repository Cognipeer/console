// @vitest-environment jsdom
/**
 * Configure → Sandbox → Environment variables → "Add from Config": items ticked on one tab and groups ticked on
 * the other are added by one click, and both must reach the agent config (two patches in one event).
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

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/config/groups')) {
      return json({ groups: [{ _id: 'g1', key: 'cfg-grp-platform', name: 'Platform' }, { _id: 'g2', key: 'cfg-grp-openai', name: 'OpenAI' }] });
    }
    if (String(url).includes('/api/config/items')) {
      return json({ items: [{ _id: 'i1', key: 'cfg-log-level', name: 'Log level', groupId: 'g1', isSecret: false, version: 1 }] });
    }
    return json({ available: true, templates: [] });
  }));
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};
const byText = (selector: string, text: string) =>
  Array.from(document.querySelectorAll(selector)).find((el) => el.textContent?.trim().startsWith(text));
const checkboxFor = (labelText: string) => {
  const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes(labelText));
  return label ? document.getElementById(label.htmlFor) : null;
};

describe('the sandbox panel, Add from Config', () => {
  it('adds the ticked items and binds the ticked groups in one go', async () => {
    let latest: IAgentSandboxConfig | undefined;
    function Harness() {
      const [value, setValue] = useState<IAgentSandboxConfig | undefined>({ enabled: true, templateKey: 't' });
      // env="test": no transitions or portals, so the popover renders in place at once.
      return h(MantineProvider, { env: 'test' }, h(AgentSandboxPanel, {
        value,
        onChange: (next: IAgentSandboxConfig | undefined) => { latest = next; setValue(next); },
      }));
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(h(Harness)));
    for (let i = 0; i < 5; i += 1) await flush();

    click(byText('button', 'Add from Config'));
    click(checkboxFor('cfg-log-level'));
    click(byText('[role="tab"]', 'Groups'));
    click(checkboxFor('OpenAI'));
    click(byText('button', 'Add (2)'));

    expect(latest?.envRefs).toEqual({ LOG_LEVEL: { configId: 'i1', key: 'cfg-log-level', groupId: 'g1' } });
    expect(latest?.groupRefs).toEqual([{ groupId: 'g2', key: 'cfg-grp-openai' }]);
  });
});
