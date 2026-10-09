'use client';

/**
 * The IAM catalog (services, actions, resource types) changes only with a
 * deployment, so every tab shares one cached copy per page load.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage, iamApi, type IamCatalog } from './api';
import { indexCatalog, type CatalogIndex } from './catalogModel';

const TTL_MS = 5 * 60_000;
let cached: { at: number; promise: Promise<IamCatalog> } | null = null;

export function loadCatalog(force = false): Promise<IamCatalog> {
  const now = Date.now();
  if (!force && cached && now - cached.at < TTL_MS) return cached.promise;
  const promise = iamApi.getCatalog();
  cached = { at: now, promise };
  // A failed load must not be served again.
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}

export interface UseIamCatalog {
  catalog: IamCatalog | null;
  index: CatalogIndex | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useIamCatalog(): UseIamCatalog {
  const [catalog, setCatalog] = useState<IamCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadCatalog(nonce > 0)
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load the catalog'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const index = useMemo(() => (catalog ? indexCatalog(catalog) : null), [catalog]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { catalog, index, loading, error, reload };
}
