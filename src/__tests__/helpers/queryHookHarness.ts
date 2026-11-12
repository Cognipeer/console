/**
 * Harness for the tests of React Query hook files (jsdom only): `renderHook` mounts a probe that runs the hook inside
 * a query client, `settle` lets requests and re-renders finish, and `stubApi` answers `fetch` from a handler while
 * recording every call. Import from a test file that starts with `// @vitest-environment jsdom`.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';
import { jsonResponse } from './iamCenterUi';

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

export const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** Unmounts the probe and restores `fetch`; call from `afterEach`. */
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

export type ApiHandler = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

/** Replaces `fetch`: every call is recorded; `handler` answers it, or returns undefined for a 404. */
export function stubApi(handler: ApiHandler): RecordedCall[] {
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
      return (await handler(call)) ?? jsonResponse({ error: `no mock for ${call.method} ${call.path}` }, 404);
    }),
  );
  return calls;
}
