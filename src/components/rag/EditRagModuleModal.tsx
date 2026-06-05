'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  NumberInput,
  Select,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconBook } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';

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
  dimension: number;
}

interface RagModuleData {
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  chunkConfig: {
    strategy: string;
    chunkSize: number;
    chunkOverlap: number;
    separators?: string[];
    encoding?: string;
  };
  rerankerKey?: string | null;
  rerankerOversample?: number | null;
}

interface RerankerOption {
  key: string;
  name: string;
}

interface EditRagModuleModalProps {
  opened: boolean;
  onClose: () => void;
  module: RagModuleData;
  onUpdated: (ragModule: Record<string, unknown>) => void;
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
  rerankerKey: string;
  rerankerOversample: number | '';
}

export default function EditRagModuleModal({ opened, onClose, module, onUpdated }: EditRagModuleModalProps) {
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [vectorProviders, setVectorProviders] = useState<VectorProvider[]>([]);
  const [vectorIndexes, setVectorIndexes] = useState<VectorIndex[]>([]);
  const [rerankers, setRerankers] = useState<RerankerOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: module.name,
      description: module.description ?? '',
      embeddingModelKey: module.embeddingModelKey,
      vectorProviderKey: module.vectorProviderKey,
      vectorIndexKey: module.vectorIndexKey,
      chunkStrategy: module.chunkConfig.strategy,
      chunkSize: module.chunkConfig.chunkSize,
      chunkOverlap: module.chunkConfig.chunkOverlap,
      separators: module.chunkConfig.separators ?? ['\\n\\n', '\\n', '. ', ' '],
      encoding: module.chunkConfig.encoding ?? 'cl100k_base',
      rerankerKey: module.rerankerKey ?? '',
      rerankerOversample: module.rerankerOversample ?? '',
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

  const loadRerankers = useCallback(async () => {
    try {
      const res = await fetch('/api/reranker?status=active', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setRerankers(
          (data.rerankers ?? []).map((r: Record<string, string>) => ({
            key: r.key,
            name: r.name,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load rerankers', err);
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
          dimension: i.dimension as number,
        })));
      }
    } catch (err) {
      console.error('Failed to load vector indexes', err);
    }
  }, [selectedProvider]);

  // Reset form to current module values each time modal opens
  useEffect(() => {
    if (opened) {
      form.setValues({
        name: module.name,
        description: module.description ?? '',
        embeddingModelKey: module.embeddingModelKey,
        vectorProviderKey: module.vectorProviderKey,
        vectorIndexKey: module.vectorIndexKey,
        chunkStrategy: module.chunkConfig.strategy,
        chunkSize: module.chunkConfig.chunkSize,
        chunkOverlap: module.chunkConfig.chunkOverlap,
        separators: module.chunkConfig.separators ?? ['\\n\\n', '\\n', '. ', ' '],
        encoding: module.chunkConfig.encoding ?? 'cl100k_base',
        rerankerKey: module.rerankerKey ?? '',
        rerankerOversample: module.rerankerOversample ?? '',
      });
      void loadEmbeddingModels();
      void loadVectorProviders();
      void loadRerankers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

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

      const res = await fetch(`/api/rag/modules/${encodeURIComponent(module.key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          embeddingModelKey: values.embeddingModelKey,
          vectorProviderKey: values.vectorProviderKey,
          vectorIndexKey: values.vectorIndexKey,
          chunkConfig,
          rerankerKey: values.rerankerKey ? values.rerankerKey : null,
          rerankerOversample:
            values.rerankerOversample === ''
              ? null
              : Number(values.rerankerOversample),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to update RAG module');
      }

      const data = await res.json();
      notifications.show({
        color: 'green',
        title: 'RAG Module Updated',
        message: `${values.name} has been updated successfully.`,
      });
      onUpdated(data.module);
      onClose();
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Failed to update RAG module',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  });

  const v = form.values;
  const validIdentity = Boolean(v.name);
  const validStore = Boolean(v.embeddingModelKey && v.vectorProviderKey && v.vectorIndexKey);
  const validChunk = Boolean(v.chunkSize) && Number(v.chunkSize) > 0 && v.chunkOverlap !== '' && Number(v.chunkOverlap) >= 0;
  const canSubmit = validIdentity && validStore && validChunk;

  const checklist = [
    { id: 'name', label: 'Name provided', done: validIdentity },
    { id: 'store', label: 'Embedding + vector index set', done: validStore },
    { id: 'chunk', label: 'Chunking configured', done: validChunk },
  ];

  const summary = (
    <SummaryGroup title="RAG module">
      <SummaryKV label="Key" value={module.key} mono />
      <SummaryKV label="Name" value={v.name || '—'} />
      <SummaryKV label="Embedding" value={v.embeddingModelKey || '—'} />
      <SummaryKV label="Index" value={v.vectorIndexKey || '—'} />
      <SummaryKV label="Chunk" value={v.chunkSize ? `${v.chunkSize} / ${v.chunkOverlap}` : '—'} />
      <SummaryKV label="Reranker" value={v.rerankerKey || 'none'} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBook size={16} />}
      title="Edit RAG module"
      subtitle={module.key}
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Save changes',
        icon: <IconCheck size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: () => handleSubmit(),
      }}
    >
      <FormSection number={1} title="Identity" done={validIdentity}>
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput placeholder="My Knowledge Base" {...form.getInputProps('name')} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea placeholder="Describe what this RAG module is for..." rows={2} {...form.getInputProps('description')} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Embedding & vector store" done={validStore}>
        <FormField label="Embedding model" required>
          <Select
            placeholder={embeddingModels.length === 0 ? 'No embedding models found' : 'Select an embedding model'}
            data={embeddingModels.map((m) => ({ value: m.key, label: m.name }))}
            searchable
            {...form.getInputProps('embeddingModelKey')}
          />
        </FormField>
        <FormRow cols={2}>
          <FormField label="Vector provider" required>
            <Select
              placeholder={vectorProviders.length === 0 ? 'No vector providers found' : 'Select a vector provider'}
              data={vectorProviders.filter((p) => p.status === 'active').map((p) => ({ value: p.key, label: p.label }))}
              searchable
              {...form.getInputProps('vectorProviderKey')}
              onChange={(val) => {
                form.setFieldValue('vectorProviderKey', val ?? '');
                form.setFieldValue('vectorIndexKey', '');
              }}
            />
          </FormField>
          <FormField label="Vector index" required>
            <Select
              placeholder="Select an index"
              data={vectorIndexes.map((i) => ({ value: i.key, label: `${i.name} (${i.dimension}d)` }))}
              searchable
              disabled={!selectedProvider}
              {...form.getInputProps('vectorIndexKey')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={3} title="Chunking" done={validChunk}>
        <FormField label="Chunk strategy">
          <Select
            data={[
              { value: 'recursive_character', label: 'Recursive Character' },
              { value: 'token', label: 'Token Based' },
            ]}
            {...form.getInputProps('chunkStrategy')}
          />
        </FormField>
        <FormRow cols={2}>
          <FormField label="Chunk size" required>
            <NumberInput min={50} max={10000} step={100} {...form.getInputProps('chunkSize')} />
          </FormField>
          <FormField label="Chunk overlap" required>
            <NumberInput min={0} max={5000} step={50} {...form.getInputProps('chunkOverlap')} />
          </FormField>
        </FormRow>

        {v.chunkStrategy === 'recursive_character' && (
          <FormField label="Separators" hint="Use \\n for newline. Order matters — first separator tried first.">
            <TagsInput placeholder="Add separator..." {...form.getInputProps('separators')} />
          </FormField>
        )}

        {v.chunkStrategy === 'token' && (
          <FormField label="Token encoding">
            <Select
              data={[
                { value: 'cl100k_base', label: 'cl100k_base (GPT-4, GPT-3.5)' },
                { value: 'p50k_base', label: 'p50k_base (Codex, text-davinci)' },
                { value: 'o200k_base', label: 'o200k_base (GPT-4o)' },
              ]}
              {...form.getInputProps('encoding')}
            />
          </FormField>
        )}
      </FormSection>

      <FormSection number={4} title="Reranking">
        <FormRow cols={2}>
          <FormField label="Reranker" hint="Optional. Re-orders vector matches before returning.">
            <Select
              placeholder="None — use vector ranking only"
              data={[{ value: '', label: 'None' }, ...rerankers.map((r) => ({ value: r.key, label: r.name }))]}
              searchable
              clearable
              {...form.getInputProps('rerankerKey')}
            />
          </FormField>
          <FormField label="Oversample multiplier" hint="When a reranker is set, fetch topK × N candidates. Default: 3.">
            <NumberInput min={1} max={20} step={1} disabled={!v.rerankerKey} {...form.getInputProps('rerankerOversample')} />
          </FormField>
        </FormRow>
        <Text size="xs" c="dimmed">
          Changing the embedding model or vector index does not automatically re-embed existing documents. Re-ingest documents after saving to apply the new configuration.
        </Text>
      </FormSection>
    </FormShell>
  );
}
