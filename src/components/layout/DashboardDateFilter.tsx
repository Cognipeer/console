'use client';

import { Group, Select } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconCalendar } from '@tabler/icons-react';
import type {
  DashboardDateFilterState,
  DashboardDatePeriod,
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

export default function DashboardDateFilter({
  value,
  onChange,
}: DashboardDateFilterProps) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Select
        size="xs"
        w={140}
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
        size="xs"
        w={220}
        placeholder="Select date range"
        valueFormat="MMM D, YYYY"
        leftSection={<IconCalendar size={14} stroke={1.5} />}
        onChange={(dateRange) => {
          const [from, to] = dateRange;
          if (!from && !to) {
            onChange({ period: 'total', dateRange: [null, null] });
            return;
          }
          onChange({
            period: 'custom',
            dateRange: dateRange as [Date | null, Date | null],
          });
        }}
      />
    </Group>
  );
}