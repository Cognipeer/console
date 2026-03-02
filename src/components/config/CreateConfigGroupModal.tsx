'use client';

import { useState, useCallback } from 'react';
import {
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconFolder } from '@tabler/icons-react';
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

  const handleSubmit = useCallback(
    async (values: typeof form.values) => {
      setLoading(true);
      try {
        const tags = values.tags
          ? values.tags.split(',').map((t) => t.trim()).filter(Boolean)
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
    },
    [form, onCreated, t],
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ThemeIcon variant="light" color="violet" size="sm">
            <IconFolder size={14} />
          </ThemeIcon>
          <Text fw={600}>{t('createGroup')}</Text>
        </Group>
      }
      size="md"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t('groupName')}
            placeholder="e.g. OpenAI Credentials"
            required
            {...form.getInputProps('name')}
          />

          <TextInput
            label={t('groupKey')}
            placeholder="Auto-generated from name if empty"
            description="Unique identifier used in API calls"
            {...form.getInputProps('key')}
          />

          <Textarea
            label={t('description')}
            placeholder="What is this group for?"
            autosize
            minRows={2}
            {...form.getInputProps('description')}
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
