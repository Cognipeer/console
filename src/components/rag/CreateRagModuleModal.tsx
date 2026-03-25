'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';

interface EmbeddingModel {
  key: string;
  name: string;
}

interface VectorProvider {
  key: string;
  label: string;
  status: string;
}

interface VectorIndex {
  key: string;
  name: string;
  providerKey: string;
  dimension: number;
}

interface CreateRagModuleModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (ragModule: Record<string, unknown>) => void;
}

interface FormValues {
  name: string;
  description: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  chunkStrategy: string;
  chunkSize: number | '';
  chunkOverlap: number | '';
  separators: string[];
  encoding: string;
}

export default function CreateRagModuleModal({ opened, onClose, onCreated }: CreateRagModuleModalProps) {
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [vectorProviders, setVectorProviders] = useState<VectorProvider[]>([]);
  const [vectorIndexes, setVectorIndexes] = useState<VectorIndex[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      embeddingModelKey: '',
      vectorProviderKey: '',
      vectorIndexKey: '',
      chunkStrategy: 'recursive_character',
      chunkSize: 1000,
      chunkOverlap: 200,
      separators: ['\\n\\n', '\\n', '. ', ' '],
      encoding: 'cl100k_base',
    },
    validate: {
      name: (v) => (!v ? 'Name is required' : null),
      embeddingModelKey: (v) => (!v ? 'Embedding model is required' : null),
      vectorProviderKey: (v) => (!v ? 'Vector provider is required' : null),
      vectorIndexKey: (v) => (!v ? 'Vector index is required' : null),
      chunkSize: (v) => (!v || Number(v) <= 0 ? 'Chunk size must be positive' : null),
      chunkOverlap: (v) => (v === '' || Number(v) < 0 ? 'Overlap must be non-negative' : null),
    },
  });

  const selectedProvider = form.values.vectorProviderKey;

  const loadEmbeddingModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models?category=embedding', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setEmbeddingModels((data.models ?? []).map((m: Record<string, string>) => ({ key: m.key, name: m.name })));
      }
    } catch (err) {
      console.error('Failed to load embedding models', err);
    }
  }, []);

  const loadVectorProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/vector/providers', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setVectorProviders((data.providers ?? []).map((p: Record<string, string>) => ({
          key: p.key,
          label: p.label || p.key,
          status: p.status,
        })));
      }
    } catch (err) {
      console.error('Failed to load vector providers', err);
    }
  }, []);

  const loadVectorIndexes = useCallback(async () => {
    if (!selectedProvider) {
      setVectorIndexes([]);
      return;
    }
    try {
      const res = await fetch(`/api/vector/indexes?providerKey=${encodeURIComponent(selectedProvider)}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setVectorIndexes((data.indexes ?? []).map((i: Record<string, unknown>) => ({
          key: i.key as string,
          name: i.name as string,
          providerKey: i.providerKey as string,
          dimension: i.dimension as number,
        })));
      }
    } catch (err) {
      console.error('Failed to load vector indexes', err);
    }
  }, [selectedProvider]);

  useEffect(() => {
    if (opened) {
      void loadEmbeddingModels();
      void loadVectorProviders();
    }
  }, [opened, loadEmbeddingModels, loadVectorProviders]);

  useEffect(() => {
    void loadVectorIndexes();
  }, [loadVectorIndexes]);

  const handleSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      const chunkConfig: Record<string, unknown> = {
        strategy: values.chunkStrategy,
        chunkSize: Number(values.chunkSize),
        chunkOverlap: Number(values.chunkOverlap),
      };

      if (values.chunkStrategy === 'recursive_character') {
        chunkConfig.separators = values.separators.map((s) =>
          s.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
        );
      }
      if (values.chunkStrategy === 'token') {
        chunkConfig.encoding = values.encoding;
      }

      const res = await fetch('/api/rag/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          embeddingModelKey: values.embeddingModelKey,
          vectorProviderKey: values.vectorProviderKey,
          vectorIndexKey: values.vectorIndexKey,
          chunkConfig,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to create RAG module');
      }

      const data = await res.json();
      notifications.show({
        color: 'green',
        title: 'RAG Module Created',
        message: `${values.name} has been created successfully.`,
      });
      form.reset();
      onCreated(data.module);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Failed to create RAG module',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Create RAG Module"
      size="lg"
    >
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          <TextInput
            label="Name"
            placeholder="My Knowledge Base"
            required
            {...form.getInputProps('name')}
          />
          <Textarea
            label="Description"
            placeholder="Describe what this RAG module is for..."
            rows={2}
            {...form.getInputProps('description')}
          />

          <Select
            label="Embedding Model"
            placeholder="Select an embedding model"
            required
            data={embeddingModels.map((m) => ({ value: m.key, label: m.name }))}
            searchable
            {...form.getInputProps('embeddingModelKey')}
          />

          <Group grow>
            <Select
              label="Vector Provider"
              placeholder="Select a vector provider"
              required
              data={vectorProviders
                .filter((p) => p.status === 'active')
                .map((p) => ({ value: p.key, label: p.label }))}
              searchable
              {...form.getInputProps('vectorProviderKey')}
              onChange={(val) => {
                form.setFieldValue('vectorProviderKey', val ?? '');
                form.setFieldValue('vectorIndexKey', '');
              }}
            />
            <Select
              label="Vector Index"
              placeholder="Select an index"
              required
              data={vectorIndexes.map((i) => ({ value: i.key, label: `${i.name} (${i.dimension}d)` }))}
              searchable
              disabled={!selectedProvider}
              {...form.getInputProps('vectorIndexKey')}
            />
          </Group>

          <Select
            label="Chunk Strategy"
            data={[
              { value: 'recursive_character', label: 'Recursive Character' },
              { value: 'token', label: 'Token Based' },
            ]}
            {...form.getInputProps('chunkStrategy')}
          />

          <Group grow>
            <NumberInput
              label="Chunk Size"
              min={50}
              max={10000}
              step={100}
              required
              {...form.getInputProps('chunkSize')}
            />
            <NumberInput
              label="Chunk Overlap"
              min={0}
              max={5000}
              step={50}
              required
              {...form.getInputProps('chunkOverlap')}
            />
          </Group>

          {form.values.chunkStrategy === 'recursive_character' && (
            <TagsInput
              label="Separators"
              description="Use \\n for newline. Order matters - first separator tried first."
              placeholder="Add separator..."
              {...form.getInputProps('separators')}
            />
          )}

          {form.values.chunkStrategy === 'token' && (
            <Select
              label="Token Encoding"
              data={[
                { value: 'cl100k_base', label: 'cl100k_base (GPT-4, GPT-3.5)' },
                { value: 'p50k_base', label: 'p50k_base (Codex, text-davinci)' },
                { value: 'o200k_base', label: 'o200k_base (GPT-4o)' },
              ]}
              {...form.getInputProps('encoding')}
            />
          )}

          <Text size="xs" c="dimmed">
            The document text will be split into chunks using the selected strategy, then each chunk will be embedded and stored in the vector index.
          </Text>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create Module
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
