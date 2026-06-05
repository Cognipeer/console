'use client';

import { useState, useCallback } from 'react';
import { TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconFolder } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

interface CreateConfigGroupModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateConfigGroupModal({
  opened,
  onClose,
  onCreated,
}: CreateConfigGroupModalProps) {
  const t = useTranslations('config');
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      key: '',
      description: '',
      tags: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
    },
  });

  const submit = useCallback(async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setLoading(true);
    try {
      const tags = values.tags
        ? values.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        : undefined;

      const res = await fetch('/api/config/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          key: values.key || undefined,
          description: values.description || undefined,
          tags,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('createError'));
      }

      notifications.show({
        title: t('groupCreated'),
        message: t('groupCreatedMessage'),
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
  }, [form, onCreated, t]);

  const values = form.values;
  const validName = values.name.trim().length > 0;

  const checklist = [
    { id: 1, label: t('groupName'), done: validName },
  ];

  const summary = (
    <>
      <SummaryGroup title={t('createGroup')}>
        <SummaryKV
          label={t('groupName')}
          value={values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={t('groupKey')}
          value={values.key ? <span className="ds-mono">{values.key}</span> : <span className="ds-faint">auto</span>}
        />
        <SummaryKV
          label={t('tags')}
          value={values.tags || <span className="ds-faint">—</span>}
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
      icon={<IconFolder size={16} />}
      title={t('createGroup')}
      subtitle="Organize secrets, API keys, and configuration values into a named group."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('create'),
        icon: <IconCheck size={13} />,
        loading,
        disabled: !validName,
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
        title={t('groupName')}
        description="Identity for this config group across the console."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label={t('groupName')} required>
            <TextInput
              placeholder="e.g. OpenAI Credentials"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField
            label={t('groupKey')}
            hint="Unique identifier used in API calls. Auto-generated from name if empty."
            optional
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
              placeholder="What is this group for?"
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
    </FormShell>
  );
}
