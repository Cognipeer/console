// @vitest-environment jsdom
/**
 * Configure → Sandbox → Secrets: when the stored secrets cannot be decrypted the agent read says
 * `secretsUnreadable` and the panel warns; entering values again then replaces them.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import AgentSandboxPanel from '@/components/agents/studio/AgentSandboxPanel';
import type { IAgentSandboxConfig } from '@/lib/database/provider/types.domain';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

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

function mount(initial: IAgentSandboxConfig) {
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
  return { warning: () => container!.querySelector('[data-testid="sandbox-secrets-unreadable"]'), seen };
}

describe('the sandbox panel, secrets', () => {
  it('warns when the stored secrets cannot be decrypted, and says what to do', () => {
    const { warning } = mount({ enabled: true, secretsUnreadable: true });
    expect(warning()).not.toBeNull();
    expect(warning()!.textContent).toContain('Stored secrets cannot be decrypted');
    expect(warning()!.textContent).toContain('Enter all the values again');
  });

  it('shows no warning for secrets that can be read, or none stored', () => {
    expect(mount({ enabled: true, secrets: { API_TOKEN: '••••••' } }).warning()).toBeNull();
    act(() => root!.unmount());
    expect(mount({ enabled: true }).warning()).toBeNull();
  });
});

describe('the strings', () => {
  it('exist in English and Turkish', () => {
    for (const messages of [en, tr]) {
      expect(messages.agents.sandboxSecrets.unreadableTitle).toBeTruthy();
      expect(messages.agents.sandboxSecrets.unreadableBody).toBeTruthy();
    }
  });
});
