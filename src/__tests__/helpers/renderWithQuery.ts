/**
 * Rendering helpers for UI tests of components that read through React Query: a query client that does not retry
 * and drops its cache at once, and `renderWithQuery`, which mounts an element inside it (plus the Mantine, i18n and
 * confirm providers `mount` gives). jsdom only; import from a test file that starts with `// @vitest-environment jsdom`.
 */

import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mount, type Mounted } from './iamCenterUi';

/** A query client that does not retry and answers an error at once. */
export function newTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 }, mutations: { retry: false } } });
}

export interface RenderedWithQuery extends Mounted {
  client: QueryClient;
}

/** Mounts `element` inside a query client (a fresh one unless `client` is given). */
export async function renderWithQuery(
  element: ReactNode,
  options: { client?: QueryClient; locale?: string } = {},
): Promise<RenderedWithQuery> {
  const client = options.client ?? newTestQueryClient();
  const mounted = await mount(createElement(QueryClientProvider, { client }, element), options.locale);
  return { ...mounted, client };
}
