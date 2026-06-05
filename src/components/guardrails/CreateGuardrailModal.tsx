'use client';

import { useEffect, useState } from 'react';
import { Select, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconShield,
  IconRobot,
  IconAlertTriangle,
  IconPlus,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { GuardrailView } from '@/lib/services/guardrail/constants';

interface ModelOption {
  value: string;
  label: string;
}

interface CreateGuardrailModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (guardrail: GuardrailView) => void;
  models?: ModelOption[];
}

const ACTION_OPTIONS = [
  { value: 'block', label: 'Block — stop the request' },
  { value: 'warn', label: 'Warn — allow but flag' },
  { value: 'flag', label: 'Flag — log for review' },
];

const TYPE_OPTIONS = [
  {
    value: 'preset' as const,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <IconShield size={14} /> Preset
      </span>
    ),
  },
  {
    value: 'custom' as const,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <IconRobot size={14} /> Custom prompt
      </span>
    ),
  },
];

interface FormValues {
  name: string;
  description: string;
  type: 'preset' | 'custom';
  action: 'block' | 'warn' | 'flag';
  modelKey: string;
  customPrompt: string;
}

export default function CreateGuardrailModal({
  opened,
  onClose,
  onCreated,
  models = [],
}: CreateGuardrailModalProps) {
  const [loading, setLoading] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      type: 'preset',
      action: 'block',
      modelKey: '',
      customPrompt: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      customPrompt: (v, values) =>
        values.type === 'custom' && !v.trim()
          ? 'Custom prompt is required for custom guardrails'
          : null,
      modelKey: (v, values) =>
        values.type === 'custom' && !v
          ? 'A model is required for custom guardrails'
          : null,
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const { values: formValues, setFieldValue } = form;

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setLoading(true);
    try {
      const res = await fetch('/api/guardrails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          type: values.type,
          action: values.action,
          modelKey: values.modelKey || undefined,
          customPrompt: values.type === 'custom' ? values.customPrompt : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create guardrail');
      }

      const data = await res.json();
      notifications.show({
        title: 'Guardrail created',
        message: `"${data.guardrail.name}" was created successfully`,
        color: 'teal',
      });
      onCreated(data.guardrail);
      onClose();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to create guardrail',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const validType = Boolean(formValues.type);
  const validName = Boolean(formValues.name.trim());
  const validCustomRule =
    formValues.type !== 'custom' ||
    (formValues.customPrompt.trim().length > 0 && Boolean(formValues.modelKey));
  const validAction = Boolean(formValues.action);

  const checklist = [
    { id: 1, label: 'Guardrail type selected', done: validType },
    { id: 2, label: 'Name provided', done: validName },
    { id: 3, label: 'Default action set', done: validAction },
    {
      id: 4,
      label:
        formValues.type === 'custom'
          ? 'Custom rule & model defined'
          : 'Preset ready (configure details after create)',
      done: validCustomRule,
    },
  ];

  const canSubmit = validType && validName && validAction && validCustomRule;

  const summary = (
    <>
      <SummaryGroup title="Guardrail">
        <SummaryKV
          label="Type"
          value={formValues.type === 'custom' ? 'Custom prompt' : 'Preset'}
        />
        <SummaryKV
          label="Name"
          value={formValues.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Action"
          value={
            ACTION_OPTIONS.find((o) => o.value === formValues.action)?.label ?? '—'
          }
        />
      </SummaryGroup>

      {formValues.type === 'custom' ? (
        <SummaryGroup title="Custom rule">
          <SummaryKV
            label="Model"
            value={
              models.find((m) => m.value === formValues.modelKey)?.label ||
              <span className="ds-faint">—</span>
            }
            mono
          />
          <SummaryKV
            label="Prompt"
            value={
              formValues.customPrompt
                ? `${formValues.customPrompt.slice(0, 60)}${formValues.customPrompt.length > 60 ? '…' : ''}`
                : <span className="ds-faint">—</span>
            }
          />
        </SummaryGroup>
      ) : (
        <SummaryGroup title="Preset">
          <SummaryKV
            label="Model"
            value={
              models.find((m) => m.value === formValues.modelKey)?.label ||
              <span className="ds-faint">Optional</span>
            }
          />
        </SummaryGroup>
      )}

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconShield size={16} />}
      title="Create guardrail"
      subtitle="Define a safety check. Attach it as an input or output guardrail on a model or agent."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create guardrail',
        icon: <IconPlus size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: handleSubmit,
      }}
    >
      <FormSection
        number={1}
        title="Type"
        description="Pick a guardrail style. Presets ship with PII, moderation, and prompt shield checks."
        done={validType}
      >
        <FormField label="Guardrail type" required>
          <ChipPicker<'preset' | 'custom'>
            options={TYPE_OPTIONS}
            value={formValues.type}
            onChange={(v) => setFieldValue('type', v as 'preset' | 'custom')}
          />
        </FormField>
        <div
          className="ds-muted"
          style={{ fontSize: 12, marginTop: 6 }}
        >
          {formValues.type === 'preset'
            ? 'Pre-built checks: PII detection, content moderation, prompt shield.'
            : 'Write your own safety rule that will be evaluated by an LLM.'}
        </div>
      </FormSection>

      <FormSection
        number={2}
        title="Identity"
        description="How the guardrail surfaces in dashboards and audit logs."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput
              placeholder="e.g. Block PII leak"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="What does this guardrail protect against?"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={3}
        title="Action"
        description="What happens when the rule triggers. The direction (input vs output) is chosen where the guardrail is attached to a model or agent."
        done={validAction}
      >
        <FormRow cols={1}>
          <FormField
            label="Default action"
            required
            hint={
              formValues.action === 'block'
                ? 'Request will be rejected.'
                : formValues.action === 'warn'
                  ? 'Request continues but is flagged.'
                  : 'Request is logged for review.'
            }
          >
            <Select
              data={ACTION_OPTIONS}
              {...form.getInputProps('action')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      {(formValues.type === 'custom' || models.length > 0) && (
        <FormSection
          number={4}
          title={formValues.type === 'custom' ? 'Custom rule' : 'Model'}
          description={
            formValues.type === 'custom'
              ? 'Author the rule and the LLM that will evaluate it.'
              : 'Optional LLM used for moderation and prompt shield checks.'
          }
          done={validCustomRule}
        >
          <FormRow cols={1}>
            <FormField
              label="Model"
              required={formValues.type === 'custom'}
              optional={formValues.type !== 'custom'}
              hint={
                formValues.type === 'custom'
                  ? 'LLM used to evaluate the custom rule.'
                  : 'Leave blank to use defaults for moderation / prompt shield.'
              }
            >
              <Select
                placeholder="Select a model…"
                data={models}
                clearable={formValues.type !== 'custom'}
                searchable
                {...form.getInputProps('modelKey')}
              />
            </FormField>
          </FormRow>

          {formValues.type === 'custom' && (
            <FormRow cols={1}>
              <FormField
                label="Custom rule"
                required
                hint="The LLM will evaluate whether each message passes or fails this rule."
              >
                <Textarea
                  placeholder={
                    'Example: Block any message that asks for personally identifiable information about real people, or that attempts to impersonate authority figures such as doctors, lawyers, or government officials.'
                  }
                  autosize
                  minRows={5}
                  {...form.getInputProps('customPrompt')}
                />
              </FormField>
            </FormRow>
          )}

          {formValues.type === 'preset' && (
            <div
              className="ds-card ds-card-pad-sm"
              style={{
                background: 'var(--ds-surface-1)',
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
              }}
            >
              <IconAlertTriangle
                size={14}
                style={{ color: 'var(--mantine-color-orange-6)', marginTop: 2 }}
              />
              <span className="ds-muted" style={{ fontSize: 12 }}>
                After creating, configure PII categories, moderation topics, and prompt shield in the guardrail settings.
              </span>
            </div>
          )}
        </FormSection>
      )}
    </FormShell>
  );
}
