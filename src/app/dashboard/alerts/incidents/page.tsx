'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Paper,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconAlertTriangle,
  IconCheck,
  IconSearch,
  IconShieldCheck,
  IconLock,
  IconDots,
  IconEye,
  IconFlame,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { useTranslations } from '@/lib/i18n';

interface IncidentNote {
  userId: string;
  userName: string;
  content: string;
  createdAt: string;
}

interface Incident {
  _id: string;
  ruleName: string;
  ruleId: string;
  alertEventId: string;
  metric: string;
  threshold: number;
  actualValue: number;
  severity: 'critical' | 'warning' | 'info';
  status: 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'closed';
  assignedTo?: string;
  notes: IncidentNote[];
  firedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  resolvedBy?: string;
  metadata?: Record<string, unknown>;
}

const METRIC_LABELS: Record<string, string> = {
  error_rate: 'Error Rate',
  avg_latency_ms: 'Avg Latency',
  p95_latency_ms: 'P95 Latency',
  total_cost: 'Total Cost',
  total_requests: 'Total Requests',
  gpu_cache_usage: 'GPU Cache',
  request_queue_depth: 'Queue Depth',
  guardrail_fail_rate: 'Fail Rate',
  guardrail_avg_latency_ms: 'Avg Latency',
  guardrail_total_evaluations: 'Total Evals',
  rag_avg_latency_ms: 'Avg Latency',
  rag_total_queries: 'Total Queries',
  rag_failed_documents: 'Failed Docs',
};

const METRIC_UNITS: Record<string, string> = {
  error_rate: '%',
  avg_latency_ms: 'ms',
  p95_latency_ms: 'ms',
  total_cost: 'USD',
  total_requests: '',
  gpu_cache_usage: '%',
  request_queue_depth: '',
  guardrail_fail_rate: '%',
  guardrail_avg_latency_ms: 'ms',
  guardrail_total_evaluations: '',
  rag_avg_latency_ms: 'ms',
  rag_total_queries: '',
  rag_failed_documents: '',
};

const MODULE_LABELS: Record<string, string> = {
  models: 'Model Hub',
  inference: 'Model Monitoring',
  guardrails: 'Guardrail',
  rag: 'Knowledge Engine',
};

const MODULE_COLORS: Record<string, string> = {
  models: 'blue',
  inference: 'teal',
  guardrails: 'grape',
  rag: 'indigo',
};

const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  eq: '=',
};

/** Infer module from metric name */
function inferModule(metric: string): string {
  if (['error_rate', 'avg_latency_ms', 'p95_latency_ms', 'total_cost', 'total_requests'].includes(metric)) return 'models';
  if (['gpu_cache_usage', 'request_queue_depth'].includes(metric)) return 'inference';
  if (metric.startsWith('guardrail_')) return 'guardrails';
  if (metric.startsWith('rag_')) return 'rag';
  return 'models';
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'red',
  warning: 'orange',
  info: 'blue',
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'red',
  acknowledged: 'blue',
  investigating: 'violet',
  resolved: 'green',
  closed: 'gray',
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  investigating: 'Investigating',
  resolved: 'Resolved',
  closed: 'Closed',
};

const STATUS_ICONS: Record<string, typeof IconAlertTriangle> = {
  open: IconFlame,
  acknowledged: IconEye,
  investigating: IconSearch,
  resolved: IconCheck,
  closed: IconLock,
};

export default function IncidentsPage() {
  const router = useRouter();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const t = useTranslations('incidents');

  const fetchIncidents = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (severityFilter) params.set('severity', severityFilter);
      params.set('limit', '100');
      const res = await fetch(`/api/alerts/incidents?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch incidents');
      const data = await res.json();
      setIncidents(data.incidents || []);
      setOpenCount(data.openCount || 0);
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: err instanceof Error ? err.message : 'Failed to load incidents',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, severityFilter, t]);

  useEffect(() => {
    fetchIncidents();
  }, [fetchIncidents]);

  const handleStatusChange = async (incidentId: string, newStatus: string) => {
    try {
      const res = await fetch(`/api/alerts/incidents/${incidentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update status');
      }
      const data = await res.json();
      setIncidents((prev) =>
        prev.map((inc) => (inc._id === incidentId ? data.incident : inc)),
      );
      if (newStatus === 'resolved' || newStatus === 'closed') {
        setOpenCount((prev) => Math.max(0, prev - 1));
      }
      notifications.show({
        title: t('statusUpdated'),
        message: t('statusUpdatedMessage', { status: STATUS_LABELS[newStatus] || newStatus }),
        color: 'teal',
      });
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: err instanceof Error ? err.message : t('statusUpdateError'),
        color: 'red',
      });
    }
  };

  const openDetail = (incident: Incident) => {
    router.push(`/dashboard/alerts/incidents/${incident._id}`);
  };

  if (loading) {
    return (
      <Stack align="center" justify="center" h={400}>
        <Loader size="lg" />
      </Stack>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Incidents"
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Group gap="xs">
            {openCount > 0 && (
              <Badge color="red" variant="filled" size="lg">
                {openCount} {t('openIncidents')}
              </Badge>
            )}
            <Button
              component={Link}
              href="/dashboard/alerts"
              variant="light"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
            >
              {t('backToAlerts')}
            </Button>
          </Group>
        }
      />

      {/* Filters */}
      <Group>
        <Select
          size="xs"
          placeholder={t('filterByStatus')}
          data={[
            { value: 'open', label: 'Open' },
            { value: 'acknowledged', label: 'Acknowledged' },
            { value: 'investigating', label: 'Investigating' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'closed', label: 'Closed' },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
          clearable
          w={200}
        />
        <Select
          size="xs"
          placeholder={t('filterBySeverity')}
          data={[
            { value: 'critical', label: 'Critical' },
            { value: 'warning', label: 'Warning' },
            { value: 'info', label: 'Info' },
          ]}
          value={severityFilter}
          onChange={setSeverityFilter}
          clearable
          w={200}
        />
      </Group>

      {/* Incidents List */}
      {incidents.length === 0 ? (
        <Paper p="xl" radius="md" withBorder>
          <Stack align="center" gap="md" py="xl">
            <ThemeIcon size={60} radius="xl" variant="light" color="green">
              <IconShieldCheck size={28} />
            </ThemeIcon>
            <Text size="lg" fw={600}>{t('noIncidents')}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={400}>
              {t('noIncidentsDescription')}
            </Text>
          </Stack>
        </Paper>
      ) : (
        <Stack gap="sm">
          {incidents.map((incident) => {
            const StatusIcon = STATUS_ICONS[incident.status] ?? IconAlertTriangle;
            return (
              <Paper key={incident._id} p="md" radius="md" withBorder>
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="md" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <ThemeIcon
                      size={36}
                      radius="md"
                      variant="light"
                      color={STATUS_COLORS[incident.status] ?? 'gray'}
                    >
                      <StatusIcon size={18} />
                    </ThemeIcon>
                    <div style={{ minWidth: 0 }}>
                      <Group gap="xs" wrap="nowrap">
                        <Text fw={600} size="sm" lineClamp={1}>
                          {incident.ruleName}
                        </Text>
                        <Badge
                          size="xs"
                          variant="light"
                          color={MODULE_COLORS[inferModule(incident.metric)] ?? 'gray'}
                        >
                          {MODULE_LABELS[inferModule(incident.metric)] ?? inferModule(incident.metric)}
                        </Badge>
                        <Badge
                          size="xs"
                          variant="light"
                          color={SEVERITY_COLORS[incident.severity] ?? 'gray'}
                        >
                          {SEVERITY_LABELS[incident.severity] ?? incident.severity}
                        </Badge>
                        <Badge
                          size="xs"
                          variant="light"
                          color={STATUS_COLORS[incident.status] ?? 'gray'}
                        >
                          {STATUS_LABELS[incident.status] ?? incident.status}
                        </Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mt={2}>
                        {METRIC_LABELS[incident.metric] ?? incident.metric}:{' '}
                        <Text span fw={600} c="orange">
                          {Number(incident.actualValue).toFixed(2)}
                          {METRIC_UNITS[incident.metric] ?? ''}
                        </Text>
                        {' '}
                        ({OPERATOR_SYMBOLS[(incident.metadata?.operator as string)] ?? '>'}{' '}
                        {incident.threshold}
                        {METRIC_UNITS[incident.metric] ?? ''})
                        {(() => {
                          if (!incident.metadata?.scope) return null;
                          const scope = incident.metadata.scope as Record<string, string>;
                          const parts: string[] = [];
                          if (scope.modelKey) parts.push(`model: ${scope.modelKey}`);
                          if (scope.serverKey) parts.push(`server: ${scope.serverKey}`);
                          if (scope.guardrailKey) parts.push(`guardrail: ${scope.guardrailKey}`);
                          if (scope.ragModuleKey) parts.push(`rag: ${scope.ragModuleKey}`);
                          return parts.length > 0 ? ` · ${parts.join(', ')}` : null;
                        })()}
                      </Text>
                      <Text size="xs" c="dimmed" mt={2}>
                        {new Date(incident.firedAt).toLocaleString()}
                        {incident.metadata?.windowMinutes ? (
                          <Text span> · {String(incident.metadata.windowMinutes)}min window</Text>
                        ) : null}
                        {incident.metadata?.sampleCount != null ? (
                          <Text span> · {String(incident.metadata.sampleCount)} samples</Text>
                        ) : null}
                        {incident.notes.length > 0 && (
                          <Text span ml="xs">
                            · {incident.notes.length} {t('notes')}
                          </Text>
                        )}
                      </Text>
                    </div>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label={t('viewDetail')}>
                      <ActionIcon
                        variant="light"
                        color="gray"
                        size="sm"
                        onClick={() => openDetail(incident)}
                      >
                        <IconEye size={14} />
                      </ActionIcon>
                    </Tooltip>
                    {incident.status !== 'resolved' && incident.status !== 'closed' && (
                      <Menu position="bottom-end" withinPortal shadow="md">
                        <Menu.Target>
                          <ActionIcon variant="light" color="gray" size="sm">
                            <IconDots size={14} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {incident.status === 'open' && (
                            <Menu.Item
                              leftSection={<IconEye size={14} />}
                              onClick={() => handleStatusChange(incident._id, 'acknowledged')}
                            >
                              {t('acknowledge')}
                            </Menu.Item>
                          )}
                          {(incident.status === 'open' || incident.status === 'acknowledged') && (
                            <Menu.Item
                              leftSection={<IconSearch size={14} />}
                              onClick={() => handleStatusChange(incident._id, 'investigating')}
                            >
                              {t('investigate')}
                            </Menu.Item>
                          )}
                          <Menu.Item
                            leftSection={<IconCheck size={14} />}
                            color="green"
                            onClick={() => handleStatusChange(incident._id, 'resolved')}
                          >
                            {t('resolve')}
                          </Menu.Item>
                          <Menu.Item
                            leftSection={<IconLock size={14} />}
                            onClick={() => handleStatusChange(incident._id, 'closed')}
                          >
                            {t('close')}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}

    </PageContainer>
  );
}
