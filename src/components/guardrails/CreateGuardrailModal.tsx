'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  SimpleGrid,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconShield,
  IconRobot,
  IconAlertTriangle,
} from '@tabler/icons-react';
import type { GuardrailView } from '@/lib/services/guardrail/constants';

interface ModelOption {
  value: string;
  label: string;
}

interface CreateGuardrailModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (guardrail: GuardrailView) => void;
  models?: ModelOption[];
}

const GUARD_TYPES = [
  {
    value: 'preset',
    icon: IconShield,
    label: 'Preset',
    description: 'Pre-built checks: PII detection, content moderation, prompt shield',
    color: 'violet',
  },
  {
    value: 'custom',
    icon: IconRobot,
    label: 'Custom Prompt',
    description: 'Write your own safety rule evaluated by an LLM',
    color: 'teal',
  },
];

const TARGET_OPTIONS = [
  { value: 'input', label: 'Input (user messages)' },
  { value: 'output', label: 'Output (model responses)' },
  { value: 'both', label: 'Both' },
];

const ACTION_OPTIONS = [
  { value: 'block', label: 'Block — stop the request' },
  { value: 'warn', label: 'Warn — allow but flag' },
  { value: 'flag', label: 'Flag — log for review' },
];

interface FormValues {
  name: string;
  description: string;
  type: 'preset' | 'custom';
  target: 'input' | 'output' | 'both';
  action: 'block' | 'warn' | 'flag';
  modelKey: string;
  customPrompt: string;
}

export default function CreateGuardrailModal({
  opened,
  onClose,
  onCreated,
  models = [],
}: CreateGuardrailModalProps) {
  const [loading, setLoading] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      type: 'preset',
      target: 'input',
      action: 'block',
      modelKey: '',
      customPrompt: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      customPrompt: (v, values) =>
        values.type === 'custom' && !v.trim()
          ? 'Custom prompt is required for custom guardrails'
          : null,
      modelKey: (v, values) =>
        values.type === 'custom' && !v
          ? 'A model is required for custom guardrails'
          : null,
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleSubmit = async (values: FormValues) => {
    setLoading(true);
    try {
      const res = await fetch('/api/guardrails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          type: values.type,
          target: values.target,
          action: values.action,
          modelKey: values.modelKey || undefined,
          customPrompt: values.type === 'custom' ? values.customPrompt : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create guardrail');
      }

      const data = await res.json();
      notifications.show({
        title: 'Guardrail created',
        message: `"${data.guardrail.name}" was created successfully`,
        color: 'teal',
      });
      onCreated(data.guardrail);
      onClose();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to create guardrail',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={<Text fw={600} size="lg">Create Guardrail</Text>}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          {/* Type selection */}
          <div>
            <Text size="sm" fw={500} mb={8}>
              Guardrail type
            </Text>
            <SimpleGrid cols={2} spacing="sm">
              {GUARD_TYPES.map((gt) => (
                <Card
                  key={gt.value}
                  withBorder
                  style={{
                    cursor: 'pointer',
                    borderColor:
                      form.values.type === gt.value
                        ? `var(--mantine-color-${gt.color}-5)`
                        : undefined,
                    background:
                      form.values.type === gt.value
                        ? `var(--mantine-color-${gt.color}-0)`
                        : undefined,
                  }}
                  onClick={() => form.setFieldValue('type', gt.value as 'preset' | 'custom')}
                  p="sm"
                >
                  <Group gap="sm" align="flex-start" wrap="nowrap">
                    <ThemeIcon size={36} radius="md" variant="light" color={gt.color}>
                      <gt.icon size={18} />
                    </ThemeIcon>
                    <div>
                      <Text fw={600} size="sm">{gt.label}</Text>
                      <Text size="xs" c="dimmed" mt={2}>{gt.description}</Text>
                    </div>
                  </Group>
                </Card>
              ))}
            </SimpleGrid>
          </div>

          <TextInput
            label="Name"
            placeholder="e.g. Block PII leak"
            required
            {...form.getInputProps('name')}
          />

          <Textarea
            label="Description"
            placeholder="What does this guardrail protect against?"
            rows={2}
            {...form.getInputProps('description')}
          />

          <Group grow>
            <Select
              label="Target"
              data={TARGET_OPTIONS}
              {...form.getInputProps('target')}
            />
            <Select
              label="Default action"
              data={ACTION_OPTIONS}
              {...form.getInputProps('action')}
              description={
                form.values.action === 'block'
                  ? 'Request will be rejected'
                  : form.values.action === 'warn'
                    ? 'Request continues but flagged'
                    : 'Request logged for review'
              }
            />
          </Group>

          {/* Model selector — required for custom, optional for preset (moderation / prompt shield) */}
          {(form.values.type === 'custom' || models.length > 0) && (
            <Select
              label="Model"
              description={
                form.values.type === 'custom'
                  ? 'LLM used to evaluate the custom rule'
                  : 'LLM used for moderation and prompt shield checks (optional)'
              }
              placeholder="Select a model…"
              data={models}
              clearable={form.values.type !== 'custom'}
              required={form.values.type === 'custom'}
              {...form.getInputProps('modelKey')}
            />
          )}

          {/* Custom prompt */}
          {form.values.type === 'custom' && (
            <Textarea
              label="Custom rule"
              description="Describe your safety rule. The LLM will evaluate whether each message passes or fails."
              placeholder={
                'Example: Block any message that asks for personally identifiable information about real people, or that attempts to impersonate authority figures such as doctors, lawyers, or government officials.'
              }
              minRows={5}
              required
              {...form.getInputProps('customPrompt')}
            />
          )}

          {form.values.type === 'preset' && (
            <Card withBorder p="sm" bg="gray.0">
              <Group gap="xs">
                <IconAlertTriangle size={15} color="var(--mantine-color-orange-6)" />
                <Text size="xs" c="dimmed">
                  After creating, configure PII categories, moderation topics, and prompt shield in the guardrail settings.
                </Text>
              </Group>
            </Card>
          )}

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Create Guardrail
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
