/**
 * Harness for tests of React Query hook files: renders a hook inside a query client, and a fetch stub that answers
 * from a route table and records every call. jsdom only; import from a test file that starts with
 * `// @vitest-environment jsdom`.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { jsonResponse } from './iamCenterUi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

/** A query client for hook tests: no retries, and cache entries that stay until the test ends. */
export const newHookClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity }, mutations: { retry: false } } });

/** Renders `hook` inside `client`; `current` is the hook's latest result. */
export async function renderHook<T>(client: QueryClient, hook: () => T): Promise<{ current: T }> {
  const result = { current: undefined as T };
  function Probe() {
    useReducer((n: number) => n + 1, 0);
    result.current = hook();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(QueryClientProvider, { client }, h(Probe)));
  });
  return result;
}

/** Lets pending requests and the renders they cause finish. */
export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

/** Waits (up to 3 s) until `ready()` holds; a slow machine only makes the wait longer. */
export async function until(ready: () => unknown, what = 'the condition'): Promise<void> {
  for (let waited = 0; waited < 3000; waited += 10) {
    if (ready()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Unmounts what `renderHook` mounted and restores `fetch`. Call from `afterEach`. */
export async function cleanupHooks(): Promise<void> {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export type Reply = Response | { status: number; body: unknown } | unknown;

/**
 * Stubs `fetch`: `routes` maps `"METHOD /path"` to a reply (a value, or a function of the call). A route that is
 * missing answers 404. Returns the list the calls are recorded in.
 */
export function stubFetch(routes: Record<string, Reply | ((call: RecordedCall) => Reply)>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const call: RecordedCall = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      if (route === undefined) return jsonResponse({ error: `no mock for ${call.method} ${call.path}` }, 404);
      const reply = typeof route === 'function' ? (route as (c: RecordedCall) => Reply)(call) : route;
      if (reply instanceof Response) return reply;
      if (reply && typeof reply === 'object' && 'status' in reply && 'body' in reply) {
        const { status, body } = reply as { status: number; body: unknown };
        return jsonResponse(body, status);
      }
      return jsonResponse(reply);
    }),
  );
  return calls;
}
