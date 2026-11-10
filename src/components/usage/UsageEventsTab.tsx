'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Group, Loader, Paper, Select, Stack, Text, Title } from '@mantine/core';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { apiRequest } from '@/lib/api/client';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { PlanLimitEvent } from '@/lib/limits/types';
import { formatBytes, formatNumber } from './format';

/** Events as the API sends them: `at` is an ISO string. */
type EventRow = Omit<PlanLimitEvent, 'at'> & { at: string };

const PERIODS = { day: 24, week: 24 * 7, month: 24 * 30 } as const;
type PeriodId = keyof typeof PERIODS;

export default function UsageEventsTab() {
  const t = useTranslations('usage');
  const locale = useLocale();
  const [period, setPeriod] = useState<PeriodId>('day');
  const [dimension, setDimension] = useState<string>('');
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const since = new Date(Date.now() - PERIODS[period] * 3_600_000).toISOString();
      const params = new URLSearchParams({ since, limit: '500' });
      const data = await apiRequest<{ events?: EventRow[] }>(`/api/usage/events?${params.toString()}`);
      setEvents(data.events ?? []);
    } catch {
      setError(true);
      setEvents([]);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const dimensionLabel = useCallback(
    (value: string | undefined) => {
      if (!value) return '';
      const key = `rows.${value}`;
      const label = t(key);
      // An unknown dimension comes back as the key itself: show the raw name.
      return label === `usage.${key}` || label === key ? value : label;
    },
    [t],
  );

  const options = useMemo(() => {
    const seen = new Set((events ?? []).map((event) => event.dimension).filter((value): value is string => !!value));
    return [
      { value: '', label: t('events.allDimensions') },
      ...[...seen].sort().map((value) => ({ value, label: dimensionLabel(value) })),
    ];
  }, [events, t, dimensionLabel]);

  const rows = useMemo(
    () => (events ?? []).filter((event) => !dimension || event.dimension === dimension),
    [events, dimension],
  );

  const amount = (event: EventRow, value: number | undefined) =>
    value === undefined ? '' : event.kind === 'storage' ? formatBytes(value, locale) : formatNumber(value, locale);

  const columns: DataGridColumn<EventRow>[] = [
    { key: 'at', label: t('events.columns.time'), render: (row) => <Text size="sm">{new Date(row.at).toLocaleString(locale)}</Text> },
    { key: 'dimension', label: t('events.columns.dimension'), render: (row) => <Text size="sm">{dimensionLabel(row.dimension)}</Text> },
    { key: 'outcome', label: t('events.columns.outcome'), render: (row) => <Text size="sm">{t(`events.outcomes.${row.outcome}`)}</Text> },
    {
      key: 'source',
      label: t('events.columns.source'),
      render: (row) => (
        <Text size="sm" c="dimmed">
          {row.source ? [t(`events.sources.${row.source.type}`), row.source.label].filter(Boolean).join(' · ') : ''}
        </Text>
      ),
    },
    {
      key: 'usage',
      label: t('events.columns.usage'),
      align: 'right',
      render: (row) => (
        <Text size="sm">
          {row.used === undefined && row.limit === undefined ? '' : `${amount(row, row.used)} / ${amount(row, row.limit)}`}
        </Text>
      ),
    },
    {
      key: 'wait',
      label: t('events.columns.wait'),
      align: 'right',
      render: (row) => (
        <Text size="sm">{row.waitMs === undefined ? '' : t('events.seconds', { seconds: formatNumber(row.waitMs / 1000, locale) })}</Text>
      ),
    },
    { key: 'count', label: t('events.columns.count'), align: 'right', render: (row) => <Text size="sm">{row.count}</Text> },
  ];

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <div>
          <Title order={4}>{t('events.title')}</Title>
          <Text size="sm" c="dimmed">{t('events.description')}</Text>
        </div>
        <Group gap="sm" wrap="wrap">
          <Select
            label={t('events.sinceLabel')}
            allowDeselect={false}
            value={period}
            onChange={(value) => value && setPeriod(value as PeriodId)}
            data={(Object.keys(PERIODS) as PeriodId[]).map((id) => ({ value: id, label: t(`events.since.${id}`) }))}
            w={200}
          />
          <Select
            label={t('events.dimensionLabel')}
            allowDeselect={false}
            value={dimension}
            onChange={(value) => setDimension(value ?? '')}
            data={options}
            w={240}
          />
        </Group>
        {error ? <Alert color="red">{t('loadError')}</Alert> : null}
        {events === null ? (
          <Group justify="center" py="md"><Loader size="sm" /></Group>
        ) : rows.length === 0 && !error ? (
          <Text size="sm" c="dimmed">{t('events.empty')}</Text>
        ) : (
          <DataGrid<EventRow>
            records={rows}
            rowKey={(row) => `${row.at}|${row.kind}|${row.dimension ?? ''}|${row.outcome}|${row.source?.type ?? ''}|${row.source?.id ?? ''}`}
            columns={columns}
          />
        )}
      </Stack>
    </Paper>
  );
}
