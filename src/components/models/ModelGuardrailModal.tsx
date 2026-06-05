'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconShield,
  IconShieldOff,
} from '@tabler/icons-react';

interface GuardrailOption {
  value: string;
  label: string;
  type: 'preset' | 'custom';
  action: string;
  enabled: boolean;
}

interface ModelGuardrailModalProps {
  opened: boolean;
  modelId: string;
  modelName: string;
  initialInputGuardrailKey?: string;
  initialOutputGuardrailKey?: string;
  onClose: () => void;
  onSaved: (inputKey: string | null, outputKey: string | null) => void;
}

export default function ModelGuardrailModal({
  opened,
  modelId,
  modelName,
  initialInputGuardrailKey,
  initialOutputGuardrailKey,
  onClose,
  onSaved,
}: ModelGuardrailModalProps) {
  const [guardrails, setGuardrails] = useState<GuardrailOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [inputKey, setInputKey] = useState<string | null>(initialInputGuardrailKey ?? null);
  const [outputKey, setOutputKey] = useState<string | null>(initialOutputGuardrailKey ?? null);

  // Re-sync when modal opens with new model
  useEffect(() => {
    if (opened) {
      setInputKey(initialInputGuardrailKey ?? null);
      setOutputKey(initialOutputGuardrailKey ?? null);
    }
  }, [opened, initialInputGuardrailKey, initialOutputGuardrailKey]);

  // Load guardrails when modal opens
  useEffect(() => {
    if (!opened) return;

    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/guardrails?enabled=true', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load guardrails');
        const data = await res.json();
        const items = (data.guardrails ?? []) as {
          key: string;
          name: string;
          type: 'preset' | 'custom';
          action: string;
          enabled: boolean;
        }[];
        setGuardrails(
          items.map((g) => ({
            value: g.key,
            label: g.name,
            type: g.type,
            action: g.action,
            enabled: g.enabled,
          })),
        );
      } catch (err) {
        console.error('[model-guardrail-modal]', err);
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [opened]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/models/${modelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputGuardrailKey: inputKey ?? '',
          outputGuardrailKey: outputKey ?? '',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? 'Failed to save');
      }
      notifications.show({
        title: 'Guardrails saved',
        message: `Guardrail settings updated for "${modelName}"`,
        color: 'teal',
        icon: <IconCheck size={16} />,
      });
      onSaved(inputKey, outputKey);
      onClose();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to save',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const selectData = guardrails.map((g) => ({
    value: g.value,
    label: `${g.label} [${g.type} · ${g.action}]`,
  }));

  const inputGuardrail = guardrails.find((g) => g.value === inputKey);
  const outputGuardrail = guardrails.find((g) => g.value === outputKey);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="sm">
          <ThemeIcon size={28} radius="md" variant="light" color="violet">
            <IconShield size={14} />
          </ThemeIcon>
          <div>
            <Text fw={600} size="sm">Guardrail Settings</Text>
            <Text size="xs" c="dimmed">{modelName}</Text>
          </div>
        </Group>
      }
      size="md"
      centered
    >
      {loading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      ) : (
        <Stack gap="md">
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="blue"
            variant="light"
            p="sm"
          >
            <Text size="xs">
              Guardrails run automatically on every request to this model. Input guardrails check
              the user message before calling the LLM. Output guardrails check the response before
              it is returned.
            </Text>
          </Alert>

          {guardrails.length === 0 ? (
            <Stack align="center" gap="sm" py="md">
              <ThemeIcon size={40} radius="xl" variant="light" color="gray">
                <IconShieldOff size={20} />
              </ThemeIcon>
              <Text size="sm" c="dimmed" ta="center">
                No guardrails defined yet.{' '}
                <Text
                  component="a"
                  href="/dashboard/guardrails"
                  size="sm"
                  c="teal"
                  style={{ cursor: 'pointer' }}
                >
                  Create one first.
                </Text>
              </Text>
            </Stack>
          ) : (
            <>
              {/* Input guardrail */}
              <Stack gap="xs">
                <Group gap="xs">
                  <ThemeIcon size={22} radius="sm" variant="light" color="blue">
                    <IconArrowDown size={12} />
                  </ThemeIcon>
                  <Text fw={500} size="sm">Input Guardrail</Text>
                  <Text size="xs" c="dimmed">(checks user message)</Text>
                </Group>
                <Select
                  placeholder="None — no input check"
                  data={selectData}
                  value={inputKey}
                  onChange={setInputKey}
                  clearable
                  searchable
                />
                {inputGuardrail && (
                  <Group gap="xs" ml={4}>
                    <Badge size="xs" variant="light" color={inputGuardrail.type === 'preset' ? 'violet' : 'teal'}>
                      {inputGuardrail.type}
                    </Badge>
                    <Badge
                      size="xs"
                      variant="light"
                      color={{ block: 'red', warn: 'orange', flag: 'blue' }[inputGuardrail.action] ?? 'gray'}
                    >
                      {inputGuardrail.action}
                    </Badge>
                  </Group>
                )}
              </Stack>

              <Divider />

              {/* Output guardrail */}
              <Stack gap="xs">
                <Group gap="xs">
                  <ThemeIcon size={22} radius="sm" variant="light" color="green">
                    <IconArrowUp size={12} />
                  </ThemeIcon>
                  <Text fw={500} size="sm">Output Guardrail</Text>
                  <Text size="xs" c="dimmed">(checks LLM response · non-streaming only)</Text>
                </Group>
                <Select
                  placeholder="None — no output check"
                  data={selectData}
                  value={outputKey}
                  onChange={setOutputKey}
                  clearable
                  searchable
                />
                {outputGuardrail && (
                  <Group gap="xs" ml={4}>
                    <Badge size="xs" variant="light" color={outputGuardrail.type === 'preset' ? 'violet' : 'teal'}>
                      {outputGuardrail.type}
                    </Badge>
                    <Badge
                      size="xs"
                      variant="light"
                      color={{ block: 'red', warn: 'orange', flag: 'blue' }[outputGuardrail.action] ?? 'gray'}
                    >
                      {outputGuardrail.action}
                    </Badge>
                  </Group>
                )}
              </Stack>
            </>
          )}

          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={guardrails.length === 0}
              leftSection={<IconShield size={14} />}
            >
              Save
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
