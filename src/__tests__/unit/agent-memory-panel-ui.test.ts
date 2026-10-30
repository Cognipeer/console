// @vitest-environment jsdom
/**
 * Configure → Memory: one store, one scope. A config saved with several
 * stores shows its first one, says the rest are no longer used, and the
 * first edit saves it as a single store.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import AgentMemoryPanel from '@/components/agents/studio/AgentMemoryPanel';
import type { IAgentMemoryConfig } from '@/lib/database/provider/types.domain';

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

const stores = [
    { key: 'a', name: 'Store A', status: 'active' },
    { key: 'b', name: 'Store B', status: 'active' },
];

function mount(value: IAgentMemoryConfig, onChange = vi.fn()) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(h(MantineProvider, null, h(AgentMemoryPanel, { value, onChange, stores }))));
    return { el: container, onChange };
}

const inputByLabel = (el: HTMLElement, label: string) => {
    const id = [...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))?.getAttribute('for');
    return id ? (document.getElementById(id) as HTMLInputElement | null) ?? undefined : undefined;
};

describe('AgentMemoryPanel', () => {
    it('has one store picker and one scope, and no per-store rows', () => {
        const { el } = mount({ enabled: true, memoryStoreKey: 'a', scope: 'user' });
        expect(inputByLabel(el, 'Memory store')?.value).toBe('Store A');
        expect(inputByLabel(el, 'Scope')?.value).toBe('user — follows the caller everywhere');
        expect([...el.querySelectorAll('label')].filter((l) => l.textContent?.startsWith('Scope'))).toHaveLength(1);
        expect(el.textContent).not.toMatch(/Add store|Access|Use for/);
        expect(el.textContent).not.toContain('no longer read');
    });

    it('shows a former mounts config as its first store and names the stores it no longer uses', () => {
        const { el } = mount({ enabled: true, mounts: [{ storeKey: 'a' }, { storeKey: 'b' }] });
        expect(inputByLabel(el, 'Memory store')?.value).toBe('Store A');
        expect(inputByLabel(el, 'Scope')?.value).toBe('workspace — shared by agents in this project using this store');
        expect(el.textContent).toContain('b are no longer read or written');
    });

    it('the first edit saves a single store and keeps the shared workspace', () => {
        const { el, onChange } = mount({ enabled: true, mounts: [{ storeKey: 'a' }, { storeKey: 'b' }] });
        const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
        act(() => toggle.click());
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
            enabled: false, memoryStoreKey: 'a', mounts: undefined, scope: 'workspace', sharedWorkspace: true,
        }));
    });
});
