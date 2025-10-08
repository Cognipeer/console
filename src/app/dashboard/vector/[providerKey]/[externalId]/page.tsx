'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import type {
  VectorIndexRecord,
  VectorQueryResponse,
  VectorProviderView,
} from '@/lib/services/vector';
import EditVectorIndexModal from '@/components/vector/EditVectorIndexModal';
import UpsertVectorItemModal from '@/components/vector/UpsertVectorItemModal';

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function stringifyMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return '—';
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return '—';
  }
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

function resolveBucketName(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const raw = metadata['bucketName'];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

export default function VectorIndexDetailPage() {
  const params = useParams();
  const router = useRouter();
  const providerKeyParam = params.providerKey;
  const indexKeyParam = params.externalId;
  const providerKey = Array.isArray(providerKeyParam) ? providerKeyParam[0] : providerKeyParam;
  const indexKey = Array.isArray(indexKeyParam) ? indexKeyParam[0] : indexKeyParam;

  const [provider, setProvider] = useState<VectorProviderView | null>(null);
  const [index, setIndex] = useState<VectorIndexRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [queryResult, setQueryResult] = useState<VectorQueryResponse | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [upsertModalOpen, setUpsertModalOpen] = useState(false);
  const [deleteVectorId, setDeleteVectorId] = useState('');

  const description = useMemo(() => {
    if (!index?.metadata) return '';
    const value = index.metadata.description;
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    return String(value);
  }, [index?.metadata]);

  const providerHandle = useMemo(() => resolveProviderHandle(index?.metadata), [index?.metadata]);
  const bucketName = useMemo(() => resolveBucketName(index?.metadata), [index?.metadata]);

  const queryForm = useForm({
    initialValues: {
      vector: '',
      topK: 5,
      filter: '',
    },
    validate: {
      vector: (value) => (!value ? 'Vector values are required' : null),
      topK: (value) => (value <= 0 ? 'Top K must be positive' : null),
    },
  });

  const loadIndex = useCallback(async () => {
    if (!providerKey || !indexKey) {
      setIndex(null);
      setProvider(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    setRefreshing(true);
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(indexKey)}?providerKey=${encodeURIComponent(providerKey)}`,
        { cache: 'no-store' },
      );
      if (!response.ok) {
        if (response.status === 404) {
          router.push('/dashboard/vector');
          return;
        }
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to load vector index');
      }
      const data = await response.json();
      setIndex(data.index ?? null);
      setProvider(data.provider ?? null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [providerKey, indexKey, router]);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  const handleDelete = async () => {
    if (!provider || !index) return;
    const confirmed = window.confirm(
      `Delete index "${index.name}"? This cannot be undone.`,
    );
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
      router.push('/dashboard/vector');
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to delete index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleUpdateIndex = async (values: { name: string; description?: string }) => {
    if (!provider || !index) return;
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name,
            metadata: values.description ? { description: values.description } : {},
          }),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to update index');
      }
      const data = await response.json();
      setIndex(data.index ?? null);
      notifications.show({
        color: 'green',
        title: 'Index updated',
        message: `${values.name} has been updated.`,
      });
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to update index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleQuery = queryForm.onSubmit(async (values) => {
    if (!provider || !index) return;
    setQueryLoading(true);
    setQueryResult(null);
    try {
      const vector = values.vector
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
        .map((segment) => Number(segment));

      if (vector.length === 0 || vector.some((value) => Number.isNaN(value))) {
        throw new Error('Vector must contain numeric values separated by commas.');
      }

      let filter: Record<string, unknown> | undefined;
      if (values.filter) {
        try {
          filter = JSON.parse(values.filter) as Record<string, unknown>;
        } catch {
          throw new Error('Filter must be valid JSON.');
        }
      }

      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}/query?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: {
              vector,
              topK: values.topK,
              filter,
            },
          }),
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to run query');
      }

      const data = await response.json();
      setQueryResult(data.result ?? null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Query failed',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setQueryLoading(false);
    }
  });

  const handleUpsertItem = async (payload: { id: string; values: number[]; metadata?: Record<string, unknown> }) => {
    if (!provider || !index) return;
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}/upsert?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vectors: [
              {
                id: payload.id,
                values: payload.values,
                metadata: payload.metadata,
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to upsert item');
      }

      notifications.show({
        color: 'green',
        title: 'Vector item upserted',
        message: `${payload.id} has been stored.`,
      });
      await loadIndex();
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to upsert item',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!provider || !index) return;
    const confirmed = window.confirm(`Remove vector item "${itemId}"? This cannot be undone.`);
    if (!confirmed) return;

    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}/vectors?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [itemId] }),
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to delete vector item');
      }

      notifications.show({
        color: 'green',
        title: 'Vector item removed',
        message: `${itemId} has been deleted.`,
      });
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to delete item',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  if (!index || !provider) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">Vector index not found.</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/vector')}>
            Back to vector indexes
          </Button>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center">
        <Group gap="xs">
          <ActionIcon variant="light" onClick={() => router.push('/dashboard/vector')}>
            <IconArrowLeft size={16} />
          </ActionIcon>
          <div>
            <Group gap="xs">
              <Text fw={600} size="xl">
                {index.name}
              </Text>
              <Badge>{index.metric}</Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Provider {provider.label} • Driver {provider.driver}
            </Text>
          </div>
        </Group>
        <Group gap="xs">
          <Tooltip label="Refresh">
            <ActionIcon
              variant="subtle"
              onClick={() => void loadIndex()}
              disabled={refreshing}
            >
              {refreshing ? <Loader size="xs" /> : <IconRefresh size={16} />}
            </ActionIcon>
          </Tooltip>
          <Button
            variant="light"
            leftSection={<IconDeviceFloppy size={16} />}
            onClick={() => setEditModalOpen(true)}
          >
            Edit details
          </Button>
          <Button color="red" leftSection={<IconTrash size={16} />} onClick={() => void handleDelete()}>
            Delete
          </Button>
        </Group>
      </Group>

      <Paper withBorder radius="md" shadow="sm" p="md">
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Index key: {index.key}
          </Text>
          {providerHandle ? (
            <Text size="sm" c="dimmed">
              Provider handle: {providerHandle}
            </Text>
          ) : null}
          {bucketName ? (
            <Text size="sm" c="dimmed">
              Bucket: {bucketName}
            </Text>
          ) : null}
          <Text size="sm" c="dimmed">
            External ID: {index.externalId}
          </Text>
          <Group gap="lg">
            <div>
              <Text size="xs" c="dimmed">
                Dimension
              </Text>
              <Text fw={500}>{index.dimension}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">
                Created
              </Text>
              <Text fw={500}>{formatDate(index.createdAt)}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">
                Updated
              </Text>
              <Text fw={500}>{formatDate(index.updatedAt)}</Text>
            </div>
          </Group>
          {description && (
            <Text size="sm">
              {description}
            </Text>
          )}
        </Stack>
      </Paper>

      <Group align="flex-start" grow>
        <Paper withBorder radius="md" shadow="sm" p="md" style={{ flex: 1 }}>
          <Stack gap="md">
            <Stack gap="xs">
              <Text fw={600}>Manage vectors</Text>
              <Text size="sm" c="dimmed">
                Vectors live in your provider. Use these actions to sync data without storing local snapshots.
              </Text>
            </Stack>
            <Group justify="flex-start">
              <Button onClick={() => setUpsertModalOpen(true)}>Upsert vector</Button>
            </Group>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = deleteVectorId.trim();
                if (!trimmed) {
                  notifications.show({
                    color: 'yellow',
                    title: 'Vector ID required',
                    message: 'Enter the vector identifier you want to remove.',
                  });
                  return;
                }
                void (async () => {
                  await handleDeleteItem(trimmed);
                  setDeleteVectorId('');
                })();
              }}
            >
              <Stack gap="xs">
                <Text size="sm" fw={500}>
                  Delete vector by ID
                </Text>
                <TextInput
                  placeholder="vector-id"
                  value={deleteVectorId}
                  onChange={(event) => setDeleteVectorId(event.currentTarget.value)}
                />
                <Group justify="flex-end">
                  <Button
                    type="submit"
                    variant="light"
                    color="red"
                    leftSection={<IconTrash size={16} />}
                  >
                    Delete
                  </Button>
                </Group>
              </Stack>
            </form>
            <Text size="xs" c="dimmed">
              Need bulk operations? Use the API endpoints or your provider&apos;s console for imports and exports.
            </Text>
          </Stack>
        </Paper>

        <Paper withBorder radius="md" shadow="sm" p="md" style={{ flex: 1 }}>
          <Stack gap="md">
            <Text fw={600}>Run similarity query</Text>
            <form onSubmit={handleQuery}>
              <Stack gap="sm">
                <Textarea
                  label="Vector"
                  placeholder="1.2, 3.4, ..."
                  minRows={3}
                  autosize
                  {...queryForm.getInputProps('vector')}
                />
                <NumberInput
                  label="Top K"
                  min={1}
                  {...queryForm.getInputProps('topK')}
                />
                <Textarea
                  label="Filter (JSON)"
                  placeholder='{ "category": "support" }'
                  minRows={2}
                  autosize
                  {...queryForm.getInputProps('filter')}
                />
                <Group justify="flex-end">
                  <Button type="submit" loading={queryLoading}>
                    Run query
                  </Button>
                </Group>
              </Stack>
            </form>

            {queryResult && (
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  {queryResult.matches.length} matches
                </Text>
                <Table highlightOnHover verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>ID</Table.Th>
                      <Table.Th>Score</Table.Th>
                      <Table.Th>Metadata</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {queryResult.matches.map((match) => (
                      <Table.Tr key={match.id}>
                        <Table.Td>{match.id}</Table.Td>
                        <Table.Td>{match.score.toFixed(4)}</Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                            {stringifyMetadata(match.metadata)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Stack>
            )}
          </Stack>
        </Paper>
      </Group>

      <EditVectorIndexModal
        opened={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        initialName={index.name}
        initialDescription={description}
        onSubmit={handleUpdateIndex}
      />

      <UpsertVectorItemModal
        opened={upsertModalOpen}
        onClose={() => setUpsertModalOpen(false)}
        expectedDimension={index.dimension}
        onSubmit={handleUpsertItem}
      />
    </Stack>
  );
}
