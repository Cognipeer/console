'use client';

import { Modal, TextInput, Select, NumberInput, Stack, Group, Button, Tabs, Text, Switch, Divider, Paper } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useEffect } from 'react';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import type { QuotaDomain, QuotaScope, QuotaLimits } from '@/lib/quota/types';
import { useTranslations } from '@/lib/i18n';
import { ScopeIdSelector } from './ScopeIdSelector';

interface QuotaPolicyModalProps {
  opened: boolean;
  onClose: () => void;
  onSubmit: (data: QuotaPolicyFormData) => Promise<void>;
  policy?: IQuotaPolicy | null;
  loading?: boolean;
  defaultDomain?: QuotaDomain;
  allowedDomains?: QuotaDomain[];
  allowedScopes?: QuotaScope[];
  title?: string;
  resourceOptions?: { value: string; label: string }[];
}

export interface QuotaPolicyFormData {
  scope: QuotaScope;
  scopeId?: string;
  domain: QuotaDomain;
  priority: number;
  enabled: boolean;
  label?: string;
  description?: string;
  limits: QuotaLimits;
}

const toFormValue = (value?: number | string | null): number | '' => {
  if (value === undefined || value === null || value === '') return '';
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : '';
};

const fromFormValue = (
  value: number | string | '' | null | undefined,
): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

export function QuotaPolicyModal({
  opened,
  onClose,
  onSubmit,
  policy,
  loading = false,
  defaultDomain = 'global',
  allowedDomains,
  allowedScopes,
  title,
  resourceOptions = [],
}: QuotaPolicyModalProps) {
  const isEditing = !!policy;
  const t = useTranslations('settings.quotaSection.form');

  const emptyLimits: QuotaLimits = {
    rateLimit: { requests: {}, tokens: {} },
    perRequest: {},
    quotas: {},
    budget: {},
  };

  const form = useForm<QuotaPolicyFormData>({
    initialValues: {
      scope: 'tenant',
      scopeId: '',
      domain: defaultDomain,
      priority: 0,
      enabled: true,
      label: '',
      description: '',
      limits: emptyLimits,
    },
  });

  useEffect(() => {
    if (policy) {
      const normalizedLimits: QuotaLimits = {
        ...emptyLimits,
        ...policy.limits,
        rateLimit: {
          requests: {
            ...emptyLimits.rateLimit?.requests,
            ...policy.limits?.rateLimit?.requests,
          },
          tokens: {
            ...emptyLimits.rateLimit?.tokens,
            ...policy.limits?.rateLimit?.tokens,
          },
          vectors: {
            ...emptyLimits.rateLimit?.vectors,
            ...policy.limits?.rateLimit?.vectors,
          },
          files: {
            ...emptyLimits.rateLimit?.files,
            ...policy.limits?.rateLimit?.files,
          },
          storage: {
            ...emptyLimits.rateLimit?.storage,
            ...policy.limits?.rateLimit?.storage,
          },
        },
        perRequest: {
          ...emptyLimits.perRequest,
          ...policy.limits?.perRequest,
        },
        quotas: {
          ...emptyLimits.quotas,
          ...policy.limits?.quotas,
        },
        budget: {
          ...emptyLimits.budget,
          ...policy.limits?.budget,
        },
      };

      form.setValues({
        scope: policy.scope,
        scopeId: (policy as { scopeId?: string }).scopeId || '',
        domain: policy.domain,
        priority: (policy as { priority?: number }).priority || 0,
        enabled: (policy as { enabled?: boolean }).enabled !== false,
        label: (policy as { label?: string }).label || '',
        description: (policy as { description?: string }).description || '',
        limits: normalizedLimits,
      });
    } else {
      form.reset();
      form.setFieldValue('domain', defaultDomain);
      form.setFieldValue('limits', emptyLimits);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, opened, defaultDomain]);

  const handleSubmit = async (values: QuotaPolicyFormData) => {
    // Clean up empty values
    const cleanLimits: QuotaLimits = {};
    
    if (values.limits.rateLimit) {
      const { requests, tokens, vectors, files, storage } = values.limits.rateLimit;
      cleanLimits.rateLimit = {};

      if (requests && Object.values(requests).some(v => v !== undefined)) {
        cleanLimits.rateLimit.requests = requests;
      }
      if (tokens && Object.values(tokens).some(v => v !== undefined)) {
        cleanLimits.rateLimit.tokens = tokens;
      }
      if (vectors && Object.values(vectors).some(v => v !== undefined)) {
        cleanLimits.rateLimit.vectors = vectors;
      }
      if (files && Object.values(files).some(v => v !== undefined)) {
        cleanLimits.rateLimit.files = files;
      }
      if (storage && Object.values(storage).some(v => v !== undefined)) {
        cleanLimits.rateLimit.storage = storage;
      }

      if (Object.keys(cleanLimits.rateLimit).length === 0) {
        delete cleanLimits.rateLimit;
      }
    }
    
    if (values.limits.quotas && Object.values(values.limits.quotas).some(v => v !== undefined)) {
      cleanLimits.quotas = values.limits.quotas;
    }
    
    if (values.limits.perRequest && Object.values(values.limits.perRequest).some(v => v !== undefined)) {
      cleanLimits.perRequest = values.limits.perRequest;
    }
    
    if (values.limits.budget && Object.values(values.limits.budget).some(v => v !== undefined)) {
      cleanLimits.budget = values.limits.budget;
    }

    await onSubmit({
      ...values,
      scopeId: values.scopeId || undefined,
      limits: cleanLimits,
    });
  };

  const tScopes = useTranslations('settings.quotaSection.scopes');
  const tDomains = useTranslations('settings.quotaSection.domains');
  
  const scopeOptions = (allowedScopes || ['tenant', 'user', 'token', 'resource', 'provider'] as QuotaScope[]).map((s) => ({
    value: s,
    label: tScopes(s),
  }));

  const domainOptions = (allowedDomains || ['global', 'llm', 'embedding', 'vector', 'file', 'tracing'] as QuotaDomain[]).map((d) => ({
    value: d,
    label: tDomains(d),
  }));

  const showScopeId = form.values.scope !== 'tenant';
  const currentDomain = form.values.domain;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title || (isEditing ? t('title.edit') : t('title.create', { domain: tDomains(defaultDomain) }))}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          {/* Basic Info */}
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <TextInput
                label={t('label')}
                placeholder={t('labelPlaceholder')}
                {...form.getInputProps('label')}
              />
              <TextInput
                label={t('description')}
                placeholder={t('descriptionPlaceholder')}
                {...form.getInputProps('description')}
              />
              <Group grow>
                <Select
                  label={t('scope')}
                  data={scopeOptions}
                  {...form.getInputProps('scope')}
                />
                <Select
                  label={t('domain')}
                  data={domainOptions}
                  {...form.getInputProps('domain')}
                  disabled={allowedDomains?.length === 1}
                />
              </Group>
              {showScopeId && (
                <ScopeIdSelector
                  scope={form.values.scope}
                  value={form.values.scopeId}
                  onChange={(v) => form.setFieldValue('scopeId', v || '')}
                  resourceOptions={resourceOptions}
                />
              )}
              <Group grow>
                <NumberInput
                  label={t('priority')}
                  description={t('priorityDescription')}
                  min={0}
                  max={100}
                  {...form.getInputProps('priority')}
                />
                <Switch
                  label={t('enabled')}
                  description={t('enabledDescription')}
                  checked={form.values.enabled}
                  onChange={(e) => form.setFieldValue('enabled', e.currentTarget.checked)}
                  mt="xl"
                />
              </Group>
            </Stack>
          </Paper>

          {/* Limits Tabs */}
          <Tabs defaultValue="rate">
            <Tabs.List>
              <Tabs.Tab value="rate">{t('tabs.rate')}</Tabs.Tab>
              <Tabs.Tab value="quotas">{t('tabs.quotas')}</Tabs.Tab>
              <Tabs.Tab value="budget">{t('tabs.budget')}</Tabs.Tab>
            </Tabs.List>

            {/* Rate Limits */}
            <Tabs.Panel value="rate" pt="md">
              <Stack gap="md">
                <Text size="sm" fw={500}>{t('rateLimits.requests')}</Text>
                <Group grow>
                  <NumberInput
                    label={t('rateLimits.perMinute')}
                    placeholder={t('placeholder')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(form.values.limits.rateLimit?.requests?.perMinute)}
                    onChange={(v) => form.setFieldValue('limits.rateLimit.requests.perMinute', fromFormValue(v))}
                  />
                  <NumberInput
                    label={t('rateLimits.perHour')}
                    placeholder={t('placeholder')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(form.values.limits.rateLimit?.requests?.perHour)}
                    onChange={(v) => form.setFieldValue('limits.rateLimit.requests.perHour', fromFormValue(v))}
                  />
                </Group>
                <Group grow>
                  <NumberInput
                    label={t('rateLimits.perDay')}
                    placeholder={t('placeholder')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(form.values.limits.rateLimit?.requests?.perDay)}
                    onChange={(v) => form.setFieldValue('limits.rateLimit.requests.perDay', fromFormValue(v))}
                  />
                  <NumberInput
                    label={t('rateLimits.perMonth')}
                    placeholder={t('placeholder')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(form.values.limits.rateLimit?.requests?.perMonth)}
                    onChange={(v) => form.setFieldValue('limits.rateLimit.requests.perMonth', fromFormValue(v))}
                  />
                </Group>
                <NumberInput
                  label={t('perRequest.maxConcurrentRequests')}
                  placeholder={t('placeholder')}
                  min={0}
                  allowDecimal={false}
                  value={toFormValue(form.values.limits.perRequest?.maxConcurrentRequests)}
                  onChange={(v) => form.setFieldValue('limits.perRequest.maxConcurrentRequests', fromFormValue(v))}
                />
                
                {/* Tokens (LLM/Embedding) */}
                {(currentDomain === 'global' || currentDomain === 'llm' || currentDomain === 'embedding') && (
                  <>
                    <Divider my="xs" />
                    <Text size="sm" fw={500}>{t('rateLimits.tokens')}</Text>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perMinute')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.tokens?.perMinute)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.tokens.perMinute', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perHour')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.tokens?.perHour)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.tokens.perHour', fromFormValue(v))}
                      />
                    </Group>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perDay')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.tokens?.perDay)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.tokens.perDay', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perMonth')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.tokens?.perMonth)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.tokens.perMonth', fromFormValue(v))}
                      />
                    </Group>
                    <Group grow>
                      <NumberInput
                        label={t('perRequest.maxInputTokens')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxInputTokens)}
                        onChange={(v) => form.setFieldValue('limits.perRequest.maxInputTokens', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('perRequest.maxOutputTokens')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxOutputTokens)}
                        onChange={(v) => form.setFieldValue('limits.perRequest.maxOutputTokens', fromFormValue(v))}
                      />
                    </Group>
                    <NumberInput
                      label={t('perRequest.maxTotalTokens')}
                      placeholder={t('placeholder')}
                      min={0}
                      allowDecimal={false}
                      value={toFormValue(form.values.limits.perRequest?.maxTotalTokens)}
                      onChange={(v) => form.setFieldValue('limits.perRequest.maxTotalTokens', fromFormValue(v))}
                    />
                  </>
                )}

                {/* Vectors */}
                {(currentDomain === 'global' || currentDomain === 'vector') && (
                  <>
                    <Divider my="xs" />
                    <Text size="sm" fw={500}>{t('rateLimits.vectors')}</Text>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perMinute')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.vectors?.perMinute)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.vectors.perMinute', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perHour')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.vectors?.perHour)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.vectors.perHour', fromFormValue(v))}
                      />
                    </Group>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perDay')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.vectors?.perDay)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.vectors.perDay', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perMonth')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.vectors?.perMonth)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.vectors.perMonth', fromFormValue(v))}
                      />
                    </Group>
                    <Group grow>
                      <NumberInput
                        label={t('perRequest.maxVectorsPerUpsert')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxVectorsPerUpsert)}
                        onChange={(v) => form.setFieldValue('limits.perRequest.maxVectorsPerUpsert', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('perRequest.maxQueryResults')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxQueryResults)}
                        onChange={(v) => form.setFieldValue('limits.perRequest.maxQueryResults', fromFormValue(v))}
                      />
                    </Group>
                  </>
                )}

                {/* Files */}
                {(currentDomain === 'global' || currentDomain === 'file') && (
                  <>
                    <Divider my="xs" />
                    <Text size="sm" fw={500}>{t('rateLimits.files')}</Text>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perMinute')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.files?.perMinute)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.files.perMinute', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perHour')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.files?.perHour)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.files.perHour', fromFormValue(v))}
                      />
                    </Group>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perDay')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.files?.perDay)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.files.perDay', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perMonth')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.files?.perMonth)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.files.perMonth', fromFormValue(v))}
                      />
                    </Group>
                    <Group grow>
                      <NumberInput
                        label={t('perRequest.maxFileSizeMB')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxFileSize ? form.values.limits.perRequest.maxFileSize / 1024 / 1024 : undefined)}
                        onChange={(v) => {
                          const mb = fromFormValue(v);
                          form.setFieldValue(
                            'limits.perRequest.maxFileSize',
                            mb === undefined ? undefined : mb * 1024 * 1024,
                          );
                        }}
                      />
                      <NumberInput
                        label={t('perRequest.maxFilesPerRequest')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxFilesPerRequest)}
                        onChange={(v) => form.setFieldValue('limits.perRequest.maxFilesPerRequest', fromFormValue(v))}
                      />
                    </Group>
                  </>
                )}

                {/* Storage */}
                {(currentDomain === 'global' || currentDomain === 'file') && (
                  <>
                    <Divider my="xs" />
                    <Text size="sm" fw={500}>{t('rateLimits.storage')}</Text>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perMinute')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.storage?.perMinute)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.storage.perMinute', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perHour')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.storage?.perHour)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.storage.perHour', fromFormValue(v))}
                      />
                    </Group>
                    <Group grow>
                      <NumberInput
                        label={t('rateLimits.perDay')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.storage?.perDay)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.storage.perDay', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('rateLimits.perMonth')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.rateLimit?.storage?.perMonth)}
                        onChange={(v) => form.setFieldValue('limits.rateLimit.storage.perMonth', fromFormValue(v))}
                      />
                    </Group>
                  </>
                )}

                {/* Tracing */}
                {(currentDomain === 'global' || currentDomain === 'tracing') && (
                  <>
                    <Divider my="xs" />
                    <Text size="sm" fw={500}>{t('perRequest.tracing')}</Text>
                    <Group grow>
                      <NumberInput
                        label={t('perRequest.maxEventsPerSession')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxEventsPerSession)}
                        onChange={(v) => form.setFieldValue('limits.perRequest.maxEventsPerSession', fromFormValue(v))}
                      />
                      <NumberInput
                        label={t('perRequest.maxSessionDurationSec')}
                        placeholder={t('placeholder')}
                        min={0}
                        allowDecimal={false}
                        value={toFormValue(form.values.limits.perRequest?.maxSessionDurationMs ? form.values.limits.perRequest.maxSessionDurationMs / 1000 : undefined)}
                        onChange={(v) => {
                          const seconds = fromFormValue(v);
                          form.setFieldValue(
                            'limits.perRequest.maxSessionDurationMs',
                            seconds === undefined ? undefined : seconds * 1000,
                          );
                        }}
                      />
                    </Group>
                  </>
                )}
              </Stack>
            </Tabs.Panel>

            {/* Resource Quotas */}
            <Tabs.Panel value="quotas" pt="md">
              <Stack gap="md">
                <Text size="sm" c="dimmed">
                  {t('quotas.description')}
                </Text>
                
                {/* Creation Limits - Only for Tenant/User scopes */}
                {(form.values.scope === 'tenant' || form.values.scope === 'user') && (
                  <>
                    <Group grow>
                      {(currentDomain === 'global' || currentDomain === 'llm') && (
                        <NumberInput
                          label={t('quotas.maxModels')}
                          placeholder={t('planLimit')}
                          min={0}
                          allowDecimal={false}
                          value={toFormValue(form.values.limits.quotas?.maxModels)}
                          onChange={(v) => form.setFieldValue('limits.quotas.maxModels', fromFormValue(v))}
                        />
                      )}
                      {(currentDomain === 'global' || currentDomain === 'vector') && (
                        <NumberInput
                          label={t('quotas.maxVectorIndexes')}
                          placeholder={t('planLimit')}
                          min={0}
                          allowDecimal={false}
                          value={toFormValue(form.values.limits.quotas?.maxVectorIndexes)}
                          onChange={(v) => form.setFieldValue('limits.quotas.maxVectorIndexes', fromFormValue(v))}
                        />
                      )}
                    </Group>

                    <Group grow>
                      {(currentDomain === 'global' || currentDomain === 'file') && (
                        <NumberInput
                          label={t('quotas.maxFileBuckets')}
                          placeholder={t('planLimit')}
                          min={0}
                          allowDecimal={false}
                          value={toFormValue(form.values.limits.quotas?.maxFileBuckets)}
                          onChange={(v) => form.setFieldValue('limits.quotas.maxFileBuckets', fromFormValue(v))}
                        />
                      )}
                      {(currentDomain === 'global' || currentDomain === 'tracing') && (
                        <NumberInput
                          label={t('quotas.maxTracingSessions')}
                          placeholder={t('planLimit')}
                          min={0}
                          allowDecimal={false}
                          value={toFormValue(form.values.limits.quotas?.maxTracingSessions)}
                          onChange={(v) => form.setFieldValue('limits.quotas.maxTracingSessions', fromFormValue(v))}
                        />
                      )}
                    </Group>

                    {/* Tenant Management - Only for Global & Tenant scope */}
                    {currentDomain === 'global' && form.values.scope === 'tenant' && (
                      <Group grow>
                        <NumberInput
                          label={t('quotas.maxApiTokens')}
                          placeholder={t('planLimit')}
                          min={0}
                          allowDecimal={false}
                          value={toFormValue(form.values.limits.quotas?.maxApiTokens)}
                          onChange={(v) => form.setFieldValue('limits.quotas.maxApiTokens', fromFormValue(v))}
                        />
                        <NumberInput
                          label={t('quotas.maxUsers')}
                          placeholder={t('planLimit')}
                          min={0}
                          allowDecimal={false}
                          value={toFormValue(form.values.limits.quotas?.maxUsers)}
                          onChange={(v) => form.setFieldValue('limits.quotas.maxUsers', fromFormValue(v))}
                        />
                      </Group>
                    )}
                  </>
                )}

                {/* Usage Limits - Available for Resource scope too */}
                <Group grow>
                  {(currentDomain === 'global' || currentDomain === 'vector') && (
                    <NumberInput
                      label={t('quotas.maxVectorsTotal')}
                      placeholder={t('placeholder')}
                      min={0}
                      allowDecimal={false}
                      value={toFormValue(form.values.limits.quotas?.maxVectorsTotal)}
                      onChange={(v) => form.setFieldValue('limits.quotas.maxVectorsTotal', fromFormValue(v))}
                    />
                  )}
                  {(currentDomain === 'global' || currentDomain === 'file') && (
                    <NumberInput
                      label={t('quotas.maxStorageMB')}
                      placeholder={t('placeholder')}
                      min={0}
                      allowDecimal={false}
                      value={toFormValue(form.values.limits.quotas?.maxStorageBytes ? form.values.limits.quotas.maxStorageBytes / 1024 / 1024 : undefined)}
                      onChange={(v) => {
                        const mb = fromFormValue(v);
                        form.setFieldValue(
                          'limits.quotas.maxStorageBytes',
                          mb === undefined ? undefined : mb * 1024 * 1024,
                        );
                      }}
                    />
                  )}
                </Group>
              </Stack>
            </Tabs.Panel>

            {/* Budget */}
            <Tabs.Panel value="budget" pt="md">
              <Stack gap="md">
                <Text size="sm" c="dimmed">
                  {t('budget.description')}
                </Text>
                <Group grow>
                  <NumberInput
                    label={t('budget.dailyLimit')}
                    placeholder={t('placeholder')}
                    min={0}
                    decimalScale={2}
                    value={toFormValue(form.values.limits.budget?.dailySpendLimit)}
                    onChange={(v) => form.setFieldValue('limits.budget.dailySpendLimit', fromFormValue(v))}
                  />
                  <NumberInput
                    label={t('budget.monthlyLimit')}
                    placeholder={t('placeholder')}
                    min={0}
                    decimalScale={2}
                    value={toFormValue(form.values.limits.budget?.monthlySpendLimit)}
                    onChange={(v) => form.setFieldValue('limits.budget.monthlySpendLimit', fromFormValue(v))}
                  />
                </Group>
              </Stack>
            </Tabs.Panel>
          </Tabs>

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose} disabled={loading}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" loading={loading}>
              {isEditing ? t('actions.update') : t('actions.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
