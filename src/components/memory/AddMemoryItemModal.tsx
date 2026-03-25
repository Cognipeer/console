'use client';

import { useEffect, useRef, useState } from 'react';
import type { MemoryScope } from '@/lib/database';
import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useTranslations } from '@/lib/i18n';

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

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('addMemoryTitle')}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <Textarea
            label={t('content')}
            placeholder={t('contentPlaceholder')}
            autosize
            minRows={4}
            maxRows={8}
            required
            {...form.getInputProps('content')}
          />

          <Group grow align="flex-start">
            <Select
              label={t('scope')}
              data={[
                { value: 'global', label: t('scopes.global') },
                { value: 'user', label: t('scopes.user') },
                { value: 'agent', label: t('scopes.agent') },
                { value: 'session', label: t('scopes.session') },
              ]}
              allowDeselect={false}
              {...form.getInputProps('scope')}
            />

            <TextInput
              label={t('scopeId')}
              placeholder={t('scopeIdPlaceholder')}
              disabled={form.values.scope === 'global'}
              required={form.values.scope !== 'global'}
              {...form.getInputProps('scopeId')}
            />
          </Group>

          <Group grow align="flex-start">
            <TextInput
              label={t('tags')}
              placeholder={t('tagsPlaceholder')}
              {...form.getInputProps('tags')}
            />

            <Select
              label={t('memorySource')}
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
          </Group>

          <NumberInput
            label={t('importance')}
            min={0}
            max={1}
            step={0.1}
            decimalScale={2}
            clampBehavior="strict"
            {...form.getInputProps('importance')}
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={submitting}>
              {t('addMemory')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}