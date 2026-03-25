'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Progress,
  Select,
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
  IconPlus,
  IconRefresh,
  IconServerBolt,
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconBan,
  IconCpu,
  IconChartBar,
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
  status: 'active' | 'disabled' | 'errored';
  pollIntervalSeconds: number;
  lastPolledAt?: string;
  lastError?: string;
  createdAt: string;
}

interface LatestMetrics {
  gpuCacheUsagePercent?: number;
  numRequestsRunning?: number;
  numRequestsWaiting?: number;
  promptTokensThroughput?: number;
  generationTokensThroughput?: number;
  requestsPerSecond?: number;
  runningModels?: string[];
  timestamp?: string;
}

interface InferenceDashboardData {
  overview: {
    totalServers: number;
    activeServers: number;
    erroredServers: number;
    disabledServers: number;
    avgGpuCacheUsage: number | null;
    totalRunningRequests: number;
    totalWaitingRequests: number;
    runningModelsCount: number;
  };
  typeBreakdown: Array<{ type: string; count: number }>;
  servers: Array<{
    key: string;
    name: string;
    type: string;
    status: string;
    lastPolledAt?: string;
    lastError?: string;
    latestMetrics: LatestMetrics | null;
  }>;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'teal';
    case 'errored': return 'red';
    case 'disabled': return 'gray';
    default: return 'gray';
  }
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'active':
      return <IconCheck size={16} />;
    case 'errored':
      return <IconAlertTriangle size={16} />;
    default:
      return <IconBan size={16} />;
  }
}

export default function InferenceMonitoringPage() {
  const router = useRouter();
  const t = useTranslations('inferenceMonitoring');
  const tNav = useTranslations('navigation');
  const [servers, setServers] = useState<InferenceServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpened, addHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);
  const [dashboardData, setDashboardData] = useState<InferenceDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/inference-monitoring/dashboard?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) setDashboardData(await res.json() as InferenceDashboardData);
    } catch (err) {
      console.error('Failed to load inference dashboard', err);
    } finally {
      setDashboardLoading(false);
    }
  }, [dateFilter]);

  const form = useForm({
    initialValues: {
      name: '',
      type: 'llamacpp',
      baseUrl: '',
      apiKey: '',
      pollIntervalSeconds: 60,
    },
    validate: {
      name: (value) => (value.trim().length < 2 ? 'Name is required' : null),
      baseUrl: (value) => {
        if (!value.trim()) return 'URL is required';
        try {
          new URL(value);
          return null;
        } catch {
          return 'Invalid URL';
        }
      },
    },
  });

  const fetchServers = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const res = await fetch('/api/inference-monitoring/servers');
      if (res.ok) {
        const data = await res.json();
        setServers(data.servers || []);
      }
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchServers();
    void loadDashboard();
  }, [fetchServers, loadDashboard]);

  // Silent background refresh every 30 s so status / lastPolledAt stays current.
  useEffect(() => {
    const id = setInterval(() => { void fetchServers(true); void loadDashboard(); }, 30_000);
    return () => clearInterval(id);
  }, [fetchServers, loadDashboard]);

  const handleCreate = async (values: typeof form.values) => {
    try {
      setCreating(true);
      const res = await fetch('/api/inference-monitoring/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create server');
      }

      notifications.show({
        title: 'Success',
        message: t('serverCreated'),
        color: 'teal',
      });
      form.reset();
      addHandlers.close();
      await fetchServers();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to create server',
        color: 'red',
      });
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <Center h={400}>
        <Loader size="lg" color="teal" />
      </Center>
    );
  }

  const healthyRate = servers.length > 0
    ? (servers.filter((s) => s.status === 'active').length / servers.length) * 100
    : 0;

  const stalePollers = servers.filter((server) => {
    if (!server.lastPolledAt || server.status !== 'active') return false;
    const lastPolledAt = new Date(server.lastPolledAt).getTime();
    if (Number.isNaN(lastPolledAt)) return false;
    const maxAgeMs = Math.max(server.pollIntervalSeconds, 10) * 2 * 1000;
    return Date.now() - lastPolledAt > maxAgeMs;
  }).length;

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconServerBolt size={18} />}
        title={tNav('inferenceMonitoring')}
        subtitle={t('subtitle')}
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="light"
              size="xs"
              onClick={() => fetchServers(true)}
              loading={refreshing}
              leftSection={<IconRefresh size={14} />}
            >
              Refresh
            </Button>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={addHandlers.open}
            >
              {t('addServer')}
            </Button>
          </>
        }
      />

      {/* Stats Overview */}
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Total Servers</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>{dashboardData?.overview.totalServers ?? servers.length}</Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="gray"><IconServerBolt size={24} /></ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Active</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">{dashboardData?.overview.activeServers ?? servers.filter((s) => s.status === 'active').length}</Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal"><IconCheck size={24} /></ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Errored</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c={(dashboardData?.overview.erroredServers ?? servers.filter((s) => s.status === 'errored').length) > 0 ? 'red' : 'dimmed'}>{dashboardData?.overview.erroredServers ?? servers.filter((s) => s.status === 'errored').length}</Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color={(dashboardData?.overview.erroredServers ?? servers.filter((s) => s.status === 'errored').length) > 0 ? 'red' : 'gray'}><IconAlertTriangle size={24} /></ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Queue Backlog</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c={(dashboardData?.overview.totalWaitingRequests ?? 0) > 0 ? 'orange' : 'teal'}>{dashboardData?.overview.totalWaitingRequests ?? 0}</Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color={(dashboardData?.overview.totalWaitingRequests ?? 0) > 0 ? 'orange' : 'teal'}><IconActivity size={24} /></ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Analytics Panel */}
      {servers.length > 0 && (
        <Paper p="lg" radius="lg" withBorder>
          <Group justify="space-between" mb="lg">
            <Group gap="sm">
              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                <IconChartBar size={16} />
              </ThemeIcon>
              <div>
                <Text fw={600} size="lg">Server Health Overview</Text>
                <Text size="sm" c="dimmed">Live metrics snapshot from active servers</Text>
              </div>
            </Group>
            <Group gap="xs">
              <Badge variant="light" color={healthyRate >= 95 ? 'teal' : healthyRate >= 80 ? 'orange' : 'red'}>
                Healthy {healthyRate.toFixed(0)}%
              </Badge>
              <Badge variant="light" color={stalePollers > 0 ? 'orange' : 'teal'}>
                Stale pollers {stalePollers}
              </Badge>
            </Group>
            <Button variant="subtle" size="xs" leftSection={<IconRefresh size={14} />}
              loading={dashboardLoading} onClick={() => void loadDashboard()}>
              Refresh
            </Button>
          </Group>

          {dashboardLoading && !dashboardData ? (
            <Center py="xl"><Loader size="sm" color="teal" /></Center>
          ) : (
            <Stack gap="md">
              {/* GPU Cache Aggregate */}
              {dashboardData?.overview.avgGpuCacheUsage !== null && dashboardData?.overview.avgGpuCacheUsage !== undefined && (
                <Paper withBorder p="md" radius="md">
                  <Group justify="space-between" mb="xs">
                    <Group gap="sm">
                      <ThemeIcon size={28} radius="md" variant="light" color="violet">
                        <IconCpu size={14} />
                      </ThemeIcon>
                      <Text fw={600} size="sm">Avg GPU Cache Usage</Text>
                    </Group>
                    <Text fw={700} size="sm" c={dashboardData.overview.avgGpuCacheUsage > 0.8 ? 'red' : 'teal'}>
                      {(dashboardData.overview.avgGpuCacheUsage * 100).toFixed(1)}%
                    </Text>
                  </Group>
                  <Progress
                    value={dashboardData.overview.avgGpuCacheUsage * 100}
                    color={dashboardData.overview.avgGpuCacheUsage > 0.8 ? 'red' : dashboardData.overview.avgGpuCacheUsage > 0.5 ? 'orange' : 'teal'}
                    size="md"
                    radius="xl"
                  />
                </Paper>
              )}

              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                {(dashboardData?.servers ?? []).map((srv) => {
                  const gpuPct = srv.latestMetrics?.gpuCacheUsagePercent;
                  const runningModels = srv.latestMetrics?.runningModels ?? [];

                  return (
                    <Paper
                      key={srv.key}
                      withBorder
                      radius="md"
                      p="md"
                      style={{ cursor: 'pointer' }}
                      onClick={() => router.push(`/dashboard/inference-monitoring/${encodeURIComponent(srv.key)}`)}
                    >
                      <Stack gap="sm">
                        <Group justify="space-between" align="flex-start">
                          <Group gap="sm" align="flex-start">
                            <ThemeIcon size={30} radius="md" variant="light" color={statusColor(srv.status)}>
                              {srv.status === 'active' ? <IconCheck size={14} /> : srv.status === 'errored' ? <IconAlertTriangle size={14} /> : <IconBan size={14} />}
                            </ThemeIcon>
                            <div>
                              <Text size="sm" fw={600} lineClamp={1}>{srv.name}</Text>
                              <Group gap="xs" mt={4}>
                                <Badge size="xs" variant="light" color="gray">{srv.type.toUpperCase()}</Badge>
                                <Badge size="xs" variant="light" radius="xl" color={statusColor(srv.status)}>{srv.status.toUpperCase()}</Badge>
                              </Group>
                            </div>
                          </Group>
                          <Text size="xs" c="dimmed">{srv.lastPolledAt ? dayjs(srv.lastPolledAt).fromNow() : '—'}</Text>
                        </Group>

                        {gpuPct !== undefined ? (
                          <Stack gap={6}>
                            <Group justify="space-between">
                              <Text size="xs" c="dimmed">GPU Cache</Text>
                              <Text size="xs" fw={600}>{(gpuPct * 100).toFixed(1)}%</Text>
                            </Group>
                            <Progress
                              value={gpuPct * 100}
                              size="sm"
                              radius="xl"
                              color={gpuPct > 0.8 ? 'red' : gpuPct > 0.5 ? 'orange' : 'teal'}
                            />
                          </Stack>
                        ) : (
                          <Text size="xs" c="dimmed">GPU cache metric unavailable</Text>
                        )}

                        <Group gap="xs" wrap="wrap">
                          <Badge size="sm" variant="light" color="cyan">
                            Running: {srv.latestMetrics?.numRequestsRunning ?? '—'}
                          </Badge>
                          <Badge size="sm" variant="light" color="orange">
                            Waiting: {srv.latestMetrics?.numRequestsWaiting ?? '—'}
                          </Badge>
                          <Badge size="sm" variant="light" color="blue">
                            RPS: {srv.latestMetrics?.requestsPerSecond !== undefined ? srv.latestMetrics.requestsPerSecond.toFixed(2) : '—'}
                          </Badge>
                        </Group>

                        <Group gap="xs" wrap="wrap">
                          <Badge size="xs" variant="light" color="teal">
                            Prompt: {srv.latestMetrics?.promptTokensThroughput !== undefined ? srv.latestMetrics.promptTokensThroughput.toFixed(1) : '—'}/s
                          </Badge>
                          <Badge size="xs" variant="light" color="grape">
                            Gen: {srv.latestMetrics?.generationTokensThroughput !== undefined ? srv.latestMetrics.generationTokensThroughput.toFixed(1) : '—'}/s
                          </Badge>
                        </Group>

                        {runningModels.length > 0 && (
                          <Group gap="xs" wrap="wrap">
                            {runningModels.slice(0, 2).map((modelName) => (
                              <Badge key={modelName} size="xs" variant="light" color="teal">{modelName}</Badge>
                            ))}
                            {runningModels.length > 2 && (
                              <Badge size="xs" variant="light" color="gray">+{runningModels.length - 2} more</Badge>
                            )}
                          </Group>
                        )}

                        {srv.lastError && (
                          <Text size="xs" c="red" lineClamp={2}>{srv.lastError}</Text>
                        )}
                      </Stack>
                    </Paper>
                  );
                })}
              </SimpleGrid>
            </Stack>
          )}
        </Paper>
      )}

      {servers.length === 0 ? (
        <Paper p="xl" radius="lg" withBorder>
          <Center py="xl">
            <Stack gap="md" align="center">
              <ThemeIcon size={60} radius="xl" variant="light" color="gray">
                <IconServerBolt size={30} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                {t('noServers')}
              </Text>
              <Button
                variant="light"
                leftSection={<IconPlus size={14} />}
                onClick={addHandlers.open}
              >
                {t('addServer')}
              </Button>
            </Stack>
          </Center>
        </Paper>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {servers.map((server) => (
            <Paper
              key={server.key}
              withBorder
              radius="lg"
              p="lg"
              style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
              onClick={() => router.push(`/dashboard/inference-monitoring/${encodeURIComponent(server.key)}`)}
            >
              <Stack gap="sm">
                <Group justify="space-between" align="center">
                  <Group gap="sm">
                    <ThemeIcon size={36} radius="md" variant="light" color={statusColor(server.status)}>
                      <StatusIcon status={server.status} />
                    </ThemeIcon>
                    <div>
                      <Text fw={600} lineClamp={1}>{server.name}</Text>
                      <Text size="xs" c="dimmed">{server.type.toUpperCase()}</Text>
                    </div>
                  </Group>
                  <Badge size="sm" variant="light" radius="xl" color={statusColor(server.status)}>
                    {server.status.toUpperCase()}
                  </Badge>
                </Group>

                <Text size="xs" c="dimmed" lineClamp={1} ff="monospace">
                  {server.baseUrl}
                </Text>

                <Group gap="lg">
                  <Text size="xs" c="dimmed">
                    <IconActivity size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                    Every {server.pollIntervalSeconds}s
                  </Text>
                  {server.lastPolledAt && (
                    <Text size="xs" c="dimmed">
                      Last: {dayjs(server.lastPolledAt).fromNow()}
                    </Text>
                  )}
                </Group>

                {server.lastError && (
                  <Text size="xs" c="red" lineClamp={2}>
                    {server.lastError}
                  </Text>
                )}
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}

      {/* Add Server Modal */}
      <Modal
        opened={addOpened}
        onClose={addHandlers.close}
        title={t('addServer')}
        size="md"
      >
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="md">
            <TextInput
              label={t('serverName')}
              placeholder={t('form.namePlaceholder')}
              required
              {...form.getInputProps('name')}
            />
            <Select
              label={t('serverType')}
              data={[
                { value: 'vllm', label: 'vLLM' },
                { value: 'llamacpp', label: 'llama.cpp' },
              ]}
              required
              {...form.getInputProps('type')}
            />
            <TextInput
              label={t('baseUrl')}
              placeholder={t('form.urlPlaceholder')}
              required
              {...form.getInputProps('baseUrl')}
            />
            <TextInput
              label={t('apiKey')}
              placeholder={t('form.apiKeyPlaceholder')}
              {...form.getInputProps('apiKey')}
            />
            <NumberInput
              label={t('pollInterval')}
              description={t('form.pollIntervalHelp')}
              min={10}
              max={3600}
              {...form.getInputProps('pollIntervalSeconds')}
            />
            <Group justify="flex-end" mt="md">
              <Button variant="light" onClick={addHandlers.close}>
                Cancel
              </Button>
              <Button type="submit" loading={creating}>
                {t('addServer')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
