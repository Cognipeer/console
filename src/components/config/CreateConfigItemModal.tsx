'use client';

import { useState, useCallback } from 'react';
import { PasswordInput, NumberInput, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconPlus } from '@tabler/icons-react';
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

interface CreateConfigItemModalProps {
  opened: boolean;
  groupId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

type ValueType = 'string' | 'number' | 'boolean' | 'json';

export default function CreateConfigItemModal({
  opened,
  groupId,
  onClose,
  onCreated,
}: CreateConfigItemModalProps) {
  const t = useTranslations('config');
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      key: '',
      description: '',
      value: '',
      valueType: 'string' as ValueType,
      isSecret: false,
      tags: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      value: (v) => (v === '' ? 'Value is required' : null),
    },
  });

  const submit = useCallback(async () => {
    if (!groupId) return;
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setLoading(true);
    try {
      const tags = values.tags
        ? values.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        : undefined;

      const res = await fetch(`/api/config/groups/${groupId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          key: values.key || undefined,
          description: values.description || undefined,
          value: values.value,
          valueType: values.valueType || 'string',
          isSecret: values.isSecret,
          tags,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('createError'));
      }

      notifications.show({
        title: t('itemCreated'),
        message: t('itemCreatedMessage'),
        color: 'teal',
      });

      form.reset();
      onCreated();
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: err instanceof Error ? err.message : t('createError'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [form, groupId, onCreated, t]);

  const values = form.values;
  const validName = values.name.trim().length > 0;
  const validValue = values.value !== '';

  const checklist = [
    { id: 1, label: t('itemName'), done: validName },
    { id: 2, label: t('value'), done: validValue },
  ];

  const typeLabel: Record<ValueType, string> = {
    string: 'String',
    number: 'Number',
    boolean: 'Boolean',
    json: 'JSON',
  };

  const renderValueInput = () => {
    if (values.isSecret) {
      return (
        <PasswordInput
          placeholder="Configuration value"
          {...form.getInputProps('value')}
        />
      );
    }
    if (values.valueType === 'number') {
      return (
        <NumberInput
          placeholder="0"
          value={values.value === '' ? '' : Number(values.value)}
          onChange={(v) => form.setFieldValue('value', v === '' ? '' : String(v))}
        />
      );
    }
    if (values.valueType === 'boolean') {
      return (
        <ChipPicker<'true' | 'false'>
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
          value={(values.value === 'true' ? 'true' : 'false') as 'true' | 'false'}
          onChange={(v) => form.setFieldValue('value', v as string)}
        />
      );
    }
    return (
      <Textarea
        placeholder={values.valueType === 'json' ? '{ "key": "value" }' : 'Configuration value'}
        autosize
        minRows={2}
        {...form.getInputProps('value')}
      />
    );
  };

  const summary = (
    <>
      <SummaryGroup title={t('createItem')}>
        <SummaryKV
          label={t('itemName')}
          value={values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={t('itemKey')}
          value={values.key ? <span className="ds-mono">{values.key}</span> : <span className="ds-faint">auto</span>}
        />
        <SummaryKV
          label={t('valueType')}
          value={<span className="ds-badge ds-badge-info">{typeLabel[values.valueType]}</span>}
        />
        <SummaryKV
          label={t('isSecret')}
          value={
            <span className={`ds-badge ${values.isSecret ? 'ds-badge-warn' : 'ds-badge-ok'}`}>
              {values.isSecret ? 'yes' : 'no'}
            </span>
          }
        />
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const canSubmit = Boolean(groupId) && validName && validValue;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconPlus size={16} />}
      title={t('createItem')}
      subtitle="Store a configuration value, secret, or API key in this group."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('create'),
        icon: <IconCheck size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: () => {
          void submit();
        },
      }}
      secondaryAction={{
        label: t('cancel'),
        onClick: onClose,
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="Name and unique key for this config item."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label={t('itemName')} required>
            <TextInput
              placeholder="e.g. OpenAI API Key"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField
            label={t('itemKey')}
            optional
            hint="Unique identifier used in API calls. Auto-generated from name if empty."
          >
            <TextInput
              placeholder="auto"
              {...form.getInputProps('key')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('description')} optional>
            <Textarea
              placeholder="What is this config for?"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('tags')} optional hint="Comma separated.">
            <TextInput
              placeholder="api, credentials, openai"
              {...form.getInputProps('tags')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title={t('value')}
        description="The actual configuration value and its type."
        done={validValue}
      >
        <FormField label={t('valueType')}>
          <ChipPicker<ValueType>
            options={[
              { value: 'string', label: 'String' },
              { value: 'number', label: 'Number' },
              { value: 'boolean', label: 'Boolean' },
              { value: 'json', label: 'JSON' },
            ]}
            value={values.valueType}
            onChange={(v) => form.setFieldValue('valueType', v as ValueType)}
          />
        </FormField>

        <FormField label={t('value')} required>
          {renderValueInput()}
        </FormField>

        <ToggleList>
          <ToggleRow
            label={t('isSecret')}
            description="Encrypt the value at rest. Secret values are masked in the UI."
            checked={values.isSecret}
            onChange={(checked) => form.setFieldValue('isSecret', checked)}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}
