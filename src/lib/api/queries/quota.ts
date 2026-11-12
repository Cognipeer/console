'use client';

/**
 * React Query hooks of the quota editor.
 *
 * - Every key starts `['quota', <project>, ...]` (`quotaKeys`); `<project>` is the marker of `useResourceKey`.
 * - The picker sources of the quota target editor take an injectable fetcher; their default fetcher goes through the
 *   shared client (see `pickerSources.ts`), they are not hooks.
 * - The policies of the tenant (`/api/quota/policies`) are one list; every write reloads it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

export interface QuotaDefaultsBody {
  ipScope?: { trustedProxiesUnset?: boolean };
  domains?: unknown;
  jobKinds?: unknown;
}

export const quotaKeys = {
  all: ['quota'] as const,
  project: (project: string) => ['quota', project] as const,
  defaults: (project: string) => ['quota', project, 'defaults'] as const,
  policies: (project: string) => ['quota', project, 'policies'] as const,
};

/** What this install guards (the core's services plus what the overlay registered). A failed read changes nothing. */
export function useQuotaDefaults(enabled: boolean) {
  const [, project] = useResourceKey('quota');
  return useQuery({
    queryKey: quotaKeys.defaults(project),
    queryFn: ({ signal }) => apiGet<QuotaDefaultsBody | null>('/api/quota/defaults', { signal }),
    enabled,
    retry: retryUnlessClientError,
  });
}

/** The raw policies body (`{ policies }` with their targets); the screen parses it. Written elsewhere too: a visit refetches. */
export function useQuotaPolicies() {
  const [, project] = useResourceKey('quota');
  return useQuery({
    queryKey: quotaKeys.policies(project),
    queryFn: ({ signal }) => apiGet<unknown>('/api/quota/policies?include=targets', { signal }),
    retry: retryUnlessClientError,
    staleTime: 0,
  });
}

function useInvalidatePolicies() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: quotaKeys.policies(project) });
}

const policyPath = (id: string) => `/api/quota/policies/${encodeURIComponent(id)}`;

/** `id` null creates, else edits. The result is the raw body (`warnings` among it). The list reloads before this resolves. */
export function useSaveQuotaPolicy() {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: Record<string, unknown> }) =>
      id ? apiPatch<unknown>(policyPath(id), body) : apiPost<unknown>('/api/quota/policies', body),
    onSuccess: () => invalidate(),
  });
}

/**
 * Turns one policy on or off. The list reloads whether the server accepted it or not, so a refusal puts the shown
 * state back.
 */
export function useSetQuotaPolicyEnabled() {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiPatch<unknown>(policyPath(id), { enabled }),
    onSettled: () => invalidate(),
  });
}

/** Deletes one policy; `projectId` names the project it is in, so the server can confirm it. */
export function useDeleteQuotaPolicy() {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId?: string }) =>
      apiDelete<unknown>(`${policyPath(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    onSuccess: () => invalidate(),
  });
}
