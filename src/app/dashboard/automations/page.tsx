'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerPlay, IconRefresh, IconSearch, IconSettingsPause, IconSettingsUp, IconTableOptions } from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';
import type { AutomationView } from '@/lib/services/automations';

type DomainFilter = 'all' | AutomationView['domain'];
type StateFilter = 'all' | AutomationView['state'];

function stateColor(state: AutomationView['state']): string {
  switch (state) {
    case 'active':
      return 'teal';
    case 'running':
      return 'blue';
    case 'paused':
      return 'gray';
    case 'degraded':
      return 'red';
    case 'idle':
      return 'yellow';
    default:
      return 'gray';
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

  const loadAutomations = useCallback(async (silent = false) => {
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
  }, [t]);

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
        ...Object.values(automation.metrics).map((value) => formatMetricValue(value).toLowerCase()),
      ].join(' ').toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [automations, domainFilter, query, stateFilter]);

  const summary = useMemo(() => ({
    total: automations.length,
    active: automations.filter((automation) => automation.state === 'active' || automation.state === 'running').length,
    paused: automations.filter((automation) => automation.state === 'paused').length,
    degraded: automations.filter((automation) => automation.state === 'degraded').length,
  }), [automations]);

  const handleAction = useCallback(async (automation: AutomationView, action: 'run' | 'pause' | 'resume') => {
    const actionKey = `${automation.key}:${action}`;
    setActiveAction(actionKey);
    try {
      const response = await fetch(`/api/automations/${automation.key}/${action}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || t('messages.actionError'));
      }

      const data = await response.json();
      const next = data.automation as AutomationView;
      setAutomations((current) => current.map((item) => (item.key === next.key ? next : item)));
      if (selected?.key === next.key) {
        setSelected(next);
      }

      const successMessageKey = action === 'run'
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
        message: error instanceof Error ? error.message : t('messages.actionError'),
      });
    } finally {
      setActiveAction(null);
    }
  }, [loadAutomations, selected?.key, t]);

  const domainOptions = [
    { value: 'all', label: t('filters.allDomains') },
    { value: 'alerts', label: t('domains.alerts') },
    { value: 'browser', label: t('domains.browser') },
    { value: 'monitoring', label: t('domains.monitoring') },
  ];

  const stateOptions = [
    { value: 'all', label: t('filters.allStates') },
    { value: 'active', label: t('states.active') },
    { value: 'running', label: t('states.running') },
    { value: 'paused', label: t('states.paused') },
    { value: 'degraded', label: t('states.degraded') },
    { value: 'idle', label: t('states.idle') },
  ];

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconTableOptions size={18} />}
        title={t('header.title')}
        subtitle={t('header.subtitle')}
        actions={(
          <Button
            leftSection={<IconRefresh size={14} />}
            variant="light"
            size="xs"
            onClick={() => loadAutomations(true)}
            loading={refreshing}
          >
            {t('actions.refresh')}
          </Button>
        )}
      />

      <Alert color="yellow" variant="light">
        {t('notices.admin')}
      </Alert>

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <SummaryCard label={t('summary.total')} value={summary.total} color="indigo" />
        <SummaryCard label={t('summary.active')} value={summary.active} color="teal" />
        <SummaryCard label={t('summary.paused')} value={summary.paused} color="gray" />
        <SummaryCard label={t('summary.degraded')} value={summary.degraded} color="red" />
      </SimpleGrid>

      <Paper withBorder p="md" radius="lg">
        <Group justify="space-between" wrap="wrap">
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t('filters.searchPlaceholder')}
            leftSection={<IconSearch size={14} />}
            size="xs"
            w={{ base: '100%', md: 320 }}
          />
          <Group gap="sm" wrap="wrap">
            <Select
              data={domainOptions}
              value={domainFilter}
              onChange={(value) => setDomainFilter((value as DomainFilter) ?? 'all')}
              size="xs"
              w={180}
            />
            <Select
              data={stateOptions}
              value={stateFilter}
              onChange={(value) => setStateFilter((value as StateFilter) ?? 'all')}
              size="xs"
              w={180}
            />
          </Group>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="lg">
        {loading ? (
          <Group justify="center" py="xl">
            <Loader />
          </Group>
        ) : (
          <DataTable
            withTableBorder
            borderRadius="sm"
            striped
            highlightOnHover
            idAccessor="key"
            records={filtered}
            minHeight={220}
            noRecordsText={t('table.empty')}
            onRowClick={({ record }) => setSelected(record)}
            columns={[
              {
                accessor: 'name',
                title: t('table.name'),
                render: (automation) => (
                  <Stack gap={2}>
                    <Text fw={600} size="sm">{automation.name}</Text>
                    <Text size="xs" c="dimmed" lineClamp={2}>{automation.description}</Text>
                  </Stack>
                ),
              },
              {
                accessor: 'domain',
                title: t('table.domain'),
                render: (automation) => (
                  <Badge variant="light" color="blue">
                    {t(`domains.${automation.domain}`)}
                  </Badge>
                ),
              },
              {
                accessor: 'state',
                title: t('table.state'),
                render: (automation) => (
                  <Badge variant="light" color={stateColor(automation.state)}>
                    {t(`states.${automation.state}`)}
                  </Badge>
                ),
              },
              {
                accessor: 'cadenceLabel',
                title: t('table.cadence'),
                render: (automation) => (
                  <Stack gap={2}>
                    <Text size="sm">{automation.cadenceLabel}</Text>
                    <Text size="xs" c="dimmed">
                      {automation.distributed ? 'Distributed lock' : 'Local runtime'}
                    </Text>
                  </Stack>
                ),
              },
              {
                accessor: 'metrics',
                title: t('table.metrics'),
                render: (automation) => (
                  <Group gap={6} wrap="wrap">
                    {Object.entries(automation.metrics).slice(0, 3).map(([key, value]) => (
                      <Badge key={key} variant="light" color="gray">
                        {key}: {formatMetricValue(value)}
                      </Badge>
                    ))}
                  </Group>
                ),
              },
              {
                accessor: 'lastRun',
                title: t('table.lastRun'),
                render: (automation) => (
                  <Stack gap={2}>
                    <Text size="sm">{formatTimestamp(automation.lastCompletedAt)}</Text>
                    <Text size="xs" c="dimmed">
                      {automation.lastDurationMs !== null ? `${automation.lastDurationMs} ms` : '—'}
                    </Text>
                  </Stack>
                ),
              },
              {
                accessor: 'actions',
                title: t('table.actions'),
                textAlign: 'right',
                render: (automation) => (
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    {automation.supportsTrigger ? (
                      <ActionIcon
                        variant="subtle"
                        color="blue"
                        onClick={() => handleAction(automation, 'run')}
                        loading={activeAction === `${automation.key}:run`}
                      >
                        <IconPlayerPlay size={16} />
                      </ActionIcon>
                    ) : null}
                    {automation.supportsPause && automation.state !== 'paused' ? (
                      <ActionIcon
                        variant="subtle"
                        color="orange"
                        onClick={() => handleAction(automation, 'pause')}
                        loading={activeAction === `${automation.key}:pause`}
                      >
                        <IconSettingsPause size={16} />
                      </ActionIcon>
                    ) : null}
                    {automation.supportsPause && automation.state === 'paused' ? (
                      <ActionIcon
                        variant="subtle"
                        color="teal"
                        onClick={() => handleAction(automation, 'resume')}
                        loading={activeAction === `${automation.key}:resume`}
                      >
                        <IconSettingsUp size={16} />
                      </ActionIcon>
                    ) : null}
                  </Group>
                ),
              },
            ]}
          />
        )}
      </Paper>

      <Modal
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title={t('detail.title')}
        size="lg"
      >
        {selected ? (
          <Stack gap="md">
            <Stack gap={2}>
              <Text fw={600}>{selected.name}</Text>
              <Text size="sm" c="dimmed">{selected.description}</Text>
            </Stack>

            <Group gap="xs" wrap="wrap">
              <Badge variant="light" color="blue">{t(`domains.${selected.domain}`)}</Badge>
              <Badge variant="light" color={stateColor(selected.state)}>{t(`states.${selected.state}`)}</Badge>
              <Badge variant="light" color={selected.distributed ? 'teal' : 'gray'}>
                {selected.distributed ? 'Distributed lock' : 'Local runtime'}
              </Badge>
            </Group>

            <Paper withBorder p="md" radius="lg">
              <Stack gap="xs">
                <DetailRow label={t('table.cadence')} value={selected.cadenceLabel} />
                <DetailRow label={t('detail.distributed')} value={selected.distributed ? 'Yes' : 'No'} />
                <DetailRow label={t('detail.supportsPause')} value={selected.supportsPause ? 'Yes' : 'No'} />
                <DetailRow label={t('detail.supportsTrigger')} value={selected.supportsTrigger ? 'Yes' : 'No'} />
                <DetailRow label={t('table.lastRun')} value={formatTimestamp(selected.lastCompletedAt)} />
                <DetailRow
                  label={t('detail.lastError')}
                  value={selected.lastError ?? t('detail.none')}
                  multiline={Boolean(selected.lastError)}
                />
              </Stack>
            </Paper>

            <Paper withBorder p="md" radius="lg">
              <Stack gap="sm">
                <Text fw={600}>{t('detail.metrics')}</Text>
                <Code block>{JSON.stringify(selected.metrics, null, 2)}</Code>
              </Stack>
            </Paper>
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Stack gap={2}>
        <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
        <Text fw={700} size="xl" c={color}>{value}</Text>
      </Stack>
    </Paper>
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
    <Group align={multiline ? 'flex-start' : 'center'} justify="space-between" wrap="nowrap">
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="sm" ta="right" style={multiline ? { whiteSpace: 'pre-wrap' } : undefined}>
        {value}
      </Text>
    </Group>
  );
}
