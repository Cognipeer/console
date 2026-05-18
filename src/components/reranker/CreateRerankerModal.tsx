'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NumberInput,
  Select,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconArrowsSort, IconCheck } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';

type Strategy = 'dedicated-model' | 'llm-judge' | 'llm-listwise' | 'heuristic';

const STRATEGY_LABEL: Record<Strategy, string> = {
  'dedicated-model': 'Dedicated rerank model',
  'llm-judge': 'LLM judge (per-doc scoring)',
  'llm-listwise': 'LLM listwise (RankGPT)',
  heuristic: 'Heuristic (no model)',
};

interface ModelOption {
  key: string;
  name: string;
  category: string;
}

interface CreateRerankerModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (reranker: Record<string, unknown>) => void;
}

interface FormValues {
  name: string;
  description: string;
  strategy: Strategy;
  modelKey: string;
  topN: number | '';
  scoreThreshold: number | '';
  batchSize: number | '';
  temperature: number | '';
  scoreNormalization: 'none' | 'minmax';
  promptTemplate: string;
}

export default function CreateRerankerModal({
  opened,
  onClose,
  onCreated,
}: CreateRerankerModalProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      strategy: 'dedicated-model',
      modelKey: '',
      topN: 5,
      scoreThreshold: '',
      batchSize: 4,
      temperature: 0,
      scoreNormalization: 'none',
      promptTemplate: '',
    },
    validate: {
      name: (v) => (!v ? 'Name is required' : null),
      modelKey: (v, values) =>
        values.strategy !== 'heuristic' && !v ? 'Model is required for this strategy' : null,
    },
  });

  const needsModel = form.values.strategy !== 'heuristic';
  const modelCategoryForStrategy: Record<Strategy, string> = {
    'dedicated-model': 'rerank',
    'llm-judge': 'llm',
    'llm-listwise': 'llm',
    heuristic: '',
  };
  const requiredCategory = modelCategoryForStrategy[form.values.strategy];

  const loadModels = useCallback(async () => {
    if (!requiredCategory) {
      setModels([]);
      return;
    }
    try {
      const res = await fetch(`/api/models?category=${requiredCategory}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModels(
          (data.models ?? []).map((m: Record<string, string>) => ({
            key: m.key,
            name: m.name,
            category: m.category,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load models', err);
    }
  }, [requiredCategory]);

  useEffect(() => {
    if (opened) void loadModels();
  }, [opened, loadModels]);

  // Reset model selection when strategy changes if the model no longer matches.
  useEffect(() => {
    if (!needsModel) form.setFieldValue('modelKey', '');
    else if (
      form.values.modelKey
      && !models.some((m) => m.key === form.values.modelKey)
    ) {
      form.setFieldValue('modelKey', '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.strategy, models]);

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setSubmitting(true);
    try {
      const config: Record<string, unknown> = {};
      if (values.modelKey) config.modelKey = values.modelKey;
      if (values.topN !== '') config.topN = Number(values.topN);
      if (values.scoreThreshold !== '') config.scoreThreshold = Number(values.scoreThreshold);
      if (values.batchSize !== '' && values.strategy === 'llm-judge') {
        config.batchSize = Number(values.batchSize);
      }
      if (values.temperature !== '' && (values.strategy === 'llm-judge' || values.strategy === 'llm-listwise')) {
        config.temperature = Number(values.temperature);
      }
      if (values.scoreNormalization !== 'none') config.scoreNormalization = values.scoreNormalization;
      if (values.promptTemplate.trim()) config.promptTemplate = values.promptTemplate;

      const res = await fetch('/api/reranker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          strategy: values.strategy,
          config,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to create reranker');
      }
      const data = await res.json();
      notifications.show({
        color: 'green',
        title: 'Reranker created',
        message: `${values.name} is ready to use.`,
      });
      form.reset();
      onCreated(data.reranker);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to create reranker',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const selectedModel = useMemo(
    () => models.find((m) => m.key === form.values.modelKey),
    [models, form.values.modelKey],
  );

  const validIdentity = Boolean(form.values.name.trim());
  const validStrategy = !needsModel || Boolean(form.values.modelKey);

  const checklist = [
    { id: 1, label: 'Name provided', done: validIdentity },
    { id: 2, label: 'Strategy configured', done: validStrategy },
  ];

  const summary = (
    <>
      <SummaryGroup title="Reranker">
        <SummaryKV
          label="Name"
          value={form.values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV label="Strategy" value={STRATEGY_LABEL[form.values.strategy]} />
      </SummaryGroup>
      <SummaryGroup title="Backing model">
        <SummaryKV
          label="Model"
          value={selectedModel?.name || <span className="ds-faint">—</span>}
        />
      </SummaryGroup>
      <SummaryGroup title="Defaults">
        <SummaryKV
          label="topN"
          value={form.values.topN === '' ? <span className="ds-faint">—</span> : form.values.topN}
          mono
        />
        <SummaryKV
          label="Threshold"
          value={
            form.values.scoreThreshold === ''
              ? <span className="ds-faint">—</span>
              : form.values.scoreThreshold
          }
          mono
        />
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const canSubmit = validIdentity && validStrategy;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconArrowsSort size={16} />}
      title="Create reranker"
      subtitle="Configure a strategy and backing model to re-rank retrieval results."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create reranker',
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
        description="A human-readable name for this reranker."
        done={validIdentity}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput
              placeholder="My production reranker"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="What is this reranker used for?"
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Strategy"
        description="How candidate documents are re-scored."
        done={validStrategy}
      >
        <FormField label="Strategy">
          <ChipPicker<Strategy>
            options={[
              { value: 'dedicated-model', label: 'Dedicated rerank model' },
              { value: 'llm-judge', label: 'LLM judge' },
              { value: 'llm-listwise', label: 'LLM listwise' },
              { value: 'heuristic', label: 'Heuristic' },
            ]}
            value={form.values.strategy}
            onChange={(v) => form.setFieldValue('strategy', v as Strategy)}
          />
        </FormField>

        {needsModel ? (
          <FormField
            label="Backing model"
            required
            hint={
              form.values.strategy === 'dedicated-model'
                ? 'Pick a model with category "rerank" (Cohere, Jina, Voyage, BGE).'
                : 'Pick a chat LLM. Smaller/faster models work well as judges.'
            }
          >
            <Select
              placeholder={
                requiredCategory
                  ? `Select a ${requiredCategory} model`
                  : 'No model needed'
              }
              data={models.map((m) => ({ value: m.key, label: m.name }))}
              searchable
              {...form.getInputProps('modelKey')}
            />
          </FormField>
        ) : null}
      </FormSection>

      <FormSection
        number={3}
        title="Parameters"
        description="Defaults applied when this reranker is invoked."
      >
        <FormRow cols={2}>
          <FormField label="Default topN" optional>
            <NumberInput min={1} max={1000} step={1} {...form.getInputProps('topN')} />
          </FormField>
          <FormField label="Score threshold" optional>
            <NumberInput
              min={0}
              max={1}
              step={0.05}
              decimalScale={3}
              placeholder="0.0 – 1.0"
              {...form.getInputProps('scoreThreshold')}
            />
          </FormField>
        </FormRow>

        {form.values.strategy === 'llm-judge' ? (
          <FormRow cols={2}>
            <FormField label="Batch size" optional>
              <NumberInput min={1} max={32} step={1} {...form.getInputProps('batchSize')} />
            </FormField>
            <FormField label="Temperature" optional>
              <NumberInput
                min={0}
                max={2}
                step={0.1}
                decimalScale={2}
                {...form.getInputProps('temperature')}
              />
            </FormField>
          </FormRow>
        ) : null}

        {form.values.strategy === 'llm-listwise' ? (
          <FormField label="Temperature" optional>
            <NumberInput
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              {...form.getInputProps('temperature')}
            />
          </FormField>
        ) : null}

        {form.values.strategy === 'llm-judge' || form.values.strategy === 'llm-listwise' ? (
          <FormField
            label="Prompt template"
            optional
            hint="Use {{query}} and {{document}} placeholders. Leave empty to use the default."
          >
            <Textarea
              minRows={5}
              autosize
              placeholder="Custom prompt template (optional)…"
              {...form.getInputProps('promptTemplate')}
            />
          </FormField>
        ) : null}

        <FormField label="Score normalization" optional>
          <Select
            data={[
              { value: 'none', label: 'None (use raw scores)' },
              { value: 'minmax', label: 'Min–max rescale to [0, 1]' },
            ]}
            {...form.getInputProps('scoreNormalization')}
          />
        </FormField>
      </FormSection>
    </FormShell>
  );
}
