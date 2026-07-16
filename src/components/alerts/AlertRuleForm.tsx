'use client';

import { NumberInput, Select, TagsInput, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useState, useMemo, useEffect } from 'react';
import { IconBell } from '@tabler/icons-react';
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
import { useTranslations } from '@/lib/i18n';

interface AlertRuleFormProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: Record<string, unknown>;
  mode?: 'create' | 'edit';
  ruleId?: string;
}

/* ── Module definitions ─────────────────────────────────────────────── */

const MODULE_OPTIONS = [
  { value: 'models', label: 'Models' },
  { value: 'inference', label: 'Inference Servers' },
  { value: 'guardrails', label: 'Guardrails' },
  { value: 'rag', label: 'Knowledge Engine' },
  { value: 'mcp', label: 'MCP Servers' },
  { value: 'evaluation', label: 'Evaluation' },
  { value: 'analysis', label: 'Analysis' },
  { value: 'redteam', label: 'Red Team' },
];

const MODULE_METRICS: Record<string, Array<{ value: string; label: string }>> = {
  models: [
    { value: 'error_rate', label: 'Error Rate (%)' },
    { value: 'avg_latency_ms', label: 'Average Latency (ms)' },
    { value: 'p95_latency_ms', label: 'P95 Latency (ms)' },
    { value: 'total_cost', label: 'Total Cost (USD)' },
    { value: 'total_requests', label: 'Total Requests' },
  ],
  inference: [
    { value: 'gpu_cache_usage', label: 'GPU Cache Usage (%)' },
    { value: 'request_queue_depth', label: 'Request Queue Depth' },
  ],
  guardrails: [
    { value: 'guardrail_fail_rate', label: 'Fail Rate (%)' },
    { value: 'guardrail_avg_latency_ms', label: 'Average Latency (ms)' },
    { value: 'guardrail_total_evaluations', label: 'Total Evaluations' },
  ],
  rag: [
    { value: 'rag_avg_latency_ms', label: 'Avg Query Latency (ms)' },
    { value: 'rag_total_queries', label: 'Total Queries' },
    { value: 'rag_failed_documents', label: 'Failed Documents' },
  ],
  mcp: [
    { value: 'mcp_error_rate', label: 'Error Rate (%)' },
    { value: 'mcp_avg_latency_ms', label: 'Avg Latency (ms)' },
    { value: 'mcp_total_requests', label: 'Total Requests' },
  ],
  evaluation: [
    { value: 'evaluation_pass_rate', label: 'Pass Rate (%)' },
    { value: 'evaluation_avg_score', label: 'Average Score (%)' },
  ],
  analysis: [
    { value: 'analysis_pass_rate', label: 'Pass Rate (%)' },
    { value: 'analysis_avg_judge_score', label: 'Average Judge Score (%)' },
    { value: 'analysis_avg_accuracy', label: 'Average Accuracy (%)' },
  ],
  redteam: [
    { value: 'redteam_attack_success_rate', label: 'Attack Success Rate (%)' },
    { value: 'redteam_resilience_score', label: 'Resilience Score (%)' },
  ],
};

const OPERATOR_OPTIONS = [
  { value: 'gt', label: '> Greater than' },
  { value: 'gte', label: '≥ Greater or equal' },
  { value: 'lt', label: '< Less than' },
  { value: 'lte', label: '≤ Less or equal' },
  { value: 'eq', label: '= Equal to' },
];

const WINDOW_OPTIONS = [
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '60 minutes' },
];

const COOLDOWN_OPTIONS = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '360', label: '6 hours' },
];

function inferModuleFromMetric(metric: string): string {
  for (const [mod, metrics] of Object.entries(MODULE_METRICS)) {
    if (metrics.some((m) => m.value === metric)) return mod;
  }
  return 'models';
}

export default function AlertRuleForm({
  opened,
  onClose,
  onSuccess,
  initialData,
  mode = 'create',
  ruleId,
}: AlertRuleFormProps) {
  const [loading, setLoading] = useState(false);
  const t = useTranslations('alerts');

  const initialModule =
    (initialData?.module as string) ||
    (initialData?.metric
      ? inferModuleFromMetric(initialData.metric as string)
      : 'models');

  const form = useForm({
    initialValues: {
      name: (initialData?.name as string) || '',
      description: (initialData?.description as string) || '',
      module: initialModule,
      metric: (initialData?.metric as string) || 'error_rate',
      operator:
        ((initialData?.condition as Record<string, unknown>)?.operator as string) ||
        'gt',
      threshold:
        ((initialData?.condition as Record<string, unknown>)?.threshold as number) ?? 0,
      windowMinutes: String((initialData?.windowMinutes as number) || 15),
      cooldownMinutes: String((initialData?.cooldownMinutes as number) || 60),
      enabled: (initialData?.enabled as boolean) ?? true,
      modelKey:
        ((initialData?.scope as Record<string, unknown>)?.modelKey as string) || '',
      serverKey:
        ((initialData?.scope as Record<string, unknown>)?.serverKey as string) || '',
      guardrailKey:
        ((initialData?.scope as Record<string, unknown>)?.guardrailKey as string) || '',
      ragModuleKey:
        ((initialData?.scope as Record<string, unknown>)?.ragModuleKey as string) ||
        '',
      mcpServerKey:
        ((initialData?.scope as Record<string, unknown>)?.mcpServerKey as string) ||
        '',
      recipients:
        ((initialData?.channels as Array<Record<string, unknown>>)?.[0]
          ?.recipients as string[]) || [],
    },
    validate: {
      name: (value) => (!value.trim() ? t('validation.nameRequired') : null),
      threshold: (value) =>
        typeof value !== 'number' ? t('validation.thresholdRequired') : null,
    },
  });

  useEffect(() => {
    if (opened) {
      const mod =
        (initialData?.module as string) ||
        (initialData?.metric
          ? inferModuleFromMetric(initialData.metric as string)
          : 'models');
      form.setValues({
        name: (initialData?.name as string) || '',
        description: (initialData?.description as string) || '',
        module: mod,
        metric:
          (initialData?.metric as string) ||
          (MODULE_METRICS[mod]?.[0]?.value ?? 'error_rate'),
        operator:
          ((initialData?.condition as Record<string, unknown>)?.operator as string) ||
          'gt',
        threshold:
          ((initialData?.condition as Record<string, unknown>)?.threshold as number) ??
          0,
        windowMinutes: String((initialData?.windowMinutes as number) || 15),
        cooldownMinutes: String((initialData?.cooldownMinutes as number) || 60),
        enabled: (initialData?.enabled as boolean) ?? true,
        modelKey:
          ((initialData?.scope as Record<string, unknown>)?.modelKey as string) || '',
        serverKey:
          ((initialData?.scope as Record<string, unknown>)?.serverKey as string) || '',
        guardrailKey:
          ((initialData?.scope as Record<string, unknown>)?.guardrailKey as string) ||
          '',
        ragModuleKey:
          ((initialData?.scope as Record<string, unknown>)?.ragModuleKey as string) ||
          '',
        mcpServerKey:
          ((initialData?.scope as Record<string, unknown>)?.mcpServerKey as string) ||
          '',
        recipients:
          ((initialData?.channels as Array<Record<string, unknown>>)?.[0]
            ?.recipients as string[]) || [],
      });
      form.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, initialData, mode]);

  const metricOptions = useMemo(
    () => MODULE_METRICS[form.values.module] || [],
    [form.values.module],
  );

  const handleModuleChange = (value: string) => {
    form.setFieldValue('module', value);
    const firstMetric = MODULE_METRICS[value]?.[0]?.value;
    if (firstMetric) form.setFieldValue('metric', firstMetric);
    form.setFieldValue('modelKey', '');
    form.setFieldValue('serverKey', '');
    form.setFieldValue('guardrailKey', '');
    form.setFieldValue('ragModuleKey', '');
    form.setFieldValue('mcpServerKey', '');
  };

  const submit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setLoading(true);
    try {
      const scope: Record<string, string> = {};
      if (values.module === 'models' && values.modelKey)
        scope.modelKey = values.modelKey;
      if (values.module === 'inference' && values.serverKey)
        scope.serverKey = values.serverKey;
      if (values.module === 'guardrails' && values.guardrailKey)
        scope.guardrailKey = values.guardrailKey;
      if (values.module === 'rag' && values.ragModuleKey)
        scope.ragModuleKey = values.ragModuleKey;
      if (values.module === 'mcp' && values.mcpServerKey)
        scope.mcpServerKey = values.mcpServerKey;

      const body = {
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        module: values.module,
        metric: values.metric,
        condition: {
          operator: values.operator,
          threshold: values.threshold,
        },
        windowMinutes: parseInt(values.windowMinutes, 10),
        cooldownMinutes: parseInt(values.cooldownMinutes, 10),
        enabled: values.enabled,
        scope: Object.keys(scope).length > 0 ? scope : undefined,
        channels: [{ type: 'email', recipients: values.recipients }],
      };

      const url = mode === 'edit' ? `/api/alerts/rules/${ruleId}` : '/api/alerts/rules';
      const method = mode === 'edit' ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save alert rule');
      }

      notifications.show({
        title: t(mode === 'edit' ? 'ruleUpdated' : 'ruleCreated'),
        message: t(mode === 'edit' ? 'ruleUpdatedMessage' : 'ruleCreatedMessage'),
        color: 'teal',
      });

      onSuccess();
      onClose();
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: err instanceof Error ? err.message : 'Failed to save alert rule',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const scopeKey =
    form.values.module === 'models'
      ? form.values.modelKey
      : form.values.module === 'inference'
        ? form.values.serverKey
        : form.values.module === 'guardrails'
          ? form.values.guardrailKey
          : form.values.module === 'rag'
            ? form.values.ragModuleKey
            : form.values.module === 'mcp'
              ? form.values.mcpServerKey
              : '';

  const validName = Boolean(form.values.name.trim());
  const validThreshold = typeof form.values.threshold === 'number';
  const validRecipients = form.values.recipients.length > 0;

  const checklist = [
    { id: 1, label: t('form.name'), done: validName },
    { id: 2, label: t('form.metric'), done: Boolean(form.values.metric) },
    {
      id: 3,
      label: `${t('form.threshold')} & ${t('form.operator')}`,
      done: validThreshold,
    },
    { id: 4, label: t('form.recipients'), done: validRecipients },
  ];

  const operatorLabel =
    OPERATOR_OPTIONS.find((o) => o.value === form.values.operator)?.label ?? '—';
  const metricLabel =
    metricOptions.find((m) => m.value === form.values.metric)?.label ?? '—';
  const moduleLabel =
    MODULE_OPTIONS.find((m) => m.value === form.values.module)?.label ?? '—';

  const summary = (
    <>
      <SummaryGroup title={t('form.name')}>
        <SummaryKV
          label={t('form.name')}
          value={form.values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV label={t('form.module')} value={moduleLabel} />
        <SummaryKV
          label={t('form.enabled')}
          value={
            <span
              className={`ds-badge ${form.values.enabled ? 'ds-badge-ok' : 'ds-badge-warn'}`}
            >
              {form.values.enabled ? 'on' : 'off'}
            </span>
          }
        />
      </SummaryGroup>

      <SummaryGroup title={t('form.metric')}>
        <SummaryKV label={t('form.metric')} value={metricLabel} />
        <SummaryKV
          label={t('form.threshold')}
          value={
            <span className="ds-mono">
              {operatorLabel.split(' ')[0]} {form.values.threshold}
            </span>
          }
        />
        <SummaryKV
          label={t('form.window')}
          value={`${form.values.windowMinutes} min`}
        />
        <SummaryKV
          label={t('form.cooldown')}
          value={`${form.values.cooldownMinutes} min`}
        />
        {scopeKey ? (
          <SummaryKV label="Scope" value={scopeKey} mono />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title={t('form.recipients')}>
        <SummaryKV
          label={t('form.recipients')}
          value={
            form.values.recipients.length > 0 ? (
              `${form.values.recipients.length} recipient${form.values.recipients.length === 1 ? '' : 's'}`
            ) : (
              <span className="ds-faint">—</span>
            )
          }
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
      icon={<IconBell size={16} />}
      title={mode === 'edit' ? t('editRule') : t('createRule')}
      subtitle={
        mode === 'edit'
          ? 'Update the alert rule conditions and recipients.'
          : 'Define a new rule that triggers when a metric crosses a threshold.'
      }
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: mode === 'edit' ? t('save') : t('create'),
        loading,
        disabled: !validName,
        onClick: submit,
      }}
      secondaryAction={{
        label: t('cancel'),
        onClick: onClose,
      }}
    >
      <FormSection
        number={1}
        title={t('form.name')}
        description="How this rule is identified across the console."
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
        title={t('form.module')}
        description="Which subsystem this rule monitors."
        done
      >
        <ChipPicker<string>
          options={MODULE_OPTIONS}
          value={form.values.module}
          onChange={(v) => handleModuleChange(v as string)}
        />
      </FormSection>

      <FormSection
        number={3}
        title={t('form.metric')}
        description="The metric to evaluate and the threshold that triggers the alert."
        done={validThreshold}
      >
        <FormRow cols={1}>
          <FormField label={t('form.metric')} required>
            <Select
              data={metricOptions}
              {...form.getInputProps('metric')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label={t('form.operator')} required>
            <Select
              data={OPERATOR_OPTIONS}
              {...form.getInputProps('operator')}
            />
          </FormField>
          <FormField label={t('form.threshold')} required>
            <NumberInput
              min={0}
              decimalScale={2}
              {...form.getInputProps('threshold')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label={t('form.window')} required>
            <Select
              data={WINDOW_OPTIONS}
              {...form.getInputProps('windowMinutes')}
            />
          </FormField>
          <FormField label={t('form.cooldown')}>
            <Select
              data={COOLDOWN_OPTIONS}
              {...form.getInputProps('cooldownMinutes')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={4}
        title="Scope"
        description="Optionally limit the rule to a specific resource. Leave blank to apply across all."
      >
        {form.values.module === 'models' ? (
          <FormField label={t('form.modelKey')} optional>
            <TextInput
              placeholder={t('form.modelKeyPlaceholder')}
              {...form.getInputProps('modelKey')}
            />
          </FormField>
        ) : null}

        {form.values.module === 'inference' ? (
          <FormField label={t('form.serverKey')} optional>
            <TextInput
              placeholder={t('form.serverKeyPlaceholder')}
              {...form.getInputProps('serverKey')}
            />
          </FormField>
        ) : null}

        {form.values.module === 'guardrails' ? (
          <FormField label={t('form.guardrailKey')} optional>
            <TextInput
              placeholder={t('form.guardrailKeyPlaceholder')}
              {...form.getInputProps('guardrailKey')}
            />
          </FormField>
        ) : null}

        {form.values.module === 'rag' ? (
          <FormField label={t('form.ragModuleKey')} optional>
            <TextInput
              placeholder={t('form.ragModuleKeyPlaceholder')}
              {...form.getInputProps('ragModuleKey')}
            />
          </FormField>
        ) : null}

        {form.values.module === 'mcp' ? (
          <FormField label={t('form.mcpServerKey')} optional>
            <TextInput
              placeholder={t('form.mcpServerKeyPlaceholder')}
              {...form.getInputProps('mcpServerKey')}
            />
          </FormField>
        ) : null}
      </FormSection>

      <FormSection
        number={5}
        title={t('form.recipients')}
        description={t('form.defaultChannelNote')}
        done={validRecipients}
      >
        <FormField
          label={t('form.recipients')}
          hint={t('form.recipientsDescription')}
        >
          <TagsInput
            placeholder={t('form.recipientsPlaceholder')}
            {...form.getInputProps('recipients')}
          />
        </FormField>
      </FormSection>

      <FormSection number={6} title={t('form.enabled')} done>
        <ToggleList>
          <ToggleRow
            label={t('form.enabled')}
            description="Disabled rules are skipped during evaluation."
            checked={Boolean(form.values.enabled)}
            onChange={(v) => form.setFieldValue('enabled', v)}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}
