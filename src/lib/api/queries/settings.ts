'use client';

/**
 * React Query hooks of the workspace Settings screens: the license and the audit log.
 *
 * - Every key starts `['settings', <project>, ...]` (`settingsKeys`); `<project>` is the marker of `useResourceKey`.
 * - The license body and the audit log pages are returned raw: the screen owns their types, the hook owns the request.
 * - Applying or removing a license reloads the license (it also says what the install may run).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const settingsKeys = {
  all: ['settings'] as const,
  project: (project: string) => ['settings', project] as const,
  license: (project: string) => ['settings', project, 'license'] as const,
  /** `filters` is the query string of the read (search, filters, `limit`, `skip`). */
  auditLogs: (project: string, filters: string) => ['settings', project, 'audit-logs', filters] as const,
  auditServices: (project: string) => ['settings', project, 'audit-services'] as const,
};

/* ── License ─────────────────────────────────────────────────────────────── */

/** The license of the workspace and what it allows (the raw body). */
export function useLicense<TLicense = unknown>() {
  const [, project] = useResourceKey('settings');
  return useQuery<TLicense, Error>({
    queryKey: settingsKeys.license(project),
    queryFn: ({ signal }) => apiGet<TLicense>('/api/license', { signal }),
    retry: retryUnlessClientError,
  });
}

function useReloadLicense() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return () => queryClient.invalidateQueries({ queryKey: settingsKeys.license(project) });
}

/** Applies a license key; the license reloads before this resolves. */
export function useApplyLicense() {
  const reload = useReloadLicense();
  return useMutation({
    mutationFn: (licenseKey: string) => apiPost<unknown>('/api/license', { licenseKey }),
    onSuccess: () => reload(),
  });
}

/** Removes the workspace license; the license reloads before this resolves. */
export function useResetLicense() {
  const reload = useReloadLicense();
  return useMutation({
    mutationFn: () => apiDelete<unknown>('/api/license'),
    onSuccess: () => reload(),
  });
}

/* ── Audit log ───────────────────────────────────────────────────────────── */

/**
 * One page of the audit log (`filters` is the query string, `limit` and `skip` among it). While another page or
 * filter loads, the rows of the one before stay (of the same project only).
 */
export function useAuditLogs<TBody = unknown>(filters: string) {
  const [, project] = useResourceKey('settings');
  return useQuery<TBody, Error>({
    queryKey: settingsKeys.auditLogs(project, filters),
    queryFn: ({ signal }) => apiGet<TBody>(`/api/audit/logs?${filters}`, { signal }),
    retry: retryUnlessClientError,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === project ? previous : undefined),
    meta: { notifyOnError: 'Audit log' },
  });
}

/** The services the audit log can be filtered by. A failed read leaves the filter empty. */
export function useAuditServices<TBody = unknown>() {
  const [, project] = useResourceKey('settings');
  return useQuery<TBody, Error>({
    queryKey: settingsKeys.auditServices(project),
    queryFn: ({ signal }) => apiGet<TBody>('/api/audit/services', { signal }),
    retry: retryUnlessClientError,
  });
}
