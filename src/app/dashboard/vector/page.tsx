'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  Tooltip,
  ThemeIcon,
  SimpleGrid,
  Box,
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconRefresh, IconTrash, IconDatabase, IconServer, IconChartDots3, IconArrowRight, IconSparkles, IconChartBar, IconGitBranch, IconDatabaseExport } from '@tabler/icons-react';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';
import CreateVectorIndexModal from '@/components/vector/CreateVectorIndexModal';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

interface VectorDashboardData {
  overview: {
    totalProviders: number;
    activeProviders: number;
    disabledProviders: number;
    erroredProviders: number;
    totalIndexes: number;
  };
  providerBreakdown: Array<{ key: string; label: string; driver: string; status: string; indexCount: number }>;
  dimensionDistribution: Array<{ dimension: number; count: number }>;
  metricDistribution: Array<{ metric: string; count: number }>;
  recentIndexes: Array<{ key: string; name: string; providerKey: string; dimension: number; metric: string; createdAt?: string }>;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'teal';
    case 'disabled': return 'gray';
    case 'errored': return 'red';
    default: return 'gray';
  }
}

interface VectorIndexRow {
  provider: VectorProviderView;
  index: VectorIndexRecord;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}


export default function VectorIndexPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<VectorProviderView[]>([]);
  const [indexesByProvider, setIndexesByProvider] = useState<Record<string, VectorIndexRecord[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [dashboardData, setDashboardData] = useState<VectorDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/vector/dashboard?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        setDashboardData(await res.json() as VectorDashboardData);
      }
    } catch (err) {
      console.error('Failed to load vector dashboard', err);
    } finally {
      setDashboardLoading(false);
    }
  }, [dateFilter]);

  const loadProvidersAndIndexes = useCallback(async () => {
    setRefreshing(true);
    try {
      const providerResponse = await fetch('/api/vector/providers?includeIndexes=true', { cache: 'no-store' });
      if (!providerResponse.ok) {
        throw new Error('Failed to load vector providers');
      }
      const providerData = await providerResponse.json();
  const fetchedProviders: VectorProviderView[] = providerData.providers ?? [];
      setProviders(fetchedProviders);

      const nextIndexes: Record<string, VectorIndexRecord[]> = {};
      Object.entries(
        (providerData.indexesByProvider ?? {}) as Record<string, VectorIndexRecord[]>,
      ).forEach(([key, value]) => {
        nextIndexes[key] = [...value];
      });

      fetchedProviders.forEach((provider) => {
        if (!nextIndexes[provider.key]) {
          nextIndexes[provider.key] = [];
        }
      });

      setIndexesByProvider(nextIndexes);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load vector data',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadProvidersAndIndexes();
    void loadDashboard();
  }, [loadProvidersAndIndexes, loadDashboard]);

  const rows = useMemo<VectorIndexRow[]>(() => {
    return providers.flatMap((provider) => {
      const providerIndexes = indexesByProvider[provider.key] ?? [];
      return providerIndexes.map((index) => ({ provider, index }));
    });
  }, [providers, indexesByProvider]);

  const handleDeleteIndex = async (provider: VectorProviderView, index: VectorIndexRecord) => {
    const confirmed = window.confirm(`Delete index "${index.name}"? This cannot be undone.`);
    if (!confirmed) return;

    try {
      const response = await fetch(
  `/api/vector/indexes/${encodeURIComponent(index.key)}?providerKey=${encodeURIComponent(provider.key)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to delete index');
      }

      notifications.show({
        color: 'green',
        title: 'Vector index deleted',
        message: `${index.name} has been removed.`,
      });
      await loadProvidersAndIndexes();
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to delete index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleIndexCreated = ({ index, provider }: { index: VectorIndexRecord; provider: VectorProviderView }) => {
    setIndexesByProvider((current) => ({
      ...current,
      [provider.key]: [...(current[provider.key] ?? []), index],
    }));
    if (!providers.find((item) => item.key === provider.key)) {
      setProviders((current) => [...current, provider]);
    }
    setCreateModalOpen(false);
  router.push(`/dashboard/vector/${provider.key}/${index.key}`);
  };

  return (
    <Stack gap="md">
      {/* Header */}
      <PageHeader
        icon={<IconDatabase size={18} />}
        title="Knowledge Index"
        subtitle="Manage knowledge indexes across providers, inspect recent items, and launch queries."
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="light"
              size="xs"
              leftSection={refreshing ? <Loader size={12} /> : <IconRefresh size={14} />}
              onClick={() => void loadProvidersAndIndexes()}
              disabled={refreshing}
            >
              Refresh
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconDatabaseExport size={14} />}
              onClick={() => router.push('/dashboard/vector/migrations')}
            >
              Migrations
            </Button>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => setCreateModalOpen(true)}
            >
              Create Index
            </Button>
          </>
        }
      />

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Indexes
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {dashboardData?.overview.totalIndexes ?? rows.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconDatabase size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Providers
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {dashboardData?.overview.totalProviders ?? providers.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconServer size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Active Providers
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="green">
                {dashboardData?.overview.activeProviders ?? providers.filter((p) => p.status === 'active').length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="green">
              <IconSparkles size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Errored Providers
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c={(dashboardData?.overview.erroredProviders ?? 0) > 0 ? 'red' : 'teal'}>
                {dashboardData?.overview.erroredProviders ?? providers.filter((p) => p.status === 'errored').length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color={(dashboardData?.overview.erroredProviders ?? 0) > 0 ? 'red' : 'teal'}>
              <IconChartDots3 size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Vector Analytics Dashboard */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="lg">
          <Group gap="sm">
            <ThemeIcon size={32} radius="md" variant="light" color="teal">
              <IconChartBar size={16} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="lg">Vector Analytics</Text>
              <Text size="sm" c="dimmed">Provider health and index distribution</Text>
            </div>
          </Group>
          <Button variant="subtle" size="xs" leftSection={<IconRefresh size={14} />}
            loading={dashboardLoading} onClick={() => void loadDashboard()}>
            Refresh
          </Button>
        </Group>

        {dashboardLoading && !dashboardData ? (
          <Center py="xl"><Loader size="sm" color="teal" /></Center>
        ) : (
          <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
            {/* Provider Breakdown */}
            <Paper withBorder p="md" radius="md">
              <Group gap="sm" mb="md">
                <ThemeIcon size={28} radius="md" variant="light" color="teal">
                  <IconServer size={14} />
                </ThemeIcon>
                <Text fw={600} size="sm">Provider Breakdown</Text>
              </Group>
              <Stack gap={8}>
                {(dashboardData?.providerBreakdown ?? []).length === 0 ? (
                  <Text size="sm" c="dimmed">No providers configured</Text>
                ) : (
                  (dashboardData?.providerBreakdown ?? []).map((item) => {
                    const maxCount = Math.max(...(dashboardData?.providerBreakdown ?? []).map((p) => p.indexCount), 1);
                    return (
                      <Stack gap={4} key={item.key}>
                        <Group justify="space-between">
                          <Group gap={6}>
                            <Badge size="xs" variant="light" radius="xl"
                              color={statusColor(item.status)}>
                              {item.status.toUpperCase()}
                            </Badge>
                            <Text size="xs" fw={500} lineClamp={1}>{item.label}</Text>
                          </Group>
                          <Badge size="xs" variant="light" color="teal">{item.indexCount} idx</Badge>
                        </Group>
                        <Progress value={(item.indexCount / maxCount) * 100} size="xs" color="teal" radius="xl" />
                      </Stack>
                    );
                  })
                )}
              </Stack>
            </Paper>

            {/* Dimension Distribution */}
            <Paper withBorder p="md" radius="md">
              <Group gap="sm" mb="md">
                <ThemeIcon size={28} radius="md" variant="light" color="violet">
                  <IconChartDots3 size={14} />
                </ThemeIcon>
                <Text fw={600} size="sm">Dimension Distribution</Text>
              </Group>
              <Stack gap={8}>
                {(dashboardData?.dimensionDistribution ?? []).length === 0 ? (
                  <Text size="sm" c="dimmed">No indexes yet</Text>
                ) : (
                  (dashboardData?.dimensionDistribution ?? []).map((item) => (
                    <Group key={item.dimension} justify="space-between">
                      <Text size="sm" ff="monospace">{item.dimension}d</Text>
                      <Group gap={6}>
                        <Badge size="sm" variant="light" color="violet">{item.count}</Badge>
                        <Text size="xs" c="dimmed">index{item.count !== 1 ? 'es' : ''}</Text>
                      </Group>
                    </Group>
                  ))
                )}
              </Stack>
            </Paper>

            {/* Metric Distribution + Recent Indexes */}
            <Stack gap="md">
              <Paper withBorder p="md" radius="md">
                <Group gap="sm" mb="md">
                  <ThemeIcon size={28} radius="md" variant="light" color="orange">
                    <IconGitBranch size={14} />
                  </ThemeIcon>
                  <Text fw={600} size="sm">Similarity Metrics</Text>
                </Group>
                <Stack gap={8}>
                  {(dashboardData?.metricDistribution ?? []).length === 0 ? (
                    <Text size="sm" c="dimmed">No data</Text>
                  ) : (
                    (dashboardData?.metricDistribution ?? []).map((item) => (
                      <Group key={item.metric} justify="space-between">
                        <Badge size="sm" variant="light" color="orange">{item.metric}</Badge>
                        <Text size="sm" fw={500}>{item.count}</Text>
                      </Group>
                    ))
                  )}
                </Stack>
              </Paper>

              <Paper withBorder p="md" radius="md">
                <Group gap="sm" mb="md">
                  <ThemeIcon size={28} radius="md" variant="light" color="cyan">
                    <IconSparkles size={14} />
                  </ThemeIcon>
                  <Text fw={600} size="sm">Recently Created</Text>
                </Group>
                <Stack gap={6}>
                  {(dashboardData?.recentIndexes ?? []).length === 0 ? (
                    <Text size="sm" c="dimmed">No indexes yet</Text>
                  ) : (
                    (dashboardData?.recentIndexes ?? []).slice(0, 4).map((idx) => (
                      <Group key={idx.key} justify="space-between">
                        <Text size="xs" fw={500} lineClamp={1}>{idx.name}</Text>
                        <Badge size="xs" variant="dot" color="teal">{idx.dimension}d</Badge>
                      </Group>
                    ))
                  )}
                </Stack>
              </Paper>
            </Stack>
          </SimpleGrid>
        )}
      </Paper>

      {/* Indexes Table */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <div>
            <Text fw={600} size="lg">All Indexes</Text>
            <Text size="sm" c="dimmed">Click on any row to view details and run queries</Text>
          </div>
        </Group>
        
        {loading ? (
          <Center py="xl">
            <Loader size="md" color="violet" />
          </Center>
        ) : rows.length === 0 ? (
          <Center py="xl">
            <Stack gap="md" align="center">
              <ThemeIcon size={80} radius="xl" variant="light" color="teal">
                <IconDatabase size={40} />
              </ThemeIcon>
              <Stack gap={4} align="center">
                <Text size="lg" fw={500}>
                  {providers.length === 0 ? 'No Vector Providers' : 'No Indexes Yet'}
                </Text>
                <Text size="sm" c="dimmed" ta="center" maw={400}>
                  {providers.length === 0
                    ? 'Configure a vector provider first to start creating indexes.'
                    : 'Create your first vector index to store and query embeddings.'}
                </Text>
              </Stack>
              <Button 
                leftSection={<IconPlus size={16} />} 
                onClick={() => setCreateModalOpen(true)}
                variant="gradient"
                gradient={{ from: 'teal', to: 'cyan', deg: 90 }}>
                Create Index
              </Button>
            </Stack>
          </Center>
        ) : (
          <Box style={{ overflow: 'hidden', borderRadius: 'var(--mantine-radius-md)' }}>
            <Table verticalSpacing="md" horizontalSpacing="md" highlightOnHover>
              <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
                <Table.Tr>
                  <Table.Th style={{ fontWeight: 600 }}>Index</Table.Th>
                  <Table.Th style={{ fontWeight: 600 }}>Provider</Table.Th>
                  <Table.Th style={{ fontWeight: 600, textAlign: 'center' }}>Dimension</Table.Th>
                  <Table.Th style={{ fontWeight: 600 }}>Metric</Table.Th>
                  <Table.Th style={{ fontWeight: 600 }}>Created</Table.Th>
                  <Table.Th style={{ fontWeight: 600, textAlign: 'center' }}>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map(({ provider, index }) => {
                  const navigateToDetail = () =>
                    router.push(`/dashboard/vector/${provider.key}/${index.key}`);

                  return (
                    <Table.Tr
                      key={`${provider.key}-${index.key}`}
                      onClick={navigateToDetail}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          navigateToDetail();
                        }
                      }}
                      tabIndex={0}
                      style={{ cursor: 'pointer', transition: 'background-color 0.15s ease' }}
                    >
                      <Table.Td>
                        <Group gap="sm">
                          <ThemeIcon size={40} radius="md" variant="light" color="teal">
                            <IconDatabase size={20} />
                          </ThemeIcon>
                          <Stack gap={2}>
                            <Text fw={600} size="sm">{index.name}</Text>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {index.key}
                            </Text>
                          </Stack>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6}>
                          <Badge 
                            variant="light" 
                            color={provider.status === 'active' ? 'teal' : 'yellow'} 
                            size="sm"
                            leftSection={<IconServer size={10} />}>
                            {provider.label}
                          </Badge>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Center>
                          <Badge variant="filled" color="teal" size="md" radius="sm">
                            {index.dimension}
                          </Badge>
                        </Center>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color="gray" size="sm">
                          {index.metric}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">{formatDate(index.createdAt)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" justify="center">
                          <Tooltip label="View details" withArrow>
                            <ActionIcon
                              variant="light"
                              color="violet"
                              radius="md"
                              onClick={(event) => {
                                event.stopPropagation();
                                navigateToDetail();
                              }}
                            >
                              <IconArrowRight size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete index" withArrow>
                            <ActionIcon
                              variant="light"
                              color="red"
                              radius="md"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleDeleteIndex(provider, index);
                              }}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Paper>

      <CreateVectorIndexModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        onCreated={handleIndexCreated}
      />
    </Stack>
  );
}
