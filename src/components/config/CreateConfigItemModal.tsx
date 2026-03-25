'use client';

import { useState, useCallback } from 'react';
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
import { IconPlus } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

interface CreateConfigItemModalProps {
  opened: boolean;
  groupId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

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
      valueType: 'string' as string,
      isSecret: false,
      tags: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      value: (v) => (v === '' ? 'Value is required' : null),
    },
  });

  const handleSubmit = useCallback(
    async (values: typeof form.values) => {
      if (!groupId) return;
      setLoading(true);
      try {
        const tags = values.tags
          ? values.tags.split(',').map((t) => t.trim()).filter(Boolean)
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
    },
    [form, groupId, onCreated, t],
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ThemeIcon variant="light" color="violet" size="sm">
            <IconPlus size={14} />
          </ThemeIcon>
          <Text fw={600}>{t('createItem')}</Text>
        </Group>
      }
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t('itemName')}
            placeholder="e.g. OpenAI API Key"
            required
            {...form.getInputProps('name')}
          />

          <TextInput
            label={t('itemKey')}
            placeholder="Auto-generated from name if empty"
            description="Unique identifier used in API calls"
            {...form.getInputProps('key')}
          />

          <Textarea
            label={t('description')}
            placeholder="What is this config for?"
            autosize
            minRows={2}
            {...form.getInputProps('description')}
          />

          <Textarea
            label={t('value')}
            placeholder="Configuration value"
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
            placeholder="Comma separated: api, credentials, openai"
            {...form.getInputProps('tags')}
          />

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={loading}>
              {t('create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
