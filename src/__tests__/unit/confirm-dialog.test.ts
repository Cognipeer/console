// @vitest-environment jsdom
import { StrictMode, createElement, useEffect, type ComponentType, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider, useConfirm, type ConfirmApi } from '@/components/common/confirm/ConfirmProvider';
import { useDeleteResource } from '@/components/common/confirm/useDeleteResource';
import { useConfirmKeyChange } from '@/components/common/confirm/useConfirmKeyChange';
import ResourceUsageSection from '@/components/common/confirm/ResourceUsageSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// createElement's overloads insist on `children` inside the props for these providers.
type Loose = ComponentType<{ locale?: string; children?: ReactNode }>;
const Mantine = MantineProvider as unknown as Loose;
const I18n = I18nProvider as unknown as Loose;
const Confirm = ConfirmProvider as unknown as Loose;

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

let root: Root;
let host: HTMLElement;
let api: ConfirmApi;
let deleteResource: ReturnType<typeof useDeleteResource>;
let confirmKeyChange: ReturnType<typeof useConfirmKeyChange>;

function Capture() {
  const c = useConfirm();
  const d = useDeleteResource();
  const k = useConfirmKeyChange();
  useEffect(() => {
    api = c;
    deleteResource = d;
    confirmKeyChange = k;
  });
  return null;
}

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel);
const buttonByText = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(Mantine, null,
        createElement(I18n, { locale: 'en' },
          createElement(Confirm, null, createElement(Capture)))),
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ConfirmProvider', () => {
  it('resolves true on confirm and false on cancel', async () => {
    let p!: Promise<boolean>;
    await act(async () => {
      p = api.confirm({ title: 'Restart?', message: 'Sure?' });
    });
    expect(document.body.textContent).toContain('Restart?');
    await act(async () => buttonByText('Confirm')!.click());
    await expect(p).resolves.toBe(true);

    await act(async () => {
      p = api.confirm({ title: 'Again?', message: 'x' });
    });
    await act(async () => buttonByText('Cancel')!.click());
    await expect(p).resolves.toBe(false);
    await flush();
    expect(document.body.textContent).not.toContain('Again?');
  });

  it('resolves false on Escape', async () => {
    let p!: Promise<boolean>;
    await act(async () => {
      p = api.confirm({ title: 'Esc?', message: 'x', tone: 'danger' });
    });
    await act(async () => {
      q('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(p).resolves.toBe(false);
  });

  it('keeps confirm disabled until the typed text matches', async () => {
    let p!: Promise<boolean>;
    await act(async () => {
      p = api.confirm({ title: 'Delete?', message: 'x', tone: 'danger', requireTypedText: 'Sales bot', confirmLabel: 'Delete' });
    });
    const confirmBtn = () => buttonByText('Delete') as HTMLButtonElement;
    expect(confirmBtn().disabled).toBe(true);
    const input = q<HTMLInputElement>('input')!;
    await setInput(input, 'Sales');
    expect(confirmBtn().disabled).toBe(true);
    await setInput(input, 'Sales bot');
    expect(confirmBtn().disabled).toBe(false);
    await act(async () => confirmBtn().click());
    await expect(p).resolves.toBe(true);
  });

  it('confirmAction stays open with the error inline, then succeeds on retry', async () => {
    const action = vi.fn().mockRejectedValueOnce(new Error('boom: in use')).mockResolvedValueOnce(undefined);
    let p!: Promise<boolean>;
    let settled = false;
    await act(async () => {
      p = api.confirmAction({ title: 'Delete?', message: 'x', tone: 'danger', confirmLabel: 'Delete', action });
      void p.then(() => { settled = true; });
    });
    await act(async () => buttonByText('Delete')!.click());
    await flush();
    expect(settled).toBe(false);
    expect(document.body.textContent).toContain('boom: in use');
    await act(async () => buttonByText('Delete')!.click());
    await flush();
    await expect(p).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('does not cancel while the action is running', async () => {
    let release!: () => void;
    const action = vi.fn(() => new Promise<void>((r) => { release = r; }));
    let p!: Promise<boolean>;
    let settled = false;
    await act(async () => {
      p = api.confirmAction({ title: 'Work?', message: 'x', action });
      void p.then(() => { settled = true; });
    });
    await act(async () => buttonByText('Confirm')!.click());
    await act(async () => {
      q('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(settled).toBe(false);
    await act(async () => release());
    await expect(p).resolves.toBe(true);
  });

  it('queues a second dialog behind the first', async () => {
    let a!: Promise<boolean>;
    let b!: Promise<boolean>;
    await act(async () => {
      a = api.confirm({ title: 'First', message: 'x' });
      b = api.confirm({ title: 'Second', message: 'x' });
    });
    expect(document.body.textContent).toContain('First');
    expect(document.body.textContent).not.toContain('Second');
    await act(async () => buttonByText('Confirm')!.click());
    await expect(a).resolves.toBe(true);
    await flush();
    expect(document.body.textContent).toContain('Second');
    await act(async () => buttonByText('Cancel')!.click());
    await expect(b).resolves.toBe(false);
  });
});

describe('useDeleteResource', () => {
  const usageBody = {
    resource: { type: 'model', id: 'm1', key: 'gpt', name: 'GPT', projectId: null, projectName: null, projectDisplay: null, crn: null },
    usedBy: [
      { kind: 'agent.model', field: 'config.modelKey', direction: 'in', status: 'ok', severity: null, impact: 'error',
        other: { type: 'agent', id: 'a1', key: 'sales', name: 'Sales bot', projectId: 'p1', projectName: 'Retail', projectDisplay: { kind: 'project', projectId: 'p1', projectName: 'Retail' }, crn: null } },
    ],
    hiddenUsedByCount: 2,
    hiddenByType: { agent: 2 },
    summary: { error: 3, warning: 0 },
    usedByTruncated: false,
  };

  it('shows usage, requires typing the name when dependents fail, then deletes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => usageBody }));
    const action = vi.fn().mockResolvedValue(undefined);
    let p!: Promise<boolean>;
    await act(async () => {
      p = deleteResource({ noun: 'model', name: 'GPT', type: 'model', id: 'm1', action });
    });
    await flush();
    const text = document.body.textContent ?? '';
    expect(fetch).toHaveBeenCalledWith('/api/resource-usage/model/m1', expect.anything());
    expect(text).toContain('Delete model?');
    expect(text).toContain('This model is used in 3 places');
    expect(text).toContain('Sales bot');
    expect(text).toContain('2 more uses in projects you cannot access');
    expect(text).toContain('these will fail at run time');
    const del = () => buttonByText('Delete') as HTMLButtonElement;
    expect(del().disabled).toBe(true);
    await setInput(q<HTMLInputElement>('input')!, 'GPT');
    await act(async () => del().click());
    await flush();
    await expect(p).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('moves focus to the type-to-confirm input once it appears', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true, status: 200, json: async () => usageBody };
    }));
    await act(async () => {
      void deleteResource({ noun: 'model', name: 'GPT', type: 'model', id: 'm1', action: async () => {} });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    await flush();
    const input = q<HTMLInputElement>('input')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await act(async () => buttonByText('Cancel')!.click());
    vi.unstubAllGlobals();
  });

  it('asks the usage endpoint once per dialog even under StrictMode', async () => {
    await act(async () => {
      root.render(
        createElement(StrictMode, null,
          createElement(Mantine, null,
            createElement(I18n, { locale: 'en' },
              createElement(Confirm, null, createElement(Capture))))),
      );
    });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => usageBody });
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => {
      void deleteResource({ noun: 'model', name: 'GPT', type: 'model', id: 'm1', action: async () => {} });
    });
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => buttonByText('Cancel')!.click());
    vi.unstubAllGlobals();
  });

  it('falls back to a plain confirm with a note when the usage lookup fails, and never blocks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'x' }) }));
    const action = vi.fn().mockResolvedValue(undefined);
    let p!: Promise<boolean>;
    await act(async () => {
      p = deleteResource({ noun: 'tool', name: 'CRM', type: 'tool', id: 't1', action });
    });
    await flush();
    expect(document.body.textContent).toContain('could not be checked');
    expect(q('input')).toBeNull();
    await act(async () => buttonByText('Delete')!.click());
    await flush();
    await expect(p).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it('without type/id it is a plain danger confirm and makes no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    let p!: Promise<boolean>;
    await act(async () => {
      p = deleteResource({ noun: 'file', name: 'a.txt', action: async () => {} });
    });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('You are about to delete a.txt');
    await act(async () => buttonByText('Cancel')!.click());
    await expect(p).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('useConfirmKeyChange', () => {
  const body = (impact: 'error' | 'warning' | null, hidden = 0) => ({
    resource: { type: 'model', id: 'm1', key: 'gpt', name: 'GPT', projectId: null, projectName: null, projectDisplay: null, crn: null },
    usedBy: impact === null ? [] : [{ kind: 'agent.model', field: 'config.modelKey', direction: 'in', status: 'ok', severity: null, impact,
      other: { type: 'agent', id: 'a1', key: 'sales', name: 'Sales bot', projectId: null, projectName: null, projectDisplay: null, crn: null } }],
    hiddenUsedByCount: hidden,
    hiddenByType: {},
    summary: { error: impact === 'error' ? 1 : 0, warning: 0 },
    usedByTruncated: false,
  });
  const opts = { type: 'model', id: 'm1', noun: 'model', originalKey: 'gpt', nextKey: 'gpt-4' };

  it('does not call the API when the key did not change', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(confirmKeyChange({ ...opts, nextKey: ' gpt ' })).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('lets the save through when nothing references the key or the lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body(null) }));
    await expect(confirmKeyChange(opts)).resolves.toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(confirmKeyChange(opts)).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it('warns with the referrers that would break and respects Cancel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body('error', 1) }));
    let p!: Promise<boolean>;
    await act(async () => {
      p = confirmKeyChange(opts);
    });
    await flush();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Change the key of model?');
    expect(text).toContain('Sales bot');
    expect(text).toContain('1 more references in projects you cannot access');
    await act(async () => buttonByText('Cancel')!.click());
    await expect(p).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('ResourceUsageSection', () => {
  const render = async (node: unknown) => {
    await act(async () => {
      root.render(
        createElement(Mantine, null,
          createElement(I18n, { locale: 'en' },
            createElement(Confirm, null, createElement(Capture), node as never))),
      );
    });
    await flush();
  };

  it('shows the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      resource: {}, usedBy: [], uses: [], hiddenUsedByCount: 0, hiddenByType: {}, summary: { error: 0, warning: 0 }, usedByTruncated: false,
    }) }));
    await render(createElement(ResourceUsageSection, { type: 'agent', id: 'a1', showUses: true }));
    expect(document.body.textContent).toContain('Not used anywhere');
    vi.unstubAllGlobals();
  });

  it('lists Used by and the hidden count, and degrades to a note on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      resource: {}, uses: [], hiddenUsedByCount: 2, hiddenByType: {}, summary: { error: 0, warning: 1 }, usedByTruncated: false,
      usedBy: [{ kind: 'agent.tool', field: 'f', direction: 'in', status: 'ok', severity: null, impact: 'warning',
        other: { type: 'agent', id: 'a1', key: 'sales', name: 'Sales bot', projectId: null, projectName: null, projectDisplay: null, crn: null } }],
    }) }));
    await render(createElement(ResourceUsageSection, { type: 'tool', id: 't1' }));
    expect(document.body.textContent).toContain('Sales bot');
    expect(document.body.textContent).toContain('2 more uses in projects you cannot access');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await render(createElement(ResourceUsageSection, { type: 'tool', id: 't2' }));
    expect(document.body.textContent).toContain('Usage could not be loaded');
    vi.unstubAllGlobals();
  });
});
