'use client';

import { useCallback, useEffect, useState } from 'react';
import { PasswordInput, Select, Switch, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconEdit } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { ResourceUsageSection } from '@/components/common/confirm';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';

interface ConfigItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  value: string;
  valueType: string;
  isSecret: boolean;
  tags?: string[];
}

interface EditConfigItemModalProps {
  opened: boolean;
  item: ConfigItem | null;
  onClose: () => void;
  onUpdated: () => void;
}

export default function EditConfigItemModal({
  opened,
  item,
  onClose,
  onUpdated,
}: EditConfigItemModalProps) {
  const t = useTranslations('config');
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      value: '',
      valueType: 'string' as string,
      isSecret: false,
      tags: '',
    },
    validate: {
      name: (v) => (!v.trim() ? t('nameRequired') : null),
    },
  });

  // A stored secret is never sent to the browser (the API returns a mask), so
  // an empty value on a still-secret item means "keep the stored secret".
  const keepsSecret = Boolean(item?.isSecret) && form.values.isSecret;

  useEffect(() => {
    if (!item) return;
    form.setValues({
      name: item.name || '',
      description: item.description || '',
      value: item.isSecret ? '' : item.value || '',
      valueType: item.valueType || 'string',
      isSecret: item.isSecret,
      tags: (item.tags || []).join(', '),
    });
  }, [item]);

  const handleSubmit = useCallback(
    async (values: typeof form.values) => {
      if (!item) return;
      setLoading(true);
      try {
        const tags = values.tags
          ? values.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
          : undefined;

        const res = await fetch(`/api/config/items/${item._id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name,
            description: values.description || undefined,
            ...(keepsSecret && values.value === '' ? {} : { value: values.value }),
            valueType: values.valueType,
            isSecret: values.isSecret,
            tags,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || t('updateError'));
        }

        notifications.show({
          title: t('itemUpdated'),
          message: t('itemUpdatedMessage'),
          color: 'teal',
        });

        onUpdated();
      } catch (error) {
        notifications.show({
          title: t('error'),
          message: error instanceof Error ? error.message : t('updateError'),
          color: 'red',
        });
      } finally {
        setLoading(false);
      }
    },
    [form.values, item, keepsSecret, onUpdated, t],
  );

  const v = form.values;
  const validName = v.name.trim().length > 0;
  const validValue = keepsSecret || v.value !== '';
  const checklist = [
    { id: 'name', label: t('itemName'), done: validName },
    { id: 'value', label: t('value'), done: validValue },
  ];

  const summary = (
    <SummaryGroup title={t('editItem')}>
      <SummaryKV label={t('itemKey')} value={item?.key || '—'} mono />
      <SummaryKV label={t('itemName')} value={v.name || '—'} />
      <SummaryKV label={t('valueType')} value={v.valueType} />
      <SummaryKV label={t('isSecret')} value={v.isSecret ? t('yes') : t('no')} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconEdit size={16} />}
      title={t('editItem')}
      subtitle={item?.key}
      summary={summary}
      footerStatus={t('ready', { done: checklist.filter((c) => c.done).length, total: checklist.length })}
      primaryAction={{
        label: t('save'),
        icon: <IconCheck size={13} />,
        loading,
        disabled: !validName || !validValue,
        onClick: () => form.onSubmit(handleSubmit)(),
      }}
    >
      <FormSection number={1} title={t('identity')} done={validName}>
        <FormRow cols={2}>
          <FormField label={t('itemName')} required>
            <TextInput {...form.getInputProps('name')} />
          </FormField>
          <FormField label={t('itemKey')} hint={t('itemKeyLocked')}>
            <TextInput value={item?.key || ''} readOnly />
          </FormField>
        </FormRow>
        <FormField label={t('description')} optional>
          <Textarea autosize minRows={2} {...form.getInputProps('description')} />
        </FormField>
      </FormSection>

      <FormSection number={2} title={t('value')} done={validValue}>
        <FormField
          label={t('value')}
          required={!keepsSecret}
          hint={keepsSecret ? t('secretValueSet') : undefined}
        >
          {v.isSecret ? (
            <PasswordInput
              placeholder={keepsSecret ? t('keepSecretHint') : t('valuePlaceholder')}
              {...form.getInputProps('value')}
            />
          ) : (
            <Textarea autosize minRows={2} {...form.getInputProps('value')} />
          )}
        </FormField>
        <FormRow cols={2}>
          <FormField label={t('valueType')}>
            <Select
              data={[
                { value: 'string', label: 'String' },
                { value: 'number', label: 'Number' },
                { value: 'boolean', label: 'Boolean' },
                { value: 'json', label: 'JSON' },
              ]}
              {...form.getInputProps('valueType')}
            />
          </FormField>
          <FormField label={t('isSecret')} hint={t('secretHint')}>
            <Switch mt={6} {...form.getInputProps('isSecret', { type: 'checkbox' })} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={3} title={t('tags')}>
        <FormField label={t('tags')} optional>
          <TextInput placeholder={t('tagsPlaceholder')} {...form.getInputProps('tags')} />
        </FormField>
      </FormSection>

      {item ? (
        <FormSection number={4} title={t('usageSection')} description={t('usageSectionDescription')}>
          <ResourceUsageSection type="config-item" id={item._id} />
        </FormSection>
      ) : null}
    </FormShell>
  );
}
