'use client';

import { NumberInput, Select, Switch, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useEffect, useMemo } from 'react';
import { IconBolt, IconGauge } from '@tabler/icons-react';
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

const hasAnyValue = (obj?: object | null) =>
  !!obj &&
  Object.values(obj as Record<string, unknown>).some(
    (v) => v !== undefined && v !== null && v !== '',
  );

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
  const tScopes = useTranslations('settings.quotaSection.scopes');
  const tDomains = useTranslations('settings.quotaSection.domains');

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

  const handleSubmit = async () => {
    const values = form.getValues();

    // Clean up empty values
    const cleanLimits: QuotaLimits = {};

    if (values.limits.rateLimit) {
      const { requests, tokens, vectors, files, storage } = values.limits.rateLimit;
      cleanLimits.rateLimit = {};

      if (requests && Object.values(requests).some((v) => v !== undefined)) {
        cleanLimits.rateLimit.requests = requests;
      }
      if (tokens && Object.values(tokens).some((v) => v !== undefined)) {
        cleanLimits.rateLimit.tokens = tokens;
      }
      if (vectors && Object.values(vectors).some((v) => v !== undefined)) {
        cleanLimits.rateLimit.vectors = vectors;
      }
      if (files && Object.values(files).some((v) => v !== undefined)) {
        cleanLimits.rateLimit.files = files;
      }
      if (storage && Object.values(storage).some((v) => v !== undefined)) {
        cleanLimits.rateLimit.storage = storage;
      }

      if (Object.keys(cleanLimits.rateLimit).length === 0) {
        delete cleanLimits.rateLimit;
      }
    }

    if (values.limits.quotas && Object.values(values.limits.quotas).some((v) => v !== undefined)) {
      cleanLimits.quotas = values.limits.quotas;
    }

    if (
      values.limits.perRequest &&
      Object.values(values.limits.perRequest).some((v) => v !== undefined)
    ) {
      cleanLimits.perRequest = values.limits.perRequest;
    }

    if (values.limits.budget && Object.values(values.limits.budget).some((v) => v !== undefined)) {
      cleanLimits.budget = values.limits.budget;
    }

    await onSubmit({
      ...values,
      scopeId: values.scopeId || undefined,
      limits: cleanLimits,
    });
  };

  const scopeOptions = (allowedScopes ||
    (['tenant', 'user', 'token', 'resource', 'provider'] as QuotaScope[])).map((s) => ({
    value: s,
    label: tScopes(s),
  }));

  const domainOptions = (allowedDomains ||
    (['global', 'llm', 'embedding', 'vector', 'file', 'tracing'] as QuotaDomain[])).map((d) => ({
    value: d,
    label: tDomains(d),
  }));

  const showScopeId = form.values.scope !== 'tenant';
  const currentDomain = form.values.domain;
  const currentScope = form.values.scope;
  const values = form.values;
  const limits = values.limits;

  const showTokens =
    currentDomain === 'global' || currentDomain === 'llm' || currentDomain === 'embedding';
  const showVectors = currentDomain === 'global' || currentDomain === 'vector';
  const showFiles = currentDomain === 'global' || currentDomain === 'file';
  const showStorage = currentDomain === 'global' || currentDomain === 'file';
  const showTracing = currentDomain === 'global' || currentDomain === 'tracing';
  const showCreationQuotas = currentScope === 'tenant' || currentScope === 'user';

  // Validation/checklist signals
  const identityDone = !!values.label && !!values.domain;
  const scopeDone =
    !!values.scope && (currentScope === 'tenant' || !!values.scopeId);
  const limitsDone =
    hasAnyValue(limits.rateLimit?.requests) ||
    hasAnyValue(limits.rateLimit?.tokens) ||
    hasAnyValue(limits.rateLimit?.vectors) ||
    hasAnyValue(limits.rateLimit?.files) ||
    hasAnyValue(limits.rateLimit?.storage) ||
    hasAnyValue(limits.perRequest) ||
    hasAnyValue(limits.quotas) ||
    hasAnyValue(limits.budget);

  const checklist = useMemo(
    () => [
      { id: 1, label: 'Label set', done: !!values.label },
      { id: 2, label: 'Domain chosen', done: !!values.domain },
      { id: 3, label: 'Scope target valid', done: scopeDone },
      { id: 4, label: 'At least one limit configured', done: limitsDone },
      { id: 5, label: 'Active', done: values.enabled },
    ],
    [values.label, values.domain, scopeDone, limitsDone, values.enabled],
  );

  const headerTitle =
    title || (isEditing ? t('title.edit') : t('title.create', { domain: tDomains(defaultDomain) }));

  const summary = (
    <>
      <SummaryGroup title="Identity">
        <SummaryKV
          label="Label"
          value={values.label || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Description"
          value={values.description || <span className="ds-faint">—</span>}
        />
        <SummaryKV label="Priority" value={values.priority ?? 0} mono />
        <SummaryKV label="Status" value={values.enabled ? 'enabled' : 'disabled'} />
      </SummaryGroup>

      <SummaryGroup title="Scope">
        <SummaryKV label="Domain" value={tDomains(values.domain)} />
        <SummaryKV label="Scope" value={tScopes(values.scope)} />
        {showScopeId ? (
          <SummaryKV
            label="Target"
            value={values.scopeId || <span className="ds-faint">—</span>}
            mono
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Limits">
        <SummaryKV
          label="Request RPM"
          value={toFormValue(limits.rateLimit?.requests?.perMinute) || '—'}
          mono
        />
        <SummaryKV
          label="Request RPH"
          value={toFormValue(limits.rateLimit?.requests?.perHour) || '—'}
          mono
        />
        {showTokens ? (
          <>
            <SummaryKV
              label="Token TPM"
              value={toFormValue(limits.rateLimit?.tokens?.perMinute) || '—'}
              mono
            />
            <SummaryKV
              label="Max input"
              value={toFormValue(limits.perRequest?.maxInputTokens) || '—'}
              mono
            />
            <SummaryKV
              label="Max output"
              value={toFormValue(limits.perRequest?.maxOutputTokens) || '—'}
              mono
            />
          </>
        ) : null}
        {showFiles ? (
          <SummaryKV
            label="Max file size (MB)"
            value={
              limits.perRequest?.maxFileSize
                ? Math.round(limits.perRequest.maxFileSize / 1024 / 1024)
                : '—'
            }
            mono
          />
        ) : null}
        <SummaryKV
          label="Daily $"
          value={toFormValue(limits.budget?.dailySpendLimit) || '—'}
          mono
        />
        <SummaryKV
          label="Monthly $"
          value={toFormValue(limits.budget?.monthlySpendLimit) || '—'}
          mono
        />
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const readyCount = checklist.filter((c) => c.done).length;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconGauge size={16} />}
      title={headerTitle}
      subtitle="Configure rate limits, resource quotas, and budgets for this scope."
      summary={summary}
      footerStatus={`${readyCount} of ${checklist.length} ready`}
      primaryAction={{
        label: isEditing ? t('actions.update') : t('actions.create'),
        icon: <IconBolt size={13} />,
        loading,
        disabled: !values.label || !values.domain || !scopeDone,
        onClick: handleSubmit,
      }}
      secondaryAction={{
        label: t('actions.cancel'),
        onClick: onClose,
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="How this policy is identified across the console."
        done={identityDone}
      >
        <FormRow cols={1}>
          <FormField label={t('label')} required>
            <TextInput
              placeholder={t('labelPlaceholder')}
              {...form.getInputProps('label')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('description')} optional>
            <Textarea
              placeholder={t('descriptionPlaceholder')}
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField
            label={t('priority')}
            hint={t('priorityDescription')}
          >
            <NumberInput min={0} max={100} {...form.getInputProps('priority')} />
          </FormField>
          <FormField label={t('enabled')} hint={t('enabledDescription')}>
            <Switch
              checked={values.enabled}
              onChange={(e) => form.setFieldValue('enabled', e.currentTarget.checked)}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Scope"
        description="Choose which domain this policy targets and to whom it applies."
        done={scopeDone}
      >
        <FormRow cols={1}>
          <FormField label={t('domain')} required>
            <Select
              data={domainOptions}
              value={values.domain}
              onChange={(v) => form.setFieldValue('domain', (v as QuotaDomain) || defaultDomain)}
              disabled={allowedDomains?.length === 1}
              allowDeselect={false}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('scope')} required>
            <ChipPicker<QuotaScope>
              options={scopeOptions}
              value={values.scope}
              onChange={(v) => form.setFieldValue('scope', v as QuotaScope)}
            />
          </FormField>
        </FormRow>
        {showScopeId ? (
          <FormRow cols={1}>
            <FormField label={t('scopeId')} required hint={t('scopeIdDescription')}>
              <ScopeIdSelector
                scope={values.scope}
                value={values.scopeId}
                onChange={(v) => form.setFieldValue('scopeId', v || '')}
                resourceOptions={resourceOptions}
              />
            </FormField>
          </FormRow>
        ) : null}
      </FormSection>

      <FormSection
        number={3}
        title="Request rate limits"
        description="Cap how many requests can be made within rolling windows."
      >
        <FormRow cols={2}>
          <FormField label={t('rateLimits.perMinute')} optional>
            <NumberInput
              placeholder={t('placeholder')}
              min={0}
              allowDecimal={false}
              value={toFormValue(limits.rateLimit?.requests?.perMinute)}
              onChange={(v) =>
                form.setFieldValue('limits.rateLimit.requests.perMinute', fromFormValue(v))
              }
            />
          </FormField>
          <FormField label={t('rateLimits.perHour')} optional>
            <NumberInput
              placeholder={t('placeholder')}
              min={0}
              allowDecimal={false}
              value={toFormValue(limits.rateLimit?.requests?.perHour)}
              onChange={(v) =>
                form.setFieldValue('limits.rateLimit.requests.perHour', fromFormValue(v))
              }
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label={t('rateLimits.perDay')} optional>
            <NumberInput
              placeholder={t('placeholder')}
              min={0}
              allowDecimal={false}
              value={toFormValue(limits.rateLimit?.requests?.perDay)}
              onChange={(v) =>
                form.setFieldValue('limits.rateLimit.requests.perDay', fromFormValue(v))
              }
            />
          </FormField>
          <FormField label={t('rateLimits.perMonth')} optional>
            <NumberInput
              placeholder={t('placeholder')}
              min={0}
              allowDecimal={false}
              value={toFormValue(limits.rateLimit?.requests?.perMonth)}
              onChange={(v) =>
                form.setFieldValue('limits.rateLimit.requests.perMonth', fromFormValue(v))
              }
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('perRequest.maxConcurrentRequests')} optional>
            <NumberInput
              placeholder={t('placeholder')}
              min={0}
              allowDecimal={false}
              value={toFormValue(limits.perRequest?.maxConcurrentRequests)}
              onChange={(v) =>
                form.setFieldValue('limits.perRequest.maxConcurrentRequests', fromFormValue(v))
              }
            />
          </FormField>
        </FormRow>
      </FormSection>

      {showTokens ? (
        <FormSection
          number={4}
          title={t('rateLimits.tokens')}
          description="Throttle token throughput for LLM and embedding workloads."
        >
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perMinute')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.tokens?.perMinute)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.tokens.perMinute', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perHour')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.tokens?.perHour)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.tokens.perHour', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perDay')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.tokens?.perDay)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.tokens.perDay', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perMonth')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.tokens?.perMonth)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.tokens.perMonth', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label={t('perRequest.maxInputTokens')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.perRequest?.maxInputTokens)}
                onChange={(v) =>
                  form.setFieldValue('limits.perRequest.maxInputTokens', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('perRequest.maxOutputTokens')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.perRequest?.maxOutputTokens)}
                onChange={(v) =>
                  form.setFieldValue('limits.perRequest.maxOutputTokens', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label={t('perRequest.maxTotalTokens')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.perRequest?.maxTotalTokens)}
                onChange={(v) =>
                  form.setFieldValue('limits.perRequest.maxTotalTokens', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
        </FormSection>
      ) : null}

      {showVectors ? (
        <FormSection
          number={5}
          title={t('rateLimits.vectors')}
          description="Upsert and query throughput for vector indexes."
        >
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perMinute')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.vectors?.perMinute)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.vectors.perMinute', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perHour')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.vectors?.perHour)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.vectors.perHour', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perDay')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.vectors?.perDay)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.vectors.perDay', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perMonth')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.vectors?.perMonth)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.vectors.perMonth', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label={t('perRequest.maxVectorsPerUpsert')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.perRequest?.maxVectorsPerUpsert)}
                onChange={(v) =>
                  form.setFieldValue('limits.perRequest.maxVectorsPerUpsert', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('perRequest.maxQueryResults')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.perRequest?.maxQueryResults)}
                onChange={(v) =>
                  form.setFieldValue('limits.perRequest.maxQueryResults', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
        </FormSection>
      ) : null}

      {showFiles ? (
        <FormSection
          number={6}
          title={t('rateLimits.files')}
          description="Per-request and rate limits for file operations."
        >
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perMinute')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.files?.perMinute)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.files.perMinute', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perHour')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.files?.perHour)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.files.perHour', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perDay')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.files?.perDay)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.files.perDay', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perMonth')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.files?.perMonth)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.files.perMonth', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label={t('perRequest.maxFileSizeMB')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(
                  limits.perRequest?.maxFileSize
                    ? limits.perRequest.maxFileSize / 1024 / 1024
                    : undefined,
                )}
                onChange={(v) => {
                  const mb = fromFormValue(v);
                  form.setFieldValue(
                    'limits.perRequest.maxFileSize',
                    mb === undefined ? undefined : mb * 1024 * 1024,
                  );
                }}
              />
            </FormField>
            <FormField label={t('perRequest.maxFilesPerRequest')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.perRequest?.maxFilesPerRequest)}
                onChange={(v) =>
                  form.setFieldValue('limits.perRequest.maxFilesPerRequest', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
        </FormSection>
      ) : null}

      {showStorage ? (
        <FormSection
          number={7}
          title={t('rateLimits.storage')}
          description="Throttle storage I/O measured in bytes."
        >
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perMinute')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.storage?.perMinute)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.storage.perMinute', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perHour')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.storage?.perHour)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.storage.perHour', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label={t('rateLimits.perDay')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.storage?.perDay)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.storage.perDay', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('rateLimits.perMonth')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.rateLimit?.storage?.perMonth)}
                onChange={(v) =>
                  form.setFieldValue('limits.rateLimit.storage.perMonth', fromFormValue(v))
                }
              />
            </FormField>
          </FormRow>
        </FormSection>
      ) : null}

      {showTracing ? (
        <FormSection
          number={8}
          title={t('perRequest.tracing')}
          description="Limits for observability session size and duration."
        >
          <FormRow cols={2}>
            <FormField label={t('perRequest.maxEventsPerSession')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.perRequest?.maxEventsPerSession)}
                onChange={(v) =>
                  form.setFieldValue('limits.perRequest.maxEventsPerSession', fromFormValue(v))
                }
              />
            </FormField>
            <FormField label={t('perRequest.maxSessionDurationSec')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(
                  limits.perRequest?.maxSessionDurationMs
                    ? limits.perRequest.maxSessionDurationMs / 1000
                    : undefined,
                )}
                onChange={(v) => {
                  const seconds = fromFormValue(v);
                  form.setFieldValue(
                    'limits.perRequest.maxSessionDurationMs',
                    seconds === undefined ? undefined : seconds * 1000,
                  );
                }}
              />
            </FormField>
          </FormRow>
        </FormSection>
      ) : null}

      <FormSection
        number={9}
        title="Resource quotas"
        description={t('quotas.description')}
      >
        {showCreationQuotas ? (
          <>
            <FormRow cols={2}>
              {showTokens ? (
                <FormField label={t('quotas.maxModels')} optional>
                  <NumberInput
                    placeholder={t('planLimit')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(limits.quotas?.maxModels)}
                    onChange={(v) =>
                      form.setFieldValue('limits.quotas.maxModels', fromFormValue(v))
                    }
                  />
                </FormField>
              ) : (
                <div />
              )}
              {showVectors ? (
                <FormField label={t('quotas.maxVectorIndexes')} optional>
                  <NumberInput
                    placeholder={t('planLimit')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(limits.quotas?.maxVectorIndexes)}
                    onChange={(v) =>
                      form.setFieldValue('limits.quotas.maxVectorIndexes', fromFormValue(v))
                    }
                  />
                </FormField>
              ) : (
                <div />
              )}
            </FormRow>
            <FormRow cols={2}>
              {showFiles ? (
                <FormField label={t('quotas.maxFileBuckets')} optional>
                  <NumberInput
                    placeholder={t('planLimit')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(limits.quotas?.maxFileBuckets)}
                    onChange={(v) =>
                      form.setFieldValue('limits.quotas.maxFileBuckets', fromFormValue(v))
                    }
                  />
                </FormField>
              ) : (
                <div />
              )}
              {showTracing ? (
                <FormField label={t('quotas.maxTracingSessions')} optional>
                  <NumberInput
                    placeholder={t('planLimit')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(limits.quotas?.maxTracingSessions)}
                    onChange={(v) =>
                      form.setFieldValue('limits.quotas.maxTracingSessions', fromFormValue(v))
                    }
                  />
                </FormField>
              ) : (
                <div />
              )}
            </FormRow>
            {currentDomain === 'global' && currentScope === 'tenant' ? (
              <FormRow cols={2}>
                <FormField label={t('quotas.maxApiTokens')} optional>
                  <NumberInput
                    placeholder={t('planLimit')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(limits.quotas?.maxApiTokens)}
                    onChange={(v) =>
                      form.setFieldValue('limits.quotas.maxApiTokens', fromFormValue(v))
                    }
                  />
                </FormField>
                <FormField label={t('quotas.maxUsers')} optional>
                  <NumberInput
                    placeholder={t('planLimit')}
                    min={0}
                    allowDecimal={false}
                    value={toFormValue(limits.quotas?.maxUsers)}
                    onChange={(v) =>
                      form.setFieldValue('limits.quotas.maxUsers', fromFormValue(v))
                    }
                  />
                </FormField>
              </FormRow>
            ) : null}
          </>
        ) : null}

        <FormRow cols={2}>
          {showVectors ? (
            <FormField label={t('quotas.maxVectorsTotal')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(limits.quotas?.maxVectorsTotal)}
                onChange={(v) =>
                  form.setFieldValue('limits.quotas.maxVectorsTotal', fromFormValue(v))
                }
              />
            </FormField>
          ) : (
            <div />
          )}
          {showFiles ? (
            <FormField label={t('quotas.maxStorageMB')} optional>
              <NumberInput
                placeholder={t('placeholder')}
                min={0}
                allowDecimal={false}
                value={toFormValue(
                  limits.quotas?.maxStorageBytes
                    ? limits.quotas.maxStorageBytes / 1024 / 1024
                    : undefined,
                )}
                onChange={(v) => {
                  const mb = fromFormValue(v);
                  form.setFieldValue(
                    'limits.quotas.maxStorageBytes',
                    mb === undefined ? undefined : mb * 1024 * 1024,
                  );
                }}
              />
            </FormField>
          ) : (
            <div />
          )}
        </FormRow>
      </FormSection>

      <FormSection
        number={10}
        title={t('tabs.budget')}
        description={t('budget.description')}
      >
        <FormRow cols={2}>
          <FormField label={t('budget.dailyLimit')} optional>
            <NumberInput
              placeholder={t('placeholder')}
              min={0}
              decimalScale={2}
              value={toFormValue(limits.budget?.dailySpendLimit)}
              onChange={(v) =>
                form.setFieldValue('limits.budget.dailySpendLimit', fromFormValue(v))
              }
            />
          </FormField>
          <FormField label={t('budget.monthlyLimit')} optional>
            <NumberInput
              placeholder={t('placeholder')}
              min={0}
              decimalScale={2}
              value={toFormValue(limits.budget?.monthlySpendLimit)}
              onChange={(v) =>
                form.setFieldValue('limits.budget.monthlySpendLimit', fromFormValue(v))
              }
            />
          </FormField>
        </FormRow>
      </FormSection>

      {/* Keep ToggleList/ToggleRow imports usage for status reaffirmation */}
      <FormSection
        number={11}
        title="Activation"
        description="Make the policy active or staged for later enablement."
        done={values.enabled}
      >
        <ToggleList>
          <ToggleRow
            label={t('enabled')}
            description={t('enabledDescription')}
            checked={values.enabled}
            onChange={(v) => form.setFieldValue('enabled', v)}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}
