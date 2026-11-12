'use client';

import {
  Loader,
  NumberInput,
  Select,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBrain, IconPlus } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import { useCreateMemoryStore } from '@/lib/api/queries/memory';
import { useModelsByCategory } from '@/lib/api/queries/rag';
import { useVectorProviders } from '@/lib/api/queries/vector';

/** What `POST /api/memory/stores` answers with: the store. */
export interface CreatedMemoryStore {
  key: string;
  name: string;
  status?: string;
  [field: string]: unknown;
}

interface CreateMemoryStoreModalProps {
  opened: boolean;
  onClose: () => void;
  /** The created store, when the answer could be read (a caller that only reloads can ignore it). */
  onCreated: (store?: CreatedMemoryStore) => void;
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
  const providersQuery = useVectorProviders(opened);
  const modelsQuery = useModelsByCategory('embedding', opened);
  const createStore = useCreateMemoryStore();
  const vectorProviders = providersQuery.data ?? [];
  const embeddingModels = modelsQuery.data ?? [];
  const loadingProviders = providersQuery.isLoading;
  const loadingModels = modelsQuery.isLoading;
  const submitting = createStore.isPending;

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

  const { values: formValues, setFieldValue } = form;

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    try {
      const created = await createStore.mutateAsync({
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
      });
      form.reset();
      onCreated(created && typeof created.key === 'string' ? (created as CreatedMemoryStore) : undefined);
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: errorMessage(error, t('createError')),
        color: 'red',
      });
    }
  };

  const providerOptions = vectorProviders
    .filter((p) => p.status === 'active')
    .map((p) => ({
      value: p.key,
      label: p.label || p.key,
    }));

  const modelOptions = embeddingModels.map((m) => ({
    value: m.key,
    label: m.name || m.modelId || m.key,
  }));

  const validName = Boolean(formValues.name.trim());
  const validProvider = Boolean(formValues.vectorProviderKey);
  const validModel = Boolean(formValues.embeddingModelKey);
  const validRetrieval =
    formValues.defaultTopK > 0 &&
    formValues.defaultMinScore >= 0 &&
    formValues.defaultMinScore <= 1;

  const checklist = [
    { id: 1, label: 'Name set', done: validName },
    { id: 2, label: 'Vector provider selected', done: validProvider },
    { id: 3, label: 'Embedding model selected', done: validModel },
    { id: 4, label: 'Retrieval defaults valid', done: validRetrieval },
  ];

  const canSubmit = validName && validProvider && validModel && validRetrieval;

  const providerLabel =
    providerOptions.find((o) => o.value === formValues.vectorProviderKey)?.label;
  const modelLabel =
    modelOptions.find((o) => o.value === formValues.embeddingModelKey)?.label;

  const summary = (
    <>
      <SummaryGroup title="Store">
        <SummaryKV
          label="Name"
          value={formValues.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Provider"
          value={providerLabel || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="Embedding model"
          value={modelLabel || <span className="ds-faint">—</span>}
          mono
        />
      </SummaryGroup>

      <SummaryGroup title="Retrieval">
        <SummaryKV
          label="Top K"
          value={String(formValues.defaultTopK)}
          mono
        />
        <SummaryKV
          label="Min score"
          value={formValues.defaultMinScore.toFixed(2)}
          mono
        />
      </SummaryGroup>

      <SummaryGroup title="Behavior">
        <SummaryKV
          label="Deduplication"
          value={formValues.deduplication ? 'On' : 'Off'}
        />
        <SummaryKV
          label="Auto-embed"
          value={formValues.autoEmbed ? 'On' : 'Off'}
        />
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBrain size={16} />}
      title={t('createStore')}
      subtitle="Configure a vector-backed long-term memory store."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('create'),
        icon: <IconPlus size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: handleSubmit,
      }}
      secondaryAction={{
        label: t('cancel'),
        onClick: onClose,
        disabled: submitting,
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="How the memory store appears in dashboards and the SDK."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label={t('form.name')} required>
            <TextInput
              placeholder={t('form.namePlaceholder')}
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('form.description')} optional>
            <Textarea
              placeholder={t('form.descriptionPlaceholder')}
              autosize
              minRows={2}
              maxRows={4}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Backend"
        description="Choose where vectors are stored and which model produces embeddings."
        done={validProvider && validModel}
      >
        <FormRow cols={1}>
          <FormField
            label={t('form.vectorProvider')}
            required
            hint={
              loadingProviders && providerOptions.length === 0
                ? 'Loading providers...'
                : undefined
            }
          >
            <Select
              placeholder={t('form.vectorProviderPlaceholder')}
              data={providerOptions}
              rightSection={loadingProviders ? <Loader size={14} /> : undefined}
              searchable
              {...form.getInputProps('vectorProviderKey')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('form.embeddingModel')} required>
            <Select
              placeholder={t('form.embeddingModelPlaceholder')}
              data={modelOptions}
              rightSection={loadingModels ? <Loader size={14} /> : undefined}
              searchable
              {...form.getInputProps('embeddingModelKey')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={3}
        title="Retrieval defaults"
        description="Default search parameters used when callers don't override them."
        done={validRetrieval}
      >
        <FormRow cols={2}>
          <FormField label={t('form.defaultTopK')}>
            <NumberInput
              min={1}
              max={100}
              {...form.getInputProps('defaultTopK')}
            />
          </FormField>
          <FormField label={t('form.defaultMinScore')}>
            <NumberInput
              min={0}
              max={1}
              step={0.05}
              decimalScale={2}
              {...form.getInputProps('defaultMinScore')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={4}
        title="Behavior"
        description="Operational toggles for write paths."
        done
      >
        <ToggleList>
          <ToggleRow
            label={t('form.deduplication')}
            description={t('form.deduplicationDescription')}
            checked={formValues.deduplication}
            onChange={(v) => setFieldValue('deduplication', v)}
          />
          <ToggleRow
            label={t('form.autoEmbed')}
            description={t('form.autoEmbedDescription')}
            checked={formValues.autoEmbed}
            onChange={(v) => setFieldValue('autoEmbed', v)}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}
