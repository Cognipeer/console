'use client';

import { useEffect, useRef, useState } from 'react';
import type { QuotaTargetSource } from '@/lib/quota/targets';
import {
  resolveTargetOption,
  searchTargetOptions,
  type FetchLike,
  type TargetOption,
  type TargetResolution,
} from './pickerSources';

/** How long typing must pause before the registry is asked. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface TargetSearch {
  /** What the person typed (the picker's search box). */
  query: string;
  setQuery: (query: string) => void;
  /** Outcome of the last SETTLED search; `unavailable` = the caller may not browse the registry. */
  status: 'ok' | 'unavailable' | 'failed';
  options: TargetOption[];
  /** Matches on the server, which can be more than `options` (the picker shows the first page). */
  total: number;
  /** A search is waiting out the debounce or in flight. The previous options stay in `options` meanwhile. */
  loading: boolean;
}

/**
 * Type-ahead over the registry for one kind of target: the first page as soon
 * as it mounts, then a new page `SEARCH_DEBOUNCE_MS` after the last keystroke.
 * A search still running when the query changes (or the picker goes away) is
 * aborted and its answer ignored, so a slow early answer can never overwrite a
 * newer one.
 *
 * Remount (`key={source.id}`) to start over for a different kind of target.
 */
export function useTargetSearch(
  source: QuotaTargetSource,
  options: { fetcher?: FetchLike; debounceMs?: number } = {},
): TargetSearch {
  const { fetcher, debounceMs = SEARCH_DEBOUNCE_MS } = options;
  const [query, setQuery] = useState('');
  const [state, setState] = useState<Omit<TargetSearch, 'query' | 'setQuery'>>({
    status: 'ok',
    options: [],
    total: 0,
    loading: true,
  });
  // Callers build `source` (and may build `fetcher`) afresh on every render; only the source's id says whether it changed.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Blanks around the words are not a different question.
  const typed = query.trim();

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => (current.loading ? current : { ...current, loading: true }));
    const handle = setTimeout(() => {
      void searchTargetOptions(sourceRef.current, typed, fetcherRef.current, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setState(
          result.status === 'ok'
            ? { status: 'ok', options: result.options, total: result.total, loading: false }
            : { status: result.status, options: [], total: 0, loading: false },
        );
      });
    }, typed ? debounceMs : 0);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [source.id, typed, debounceMs]);

  return { query, setQuery, ...state };
}

/**
 * What the registry says about a STORED value (an existing limit, a deep link):
 * null while nobody asked or the answer is pending. Not asked when `skip` is set
 * (the value was just picked from the list, so it is known to exist).
 */
export function useTargetResolution(
  source: QuotaTargetSource,
  value: string | undefined,
  options: { skip?: boolean; preferProjectId?: string; fetcher?: FetchLike } = {},
): TargetResolution | null {
  const { skip = false, preferProjectId, fetcher } = options;
  const [answer, setAnswer] = useState<{ sourceId: string; value: string; result: TargetResolution } | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // Only the project a value was resolved FOR matters at that moment; a later change of project asks nothing new.
  const projectRef = useRef(preferProjectId);
  projectRef.current = preferProjectId;

  useEffect(() => {
    if (!value || skip) {
      setAnswer(null);
      return;
    }
    const controller = new AbortController();
    void resolveTargetOption(sourceRef.current, value, fetcherRef.current, controller.signal, projectRef.current).then((result) => {
      if (!controller.signal.aborted) setAnswer({ sourceId: source.id, value, result });
    });
    return () => controller.abort();
  }, [source.id, value, skip]);

  return answer && answer.sourceId === source.id && answer.value === value ? answer.result : null;
}
