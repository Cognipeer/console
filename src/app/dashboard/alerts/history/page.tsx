'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Group, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconBellCheck, IconCheck } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { formatDateTime, formatRelative } from '@/components/iam/timeFormat';
import LoadError from '@/components/alerts/LoadError';
import { apiErrorMessage } from '@/components/alerts/apiError';
import { entityHref, entityOf, entityTypeLabel, metricLabel } from '@/components/alerts/alertCatalog';
import { useAlertMeta } from '@/components/alerts/useAlertMeta';
import { userLabel, useUserDirectory } from '@/components/alerts/useUserDirectory';
import { describeRowValue } from '@/components/alerts/incidentUi';
import type { AlertEventDto } from '@/components/alerts/alertTypes';
import { useAcknowledgeAlertEvent, useAlertHistory } from '@/lib/api/queries/alerts';
import { useLocale, useTranslations } from '@/lib/i18n';

const PAGE_SIZE_OPTIONS = [25, 50];

const STATUS_CLASSES: Record<AlertEventDto['status'], string> = {
  fired: 'ds-badge ds-badge-err',
  acknowledged: 'ds-badge ds-badge-info',
  resolved: 'ds-badge ds-badge-ok',
};

export default function AlertHistoryPage() {
  const t = useTranslations('alerts');
  const ti = useTranslations('incidents');
  const locale = useLocale();
  const { catalog } = useAlertMeta();
  const directory = useUserDirectory();

  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]!);

  const historyQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    // One extra row tells whether another page exists.
    params.set('limit', String(pageSize + 1));
    params.set('skip', String((page - 1) * pageSize));
    return params.toString();
  }, [statusFilter, page, pageSize]);
  const history = useAlertHistory(historyQuery);
  const rawRows = history.data?.events ?? [];
  const events = rawRows.slice(0, pageSize);
  const hasMore = rawRows.length > pageSize;
  const activeCount = history.data?.activeCount ?? 0;
  // A new filter or page shows the loading state over the rows it replaces; a reload of the same page refreshes in place.
  const loading = history.isPending || history.isPlaceholderData;
  const refreshing = history.isFetching && !loading;
  const loadError = history.isError ? apiErrorMessage(history.error, t('loadHistoryError')) : null;

  const acknowledgeEvent = useAcknowledgeAlertEvent();
  const acknowledge = async (event: AlertEventDto) => {
    try {
      await acknowledgeEvent.mutateAsync(event._id);
      notifications.show({ title: t('acknowledged'), message: t('acknowledgedMessage'), color: 'teal' });
    } catch (error) {
      notifications.show({ title: t('error'), message: apiErrorMessage(error, t('acknowledgeError')), color: 'red' });
    }
  };

  const needle = search.trim().toLowerCase();
  const rows = needle
    ? events.filter((event) => [event.ruleName, event.metric, metricLabel(catalog, event.metric, t), entityOf(event)?.key ?? ''].join(' ').toLowerCase().includes(needle))
    : events;

  const columns: DataGridColumn<AlertEventDto>[] = [
    {
      key: 'status',
      label: t('columns.kind'),
      render: (event) => <span className={STATUS_CLASSES[event.status] ?? 'ds-badge'}>{t(`eventStatus.${event.status}`)}</span>,
    },
    {
      key: 'rule',
      label: t('columns.rule'),
      render: (event) => (
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} lineClamp={1}>
            {event.ruleName}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {metricLabel(catalog, event.metric, t)}
          </Text>
        </div>
      ),
    },
    {
      key: 'entity',
      label: t('columns.entity'),
      render: (event) => {
        const entity = entityOf(event);
        if (!entity) return <Text size="xs" c="dimmed">—</Text>;
        const href = entityHref(entity.type, entity.key);
        const chip = (
          <span className="ds-badge" title={entityTypeLabel(entity.type, t)}>
            <span className="ds-mono" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entity.key}
            </span>
          </span>
        );
        return href ? (
          <Link href={href} style={{ textDecoration: 'none' }}>
            {chip}
          </Link>
        ) : (
          chip
        );
      },
    },
    {
      key: 'value',
      label: t('columns.value'),
      render: (event) => {
        const text = describeRowValue(event, catalog, t, locale);
        return (
          <div>
            <Text size="sm" fw={600}>
              {text.value}
            </Text>
            {text.compare ? (
              <Text size="xs" c="dimmed">
                {text.compare}
              </Text>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'fired',
      label: t('columns.firedAt'),
      render: (event) => (
        <Text size="xs" title={formatDateTime(event.firedAt, locale)}>
          {formatRelative(event.firedAt, locale)}
        </Text>
      ),
    },
    {
      key: 'resolved',
      label: t('columns.resolvedAt'),
      render: (event) =>
        event.resolvedAt ? (
          <Text size="xs" title={formatDateTime(event.resolvedAt, locale)}>
            {formatRelative(event.resolvedAt, locale)}
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        ),
    },
    {
      key: 'acknowledged',
      label: t('columns.acknowledgedBy'),
      render: (event) =>
        event.acknowledgedAt ? (
          <div>
            <Text size="xs" lineClamp={1}>
              {userLabel(event.acknowledgedBy, directory, { you: ti('you'), system: ti('system') })}
            </Text>
            <Text size="xs" c="dimmed" title={formatDateTime(event.acknowledgedAt, locale)}>
              {formatRelative(event.acknowledgedAt, locale)}
            </Text>
          </div>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        ),
    },
    {
      key: 'notifications',
      label: t('columns.notifications'),
      render: (event) => {
        const total = event.channels?.length ?? 0;
        if (total === 0) return <Text size="xs" c="dimmed">—</Text>;
        const sent = event.channels.filter((channel) => channel.success).length;
        const failures = event.channels.filter((channel) => !channel.success && channel.error).map((channel) => `${channel.type}: ${channel.error}`);
        return (
          <Text size="xs" c={sent === total ? undefined : 'orange'} title={failures.join('\n') || undefined}>
            {t('history.notificationsSent', { sent, total })}
          </Text>
        );
      },
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('historyEyebrow')}
        title={t('historyTitle')}
        subtitle={t('historySubtitle')}
        actions={
          <Group gap="xs">
            {activeCount > 0 ? (
              <Badge color="red" variant="filled" size="lg">
                {activeCount} {t('activeAlerts')}
              </Badge>
            ) : null}
            <Button component={Link} href="/dashboard/alerts" variant="light" size="xs" leftSection={<IconArrowLeft size={14} />}>
              {t('backToRules')}
            </Button>
          </Group>
        }
      />

      {loadError ? (
        <div style={{ marginBottom: 12 }}>
          <LoadError message={loadError} onRetry={() => void history.refetch()} />
        </div>
      ) : null}

      <DataGrid<AlertEventDto>
        records={rows}
        rowKey={(event) => event._id}
        columns={columns}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => void history.refetch()}
        search={{ value: search, onChange: setSearch, placeholder: t('searchHistoryPlaceholder') }}
        filters={[
          {
            value: statusFilter,
            onChange: (value) => {
              setStatusFilter(value);
              setPage(1);
            },
            options: [
              { value: '', label: t('filters.allStatuses') },
              { value: 'fired', label: t('eventStatus.fired') },
              { value: 'acknowledged', label: t('eventStatus.acknowledged') },
              { value: 'resolved', label: t('eventStatus.resolved') },
            ],
            ariaLabel: t('filterByStatus'),
            width: 160,
          },
        ]}
        rowActions={(event) => [
          {
            id: 'acknowledge',
            label: t('acknowledge'),
            icon: <IconCheck size={14} />,
            hidden: event.status !== 'fired',
            onClick: () => void acknowledge(event),
          },
        ]}
        empty={{ icon: <IconBellCheck size={28} />, title: t('noEvents'), description: t('noEventsDescription') }}
        pagination={{
          page,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setPage(1);
          },
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          hasMore,
        }}
      />
    </PageContainer>
  );
}
