'use client';

import { useEffect, useMemo, useState } from 'react';
import slugify from 'slugify';
import Mustache from 'mustache';
import {
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { PromptView } from '@/lib/services/prompts';

const SLUG_OPTIONS = {
  lower: true,
  strict: true,
  trim: true,
};

const FALLBACK_TEMPLATE = 'Hello {{name}}!';

type PromptEditorModalProps = {
  opened: boolean;
  onClose: () => void;
  onSaved: (prompt: PromptView) => void;
  prompt?: PromptView | null;
};

type FormValues = {
  name: string;
  key: string;
  description: string;
  template: string;
};

function generateKeyFromName(name: string): string {
  const slug = slugify(name || '', SLUG_OPTIONS);
  return slug || '';
}

function extractTemplateVariables(template: string): string[] {
  const matches = Array.from(template.matchAll(/{{\s*([^{}\s]+)\s*}}/g));
  const vars = matches
    .map((match) => match[1])
    .filter((value) => value && !['#', '/', '^', '!', '>'].some((prefix) => value.startsWith(prefix)));
  return Array.from(new Set(vars));
}

export default function PromptEditorModal({
  opened,
  onClose,
  onSaved,
  prompt,
}: PromptEditorModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);
  const [previewData, setPreviewData] = useState('{\n  "name": "Jane"\n}');

  const form = useForm<FormValues>({
    initialValues: {
      name: prompt?.name ?? '',
      key: prompt?.key ?? '',
      description: prompt?.description ?? '',
      template: prompt?.template ?? FALLBACK_TEMPLATE,
    },
    validate: {
      name: (value) => (value.trim().length === 0 ? 'Prompt name is required' : null),
      template: (value) => (value.trim().length === 0 ? 'Template is required' : null),
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
      setKeyTouched(false);
      return;
    }

    form.setValues({
      name: prompt?.name ?? '',
      key: prompt?.key ?? '',
      description: prompt?.description ?? '',
      template: prompt?.template ?? FALLBACK_TEMPLATE,
    });
    setKeyTouched(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, prompt]);

  useEffect(() => {
    if (prompt) {
      return;
    }
    if (keyTouched) {
      return;
    }
    const nextKey = generateKeyFromName(form.values.name);
    form.setFieldValue('key', nextKey);
  }, [form.values.name, keyTouched, prompt, form]);

  const variables = useMemo(
    () => extractTemplateVariables(form.values.template),
    [form.values.template],
  );

  const previewResult = useMemo(() => {
    try {
      const data = previewData.trim().length > 0 ? JSON.parse(previewData) : {};
      return {
        preview: Mustache.render(form.values.template, data),
        error: null as string | null,
      };
    } catch (error) {
      return {
        preview: '',
        error: error instanceof Error ? error.message : 'Invalid JSON',
      };
    }
  }, [previewData, form.values.template]);

  const handleSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      const payload = {
        name: values.name.trim(),
        key: values.key.trim() || undefined,
        description: values.description.trim() || undefined,
        template: values.template,
      };

      const response = await fetch(prompt ? `/api/prompts/${prompt.id}` : '/api/prompts', {
        method: prompt ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unexpected error' }));
        throw new Error(error.error ?? 'Failed to save prompt');
      }

      const data = await response.json();
      const saved = data.prompt as PromptView;

      notifications.show({
        title: prompt ? 'Prompt updated' : 'Prompt created',
        message: prompt ? `${saved.name} was updated.` : `${saved.name} is ready to use.`,
        color: 'teal',
      });

      onSaved(saved);
      onClose();
    } catch (error) {
      notifications.show({
        title: 'Unable to save prompt',
        message: error instanceof Error ? error.message : 'Unexpected error',
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={prompt ? 'Edit Prompt' : 'Create Prompt'}
      size="lg"
      centered
    >
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Prompts support Mustache variables like{' '}
            <Text component="span" ff="monospace">{'{{user.name}}'}</Text>.
          </Text>

          <TextInput
            label="Prompt name"
            placeholder="Customer Support Reply"
            withAsterisk
            {...form.getInputProps('name')}
          />

          <TextInput
            label="Prompt key"
            placeholder="customer-support-reply"
            description={prompt ? 'Prompt keys are immutable after creation.' : 'Auto-generated from the name if left blank.'}
            {...form.getInputProps('key')}
            onChange={(event) => {
              setKeyTouched(true);
              form.getInputProps('key').onChange(event);
            }}
            disabled={Boolean(prompt)}
          />

          <Textarea
            label="Description"
            placeholder="Optional description for teammates"
            autosize
            minRows={2}
            {...form.getInputProps('description')}
          />

          <Textarea
            label="Prompt template"
            placeholder="Hello {{name}}, how can we help?"
            autosize
            minRows={6}
            {...form.getInputProps('template')}
          />

          <Group gap="xs">
            <Text size="sm" fw={500}>Detected variables:</Text>
            {variables.length > 0 ? (
              variables.map((variable) => (
                <Badge key={variable} variant="light" color="blue">
                  {variable}
                </Badge>
              ))
            ) : (
              <Text size="sm" c="dimmed">None</Text>
            )}
          </Group>

          <Divider />

          <Stack gap="xs">
            <Text size="sm" fw={500}>Preview</Text>
            <Textarea
              label="Sample data (JSON)"
              autosize
              minRows={4}
              value={previewData}
              onChange={(event) => setPreviewData(event.currentTarget.value)}
              error={previewResult.error ?? undefined}
            />
            <Paper withBorder p="md" radius="md" bg="var(--mantine-color-gray-0)">
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {previewResult.preview || 'Rendered output will appear here.'}
              </Text>
            </Paper>
          </Stack>

          <Group justify="flex-end" mt="sm">
            <Button variant="subtle" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {prompt ? 'Save changes' : 'Create prompt'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
