'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconDeviceFloppy,
  IconPlus,
  IconStack2,
  IconTrash,
} from '@tabler/icons-react';

export interface ReplicaDraft {
  providerKey: string;
  modelId: string;
  weight?: number;
  enabled?: boolean;
  label?: string;
}

interface ReplicaPoolPanelProps {
  modelId: string;
  modelKey: string;
  /** The model's own provider/upstream id — replica zero when no pool exists. */
  ownProviderKey: string;
  ownModelId: string;
  providers: Array<{ key: string; label?: string }>;
  initialReplicas?: ReplicaDraft[];
  onSaved?: (replicas: ReplicaDraft[]) => void;
}

export default function ReplicaPoolPanel({
  modelId,
  modelKey,
  ownProviderKey,
  ownModelId,
  providers,
  initialReplicas,
  onSaved,
}: ReplicaPoolPanelProps) {
  const [replicas, setReplicas] = useState<ReplicaDraft[]>(initialReplicas ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pooled = replicas.length > 0;

  const update = (index: number, patch: Partial<ReplicaDraft>) => {
    setReplicas((current) => current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };

  const add = () => {
    setReplicas((current) => [
      ...current,
      // The first replica seeds from the model's own deployment, so turning a
      // single model into a pool never silently drops the upstream it had.
      current.length === 0
        ? { providerKey: ownProviderKey, modelId: ownModelId, weight: 1, enabled: true }
        : { providerKey: providers[0]?.key ?? '', modelId: ownModelId, weight: 1, enabled: true },
    ]);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/models/${modelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replicas }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Save failed (${response.status})`);
      notifications.show({
        color: 'teal',
        title: pooled ? 'Pool saved' : 'Pool cleared',
        message: pooled
          ? `${modelKey} now serves from ${replicas.filter((r) => r.enabled !== false).length} replica(s).`
          : `${modelKey} is back to a single deployment.`,
      });
      onSaved?.(replicas);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      setError(message);
      notifications.show({ color: 'red', title: 'Could not save the pool', message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group gap="xs" justify="space-between">
            <Group gap="xs">
              <IconStack2 size={18} />
              <Text fw={600}>Replicas</Text>
              <Badge variant="light" color={pooled ? 'teal' : 'gray'}>
                {pooled ? `${replicas.length} in pool` : 'single deployment'}
              </Badge>
            </Group>
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                leftSection={<IconPlus size={14} />}
                onClick={add}
              >
                Add replica
              </Button>
              <Button
                size="xs"
                loading={saving}
                leftSection={<IconDeviceFloppy size={14} />}
                onClick={() => void save()}
              >
                Save
              </Button>
            </Group>
          </Group>

          <Text size="sm" c="dimmed">
            Interchangeable deployments of this same model. Traffic is split by weight across the
            healthy ones, and a request that hits a deployment which is rate-limited, down or
            cooling off is retried on the next — so callers keep asking for{' '}
            <Text span fw={600}>{modelKey}</Text> and never learn which one answered. Routing to a
            different model is a Dynamic LLM, not a pool.
          </Text>

          {replicas.length === 0 ? (
            <Text size="sm" c="dimmed">
              No pool. Every request goes to{' '}
              <Text span fw={600}>{ownProviderKey}</Text> · <Text span fw={600}>{ownModelId}</Text>.
            </Text>
          ) : (
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Provider</Table.Th>
                  <Table.Th>Upstream model / deployment</Table.Th>
                  <Table.Th w={110}>Weight</Table.Th>
                  <Table.Th w={100}>Enabled</Table.Th>
                  <Table.Th w={44} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {replicas.map((replica, index) => (
                  <Table.Tr key={`${replica.providerKey}-${index}`}>
                    <Table.Td>
                      <Select
                        size="xs"
                        data={providers.map((p) => ({ value: p.key, label: p.label || p.key }))}
                        value={replica.providerKey}
                        onChange={(value) => update(index, { providerKey: value ?? '' })}
                        searchable
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        size="xs"
                        placeholder={ownModelId}
                        value={replica.modelId}
                        onChange={(e) => update(index, { modelId: e.currentTarget.value })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <NumberInput
                        size="xs"
                        min={1}
                        value={replica.weight ?? 1}
                        onChange={(value) => update(index, { weight: Number(value) || 1 })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Switch
                        size="sm"
                        checked={replica.enabled !== false}
                        onChange={(e) => update(index, { enabled: e.currentTarget.checked })}
                        aria-label={`Enable replica ${index + 1}`}
                      />
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Remove replica ${index + 1}`}
                        onClick={() => setReplicas((c) => c.filter((_, i) => i !== index))}
                      >
                        <IconTrash size={15} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </Paper>

      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Could not save the pool">
          {error}
        </Alert>
      ) : null}

      <Alert color="gray" variant="light" title="What a pool does not change">
        Pricing, capabilities, guardrail bindings, quota and the semantic cache stay on the model —
        every replica is the same model, so splitting them would fork the bill and the cache.
        Failover covers opening the call; once a streamed answer has started it runs to the end on
        the deployment that began it. Pooling applies to chat completions.
      </Alert>
    </Stack>
  );
}
