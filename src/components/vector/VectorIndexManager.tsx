'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { IconTrash, IconRefresh } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
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
  const deleteResource = useDeleteResource();
  const tSafe = useTranslations('common.confirm.dataSafety');
  const [indexes, setIndexes] = useState<VectorIndexRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);

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
    await deleteResource({
      noun: tSafe('nouns.vectorIndex'),
      name: index.name,
      type: 'vector-index',
      id: index._id ? String(index._id) : undefined,
      extraWarning: tSafe('vectorIndexExtra'),
      action: async () => {
        const response = await fetch(
          `/api/vector/indexes/${encodeURIComponent(index.key)}?providerKey=${encodeURIComponent(providerKey)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(error.error ?? 'Unexpected error');
        }
        notifications.show({
          color: 'green',
          title: 'Vector index deleted',
          message: `${index.name} has been removed.`,
        });
        await loadIndexes();
      },
    });
  };

  const indexColumns: DataGridColumn<VectorIndexRecord>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (index) => (
        <Group gap="xs">
          <Text fw={500}>{index.name}</Text>
          <Badge color="blue" variant="light">
            {index.createdBy ?? 'system'}
          </Badge>
        </Group>
      ),
    },
    {
      key: 'key',
      label: 'Index ID',
      render: (index) => {
        const providerHandle = resolveProviderHandle(index.metadata);
        return (
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
        );
      },
    },
    { key: 'dimension', label: 'Dimension', align: 'right', render: (index) => index.dimension },
    { key: 'metric', label: 'Metric', render: (index) => index.metric },
    { key: 'created', label: 'Created', render: (index) => formatDate(index.createdAt) },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (index) => (
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
      ),
    },
  ];

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
          <DataGrid<VectorIndexRecord>
            records={indexes}
            rowKey={(index) => index.key}
            columns={indexColumns}
            rowHref={(index) => (providerKey ? `/dashboard/vector/${providerKey}/${index.key}` : null)}
          />
        )}
      </Stack>
      {createModal}
    </SectionCard>
  );
}
