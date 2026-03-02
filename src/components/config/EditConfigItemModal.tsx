'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconEdit } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

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
      name: (v) => (!v.trim() ? 'Name is required' : null),
      value: (v) => (v === '' ? 'Value is required' : null),
    },
  });

  useEffect(() => {
    if (!item) return;
    form.setValues({
      name: item.name || '',
      description: item.description || '',
      value: item.value || '',
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
            value: values.value,
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
    [form.values, item, onUpdated, t],
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ThemeIcon variant="light" color="violet" size="sm">
            <IconEdit size={14} />
          </ThemeIcon>
          <Text fw={600}>{t('editItem')}</Text>
        </Group>
      }
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput label={t('itemName')} required {...form.getInputProps('name')} />

          <TextInput
            label={t('itemKey')}
            value={item?.key || ''}
            readOnly
            description="Item key cannot be changed"
          />

          <Textarea
            label={t('description')}
            autosize
            minRows={2}
            {...form.getInputProps('description')}
          />

          <Textarea
            label={t('value')}
            required
            autosize
            minRows={2}
            {...form.getInputProps('value')}
          />

          <Select
            label={t('valueType')}
            data={[
              { value: 'string', label: 'String' },
              { value: 'number', label: 'Number' },
              { value: 'boolean', label: 'Boolean' },
              { value: 'json', label: 'JSON' },
            ]}
            {...form.getInputProps('valueType')}
          />

          <Switch
            label={t('isSecret')}
            description="Encrypt the value at rest. Secret values are masked in the UI."
            {...form.getInputProps('isSecret', { type: 'checkbox' })}
          />

          <TextInput
            label={t('tags')}
            placeholder="Comma separated: api, credentials"
            {...form.getInputProps('tags')}
          />

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={loading}>
              {t('save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
