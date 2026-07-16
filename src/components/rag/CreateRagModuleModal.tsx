'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NumberInput,
  Select,
  TagsInput,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBook, IconCheck } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
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
  providerKey: string;
  dimension: number;
}

interface RerankerOption {
  key: string;
  name: string;
}

interface CreateRagModuleModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (ragModule: Record<string, unknown>) => void;
}

type ChunkStrategy = 'recursive_character' | 'token';

interface FormValues {
  name: string;
  description: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  chunkStrategy: ChunkStrategy;
  chunkSize: number | '';
  chunkOverlap: number | '';
  separators: string[];
  rerankerKey: string;
  rerankerOversample: number | '';
}

export default function CreateRagModuleModal({ opened, onClose, onCreated }: CreateRagModuleModalProps) {
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [vectorProviders, setVectorProviders] = useState<VectorProvider[]>([]);
  const [vectorIndexes, setVectorIndexes] = useState<VectorIndex[]>([]);
  const [rerankers, setRerankers] = useState<RerankerOption[]>([]);
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
      rerankerKey: '',
      rerankerOversample: '',
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

  useEffect(() => {
    if (opened) {
      void loadEmbeddingModels();
      void loadVectorProviders();
      void loadRerankers();
    }
  }, [opened, loadEmbeddingModels, loadVectorProviders, loadRerankers]);

  useEffect(() => {
    void loadVectorIndexes();
  }, [loadVectorIndexes]);

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

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
          rerankerKey: values.rerankerKey ? values.rerankerKey : undefined,
          rerankerOversample:
            values.rerankerKey && values.rerankerOversample !== ''
              ? Number(values.rerankerOversample)
              : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to create Knowledge Engine module');
      }

      const data = await res.json();
      notifications.show({
        color: 'green',
        title: 'Knowledge Engine Module Created',
        message: `${values.name} has been created successfully.`,
      });
      form.reset();
      onCreated(data.module);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Failed to create Knowledge Engine module',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const selectedEmbedding = useMemo(
    () => embeddingModels.find((m) => m.key === form.values.embeddingModelKey),
    [embeddingModels, form.values.embeddingModelKey],
  );
  const selectedVectorProvider = useMemo(
    () => vectorProviders.find((p) => p.key === form.values.vectorProviderKey),
    [vectorProviders, form.values.vectorProviderKey],
  );
  const selectedVectorIndex = useMemo(
    () => vectorIndexes.find((i) => i.key === form.values.vectorIndexKey),
    [vectorIndexes, form.values.vectorIndexKey],
  );
  const selectedReranker = useMemo(
    () => rerankers.find((r) => r.key === form.values.rerankerKey),
    [rerankers, form.values.rerankerKey],
  );

  const validIdentity = Boolean(form.values.name.trim());
  const validEmbedding = Boolean(form.values.embeddingModelKey);
  const validVector = Boolean(
    form.values.vectorProviderKey && form.values.vectorIndexKey,
  );
  const validChunking =
    form.values.chunkSize !== '' &&
    Number(form.values.chunkSize) > 0 &&
    form.values.chunkOverlap !== '' &&
    Number(form.values.chunkOverlap) >= 0;

  const checklist = [
    { id: 1, label: 'Name provided', done: validIdentity },
    { id: 2, label: 'Embedding model selected', done: validEmbedding },
    { id: 3, label: 'Vector index selected', done: validVector },
    { id: 4, label: 'Chunking configured', done: validChunking },
  ];

  const chunkStrategyLabel: Record<ChunkStrategy, string> = {
    recursive_character: 'Recursive character',
    token: 'Token based',
  };

  const summary = (
    <>
      <SummaryGroup title="Module">
        <SummaryKV
          label="Name"
          value={form.values.name || <span className="ds-faint">—</span>}
        />
      </SummaryGroup>

      <SummaryGroup title="Embedding">
        <SummaryKV
          label="Model"
          value={selectedEmbedding?.name || <span className="ds-faint">—</span>}
        />
      </SummaryGroup>

      <SummaryGroup title="Vector index">
        <SummaryKV
          label="Provider"
          value={selectedVectorProvider?.label || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Index"
          value={selectedVectorIndex?.name || <span className="ds-faint">—</span>}
        />
        {selectedVectorIndex ? (
          <SummaryKV
            label="Dimensions"
            value={`${selectedVectorIndex.dimension}d`}
            mono
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Chunking">
        <SummaryKV
          label="Strategy"
          value={chunkStrategyLabel[form.values.chunkStrategy]}
        />
        <SummaryKV
          label="Size"
          value={form.values.chunkSize || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="Overlap"
          value={
            form.values.chunkOverlap === ''
              ? <span className="ds-faint">—</span>
              : form.values.chunkOverlap
          }
          mono
        />
      </SummaryGroup>

      <SummaryGroup title="Reranking">
        <SummaryKV
          label="Reranker"
          value={
            selectedReranker?.name
            ?? <span className="ds-faint">none</span>
          }
        />
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const canSubmit =
    validIdentity && validEmbedding && validVector && validChunking;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBook size={16} />}
      title="Create Knowledge Engine module"
      subtitle="Configure embedding, vector storage, and chunking for a knowledge base."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create module',
        icon: <IconCheck size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="How this Knowledge Engine module is identified across the console."
        done={validIdentity}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput
              placeholder="My Knowledge Base"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="Describe what this Knowledge Engine module is for..."
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Embedding model"
        description="Used to turn document chunks into vectors."
        done={validEmbedding}
      >
        <FormField label="Embedding model" required>
          <Select
            placeholder="Select an embedding model"
            data={embeddingModels.map((m) => ({ value: m.key, label: m.name }))}
            searchable
            {...form.getInputProps('embeddingModelKey')}
          />
        </FormField>
      </FormSection>

      <FormSection
        number={3}
        title="Vector storage"
        description="Where the embeddings are stored and queried."
        done={validVector}
      >
        <FormRow cols={2}>
          <FormField label="Vector provider" required>
            <Select
              placeholder="Select a vector provider"
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
          </FormField>
          <FormField label="Vector index" required>
            <Select
              placeholder="Select an index"
              data={vectorIndexes.map((i) => ({
                value: i.key,
                label: `${i.name} (${i.dimension}d)`,
              }))}
              searchable
              disabled={!selectedProvider}
              {...form.getInputProps('vectorIndexKey')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={4}
        title="Chunking"
        description="How documents are split before embedding."
        done={validChunking}
      >
        <FormField label="Strategy">
          <ChipPicker<ChunkStrategy>
            options={[
              { value: 'recursive_character', label: 'Recursive character' },
              { value: 'token', label: 'Token based' },
            ]}
            value={form.values.chunkStrategy}
            onChange={(v) => form.setFieldValue('chunkStrategy', v as ChunkStrategy)}
          />
        </FormField>

        <FormRow cols={2}>
          <FormField label="Chunk size" required>
            <NumberInput
              min={50}
              max={10000}
              step={100}
              {...form.getInputProps('chunkSize')}
            />
          </FormField>
          <FormField label="Chunk overlap" required>
            <NumberInput
              min={0}
              max={5000}
              step={50}
              {...form.getInputProps('chunkOverlap')}
            />
          </FormField>
        </FormRow>

        {form.values.chunkStrategy === 'recursive_character' ? (
          <FormField
            label="Separators"
            hint="Use \n for newline. Order matters — first separator is tried first."
          >
            <TagsInput
              placeholder="Add separator..."
              {...form.getInputProps('separators')}
            />
          </FormField>
        ) : null}
      </FormSection>

      <FormSection
        number={5}
        title="Reranking"
        description="Optionally re-order vector matches with a reranker before they're returned."
      >
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
            <NumberInput
              min={1}
              max={20}
              step={1}
              disabled={!form.values.rerankerKey}
              {...form.getInputProps('rerankerOversample')}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
