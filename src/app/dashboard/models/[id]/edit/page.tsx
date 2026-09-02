'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Button,
  Card,
  Center,
  Checkbox,
  Badge,
  Grid,
  Group,
  JsonInput,
  Loader,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconBook,
  IconDeviceFloppy,
  IconRefresh,
  IconShield,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { PROVIDER_DEFINITIONS } from '@/lib/services/models/providerCatalog';
import {
  detectUnsupportedParams,
  formatRequestDefaults,
  parseRequestDefaults,
  REQUEST_DEFAULTS_PLACEHOLDER,
  toStringArray,
  UNSUPPORTED_PARAM_OPTIONS,
  validateRequestDefaults,
} from '@/components/models/requestParams';
import {
  getDefaultModelInputModalities,
  getDefaultModelOutputModalities,
} from '@/lib/services/models/modelCapabilities';
import CatalogPriceFill from '@/components/models/CatalogPriceFill';
import ModelGuardrailModal from '@/components/models/ModelGuardrailModal';
import type { GuardrailBindingRow } from '@/components/guardrails/GuardrailBindingList';

interface ModelProviderOption {
  key: string;
  label: string;
  status: string;
  driver: string;
}

interface ModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
}

interface SemanticCacheConfig {
  enabled: boolean;
  vectorProviderKey: string;
  vectorIndexKey: string;
  embeddingModelKey: string;
  similarityThreshold: number;
  ttlSeconds: number;
  maxCacheSize?: number;
}

interface ModelDetailDto {
  _id: string;
  name: string;
  description?: string;
  key: string;
  provider?: string;
  providerKey: string;
  providerDriver?: string;
  category: 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  capabilities?: {
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsReasoning?: boolean;
    supportsStructuredOutputs?: boolean;
  };
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  semanticCache?: SemanticCacheConfig;
  /**
   * Multi-guardrail binding. Its PRESENCE (not its length) is what says the
   * model is on the list rather than the two deprecated slots — an explicitly
   * empty array is an operator saying "bound to nothing", which the resolver
   * honours literally instead of falling back to the keys below.
   */
  guardrails?: GuardrailBindingRow[];
  /** @deprecated Read only to tell a legacy-bound model from an unbound one. */
  inputGuardrailKey?: string;
  /** @deprecated See `inputGuardrailKey`. */
  outputGuardrailKey?: string;
  metadata?: Record<string, unknown>;
}

/** `GET /api/guardrails`, narrowed to what naming an attached binding needs. */
interface GuardrailOption {
  key: string;
  name: string;
  type: 'preset' | 'custom';
  action: string;
  enabled?: boolean;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

interface FormValues {
  name: string;
  description?: string;
  key: string;
  providerKey: string;
  modelId: string;
  pricing: {
    currency: string;
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M: number;
  };
  settings: Record<string, unknown>;
  isMultimodal: boolean;
  supportsToolCalls: boolean;
  contextWindow: number | '';
  maxOutputTokens: number | '';
  supportsReasoning: boolean;
  supportsStructuredOutputs: boolean;
  semanticCacheEnabled: boolean;
  semanticCacheVectorProviderKey: string;
  semanticCacheVectorIndexKey: string;
  semanticCacheEmbeddingModelKey: string;
  semanticCacheSimilarityThreshold: number;
  semanticCacheTtlSeconds: number;
}

interface VectorProviderOption {
  key: string;
  label: string;
}

interface VectorIndexOption {
  key: string;
  name: string;
}

interface EmbeddingModelOption {
  key: string;
  name: string;
}

export default function EditModelPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const t = useTranslations('modelEdit');
  const tWizard = useTranslations('modelWizard');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [model, setModel] = useState<ModelDetailDto | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderOption[]>([]);
  const [vectorProviders, setVectorProviders] = useState<VectorProviderOption[]>([]);
  const [vectorIndexes, setVectorIndexes] = useState<VectorIndexOption[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModelOption[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailOption[]>([]);
  const [guardrailModalOpen, setGuardrailModalOpen] = useState(false);
  // Held as text so a half-typed JSON object doesn't get thrown away on rerender.
  const [requestDefaultsText, setRequestDefaultsText] = useState('');

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      key: '',
      providerKey: '',
      modelId: '',
      pricing: {
        currency: 'USD',
        inputTokenPer1M: 0,
        outputTokenPer1M: 0,
        cachedTokenPer1M: 0,
      },
      settings: {},
      isMultimodal: false,
      supportsToolCalls: false,
      contextWindow: '',
      maxOutputTokens: '',
      supportsReasoning: false,
      supportsStructuredOutputs: false,
      semanticCacheEnabled: false,
      semanticCacheVectorProviderKey: '',
      semanticCacheVectorIndexKey: '',
      semanticCacheEmbeddingModelKey: '',
      semanticCacheSimilarityThreshold: 0.92,
      semanticCacheTtlSeconds: 3600,
    },
    validate: {
      name: (value) => (!value ? tWizard('validation.name') : null),
      modelId: (value) => (!value ? tWizard('validation.modelId') : null),
    },
  });

  const selectedProvider = useMemo(
    () =>
      modelProviders.find((candidate) => candidate.key === form.values.providerKey) ?? null,
    [form.values.providerKey, modelProviders],
  );

  /**
   * Guardrail keys attached today, whichever generation the row is on.
   *
   * Only the KEYS: which hooks each one covers is a question with a right
   * answer (the guardrail's own declaration, the surface, whether streaming is
   * enabled) and it is answered in one place — `GuardrailBindingList`, inside
   * the editor below. A second, hand-rolled answer on this card is how a screen
   * ends up telling an operator a guardrail runs somewhere it does not.
   */
  const attachedGuardrailKeys = useMemo(() => {
    if (!model) return [];
    if (Array.isArray(model.guardrails)) {
      return model.guardrails.map((binding) => binding.key);
    }
    return [model.inputGuardrailKey, model.outputGuardrailKey].filter(
      (key, index, all): key is string =>
        Boolean(key) && all.indexOf(key) === index,
    );
  }, [model]);


  const providerDefinition = useMemo(
    () =>
      PROVIDER_DEFINITIONS.find(
        (candidate) => candidate.id === selectedProvider?.driver,
      ) ?? null,
    [selectedProvider?.driver],
  );

  // Same registry the gateway consults at call time, so the form shows exactly
  // what will be dropped rather than a description of it.
  const autoDropped = useMemo(
    () => (form.values.settings.autoDropUnsupportedParams === false
      ? { params: [] as string[], reason: undefined as string | undefined }
      : detectUnsupportedParams(selectedProvider?.driver, form.values.modelId)),
    [
      selectedProvider?.driver,
      form.values.modelId,
      form.values.settings.autoDropUnsupportedParams,
    ],
  );

  const loadVectorIndexes = useCallback(async (providerKey: string) => {
    if (!providerKey) {
      setVectorIndexes([]);
      return;
    }
    try {
      const res = await fetch(`/api/vector/indexes?providerKey=${encodeURIComponent(providerKey)}`);
      if (res.ok) {
        const data = await res.json();
        setVectorIndexes(
          (data.indexes ?? []).map((idx: { key: string; name: string }) => ({
            key: idx.key,
            name: idx.name,
          })),
        );
      }
    } catch {
      setVectorIndexes([]);
    }
  }, []);

  const loadModel = async (silenceNotification = false) => {
    const modelId = params?.id;
    if (!modelId) return;

    setRefreshing(!loading);
    try {
      const [modelResponse, providerResponse, vectorProviderResponse, embeddingModelsResponse, guardrailsResponse] = await Promise.all([
        fetch(`/api/models/${modelId}`),
        fetch('/api/models/providers'),
        fetch('/api/vector/providers'),
        fetch('/api/models?category=embedding'),
        // Unfiltered on purpose: a guardrail disabled AFTER it was bound still
        // has to resolve to its name here, or an attached binding renders as
        // "unknown" and reads as deleted when it is merely switched off.
        fetch('/api/guardrails'),
      ]);

      if (!modelResponse.ok) {
        throw new Error('failed');
      }

      const modelData = await modelResponse.json();
      const nextModel: ModelDetailDto = modelData.model;
      setModel(nextModel);

      const settings = { ...nextModel.settings };
      setRequestDefaultsText(formatRequestDefaults(settings.requestDefaults));

      const cache = nextModel.semanticCache;

      form.setValues({
        name: nextModel.name,
        description: nextModel.description,
        key: nextModel.key,
        providerKey: nextModel.providerKey || '',
        modelId: nextModel.modelId,
        pricing: {
          currency: nextModel.pricing.currency || 'USD',
          inputTokenPer1M: nextModel.pricing.inputTokenPer1M,
          outputTokenPer1M: nextModel.pricing.outputTokenPer1M,
          cachedTokenPer1M: nextModel.pricing.cachedTokenPer1M || 0,
        },
        settings,
        isMultimodal: Boolean(nextModel.isMultimodal),
        supportsToolCalls: Boolean(nextModel.supportsToolCalls),
        contextWindow: nextModel.capabilities?.contextWindow ?? '',
        maxOutputTokens: nextModel.capabilities?.maxOutputTokens ?? '',
        supportsReasoning: Boolean(nextModel.capabilities?.supportsReasoning),
        supportsStructuredOutputs: Boolean(
          nextModel.capabilities?.supportsStructuredOutputs,
        ),
        semanticCacheEnabled: Boolean(cache?.enabled),
        semanticCacheVectorProviderKey: cache?.vectorProviderKey || '',
        semanticCacheVectorIndexKey: cache?.vectorIndexKey || '',
        semanticCacheEmbeddingModelKey: cache?.embeddingModelKey || '',
        semanticCacheSimilarityThreshold: cache?.similarityThreshold ?? 0.92,
        semanticCacheTtlSeconds: cache?.ttlSeconds ?? 3600,
      });

      if (providerResponse.ok) {
        const providerData = await providerResponse.json();
        const rawProviders = providerData.providers ?? [];
        setModelProviders(
          rawProviders.map((p: Record<string, string>) => ({
            key: p.key,
            label: p.label || p.key,
            status: p.status || 'active',
            driver: p.driver || '',
          }))
        );
      }

      if (vectorProviderResponse.ok) {
        const vpData = await vectorProviderResponse.json();
        setVectorProviders(
          (vpData.providers ?? []).map((p: { key: string; label: string }) => ({
            key: p.key,
            label: p.label,
          })),
        );
      }

      if (embeddingModelsResponse.ok) {
        const emData = await embeddingModelsResponse.json();
        setEmbeddingModels(
          (emData.models ?? []).map((m: { key: string; name: string }) => ({
            key: m.key,
            name: m.name,
          })),
        );
      }

      if (guardrailsResponse.ok) {
        const gData = await guardrailsResponse.json();
        setGuardrails(
          (gData.guardrails ?? []).map(
            (g: {
              key: string;
              name: string;
              type: 'preset' | 'custom';
              action: string;
              enabled?: boolean;
            }) => ({
              key: g.key,
              name: g.name,
              type: g.type,
              action: g.action,
              enabled: g.enabled,
            }),
          ),
        );
      }

      // Load vector indexes for current provider if set
      if (cache?.vectorProviderKey) {
        await loadVectorIndexes(cache.vectorProviderKey);
      }

      if (!silenceNotification) {
        notifications.show({
          title: t('notifications.loadedTitle'),
          message: t('notifications.loadedMessage'),
          color: 'teal',
        });
      }
    } catch (error) {
      console.error('Failed to load model', error);
      notifications.show({
        title: t('notifications.errorTitle'),
        message: t('notifications.errorMessage'),
        color: 'red',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadModel(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  const handleSubmit = async (values: FormValues) => {
    if (!model) return;

    const validation = form.validate();
    if (validation.hasErrors) {
      return;
    }

    // The JSON editor lives outside the Mantine form, so it has to be checked
    // here. Without this, a typo fell through to `parseRequestDefaults` returning
    // undefined, which the payload below turns into `null` — i.e. a delete — and
    // the save reported success while wiping the stored defaults.
    const requestDefaultsError = validateRequestDefaults(requestDefaultsText);
    if (requestDefaultsError) {
      notifications.show({
        color: 'red',
        message: `Extra request body: ${requestDefaultsError}`,
        title: 'Cannot save',
      });
      return;
    }
    if (
      values.contextWindow !== ''
      && values.maxOutputTokens !== ''
      && values.maxOutputTokens > values.contextWindow
    ) {
      notifications.show({
        title: t('notifications.errorTitle'),
        message: tWizard('validation.maxOutputTokens'),
        color: 'red',
      });
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/models/${model._id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          key: values.key,
          providerKey: values.providerKey || undefined,
          modelId: values.modelId,
          pricing: values.pricing,
          settings: {
            ...values.settings,
            // `null` clears the key server-side, so emptying the editor removes
            // the defaults rather than persisting an empty object. Reached only
            // when the text is genuinely empty — invalid JSON is rejected above.
            requestDefaults: requestDefaultsText.trim()
              ? parseRequestDefaults(requestDefaultsText) ?? null
              : null,
            unsupportedParams: toStringArray(values.settings.unsupportedParams).length
              ? toStringArray(values.settings.unsupportedParams)
              : null,
          },
          isMultimodal: values.isMultimodal,
          supportsToolCalls: values.supportsToolCalls,
          capabilities: {
            ...(values.contextWindow !== ''
              ? { contextWindow: values.contextWindow }
              : {}),
            ...(values.maxOutputTokens !== ''
              ? { maxOutputTokens: values.maxOutputTokens }
              : {}),
            inputModalities: getDefaultModelInputModalities(
              model.category,
              values.isMultimodal,
            ),
            outputModalities: getDefaultModelOutputModalities(model.category),
            supportsReasoning: values.supportsReasoning,
            supportsStructuredOutputs: values.supportsStructuredOutputs,
            supportsToolCalls: values.supportsToolCalls,
          },
          semanticCache: {
            enabled: values.semanticCacheEnabled,
            vectorProviderKey: values.semanticCacheVectorProviderKey,
            vectorIndexKey: values.semanticCacheVectorIndexKey,
            embeddingModelKey: values.semanticCacheEmbeddingModelKey,
            similarityThreshold: values.semanticCacheSimilarityThreshold,
            ttlSeconds: values.semanticCacheTtlSeconds,
          },
          // No guardrail field of any kind. The bindings are written by the
          // editor overlay (which sends `guardrails`, and lets the API derive
          // the two deprecated columns from it); resending the legacy keys from
          // here would either be a stale echo of columns the API now owns, or —
          // on a model whose bindings moved into the list — the exact write the
          // API rejects with "send the full `guardrails` array instead". An
          // update that omits them leaves both columns untouched.
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update model');
      }

      notifications.show({
        title: t('notifications.savedTitle'),
        message: t('notifications.savedMessage'),
        color: 'teal',
      });

      router.push(`/dashboard/models/${model._id}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : t('notifications.errorMessage');
      notifications.show({
        title: t('notifications.errorTitle'),
        message: errorMessage,
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (!model) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">{t('errors.notFound')}</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/models')}>
            {t('actions.backToDetail')}
          </Button>
        </Stack>
      </Center>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Edit model"
        title={t('title', { name: model.name })}
        subtitle={t('subtitle')}
        actions={
          <>
            <Button
              onClick={() => openDocs('api-client')}
              variant="light"
              size="xs"
              leftSection={<IconBook size={14} />}
            >
              Docs
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              loading={refreshing || loading}
              onClick={() => loadModel(false)}
            >
              {t('actions.reload')}
            </Button>
            <Button
              type="submit"
              form="model-edit-form"
              size="xs"
              leftSection={<IconDeviceFloppy size={14} />}
              loading={saving}
            >
              {t('actions.save')}
            </Button>
          </>
        }
      />

      <Card withBorder radius="md" padding="lg">
        <form id="model-edit-form" onSubmit={form.onSubmit(handleSubmit)}>
          <Stack gap="lg">
            <Grid>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={tWizard('fields.name.label')}
                  placeholder={tWizard('fields.name.placeholder')}
                  required
                  {...form.getInputProps('name')}
                  onChange={(event) => {
                    form.setFieldValue('name', event.currentTarget.value);
                    if (!model.key || form.values.key === slugify(model.name)) {
                      form.setFieldValue('key', slugify(event.currentTarget.value));
                    }
                  }}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={tWizard('fields.key.label')}
                  placeholder={tWizard('fields.key.placeholder')}
                  value={form.values.key}
                  onChange={(event) => form.setFieldValue('key', slugify(event.currentTarget.value))}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <Textarea
                  label={tWizard('fields.description.label')}
                  placeholder={tWizard('fields.description.placeholder')}
                  autosize
                  minRows={2}
                  {...form.getInputProps('description')}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                {modelProviders.length > 0 ? (
                  <Select
                    label="Provider"
                    description="The provider that handles inference for this model."
                    data={modelProviders.map((p) => ({
                      value: p.key,
                      label: p.label,
                      disabled: p.status === 'disabled',
                    }))}
                    value={form.values.providerKey}
                    onChange={(val) => form.setFieldValue('providerKey', val || '')}
                    searchable
                    withAsterisk
                  />
                ) : (
                  <Text size="sm" c="dimmed">No model providers configured.</Text>
                )}
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={tWizard('fields.modelId.label')}
                  placeholder={providerDefinition?.modelIdHint || tWizard('fields.modelId.placeholder')}
                  required
                  {...form.getInputProps('modelId')}
                />
              </Grid.Col>
            </Grid>

            <Grid>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={tWizard('fields.currency.label')}
                  value={form.values.pricing.currency}
                  onChange={(event) => form.setFieldValue('pricing.currency', event.currentTarget.value.toUpperCase().slice(0, 8))}
                />
              </Grid.Col>
            </Grid>

            <Group justify="flex-end" mb={4}>
              <CatalogPriceFill
                modelId={form.values.modelId}
                onApply={(pricing) => {
                  form.setFieldValue('pricing.inputTokenPer1M', pricing.inputTokenPer1M);
                  form.setFieldValue('pricing.outputTokenPer1M', pricing.outputTokenPer1M);
                  form.setFieldValue('pricing.cachedTokenPer1M', pricing.cachedTokenPer1M);
                }}
              />
            </Group>
            <Paper withBorder radius="md" p="md">
              <Grid>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={tWizard('fields.pricing.prompt')}
                    min={0}
                    value={form.values.pricing.inputTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.inputTokenPer1M', Number(value) || 0)}
                    thousandSeparator=","
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={tWizard('fields.pricing.completion')}
                    min={0}
                    value={form.values.pricing.outputTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.outputTokenPer1M', Number(value) || 0)}
                    thousandSeparator=","
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={tWizard('fields.pricing.cached')}
                    min={0}
                    value={form.values.pricing.cachedTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.cachedTokenPer1M', Number(value) || 0)}
                    thousandSeparator=","
                  />
                </Grid.Col>
              </Grid>
            </Paper>

            <Grid>
              <Grid.Col span={{ base: 12, md: 4 }}>
                <NumberInput
                  label={tWizard('fields.contextWindow.label')}
                  description={tWizard('fields.contextWindow.description')}
                  min={1}
                  step={1024}
                  thousandSeparator=","
                  {...form.getInputProps('contextWindow')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 4 }}>
                <NumberInput
                  label={tWizard('fields.maxOutputTokens.label')}
                  description={tWizard('fields.maxOutputTokens.description')}
                  min={1}
                  step={1024}
                  thousandSeparator=","
                  {...form.getInputProps('maxOutputTokens')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 4 }}>
                <NumberInput
                  label={tWizard('fields.runtimeMaxTokens.label')}
                  description={tWizard('fields.runtimeMaxTokens.description')}
                  min={1}
                  step={1024}
                  thousandSeparator=","
                  {...form.getInputProps('settings.maxTokens')}
                />
              </Grid.Col>
            </Grid>

            <Group align="flex-start">
              <Checkbox
                label={tWizard('fields.isMultimodal.label')}
                description={tWizard('fields.isMultimodal.description')}
                {...form.getInputProps('isMultimodal', { type: 'checkbox' })}
              />
              <Checkbox
                label={tWizard('fields.supportsToolCalls.label')}
                description={tWizard('fields.supportsToolCalls.description')}
                {...form.getInputProps('supportsToolCalls', { type: 'checkbox' })}
              />
              <Checkbox
                label={tWizard('fields.supportsReasoning.label')}
                description={tWizard('fields.supportsReasoning.description')}
                {...form.getInputProps('supportsReasoning', { type: 'checkbox' })}
              />
              <Checkbox
                label={tWizard('fields.supportsStructuredOutputs.label')}
                description={tWizard('fields.supportsStructuredOutputs.description')}
                {...form.getInputProps('supportsStructuredOutputs', { type: 'checkbox' })}
              />
            </Group>

            {model.category === 'llm' && (
              <Card withBorder radius="md" padding="md">
                <Stack gap="sm">
                  <Title order={4}>Request parameters</Title>

                  <div>
                    <Text size="sm" fw={500}>Detected automatically</Text>
                    <Text size="xs" c="dimmed" mb={6}>
                      {autoDropped.params.length
                        ? autoDropped.reason
                        : 'Nothing known against this provider and model id. Anything the provider still rejects goes in the list below.'}
                    </Text>
                    {autoDropped.params.length ? (
                      <Group gap={6}>
                        {autoDropped.params.map((param) => (
                          <Badge key={param} variant="light" color="gray" radius="sm">
                            {param}
                          </Badge>
                        ))}
                      </Group>
                    ) : (
                      <Text size="sm" c="dimmed">None</Text>
                    )}
                  </div>

                  <Checkbox
                    label="Drop detected parameters automatically"
                    description="On by default. Turn off if the provider has started accepting a parameter this list still flags."
                    checked={form.values.settings.autoDropUnsupportedParams !== false}
                    onChange={(event) =>
                      form.setFieldValue(
                        'settings.autoDropUnsupportedParams',
                        event.currentTarget.checked,
                      )
                    }
                  />

                  <MultiSelect
                    label="Also reject these"
                    description="Added on top of what was detected, for anything the registry does not know about this provider yet."
                    data={UNSUPPORTED_PARAM_OPTIONS}
                    searchable
                    clearable
                    placeholder="None"
                    value={toStringArray(form.values.settings.unsupportedParams)}
                    onChange={(value) => form.setFieldValue('settings.unsupportedParams', value)}
                  />

                  <JsonInput
                    label="Extra request body (JSON)"
                    description="Merged into every request to this model — for parameters outside the OpenAI schema, such as vLLM's chat_template_kwargs or top_k. A caller's value wins over these."
                    autosize
                    minRows={4}
                    formatOnBlur
                    validationError="Must be valid JSON"
                    placeholder={REQUEST_DEFAULTS_PLACEHOLDER}
                    value={requestDefaultsText}
                    onChange={(value) => setRequestDefaultsText(value)}
                    error={validateRequestDefaults(requestDefaultsText)}
                  />

                  <Checkbox
                    label="Forward unrecognised caller parameters"
                    description="Off by default. When on, body fields the gateway does not know are passed to the provider as-is."
                    checked={Boolean(form.values.settings.allowUnknownPassthrough)}
                    onChange={(event) =>
                      form.setFieldValue(
                        'settings.allowUnknownPassthrough',
                        event.currentTarget.checked,
                      )
                    }
                  />
                </Stack>
              </Card>
            )}

            {/* Semantic Cache section - only for LLM models */}
            {model.category === 'llm' && (
              <Card withBorder radius="md" padding="md">
                <Stack gap="sm">
                  <Title order={4}>{t('sections.semanticCache')}</Title>
                  <Text size="sm" c="dimmed">{t('semanticCache.description')}</Text>
                  <Switch
                    label={t('semanticCache.enabled')}
                    checked={form.values.semanticCacheEnabled}
                    onChange={(event) => form.setFieldValue('semanticCacheEnabled', event.currentTarget.checked)}
                  />
                  {form.values.semanticCacheEnabled && (
                    <Stack gap="sm">
                      <Grid>
                        <Grid.Col span={{ base: 12, md: 6 }}>
                          {vectorProviders.length > 0 ? (
                            <Select
                              label={t('semanticCache.vectorProviderKey')}
                              placeholder={t('semanticCache.vectorProviderKeyPlaceholder')}
                              data={vectorProviders.map((p) => ({ value: p.key, label: p.label }))}
                              value={form.values.semanticCacheVectorProviderKey}
                              onChange={(val) => {
                                form.setFieldValue('semanticCacheVectorProviderKey', val || '');
                                form.setFieldValue('semanticCacheVectorIndexKey', '');
                                if (val) {
                                  loadVectorIndexes(val);
                                } else {
                                  setVectorIndexes([]);
                                }
                              }}
                            />
                          ) : (
                            <Text size="sm" c="dimmed">{t('semanticCache.noVectorProviders')}</Text>
                          )}
                        </Grid.Col>
                        <Grid.Col span={{ base: 12, md: 6 }}>
                          {form.values.semanticCacheVectorProviderKey ? (
                            vectorIndexes.length > 0 ? (
                              <Select
                                label={t('semanticCache.vectorIndexKey')}
                                placeholder={t('semanticCache.vectorIndexKeyPlaceholder')}
                                data={vectorIndexes.map((idx) => ({ value: idx.key, label: idx.name }))}
                                value={form.values.semanticCacheVectorIndexKey}
                                onChange={(val) => form.setFieldValue('semanticCacheVectorIndexKey', val || '')}
                              />
                            ) : (
                              <Text size="sm" c="dimmed">{t('semanticCache.noVectorIndexes')}</Text>
                            )
                          ) : null}
                        </Grid.Col>
                      </Grid>
                      <Grid>
                        <Grid.Col span={{ base: 12, md: 6 }}>
                          {embeddingModels.length > 0 ? (
                            <Select
                              label={t('semanticCache.embeddingModelKey')}
                              placeholder={t('semanticCache.embeddingModelKeyPlaceholder')}
                              data={embeddingModels.map((m) => ({ value: m.key, label: m.name }))}
                              value={form.values.semanticCacheEmbeddingModelKey}
                              onChange={(val) => form.setFieldValue('semanticCacheEmbeddingModelKey', val || '')}
                            />
                          ) : (
                            <Text size="sm" c="dimmed">{t('semanticCache.noEmbeddingModels')}</Text>
                          )}
                        </Grid.Col>
                      </Grid>
                      <Grid>
                        <Grid.Col span={{ base: 12, md: 6 }}>
                          <Text size="sm" fw={500} mb={4}>{t('semanticCache.similarityThreshold')}</Text>
                          <Slider
                            min={0.5}
                            max={1}
                            step={0.01}
                            marks={[
                              { value: 0.5, label: '0.5' },
                              { value: 0.75, label: '0.75' },
                              { value: 0.9, label: '0.9' },
                              { value: 1, label: '1.0' },
                            ]}
                            value={form.values.semanticCacheSimilarityThreshold}
                            onChange={(val) => form.setFieldValue('semanticCacheSimilarityThreshold', val)}
                          />
                          <Text size="xs" c="dimmed" mt={4}>{t('semanticCache.similarityThresholdDescription')}</Text>
                        </Grid.Col>
                        <Grid.Col span={{ base: 12, md: 6 }}>
                          <NumberInput
                            label={t('semanticCache.ttlSeconds')}
                            description={t('semanticCache.ttlSecondsDescription')}
                            min={0}
                            value={form.values.semanticCacheTtlSeconds}
                            onChange={(val) => form.setFieldValue('semanticCacheTtlSeconds', Number(val) || 0)}
                          />
                        </Grid.Col>
                      </Grid>
                    </Stack>
                  )}
                </Stack>
              </Card>
            )}

            {/*
              * Guardrails — the binding LIST, not the two `Select`s this card
              * used to be. One slot per direction cannot compose two reusable
              * guardrails and has nowhere to put a tool binding at all.
              *
              * The editing itself is `ModelGuardrailModal`: a full-screen
              * `FormShell` hosting the shared `GuardrailBindingList`, and the
              * same overlay the models list page opens. One editor for the
              * model surface means one set of rules for the column and one
              * place where the per-hook warnings are worded — this card only
              * has to say what is attached and open it.
              */}
            {model.category === 'llm' && (
              <Card withBorder radius="md" padding="md">
                <Stack gap="sm">
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <div>
                      <Title order={4}>Guardrails</Title>
                      <Text size="sm" c="dimmed">
                        Safety checks that run on every request to this model — the prompt
                        before the model sees it, the answer before it reaches the caller, and
                        the answer while it streams. Each guardrail covers the hooks you tick.
                      </Text>
                    </div>
                    <Button
                      variant="light"
                      size="xs"
                      leftSection={<IconShield size={14} />}
                      onClick={() => setGuardrailModalOpen(true)}
                      style={{ flexShrink: 0 }}
                    >
                      {attachedGuardrailKeys.length > 0 ? 'Edit bindings' : 'Attach a guardrail'}
                    </Button>
                  </Group>

                  {attachedGuardrailKeys.length === 0 ? (
                    guardrails.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        No guardrails defined yet.{' '}
                        <Link href="/dashboard/guardrails" style={{ color: 'var(--mantine-color-teal-6)' }}>
                          Create one first.
                        </Link>
                      </Text>
                    ) : (
                      <Text size="sm" c="dimmed">
                        No guardrails attached — every request to this model passes unchecked.
                      </Text>
                    )
                  ) : (
                    <Group gap="xs">
                      {attachedGuardrailKeys.map((key) => {
                        const guardrail = guardrails.find((candidate) => candidate.key === key);
                        return (
                          <Badge
                            key={key}
                            variant="light"
                            // A bound key with no guardrail behind it is kept
                            // visible and flagged: it was deleted or belongs to
                            // another project, and hiding it is how a binding
                            // nobody chose to remove disappears.
                            color={
                              !guardrail ? 'red' : guardrail.enabled === false ? 'gray' : 'teal'
                            }
                          >
                            {guardrail
                              ? `${guardrail.name}${guardrail.enabled === false ? ' · disabled' : ''}`
                              : `${key} · unknown key`}
                          </Badge>
                        );
                      })}
                    </Group>
                  )}

                  <Text size="xs" c="dimmed">
                    Bindings are saved by the overlay, separately from the rest of this form.
                  </Text>
                </Stack>
              </Card>
            )}

            <Group justify="flex-end">
              <Button type="submit" loading={saving} leftSection={<IconDeviceFloppy size={16} />}>
                {t('actions.save')}
              </Button>
              <Button component={Link} href={`/dashboard/models/${model._id}`} variant="default">
                {t('actions.cancel')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>

      {/*
        * Mounted unconditionally rather than behind `guardrailModalOpen` so the
        * overlay owns its own load: it re-reads `GET /api/models/:id` on open,
        * which is what decides list-vs-legacy, and the seeds below are only a
        * fallback for the moment before that lands.
        */}
      <ModelGuardrailModal
        opened={guardrailModalOpen}
        modelId={model._id}
        modelName={model.name}
        initialInputGuardrailKey={model.inputGuardrailKey}
        initialOutputGuardrailKey={model.outputGuardrailKey}
        onClose={() => setGuardrailModalOpen(false)}
        onSaved={(bindings) => {
          // Reflect the save locally instead of reloading the whole form: a
          // reload would throw away every unsaved field on this page. Setting
          // `guardrails` is also what flips the card out of the legacy state,
          // which is exactly what the save just did to the record.
          setModel((current) => (current ? { ...current, guardrails: bindings } : current));
        }}
      />
    </PageContainer>
  );
}
