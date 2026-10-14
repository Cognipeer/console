'use client';

import { useEffect, useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import {
  errorMessage,
  iamLookupApi,
  isAbortError,
  IamApiError,
  type ProjectOption,
  type ResourceOption,
} from '../api';

// ── projects ─────────────────────────────────────────────────────────────

const PROJECT_TTL_MS = 60_000;
let projectCache: { at: number; promise: Promise<ProjectOption[]> } | null = null;

function loadProjects(): Promise<ProjectOption[]> {
  const now = Date.now();
  if (projectCache && now - projectCache.at < PROJECT_TTL_MS) return projectCache.promise;
  const promise = iamLookupApi.listProjects();
  projectCache = { at: now, promise };
  promise.catch(() => {
    if (projectCache?.promise === promise) projectCache = null;
  });
  return promise;
}

export interface UseProjects {
  projects: ProjectOption[];
  loading: boolean;
  error: string | null;
}

/** Projects the caller can see (a tenant has tens, not thousands: loaded whole and cached). */
export function useProjects(): UseProjects {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { projects, loading, error };
}

// ── resource registry search ─────────────────────────────────────────────

export interface ResourceSearch {
  search: string;
  setSearch: (value: string) => void;
  items: ResourceOption[];
  loading: boolean;
  error: string | null;
  /**
   * The caller may not read the registry (`/api/resources` is an admin service),
   * so pickers fall back to typing an id.
   */
  unavailable: boolean;
}

export function useResourceSearch(type: string | null): ResourceSearch {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 250);
  const [items, setItems] = useState<ResourceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setItems([]);
    setSearch('');
  }, [type]);

  useEffect(() => {
    if (!type || unavailable) return;
    const controller = new AbortController();
    setLoading(true);
    iamLookupApi
      .searchResources({ type, q: debounced.trim() || undefined, limit: 20 }, controller.signal)
      .then((res) => {
        setItems(res.items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setItems([]);
        if (err instanceof IamApiError && (err.status === 403 || err.status === 404)) {
          setUnavailable(true);
          setError(null);
        } else {
          setError(errorMessage(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [type, debounced, unavailable]);

  return { search, setSearch, items, loading, error, unavailable };
}
