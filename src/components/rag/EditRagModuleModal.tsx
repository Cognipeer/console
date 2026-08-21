'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  NumberInput,
  Select,
  Slider,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconBook } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import ChunkConfigFields from './ChunkConfigFields';
import RetrievalFields from './RetrievalFields';
import {
  CHUNK_STRATEGIES,
  buildChunkConfig,
  buildHybrid,
  chunkConfigRequiresReindex,
  chunkFieldErrors,
  chunkFormValues,
  clearedValue,
  hasChunkFieldErrors,
  providerSupportsHybrid,
  retrievalFormValues,
  type ChunkFormValues,
  type HybridMode,
  type RetrievalFormValues,
} from './ragModuleForm';
import type { IRagChunkConfig } from '@/lib/database';

const MODE = 'update';

interface EmbeddingModel {
  key: string;
  name: string;
}

interface VectorProvider {
  key: string;
  label: string;
  status: string;
  driverCapabilities?: Record<string, unknown>;
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
  chunkConfig: IRagChunkConfig;
  hybrid?: { enabled: boolean; mode?: HybridMode; alpha?: number; k?: number } | null;
  isolateByModule?: boolean | null;
  rerankerKey?: string | null;
  rerankerOversample?: number | null;
  defaultTopK?: number | null;
  defaultMinScore?: number | null;
  defaultFilter?: Record<string, unknown> | null;
  filterableFields?: string[] | null;
  responseDetail?: 'full' | 'text' | null;
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
  chunk: ChunkFormValues;
  retrieval: RetrievalFormValues;
  rerankerKey: string;
  rerankerOversample: number | '';
  defaultTopK: number | '';
  defaultMinScore: number;
  defaultFilter: string;
  filterableFields: string[];
  responseDetail: 'full' | 'text';
}

function formValuesFromModule(module: RagModuleData): FormValues {
  return {
    name: module.name,
    description: module.description ?? '',
    embeddingModelKey: module.embeddingModelKey,
    vectorProviderKey: module.vectorProviderKey,
    vectorIndexKey: module.vectorIndexKey,
    chunk: chunkFormValues(module.chunkConfig),
    retrieval: retrievalFormValues(module),
    rerankerKey: module.rerankerKey ?? '',
    rerankerOversample: module.rerankerOversample ?? '',
    defaultTopK: module.defaultTopK ?? 5,
    defaultMinScore: module.defaultMinScore ?? 0.5,
    defaultFilter: module.defaultFilter ? JSON.stringify(module.defaultFilter, null, 2) : '',
    filterableFields: module.filterableFields ?? [],
    responseDetail: module.responseDetail ?? 'full',
  };
}

export default function EditRagModuleModal({ opened, onClose, module, onUpdated }: EditRagModuleModalProps) {
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [vectorProviders, setVectorProviders] = useState<VectorProvider[]>([]);
  const [vectorIndexes, setVectorIndexes] = useState<VectorIndex[]>([]);
  const [rerankers, setRerankers] = useState<RerankerOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FormValues>({
    initialValues: formValuesFromModule(module),
    validate: {
      name: (v) => (!v ? 'Name is required' : null),
      embeddingModelKey: (v) => (!v ? 'Embedding model is required' : null),
      vectorProviderKey: (v) => (!v ? 'Vector provider is required' : null),
      vectorIndexKey: (v) => (!v ? 'Vector index is required' : null),
      defaultTopK: (v) => (v === '' || Number(v) < 1 ? 'Must be at least 1' : null),
      defaultFilter: (v) => {
        if (!v.trim()) return null;
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return 'Filter must be a JSON object';
          }
          return null;
        } catch {
          return 'Filter must be valid JSON';
        }
      },
    },
  });

  const selectedProvider = form.values.vectorProviderKey;
  const chunkErrors = chunkFieldErrors(form.values.chunk);

  const patchChunk = (patch: Partial<ChunkFormValues>) =>
    form.setFieldValue('chunk', { ...form.getValues().chunk, ...patch });

  const patchRetrieval = (patch: Partial<RetrievalFormValues>) =>
    form.setFieldValue('retrieval', { ...form.getValues().retrieval, ...patch });

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
        setVectorProviders((data.providers ?? []).map((p: Record<string, unknown>) => ({
          key: p.key as string,
          label: (p.label as string) || (p.key as string),
          status: p.status as string,
          driverCapabilities: p.driverCapabilities as Record<string, unknown> | undefined,
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
      form.setValues(formValuesFromModule(module));
      void loadEmbeddingModels();
      void loadVectorProviders();
      void loadRerankers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  useEffect(() => {
    void loadVectorIndexes();
  }, [loadVectorIndexes]);

  const selectedVectorProvider = useMemo(
    () => vectorProviders.find((p) => p.key === form.values.vectorProviderKey),
    [vectorProviders, form.values.vectorProviderKey],
  );
  const hybridSupported = providerSupportsHybrid(selectedVectorProvider?.driverCapabilities);

  // Both of these invalidate every stored vector, so the module is marked
  // reindexRequired and a re-index run is enqueued the moment this form saves.
  // Say so here rather than surprising the user with it afterwards.
  const chunkingChanged = chunkConfigRequiresReindex(
    buildChunkConfig(form.values.chunk),
    buildChunkConfig(chunkFormValues(module.chunkConfig)),
  );
  const embeddingChanged = form.values.embeddingModelKey !== module.embeddingModelKey;
  const reindexWarning = chunkingChanged || embeddingChanged ? (
    <Alert
      color="yellow"
      variant="light"
      icon={<IconAlertTriangle size={16} />}
      title="Saving this starts a re-index"
    >
      <Text size="sm">
        {chunkingChanged && embeddingChanged
          ? 'The chunking configuration and the embedding model both changed.'
          : chunkingChanged
            ? 'The chunking configuration changed.'
            : 'The embedding model changed.'}
        {' '}
        Every document in this module is re-chunked and re-embedded in the background.
        Queries keep answering from the current vectors until the run finishes.
      </Text>
    </Alert>
  ) : null;

  const handleSubmit = form.onSubmit(async (values) => {
    if (hasChunkFieldErrors(chunkErrors)) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(module.key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || clearedValue(MODE),
          embeddingModelKey: values.embeddingModelKey,
          vectorProviderKey: values.vectorProviderKey,
          vectorIndexKey: values.vectorIndexKey,
          chunkConfig: buildChunkConfig(values.chunk),
          hybrid: hybridSupported ? buildHybrid(values.retrieval) : { enabled: false },
          isolateByModule: values.retrieval.isolateByModule,
          rerankerKey: values.rerankerKey || clearedValue(MODE),
          rerankerOversample:
            values.rerankerOversample === ''
              ? clearedValue(MODE)
              : Number(values.rerankerOversample),
          defaultTopK: values.defaultTopK === '' ? clearedValue(MODE) : Number(values.defaultTopK),
          defaultMinScore: values.defaultMinScore,
          defaultFilter: values.defaultFilter.trim()
            ? (JSON.parse(values.defaultFilter) as Record<string, unknown>)
            : clearedValue(MODE),
          filterableFields:
            values.filterableFields.length > 0 ? values.filterableFields : clearedValue(MODE),
          responseDetail: values.responseDetail,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to update Knowledge Engine module');
      }

      const data = await res.json();
      notifications.show({
        color: 'green',
        title: 'Knowledge Engine Module Updated',
        message: chunkingChanged || embeddingChanged
          ? `${values.name} updated — re-indexing its documents in the background.`
          : `${values.name} has been updated successfully.`,
      });
      onUpdated(data.module);
      onClose();
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Failed to update Knowledge Engine module',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  });

  const v = form.values;
  const validIdentity = Boolean(v.name);
  const validStore = Boolean(v.embeddingModelKey && v.vectorProviderKey && v.vectorIndexKey);
  const validChunk = !hasChunkFieldErrors(chunkErrors);
  const canSubmit = validIdentity && validStore && validChunk;

  const checklist = [
    { id: 'name', label: 'Name provided', done: validIdentity },
    { id: 'store', label: 'Embedding + vector index set', done: validStore },
    { id: 'chunk', label: 'Chunking configured', done: validChunk },
  ];

  const summary = (
    <SummaryGroup title="Knowledge Engine module">
      <SummaryKV label="Key" value={module.key} mono />
      <SummaryKV label="Name" value={v.name || '—'} />
      <SummaryKV label="Embedding" value={v.embeddingModelKey || '—'} />
      <SummaryKV label="Index" value={v.vectorIndexKey || '—'} />
      <SummaryKV label="Strategy" value={CHUNK_STRATEGIES[v.chunk.strategy].label} />
      <SummaryKV label="Chunk" value={v.chunk.chunkSize ? `${v.chunk.chunkSize} / ${v.chunk.chunkOverlap}` : '—'} />
      <SummaryKV
        label="Parent window"
        value={v.chunk.parentWindowSize === '' ? 'off' : v.chunk.parentWindowSize}
        mono
      />
      <SummaryKV
        label="Hybrid"
        value={hybridSupported && v.retrieval.hybridEnabled ? v.retrieval.hybridMode : 'off'}
      />
      <SummaryKV label="Isolation" value={v.retrieval.isolateByModule ? 'on' : 'off'} />
      <SummaryKV label="Reranker" value={v.rerankerKey || 'none'} />
      <SummaryKV label="Default Top K" value={v.defaultTopK || '—'} mono />
      <SummaryKV label="Default min score" value={v.defaultMinScore.toFixed(2)} mono />
      <SummaryKV
        label="Re-index"
        value={chunkingChanged || embeddingChanged ? 'required on save' : 'not needed'}
      />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBook size={16} />}
      title="Edit Knowledge Engine module"
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
            <Textarea placeholder="Describe what this Knowledge Engine module is for..." rows={2} {...form.getInputProps('description')} />
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
        <ChunkConfigFields
          values={v.chunk}
          onChange={patchChunk}
          errors={chunkErrors}
          notice={reindexWarning}
        />
      </FormSection>

      <FormSection number={4} title="Retrieval" description="How a query reaches the stored vectors.">
        <RetrievalFields
          values={v.retrieval}
          onChange={patchRetrieval}
          hybridSupported={hybridSupported}
          providerLabel={selectedVectorProvider?.label}
        />
      </FormSection>

      <FormSection number={5} title="Reranking">
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
      </FormSection>

      <FormSection number={6} title="Query defaults" description="Applied whenever a query doesn't explicitly override these.">
        <FormRow cols={2}>
          <FormField label="Top K" required hint="How many chunks a query returns by default.">
            <NumberInput min={1} max={100} step={1} {...form.getInputProps('defaultTopK')} />
          </FormField>
          <FormField label="Min score" hint="Matches below this similarity score are discarded.">
            <Slider
              min={0}
              max={1}
              step={0.05}
              marks={[
                { value: 0, label: '0' },
                { value: 0.5, label: '0.5' },
                { value: 1, label: '1' },
              ]}
              label={(val) => val.toFixed(2)}
              value={v.defaultMinScore}
              onChange={(val) => form.setFieldValue('defaultMinScore', val)}
            />
          </FormField>
        </FormRow>
        <FormField
          label="Default metadata filter (JSON)"
          hint="ANDed into every query. Lets several sources share one vector index while this module retrieves only its own slice."
        >
          <Textarea
            placeholder='{ "source": "crawler" }'
            minRows={2}
            autosize
            {...form.getInputProps('defaultFilter')}
          />
        </FormField>
        <FormField
          label="Filterable fields"
          hint="Metadata keys callers may filter on. Leave empty to allow any key. Also shown to agents and MCP clients so they know what is filterable."
        >
          <TagsInput
            placeholder="source, depth, title…"
            {...form.getInputProps('filterableFields')}
          />
        </FormField>
        <FormRow cols={2}>
          <FormField
            label="Response detail"
            hint="What a query response carries. 'Text only' returns just the chunk text."
          >
            <Select
              data={[
                { value: 'full', label: 'Full — scores, ids and metadata' },
                { value: 'text', label: 'Text only — just the chunk text' },
              ]}
              allowDeselect={false}
              {...form.getInputProps('responseDetail')}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
