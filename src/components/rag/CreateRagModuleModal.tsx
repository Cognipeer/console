'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NumberInput,
  Select,
  Slider,
  TagsInput,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBook, IconCheck } from '@tabler/icons-react';
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
  DEFAULT_CHUNK_FORM_VALUES,
  DEFAULT_RETRIEVAL_FORM_VALUES,
  buildChunkConfig,
  buildHybrid,
  chunkFieldErrors,
  clearedValue,
  hasChunkFieldErrors,
  providerSupportsHybrid,
  type ChunkFormValues,
  type RetrievalFormValues,
} from './ragModuleForm';

const MODE = 'create';

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
      chunk: { ...DEFAULT_CHUNK_FORM_VALUES },
      retrieval: { ...DEFAULT_RETRIEVAL_FORM_VALUES },
      rerankerKey: '',
      rerankerOversample: '',
      defaultTopK: 5,
      defaultMinScore: 0.5,
      defaultFilter: '',
      filterableFields: [],
      responseDetail: 'full',
    },
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

  const hybridSupported = providerSupportsHybrid(selectedVectorProvider?.driverCapabilities);

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors || hasChunkFieldErrors(chunkErrors)) return;
    const values = form.getValues();

    setSubmitting(true);
    try {
      const res = await fetch('/api/rag/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || clearedValue(MODE),
          embeddingModelKey: values.embeddingModelKey,
          vectorProviderKey: values.vectorProviderKey,
          vectorIndexKey: values.vectorIndexKey,
          chunkConfig: buildChunkConfig(values.chunk),
          hybrid: hybridSupported ? buildHybrid(values.retrieval) : { enabled: false },
          // The tri-state only ever holds null on the edit screen, where an
          // existing module can predate the flag. A new module always states it.
          isolateByModule: values.retrieval.isolateByModule ?? undefined,
          rerankerKey: values.rerankerKey || clearedValue(MODE),
          rerankerOversample:
            values.rerankerKey && values.rerankerOversample !== ''
              ? Number(values.rerankerOversample)
              : clearedValue(MODE),
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

  const validIdentity = Boolean(form.values.name.trim());
  const validEmbedding = Boolean(form.values.embeddingModelKey);
  const validVector = Boolean(
    form.values.vectorProviderKey && form.values.vectorIndexKey,
  );
  const validChunking = !hasChunkFieldErrors(chunkErrors);

  const checklist = [
    { id: 1, label: 'Name provided', done: validIdentity },
    { id: 2, label: 'Embedding model selected', done: validEmbedding },
    { id: 3, label: 'Vector index selected', done: validVector },
    { id: 4, label: 'Chunking configured', done: validChunking },
  ];

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
        <SummaryKV label="Strategy" value={CHUNK_STRATEGIES[form.values.chunk.strategy].label} />
        <SummaryKV
          label="Size"
          value={form.values.chunk.chunkSize || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="Overlap"
          value={
            form.values.chunk.chunkOverlap === ''
              ? <span className="ds-faint">—</span>
              : form.values.chunk.chunkOverlap
          }
          mono
        />
        <SummaryKV
          label="Parent window"
          value={
            form.values.chunk.parentWindowSize === ''
              ? <span className="ds-faint">off</span>
              : form.values.chunk.parentWindowSize
          }
          mono
        />
        <SummaryKV
          label="Contextual headers"
          value={
            form.values.chunk.contextualHeaderEnabled
              ? 'on — one model call per chunk'
              : <span className="ds-faint">off</span>
          }
        />
      </SummaryGroup>

      <SummaryGroup title="Retrieval">
        <SummaryKV
          label="Hybrid"
          value={
            hybridSupported && form.values.retrieval.hybridEnabled
              ? form.values.retrieval.hybridMode
              : <span className="ds-faint">off</span>
          }
        />
        <SummaryKV
          label="Isolation"
          value={form.values.retrieval.isolateByModule ? 'on' : <span className="ds-faint">off</span>}
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

      <SummaryGroup title="Query defaults">
        <SummaryKV
          label="Top K"
          value={form.values.defaultTopK || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV label="Min score" value={form.values.defaultMinScore.toFixed(2)} mono />
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
        <ChunkConfigFields
          values={form.values.chunk}
          onChange={patchChunk}
          errors={chunkErrors}
        />
      </FormSection>

      <FormSection
        number={5}
        title="Retrieval"
        description="How a query reaches the stored vectors."
      >
        <RetrievalFields
          values={form.values.retrieval}
          onChange={patchRetrieval}
          hybridSupported={hybridSupported}
          providerLabel={selectedVectorProvider?.label}
        />
      </FormSection>

      <FormSection
        number={6}
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

      <FormSection
        number={7}
        title="Query defaults"
        description="Applied whenever a query doesn't explicitly override these."
      >
        <FormRow cols={2}>
          <FormField label="Top K" required hint="How many chunks a query returns by default.">
            <NumberInput
              min={1}
              max={100}
              step={1}
              {...form.getInputProps('defaultTopK')}
            />
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
              label={(v) => v.toFixed(2)}
              value={form.values.defaultMinScore}
              onChange={(v) => form.setFieldValue('defaultMinScore', v)}
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
