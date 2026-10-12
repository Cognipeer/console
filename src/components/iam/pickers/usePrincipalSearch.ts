'use client';

import { useEffect, useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import {
  errorMessage,
  iamApi,
  isAbortError,
  type IamPrincipalType,
  type PrincipalListItem,
} from '../api';

export interface PrincipalSearch {
  search: string;
  setSearch: (value: string) => void;
  items: PrincipalListItem[];
  loading: boolean;
  error: string | null;
}

/**
 * Server-side principal search for the pickers. The tenant can have ~20K users,
 * so nothing is ever loaded wholesale: every keystroke (debounced) asks the API
 * for the first page of matches.
 */
export function usePrincipalSearch(type: IamPrincipalType, options: { limit?: number; enabled?: boolean } = {}): PrincipalSearch {
  const { limit = 20, enabled = true } = options;
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 250);
  const [items, setItems] = useState<PrincipalListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    iamApi
      .listPrincipals({ type, q: debounced.trim() || undefined, limit }, controller.signal)
      .then((res) => {
        setItems(res.items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setItems([]);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [type, debounced, limit, enabled]);

  return { search, setSearch, items, loading, error };
}
