'use client';

/**
 * React Query hooks of the quota editor.
 *
 * - Every key starts `['quota', <project>, ...]` (`quotaKeys`); `<project>` is the marker of `useResourceKey`.
 * - The picker sources of the quota target editor take an injectable fetcher and stay as they are.
 */

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api/client';
import { retryUnlessClientError } from './errors';
import { useResourceKey } from './projectScope';

export interface QuotaDefaultsBody {
  ipScope?: { trustedProxiesUnset?: boolean };
  domains?: unknown;
  jobKinds?: unknown;
}

export const quotaKeys = {
  all: ['quota'] as const,
  project: (project: string) => ['quota', project] as const,
  defaults: (project: string) => ['quota', project, 'defaults'] as const,
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
