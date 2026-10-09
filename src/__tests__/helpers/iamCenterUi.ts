/**
 * Harness for rendering the IAM center's components in jsdom: Mantine + i18n +
 * confirm providers, a mocked `next/navigation` search string, and a fetch mock
 * that answers the `/api/iam/*` contract from fixtures and records every call.
 *
 * Use with `// @vitest-environment jsdom` at the top of the test file and
 *   vi.mock('next/navigation', () => iamNavigationMock())   (hoisting: see tests)
 */

import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmProvider } from '@/components/common/confirm/ConfirmProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Loose = ComponentType<{ locale?: string; children?: ReactNode; env?: string }>;
const Mantine = MantineProvider as unknown as Loose;
const I18n = I18nProvider as unknown as Loose;
const Confirm = ConfirmProvider as unknown as Loose;

export function installDomStubs(): void {
  window.matchMedia =
    window.matchMedia ||
    (((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as never);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // floating-ui (every Mantine popover: Menu, Select, MultiSelect...) probes `:popover-open` / `:modal`
  // on each ancestor. nwsapi (jsdom's selector engine) does not know them and throws, and that throw is
  // so slow that opening one popover freezes the test for 20+ seconds. Neither state exists in jsdom.
  const nativeMatches = Element.prototype.matches;
  Element.prototype.matches = function matches(this: Element, selector: string) {
    if (selector === ':popover-open' || selector === ':modal') return false;
    return nativeMatches.call(this, selector);
  };
}

export interface Mounted {
  root: Root;
  host: HTMLElement;
  unmount: () => Promise<void>;
}

export async function mount(element: ReactNode, locale = 'en'): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        Mantine,
        { env: 'test' },
        createElement(I18n, { locale }, createElement(Confirm, null, element)),
      ),
    );
  });
  return {
    root,
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
      document.body.innerHTML = '';
    },
  };
}

export const wait = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** Lets debounced inputs (250 ms search, 450 ms compile) and the promises behind them settle. */
export const settle = async (ms = 700) => {
  await wait(ms);
  await wait(0);
};

export const body = () => document.body;
export const text = () => document.body.textContent ?? '';
export const q = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document.body) =>
  scope.querySelector<T>(sel);
export const qa = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document.body) => [
  ...scope.querySelectorAll<T>(sel),
];

export const buttonByText = (label: string | RegExp, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button, a')].find((b) => {
    const t = b.textContent?.trim() ?? '';
    return typeof label === 'string' ? t === label : label.test(t);
  });

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('click(): element not found');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

export async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// ── fetch mock ───────────────────────────────────────────────────────────

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (call: RecordedCall) => unknown | Response | Promise<unknown | Response>;

export interface ApiMock {
  calls: RecordedCall[];
  /** Calls whose path matches. */
  to(method: string, path: string | RegExp): RecordedCall[];
  /** Replace / add a handler (later wins). */
  on(method: string, path: string | RegExp, handler: RouteHandler): void;
}

export function installApiMock(initial: Array<[string, string | RegExp, RouteHandler]>): ApiMock {
  const routes: Array<{ method: string; path: string | RegExp; handler: RouteHandler }> = initial.map(
    ([method, path, handler]) => ({ method, path, handler }),
  );
  const calls: RecordedCall[] = [];

  const matches = (route: { path: string | RegExp }, path: string) =>
    typeof route.path === 'string' ? route.path === path : route.path.test(path);

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: RecordedCall = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = [...routes].reverse().find((r) => r.method === method && matches(r, url.pathname));
    if (!route) {
      return new Response(JSON.stringify({ error: `no mock for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const result = await route.handler(call);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    to: (method, path) => calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))),
    on: (method, path, handler) => {
      routes.push({ method, path, handler });
    },
  };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
