'use client';

/**
 * React Query hooks of Webhooks (endpoints, the event catalog, the deliveries of one endpoint).
 *
 * - Every key starts `['webhooks', <project>, ...]` (`webhooksKeys`); `<project>` is the marker of `useResourceKey`.
 * - The endpoint list and the event catalog load together (`useWebhooks`); a 403 on the list is an answer (`forbidden`).
 * - Every write that changes an endpoint reloads the whole `['webhooks', <project>]` prefix.
 * - Deliveries load page by page (`skip` = rows already shown); `useRestartWebhookDeliveries` goes back to the first page.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import type { WebhookDeliveryRow, WebhookEndpointRow, WebhookEventType } from '@/components/settings/webhooksUi';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

const API = '/api/webhooks';
const enc = encodeURIComponent;

/** Deliveries per page. */
export const DELIVERY_PAGE = 50;

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const webhooksKeys = {
  all: ['webhooks'] as const,
  project: (project: string) => ['webhooks', project] as const,
  list: (project: string) => ['webhooks', project, 'list'] as const,
  deliveries: (project: string, endpointId: string) => ['webhooks', project, 'deliveries', endpointId] as const,
};

/* ── Types ───────────────────────────────────────────────────────────────── */

/** The raw list body: the endpoints, and what the caller may do (read by `parseWebhookCapabilities`). */
export type WebhookListBody = { endpoints?: WebhookEndpointRow[] } & Record<string, unknown>;

export interface WebhooksData {
  /** The caller may not read webhooks at all (403). */
  forbidden: boolean;
  /** The raw list body; null when forbidden. */
  list: WebhookListBody | null;
  /** The event catalog; empty when it could not be read (the list still shows). */
  catalog: WebhookEventType[];
}

export interface WebhookDeliveriesPage {
  deliveries: WebhookDeliveryRow[];
  hasMore: boolean;
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** The endpoints and the event catalog. Both are read at once; only the list decides success. */
export function useWebhooks() {
  const [, project] = useResourceKey('webhooks');
  return useQuery<WebhooksData, Error>({
    queryKey: webhooksKeys.list(project),
    queryFn: async ({ signal }) => {
      const [list, events] = await Promise.all([
        apiGet<WebhookListBody>(API, { signal }).then(
          (body) => ({ forbidden: false, body }),
          (error: unknown) => {
            if (error instanceof ApiError && error.status === 403) return { forbidden: true, body: null };
            throw error;
          },
        ),
        apiGet<{ events?: WebhookEventType[] }>(`${API}/events`, { signal }).catch((error: unknown) => {
          if (error instanceof ApiError) return null;
          throw error;
        }),
      ]);
      return { forbidden: list.forbidden, list: list.body, catalog: events?.events ?? [] };
    },
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** The deliveries of one endpoint, a page at a time (the next page starts after the rows already loaded). */
export function useWebhookDeliveries(endpointId: string) {
  const [, project] = useResourceKey('webhooks');
  return useInfiniteQuery<WebhookDeliveriesPage, Error, InfiniteData<WebhookDeliveriesPage, number>, readonly unknown[], number>({
    queryKey: webhooksKeys.deliveries(project, endpointId),
    queryFn: ({ pageParam, signal }) =>
      apiGet<WebhookDeliveriesPage>(`${API}/${enc(endpointId)}/deliveries?limit=${DELIVERY_PAGE}&skip=${pageParam}`, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.reduce((count, page) => count + (page.deliveries?.length ?? 0), 0) : undefined,
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

/** Goes back to the first page of an endpoint's deliveries and reloads it (the rows shown stay until it answers). */
export function useRestartWebhookDeliveries(endpointId: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => {
    const key = webhooksKeys.deliveries(project, endpointId);
    queryClient.setQueryData<InfiniteData<WebhookDeliveriesPage, number>>(key, (data) =>
      data ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
    );
    return queryClient.refetchQueries({ queryKey: key });
  };
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

function useReloadWebhooks() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: webhooksKeys.project(project) });
}

export type WebhookSecretEndpoint = WebhookEndpointRow & { secret?: string };

/** Creates an endpoint (`id` undefined; the answer carries its secret once) or edits one. */
export function useSaveWebhook() {
  const reload = useReloadWebhooks();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) =>
      id
        ? apiPatch<{ endpoint: WebhookEndpointRow }>(`${API}/${enc(id)}`, body)
        : apiPost<{ endpoint: WebhookSecretEndpoint }>(API, body),
    onSuccess: () => reload(),
  });
}

/** Enables or disables an endpoint. */
export function useSetWebhookStatus() {
  const reload = useReloadWebhooks();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      apiPatch<unknown>(`${API}/${enc(id)}`, { status }),
    onSuccess: () => reload(),
  });
}

/** Sends a test event; the answer is the delivery it made. */
export function useSendWebhookTest() {
  return useMutation({
    mutationFn: (id: string) => apiPost<{ delivery: WebhookDeliveryRow }>(`${API}/${enc(id)}/test`),
  });
}

/** Rotates an endpoint's secret; the answer carries the new one, shown once. */
export function useRotateWebhookSecret() {
  const reload = useReloadWebhooks();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ endpoint: WebhookSecretEndpoint }>(`${API}/${enc(id)}/rotate-secret`),
    onSuccess: () => reload(),
  });
}

export function useDeleteWebhook() {
  const reload = useReloadWebhooks();
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(`${API}/${enc(id)}`),
    onSuccess: () => reload(),
  });
}

/** Sends one delivery again. */
export function useRedeliverWebhook() {
  return useMutation({
    mutationFn: (deliveryId: string) => apiPost<unknown>(`${API}/deliveries/${enc(deliveryId)}/redeliver`),
  });
}
