import { useEffect, useMemo, useRef, useState } from 'react';
import { NumberInput, Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBolt, IconBrain } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import type { ModelProviderView } from '@/lib/services/models/types';
import type { IModel } from '@/lib/database';

const DEFAULT_PRICING = {
  currency: 'USD',
  inputTokenPer1M: 0,
  outputTokenPer1M: 0,
  cachedTokenPer1M: 0,
};

const CAPABILITY_KEYS = {
  categories: 'model.categories',
  toolCalls: 'model.supports.tool_calls',
  multimodal: 'model.supports.multimodal',
} as const;

type ModelCategory = 'llm' | 'embedding';

type CreateModelModalProps = {
  opened: boolean;
  onClose: () => void;
  providers: ModelProviderView[];
  onCreated: (options: { model: IModel; provider: ModelProviderView }) => void;
};

interface FormValues {
  providerKey: string;
  name: string;
  key: string;
  description: string;
  category: ModelCategory;
  modelId: string;
  isMultimodal: boolean;
  supportsToolCalls: boolean;
  pricing: {
    currency: string;
    inputTokenPer1M: number | '';
    outputTokenPer1M: number | '';
    cachedTokenPer1M: number | '';
  };
  settings: {
    temperature: number | '';
    maxTokens: number | '';
  };
}

function toNumber(value: number | '' | undefined): number | undefined {
  if (value === '' || value === undefined) return undefined;
  if (Number.isNaN(value)) return undefined;
  return value;
}

function resolveProviderCategories(provider?: ModelProviderView): ModelCategory[] {
  const raw = provider?.driverCapabilities?.[CAPABILITY_KEYS.categories];
  if (!Array.isArray(raw)) return ['llm', 'embedding'];
  return raw.filter(
    (item): item is ModelCategory => item === 'llm' || item === 'embedding',
  );
}

function providerSupportsToolCalls(provider?: ModelProviderView) {
  return Boolean(provider?.driverCapabilities?.[CAPABILITY_KEYS.toolCalls]);
}

function providerSupportsMultimodal(provider?: ModelProviderView) {
  return Boolean(provider?.driverCapabilities?.[CAPABILITY_KEYS.multimodal]);
}

export default function CreateModelModal({
  opened,
  onClose,
  providers,
  onCreated,
}: CreateModelModalProps) {
  const [availableProviders, setAvailableProviders] =
    useState<ModelProviderView[]>(providers);
  const [submitting, setSubmitting] = useState(false);
  const wasOpenedRef = useRef(false);

  const form = useForm<FormValues>({
    initialValues: {
      providerKey: providers[0]?.key ?? '',
      name: '',
      key: '',
      description: '',
      category: 'llm',
      modelId: '',
      isMultimodal: false,
      supportsToolCalls: true,
      pricing: {
        currency: DEFAULT_PRICING.currency,
        inputTokenPer1M: DEFAULT_PRICING.inputTokenPer1M,
        outputTokenPer1M: DEFAULT_PRICING.outputTokenPer1M,
        cachedTokenPer1M: DEFAULT_PRICING.cachedTokenPer1M,
      },
      settings: {
        temperature: '',
        maxTokens: '',
      },
    },
    validate: {
      providerKey: (value) => (!value ? 'Select a provider' : null),
      name: (value) => (!value ? 'Name is required' : null),
      modelId: (value) => (!value ? 'Model ID is required' : null),
      pricing: {
        inputTokenPer1M: (value: number | '') =>
          value === '' || value < 0 ? 'Must be a non-negative number' : null,
        outputTokenPer1M: (value: number | '') =>
          value === '' || value < 0 ? 'Must be a non-negative number' : null,
        cachedTokenPer1M: (value: number | '') =>
          value === '' || value < 0 ? 'Must be a non-negative number' : null,
      },
    },
  });

  const { values: formValues, setFieldValue, reset } = form;

  useEffect(() => {
    setAvailableProviders(providers);
    if (providers.length === 0) return;
    const currentKey = form.getValues().providerKey;
    const hasCurrentProvider = providers.some(
      (provider) => provider.key === currentKey,
    );
    if (!currentKey || !hasCurrentProvider) {
      setFieldValue('providerKey', providers[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  useEffect(() => {
    if (!opened) {
      if (wasOpenedRef.current) {
        reset();
        const firstKey = providers[0]?.key ?? '';
        if (firstKey) setFieldValue('providerKey', firstKey);
        wasOpenedRef.current = false;
      }
    } else {
      wasOpenedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, providers]);

  const selectedProvider = useMemo(
    () =>
      availableProviders.find((provider) => provider.key === formValues.providerKey),
    [availableProviders, formValues.providerKey],
  );

  const allowedCategories = useMemo(
    () => resolveProviderCategories(selectedProvider),
    [selectedProvider],
  );

  useEffect(() => {
    if (!selectedProvider) return;

    const categories = resolveProviderCategories(selectedProvider);
    if (categories.length && !categories.includes(formValues.category)) {
      setFieldValue('category', categories[0]);
    }

    const supportsTools = providerSupportsToolCalls(selectedProvider);
    if (formValues.supportsToolCalls !== supportsTools) {
      setFieldValue('supportsToolCalls', supportsTools);
    }

    const multimodal = providerSupportsMultimodal(selectedProvider);
    if (formValues.isMultimodal !== multimodal) {
      setFieldValue('isMultimodal', multimodal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedProvider,
    formValues.category,
    formValues.supportsToolCalls,
    formValues.isMultimodal,
  ]);

  const providerOptions = useMemo(
    () =>
      availableProviders.map((provider) => ({
        value: provider.key,
        label: provider.label,
        disabled: provider.status === 'disabled',
      })),
    [availableProviders],
  );

  const validProvider = Boolean(formValues.providerKey);
  const validIdentity = Boolean(formValues.name && formValues.modelId);
  const validPricing =
    formValues.pricing.inputTokenPer1M !== '' &&
    formValues.pricing.outputTokenPer1M !== '';

  const checklist = [
    { id: 1, label: 'Provider selected', done: validProvider },
    { id: 2, label: 'Display name and Model ID set', done: validIdentity },
    { id: 3, label: 'Pricing configured', done: validPricing },
    {
      id: 4,
      label: 'Category chosen',
      done: Boolean(formValues.category),
    },
  ];

  const submit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    const provider = availableProviders.find(
      (item) => item.key === values.providerKey,
    );
    if (!provider) {
      notifications.show({
        color: 'red',
        title: 'Provider not found',
        message: 'Select a valid provider before creating a model.',
      });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: values.providerKey,
          name: values.name,
          key: values.key,
          description: values.description,
          category: values.category,
          modelId: values.modelId,
          isMultimodal: values.isMultimodal,
          supportsToolCalls: values.supportsToolCalls,
          pricing: {
            currency: values.pricing.currency || DEFAULT_PRICING.currency,
            inputTokenPer1M: Number(values.pricing.inputTokenPer1M ?? 0),
            outputTokenPer1M: Number(values.pricing.outputTokenPer1M ?? 0),
            cachedTokenPer1M: Number(values.pricing.cachedTokenPer1M ?? 0),
          },
          settings: {
            ...(toNumber(values.settings.temperature) !== undefined
              ? { temperature: toNumber(values.settings.temperature) }
              : {}),
            ...(toNumber(values.settings.maxTokens) !== undefined
              ? { maxTokens: toNumber(values.settings.maxTokens) }
              : {}),
          },
        }),
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to create model');
      }

      const data = await response.json();
      notifications.show({
        color: 'green',
        title: 'Model created',
        message: `${values.name} is ready to use.`,
      });
      onCreated({ model: data.model, provider });
      onClose();
      reset();
    } catch (error: unknown) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to create model',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const summary = (
    <>
      <SummaryGroup title="Provider">
        {selectedProvider ? (
          <>
            <SummaryKV label="Name" value={selectedProvider.label} />
            <SummaryKV label="Driver" value={selectedProvider.driver} mono />
            <SummaryKV label="Status" value={selectedProvider.status} />
          </>
        ) : (
          <SummaryKV label="—" value="Select a provider" />
        )}
      </SummaryGroup>

      <SummaryGroup title="Model">
        <SummaryKV
          label="Display name"
          value={formValues.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Model ID"
          value={formValues.modelId || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV label="Category" value={formValues.category} />
        <SummaryKV
          label="Capabilities"
          value={
            [
              formValues.supportsToolCalls ? 'tools' : null,
              formValues.isMultimodal ? 'vision' : null,
            ]
              .filter(Boolean)
              .join(' · ') || '—'
          }
        />
      </SummaryGroup>

      <SummaryGroup title="Pricing">
        <SummaryKV
          label="Input / 1M"
          value={`${formValues.pricing.inputTokenPer1M || 0} ${formValues.pricing.currency || 'USD'}`}
          mono
        />
        <SummaryKV
          label="Output / 1M"
          value={`${formValues.pricing.outputTokenPer1M || 0} ${formValues.pricing.currency || 'USD'}`}
          mono
        />
        {formValues.pricing.cachedTokenPer1M ? (
          <SummaryKV
            label="Cached / 1M"
            value={`${formValues.pricing.cachedTokenPer1M} ${formValues.pricing.currency || 'USD'}`}
            mono
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const noProviders = availableProviders.length === 0;
  const canSubmit = !noProviders && validProvider && validIdentity && validPricing;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBrain size={16} />}
      title="Deploy model"
      subtitle="Add a new inference endpoint backed by a configured provider."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create model',
        icon: <IconBolt size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: submit,
      }}
    >
      <FormSection
        number={1}
        title="Provider"
        description="Pick the model provider that will serve this endpoint."
        done={validProvider}
      >
        {noProviders ? (
          <div
            className="ds-card ds-card-pad"
            style={{ background: 'var(--ds-surface-1)' }}
          >
            <span className="ds-muted" style={{ fontSize: 13 }}>
              No model providers configured yet. Ask a tenant admin to add one
              under Configure → Providers.
            </span>
          </div>
        ) : (
          <>
            <FormField label="Provider" required>
              <Select
                placeholder="Select a model provider"
                data={providerOptions}
                value={formValues.providerKey}
                onChange={(value) => setFieldValue('providerKey', value ?? '')}
                searchable
              />
            </FormField>
            {selectedProvider ? (
              <div
                className="ds-card ds-card-pad-sm"
                style={{ marginTop: 12, background: 'var(--ds-surface-1)' }}
              >
                <div className="ds-row ds-gap-sm" style={{ marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{selectedProvider.label}</span>
                  <span
                    className={`ds-badge ${selectedProvider.status === 'active' ? 'ds-badge-ok' : 'ds-badge-warn'}`}
                  >
                    {selectedProvider.status}
                  </span>
                </div>
                {selectedProvider.description ? (
                  <div
                    className="ds-muted"
                    style={{ fontSize: 12, marginBottom: 4 }}
                  >
                    {selectedProvider.description}
                  </div>
                ) : null}
                <div className="ds-faint" style={{ fontSize: 11.5 }}>
                  driver: <span className="ds-mono">{selectedProvider.driver}</span>{' '}
                  · key: <span className="ds-mono">{selectedProvider.key}</span>
                </div>
              </div>
            ) : null}
          </>
        )}
      </FormSection>

      <FormSection
        number={2}
        title="Identity"
        description="How this model is identified across the console and SDK."
        done={validIdentity}
      >
        <FormRow cols={2}>
          <FormField label="Display name" required>
            <TextInput
              placeholder="Friendly model name"
              {...form.getInputProps('name')}
            />
          </FormField>
          <FormField
            label="Key"
            hint="Leave blank to generate from the display name."
          >
            <TextInput
              placeholder="optional-model-key"
              {...form.getInputProps('key')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label="Model ID" required>
            <TextInput
              placeholder="gpt-4o-mini"
              {...form.getInputProps('modelId')}
            />
          </FormField>
          <FormField label="Category">
            <ChipPicker<ModelCategory>
              options={(
                [
                  { value: 'llm' as const, label: 'LLM' },
                  { value: 'embedding' as const, label: 'Embedding' },
                ] satisfies Array<{ value: ModelCategory; label: string }>
              ).filter((opt) => allowedCategories.includes(opt.value))}
              value={formValues.category}
              onChange={(v) => setFieldValue('category', v as ModelCategory)}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="Optional description"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={3}
        title="Capabilities"
        description="What this model supports — determined by the provider but can be overridden."
      >
        <ToggleList>
          <ToggleRow
            label="Supports tool calls"
            description="Allow the model to invoke registered tools via function calling."
            checked={formValues.supportsToolCalls}
            disabled={!providerSupportsToolCalls(selectedProvider)}
            onChange={(v) => setFieldValue('supportsToolCalls', v)}
          />
          <ToggleRow
            label="Multimodal (vision)"
            description="Model accepts image inputs in addition to text."
            checked={formValues.isMultimodal}
            disabled={!providerSupportsMultimodal(selectedProvider)}
            onChange={(v) => setFieldValue('isMultimodal', v)}
          />
        </ToggleList>
      </FormSection>

      <FormSection
        number={4}
        title="Pricing"
        description="Per-million-token pricing for accounting and routing decisions."
        done={validPricing}
      >
        <FormRow cols={2}>
          <FormField label="Currency">
            <TextInput
              placeholder="USD"
              {...form.getInputProps('pricing.currency')}
            />
          </FormField>
          <FormField label="Input · per 1M">
            <NumberInput
              min={0}
              decimalScale={4}
              {...form.getInputProps('pricing.inputTokenPer1M')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label="Output · per 1M">
            <NumberInput
              min={0}
              decimalScale={4}
              {...form.getInputProps('pricing.outputTokenPer1M')}
            />
          </FormField>
          <FormField label="Cached · per 1M" optional>
            <NumberInput
              min={0}
              decimalScale={4}
              {...form.getInputProps('pricing.cachedTokenPer1M')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={5}
        title="Default parameters"
        description="Used when callers don't specify their own. Can always be overridden per-request."
        done
      >
        <FormRow cols={2}>
          <FormField label="Temperature" optional>
            <NumberInput
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              placeholder="Optional"
              {...form.getInputProps('settings.temperature')}
            />
          </FormField>
          <FormField label="Max tokens" optional>
            <NumberInput
              min={1}
              placeholder="Optional"
              {...form.getInputProps('settings.maxTokens')}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
