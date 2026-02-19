'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
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
  IconBell,
  IconBellCheck,
  IconCheck,
  IconHistory,
} from '@tabler/icons-react';
import Link from 'next/link';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';

interface AlertEvent {
  _id: string;
  ruleName: string;
  metric: string;
  threshold: number;
  actualValue: number;
  status: 'fired' | 'resolved' | 'acknowledged';
  firedAt: string;
  resolvedAt?: string;
  channels: Array<{ type: string; target: string; success: boolean; error?: string }>;
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

const STATUS_COLORS: Record<string, string> = {
  fired: 'red',
  resolved: 'green',
  acknowledged: 'blue',
};

const STATUS_LABELS: Record<string, string> = {
  fired: 'Fired',
  resolved: 'Resolved',
  acknowledged: 'Acknowledged',
};

export default function AlertHistoryPage() {
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const t = useTranslations('alerts');

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      params.set('limit', '100');
      const res = await fetch(`/api/alerts/history?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch alert history');
      const data = await res.json();
      setEvents(data.events || []);
      setActiveCount(data.activeCount || 0);
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: err instanceof Error ? err.message : 'Failed to load alert history',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handleAcknowledge = async (eventId: string) => {
    try {
      const res = await fetch(`/api/alerts/history/${eventId}/acknowledge`, {
        method: 'PATCH',
      });
      if (!res.ok) throw new Error('Failed to acknowledge alert');
      setEvents((prev) =>
        prev.map((e) => (e._id === eventId ? { ...e, status: 'acknowledged' as const } : e)),
      );
      setActiveCount((prev) => Math.max(0, prev - 1));
      notifications.show({
        title: t('acknowledged'),
        message: t('acknowledgedMessage'),
        color: 'teal',
      });
    } catch {
      notifications.show({
        title: t('error'),
        message: t('acknowledgeError'),
        color: 'red',
      });
    }
  };

  if (loading) {
    return (
      <Stack align="center" justify="center" h={400}>
        <Loader size="lg" />
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconHistory size={20} />}
        title={t('historyTitle')}
        subtitle={t('historySubtitle')}
        iconColor="orange"
        actions={
          <Group gap="xs">
            {activeCount > 0 && (
              <Badge color="red" variant="filled" size="lg">
                {activeCount} {t('activeAlerts')}
              </Badge>
            )}
            <Button
              component={Link}
              href="/dashboard/alerts"
              variant="light"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
            >
              {t('backToRules')}
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
            { value: 'fired', label: 'Fired' },
            { value: 'acknowledged', label: 'Acknowledged' },
            { value: 'resolved', label: 'Resolved' },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
          clearable
          w={200}
        />
      </Group>

      {/* Events List */}
      {events.length === 0 ? (
        <Paper p="xl" radius="md" withBorder>
          <Stack align="center" gap="md" py="xl">
            <ThemeIcon size={60} radius="xl" variant="light" color="green">
              <IconBellCheck size={28} />
            </ThemeIcon>
            <Text size="lg" fw={600}>{t('noEvents')}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={400}>
              {t('noEventsDescription')}
            </Text>
          </Stack>
        </Paper>
      ) : (
        <Stack gap="sm">
          {events.map((event) => (
            <Paper key={event._id} p="md" radius="md" withBorder>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="md" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                  <ThemeIcon
                    size={36}
                    radius="md"
                    variant="light"
                    color={STATUS_COLORS[event.status] ?? 'gray'}
                  >
                    <IconBell size={18} />
                  </ThemeIcon>
                  <div style={{ minWidth: 0 }}>
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={600} size="sm" lineClamp={1}>
                        {event.ruleName}
                      </Text>
                      <Badge
                        size="xs"
                        variant="light"
                        color={STATUS_COLORS[event.status] ?? 'gray'}
                      >
                        {STATUS_LABELS[event.status] ?? event.status}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" mt={2}>
                      {METRIC_LABELS[event.metric] ?? event.metric}:{' '}
                      <Text span fw={600} c="orange">
                        {Number(event.actualValue).toFixed(2)}
                        {METRIC_UNITS[event.metric] ?? ''}
                      </Text>
                      {' '}(threshold: {event.threshold}
                      {METRIC_UNITS[event.metric] ?? ''})
                    </Text>
                    <Text size="xs" c="dimmed" mt={2}>
                      {new Date(event.firedAt).toLocaleString()}
                      {event.channels.length > 0 && (
                        <Text span ml="xs">
                          · {event.channels.filter((c) => c.success).length}/{event.channels.length} notifications sent
                        </Text>
                      )}
                    </Text>
                  </div>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  {event.status === 'fired' && (
                    <Tooltip label={t('acknowledge')}>
                      <ActionIcon
                        variant="light"
                        color="blue"
                        size="sm"
                        onClick={() => handleAcknowledge(event._id)}
                      >
                        <IconCheck size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
