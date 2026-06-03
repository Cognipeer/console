'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle } from '@tabler/icons-react';
import type { EvalTargetView, ModelOption } from './types';

interface CreateTargetModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (target: EvalTargetView) => void;
  models?: ModelOption[];
}

interface FormValues {
  name: string;
  description: string;
  kind: 'agent' | 'model' | 'external';
  modelKey: string;
  agentKey: string;
}

const KIND_OPTIONS = [
  { value: 'model', label: 'Model — a registered model' },
  { value: 'agent', label: 'Agent — a registered agent' },
  { value: 'external', label: 'External — an HTTP endpoint' },
];

export default function CreateTargetModal({ opened, onClose, onCreated, models = [] }: CreateTargetModalProps) {
  const [loading, setLoading] = useState(false);
  const form = useForm<FormValues>({
    initialValues: { name: '', description: '', kind: 'model', modelKey: '', agentKey: '' },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      modelKey: (v, values) => (values.kind === 'model' && !v ? 'A model is required for model targets' : null),
      agentKey: (v, values) => (values.kind === 'agent' && !v.trim() ? 'An agent key is required for agent targets' : null),
    },
  });

  useEffect(() => {
    if (!opened) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleSubmit = async () => {
    if (form.validate().hasErrors) return;
    const v = form.getValues();
    setLoading(true);
    try {
      const res = await fetch('/api/evaluation/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: v.name.trim(),
          description: v.description || undefined,
          kind: v.kind,
          modelKey: v.kind === 'model' ? v.modelKey : undefined,
          agentKey: v.kind === 'agent' ? v.agentKey.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create target');
      }
      const data = await res.json();
      notifications.show({ title: 'Target created', message: `"${data.target.name}" was created`, color: 'teal' });
      onCreated(data.target);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to create target', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const kind = form.getValues().kind;

  return (
    <Modal opened={opened} onClose={onClose} title="New evaluation target" centered size="lg">
      <Stack gap="md">
        <TextInput label="Name" placeholder="e.g. GPT-4o production model" withAsterisk {...form.getInputProps('name')} />
        <Textarea label="Description" placeholder="What is this target?" autosize minRows={2} {...form.getInputProps('description')} />
        <Select label="Kind" data={KIND_OPTIONS} withAsterisk {...form.getInputProps('kind')} />

        {kind === 'model' && (
          <Select
            label="Model"
            placeholder="Select a model…"
            data={models}
            searchable
            withAsterisk
            {...form.getInputProps('modelKey')}
          />
        )}
        {kind === 'agent' && (
          <TextInput label="Agent key" placeholder="agent key" withAsterisk {...form.getInputProps('agentKey')} />
        )}
        {kind === 'agent' && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            Agent targets can be created now; live agent execution lands in a follow-up — runs against agent targets are
            recorded as per-item errors for now.
          </Alert>
        )}
        {kind === 'external' && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            External HTTP endpoint configuration is coming soon. The target will be created, but runs against it are
            recorded as per-item errors until the adapter ships.
          </Alert>
        )}

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="teal" loading={loading} onClick={handleSubmit}>Create target</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
