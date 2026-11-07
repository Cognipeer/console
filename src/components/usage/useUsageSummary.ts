'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/api/client';
import type { UsageSummary } from '@/lib/limits/usageSummary';

export interface UsageSummaryState {
  summary: UsageSummary | null;
  loading: boolean;
  error: boolean;
  refetch: () => Promise<void>;
}

/**
 * Loads `/api/usage/summary` and refetches it every `intervalMs` while the tab
 * is visible (a hidden tab stops polling and refreshes once when it comes back).
 * `enabled = false` does nothing at all.
 */
export function useUsageSummary(intervalMs: number, enabled = true): UsageSummaryState {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const alive = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const data = await apiRequest<UsageSummary>('/api/usage/summary');
      if (!alive.current) return;
      setSummary(data);
      setError(false);
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    void refetch();
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const timer = setInterval(() => {
      if (visible()) void refetch();
    }, intervalMs);
    const onVisible = () => {
      if (visible()) void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, refetch]);

  return { summary, loading, error, refetch };
}
