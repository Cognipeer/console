'use client';

import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useState, useMemo, useEffect } from 'react';
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
  { value: 'rag', label: 'RAG' },
  { value: 'mcp', label: 'MCP Servers' },
];

/** Metrics grouped by module */
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

/** Infer module from metric for backward-compat with existing rules */
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
    (initialData?.metric ? inferModuleFromMetric(initialData.metric as string) : 'models');

  const form = useForm({
    initialValues: {
      name: (initialData?.name as string) || '',
      description: (initialData?.description as string) || '',
      module: initialModule,
      metric: (initialData?.metric as string) || 'error_rate',
      operator: ((initialData?.condition as Record<string, unknown>)?.operator as string) || 'gt',
      threshold: ((initialData?.condition as Record<string, unknown>)?.threshold as number) ?? 0,
      windowMinutes: String((initialData?.windowMinutes as number) || 15),
      cooldownMinutes: String((initialData?.cooldownMinutes as number) || 60),
      enabled: (initialData?.enabled as boolean) ?? true,
      modelKey: ((initialData?.scope as Record<string, unknown>)?.modelKey as string) || '',
      serverKey: ((initialData?.scope as Record<string, unknown>)?.serverKey as string) || '',
      guardrailKey: ((initialData?.scope as Record<string, unknown>)?.guardrailKey as string) || '',
      ragModuleKey: ((initialData?.scope as Record<string, unknown>)?.ragModuleKey as string) || '',
      mcpServerKey: ((initialData?.scope as Record<string, unknown>)?.mcpServerKey as string) || '',
      recipients: ((initialData?.channels as Array<Record<string, unknown>>)?.[0]?.recipients as string[]) || [],
    },
    validate: {
      name: (value) => (!value.trim() ? t('validation.nameRequired') : null),
      threshold: (value) => (typeof value !== 'number' ? t('validation.thresholdRequired') : null),
    },
  });

  // Reset form values when initialData or mode changes (edit vs create)
  useEffect(() => {
    if (opened) {
      const mod =
        (initialData?.module as string) ||
        (initialData?.metric ? inferModuleFromMetric(initialData.metric as string) : 'models');
      form.setValues({
        name: (initialData?.name as string) || '',
        description: (initialData?.description as string) || '',
        module: mod,
        metric: (initialData?.metric as string) || (MODULE_METRICS[mod]?.[0]?.value ?? 'error_rate'),
        operator: ((initialData?.condition as Record<string, unknown>)?.operator as string) || 'gt',
        threshold: ((initialData?.condition as Record<string, unknown>)?.threshold as number) ?? 0,
        windowMinutes: String((initialData?.windowMinutes as number) || 15),
        cooldownMinutes: String((initialData?.cooldownMinutes as number) || 60),
        enabled: (initialData?.enabled as boolean) ?? true,
        modelKey: ((initialData?.scope as Record<string, unknown>)?.modelKey as string) || '',
        serverKey: ((initialData?.scope as Record<string, unknown>)?.serverKey as string) || '',
        guardrailKey: ((initialData?.scope as Record<string, unknown>)?.guardrailKey as string) || '',
        ragModuleKey: ((initialData?.scope as Record<string, unknown>)?.ragModuleKey as string) || '',
        mcpServerKey: ((initialData?.scope as Record<string, unknown>)?.mcpServerKey as string) || '',
        recipients: ((initialData?.channels as Array<Record<string, unknown>>)?.[0]?.recipients as string[]) || [],
      });
      form.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, initialData, mode]);

  /** Metric options change when module changes */
  const metricOptions = useMemo(
    () => MODULE_METRICS[form.values.module] || [],
    [form.values.module],
  );

  const handleModuleChange = (value: string | null) => {
    if (!value) return;
    form.setFieldValue('module', value);
    // Reset metric to first of the new module
    const firstMetric = MODULE_METRICS[value]?.[0]?.value;
    if (firstMetric) form.setFieldValue('metric', firstMetric);
    // Clear irrelevant scope fields
    form.setFieldValue('modelKey', '');
    form.setFieldValue('serverKey', '');
    form.setFieldValue('guardrailKey', '');
    form.setFieldValue('ragModuleKey', '');
    form.setFieldValue('mcpServerKey', '');
  };

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);
    try {
      const scope: Record<string, string> = {};
      if (values.module === 'models' && values.modelKey) scope.modelKey = values.modelKey;
      if (values.module === 'inference' && values.serverKey) scope.serverKey = values.serverKey;
      if (values.module === 'guardrails' && values.guardrailKey) scope.guardrailKey = values.guardrailKey;
      if (values.module === 'rag' && values.ragModuleKey) scope.ragModuleKey = values.ragModuleKey;
      if (values.module === 'mcp' && values.mcpServerKey) scope.mcpServerKey = values.mcpServerKey;

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
        channels: [
          {
            type: 'email',
            recipients: values.recipients,
          },
        ],
      };

      const url =
        mode === 'edit' ? `/api/alerts/rules/${ruleId}` : '/api/alerts/rules';
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

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={mode === 'edit' ? t('editRule') : t('createRule')}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t('form.name')}
            placeholder={t('form.namePlaceholder')}
            required
            {...form.getInputProps('name')}
          />

          <Textarea
            label={t('form.description')}
            placeholder={t('form.descriptionPlaceholder')}
            autosize
            minRows={2}
            maxRows={4}
            {...form.getInputProps('description')}
          />

          <Select
            label={t('form.module')}
            data={MODULE_OPTIONS}
            required
            value={form.values.module}
            onChange={handleModuleChange}
          />

          <Select
            label={t('form.metric')}
            data={metricOptions}
            required
            {...form.getInputProps('metric')}
          />

          <Group grow>
            <Select
              label={t('form.operator')}
              data={OPERATOR_OPTIONS}
              required
              {...form.getInputProps('operator')}
            />
            <NumberInput
              label={t('form.threshold')}
              required
              min={0}
              decimalScale={2}
              {...form.getInputProps('threshold')}
            />
          </Group>

          <Group grow>
            <Select
              label={t('form.window')}
              data={WINDOW_OPTIONS}
              required
              {...form.getInputProps('windowMinutes')}
            />
            <Select
              label={t('form.cooldown')}
              data={COOLDOWN_OPTIONS}
              {...form.getInputProps('cooldownMinutes')}
            />
          </Group>

          {/* Module-specific scope fields */}
          {form.values.module === 'models' && (
            <TextInput
              label={t('form.modelKey')}
              placeholder={t('form.modelKeyPlaceholder')}
              {...form.getInputProps('modelKey')}
            />
          )}

          {form.values.module === 'inference' && (
            <TextInput
              label={t('form.serverKey')}
              placeholder={t('form.serverKeyPlaceholder')}
              {...form.getInputProps('serverKey')}
            />
          )}

          {form.values.module === 'guardrails' && (
            <TextInput
              label={t('form.guardrailKey')}
              placeholder={t('form.guardrailKeyPlaceholder')}
              {...form.getInputProps('guardrailKey')}
            />
          )}

          {form.values.module === 'rag' && (
            <TextInput
              label={t('form.ragModuleKey')}
              placeholder={t('form.ragModuleKeyPlaceholder')}
              {...form.getInputProps('ragModuleKey')}
            />
          )}

          {form.values.module === 'mcp' && (
            <TextInput
              label={t('form.mcpServerKey')}
              placeholder={t('form.mcpServerKeyPlaceholder')}
              {...form.getInputProps('mcpServerKey')}
            />
          )}

          <TagsInput
            label={t('form.recipients')}
            placeholder={t('form.recipientsPlaceholder')}
            description={t('form.recipientsDescription')}
            {...form.getInputProps('recipients')}
          />

          <Switch
            label={t('form.enabled')}
            {...form.getInputProps('enabled', { type: 'checkbox' })}
          />

          <Text size="xs" c="dimmed">
            {t('form.defaultChannelNote')}
          </Text>

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={loading}>
              {mode === 'edit' ? t('save') : t('create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
