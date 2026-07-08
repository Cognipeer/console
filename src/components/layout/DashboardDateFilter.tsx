'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Group, Select } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconCalendar } from '@tabler/icons-react';
import {
  applyDashboardDateFilterToSearchParams,
  dashboardDateFilterFromSearchParams,
  dashboardDateFilterKey,
  parseLocalDate,
  type DashboardDateFilterState,
  type DashboardDatePeriod,
} from '@/lib/utils/dashboardDateFilter';

interface DashboardDateFilterProps {
  value: DashboardDateFilterState;
  onChange: (next: DashboardDateFilterState) => void;
}

const periodOptions: Array<{ value: DashboardDatePeriod; label: string }> = [
  { value: 'total', label: 'Total' },
  { value: 'last_day', label: 'Last day' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' },
];

/**
 * URL-synced replacement for `useState(defaultDashboardDateFilter)`.
 * Initializes from ?period/&from/&to, writes changes back with
 * router.replace (shareable links, filter survives drill-down navigation)
 * and follows external URL changes (back/forward, links from other pages).
 */
export function useDashboardDateFilterState(): [
  DashboardDateFilterState,
  (next: DashboardDateFilterState) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<DashboardDateFilterState>(() =>
    dashboardDateFilterFromSearchParams(new URLSearchParams(searchParams.toString())));

  const update = useCallback(
    (next: DashboardDateFilterState) => {
      setFilter(next);
      const params = new URLSearchParams(searchParams.toString());
      applyDashboardDateFilterToSearchParams(next, params);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  useEffect(() => {
    const parsed = dashboardDateFilterFromSearchParams(
      new URLSearchParams(searchParams.toString()),
    );
    // Keep object identity stable unless the URL actually changed the filter,
    // so effects keyed on the filter don't refetch after our own replace().
    setFilter((prev) =>
      dashboardDateFilterKey(prev) === dashboardDateFilterKey(parsed) ? prev : parsed);
  }, [searchParams]);

  return [filter, update];
}

export default function DashboardDateFilter({
  value,
  onChange,
}: DashboardDateFilterProps) {
  return (
    <Group gap="xs">
      <Select
        size="sm"
        w={{ base: '100%', xs: 140 }}
        data={periodOptions}
        value={value.period}
        onChange={(next) => {
          const period = (next as DashboardDatePeriod | null) ?? 'total';
          onChange({
            period,
            dateRange: period === 'custom' ? value.dateRange : [null, null],
          });
        }}
      />
      <DatePickerInput
        type="range"
        value={value.dateRange}
        clearable
        size="sm"
        w={{ base: '100%', xs: 220 }}
        placeholder="Select date range"
        valueFormat="MMM D, YYYY"
        leftSection={<IconCalendar size={14} stroke={1.5} />}
        onChange={(dateRange) => {
          // Mantine 8 emits 'YYYY-MM-DD' strings — normalize to local Dates.
          const from = parseLocalDate(dateRange[0]);
          const to = parseLocalDate(dateRange[1]);
          if (!from && !to) {
            onChange({ period: 'total', dateRange: [null, null] });
            return;
          }
          onChange({ period: 'custom', dateRange: [from, to] });
        }}
      />
    </Group>
  );
}
