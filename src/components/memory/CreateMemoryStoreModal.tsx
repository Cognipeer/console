'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useTranslations } from '@/lib/i18n';

interface VectorProviderOption {
  key: string;
  name?: string;
  driver?: string;
  status?: string;
}

interface ModelOption {
  key: string;
  name?: string;
  modelId?: string;
}

interface CreateMemoryStoreModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface FormValues {
  name: string;
  description: string;
  vectorProviderKey: string;
  embeddingModelKey: string;
  deduplication: boolean;
  autoEmbed: boolean;
  defaultTopK: number;
  defaultMinScore: number;
}

export default function CreateMemoryStoreModal({
  opened,
  onClose,
  onCreated,
}: CreateMemoryStoreModalProps) {
  const t = useTranslations('memory');
  const [vectorProviders, setVectorProviders] = useState<VectorProviderOption[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<ModelOption[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      vectorProviderKey: '',
      embeddingModelKey: '',
      deduplication: true,
      autoEmbed: true,
      defaultTopK: 10,
      defaultMinScore: 0.7,
    },
    validate: {
      name: (v) => (v.trim() ? null : t('validation.nameRequired')),
      vectorProviderKey: (v) => (v ? null : t('validation.vectorProviderRequired')),
      embeddingModelKey: (v) => (v ? null : t('validation.embeddingModelRequired')),
    },
  });

  const loadVectorProviders = useCallback(async () => {
    setLoadingProviders(true);
    try {
      const res = await fetch('/api/vector/providers', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setVectorProviders(data.providers ?? data ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoadingProviders(false);
    }
  }, []);

  const loadEmbeddingModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const res = await fetch('/api/models?category=embedding', {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        setEmbeddingModels(data.models ?? data ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    if (opened) {
      loadVectorProviders();
      loadEmbeddingModels();
    }
  }, [opened, loadVectorProviders, loadEmbeddingModels]);

  const handleSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/memory/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          vectorProviderKey: values.vectorProviderKey,
          embeddingModelKey: values.embeddingModelKey,
          config: {
            deduplication: values.deduplication,
            autoEmbed: values.autoEmbed,
            defaultTopK: values.defaultTopK,
            defaultMinScore: values.defaultMinScore,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Failed to create store');
      }

      form.reset();
      onCreated();
    } catch (error) {
      notifications.show({
        title: t('error'),
        message:
          error instanceof Error ? error.message : t('createError'),
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const providerOptions = vectorProviders
    .filter((p) => p.status === 'active')
    .map((p) => ({
      value: p.key,
      label: p.name || p.key,
    }));

  const modelOptions = embeddingModels.map((m) => ({
    value: m.key,
    label: m.name || m.modelId || m.key,
  }));

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('createStore')}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t('form.name')}
            placeholder={t('form.namePlaceholder')}
            required
            {...form.getInputProps('name')}
          />

          <Textarea
            label={t('form.description')}
            placeholder={t('form.descriptionPlaceholder')}
            autosize
            minRows={2}
            maxRows={4}
            {...form.getInputProps('description')}
          />

          <Select
            label={t('form.vectorProvider')}
            placeholder={t('form.vectorProviderPlaceholder')}
            required
            data={providerOptions}
            rightSection={loadingProviders ? <Loader size={14} /> : undefined}
            searchable
            {...form.getInputProps('vectorProviderKey')}
          />

          <Select
            label={t('form.embeddingModel')}
            placeholder={t('form.embeddingModelPlaceholder')}
            required
            data={modelOptions}
            rightSection={loadingModels ? <Loader size={14} /> : undefined}
            searchable
            {...form.getInputProps('embeddingModelKey')}
          />

          <Group grow>
            <NumberInput
              label={t('form.defaultTopK')}
              min={1}
              max={100}
              {...form.getInputProps('defaultTopK')}
            />
            <NumberInput
              label={t('form.defaultMinScore')}
              min={0}
              max={1}
              step={0.05}
              decimalScale={2}
              {...form.getInputProps('defaultMinScore')}
            />
          </Group>

          <Switch
            label={t('form.deduplication')}
            description={t('form.deduplicationDescription')}
            {...form.getInputProps('deduplication', { type: 'checkbox' })}
          />

          <Switch
            label={t('form.autoEmbed')}
            description={t('form.autoEmbedDescription')}
            {...form.getInputProps('autoEmbed', { type: 'checkbox' })}
          />

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={submitting}>
              {t('create')}
            </Button>
          </Group>
        </Stack>
      </form>

      {loadingProviders && providerOptions.length === 0 && (
        <Text size="xs" c="dimmed" ta="center" mt="xs">
          Loading providers...
        </Text>
      )}
    </Modal>
  );
}
