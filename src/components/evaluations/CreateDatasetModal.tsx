'use client';

import { useEffect, useState } from 'react';
import { Button, Code, Group, Modal, Stack, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { EvalDatasetItemView, EvalDatasetView } from './types';

interface CreateDatasetModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (dataset: EvalDatasetView) => void;
}

const EXAMPLE = `[
  {
    "id": "q1",
    "input": [{ "role": "user", "content": "What is 2+2?" }],
    "expected": { "mustContain": ["4"] }
  }
]`;

interface FormValues {
  name: string;
  description: string;
  itemsJson: string;
}

/** Validate + normalise the items JSON into dataset items. */
function parseItems(raw: string): { items: EvalDatasetItemView[] } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { error: 'Items must be a JSON array' };
  const items: EvalDatasetItemView[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') return { error: `Item ${i} is not an object` };
    if (!Array.isArray(entry.input)) return { error: `Item ${i} must have an "input" array of messages` };
    items.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `item-${i + 1}`,
      input: entry.input as EvalDatasetItemView['input'],
      expected: (entry.expected as Record<string, unknown> | undefined) ?? undefined,
      tags: Array.isArray(entry.tags) ? (entry.tags as string[]) : undefined,
    });
  }
  return { items };
}

export default function CreateDatasetModal({ opened, onClose, onCreated }: CreateDatasetModalProps) {
  const [loading, setLoading] = useState(false);
  const form = useForm<FormValues>({
    initialValues: { name: '', description: '', itemsJson: '' },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      itemsJson: (v) => {
        const result = parseItems(v);
        return 'error' in result ? result.error : null;
      },
    },
  });

  useEffect(() => {
    if (!opened) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleSubmit = async () => {
    if (form.validate().hasErrors) return;
    const v = form.getValues();
    const parsed = parseItems(v.itemsJson);
    if ('error' in parsed) return;
    setLoading(true);
    try {
      const res = await fetch('/api/evaluation/datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v.name.trim(), description: v.description || undefined, items: parsed.items }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create dataset');
      }
      const data = await res.json();
      notifications.show({ title: 'Dataset created', message: `"${data.dataset.name}" (${data.dataset.items.length} items)`, color: 'teal' });
      onCreated(data.dataset);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to create dataset', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New evaluation dataset" centered size="lg">
      <Stack gap="md">
        <TextInput label="Name" placeholder="e.g. Customer FAQ regression set" withAsterisk {...form.getInputProps('name')} />
        <Textarea label="Description" placeholder="What does this dataset cover?" autosize minRows={2} {...form.getInputProps('description')} />
        <Textarea
          label="Items (JSON array)"
          description={<>Each item needs an <Code>input</Code> message array; optional <Code>expected</Code> with mustContain / equals / regex / jsonSchema / jsonPath.</>}
          placeholder={EXAMPLE}
          autosize
          minRows={8}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
          {...form.getInputProps('itemsJson')}
        />
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="teal" loading={loading} onClick={handleSubmit}>Create dataset</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
