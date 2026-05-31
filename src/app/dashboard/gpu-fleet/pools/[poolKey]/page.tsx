'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Stepper,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBoxModel,
  IconInfoCircle,
  IconPlus,
  IconRocket,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { GpuFleetApi } from '../../_lib/api';
import { formatRelative, statusColor } from '../../_lib/format';
import type { DeploymentView, PoolView } from '../../_lib/types';

type Algorithm = PoolView['algorithm'];

const ALGORITHM_DESCRIPTIONS: Record<Algorithm, string> = {
  'round-robin': 'One request per member in turn. Simple, predictable, evenly distributed.',
  'least-busy': "Pick the member with the fewest in-flight vLLM requests. Load-aware.",
  'weighted-static': 'Distribute by fixed per-member weights. Ideal for heterogeneous hardware.',
  random: 'Pick a random member. Useful for testing/debugging only.',
};

interface PoolListResponse {
  pools: PoolView[];
}

interface DeploymentSummary {
  id: string;
  name: string;
  modelName: string;
  actualState: DeploymentView['actualState'];
  hostId: string;
  lastError: string | null;
  lastHealthyAt: string | Date | null;
}

export default function GpuFleetPoolDetailPage() {
  const params = useParams<{ poolKey: string }>();
  const poolKey = params?.poolKey ?? '';
  const [pool, setPool] = useState<PoolView | null>(null);
  const [members, setMembers] = useState<DeploymentSummary[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  const load = useCallback(async () => {
    if (!poolKey) return;
    try {
      const data = await GpuFleetApi.listPools<PoolListResponse>();
      const target = data.pools.find((p) => p.key === poolKey) ?? null;
      setPool(target);
      if (target && target.deploymentIds.length > 0) {
        const summaries = await Promise.all(
          target.deploymentIds.map((id) =>
            fetch(`/api/gpu-fleet/deployments/${id}`)
              .then(async (res) => (res.ok ? res.json() : null))
              .catch(() => null),
          ),
        );
        setMembers(
          summaries
            .map((s) => s?.deployment)
            .filter((d: unknown): d is DeploymentSummary => Boolean(d)),
        );
      } else {
        setMembers([]);
      }
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to load pool',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [poolKey]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 8_000);
    return () => clearInterval(id);
  }, [load]);

  const healthy = useMemo(() => members.filter((m) => m.actualState === 'healthy'), [members]);

  const changeAlgorithm = async (algorithm: Algorithm) => {
    if (!pool) return;
    try {
      await GpuFleetApi.patchPool(pool.key, { algorithm });
      notifications.show({ color: 'teal', title: 'Algorithm updated', message: algorithm });
      void load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Update failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const setWeight = async (deploymentId: string, weight: number) => {
    if (!pool) return;
    const next = { ...pool.weights, [deploymentId]: weight };
    try {
      await GpuFleetApi.patchPool(pool.key, { weights: next });
      void load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Weight update failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const removeMember = async (deploymentId: string) => {
    if (!pool) return;
    if (!confirm('Remove this deployment from the pool? The container keeps running.')) return;
    try {
      await GpuFleetApi.detachMember(pool.key, deploymentId);
      notifications.show({ color: 'gray', title: 'Member removed', message: '' });
      void load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Remove failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  if (!pool) {
    return (
      <PageContainer>
        <Text c="dimmed">Loading pool…</Text>
      </PageContainer>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const proxyUrl = `${origin}/api/internal/gpu-pool/${pool.key}/v1`;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · GPU Fleet · Pools"
        title={
          <Group gap="xs">
            <span>{pool.name}</span>
            <Badge color={pool.status === 'active' ? 'teal' : 'gray'} variant="dot">{pool.status}</Badge>
          </Group>
        }
        subtitle={
          <Group gap="md">
            <span>model: <Code>{pool.modelName}</Code></span>
            <span>{healthy.length} healthy / {members.length} members</span>
          </Group>
        }
        actions={
          <Group>
            {pool.providerKey ? (
              <Tooltip label={`Provider: ${pool.providerKey} · Model: ${pool.modelKey}`}>
                <Badge color="violet" variant="light" size="lg" leftSection={<IconBoxModel size={12} />}>
                  Published
                </Badge>
              </Tooltip>
            ) : (
              <Button leftSection={<IconRocket size={14} />} onClick={() => setPublishOpen(true)}>
                Publish to Model Hub
              </Button>
            )}
          </Group>
        }
      />

      <Card withBorder mb="md">
        <Stack gap="xs">
          <Group justify="space-between">
            <Title order={6}>OpenAI-compatible endpoint</Title>
            <Badge variant="dot" color="blue" size="sm">{pool.algorithm}</Badge>
          </Group>
          <Group gap="xs">
            <Code style={{ flex: 1 }}>{proxyUrl}</Code>
            <CopyButton value={proxyUrl}>
              {({ copied, copy }) => (
                <Button size="xs" variant={copied ? 'filled' : 'default'} onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Text size="xs" c="dimmed">
            Paste this into the <Code>baseURL</Code> of any OpenAI SDK. The Bearer token must be a valid tenant API token.
            If the pool is already published to Model Hub, the matching provider record uses this URL automatically.
          </Text>
        </Stack>
      </Card>

      <Card withBorder mb="md">
        <Stack gap="xs">
          <Group justify="space-between">
            <Title order={6}>Load-balancing</Title>
            <Tooltip label="Algorithm changes apply to the next request — in-flight requests are unaffected.">
              <IconInfoCircle size={14} />
            </Tooltip>
          </Group>
          <Select
            data={[
              { value: 'round-robin', label: 'Round robin' },
              { value: 'least-busy', label: 'Least busy (vLLM running requests)' },
              { value: 'weighted-static', label: 'Weighted static' },
              { value: 'random', label: 'Random' },
            ]}
            value={pool.algorithm}
            onChange={(v) => v && changeAlgorithm(v as Algorithm)}
          />
          <Text size="xs" c="dimmed">{ALGORITHM_DESCRIPTIONS[pool.algorithm]}</Text>
        </Stack>
      </Card>

      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Title order={6}>Members ({members.length})</Title>
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setAddMemberOpen(true)}
          >
            Add member
          </Button>
        </Group>
        {members.length === 0 ? (
          <Alert color="blue" icon={<IconInfoCircle size={16} />}>
            <Text size="sm">Pool is empty. Two ways to add deployments:</Text>
            <Text size="sm" mt={4}>
              1. Click <strong>Add member</strong> to attach an existing deployment that already serves this model.
              <br />
              2. Use <strong>Bulk deploy</strong> to spin up the same model on additional hosts.
            </Text>
          </Alert>
        ) : (
          <Stack gap="xs">
            {members.map((m) => {
              const weight = pool.weights[m.id] ?? 1;
              return (
                <Card key={m.id} withBorder padding="sm">
                  <Group justify="space-between">
                    <Group gap="md">
                      <Badge color={statusColor(m.actualState)} variant="dot">{m.actualState}</Badge>
                      <Stack gap={2}>
                        <Text size="sm" fw={500}>{m.name}</Text>
                        <Text size="xs" c="dimmed">{m.modelName}</Text>
                        {m.lastError ? (
                          <Text size="xs" c="red">{m.lastError}</Text>
                        ) : null}
                      </Stack>
                    </Group>
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">healthy {formatRelative(m.lastHealthyAt)}</Text>
                      {pool.algorithm === 'weighted-static' ? (
                        <Tooltip label="Higher weight = more requests routed here">
                          <NumberInput
                            size="xs"
                            w={80}
                            min={0}
                            step={1}
                            value={weight}
                            onChange={(value) => {
                              const num = typeof value === 'number' ? value : Number.parseFloat(String(value));
                              if (Number.isFinite(num)) setWeight(m.id, num);
                            }}
                          />
                        </Tooltip>
                      ) : null}
                      <Tooltip label="Pool'dan çıkar">
                        <ActionIcon variant="default" color="red" onClick={() => removeMember(m.id)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Group>
                </Card>
              );
            })}
          </Stack>
        )}
      </Card>

      <PublishPoolModal
        opened={publishOpen}
        onClose={() => setPublishOpen(false)}
        poolKey={pool.key}
        defaultModality={inferModality(pool.modelName)}
        onPublished={() => {
          setPublishOpen(false);
          void load();
        }}
      />

      <AddMemberModal
        opened={addMemberOpen}
        onClose={() => setAddMemberOpen(false)}
        poolKey={pool.key}
        modelName={pool.modelName}
        onAttached={() => {
          setAddMemberOpen(false);
          void load();
        }}
      />
    </PageContainer>
  );
}

function inferModality(modelName: string): 'llm' | 'embedding' | 'stt' | 'tts' | 'ocr' {
  const lower = modelName.toLowerCase();
  if (lower.includes('bge') || lower.includes('embed')) return 'embedding';
  if (lower.includes('whisper')) return 'stt';
  if (lower.includes('xtts') || lower.includes('tts')) return 'tts';
  if (lower.includes('ocr')) return 'ocr';
  return 'llm';
}

interface AddMemberModalProps {
  opened: boolean;
  onClose: () => void;
  poolKey: string;
  modelName: string;
  onAttached: () => void;
}

function AddMemberModal({ opened, onClose, poolKey, modelName, onAttached }: AddMemberModalProps) {
  const [candidates, setCandidates] = useState<DeploymentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opened) return;
    void GpuFleetApi.listPoolCandidates<{ candidates: DeploymentSummary[] }>(poolKey)
      .then((data) => setCandidates(data.candidates))
      .catch(() => undefined);
  }, [opened, poolKey]);

  const attach = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await GpuFleetApi.attachMember(poolKey, selected);
      notifications.show({ color: 'teal', title: 'Member added', message: '' });
      onAttached();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Attach failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add pool member" size="md">
      <Stack>
        <Alert color="blue" icon={<IconInfoCircle size={16} />}>
          Only deployments serving <Code>{modelName}</Code> are listed. If none show up,
          use <strong>Bulk deploy</strong> to spin this model up on a new host.
        </Alert>
        {candidates.length === 0 ? (
          <Text size="sm" c="dimmed">
            No eligible candidates. Deploy the same model (<Code>{modelName}</Code>) on another host first, then come back.
          </Text>
        ) : (
          <Select
            label="Deployment"
            data={candidates.map((c) => ({
              value: c.id,
              label: `${c.name} · ${c.actualState}`,
            }))}
            value={selected}
            onChange={setSelected}
            placeholder="Pick a deployment"
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button onClick={attach} loading={busy} disabled={!selected}>
            Add to pool
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface PublishPoolModalProps {
  opened: boolean;
  onClose: () => void;
  poolKey: string;
  defaultModality: 'llm' | 'embedding' | 'stt' | 'tts' | 'ocr';
  onPublished: () => void;
}

function PublishPoolModal({ opened, onClose, poolKey, defaultModality, onPublished }: PublishPoolModalProps) {
  const [modality, setModality] = useState<string>(defaultModality);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ providerKey: string; modelKey: string; bearerToken?: string } | null>(null);

  useEffect(() => {
    if (opened) {
      setResult(null);
      setModality(defaultModality);
    }
  }, [opened, defaultModality]);

  const publish = async () => {
    setBusy(true);
    try {
      const data = await GpuFleetApi.publishPool<{
        providerKey: string;
        modelKey: string;
        bearerToken?: string;
      }>(poolKey, modality);
      setResult(data);
      notifications.show({
        color: 'teal',
        title: 'Published',
        message: `Provider ${data.providerKey}, Model ${data.modelKey}`,
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Publish failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Publish pool to Model Hub" size="lg">
      <Stack>
        <Stepper active={result ? 1 : 0} size="xs">
          <Stepper.Step label="Modality + publish" />
          <Stepper.Step label="Done" />
        </Stepper>
        <Text size="sm" c="dimmed">
          Publish this pool to Model Hub: an OpenAI-compatible <Code>Provider</Code> and a <Code>Model</Code> record will be created.
          A tenant API token is minted and written encrypted into the Provider record.
        </Text>
        <Select
          label="Modality"
          description="What does this pool produce?"
          data={[
            { value: 'llm', label: 'LLM (chat/completions)' },
            { value: 'embedding', label: 'Embedding' },
            { value: 'stt', label: 'Speech-to-Text' },
            { value: 'tts', label: 'Text-to-Speech' },
            { value: 'ocr', label: 'OCR' },
          ]}
          value={modality}
          onChange={(v) => setModality(v ?? 'llm')}
          disabled={Boolean(result)}
        />
        {result ? (
          <>
            <Alert color="teal" icon={<IconBoxModel size={16} />}>
              Published. Provider key <Code>{result.providerKey}</Code>, Model key <Code>{result.modelKey}</Code>.
            </Alert>
            {result.bearerToken ? (
              <Alert color="yellow" icon={<IconShieldLock size={16} />}>
                <Stack gap={4}>
                  <Text size="sm">
                    Pool-internal API token. Shown ONCE — if you lose it, <strong>rotate</strong> to mint a new one.
                  </Text>
                  <Code block>{result.bearerToken}</Code>
                </Stack>
              </Alert>
            ) : null}
          </>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result ? (
            <Button onClick={publish} loading={busy} leftSection={<IconBoxModel size={14} />}>
              Publish
            </Button>
          ) : (
            <Button onClick={onPublished}>Done</Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
