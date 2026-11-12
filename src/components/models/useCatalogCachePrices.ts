'use client';

import { useEffect, useMemo, useState } from 'react';
import { cachePricesFromMatch, type CatalogCachePrices } from '@/components/models/promptCachingForm';
import { useModelPriceSuggestion } from '@/lib/api/queries/models';

/**
 * The cache read / write prices the built-in price catalog holds for a model id, or null when it has no entry
 * (or none with cache prices). Looked up only while `active`, debounced on the id; a failed lookup is "no entry".
 */
export function useCatalogCachePrices(modelId: string, active: boolean): CatalogCachePrices | null {
  const [name, setName] = useState('');

  useEffect(() => {
    const next = modelId.trim();
    if (!active || !next) {
      setName('');
      return;
    }
    const timer = setTimeout(() => setName(next), 400);
    return () => clearTimeout(timer);
  }, [modelId, active]);

  const match = useModelPriceSuggestion(name, active).data;
  return useMemo(() => (active && name && match ? cachePricesFromMatch(match.pricing) : null), [active, name, match]);
}
