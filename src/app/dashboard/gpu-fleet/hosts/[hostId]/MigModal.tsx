'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Code,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconAdjustments } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { formatMemoryMiB } from '../../_lib/format';

interface GpuDevice {
  uuid: string;
  productName: string;
  memoryTotalMiB: number;
  migEnabled: boolean;
  migCapable: boolean;
}

interface MigModalProps {
  opened: boolean;
  onClose: () => void;
  hostId: string;
  gpus: GpuDevice[];
  onApplied: () => void;
}

/**
 * Common A100/H100 profile presets. Keep this short — admins know which
 * profile they want; we're just saving them from typing the layout strings.
 */
const PRESETS: Array<{ label: string; profiles: string[] }> = [
  { label: 'Disable MIG (full GPU)', profiles: [] },
  { label: '1× 7g.80gb (whole card as one MIG)', profiles: ['7g.80gb'] },
  { label: '2× 3g.40gb', profiles: ['3g.40gb', '3g.40gb'] },
  { label: '3× 2g.20gb + 1× 1g.10gb', profiles: ['2g.20gb', '2g.20gb', '2g.20gb', '1g.10gb'] },
  { label: '7× 1g.10gb (max instances)', profiles: ['1g.10gb', '1g.10gb', '1g.10gb', '1g.10gb', '1g.10gb', '1g.10gb', '1g.10gb'] },
];

export default function MigModal({ opened, onClose, hostId, gpus, onApplied }: MigModalProps) {
  const migCapable = gpus.filter((g) => g.migCapable);
  const [gpuUuid, setGpuUuid] = useState<string | null>(migCapable[0]?.uuid ?? null);
  const [presetIndex, setPresetIndex] = useState<string>('0');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (opened && migCapable.length > 0 && !gpuUuid) {
      setGpuUuid(migCapable[0].uuid);
    }
  }, [opened, migCapable, gpuUuid]);

  const preset = PRESETS[Number.parseInt(presetIndex, 10)] ?? PRESETS[0];

  const apply = async () => {
    if (!gpuUuid) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/gpu-fleet/hosts/${hostId}/mig`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gpuUuid, profiles: preset.profiles }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      notifications.show({
        color: 'teal',
        title: 'MIG reconfigure scheduled',
        message: 'The agent will drain bound deployments and apply the layout shortly.',
      });
      onApplied();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'MIG apply failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Reconfigure MIG" size="lg">
      {migCapable.length === 0 ? (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
          No MIG-capable GPUs on this host. MIG is supported on A100 / H100 / H200 / B100 class cards.
        </Alert>
      ) : (
        <Stack>
          <Select
            label="Target GPU"
            data={migCapable.map((g) => ({
              value: g.uuid,
              label: `${g.productName} (${formatMemoryMiB(g.memoryTotalMiB)}) · ${g.migEnabled ? 'MIG on' : 'MIG off'}`,
            }))}
            value={gpuUuid}
            onChange={setGpuUuid}
          />
          <Select
            label="Layout"
            data={PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
            value={presetIndex}
            onChange={(v) => setPresetIndex(v ?? '0')}
          />
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            <Stack gap={4}>
              <Title order={6}>Destructive operation</Title>
              <Text size="sm">
                Every container currently bound to a slice on this GPU will be stopped before the reconfigure.
                The new layout takes effect after the agent calls <Code>nvidia-smi mig</Code>; deployments will
                need to be re-attached to the new slice UUIDs.
              </Text>
              <Text size="xs" c="dimmed">
                Profiles: {preset.profiles.length === 0 ? 'MIG disabled' : preset.profiles.join(', ')}
              </Text>
            </Stack>
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button leftSection={<IconAdjustments size={14} />} color="red" onClick={apply} loading={busy}>
              Apply layout
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
