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
  Stack,
  Table,
  Text,
  Tooltip,
  Title,
  ThemeIcon,
  SimpleGrid,
  Box,
  Transition,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconEye, IconPlus, IconRefresh, IconTrash, IconDatabase, IconServer, IconChartDots3, IconArrowRight, IconSparkles } from '@tabler/icons-react';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';
import CreateVectorIndexModal from '@/components/vector/CreateVectorIndexModal';

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

function resolveProviderHandle(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const candidates = ['providerExternalId', 'indexArn', 'externalId', 'arn'];
  for (const key of candidates) {
    const value = metadata[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return undefined;
}

export default function VectorIndexPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<VectorProviderView[]>([]);
  const [indexesByProvider, setIndexesByProvider] = useState<Record<string, VectorIndexRecord[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const loadProvidersAndIndexes = useCallback(async () => {
    setRefreshing(true);
    try {
      const providerResponse = await fetch('/api/vector/providers', { cache: 'no-store' });
      if (!providerResponse.ok) {
        throw new Error('Failed to load vector providers');
      }
      const providerData = await providerResponse.json();
  const fetchedProviders: VectorProviderView[] = providerData.providers ?? [];
      setProviders(fetchedProviders);

      const indexEntries = await Promise.all(
        fetchedProviders.map(async (provider) => {
          try {
            const response = await fetch(
              `/api/vector/indexes?providerKey=${encodeURIComponent(provider.key)}`,
              { cache: 'no-store' },
            );
            if (!response.ok) {
              throw new Error('Failed to load indexes for provider');
            }
            const data = await response.json();
            return [provider.key, (data.indexes ?? []) as VectorIndexRecord[]] as const;
          } catch (error) {
            console.error(error);
            notifications.show({
              color: 'red',
              title: 'Unable to load indexes',
              message:
                error instanceof Error
                  ? `${provider.label}: ${error.message}`
                  : 'Unexpected error',
            });
            return [provider.key, []] as const;
          }
        }),
      );

  const nextIndexes: Record<string, VectorIndexRecord[]> = {};
      indexEntries.forEach(([key, value]) => {
        nextIndexes[key] = [...value];
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
  }, [loadProvidersAndIndexes]);

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

  const totalDimensions = useMemo(() => {
    return rows.reduce((sum, row) => sum + (row.index.dimension || 0), 0);
  }, [rows]);

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-violet-0) 0%, var(--mantine-color-grape-0) 100%)',
          borderColor: 'var(--mantine-color-violet-2)',
        }}>
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'violet', to: 'grape', deg: 135 }}>
              <IconDatabase size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>Vector Indexes</Title>
              <Text size="sm" c="dimmed" mt={4}>
                Manage vector indexes across providers, inspect recent items, and launch queries.
              </Text>
            </div>
          </Group>
          <Group gap="xs">
            <Button 
              variant="light" 
              leftSection={refreshing ? <Loader size={14} /> : <IconRefresh size={16} />}
              onClick={() => void loadProvidersAndIndexes()}
              disabled={refreshing}>
              Refresh
            </Button>
            <Button 
              leftSection={<IconPlus size={16} />} 
              onClick={() => setCreateModalOpen(true)}
              variant="gradient"
              gradient={{ from: 'violet', to: 'grape', deg: 90 }}>
              Create Index
            </Button>
          </Group>
        </Group>
      </Paper>

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Indexes
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {rows.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="violet">
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
                {providers.length}
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
                {providers.filter(p => p.status === 'active').length}
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
                Avg. Dimensions
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="orange">
                {rows.length > 0 ? Math.round(totalDimensions / rows.length) : 0}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="orange">
              <IconChartDots3 size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

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
              <ThemeIcon size={80} radius="xl" variant="light" color="violet">
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
                gradient={{ from: 'violet', to: 'grape', deg: 90 }}>
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
                  const providerHandle = resolveProviderHandle(index.metadata);
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
                          <ThemeIcon size={40} radius="md" variant="light" color="violet">
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
                          <Badge variant="filled" color="violet" size="md" radius="sm">
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
