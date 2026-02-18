'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Button,
  Card,
  Center,
  Checkbox,
  Grid,
  Group,
  Loader,
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
import PageHeader from '@/components/layout/PageHeader';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconBook, IconBrain, IconDeviceFloppy, IconRefresh } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

interface ProviderField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

interface ProviderDefinitionDto {
  id: string;
  label: string;
  description: string;
  categories: Array<'llm' | 'embedding'>;
  credentialFields: ProviderField[];
  defaultPricingCurrency: string;
  modelIdHint?: string;
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
  provider: string;
  category: 'llm' | 'embedding';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, string>;
  semanticCache?: SemanticCacheConfig;
  metadata?: Record<string, unknown>;
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
  modelId: string;
  pricing: {
    currency: string;
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M: number;
  };
  settings: Record<string, string>;
  isMultimodal: boolean;
  supportsToolCalls: boolean;
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
  const [providers, setProviders] = useState<ProviderDefinitionDto[]>([]);
  const [vectorProviders, setVectorProviders] = useState<VectorProviderOption[]>([]);
  const [vectorIndexes, setVectorIndexes] = useState<VectorIndexOption[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModelOption[]>([]);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      key: '',
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

  const provider = useMemo(
    () => providers.find((candidate) => candidate.id === model?.provider),
    [providers, model],
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
      const [modelResponse, providerResponse, vectorProviderResponse, embeddingModelsResponse] = await Promise.all([
        fetch(`/api/models/${modelId}`),
        fetch('/api/models/providers'),
        fetch('/api/vector/providers'),
        fetch('/api/models?category=embedding'),
      ]);

      if (!modelResponse.ok) {
        throw new Error('failed');
      }

      const modelData = await modelResponse.json();
      const nextModel: ModelDetailDto = modelData.model;
      setModel(nextModel);

      const settings = Object.entries(nextModel.settings || {}).reduce<Record<string, string>>((acc, [key, value]) => {
        acc[key] = typeof value === 'string' ? value : JSON.stringify(value);
        return acc;
      }, {});

      const cache = nextModel.semanticCache;

      form.setValues({
        name: nextModel.name,
        description: nextModel.description,
        key: nextModel.key,
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
        semanticCacheEnabled: Boolean(cache?.enabled),
        semanticCacheVectorProviderKey: cache?.vectorProviderKey || '',
        semanticCacheVectorIndexKey: cache?.vectorIndexKey || '',
        semanticCacheEmbeddingModelKey: cache?.embeddingModelKey || '',
        semanticCacheSimilarityThreshold: cache?.similarityThreshold ?? 0.92,
        semanticCacheTtlSeconds: cache?.ttlSeconds ?? 3600,
      });

      if (providerResponse.ok) {
        const providerData = await providerResponse.json();
        setProviders(providerData.providers ?? []);
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

  const handleCredentialChange = (field: ProviderField, value: string) => {
    form.setFieldValue('settings', {
      ...form.values.settings,
      [field.name]: value,
    });
  };

  const handleSubmit = async (values: FormValues) => {
    if (!model) return;

    const validation = form.validate();
    if (validation.hasErrors) {
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
          modelId: values.modelId,
          pricing: values.pricing,
          settings: values.settings,
          isMultimodal: values.isMultimodal,
          supportsToolCalls: values.supportsToolCalls,
          semanticCache: {
            enabled: values.semanticCacheEnabled,
            vectorProviderKey: values.semanticCacheVectorProviderKey,
            vectorIndexKey: values.semanticCacheVectorIndexKey,
            embeddingModelKey: values.semanticCacheEmbeddingModelKey,
            similarityThreshold: values.semanticCacheSimilarityThreshold,
            ttlSeconds: values.semanticCacheTtlSeconds,
          },
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
    <Stack gap="md">
      <PageHeader
        icon={<IconBrain size={18} />}
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
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={tWizard('fields.modelId.label')}
                  placeholder={provider?.modelIdHint || tWizard('fields.modelId.placeholder')}
                  required
                  {...form.getInputProps('modelId')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={tWizard('fields.currency.label')}
                  value={form.values.pricing.currency}
                  onChange={(event) => form.setFieldValue('pricing.currency', event.currentTarget.value.toUpperCase().slice(0, 8))}
                />
              </Grid.Col>
            </Grid>

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

            <Group>
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
            </Group>

            {provider?.credentialFields?.length ? (
              <Card withBorder radius="md" padding="md">
                <Stack gap="sm">
                  <Title order={4}>{t('sections.credentials')}</Title>
                  {provider.credentialFields.map((field) => {
                    const value = form.values.settings?.[field.name] || '';

                    if (field.type === 'select') {
                      return (
                        <Select
                          key={field.name}
                          label={field.label}
                          placeholder={field.placeholder}
                          data={field.options || []}
                          required={field.required}
                          value={value}
                          onChange={(val) => handleCredentialChange(field, val || '')}
                        />
                      );
                    }

                    return (
                      <TextInput
                        key={field.name}
                        type={field.type === 'password' ? 'password' : 'text'}
                        label={field.label}
                        placeholder={field.placeholder}
                        description={field.description}
                        required={field.required}
                        value={value}
                        onChange={(event) => handleCredentialChange(field, event.currentTarget.value)}
                      />
                    );
                  })}
                </Stack>
              </Card>
            ) : null}

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
    </Stack>
  );
}
