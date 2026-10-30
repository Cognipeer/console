'use client';

import { useEffect, useState } from 'react';
import { cachePricesFromMatch, type CatalogCachePrices } from '@/components/models/promptCachingForm';

/**
 * The cache read / write prices the built-in price catalog holds for a model id, or null when it has no entry
 * (or none with cache prices). Looked up only while `active`, debounced on the id; a failed lookup is "no entry".
 */
export function useCatalogCachePrices(modelId: string, active: boolean): CatalogCachePrices | null {
  const [prices, setPrices] = useState<CatalogCachePrices | null>(null);

  useEffect(() => {
    const name = modelId.trim();
    if (!active || !name) {
      setPrices(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/model-price-catalog/suggest?names=${encodeURIComponent(name)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => setPrices(cachePricesFromMatch(payload?.suggestions?.[0]?.match?.pricing)))
        .catch(() => {
          if (!controller.signal.aborted) setPrices(null);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [modelId, active]);

  return prices;
}
