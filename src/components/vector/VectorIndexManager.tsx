'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconRefresh } from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import SectionCard from '@/components/common/SectionCard';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';

const DEFAULT_METRIC_OPTIONS = [
  { value: 'cosine', label: 'Cosine' },
  { value: 'dot', label: 'Dot Product' },
  { value: 'euclidean', label: 'Euclidean' },
];

type VectorIndexManagerProps = {
  provider?: VectorProviderView | null;
};

type CreateIndexFormValues = {
  name: string;
  dimension: number | '';
  metric: string;
};

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

function formatDate(value?: Date | string) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

function resolveAllowedMetrics(provider?: VectorProviderView | null): string[] | null {
  const raw = provider?.driverCapabilities?.['vector.metrics'];
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
    return raw as string[];
  }
  return null;
}

export default function VectorIndexManager({ provider }: VectorIndexManagerProps) {
  const [indexes, setIndexes] = useState<VectorIndexRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const router = useRouter();

  const form = useForm<CreateIndexFormValues>({
    initialValues: {
      name: '',
      dimension: '',
      metric: 'cosine',
    },
    validate: {
      name: (value) => (!value ? 'Name is required' : null),
      dimension: (value) =>
        !value || Number(value) <= 0 ? 'Dimension must be positive' : null,
    },
  });

  const { values: formValues, setFieldValue } = form;

  const providerKey = provider?.key;
  const allowedMetrics = useMemo(() => resolveAllowedMetrics(provider), [provider]);

  const metricOptions = useMemo(() => {
    if (allowedMetrics && allowedMetrics.length > 0) {
      return DEFAULT_METRIC_OPTIONS.filter((option) => allowedMetrics.includes(option.value));
    }
    return DEFAULT_METRIC_OPTIONS;
  }, [allowedMetrics]);

  useEffect(() => {
    if (allowedMetrics && allowedMetrics.length > 0) {
      if (!allowedMetrics.includes(formValues.metric)) {
        setFieldValue('metric', allowedMetrics[0]);
      }
    }
  }, [allowedMetrics, formValues.metric, setFieldValue]);

  const loadIndexes = useCallback(async () => {
    if (!providerKey) {
      setIndexes([]);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(
        `/api/vector/indexes?providerKey=${encodeURIComponent(providerKey)}`,
      );
      if (!response.ok) {
        throw new Error('Failed to fetch vector indexes');
      }
      const data = await response.json();
      setIndexes(data.indexes ?? []);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load indexes',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
    }
  }, [providerKey]);

  useEffect(() => {
    void loadIndexes();
  }, [loadIndexes]);

  const handleCreateIndex = async (values: CreateIndexFormValues) => {
    if (!providerKey) return;

    const normalizedName = values.name.trim().toLowerCase();
    const existingIndex = indexes.find(
      (index) => index.name.trim().toLowerCase() === normalizedName,
    );

    if (existingIndex) {
      notifications.show({
        color: 'blue',
        title: 'Vector index ready',
        message: `Using existing index "${existingIndex.name}".`,
      });
      return;
    }

    const response = await fetch('/api/vector/indexes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerKey,
        name: values.name,
        dimension: Number(values.dimension),
        metric: values.metric,
      }),
    });

    const payload = (await response.json().catch(() => null)) as
      | { index?: VectorIndexRecord; reused?: boolean; error?: string }
      | null;

    if (!response.ok) {
      throw new Error(payload?.error ?? 'Failed to create index');
    }

    const indexName = payload?.index?.name ?? values.name;

    if (payload?.reused || response.status === 200) {
      notifications.show({
        color: 'blue',
        title: 'Vector index ready',
        message: `Using existing index "${indexName}".`,
      });
      await loadIndexes();
      return;
    }

    notifications.show({
      color: 'green',
      title: 'Vector index created',
      message: `${indexName} is ready to use.`,
    });
    await loadIndexes();
  };

  const handleDeleteIndex = async (index: VectorIndexRecord) => {
    if (!providerKey) return;
    const confirmed = window.confirm(
      `Delete index "${index.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    const response = await fetch(
  `/api/vector/indexes/${encodeURIComponent(index.key)}?providerKey=${encodeURIComponent(providerKey)}`,
      {
        method: 'DELETE',
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      notifications.show({
        color: 'red',
        title: 'Failed to delete index',
        message: error.error ?? 'Unexpected error',
      });
      return;
    }

    notifications.show({
      color: 'green',
      title: 'Vector index deleted',
      message: `${index.name} has been removed.`,
    });
    await loadIndexes();
  };

  const navigateToIndex = (index: VectorIndexRecord) => {
    if (!providerKey) {
      return;
    }
    router.push(`/dashboard/vector/${providerKey}/${index.key}`);
  };

  const createModal = (
    <Modal
      opened={createModalOpen}
      onClose={() => setCreateModalOpen(false)}
      title="Create Vector Index"
      size="md"
    >
      <form
        onSubmit={form.onSubmit(async (values) => {
          try {
            await handleCreateIndex(values);
            setCreateModalOpen(false);
            form.reset();
          } catch (error) {
            console.error(error);
            notifications.show({
              color: 'red',
              title: 'Unable to create index',
              message:
                error instanceof Error ? error.message : 'Unexpected error',
            });
          }
        })}
      >
        <Stack gap="md">
          <TextInput
            label="Name"
            placeholder="Knowledge base"
            required
            {...form.getInputProps('name')}
          />
          <NumberInput
            label="Dimension"
            placeholder="1536"
            required
            {...form.getInputProps('dimension')}
          />
          <Select
            label="Metric"
            data={metricOptions}
            disabled={!!allowedMetrics && allowedMetrics.length <= 1}
            {...form.getInputProps('metric')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );

  return (
    <SectionCard
      title="Knowledge Index"
      description={
        provider
          ? `Manage indexes for ${provider.label}`
          : 'Select a vector provider to view its indexes.'
      }
      actions={
        <Group gap="xs">
          <Tooltip label="Refresh">
            <ActionIcon
              variant="subtle"
              onClick={() => void loadIndexes()}
              disabled={!providerKey}
              aria-label="Refresh indexes"
            >
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
          <Button onClick={() => setCreateModalOpen(true)} disabled={!providerKey}>
            New Index
          </Button>
        </Group>
      }
    >
      <Stack gap="md">
        {!provider ? (
          <EmptyState
            title="No provider selected"
            description="Choose a vector provider to inspect or create indexes."
            minHeight={220}
          />
        ) : loading ? (
          <LoadingState label="Loading vector indexes..." minHeight={220} />
        ) : indexes.length === 0 ? (
          <EmptyState
            title="No indexes yet"
            description="Create the first vector index for this provider to start storing embeddings."
            minHeight={220}
          />
        ) : (
          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Index ID</Table.Th>
                <Table.Th>Dimension</Table.Th>
                <Table.Th>Metric</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {indexes.map((index) => {
                const providerHandle = resolveProviderHandle(index.metadata);
                return (
                  <Table.Tr
                    key={index.key}
                    onClick={() => navigateToIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigateToIndex(index);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open index ${index.name}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>
                      <Group gap="xs">
                        <Text fw={500}>{index.name}</Text>
                        <Badge color="blue" variant="light">
                          {index.createdBy ?? 'system'}
                        </Badge>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={4}>
                        <Text size="sm" c="dimmed" ff="monospace">
                          {index.key}
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
                    </Table.Td>
                    <Table.Td>{index.dimension}</Table.Td>
                    <Table.Td>{index.metric}</Table.Td>
                    <Table.Td>{formatDate(index.createdAt)}</Table.Td>
                    <Table.Td>
                      <Tooltip label="Delete index">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`Delete ${index.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteIndex(index);
                          }}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
      {createModal}
    </SectionCard>
  );
}
