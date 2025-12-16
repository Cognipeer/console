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
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconEye, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
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

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={600} size="xl">
            Vector Indexes
          </Text>
          <Text size="sm" c="dimmed">
            Manage vector indexes across providers, inspect recent items, and launch queries.
          </Text>
        </div>
        <Group gap="xs">
          <Tooltip label="Refresh">
            <ActionIcon
              variant="subtle"
              onClick={() => void loadProvidersAndIndexes()}
              disabled={refreshing}
            >
              {refreshing ? <Loader size="xs" /> : <IconRefresh size={16} />}
            </ActionIcon>
          </Tooltip>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateModalOpen(true)}>
            Create Index
          </Button>
        </Group>
      </Group>

      <Paper radius="md" shadow="sm" withBorder>
        {loading ? (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        ) : rows.length === 0 ? (
          <Center py="xl">
            <Stack gap="sm" align="center">
              <Text size="sm" c="dimmed">
                {providers.length === 0
                  ? 'No vector providers configured yet. Add a provider to get started.'
                  : 'No indexes created yet. Use the Create Index button to add one.'}
              </Text>
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateModalOpen(true)}>
                Create Index
              </Button>
            </Stack>
          </Center>
        ) : (
          <Table striped verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Index</Table.Th>
                <Table.Th>Provider</Table.Th>
                <Table.Th>Dimension</Table.Th>
                <Table.Th>Metric</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th>Last Updated</Table.Th>
                <Table.Th></Table.Th>
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
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>
                      <Stack gap={4}>
                        <Text fw={600}>{index.name}</Text>
                        <Stack gap={2}>
                          <Text size="xs" c="dimmed">
                            Index key: {index.key}
                          </Text>
                          <Text size="xs" c="dimmed">
                            External ID: {index.externalId}
                          </Text>
                          {providerHandle ? (
                            <Text size="xs" c="dimmed">
                              Handle: {providerHandle}
                            </Text>
                          ) : null}
                        </Stack>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        <Group gap="xs">
                          <Text size="sm" fw={500}>
                            {provider.label}
                          </Text>
                          <Badge color={provider.status === 'active' ? 'green' : 'yellow'} size="sm">
                            {provider.status}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed">
                          Driver: {provider.driver}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>{index.dimension}</Table.Td>
                    <Table.Td>{index.metric}</Table.Td>
                    <Table.Td>{formatDate(index.createdAt)}</Table.Td>
                    <Table.Td>{formatDate(index.updatedAt)}</Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        <Tooltip label="View details">
                          <ActionIcon
                            variant="subtle"
                            onClick={(event) => {
                              event.stopPropagation();
                              navigateToDetail();
                            }}
                          >
                            <IconEye size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Delete index">
                          <ActionIcon
                            variant="subtle"
                            color="red"
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
