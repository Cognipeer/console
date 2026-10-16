'use client';

import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import type { DashboardDateFilterState, DashboardDatePeriod } from '@/lib/utils/dashboardDateFilter';

/**
 * The URL-synced dashboard date filter with a default other than "total". The shared filter drops its
 * `period` from the URL for "total", so a page whose URL carries no period cannot tell "never chosen" from
 * "chose total": until the viewer picks something, the default period applies (and is not written to the URL).
 */
export function useHealthDateFilter(
  defaultPeriod: Exclude<DashboardDatePeriod, 'total' | 'custom'> = 'last_day',
): [DashboardDateFilterState, (next: DashboardDateFilterState) => void] {
  const searchParams = useSearchParams()!;
  const [filter, setFilter] = useDashboardDateFilterState();
  const [chosen, setChosen] = useState(() => searchParams.has('period'));

  const update = useCallback(
    (next: DashboardDateFilterState) => {
      setChosen(true);
      setFilter(next);
    },
    [setFilter],
  );

  // Stable identity: pages key their fetches on the filter.
  const effective = useMemo<DashboardDateFilterState>(
    () => (!chosen && filter.period === 'total' ? { period: defaultPeriod, dateRange: [null, null] } : filter),
    [chosen, filter, defaultPeriod],
  );
  return [effective, update];
}
