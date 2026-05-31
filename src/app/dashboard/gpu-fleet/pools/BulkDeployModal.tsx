'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Stepper,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRocket } from '@tabler/icons-react';
import { GpuFleetApi } from '../_lib/api';
import { formatMemoryMiB } from '../_lib/format';
import type { HostView, ModelLibraryEntry, SliceView } from '../_lib/types';

interface BulkDeployModalProps {
  opened: boolean;
  onClose: () => void;
  onDeployed: () => void;
}

interface HostWithSlices {
  host: HostView;
  freeSlices: SliceView[];
}

type SelectionMap = Record<string, string | undefined>; // hostId -> chosen sliceUuid

export default function BulkDeployModal({ opened, onClose, onDeployed }: BulkDeployModalProps) {
  const [step, setStep] = useState(0);
  const [library, setLibrary] = useState<ModelLibraryEntry[]>([]);
  const [hosts, setHosts] = useState<HostWithSlices[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectionMap>({});
  const [poolName, setPoolName] = useState('');
  const [algorithm, setAlgorithm] = useState('round-robin');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep(0);
    setModelId(null);
    setRuntime(null);
    setSelected({});
    setPoolName('');
  };
  useEffect(() => {
    if (!opened) reset();
  }, [opened]);

  const selectedModel = useMemo(
    () => library.find((m) => m.id === modelId) ?? null,
    [library, modelId],
  );

  const loadLibrary = useCallback(async (accelerator?: string) => {
    const data = await GpuFleetApi.listModelLibrary<{ entries: ModelLibraryEntry[] }>(
      accelerator ? { accelerator } : {},
    );
    setLibrary(data.entries);
  }, []);

  useEffect(() => {
    if (!opened) return;
    void loadLibrary();
  }, [opened, loadLibrary]);

  const loadHosts = useCallback(async () => {
    const hostsResp = await GpuFleetApi.listHosts<{ hosts: HostView[] }>();
    const claimed = hostsResp.hosts.filter((h) => h.status === 'online');
    const enriched = await Promise.all(
      claimed.map(async (host) => {
        const detail = await GpuFleetApi.getHost<{ slices: SliceView[] }>(host.id);
        const free = detail.slices.filter((s) => !s.assignedDeploymentId);
        return { host, freeSlices: free };
      }),
    );
    setHosts(enriched);
  }, []);

  useEffect(() => {
    if (step === 1) void loadHosts();
  }, [step, loadHosts]);

  useEffect(() => {
    if (selectedModel && !runtime) {
      const first = Object.keys(selectedModel.runtimes)[0];
      setRuntime(first ?? null);
    }
    if (selectedModel && !poolName) {
      setPoolName(`${selectedModel.id} pool`);
    }
  }, [selectedModel, runtime, poolName]);

  const compatibleHosts = useMemo(() => {
    if (!selectedModel) return [] as HostWithSlices[];
    return hosts.filter((h) => selectedModel.supportedPlatforms.includes(h.host.accelerator));
  }, [hosts, selectedModel]);

  const selectionCount = Object.values(selected).filter(Boolean).length;
  const targets = Object.entries(selected)
    .filter(([, sliceUuid]) => Boolean(sliceUuid))
    .map(([hostId, sliceUuid]) => ({ hostId, sliceUuid: String(sliceUuid) }));

  const deploy = async () => {
    if (!selectedModel || !runtime || targets.length === 0) return;
    setBusy(true);
    try {
      const runtimeKey = Object.keys(selectedModel.runtimes).find(
        (k) => k === runtime || (k !== 'vllm' && k !== 'tgi' && k !== 'ollama' && runtime === 'custom'),
      );
      const result = await GpuFleetApi.bulkDeploy<{ pool: { key: string }; deployments: unknown[] }>({
        modelLibraryId: selectedModel.id,
        runtimeKey: runtimeKey ?? runtime,
        targets,
        poolName: poolName.trim() || `${selectedModel.id} pool`,
        algorithm,
      });
      notifications.show({
        color: 'teal',
        title: 'Bulk deploy scheduled',
        message: `Pool ${result.pool.key} created with ${result.deployments.length} members`,
      });
      onDeployed();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Bulk deploy failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Bulk deploy" size="xl">
      <Stepper active={step} size="xs" onStepClick={setStep}>
        <Stepper.Step label="Model" />
        <Stepper.Step label="Hosts" />
        <Stepper.Step label="Pool" />
      </Stepper>

      <div style={{ marginTop: 16 }}>
        {step === 0 ? (
          <Stack>
            <Select
              label="Model"
              placeholder="Pick a model from the library"
              searchable
              data={library.map((m) => ({ value: m.id, label: `${m.displayName} · ${m.modality}` }))}
              value={modelId}
              onChange={(v) => { setModelId(v); setRuntime(null); }}
            />
            {selectedModel ? (
              <>
                <Group gap={4}>
                  {selectedModel.tags.slice(0, 6).map((t) => (
                    <Badge key={t} variant="dot" size="xs">{t}</Badge>
                  ))}
                </Group>
                <Text size="xs" c="dimmed">
                  Min {selectedModel.requirements.minVramGiB} GiB VRAM · compute {selectedModel.requirements.computeCapability} · platforms {selectedModel.supportedPlatforms.join(', ')}
                </Text>
                <Select
                  label="Runtime"
                  data={Object.keys(selectedModel.runtimes).map((k) => ({ value: k, label: k }))}
                  value={runtime}
                  onChange={setRuntime}
                />
              </>
            ) : null}
            <Group justify="flex-end">
              <Button onClick={() => setStep(1)} disabled={!selectedModel || !runtime}>
                Next
              </Button>
            </Group>
          </Stack>
        ) : null}

        {step === 1 ? (
          <Stack>
            <Text size="sm" c="dimmed">
              Pick the hosts to deploy on. Only online hosts compatible with the selected model are listed.
            </Text>
            {compatibleHosts.length === 0 ? (
              <Alert color="yellow">
                No compatible hosts online. Onboard a host or pick a different model.
              </Alert>
            ) : (
              <ScrollArea h={320}>
                <Stack gap="xs">
                  {compatibleHosts.map(({ host, freeSlices }) => (
                    <HostTargetRow
                      key={host.id}
                      host={host}
                      slices={freeSlices}
                      chosen={selected[host.id] ?? null}
                      onChoose={(sliceUuid) =>
                        setSelected((prev) => ({ ...prev, [host.id]: sliceUuid ?? undefined }))
                      }
                    />
                  ))}
                </Stack>
              </ScrollArea>
            )}
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {selectionCount} host{selectionCount === 1 ? '' : 's'} selected
              </Text>
              <Group>
                <Button variant="default" onClick={() => setStep(0)}>Back</Button>
                <Button onClick={() => setStep(2)} disabled={selectionCount === 0}>
                  Next
                </Button>
              </Group>
            </Group>
          </Stack>
        ) : null}

        {step === 2 ? (
          <Stack>
            <TextInput
              label="Pool name"
              value={poolName}
              onChange={(e) => setPoolName(e.currentTarget.value)}
            />
            <Select
              label="Load-balancing algorithm"
              data={[
                { value: 'round-robin', label: 'Round robin' },
                { value: 'least-busy', label: 'Least busy (vLLM running requests)' },
                { value: 'random', label: 'Random' },
                { value: 'weighted-static', label: 'Weighted static (manual)' },
              ]}
              value={algorithm}
              onChange={(v) => setAlgorithm(v ?? 'round-robin')}
            />
            <Card withBorder>
              <Text size="sm" fw={600} mb={4}>Summary</Text>
              <Text size="xs" c="dimmed">
                Model <Code>{selectedModel?.id}</Code> via <Code>{runtime}</Code> on {selectionCount} host{selectionCount === 1 ? '' : 's'}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                {targets.map((t) => t.hostId).join(', ')}
              </Text>
            </Card>
            <Group justify="space-between">
              <Button variant="default" onClick={() => setStep(1)}>Back</Button>
              <Button leftSection={<IconRocket size={14} />} onClick={deploy} loading={busy}>
                Deploy {selectionCount} container{selectionCount === 1 ? '' : 's'}
              </Button>
            </Group>
          </Stack>
        ) : null}
      </div>
    </Modal>
  );
}

function HostTargetRow({
  host,
  slices,
  chosen,
  onChoose,
}: {
  host: HostView;
  slices: SliceView[];
  chosen: string | null;
  onChoose: (sliceUuid: string | null) => void;
}) {
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" align="flex-start">
        <Group gap="md" align="flex-start">
          <Checkbox
            checked={Boolean(chosen)}
            onChange={(e) => {
              if (e.currentTarget.checked) {
                onChoose(slices[0]?.uuid ?? null);
              } else {
                onChoose(null);
              }
            }}
            disabled={slices.length === 0}
          />
          <Stack gap={2}>
            <Group gap="xs">
              <Text fw={500} size="sm">{host.name}</Text>
              <Badge variant="outline" size="xs">{host.accelerator}</Badge>
            </Group>
            <Text size="xs" c="dimmed">
              {slices.length} free slice{slices.length === 1 ? '' : 's'}
            </Text>
          </Stack>
        </Group>
        {slices.length > 0 ? (
          <Select
            size="xs"
            data={slices.map((s) => ({
              value: s.uuid,
              label: `${s.kind === 'mig' ? `MIG ${s.profile}` : 'Full GPU'} · ${formatMemoryMiB(s.memoryMiB)}`,
            }))}
            value={chosen ?? null}
            onChange={(v) => onChoose(v)}
            placeholder="pick a slice"
            disabled={!chosen}
          />
        ) : (
          <Text size="xs" c="dimmed">no free slices</Text>
        )}
      </Group>
    </Card>
  );
}
