'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAdjustments,
  IconBoxModel,
  IconNetwork,
  IconPlayerStop,
  IconRefresh,
  IconRocket,
  IconRotateClockwise,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import TerminalModal from './TerminalModal';
import MigModal from './MigModal';
import DeploymentTimelineDrawer from './DeploymentTimelineDrawer';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { GpuFleetApi } from '../../_lib/api';
import { formatMemoryMiB, formatRelative, statusColor } from '../../_lib/format';
import type {
  DeploymentView,
  HostView,
  ModelLibraryEntry,
  SliceView,
} from '../../_lib/types';

interface HostDetailResponse {
  host: HostView;
  slices: SliceView[];
  deployments: DeploymentView[];
}

export default function GpuFleetHostDetailPage() {
  const params = useParams<{ hostId: string }>();
  const hostId = params?.hostId ?? '';
  const [data, setData] = useState<HostDetailResponse | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [migOpen, setMigOpen] = useState(false);
  const [timelineDeploymentId, setTimelineDeploymentId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!hostId) return;
    if (silent) setRefreshing(true);
    try {
      const fresh = await GpuFleetApi.getHost<HostDetailResponse>(hostId);
      setData(fresh);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to load host',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setRefreshing(false);
    }
  }, [hostId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), 7_000);
    return () => clearInterval(id);
  }, [load]);

  if (!data) {
    return (
      <PageContainer>
        <Text c="dimmed">Loading host…</Text>
      </PageContainer>
    );
  }

  const { host, slices, deployments } = data;
  const inventory = host.inventory ?? {};
  const accelerator = (inventory.accelerator as string | undefined) ?? 'cpu';
  const gpus = (inventory.gpus as Array<{
    uuid: string;
    productName: string;
    memoryTotalMiB: number;
    migEnabled: boolean;
    migCapable: boolean;
  }> | undefined) ?? [];
  const toolchain = (inventory.system as { toolchain?: Record<string, string | null> } | undefined)?.toolchain;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · GPU Fleet"
        title={
          <Group gap="xs">
            <span>{host.name}</span>
            <Badge color={statusColor(host.status)} variant="dot" size="lg">{host.status}</Badge>
          </Group>
        }
        subtitle={
          <Group gap="md">
            <span><Code>{accelerator}</Code></span>
            <span>{gpus.length} GPU</span>
            <span>agent v{host.agentVersion ?? '?'}</span>
            <span>heartbeat {formatRelative(host.lastHeartbeatAt)}</span>
          </Group>
        }
        actions={
          <Group>
            <Button
              variant="default"
              leftSection={<IconRefresh size={14} />}
              onClick={() => void load(true)}
              loading={refreshing}
              size="xs"
            >
              Refresh
            </Button>
            <Button
              variant="default"
              color="orange"
              leftSection={<IconRotateClockwise size={14} />}
              onClick={async () => {
                if (!confirm('Restart the agent on this host? Container deployments will be untouched but heartbeats pause briefly.')) return;
                try {
                  await GpuFleetApi.restartHostAgent(host.id);
                  notifications.show({ color: 'orange', title: 'Restart queued', message: 'Agent will exit and systemd will respawn it within seconds.' });
                } catch (error) {
                  notifications.show({ color: 'red', title: 'Restart failed', message: error instanceof Error ? error.message : 'Unknown error' });
                }
              }}
            >
              Restart agent
            </Button>
            <Button
              variant="default"
              leftSection={<IconTerminal2 size={14} />}
              onClick={() => setTerminalOpen(true)}
            >
              Open terminal
            </Button>
            <Button
              variant="default"
              leftSection={<IconAdjustments size={14} />}
              onClick={() => setMigOpen(true)}
            >
              Reconfigure MIG
            </Button>
            <Button leftSection={<IconRocket size={14} />} onClick={() => setDeployOpen(true)}>
              Deploy model
            </Button>
          </Group>
        }
      />

      <ServiceAddressCard host={host} onChanged={() => void load(true)} />

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="md">
        <Card withBorder>
          <Title order={6} mb="sm">Hardware</Title>
          {gpus.length === 0 ? (
            <Text size="sm" c="dimmed">No GPUs detected.</Text>
          ) : (
            <Stack gap="xs">
              {gpus.map((g, i) => (
                <Group key={i} justify="space-between">
                  <Text size="sm">{g.productName}</Text>
                  <Group gap="xs">
                    <Badge variant="outline" size="xs">{formatMemoryMiB(g.memoryTotalMiB)}</Badge>
                    <Badge variant={g.migEnabled ? 'filled' : 'outline'} color={g.migEnabled ? 'teal' : 'gray'} size="xs">
                      MIG {g.migEnabled ? 'on' : 'off'}
                    </Badge>
                  </Group>
                </Group>
              ))}
            </Stack>
          )}
          {toolchain ? (
            <>
              <Divider my="sm" />
              <Text size="xs" c="dimmed" tt="uppercase" mb={4}>Toolchain</Text>
              <SimpleGrid cols={2}>
                <KV label="driver" value={toolchain.nvidiaDriver} />
                <KV label="cuda" value={toolchain.cuda} />
                <KV label="docker" value={toolchain.docker} />
                <KV label="nvidia-ctk" value={toolchain.nvidiaContainerToolkit} />
              </SimpleGrid>
            </>
          ) : null}
        </Card>

        <Card withBorder>
          <Title order={6} mb="sm">Slices ({slices.length})</Title>
          {slices.length === 0 ? (
            <Text size="sm" c="dimmed">No slices reported yet.</Text>
          ) : (
            <Stack gap="xs">
              {slices.map((s) => <SliceRow key={s.uuid} slice={s} deployments={deployments} />)}
            </Stack>
          )}
        </Card>
      </SimpleGrid>

      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Title order={6}>Deployments ({deployments.length})</Title>
        </Group>
        {deployments.length === 0 ? (
          <Text size="sm" c="dimmed">No deployments. Click "Deploy model" to start one.</Text>
        ) : (
          <Stack gap="xs">
            {deployments.map((d) => (
              <DeploymentRow
                key={d.id}
                deployment={d}
                onChanged={() => void load(true)}
                onViewTimeline={() => setTimelineDeploymentId(d.id)}
              />
            ))}
          </Stack>
        )}
      </Card>

      <DeployModelModal
        opened={deployOpen}
        onClose={() => setDeployOpen(false)}
        host={host}
        slices={slices}
        onDeployed={() => {
          setDeployOpen(false);
          void load(true);
        }}
      />

      <TerminalModal
        opened={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        hostId={host.id}
        hostName={host.name}
        terminalEnabled={host.terminalEnabled}
      />

      <MigModal
        opened={migOpen}
        onClose={() => setMigOpen(false)}
        hostId={host.id}
        gpus={gpus}
        onApplied={() => {
          setMigOpen(false);
          void load(true);
        }}
      />

      <DeploymentTimelineDrawer
        opened={timelineDeploymentId !== null}
        onClose={() => setTimelineDeploymentId(null)}
        deploymentId={timelineDeploymentId}
      />
    </PageContainer>
  );
}

function KV({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" style={{ fontFamily: 'monospace' }}>{value ?? '—'}</Text>
    </Stack>
  );
}

function SliceRow({ slice, deployments }: { slice: SliceView; deployments: DeploymentView[] }) {
  const bound = deployments.find((d) => d.id === slice.assignedDeploymentId);
  return (
    <Group justify="space-between">
      <Group gap="xs">
        <Badge variant="outline" size="xs">{slice.kind}</Badge>
        <Text size="xs" style={{ fontFamily: 'monospace' }}>{slice.uuid.slice(0, 16)}…</Text>
        {slice.profile ? <Badge size="xs" color="blue">{slice.profile}</Badge> : null}
      </Group>
      <Group gap="xs">
        <Badge variant="light" size="xs">{formatMemoryMiB(slice.memoryMiB)}</Badge>
        {bound ? (
          <Badge color="teal" size="xs">{bound.modelName}</Badge>
        ) : (
          <Badge color="gray" variant="outline" size="xs">free</Badge>
        )}
      </Group>
    </Group>
  );
}

function DeploymentRow({
  deployment,
  onChanged,
  onViewTimeline,
}: {
  deployment: DeploymentView;
  onChanged: () => void;
  onViewTimeline: () => void;
}) {
  const stop = async () => {
    try {
      await GpuFleetApi.stopDeployment(deployment.id);
      notifications.show({ color: 'teal', title: 'Stopping deployment', message: deployment.name });
      onChanged();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Stop failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
  const remove = async () => {
    if (!confirm(`Delete deployment "${deployment.name}"?`)) return;
    try {
      await GpuFleetApi.deleteDeployment(deployment.id);
      notifications.show({ color: 'gray', title: 'Deleted', message: deployment.name });
      onChanged();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Delete failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
  const restart = async () => {
    if (!confirm(`Restart "${deployment.name}"? Container will be torn down and rebuilt with the same config.`)) return;
    try {
      await GpuFleetApi.restartDeployment(deployment.id);
      notifications.show({ color: 'orange', title: 'Restart queued', message: deployment.name });
      onChanged();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Restart failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between">
        <Group gap="md">
          <Badge color={statusColor(deployment.actualState)} variant="dot">{deployment.actualState}</Badge>
          <Stack gap={2}>
            <Text fw={600} size="sm">{deployment.name}</Text>
            <Text size="xs" c="dimmed">
              <Code>{deployment.runtime}</Code> · <Code>{deployment.image}</Code>
            </Text>
            <Text size="xs" c="dimmed">model: {deployment.modelName}</Text>
            {deployment.lastError ? (
              <Text size="xs" c="red">last error: {deployment.lastError}</Text>
            ) : null}
          </Stack>
        </Group>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            healthy {formatRelative(deployment.lastHealthyAt)}
          </Text>
          <Tooltip label="View deployment detail + playground">
            <Button
              size="xs"
              variant="light"
              color="teal"
              component="a"
              href={`/dashboard/gpu-fleet/deployments/${deployment.id}`}
            >
              Open
            </Button>
          </Tooltip>
          <Tooltip label="View progress / timeline">
            <Button size="xs" variant="light" onClick={onViewTimeline}>
              Timeline
            </Button>
          </Tooltip>
          {/* Once delete is requested the deployment is in 'removing' state;
              don't let the user fire more actions until the agent confirms. */}
          {deployment.actualState === 'removing' ? (
            <Tooltip label="Removal in progress on the host">
              <Text size="xs" c="orange">removing…</Text>
            </Tooltip>
          ) : deployment.actualState === 'draining' ? (
            <Tooltip label="Restart in progress on the host">
              <Text size="xs" c="orange">restarting…</Text>
            </Tooltip>
          ) : (
            <>
              <Tooltip label="Restart (remove + redeploy with same config)">
                <ActionIcon variant="default" color="orange" onClick={restart}>
                  <IconRotateClockwise size={14} />
                </ActionIcon>
              </Tooltip>
              {deployment.desiredState === 'running' ? (
                <Tooltip label="Stop">
                  <ActionIcon variant="default" onClick={stop}>
                    <IconPlayerStop size={14} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
              <Tooltip label="Delete">
                <ActionIcon variant="default" color="red" onClick={remove}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
        </Group>
      </Group>
    </Card>
  );
}

interface DeployModelModalProps {
  opened: boolean;
  onClose: () => void;
  host: HostView;
  slices: SliceView[];
  onDeployed: () => void;
}

function DeployModelModal({ opened, onClose, host, slices, onDeployed }: DeployModelModalProps) {
  const [library, setLibrary] = useState<ModelLibraryEntry[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(null);
  const [selectedSlice, setSelectedSlice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // vLLM advanced overrides. These map onto well-known CLI flags and we
  // splice them into the runtime template's `args` at deploy time. Defaults
  // here match what the library JSON ships for T4-class hardware; the user
  // can loosen them on larger GPUs.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maxModelLen, setMaxModelLen] = useState<number>(8192);
  const [gpuMemUtil, setGpuMemUtil] = useState<number>(0.85);
  const [enforceEager, setEnforceEager] = useState<boolean>(true);
  const [dtype, setDtype] = useState<string>('auto');
  const [maxNumSeqs, setMaxNumSeqs] = useState<number>(32);
  // Quantization is special: AWQ/GPTQ/FP8 require a pre-quantized HF
  // repo (e.g. `Qwen/Qwen3-8B-AWQ`). `none` = use the model as-shipped.
  // `bitsandbytes` works on the FP16 model and quantizes on the fly.
  const [quantization, setQuantization] = useState<string>('none');
  const [modelNameOverride, setModelNameOverride] = useState<string>('');

  const accelerator = (host.inventory?.accelerator as string | undefined) ?? 'cpu';

  useEffect(() => {
    if (!opened) return;
    void GpuFleetApi.listModelLibrary<{ entries: ModelLibraryEntry[] }>({ accelerator })
      .then((d) => setLibrary(d.entries))
      .catch(() => undefined);
  }, [opened, accelerator]);

  const selected = useMemo(
    () => library.find((m) => m.id === selectedModelId) ?? null,
    [library, selectedModelId],
  );

  useEffect(() => {
    if (selected) {
      // Default to the first runtime that actually works on this host's
      // accelerator. On Apple Silicon / CPU, skip vLLM and TGI even if they
      // appear in the catalog entry — they won't start.
      const compatible = selected.availableRuntimes.filter((r) =>
        host.accelerator === 'nvidia-gpu' ? true : r !== 'vllm' && r !== 'tgi',
      );
      setSelectedRuntime(compatible[0] ?? null);
      if (!name) setName(selected.id);
    }
  }, [selected, name, host.accelerator]);

  const freeSlices = slices.filter((s) => !s.assignedDeploymentId);
  useEffect(() => {
    if (!selectedSlice && freeSlices.length > 0) setSelectedSlice(freeSlices[0].uuid);
  }, [freeSlices, selectedSlice]);

  const deploy = async () => {
    if (!selected || !selectedRuntime || !selectedSlice) return;
    const runtimeKey = Object.keys(selected.runtimes).find(
      (k) => (k === 'vllm' || k === 'tgi' || k === 'ollama' ? k : 'custom') === selectedRuntime,
    );
    if (!runtimeKey) return;
    const raw = selected.runtimes[runtimeKey];
    setBusy(true);
    try {
      const effectiveModel = modelNameOverride.trim() || selected.hfRepo || selected.id;
      // If the user overrode the model name, swap it in the `--model` arg
      // too — otherwise vLLM still pulls the original FP16 repo and the
      // --quantization flag becomes a no-op (or worse, an init error).
      const templateArgs = raw.args.map((a: string) =>
        a === (selected.hfRepo ?? selected.id) ? effectiveModel : a.replace('{{gpuCount}}', '1'),
      );
      const args = applyRuntimeOverrides(
        templateArgs,
        selectedRuntime,
        { maxModelLen, gpuMemUtil, enforceEager, dtype, maxNumSeqs, quantization },
      );
      await GpuFleetApi.createDeployment(host.id, {
        name: name.trim() || selected.id,
        sliceUuid: selectedSlice,
        runtime: selectedRuntime,
        image: raw.image,
        modelName: effectiveModel,
        args,
        env: raw.env ?? {},
        port: raw.port,
      });
      notifications.show({ color: 'teal', title: 'Deployment scheduled', message: name });
      onDeployed();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Deploy failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Deploy model" size="lg">
      <Stack gap="md">
        <Select
          label="Model"
          placeholder="Pick from the library"
          searchable
          data={library.map((m) => ({ value: m.id, label: `${m.displayName} · ${m.modality}` }))}
          value={selectedModelId}
          onChange={setSelectedModelId}
          leftSection={<IconBoxModel size={14} />}
        />

        {selected ? (
          <>
            <Group gap={4}>
              {selected.tags.slice(0, 6).map((t) => (
                <Badge key={t} variant="dot" size="xs">{t}</Badge>
              ))}
            </Group>
            <Text size="xs" c="dimmed">
              Requires {selected.requirements.minVramGiB} GiB+ VRAM ({selected.requirements.computeCapability})
            </Text>

            <Select
              label="Runtime"
              description={
                host.accelerator !== 'nvidia-gpu'
                  ? `vLLM / TGI need an NVIDIA GPU and are hidden on ${host.accelerator} hosts. Pick Ollama for local Apple Silicon / CPU use.`
                  : undefined
              }
              data={selected.availableRuntimes
                .filter((r) =>
                  host.accelerator === 'nvidia-gpu'
                    ? true
                    : r !== 'vllm' && r !== 'tgi',
                )
                .map((r) => ({ value: r, label: r }))}
              value={selectedRuntime}
              onChange={setSelectedRuntime}
            />

            <Select
              label="Slice"
              description="Only free slices on this host are shown."
              data={freeSlices.map((s) => ({
                value: s.uuid,
                label: `${s.kind === 'mig' ? `MIG ${s.profile}` : 'Full GPU'} · ${formatMemoryMiB(s.memoryMiB)}`,
              }))}
              value={selectedSlice}
              onChange={setSelectedSlice}
              disabled={freeSlices.length === 0}
            />

            <TextInput
              label="Deployment name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />

            {selectedRuntime === 'vllm' ? (
              <Card withBorder padding="sm" style={{ background: 'var(--mantine-color-gray-0)' }}>
                <Group justify="space-between" mb={advancedOpen ? 'sm' : 0}>
                  <Group gap="xs">
                    <IconAdjustments size={14} />
                    <Text size="sm" fw={500}>Advanced (vLLM runtime args)</Text>
                  </Group>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setAdvancedOpen((o) => !o)}
                  >
                    {advancedOpen ? 'Hide' : 'Show'}
                  </Button>
                </Group>
                {advancedOpen ? (
                  <Stack gap="xs">
                    <Text size="xs" c="dimmed">
                      Defaults are tuned for T4-class GPUs (16 GB). Loosen these
                      on A100/H100. Bad combos will OOM — start conservative.
                    </Text>
                    <NumberInput
                      label="max-model-len"
                      description="Max context length. Larger = more KV cache memory. 4096–8192 fits T4, 32768+ needs A100."
                      value={maxModelLen}
                      onChange={(v) => setMaxModelLen(Number(v) || 4096)}
                      min={512}
                      max={selected.contextLength ?? 131072}
                      step={1024}
                    />
                    <NumberInput
                      label="gpu-memory-utilization"
                      description="Fraction of VRAM vLLM may use (0.0–0.99). 0.85 safe, 0.9+ aggressive."
                      value={gpuMemUtil}
                      onChange={(v) => setGpuMemUtil(Number(v) || 0.85)}
                      min={0.5}
                      max={0.99}
                      step={0.01}
                      decimalScale={2}
                    />
                    <NumberInput
                      label="max-num-seqs"
                      description="Max concurrent sequences. Lower = less KV cache."
                      value={maxNumSeqs}
                      onChange={(v) => setMaxNumSeqs(Number(v) || 32)}
                      min={1}
                      max={256}
                    />
                    <Select
                      label="dtype"
                      description="Weight precision. auto picks fp16 on most GPUs."
                      data={[
                        { value: 'auto', label: 'auto' },
                        { value: 'float16', label: 'float16 (fp16)' },
                        { value: 'bfloat16', label: 'bfloat16 (newer GPUs)' },
                        { value: 'float32', label: 'float32 (debug only)' },
                      ]}
                      value={dtype}
                      onChange={(v) => setDtype(v ?? 'auto')}
                    />
                    <Checkbox
                      label="enforce-eager (skip CUDA graph compile)"
                      description="Faster startup, ~5% slower inference. Recommended on T4 — graph compile can OOM."
                      checked={enforceEager}
                      onChange={(e) => setEnforceEager(e.currentTarget.checked)}
                    />

                    <Divider my="xs" label="Quantization" labelPosition="left" />
                    <Select
                      label="quantization"
                      description={quantizationHint(quantization, host.accelerator, selected.hfRepo ?? selected.id)}
                      data={[
                        { value: 'none', label: 'none (FP16/BF16 — full weights)' },
                        { value: 'awq', label: 'awq (INT4 — needs *-AWQ repo)' },
                        { value: 'gptq', label: 'gptq (INT4 — needs *-GPTQ repo)' },
                        { value: 'fp8', label: 'fp8 (H100/Ada only)' },
                        { value: 'bitsandbytes', label: 'bitsandbytes (on-the-fly INT8/4)' },
                      ]}
                      value={quantization}
                      onChange={(v) => {
                        const next = v ?? 'none';
                        setQuantization(next);
                        // Helpful default — append the conventional suffix
                        // for awq/gptq if the user hasn't typed a custom
                        // model name yet. They can still edit it.
                        if (!modelNameOverride && selected.hfRepo) {
                          if (next === 'awq') setModelNameOverride(`${selected.hfRepo}-AWQ`);
                          else if (next === 'gptq') setModelNameOverride(`${selected.hfRepo}-Int4`);
                          else if (next === 'fp8') setModelNameOverride(`${selected.hfRepo}-FP8`);
                        }
                      }}
                    />
                    <TextInput
                      label="model name (HF repo)"
                      description={modelNameOverride
                        ? `Will pull from huggingface.co/${modelNameOverride}`
                        : `Default: ${selected.hfRepo ?? selected.id}`}
                      placeholder={selected.hfRepo ?? selected.id}
                      value={modelNameOverride}
                      onChange={(e) => setModelNameOverride(e.currentTarget.value)}
                    />
                  </Stack>
                ) : null}
              </Card>
            ) : null}
          </>
        ) : null}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button
            onClick={deploy}
            loading={busy}
            disabled={!selected || !selectedRuntime || !selectedSlice}
          >
            Deploy
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}


interface VllmOverrides {
  maxModelLen: number;
  gpuMemUtil: number;
  enforceEager: boolean;
  dtype: string;
  maxNumSeqs: number;
  quantization: string;
}

function quantizationHint(
  q: string,
  accelerator: string,
  baseHf: string,
): string {
  switch (q) {
    case 'none':
      return 'Use the model as published — usually FP16/BF16. Largest memory footprint, no accuracy loss.';
    case 'awq':
      return `INT4 weight quant. Cuts VRAM ~3-4×. Requires a pre-quantized HF repo (e.g. ${baseHf}-AWQ). Compatible with T4+.`;
    case 'gptq':
      return `INT4 weight quant. Similar to AWQ. Requires a pre-quantized repo (often named ${baseHf}-GPTQ or -Int4). Compatible with T4+.`;
    case 'fp8':
      return accelerator === 'nvidia-gpu'
        ? `8-bit float quant. ~Lossless, ~2× memory savings. Needs Hopper/Ada (H100/L40/4090) — won't run on T4/V100/A100.`
        : `FP8 requires NVIDIA H100/L40/Ada-class GPU.`;
    case 'bitsandbytes':
      return 'On-the-fly quantization — works with FP16 weights, no special repo needed. Slower than awq/gptq but flexible.';
    default:
      return '';
  }
}

/**
 * Replace or append vLLM CLI flags in the template args array based on
 * the user-supplied overrides from the Deploy modal's Advanced section.
 * Idempotent — if a flag is already present (catalog default), we update
 * its value rather than duplicating it.
 */
function applyRuntimeOverrides(
  args: string[],
  runtime: string,
  overrides: VllmOverrides,
): string[] {
  if (runtime !== 'vllm') return args;
  const setFlag = (acc: string[], flag: string, value: string): string[] => {
    const idx = acc.indexOf(flag);
    if (idx >= 0 && idx + 1 < acc.length) {
      const next = [...acc];
      next[idx + 1] = value;
      return next;
    }
    return [...acc, flag, value];
  };
  const removeFlag = (acc: string[], flag: string): string[] => {
    const idx = acc.indexOf(flag);
    return idx >= 0 ? [...acc.slice(0, idx), ...acc.slice(idx + 1)] : acc;
  };
  let out = args;
  out = setFlag(out, '--max-model-len', String(overrides.maxModelLen));
  out = setFlag(out, '--gpu-memory-utilization', String(overrides.gpuMemUtil));
  out = setFlag(out, '--dtype', overrides.dtype);
  out = setFlag(out, '--max-num-seqs', String(overrides.maxNumSeqs));
  if (overrides.enforceEager) {
    if (!out.includes('--enforce-eager')) out = [...out, '--enforce-eager'];
  } else {
    out = removeFlag(out, '--enforce-eager');
  }
  if (overrides.quantization && overrides.quantization !== 'none') {
    out = setFlag(out, '--quantization', overrides.quantization);
  } else {
    out = removeFlag(out, '--quantization');
  }
  return out;
}

interface ServiceAddressCardProps {
  host: HostView;
  onChanged: () => void;
}

/**
 * Operator-editable address the console uses to reach this host's
 * deployments (pool proxy → container). Three sources surface:
 *   1. Current effective value (what we'd dial right now)
 *   2. Agent-auto-detected public IP (from cloud metadata, if any)
 *   3. Agent-auto-detected private IP (VNet IP)
 *
 * Picking one of those is one click; typing a custom IP/DNS is also
 * supported (Tailscale IPs, ngrok hostnames, …). The override survives
 * agent re-installs.
 */
function ServiceAddressCard({ host, onChanged }: ServiceAddressCardProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(host.serviceAddress ?? '');
  const [busy, setBusy] = useState(false);

  const cloud = (host.inventory?.cloud ?? null) as
    | { provider?: string; publicIp?: string | null; privateIp?: string | null }
    | null;
  const autoPublic = cloud?.publicIp ?? null;
  const autoPrivate = cloud?.privateIp ?? null;
  const autoDefault = (host.inventory as { preferredServiceAddress?: string | null } | null | undefined)
    ?.preferredServiceAddress ?? null;

  const save = async (next: string | null) => {
    setBusy(true);
    try {
      await GpuFleetApi.updateHostServiceAddress(host.id, next);
      notifications.show({ color: 'teal', title: 'Service address updated', message: next ?? '(cleared)' });
      setEditing(false);
      onChanged();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Update failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder mb="md">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconNetwork size={14} />
          <Title order={6}>Service address</Title>
          <Text size="xs" c="dimmed">used by pool proxy → containers</Text>
        </Group>
        {!editing ? (
          <Button size="xs" variant="subtle" onClick={() => { setValue(host.serviceAddress ?? ''); setEditing(true); }}>
            Edit
          </Button>
        ) : null}
      </Group>

      {editing ? (
        <Stack gap="xs">
          <TextInput
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder="e.g. 20.50.10.4, host.tailscale.ts.net, 10.0.0.4"
            data-autofocus
          />
          <Group gap="xs">
            <Button size="xs" loading={busy} onClick={() => save(value.trim() || null)}>Save</Button>
            <Button size="xs" variant="default" onClick={() => setEditing(false)}>Cancel</Button>
            {autoPublic ? (
              <Button size="xs" variant="light" onClick={() => save(autoPublic)}>
                Use public IP ({autoPublic})
              </Button>
            ) : null}
            {autoPrivate ? (
              <Button size="xs" variant="light" onClick={() => save(autoPrivate)}>
                Use private IP ({autoPrivate})
              </Button>
            ) : null}
            {autoDefault && autoDefault !== autoPublic && autoDefault !== autoPrivate ? (
              <Button size="xs" variant="light" onClick={() => save(autoDefault)}>
                Use agent-detected ({autoDefault})
              </Button>
            ) : null}
          </Group>
        </Stack>
      ) : (
        <Stack gap={4}>
          <Group gap="xs">
            <Code>{host.serviceAddress ?? '(none — host unreachable)'}</Code>
            {host.serviceAddress
              && autoDefault
              && host.serviceAddress !== autoDefault ? (
              <Badge size="xs" color="orange" variant="dot">manual override</Badge>
            ) : null}
          </Group>
          <Group gap="md">
            {autoPublic ? (
              <Text size="xs" c="dimmed">
                auto · public <Code>{autoPublic}</Code>
              </Text>
            ) : null}
            {autoPrivate ? (
              <Text size="xs" c="dimmed">
                auto · private <Code>{autoPrivate}</Code>
              </Text>
            ) : null}
            {!autoPublic && !autoPrivate ? (
              <Text size="xs" c="dimmed">
                Cloud metadata unavailable — fell back to local NIC scan.
              </Text>
            ) : null}
          </Group>
        </Stack>
      )}
    </Card>
  );
}
