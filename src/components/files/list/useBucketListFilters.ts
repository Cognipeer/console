'use client';

/**
 * The bucket list's filters (search, provider, status), kept in the address as `?q=&provider=&status=` so a filtered
 * list can be bookmarked, shared and walked back to with the Back button.
 *
 * The list reacts to a filter at once; the address follows: a select writes it immediately, the search box after a
 * pause (so typing does not make a history entry per letter). An address that changed from outside (Back, a link)
 * replaces the filters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  FILES_PATH,
  NO_BUCKET_FILTERS,
  bucketListQuery,
  parseBucketListFilters,
  type BucketListFilters,
  type BucketStatusFilter,
} from './bucketListModel';

/** Typing in the search box reaches the address after this pause. */
export const SEARCH_URL_DELAY_MS = 350;

export interface BucketListFilterControls {
  filters: BucketListFilters;
  setQuery: (q: string) => void;
  setProvider: (provider: string) => void;
  setStatus: (status: BucketStatusFilter) => void;
  /** Back to "no filter" (and an address without the parameters). */
  clear: () => void;
}

export function useBucketListFilters(): BucketListFilterControls {
  const router = useRouter();
  const pathname = usePathname() ?? FILES_PATH;
  const searchParams = useSearchParams();
  const urlQuery = searchParams?.toString() ?? '';
  const fromUrl = useMemo(() => parseBucketListFilters(new URLSearchParams(urlQuery)), [urlQuery]);

  const [filters, setFilters] = useState<BucketListFilters>(fromUrl);
  const latest = useRef(filters);
  // The filters the address holds, or has been told to hold. An address that differs from this changed from outside.
  const told = useRef(bucketListQuery(fromUrl));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingWrite = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const writeAddress = useCallback(
    (next: BucketListFilters) => {
      told.current = bucketListQuery(next);
      // Whatever else the address carries stays.
      const query = bucketListQuery(next, new URLSearchParams(window.location.search));
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const change = useCallback(
    (patch: Partial<BucketListFilters>, delayed: boolean) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setFilters(next);
      cancelPendingWrite();
      if (delayed) {
        timer.current = setTimeout(() => {
          timer.current = null;
          writeAddress(latest.current);
        }, SEARCH_URL_DELAY_MS);
      } else {
        writeAddress(next);
      }
    },
    [cancelPendingWrite, writeAddress],
  );

  // The address changed from outside: Back, Forward, a link with filters in it.
  useEffect(() => {
    const incoming = bucketListQuery(fromUrl);
    if (incoming === told.current) return;
    told.current = incoming;
    latest.current = fromUrl;
    cancelPendingWrite();
    setFilters(fromUrl);
  }, [cancelPendingWrite, fromUrl]);

  useEffect(() => cancelPendingWrite, [cancelPendingWrite]);

  return {
    filters,
    setQuery: useCallback((q: string) => change({ q }, true), [change]),
    setProvider: useCallback((provider: string) => change({ provider }, false), [change]),
    setStatus: useCallback((status: BucketStatusFilter) => change({ status }, false), [change]),
    clear: useCallback(() => change({ ...NO_BUCKET_FILTERS }, false), [change]),
  };
}
