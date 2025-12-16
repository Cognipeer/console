import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
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
import type { ModelProviderView } from '@/lib/services/models/types';
import type { IModel } from '@/lib/database';

const DEFAULT_PRICING = {
  currency: 'USD',
  inputTokenPer1M: 0,
  outputTokenPer1M: 0,
  cachedTokenPer1M: 0,
};

const CATEGORIES: Array<{ value: 'llm' | 'embedding'; label: string }> = [
  { value: 'llm', label: 'LLM' },
  { value: 'embedding', label: 'Embedding' },
];

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
  if (value === '' || value === undefined) {
    return undefined;
  }
  if (Number.isNaN(value)) {
    return undefined;
  }
  return value;
}

function resolveProviderCategories(provider?: ModelProviderView): ModelCategory[] {
  const raw = provider?.driverCapabilities?.[CAPABILITY_KEYS.categories];
  if (!Array.isArray(raw)) {
    return ['llm', 'embedding'];
  }
  return raw.filter((item): item is ModelCategory => item === 'llm' || item === 'embedding');
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
  const [availableProviders, setAvailableProviders] = useState<ModelProviderView[]>(providers);
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
    if (providers.length === 0) {
      return;
    }

    const currentKey = formValues.providerKey;
    const hasCurrentProvider = providers.some((provider) => provider.key === currentKey);
    if (!currentKey || !hasCurrentProvider) {
      setFieldValue('providerKey', providers[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, formValues.providerKey]);

  useEffect(() => {
    if (!opened) {
      if (wasOpenedRef.current) {
        reset();
        setAvailableProviders(providers);
        setFieldValue('providerKey', providers[0]?.key ?? '');
        wasOpenedRef.current = false;
      }
    } else {
      wasOpenedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, providers]);

  const providerOptions = useMemo(
    () =>
      availableProviders.map((provider) => ({
        value: provider.key,
        label: provider.label,
        disabled: provider.status === 'disabled',
      })),
    [availableProviders],
  );

  const selectedProvider = useMemo(
    () => availableProviders.find((provider) => provider.key === formValues.providerKey),
    [availableProviders, formValues.providerKey],
  );

  const allowedCategories = useMemo(
    () => resolveProviderCategories(selectedProvider),
    [selectedProvider],
  );

  useEffect(() => {
    if (!selectedProvider) {
      return;
    }

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

  const handleSubmit = form.onSubmit(async (values) => {
    if (!values.providerKey) {
      form.validateField('providerKey');
      return;
    }

    const provider = availableProviders.find((item) => item.key === values.providerKey);
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
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
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
  });

  return (
    <>
      <Modal opened={opened} onClose={onClose} title="Create Model" size="lg">
        <form onSubmit={handleSubmit}>
          <Stack gap="lg">
            <Text size="sm" c="dimmed">
              Models define the AI capabilities available to your applications. Each model is backed by a provider that handles the actual inference.
            </Text>

            <Stack gap="sm">
              <Group align="flex-end" gap="xs">
                <Select
                  label="Provider"
                  placeholder="Select a model provider"
                  data={providerOptions}
                  value={formValues.providerKey}
                  onChange={(value) => {
                    const nextKey = value ?? '';
                    setFieldValue('providerKey', nextKey);
                  }}
                  searchable
                  withAsterisk
                  style={{ flex: 1 }}
                />
              </Group>
              <Text size="xs" c="dimmed">
                Need a new model provider? Ask a tenant admin to add one in Tenant Settings.
              </Text>
            </Stack>

            {availableProviders.length === 0 ? (
              <Card withBorder padding="md">
                <Stack gap="xs">
                  <Text size="sm" c="dimmed">
                    No model providers configured yet. Ask a tenant admin to add one in Tenant Settings.
                  </Text>
                </Stack>
              </Card>
            ) : null}

            {selectedProvider && (
              <Card withBorder radius="md" padding="md">
                <Stack gap={6}>
                  <Group gap="xs">
                    <Text fw={600}>{selectedProvider.label}</Text>
                    <Badge
                      color={selectedProvider.status === 'active' ? 'green' : 'yellow'}
                      size="sm"
                    >
                      {selectedProvider.status}
                    </Badge>
                  </Group>
                  {selectedProvider.description && (
                    <Text size="sm" c="dimmed">
                      {selectedProvider.description}
                    </Text>
                  )}
                  <Text size="xs" c="dimmed">
                    Driver: {selectedProvider.driver}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Key: {selectedProvider.key}
                  </Text>
                </Stack>
              </Card>
            )}

            <Stack gap="md">
              <Text fw={500}>Model configuration</Text>
              <TextInput label="Name" placeholder="Friendly model name" required {...form.getInputProps('name')} />
              <TextInput
                label="Key"
                placeholder="optional-model-key"
                description="Leave blank to generate automatically."
                {...form.getInputProps('key')}
              />
              <Textarea
                label="Description"
                placeholder="Optional description"
                autosize
                minRows={2}
                {...form.getInputProps('description')}
              />
              <TextInput label="Model ID" placeholder="gpt-4o-mini" required {...form.getInputProps('modelId')} />

              <Select
                label="Category"
                data={CATEGORIES.filter((option) => allowedCategories.includes(option.value))}
                value={formValues.category}
                onChange={(value) => setFieldValue('category', (value as ModelCategory) ?? 'llm')}
                required
              />

              <Group align="center">
                <Checkbox
                  label="Supports tool calls"
                  {...form.getInputProps('supportsToolCalls', { type: 'checkbox' })}
                  disabled={!providerSupportsToolCalls(selectedProvider)}
                />
                <Checkbox
                  label="Multimodal"
                  {...form.getInputProps('isMultimodal', { type: 'checkbox' })}
                  disabled={!providerSupportsMultimodal(selectedProvider)}
                />
              </Group>
            </Stack>

            <Stack gap="md">
              <Text fw={500}>Pricing</Text>
              <Group grow>
                <TextInput
                  label="Currency"
                  placeholder="USD"
                  {...form.getInputProps('pricing.currency')}
                />
                <NumberInput
                  label="Prompt price (per 1M)"
                  min={0}
                  {...form.getInputProps('pricing.inputTokenPer1M')}
                />
              </Group>
              <Group grow>
                <NumberInput
                  label="Completion price (per 1M)"
                  min={0}
                  {...form.getInputProps('pricing.outputTokenPer1M')}
                />
                <NumberInput
                  label="Cached price (per 1M)"
                  min={0}
                  {...form.getInputProps('pricing.cachedTokenPer1M')}
                />
              </Group>
            </Stack>

            <Stack gap="md">
              <Text fw={500}>Default settings</Text>
              <Group grow>
                <NumberInput
                  label="Temperature"
                  min={0}
                  max={2}
                  step={0.1}
                  placeholder="Optional"
                  {...form.getInputProps('settings.temperature')}
                />
                <NumberInput
                  label="Max tokens"
                  min={1}
                  placeholder="Optional"
                  {...form.getInputProps('settings.maxTokens')}
                />
              </Group>
            </Stack>

            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={submitting} disabled={availableProviders.length === 0}>
                Create Model
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
