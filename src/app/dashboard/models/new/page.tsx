import { redirect } from 'next/navigation';

export default function NewModelRedirect() {
  redirect('/dashboard/models');
}

/*

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
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
  ThemeIcon,
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

  // Load providers on mount
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
          setProviders(data.providers || []);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          notifications.show({
            title: t('notifications.errorTitle'),
            message: t('notifications.loadProvidersError'),
            color: 'red',
          });
        }
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
  }, [t]);

  // Filter providers by category
  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.categories.includes(form.values.category)),
    [providers, form.values.category],
  );

  // Get current selected provider
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === form.values.provider),
    [providers, form.values.provider],
  );

  // Handle category change - reset provider if not compatible
  useEffect(() => {
    if (form.values.provider && selectedProvider) {
      if (!selectedProvider.categories.includes(form.values.category)) {
        form.setFieldValue('provider', '');
        form.setFieldValue('settings', {});
      }
    }
  }, [form.values.category]); // Only depend on category

  // Handle provider selection
  const handleProviderSelect = useCallback((providerId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;

    // Create empty settings object based on provider's credential fields
    const emptySettings: Record<string, string> = {};
    provider.credentialFields.forEach((field) => {
      emptySettings[field.name] = '';
    });

    form.setValues({
      ...form.values,
      provider: providerId,
      settings: emptySettings,
      pricing: {
        ...form.values.pricing,
        currency: provider.defaultPricingCurrency || 'USD',
      },
    });

    setActiveStep(1);
  }, [providers, form]);

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
    <Stack gap="md">
      <div>
        <Title order={2}>{t('title')}</Title>
        <Text size="sm" c="dimmed" mt={4}>
          {t('subtitle')}
        </Text>
      </div>

      <Stepper active={activeStep} onStepClick={setActiveStep} allowNextStepsSelect={false} iconSize={32} mt="md">
        <Stepper.Step label={t('steps.provider.label')} description={t('steps.provider.description')}>
          <Stack gap="md" mt="md">
            <Paper withBorder radius="md" p="md">
              <Radio.Group
                label={t('fields.category.label')}
                description={t('fields.category.description')}
                value={form.values.category}
                onChange={(value: string) => form.setFieldValue('category', value as FormValues['category'])}
              >
                <Group mt="xs" gap="md">
                  <Radio value="llm" label={t('fields.category.options.llm')} size="md" />
                  <Radio value="embedding" label={t('fields.category.options.embedding')} size="md" />
                </Group>
              </Radio.Group>
            </Paper>

            <Stack gap="xs">
              <Text size="sm" fw={500}>{t('steps.provider.selectProvider')}</Text>
              <Grid>
                {availableProviders.map((provider) => (
                  <Grid.Col key={provider.id} span={{ base: 12, md: 6, lg: 4 }}>
                    <Paper
                      withBorder
                      radius="md"
                      p="md"
                      onClick={() => handleProviderSelect(provider.id)}
                      style={{
                        borderWidth: provider.id === form.values.provider ? 2 : 1,
                        borderColor: provider.id === form.values.provider ? 'var(--mantine-color-gray-5)' : undefined,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        backgroundColor: provider.id === form.values.provider ? 'var(--mantine-color-gray-0)' : undefined,
                      }}
                      className="hover:shadow-md"
                    >
                      <Stack gap={8}>
                        <Group gap={8}>
                          <ThemeIcon variant="light" size="md" radius="md" color="gray">
                            <IconPlug size={18} />
                          </ThemeIcon>
                          <Text fw={600} size="sm">{provider.label}</Text>
                        </Group>
                        <Text size="xs" c="dimmed" lineClamp={2}>
                          {provider.description}
                        </Text>
                        <Group gap={4}>
                          {provider.categories.map((category) => (
                            <Badge key={category} variant="light" color="gray" size="sm">
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
          </Stack>
        </Stepper.Step>

        <Stepper.Step label={t('steps.credentials.label')} description={t('steps.credentials.description')}>
          <Stack gap="md" mt="md">
            {selectedProvider && (
              <Paper withBorder radius="md" p="md">
                <Group gap="sm">
                  <ThemeIcon variant="light" size="md" radius="md" color="blue">
                    <IconPlug size={18} />
                  </ThemeIcon>
                  <div>
                    <Text fw={600} size="sm">{selectedProvider.label}</Text>
                    <Text size="xs" c="dimmed">{selectedProvider.description}</Text>
                  </div>
                </Group>
              </Paper>
            )}

            <Stack gap="sm">
              {selectedProvider?.credentialFields.map((field) => {
                const value = form.values.settings[field.name] || '';

                if (field.type === 'select') {
                  return (
                    <Select
                      key={field.name}
                      label={field.label}
                      placeholder={field.placeholder}
                      data={field.options || []}
                      required={field.required}
                      value={value}
                      onChange={(val) => form.setFieldValue(`settings.${field.name}`, val || '')}
                      size="md"
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
                    onChange={(event) => form.setFieldValue(`settings.${field.name}`, event.currentTarget.value)}
                    size="md"
                  />
                );
              })}
              {!selectedProvider?.credentialFields?.length && (
                <Paper withBorder p="md" radius="md">
                  <Group gap="sm">
                    <ThemeIcon variant="light" size="md" radius="md" color="green">
                      <IconShieldCheck size={18} />
                    </ThemeIcon>
                    <Text size="sm">{t('steps.credentials.noCredentials')}</Text>
                  </Group>
                </Paper>
              )}
            </Stack>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label={t('steps.configuration.label')} description={t('steps.configuration.description')}>
          <Stack gap="md" mt="md">
            <Paper withBorder radius="md" p="md">
              <Text fw={600} size="sm" mb="sm">{t('steps.configuration.basicInfo')}</Text>
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
                    size="md"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <TextInput
                    label={t('fields.key.label')}
                    placeholder={t('fields.key.placeholder')}
                    value={form.values.key}
                    onChange={(event) => form.setFieldValue('key', slugify(event.currentTarget.value))}
                    size="md"
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
                    size="md"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <TextInput
                    label={t('fields.modelId.label')}
                    placeholder={selectedProvider?.modelIdHint || t('fields.modelId.placeholder')}
                    required
                    value={form.values.modelId}
                    onChange={(event) => form.setFieldValue('modelId', event.currentTarget.value)}
                    size="md"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <TextInput
                    label={t('fields.currency.label')}
                    value={form.values.pricing.currency}
                    onChange={(event) => form.setFieldValue('pricing.currency', event.currentTarget.value.toUpperCase().slice(0, 8))}
                    size="md"
                  />
                </Grid.Col>
              </Grid>
            </Paper>

            <Paper withBorder radius="md" p="md">
              <Text fw={600} size="sm" mb="sm">{t('fields.pricing.title')}</Text>
              <Grid>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={t('fields.pricing.prompt')}
                    value={form.values.pricing.inputTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.inputTokenPer1M', Number(value) || 0)}
                    min={0}
                    size="md"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={t('fields.pricing.completion')}
                    value={form.values.pricing.outputTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.outputTokenPer1M', Number(value) || 0)}
                    min={0}
                    size="md"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NumberInput
                    label={t('fields.pricing.cached')}
                    value={form.values.pricing.cachedTokenPer1M}
                    onChange={(value) => form.setFieldValue('pricing.cachedTokenPer1M', Number(value) || 0)}
                    min={0}
                    size="md"
                  />
                </Grid.Col>
              </Grid>
            </Paper>

            <Paper withBorder radius="md" p="md">
              <Text fw={600} size="sm" mb="sm">{t('steps.configuration.capabilities')}</Text>
              <Stack gap="sm">
                <Checkbox
                  label={t('fields.isMultimodal.label')}
                  description={t('fields.isMultimodal.description')}
                  checked={form.values.isMultimodal}
                  onChange={(event) => form.setFieldValue('isMultimodal', event.currentTarget.checked)}
                  size="md"
                />
                <Checkbox
                  label={t('fields.supportsToolCalls.label')}
                  description={t('fields.supportsToolCalls.description')}
                  checked={form.values.supportsToolCalls}
                  onChange={(event) => form.setFieldValue('supportsToolCalls', event.currentTarget.checked)}
                  size="md"
                />
              </Stack>
            </Paper>
          </Stack>
        </Stepper.Step>

        <Stepper.Completed>
          <Paper withBorder radius="md" p="md" mt="md">
            <Stack gap="md">
              <Group gap="sm">
                <ThemeIcon variant="light" size="lg" radius="md" color="green">
                  <IconSparkles size={20} />
                </ThemeIcon>
                <div>
                  <Title order={4}>{t('review.title')}</Title>
                  <Text size="xs" c="dimmed">
                    {t('review.subtitle')}
                  </Text>
                </div>
              </Group>

              <Paper withBorder radius="md" p="md" bg="var(--mantine-color-gray-0)">
                <Text fw={600} size="sm" mb="sm">{t('review.fields.modelDetails')}</Text>
                <Grid>
                  <Grid.Col span={{ base: 12, md: 6 }}>
                    <Stack gap={4}>
                      <Text size="xs" c="dimmed" tt="uppercase">{t('review.fields.name')}</Text>
                      <Text fw={500}>{form.values.name}</Text>
                    </Stack>
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 6 }}>
                    <Stack gap={4}>
                      <Text size="xs" c="dimmed" tt="uppercase">{t('review.fields.provider')}</Text>
                      <Text fw={500}>{selectedProvider?.label}</Text>
                    </Stack>
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 6 }}>
                    <Stack gap={4}>
                      <Text size="xs" c="dimmed" tt="uppercase">{t('review.fields.modelId')}</Text>
                      <Text fw={500} ff="monospace">{form.values.modelId}</Text>
                    </Stack>
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 6 }}>
                    <Stack gap={4}>
                      <Text size="xs" c="dimmed" tt="uppercase">{t('review.fields.key')}</Text>
                      <Text fw={500} ff="monospace">{form.values.key || t('review.autoGenerated')}</Text>
                    </Stack>
                  </Grid.Col>
                </Grid>
              </Paper>

              <Paper withBorder radius="md" p="md" bg="var(--mantine-color-gray-0)">
                <Text fw={600} size="sm" mb="sm">
                  {t('review.fields.pricing')}
                </Text>
                <Stack gap={4}>
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">Input tokens (per 1M):</Text>
                    <Text fw={500} size="sm">{form.values.pricing.inputTokenPer1M} {form.values.pricing.currency}</Text>
                  </Group>
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">Output tokens (per 1M):</Text>
                    <Text fw={500} size="sm">{form.values.pricing.outputTokenPer1M} {form.values.pricing.currency}</Text>
                  </Group>
                  {form.values.pricing.cachedTokenPer1M ? (
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed">Cached tokens (per 1M):</Text>
                      <Text fw={500} size="sm">{form.values.pricing.cachedTokenPer1M} {form.values.pricing.currency}</Text>
                    </Group>
                  ) : null}
                </Stack>
              </Paper>

              {(form.values.isMultimodal || form.values.supportsToolCalls) && (
                <Paper withBorder radius="md" p="md" bg="var(--mantine-color-gray-0)">
                  <Text fw={600} size="sm" mb="sm">{t('review.fields.capabilities')}</Text>
                  <Group gap="xs">
                    {form.values.isMultimodal && (
                      <Badge variant="light" size="md" color="blue">Multimodal</Badge>
                    )}
                    {form.values.supportsToolCalls && (
                      <Badge variant="light" size="md" color="blue">Tool Calls</Badge>
                    )}
                  </Group>
                </Paper>
              )}
            </Stack>
          </Paper>
        </Stepper.Completed>
      </Stepper>

      <Group justify="space-between" mt="md">
        <Button variant="default" onClick={handlePrev} disabled={activeStep === 0}>
          {t('actions.back')}
        </Button>

        {activeStep < 3 ? (
          <Button onClick={handleNext}>
            {t('actions.next')}
          </Button>
        ) : (
          <Button color="green" onClick={handleSubmit} leftSection={<IconSparkles size={18} />}>
            {t('actions.createModel')}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

*/
