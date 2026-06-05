'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconActivity,
  IconAlertTriangle,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconSettingsUp,
  IconTableOptions,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import type { AutomationView } from '@/lib/services/automations';

type DomainFilter = 'all' | AutomationView['domain'];
type StateFilter = 'all' | AutomationView['state'];

function stateBadgeStatus(state: AutomationView['state']) {
  switch (state) {
    case 'active':
    case 'running':
      return 'active';
    case 'paused':
      return 'pending';
    case 'degraded':
      return 'failed';
    case 'idle':
      return 'pending';
    default:
      return 'pending';
  }
}

function formatMetricValue(value: boolean | number | string | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function formatTimestamp(value: Date | string | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function AutomationsPage() {
  const t = useTranslations('automations');
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [domainFilter, setDomainFilter] = useState<DomainFilter>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [selected, setSelected] = useState<AutomationView | null>(null);

  const loadAutomations = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);

      try {
        const response = await fetch('/api/automations', { cache: 'no-store' });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || t('messages.loadError'));
        }

        const data = await response.json();
        setAutomations(data.automations ?? []);
      } catch (error) {
        notifications.show({
          color: 'red',
          title: 'Error',
          message: error instanceof Error ? error.message : t('messages.loadError'),
        });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return automations.filter((automation) => {
      if (domainFilter !== 'all' && automation.domain !== domainFilter) return false;
      if (stateFilter !== 'all' && automation.state !== stateFilter) return false;
      if (!normalizedQuery) return true;

      const haystack = [
        automation.name,
        automation.description,
        automation.domain,
        automation.cadenceLabel,
        ...Object.keys(automation.metrics),
        ...Object.values(automation.metrics).map((value) =>
          formatMetricValue(value).toLowerCase(),
        ),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [automations, domainFilter, query, stateFilter]);

  const summary = useMemo(
    () => ({
      total: automations.length,
      active: automations.filter(
        (automation) =>
          automation.state === 'active' || automation.state === 'running',
      ).length,
      paused: automations.filter((automation) => automation.state === 'paused').length,
      degraded: automations.filter((automation) => automation.state === 'degraded')
        .length,
    }),
    [automations],
  );

  const handleAction = useCallback(
    async (automation: AutomationView, action: 'run' | 'pause' | 'resume') => {
      const actionKey = `${automation.key}:${action}`;
      setActiveAction(actionKey);
      try {
        const response = await fetch(
          `/api/automations/${automation.key}/${action}`,
          { method: 'POST' },
        );

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || t('messages.actionError'));
        }

        const data = await response.json();
        const next = data.automation as AutomationView;
        setAutomations((current) =>
          current.map((item) => (item.key === next.key ? next : item)),
        );
        if (selected?.key === next.key) {
          setSelected(next);
        }

        const successMessageKey =
          action === 'run'
            ? 'messages.runSuccess'
            : action === 'pause'
              ? 'messages.pauseSuccess'
              : 'messages.resumeSuccess';

        notifications.show({
          color: 'teal',
          title: 'Success',
          message: t(successMessageKey),
        });

        await loadAutomations(true);
      } catch (error) {
        notifications.show({
          color: 'red',
          title: 'Error',
          message:
            error instanceof Error ? error.message : t('messages.actionError'),
        });
      } finally {
        setActiveAction(null);
      }
    },
    [loadAutomations, selected?.key, t],
  );

  const columns: DataGridColumn<AutomationView>[] = [
    {
      key: 'name',
      label: t('table.name'),
      render: (automation) => (
        <div className="ds-col" style={{ gap: 2, maxWidth: 360 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{automation.name}</span>
          <span
            className="ds-muted"
            style={{
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {automation.description}
          </span>
        </div>
      ),
    },
    {
      key: 'domain',
      label: t('table.domain'),
      render: (automation) => (
        <span className="ds-badge ds-badge-info">
          {t(`domains.${automation.domain}`)}
        </span>
      ),
    },
    {
      key: 'state',
      label: t('table.state'),
      render: (automation) => (
        <StatusBadge
          status={stateBadgeStatus(automation.state)}
          label={t(`states.${automation.state}`)}
        />
      ),
    },
    {
      key: 'cadence',
      label: t('table.cadence'),
      render: (automation) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 12.5 }}>{automation.cadenceLabel}</span>
          <span className="ds-faint" style={{ fontSize: 11 }}>
            {automation.distributed ? 'Distributed lock' : 'Local runtime'}
          </span>
        </div>
      ),
    },
    {
      key: 'metrics',
      label: t('table.metrics'),
      render: (automation) => (
        <div className="ds-row ds-gap-xs" style={{ flexWrap: 'wrap' }}>
          {Object.entries(automation.metrics)
            .slice(0, 3)
            .map(([key, value]) => (
              <span key={key} className="ds-badge">
                {key}: {formatMetricValue(value)}
              </span>
            ))}
        </div>
      ),
    },
    {
      key: 'lastRun',
      label: t('table.lastRun'),
      render: (automation) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 12.5 }}>
            {formatTimestamp(automation.lastCompletedAt)}
          </span>
          <span className="ds-faint" style={{ fontSize: 11 }}>
            {automation.lastDurationMs !== null
              ? `${automation.lastDurationMs} ms`
              : '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'actions',
      label: t('table.actions'),
      align: 'right',
      render: (automation) => (
        <div
          role="presentation"
          className="ds-row ds-gap-xs"
          style={{ justifyContent: 'flex-end' }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {automation.supportsTrigger ? (
            <Tooltip label={t('actions.run')} withArrow>
              <ActionIcon
                variant="subtle"
                color="blue"
                radius="md"
                onClick={() => handleAction(automation, 'run')}
                loading={activeAction === `${automation.key}:run`}
                aria-label={t('actions.run')}
              >
                <IconPlayerPlay size={15} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          ) : null}
          {automation.supportsPause && automation.state !== 'paused' ? (
            <Tooltip label={t('actions.pause')} withArrow>
              <ActionIcon
                variant="subtle"
                color="orange"
                radius="md"
                onClick={() => handleAction(automation, 'pause')}
                loading={activeAction === `${automation.key}:pause`}
                aria-label={t('actions.pause')}
              >
                <IconPlayerPause size={15} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          ) : null}
          {automation.supportsPause && automation.state === 'paused' ? (
            <Tooltip label={t('actions.resume')} withArrow>
              <ActionIcon
                variant="subtle"
                color="teal"
                radius="md"
                onClick={() => handleAction(automation, 'resume')}
                loading={activeAction === `${automation.key}:resume`}
                aria-label={t('actions.resume')}
              >
                <IconSettingsUp size={15} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Automations"
        title={t('header.title')}
        subtitle={t('header.subtitle')}
        actions={
          <Button
            leftSection={<IconRefresh size={14} stroke={1.7} />}
            variant="default"
            size="sm"
            onClick={() => loadAutomations(true)}
            loading={refreshing}
          >
            {t('actions.refresh')}
          </Button>
        }
      />

      <Alert
        color="yellow"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        style={{ marginBottom: 16 }}
      >
        {t('notices.admin')}
      </Alert>

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label={t('summary.total')}
          value={summary.total}
          icon={<IconTableOptions size={14} stroke={1.7} />}
        />
        <StatTile
          label={t('summary.active')}
          value={summary.active}
          icon={<IconActivity size={14} stroke={1.7} />}
        />
        <StatTile
          label={t('summary.paused')}
          value={summary.paused}
          icon={<IconPlayerPause size={14} stroke={1.7} />}
        />
        <StatTile
          label={t('summary.degraded')}
          value={summary.degraded}
          icon={<IconAlertTriangle size={14} stroke={1.7} />}
        />
      </div>

      <DataGrid<AutomationView>
        records={filtered}
        loading={loading}
        rowKey={(a) => a.key}
        onRowClick={(a) => setSelected(a)}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t('filters.searchPlaceholder'),
        }}
        filters={[
          {
            value: domainFilter,
            onChange: (v) => setDomainFilter(v as DomainFilter),
            ariaLabel: 'Domain',
            width: 160,
            options: [
              { value: 'all', label: t('filters.allDomains') },
              { value: 'alerts', label: t('domains.alerts') },
              { value: 'browser', label: t('domains.browser') },
              { value: 'monitoring', label: t('domains.monitoring') },
            ],
          },
          {
            value: stateFilter,
            onChange: (v) => setStateFilter(v as StateFilter),
            ariaLabel: 'State',
            width: 160,
            options: [
              { value: 'all', label: t('filters.allStates') },
              { value: 'active', label: t('states.active') },
              { value: 'running', label: t('states.running') },
              { value: 'paused', label: t('states.paused') },
              { value: 'degraded', label: t('states.degraded') },
              { value: 'idle', label: t('states.idle') },
            ],
          },
        ]}
        onRefresh={() => loadAutomations(true)}
        refreshing={refreshing}
        empty={{
          icon: <IconTableOptions size={26} stroke={1.7} />,
          title: t('table.empty'),
        }}
        footerLeft={`Showing ${filtered.length} of ${automations.length}`}
        columns={columns}
      />

      <Modal
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title={t('detail.title')}
        size="lg"
      >
        {selected ? (
          <Stack gap="md">
            <div>
              <Text fw={600}>{selected.name}</Text>
              <Text size="sm" c="dimmed">
                {selected.description}
              </Text>
            </div>

            <Group gap="xs" wrap="wrap">
              <span className="ds-badge ds-badge-info">
                {t(`domains.${selected.domain}`)}
              </span>
              <StatusBadge
                status={stateBadgeStatus(selected.state)}
                label={t(`states.${selected.state}`)}
              />
              <span
                className={`ds-badge ${selected.distributed ? 'ds-badge-teal' : ''}`}
              >
                {selected.distributed ? 'Distributed lock' : 'Local runtime'}
              </span>
            </Group>

            <div className="ds-card ds-card-pad">
              <Stack gap="xs">
                <DetailRow label={t('table.cadence')} value={selected.cadenceLabel} />
                <DetailRow
                  label={t('detail.distributed')}
                  value={selected.distributed ? 'Yes' : 'No'}
                />
                <DetailRow
                  label={t('detail.supportsPause')}
                  value={selected.supportsPause ? 'Yes' : 'No'}
                />
                <DetailRow
                  label={t('detail.supportsTrigger')}
                  value={selected.supportsTrigger ? 'Yes' : 'No'}
                />
                <DetailRow
                  label={t('table.lastRun')}
                  value={formatTimestamp(selected.lastCompletedAt)}
                />
                <DetailRow
                  label={t('detail.lastError')}
                  value={selected.lastError ?? t('detail.none')}
                  multiline={Boolean(selected.lastError)}
                />
              </Stack>
            </div>

            <div className="ds-card ds-card-pad">
              <Stack gap="sm">
                <Text fw={600}>{t('detail.metrics')}</Text>
                <Code block>{JSON.stringify(selected.metrics, null, 2)}</Code>
              </Stack>
            </div>
          </Stack>
        ) : null}
      </Modal>
    </PageContainer>
  );
}

function DetailRow({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <Group
      align={multiline ? 'flex-start' : 'center'}
      justify="space-between"
      wrap="nowrap"
    >
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text
        size="sm"
        ta="right"
        style={multiline ? { whiteSpace: 'pre-wrap' } : undefined}
      >
        {value}
      </Text>
    </Group>
  );
}
