'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowLeft,
  IconEdit,
  IconRefresh,
  IconServerBolt,
  IconTrash,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import { useTranslations } from '@/lib/i18n';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

dayjs.extend(relativeTime);

interface InferenceServer {
  _id: string;
  key: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
  status: 'active' | 'disabled' | 'errored';
  pollIntervalSeconds: number;
  lastPolledAt?: string;
  lastError?: string;
  createdAt: string;
}

interface MetricsRecord {
  _id: string;
  timestamp: string;
  numRequestsRunning?: number;
  numRequestsWaiting?: number;
  gpuCacheUsagePercent?: number;
  cpuCacheUsagePercent?: number;
  promptTokensThroughput?: number;
  generationTokensThroughput?: number;
  timeToFirstTokenSeconds?: number;
  timePerOutputTokenSeconds?: number;
  e2eRequestLatencySeconds?: number;
  requestsPerSecond?: number;
  runningModels?: string[];
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'teal';
    case 'errored': return 'red';
    case 'disabled': return 'gray';
    default: return 'gray';
  }
}

function fmtNum(n: number | undefined | null, decimals = 2): string {
  if (n === undefined || n === null) return '—';
  return n.toFixed(decimals);
}

function fmtPct(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

export default function InferenceServerDetailPage() {
  const { serverKey } = useParams<{ serverKey: string }>();
  const router = useRouter();
  const t = useTranslations('inferenceMonitoring');

  const [server, setServer] = useState<InferenceServer | null>(null);
  const [metrics, setMetrics] = useState<MetricsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editOpened, editHandlers] = useDisclosure(false);
  const [deleteOpened, deleteHandlers] = useDisclosure(false);
  const [saving, setSaving] = useState(false);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  const editForm = useForm({
    initialValues: {
      name: '',
      baseUrl: '',
      apiKey: '',
      pollIntervalSeconds: 60,
    },
    validate: {
      name: (v) => (v.trim().length < 2 ? 'Name is required' : null),
      baseUrl: (v) => {
        try { new URL(v); return null; } catch { return 'Invalid URL'; }
      },
    },
  });

  const fetchServer = useCallback(async () => {
    try {
      const res = await fetch(`/api/inference-monitoring/servers/${encodeURIComponent(serverKey)}`);
      if (res.ok) {
        const data = await res.json();
        setServer(data.server);
      }
    } catch (err) {
      console.error('Failed to fetch server:', err);
    }
  }, [serverKey]);

  const fetchMetrics = useCallback(async () => {
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      params.append('limit', '500');

      const res = await fetch(
        `/api/inference-monitoring/servers/${encodeURIComponent(serverKey)}/metrics?${params}`,
      );
      if (res.ok) {
        const data = await res.json();
        setMetrics(data.metrics || []);
      }
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
    }
  }, [serverKey, dateFilter]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([fetchServer(), fetchMetrics()]);
      setLoading(false);
    };
    void load();
  }, [fetchServer, fetchMetrics]);

  // Silent background refresh: use the server's poll interval (min 15 s) so
  // the UI stays in sync with the scheduler without hammering the API.
  useEffect(() => {
    const intervalMs = Math.max(15, server?.pollIntervalSeconds ?? 30) * 1000;
    const id = setInterval(
      () => void Promise.all([fetchServer(), fetchMetrics()]),
      intervalMs,
    );
    return () => clearInterval(id);
  }, [server?.pollIntervalSeconds, fetchServer, fetchMetrics]);

  const handlePoll = async () => {
    setPolling(true);
    try {
      const res = await fetch(
        `/api/inference-monitoring/servers/${encodeURIComponent(serverKey)}/poll`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || t('pollError'));
      }
      notifications.show({ title: 'Success', message: t('pollSuccess'), color: 'teal' });
      await Promise.all([fetchServer(), fetchMetrics()]);
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : t('pollError'),
        color: 'red',
      });
      // Still refresh server to show updated error state
      await fetchServer();
    } finally {
      setPolling(false);
    }
  };

  const handleEdit = async (values: typeof editForm.values) => {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/inference-monitoring/servers/${encodeURIComponent(serverKey)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        },
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update');
      }
      notifications.show({ title: 'Success', message: t('serverUpdated'), color: 'teal' });
      editHandlers.close();
      await fetchServer();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/inference-monitoring/servers/${encodeURIComponent(serverKey)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete');
      }
      notifications.show({ title: 'Success', message: t('serverDeleted'), color: 'teal' });
      router.push('/dashboard/inference-monitoring');
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    } finally {
      setDeleting(false);
      deleteHandlers.close();
    }
  };

  const openEdit = () => {
    if (server) {
      editForm.setValues({
        name: server.name,
        baseUrl: server.baseUrl,
        apiKey: server.apiKey || '',
        pollIntervalSeconds: server.pollIntervalSeconds,
      });
    }
    editHandlers.open();
  };

  if (loading) {
    return (
      <Center h={400}>
        <Loader size="lg" color="teal" />
      </Center>
    );
  }

  if (!server) {
    return (
      <Center h={400}>
        <Stack align="center" gap="md">
          <Text c="dimmed">Server not found</Text>
          <Button variant="light" onClick={() => router.push('/dashboard/inference-monitoring')}>
            Back to Servers
          </Button>
        </Stack>
      </Center>
    );
  }

  // Latest metrics snapshot
  const latest = metrics.length > 0 ? metrics[0] : null;

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconServerBolt size={18} />}
        title={server.name}
        subtitle={`${server.type.toUpperCase()} · ${server.baseUrl}`}
        actions={
          <>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/inference-monitoring')}
            >
              All Servers
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconEdit size={14} />}
              onClick={openEdit}
            >
              {t('editServer')}
            </Button>
            <Button
              variant="light"
              size="xs"
              color="red"
              leftSection={<IconTrash size={14} />}
              onClick={deleteHandlers.open}
            >
              {t('deleteServer')}
            </Button>
            <Button
              size="xs"
              leftSection={<IconRefresh size={14} />}
              onClick={handlePoll}
              loading={polling}
            >
              {t('pollNow')}
            </Button>
          </>
        }
      />

      <Group justify="flex-end">
        <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
      </Group>

      {/* Server Status */}
      <Paper p="lg" radius="lg" withBorder>
        <Group gap="lg" align="center">
          <Badge size="lg" variant="light" color={statusColor(server.status)}>
            {server.status.toUpperCase()}
          </Badge>
          {server.lastPolledAt && (
            <Text size="sm" c="dimmed">
              Last polled: {dayjs(server.lastPolledAt).fromNow()}
            </Text>
          )}
          {server.lastError && (
            <Group gap="xs">
              <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" />
              <Text size="sm" c="red">{server.lastError}</Text>
            </Group>
          )}
        </Group>
      </Paper>

      {/* Latest Metrics Cards */}
      {latest ? (
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }}>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.runningRequests')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {fmtNum(latest.numRequestsRunning, 0)}
              </Text>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.waitingRequests')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="orange">
                {fmtNum(latest.numRequestsWaiting, 0)}
              </Text>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.gpuCacheUsage')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {fmtPct(latest.gpuCacheUsagePercent)}
              </Text>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.e2eLatency')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="blue">
                {fmtNum(latest.e2eRequestLatencySeconds)}
              </Text>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.promptThroughput')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {fmtNum(latest.promptTokensThroughput)}
              </Text>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.generationThroughput')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {fmtNum(latest.generationTokensThroughput)}
              </Text>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.timeToFirstToken')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="cyan">
                {fmtNum(latest.timeToFirstTokenSeconds, 3)}
              </Text>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {t('serverDetail.timePerOutputToken')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="grape">
                {fmtNum(latest.timePerOutputTokenSeconds, 4)}
              </Text>
            </Stack>
          </Paper>
        </SimpleGrid>
      ) : (
        <Paper p="xl" radius="lg" withBorder>
          <Center py="lg">
            <Stack gap="md" align="center">
              <ThemeIcon size={48} radius="xl" variant="light" color="gray">
                <IconActivity size={24} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">{t('serverDetail.noMetrics')}</Text>
              <Button
                variant="light"
                leftSection={<IconRefresh size={14} />}
                onClick={handlePoll}
                loading={polling}
              >
                {t('pollNow')}
              </Button>
            </Stack>
          </Center>
        </Paper>
      )}

      {/* Running Models */}
      {latest?.runningModels && latest.runningModels.length > 0 && (
        <Paper p="lg" radius="lg" withBorder>
          <Text fw={600} mb="sm">Running Models</Text>
          <Group gap="xs">
            {latest.runningModels.map((m) => (
              <Badge key={m} variant="light" color="teal" size="lg">{m}</Badge>
            ))}
          </Group>
        </Paper>
      )}

      {/* Metrics History Cards */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <div>
            <Text fw={600} size="lg">{t('serverDetail.metrics')} History</Text>
            <Text size="sm" c="dimmed">
              {metrics.length} data points{rangeParams.from ? ' in selected range' : ''}
            </Text>
          </div>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={() => fetchMetrics()}
          >
            Refresh
          </Button>
        </Group>

        {metrics.length === 0 ? (
          <Center py="lg">
            <Text size="sm" c="dimmed">{t('serverDetail.noMetrics')}</Text>
          </Center>
        ) : (
          <Stack gap="sm">
            <Text size="xs" c="dimmed">
              Showing latest {Math.min(metrics.length, 24)} snapshots
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
              {metrics.slice(0, 24).map((m) => (
                <Paper key={m._id} withBorder radius="md" p="md">
                  <Stack gap="xs">
                    <Group justify="space-between">
                      <Text size="sm" fw={600}>{dayjs(m.timestamp).format('MMM D HH:mm:ss')}</Text>
                      <Badge size="xs" variant="light" color="gray">
                        {dayjs(m.timestamp).fromNow()}
                      </Badge>
                    </Group>

                    <Group gap="xs" wrap="wrap">
                      <Badge size="sm" variant="light" color="teal">
                        Running: {fmtNum(m.numRequestsRunning, 0)}
                      </Badge>
                      <Badge size="sm" variant="light" color="orange">
                        Waiting: {fmtNum(m.numRequestsWaiting, 0)}
                      </Badge>
                    </Group>

                    <Group justify="space-between">
                      <Text size="xs" c="dimmed">GPU Cache</Text>
                      <Text size="xs" fw={600}>{fmtPct(m.gpuCacheUsagePercent)}</Text>
                    </Group>

                    <SimpleGrid cols={2} spacing="xs">
                      <Paper withBorder radius="sm" p="xs">
                        <Text size="xs" c="dimmed">Prompt tok/s</Text>
                        <Text size="sm" fw={600}>{fmtNum(m.promptTokensThroughput)}</Text>
                      </Paper>
                      <Paper withBorder radius="sm" p="xs">
                        <Text size="xs" c="dimmed">Gen tok/s</Text>
                        <Text size="sm" fw={600}>{fmtNum(m.generationTokensThroughput)}</Text>
                      </Paper>
                      <Paper withBorder radius="sm" p="xs">
                        <Text size="xs" c="dimmed">TTFT (s)</Text>
                        <Text size="sm" fw={600}>{fmtNum(m.timeToFirstTokenSeconds, 3)}</Text>
                      </Paper>
                      <Paper withBorder radius="sm" p="xs">
                        <Text size="xs" c="dimmed">E2E Lat (s)</Text>
                        <Text size="sm" fw={600}>{fmtNum(m.e2eRequestLatencySeconds)}</Text>
                      </Paper>
                    </SimpleGrid>
                  </Stack>
                </Paper>
              ))}
            </SimpleGrid>
          </Stack>
        )}
      </Paper>

      {/* Edit Modal */}
      <Modal opened={editOpened} onClose={editHandlers.close} title={t('editServer')} size="md">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="md">
            <TextInput
              label={t('serverName')}
              required
              {...editForm.getInputProps('name')}
            />
            <TextInput
              label={t('baseUrl')}
              required
              {...editForm.getInputProps('baseUrl')}
            />
            <TextInput
              label={t('apiKey')}
              placeholder={t('form.apiKeyPlaceholder')}
              {...editForm.getInputProps('apiKey')}
            />
            <NumberInput
              label={t('pollInterval')}
              description={t('form.pollIntervalHelp')}
              min={10}
              max={3600}
              {...editForm.getInputProps('pollIntervalSeconds')}
            />
            <Group justify="flex-end" mt="md">
              <Button variant="light" onClick={editHandlers.close}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal opened={deleteOpened} onClose={deleteHandlers.close} title={t('deleteServer')} size="sm">
        <Stack gap="md">
          <Text size="sm">{t('deleteConfirm')}</Text>
          <Group justify="flex-end">
            <Button variant="light" onClick={deleteHandlers.close}>Cancel</Button>
            <Button color="red" onClick={handleDelete} loading={deleting}>
              {t('deleteServer')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
