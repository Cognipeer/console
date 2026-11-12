/**
 * Harness for tests of the React Query hooks of the knowledge area (rag, vector, memory, crawler, ocr jobs):
 * mounts a hook inside a query client, and answers `fetch` from a table of routes while recording every call.
 * jsdom only; import from a test file that starts with `// @vitest-environment jsdom`.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

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

export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

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
  search: string;
  body: unknown;
}

export type RouteAnswer = { status?: number; body?: unknown } | undefined;
export type Route = (call: RecordedCall) => RouteAnswer;

/** Stubs `fetch`: `route` answers each call (undefined = 404); every call is pushed to the returned list. */
export function stubFetch(route: Route): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const call: RecordedCall = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        search: url.search,
        body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const answer = route(call) ?? { status: 404, body: { error: `no mock for ${call.method} ${call.path}` } };
      const status = answer.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(answer.body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}
