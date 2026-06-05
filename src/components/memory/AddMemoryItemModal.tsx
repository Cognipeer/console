'use client';

import { useEffect, useRef, useState } from 'react';
import type { MemoryScope } from '@/lib/database';
import { NumberInput, Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconBraces } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';

interface AddMemoryItemModalProps {
  opened: boolean;
  storeKey: string;
  defaultScope?: string;
  defaultScopeId?: string;
  onClose: () => void;
  onCreated: () => void;
}

interface FormValues {
  content: string;
  scope: MemoryScope;
  scopeId: string;
  tags: string;
  importance: number;
  source: 'chat' | 'api' | 'agent' | 'manual';
}

function resolveScope(value?: string): MemoryScope {
  switch (value) {
    case 'user':
    case 'agent':
    case 'session':
    case 'global':
      return value;
    default:
      return 'global';
  }
}

export default function AddMemoryItemModal({
  opened,
  storeKey,
  defaultScope,
  defaultScopeId,
  onClose,
  onCreated,
}: AddMemoryItemModalProps) {
  const t = useTranslations('memory');
  const [submitting, setSubmitting] = useState(false);
  const wasOpenedRef = useRef(false);

  const form = useForm<FormValues>({
    initialValues: {
      content: '',
      scope: resolveScope(defaultScope),
      scopeId: defaultScopeId ?? '',
      tags: '',
      importance: 0.5,
      source: 'manual',
    },
    validate: {
      content: (value) => (value.trim() ? null : t('contentRequired')),
      scopeId: (value, values) => {
        if (values.scope === 'global') {
          return null;
        }

        return value.trim() ? null : t('contextRequired');
      },
    },
  });

  useEffect(() => {
    if (!opened) {
      wasOpenedRef.current = false;
      return;
    }

    if (wasOpenedRef.current) {
      return;
    }

    wasOpenedRef.current = true;

    form.setValues({
      content: '',
      scope: resolveScope(defaultScope),
      scopeId: defaultScopeId ?? '',
      tags: '',
      importance: 0.5,
      source: 'manual',
    });
    form.clearErrors();
  }, [defaultScope, defaultScopeId, opened]);

  const handleSubmit = async (values: FormValues) => {
    setSubmitting(true);

    try {
      const tags = values.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      const res = await fetch(`/api/memory/stores/${storeKey}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: values.content.trim(),
          importance: values.importance,
          scope: values.scope,
          scopeId: values.scope === 'global' ? undefined : values.scopeId.trim(),
          source: values.source,
          tags,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || t('addMemoryError'));
      }

      form.reset();
      notifications.show({
        color: 'teal',
        message: t('memoryAddedMessage'),
        title: t('memoryAdded'),
      });
      onCreated();
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('addMemoryError'),
        title: t('error'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const v = form.values;
  const validContent = v.content.trim().length > 0;
  const validScope = v.scope === 'global' || v.scopeId.trim().length > 0;
  const checklist = [
    { id: 'content', label: 'Content provided', done: validContent },
    { id: 'scope', label: v.scope === 'global' ? 'Global scope' : 'Context id provided', done: validScope },
  ];

  const summary = (
    <SummaryGroup title={t('addMemoryTitle')}>
      <SummaryKV label={t('scope')} value={v.scope} />
      <SummaryKV label={t('memorySource')} value={v.source} />
      <SummaryKV label={t('importance')} value={v.importance.toFixed(2)} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBraces size={16} />}
      title={t('addMemoryTitle')}
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('addMemory'),
        icon: <IconCheck size={13} />,
        loading: submitting,
        disabled: !validContent || !validScope,
        onClick: () => form.onSubmit(handleSubmit)(),
      }}
    >
      <FormSection number={1} title={t('content')} done={validContent}>
        <FormField label={t('content')} required>
          <Textarea
            placeholder={t('contentPlaceholder')}
            autosize
            minRows={4}
            maxRows={8}
            {...form.getInputProps('content')}
          />
        </FormField>
      </FormSection>

      <FormSection number={2} title={t('scope')} done={validScope}>
        <FormRow cols={2}>
          <FormField label={t('scope')}>
            <Select
              data={[
                { value: 'global', label: t('scopes.global') },
                { value: 'user', label: t('scopes.user') },
                { value: 'agent', label: t('scopes.agent') },
                { value: 'session', label: t('scopes.session') },
              ]}
              allowDeselect={false}
              {...form.getInputProps('scope')}
            />
          </FormField>
          <FormField label={t('scopeId')} required={v.scope !== 'global'}>
            <TextInput
              placeholder={t('scopeIdPlaceholder')}
              disabled={v.scope === 'global'}
              {...form.getInputProps('scopeId')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={3} title="Metadata">
        <FormRow cols={2}>
          <FormField label={t('tags')} optional>
            <TextInput placeholder={t('tagsPlaceholder')} {...form.getInputProps('tags')} />
          </FormField>
          <FormField label={t('memorySource')}>
            <Select
              placeholder={t('sourcePlaceholder')}
              data={[
                { value: 'chat', label: t('sources.chat') },
                { value: 'api', label: t('sources.api') },
                { value: 'agent', label: t('sources.agent') },
                { value: 'manual', label: t('sources.manual') },
              ]}
              allowDeselect={false}
              {...form.getInputProps('source')}
            />
          </FormField>
        </FormRow>
        <FormField label={t('importance')}>
          <NumberInput
            min={0}
            max={1}
            step={0.1}
            decimalScale={2}
            clampBehavior="strict"
            {...form.getInputProps('importance')}
          />
        </FormField>
      </FormSection>
    </FormShell>
  );
}
