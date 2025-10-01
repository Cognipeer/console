'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Grid,
  Group,
  Loader,
  NumberInput,
  Paper,
  Radio,
  Select,
  Stack,
  Stepper,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlug, IconShieldCheck, IconSparkles } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

interface ProviderField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

interface ProviderDefinition {
  id: string;
  label: string;
  description: string;
  categories: Array<'llm' | 'embedding'>;
  credentialFields: ProviderField[];
  defaultPricingCurrency: string;
  modelIdHint?: string;
}

interface FormValues {
  category: 'llm' | 'embedding';
  provider: string;
  settings: Record<string, string>;
  name: string;
  key: string;
  description?: string;
  modelId: string;
  isMultimodal: boolean;
  supportsToolCalls: boolean;
  pricing: {
    currency: string;
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M: number;
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export default function NewModelPage() {
  const router = useRouter();
  const t = useTranslations('modelWizard');
  const tModels = useTranslations('models');
  const [activeStep, setActiveStep] = useState(0);
  const [providers, setProviders] = useState<ProviderDefinition[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const form = useForm<FormValues>({
    initialValues: {
      category: 'llm',
      provider: '',
      settings: {},
      name: '',
      key: '',
      description: '',
      modelId: '',
      isMultimodal: false,
      supportsToolCalls: true,
      pricing: {
        currency: 'USD',
        inputTokenPer1M: 0,
        outputTokenPer1M: 0,
        cachedTokenPer1M: 0,
      },
    },
    validate: {
      provider: (value) => (!value ? t('validation.provider') : null),
      name: (value) => (!value ? t('validation.name') : null),
      modelId: (value) => (!value ? t('validation.modelId') : null),
    },
  });

  useEffect(() => {
    let cancelled = false;

    const fetchProviders = async () => {
      try {
        const response = await fetch('/api/models/providers', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Failed to load providers');
        }
        const data = await response.json();
        if (!cancelled) {
          const definitions: ProviderDefinition[] = data.providers || [];
          setProviders(definitions);

          if (definitions.length > 0) {
            const existingProvider = definitions.find((provider) => provider.id === form.values.provider);
            if (existingProvider) {
              setSelectedProviderId(existingProvider.id);
            } else {
              const fallbackProvider =
                definitions.find((provider) => provider.categories.includes(form.values.category)) || definitions[0];

              if (fallbackProvider) {
                setSelectedProviderId(fallbackProvider.id);
                form.setFieldValue('provider', fallbackProvider.id);
                form.setFieldValue('pricing.currency', fallbackProvider.defaultPricingCurrency || 'USD');
                form.setFieldValue('settings', {});
              }
            }
          }
        }
      } catch (error) {
        console.error(error);
        notifications.show({
          title: t('notifications.errorTitle'),
          message: t('notifications.loadProvidersError'),
          color: 'red',
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchProviders();
    return () => {
      cancelled = true;
    };
  }, [form, t]);

  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.categories.includes(form.values.category)),
    [providers, form.values.category],
  );

  useEffect(() => {
    if (availableProviders.length === 0) {
      setSelectedProviderId('');
      form.setFieldValue('provider', '');
      return;
    }

    const currentProvider = availableProviders.find((provider) => provider.id === selectedProviderId);
    if (!currentProvider) {
      const fallback = availableProviders[0];
      setSelectedProviderId(fallback.id);
      form.setFieldValue('provider', fallback.id);
      form.setFieldValue('pricing.currency', fallback.defaultPricingCurrency || 'USD');
      form.setFieldValue('settings', {});
    }
  }, [availableProviders, selectedProviderId, form]);

  const selectedProvider = useMemo(
    () => availableProviders.find((provider) => provider.id === selectedProviderId),
    [availableProviders, selectedProviderId],
  );

  const handleNext = () => {
    if (activeStep === 0) {
      if (!selectedProvider) {
        form.validateField('provider');
        return;
      }
    }

    if (activeStep === 2) {
      const validation = form.validate();
      if (validation.hasErrors || form.values.pricing.inputTokenPer1M < 0 || form.values.pricing.outputTokenPer1M < 0) {
        notifications.show({
          title: t('notifications.errorTitle'),
          message: t('notifications.pricingError'),
          color: 'red',
        });
        return;
      }
    }

    setActiveStep((current) => Math.min(current + 1, 3));
  };

  const handlePrev = () => setActiveStep((current) => Math.max(current - 1, 0));

  const handleSubmit = async () => {
    const validation = form.validate();
    if (
      validation.hasErrors ||
      form.values.pricing.inputTokenPer1M < 0 ||
      form.values.pricing.outputTokenPer1M < 0 ||
      form.values.pricing.cachedTokenPer1M < 0
    ) {
      return;
    }

    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          category: form.values.category,
          provider: form.values.provider,
          settings: form.values.settings,
          name: form.values.name,
          key: form.values.key,
          description: form.values.description,
          modelId: form.values.modelId,
          isMultimodal: form.values.isMultimodal,
          supportsToolCalls: form.values.supportsToolCalls,
          pricing: form.values.pricing,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create model');
      }

      notifications.show({
        title: t('notifications.successTitle'),
        message: t('notifications.successMessage'),
        color: 'teal',
      });
      router.push('/dashboard/models');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : undefined;
      notifications.show({
        title: t('notifications.errorTitle'),
        message: message || t('notifications.genericError'),
        color: 'red',
      });
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>{t('title')}</Title>
          <Text size="sm" c="dimmed">
            {t('subtitle')}
          </Text>
        </div>
      </Group>

  <Stepper active={activeStep} onStepClick={setActiveStep} allowNextStepsSelect={false} iconSize={28}>
        <Stepper.Step label={t('steps.provider.label')} description={t('steps.provider.description')}>
          <Stack gap="lg">
            <Radio.Group
              label={t('fields.category.label')}
              description={t('fields.category.description')}
              value={form.values.category}
              onChange={(value: string) => form.setFieldValue('category', value as FormValues['category'])}
            >
              <Group mt="xs">
                <Radio value="llm" label={t('fields.category.options.llm')} />
                <Radio value="embedding" label={t('fields.category.options.embedding')} />
              </Group>
            </Radio.Group>

            <Grid>
              {availableProviders.map((provider) => (
                <Grid.Col key={provider.id} span={{ base: 12, md: 6, lg: 4 }}>
                  <Paper
                    withBorder
                    radius="md"
                    p="md"
                    onClick={() => {
                      setSelectedProviderId(provider.id);
                      form.setFieldValue('provider', provider.id);
                      form.setFieldValue('pricing.currency', provider.defaultPricingCurrency || 'USD');
                      form.setFieldValue('settings', {});
                      setActiveStep(1);
                    }}
                    style={{
                      borderColor: provider.id === selectedProviderId ? 'var(--mantine-color-blue-5)' : undefined,
                      cursor: 'pointer',
                    }}
                  >
                    <Stack gap={8}>
                      <Group gap={8}>
                        <IconPlug size={18} />
                        <Text fw={600}>{provider.label}</Text>
                      </Group>
                      <Text size="sm" c="dimmed">
                        {provider.description}
                      </Text>
                      <Group gap={6}>
                        {provider.categories.map((category) => (
                          <Badge key={category} variant="light" color={category === 'llm' ? 'indigo' : 'teal'}>
                            {category === 'llm' ? tModels('list.badges.llm') : tModels('list.badges.embedding')}
                          </Badge>
                        ))}
                      </Group>
                    </Stack>
                  </Paper>
                </Grid.Col>
              ))}
            </Grid>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label={t('steps.credentials.label')} description={t('steps.credentials.description')}>
          <Stack gap="md">
            {selectedProvider?.credentialFields.map((field) => {
              const value = (form.values.settings?.[field.name] as string) || '';
              const setValue = (val: string) => {
                form.setFieldValue('settings', {
                  ...form.values.settings,
                  [field.name]: val,
                });
              };

              if (field.type === 'select') {
                return (
                  <Select
                    key={field.name}
                    label={field.label}
                    placeholder={field.placeholder}
                    data={field.options || []}
                    required={field.required}
                    value={value}
                    onChange={(val) => setValue(val || '')}
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
                  onChange={(event) => setValue(event.currentTarget.value)}
                />
              );
            })}
            {!selectedProvider?.credentialFields?.length && (
              <Paper withBorder p="md" radius="md">
                <Group gap="sm">
                  <IconShieldCheck size={18} />
                  <Text size="sm">{t('steps.credentials.noCredentials')}</Text>
                </Group>
              </Paper>
            )}
          </Stack>
        </Stepper.Step>

        <Stepper.Step label={t('steps.configuration.label')} description={t('steps.configuration.description')}>
          <Stack gap="md">
            <Grid>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={t('fields.name.label')}
                  placeholder={t('fields.name.placeholder')}
                  required
                  value={form.values.name}
                  onChange={(event) => {
                    form.setFieldValue('name', event.currentTarget.value);
                    if (!form.values.key) {
                      form.setFieldValue('key', slugify(event.currentTarget.value));
                    }
                  }}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={t('fields.key.label')}
                  placeholder={t('fields.key.placeholder')}
                  value={form.values.key}
                  onChange={(event) => form.setFieldValue('key', slugify(event.currentTarget.value))}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <Textarea
                  label={t('fields.description.label')}
                  placeholder={t('fields.description.placeholder')}
                  value={form.values.description}
                  onChange={(event) => form.setFieldValue('description', event.currentTarget.value)}
                  autosize
                  minRows={2}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={t('fields.modelId.label')}
                  placeholder={selectedProvider?.modelIdHint || t('fields.modelId.placeholder')}
                  required
                  value={form.values.modelId}
                  onChange={(event) => form.setFieldValue('modelId', event.currentTarget.value)}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <TextInput
                  label={t('fields.currency.label')}
                  value={form.values.pricing.currency}
                  onChange={(event) => form.setFieldValue('pricing.currency', event.currentTarget.value.toUpperCase().slice(0, 8))}
                />
              </Grid.Col>
            </Grid>

            <Paper withBorder radius="md" p="md">
              <Title order={5} mb="sm">
                {t('fields.pricing.title')}
              </Title>
              <Grid>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={t('fields.pricing.prompt')}
                    value={form.values.pricing.inputTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.inputTokenPer1M', Number(value) || 0)}
                    min={0}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={t('fields.pricing.completion')}
                    value={form.values.pricing.outputTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.outputTokenPer1M', Number(value) || 0)}
                    min={0}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={t('fields.pricing.cached')}
                    value={form.values.pricing.cachedTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.cachedTokenPer1M', Number(value) || 0)}
                    min={0}
                  />
                </Grid.Col>
              </Grid>
            </Paper>

            <Group>
              <Checkbox
                label={t('fields.isMultimodal.label')}
                description={t('fields.isMultimodal.description')}
                checked={form.values.isMultimodal}
                onChange={(event) => form.setFieldValue('isMultimodal', event.currentTarget.checked)}
              />
              <Checkbox
                label={t('fields.supportsToolCalls.label')}
                description={t('fields.supportsToolCalls.description')}
                checked={form.values.supportsToolCalls}
                onChange={(event) => form.setFieldValue('supportsToolCalls', event.currentTarget.checked)}
              />
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Completed>
          <Paper withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group gap="sm">
                <IconSparkles size={18} />
                <Title order={4}>{t('review.title')}</Title>
              </Group>
              <Text size="sm" c="dimmed">
                {t('review.subtitle')}
              </Text>
              <Grid>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <Box>
                    <Text fw={600}>{t('review.fields.name')}</Text>
                    <Text size="sm">{form.values.name}</Text>
                  </Box>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <Box>
                    <Text fw={600}>{t('review.fields.provider')}</Text>
                    <Text size="sm">{selectedProvider?.label}</Text>
                  </Box>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <Box>
                    <Text fw={600}>{t('review.fields.modelId')}</Text>
                    <Text size="sm">{form.values.modelId}</Text>
                  </Box>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <Box>
                    <Text fw={600}>{t('review.fields.key')}</Text>
                    <Text size="sm">{form.values.key || t('review.autoGenerated')}</Text>
                  </Box>
                </Grid.Col>
              </Grid>
              <Paper withBorder radius="md" p="md">
                <Text fw={600} size="sm">
                  {t('review.fields.pricing')}
                </Text>
                <Text size="sm" c="dimmed">
                  {t('list.pricing.prompt', {
                    price: form.values.pricing.inputTokenPer1M,
                    currency: form.values.pricing.currency,
                  })}
                </Text>
                <Text size="sm" c="dimmed">
                  {t('list.pricing.completion', {
                    price: form.values.pricing.outputTokenPer1M,
                    currency: form.values.pricing.currency,
                  })}
                </Text>
                {form.values.pricing.cachedTokenPer1M ? (
                  <Text size="sm" c="dimmed">
                    {t('list.pricing.cached', {
                      price: form.values.pricing.cachedTokenPer1M,
                      currency: form.values.pricing.currency,
                    })}
                  </Text>
                ) : null}
              </Paper>
            </Stack>
          </Paper>
        </Stepper.Completed>
      </Stepper>

      <Group justify="space-between">
        <Button variant="default" onClick={handlePrev} disabled={activeStep === 0}>
          {t('actions.back')}
        </Button>

        {activeStep < 3 ? (
          <Button onClick={handleNext}>
            {t('actions.next')}
          </Button>
        ) : (
          <Button color="teal" onClick={handleSubmit}>
            {t('actions.createModel')}
          </Button>
        )}
      </Group>
    </Stack>
  );
}
