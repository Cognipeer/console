'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconArrowRight } from '@tabler/icons-react';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';
import type { IVectorMigration } from '@/lib/database/provider/types.base';

export interface CreateVectorMigrationModalProps {
  opened: boolean;
  onClose: () => void;
  providers: VectorProviderView[];
  indexesByProvider: Record<string, VectorIndexRecord[]>;
  onCreated: (migration: IVectorMigration) => void;
}

interface FormValues {
  name: string;
  description: string;
  sourceProviderKey: string;
  sourceIndexKey: string;
  destinationProviderKey: string;
  destinationIndexKey: string;
  batchSize: number | '';
}

export default function CreateVectorMigrationModal({
  opened,
  onClose,
  providers,
  indexesByProvider,
  onCreated,
}: CreateVectorMigrationModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const wasOpenedRef = useRef(false);

  const activeProviders = useMemo(
    () => providers.filter((p) => p.status !== 'disabled'),
    [providers],
  );

  const providerOptions = useMemo(
    () =>
      activeProviders.map((p) => ({
        value: p.key,
        label: p.label,
      })),
    [activeProviders],
  );

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      sourceProviderKey: activeProviders[0]?.key ?? '',
      sourceIndexKey: '',
      destinationProviderKey: activeProviders[0]?.key ?? '',
      destinationIndexKey: '',
      batchSize: 100,
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      sourceProviderKey: (v) => (!v ? 'Select a source provider' : null),
      sourceIndexKey: (v) => (!v ? 'Select a source index' : null),
      destinationProviderKey: (v) => (!v ? 'Select a destination provider' : null),
      destinationIndexKey: (v) => (!v ? 'Select a destination index' : null),
    },
  });

  const { values: formValues, setFieldValue, reset } = form;

  const sourceIndexOptions = useMemo(
    () =>
      (indexesByProvider[formValues.sourceProviderKey] ?? []).map((idx) => ({
        value: idx.key,
        label: idx.name,
      })),
    [indexesByProvider, formValues.sourceProviderKey],
  );

  const destinationIndexOptions = useMemo(
    () =>
      (indexesByProvider[formValues.destinationProviderKey] ?? []).map((idx) => ({
        value: idx.key,
        label: idx.name,
      })),
    [indexesByProvider, formValues.destinationProviderKey],
  );

  // Reset source index when source provider changes
  useEffect(() => {
    setFieldValue('sourceIndexKey', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formValues.sourceProviderKey]);

  // Reset destination index when destination provider changes
  useEffect(() => {
    setFieldValue('destinationIndexKey', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formValues.destinationProviderKey]);

  useEffect(() => {
    if (!opened) {
      if (wasOpenedRef.current) {
        reset();
        wasOpenedRef.current = false;
      }
    } else {
      wasOpenedRef.current = true;
      if (!formValues.sourceProviderKey && activeProviders.length > 0) {
        setFieldValue('sourceProviderKey', activeProviders[0].key);
      }
      if (!formValues.destinationProviderKey && activeProviders.length > 0) {
        setFieldValue('destinationProviderKey', activeProviders[0].key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, activeProviders]);

  const handleSubmit = form.onSubmit(async (values) => {
    if (
      values.sourceProviderKey === values.destinationProviderKey &&
      values.sourceIndexKey === values.destinationIndexKey
    ) {
      form.setErrors({ destinationIndexKey: 'Source and destination indexes cannot be the same' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/vector/migrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          sourceProviderKey: values.sourceProviderKey,
          sourceIndexKey: values.sourceIndexKey,
          destinationProviderKey: values.destinationProviderKey,
          destinationIndexKey: values.destinationIndexKey,
          batchSize: values.batchSize || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to create migration');
      }

      const data = await response.json();
      notifications.show({
        color: 'teal',
        title: 'Migration created',
        message: `"${values.name}" is ready to start.`,
      });
      onCreated(data.migration as IVectorMigration);
      onClose();
      reset();
    } catch (error: unknown) {
      notifications.show({
        color: 'red',
        title: 'Unable to create migration',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  });

  const sourceProvider = useMemo(
    () => activeProviders.find((p) => p.key === formValues.sourceProviderKey) ?? null,
    [activeProviders, formValues.sourceProviderKey],
  );
  const destinationProvider = useMemo(
    () => activeProviders.find((p) => p.key === formValues.destinationProviderKey) ?? null,
    [activeProviders, formValues.destinationProviderKey],
  );

  return (
    <Modal opened={opened} onClose={onClose} title="Create Vector Migration" size="xl">
      <form onSubmit={handleSubmit}>
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            Migrate vectors from a source index to a destination index. The migration runs as a
            background job and can be monitored in real time.
          </Text>

          <TextInput
            label="Migration name"
            placeholder="e.g. Migrate documents to new index"
            {...form.getInputProps('name')}
          />
          <Textarea
            label="Description"
            placeholder="Optional description"
            autosize
            minRows={2}
            {...form.getInputProps('description')}
          />

          <Divider label="Source" labelPosition="left" />

          <Group grow align="flex-start">
            <Select
              label="Source provider"
              placeholder="Select provider"
              data={providerOptions}
              value={formValues.sourceProviderKey}
              onChange={(v) => setFieldValue('sourceProviderKey', v ?? '')}
              searchable
              error={form.errors.sourceProviderKey}
            />
            <Select
              label="Source index"
              placeholder={sourceIndexOptions.length === 0 ? 'No indexes available' : 'Select index'}
              data={sourceIndexOptions}
              value={formValues.sourceIndexKey}
              onChange={(v) => setFieldValue('sourceIndexKey', v ?? '')}
              disabled={sourceIndexOptions.length === 0}
              error={form.errors.sourceIndexKey}
              searchable
            />
          </Group>

          {sourceProvider && (
            <Card withBorder radius="md" p="sm" bg="dark.8">
              <Group gap="xs">
                <Badge size="xs" variant="light" radius="xl" color={sourceProvider.status === 'active' ? 'teal' : 'gray'}>
                  {sourceProvider.status}
                </Badge>
                <Text size="xs" c="dimmed">{sourceProvider.label}</Text>
                <Text size="xs" c="dimmed">·</Text>
                <Text size="xs" c="dimmed">{sourceProvider.driver}</Text>
              </Group>
            </Card>
          )}

          <Divider label="Destination" labelPosition="left" />

          <Group grow align="flex-start">
            <Select
              label="Destination provider"
              placeholder="Select provider"
              data={providerOptions}
              value={formValues.destinationProviderKey}
              onChange={(v) => setFieldValue('destinationProviderKey', v ?? '')}
              searchable
              error={form.errors.destinationProviderKey}
            />
            <Select
              label="Destination index"
              placeholder={destinationIndexOptions.length === 0 ? 'No indexes available' : 'Select index'}
              data={destinationIndexOptions}
              value={formValues.destinationIndexKey}
              onChange={(v) => setFieldValue('destinationIndexKey', v ?? '')}
              disabled={destinationIndexOptions.length === 0}
              error={form.errors.destinationIndexKey}
              searchable
            />
          </Group>

          {destinationProvider && (
            <Card withBorder radius="md" p="sm" bg="dark.8">
              <Group gap="xs">
                <Badge size="xs" variant="light" radius="xl" color={destinationProvider.status === 'active' ? 'teal' : 'gray'}>
                  {destinationProvider.status}
                </Badge>
                <Text size="xs" c="dimmed">{destinationProvider.label}</Text>
                <Text size="xs" c="dimmed">·</Text>
                <Text size="xs" c="dimmed">{destinationProvider.driver}</Text>
              </Group>
            </Card>
          )}

          <Divider label="Options" labelPosition="left" />

          <NumberInput
            label="Batch size"
            description="Number of vectors to migrate per batch (default: 100)"
            placeholder="100"
            min={1}
            max={10000}
            {...form.getInputProps('batchSize')}
          />

          <Group justify="flex-end" pt="sm">
            <Button variant="subtle" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={submitting}
              leftSection={<IconArrowRight size={14} />}
            >
              Create Migration
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
