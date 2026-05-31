'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBox,
  IconNetwork,
  IconPlayerPlay,
  IconRotateClockwise,
  IconTimeline,
} from '@tabler/icons-react';
import ModelPlayground from '@/components/playground/ModelPlayground';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { GpuFleetApi } from '../../_lib/api';
import { formatRelative, statusColor } from '../../_lib/format';
import type { DeploymentView } from '../../_lib/types';

interface DeploymentDetailResponse {
  deployment: DeploymentView;
  host: {
    id: string;
    name: string;
    accelerator: string;
    serviceAddress: string | null;
  } | null;
  pool: {
    key: string;
    name: string;
    providerKey: string | null;
    modelKey: string | null;
  } | null;
  inferenceServer: {
    key: string;
    baseUrl: string;
    status: string;
  } | null;
}

/**
 * Standalone view for a single deployment. Useful when one host runs 3-4
 * models — the host page only shows the row; this page is the place to
 * actually USE the model (playground), inspect its endpoint, and see the
 * auto-registered Model Hub entry.
 *
 * Two routes converge here:
 *   - clicking a deployment row on the host page → opens here
 *   - the Timeline drawer's "View deployment page" link
 */
export default function DeploymentDetailPage() {
  const params = useParams<{ deploymentId: string }>();
  const deploymentId = params?.deploymentId ?? '';
  const [data, setData] = useState<DeploymentDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'playground' | 'timeline'>('overview');

  const load = useCallback(async () => {
    if (!deploymentId) return;
    try {
      const res = await fetch(`/api/gpu-fleet/deployments/${deploymentId}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [deploymentId]);

  useEffect(() => {
    void load();
    // Auto-refresh while not in playground tab (where the user is typing).
    const id = setInterval(() => {
      if (tab !== 'playground') void load();
    }, 5_000);
    return () => clearInterval(id);
  }, [load, tab]);

  if (error && !data) {
    return (
      <PageContainer>
        <Alert color="red" icon={<IconAlertTriangle size={14} />}>{error}</Alert>
      </PageContainer>
    );
  }
  if (!data) {
    return (
      <PageContainer>
        <Text c="dimmed">Loading deployment…</Text>
      </PageContainer>
    );
  }

  const { deployment, host, pool, inferenceServer } = data;
  const canPlayground = deployment.actualState === 'healthy' && pool?.modelKey;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          host ? (
            <Anchor component={Link} href={`/dashboard/gpu-fleet/hosts/${host.id}`} size="xs">
              {host.name}
            </Anchor>
          ) : 'Deployment'
        }
        title={
          <Group gap="xs">
            <span>{deployment.name}</span>
            <Badge color={statusColor(deployment.actualState)} variant="dot" size="lg">
              {deployment.actualState}
            </Badge>
          </Group>
        }
        subtitle={
          <Group gap="md">
            <span><Code>{deployment.runtime}</Code></span>
            <span><Code>{deployment.modelName}</Code></span>
            {deployment.lastHealthyAt ? (
              <span>last healthy {formatRelative(deployment.lastHealthyAt)}</span>
            ) : null}
          </Group>
        }
        actions={
          <Button
            variant="default"
            color="orange"
            leftSection={<IconRotateClockwise size={14} />}
            disabled={deployment.actualState === 'removing' || deployment.actualState === 'draining'}
            onClick={async () => {
              if (!confirm(`Restart "${deployment.name}"? Container will be torn down and rebuilt with the same config.`)) return;
              try {
                await GpuFleetApi.restartDeployment(deployment.id);
                notifications.show({ color: 'orange', title: 'Restart queued', message: deployment.name });
                void load();
              } catch (error) {
                notifications.show({
                  color: 'red',
                  title: 'Restart failed',
                  message: error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }}
          >
            Restart
          </Button>
        }
      />

      <Tabs value={tab} onChange={(v) => setTab((v as typeof tab) ?? 'overview')} mb="md">
        <Tabs.List>
          <Tabs.Tab value="overview" leftSection={<IconBox size={14} />}>Overview</Tabs.Tab>
          <Tabs.Tab
            value="playground"
            leftSection={<IconPlayerPlay size={14} />}
            disabled={!canPlayground}
          >
            Playground{!canPlayground ? ' (deploy must be healthy)' : ''}
          </Tabs.Tab>
          <Tabs.Tab value="timeline" leftSection={<IconTimeline size={14} />}>Timeline</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {tab === 'overview' ? (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <Card withBorder>
            <Title order={6} mb="sm">Endpoint</Title>
            <Stack gap="xs">
              <KV label="Container image" value={deployment.image} mono />
              <KV label="Host service address" value={inferenceServer?.baseUrl ?? '—'} mono />
              <KV
                label="Inference server status"
                value={inferenceServer?.status ?? 'not registered'}
              />
              {inferenceServer?.status === 'errored' ? (
                <Alert color="yellow" icon={<IconAlertTriangle size={14} />} mt="xs">
                  Console can't reach <Code>{inferenceServer.baseUrl}</Code>. In production both
                  must be on the same VNet; in dev use a tunnel (Tailscale / ngrok) or move the
                  console alongside the host.
                </Alert>
              ) : null}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={6} mb="sm">Model Hub registration</Title>
            {pool && pool.modelKey ? (
              <Stack gap="xs">
                <KV label="Pool" value={pool.key} />
                <KV label="Provider key" value={pool.providerKey ?? '—'} mono />
                <KV label="Model key" value={pool.modelKey} mono />
                <Anchor component={Link} href={`/dashboard/models/${pool.modelKey}`} size="sm">
                  Open in Model Hub →
                </Anchor>
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                Model registration happens automatically on the first healthy event.
                If you don&apos;t see it here yet, wait a moment and refresh.
              </Text>
            )}
          </Card>

          <Card withBorder>
            <Title order={6} mb="sm">Configuration</Title>
            <Stack gap="xs">
              <KV label="Desired state" value={deployment.desiredState} />
              <KV label="Container ID" value={deployment.containerId?.slice(0, 12) ?? '—'} mono />
              <KV label="Container port" value={String(deployment.port)} />
            </Stack>
            <Title order={6} mt="md" mb="xs">Args</Title>
            <Code block style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
              {/* deployment.args lives on the API row but isn't on DeploymentView; show it raw if present */}
              {((deployment as unknown as { args?: string[] }).args ?? []).join(' ') || '(none)'}
            </Code>
          </Card>

          <Card withBorder>
            <Title order={6} mb="sm">Last error</Title>
            {deployment.lastError ? (
              <Code block color="red" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
                {deployment.lastError}
              </Code>
            ) : (
              <Text size="sm" c="dimmed">No errors.</Text>
            )}
          </Card>
        </SimpleGrid>
      ) : null}

      {tab === 'playground' && canPlayground && pool?.modelKey ? (
        <Card withBorder>
          <Group gap="xs" mb="sm">
            <IconPlayerPlay size={14} />
            <Title order={6}>Try the model</Title>
            <Badge variant="dot" size="xs" color="teal">live</Badge>
          </Group>
          <Text size="xs" c="dimmed" mb="md">
            Routed through pool <Code>{pool.key}</Code> via the GPU pool proxy.
            Same UI you&apos;d use from the Model Hub.
          </Text>
          <ModelPlayground
            modelKey={pool.modelKey}
            defaultUser="Hello! Tell me what you can do."
          />
        </Card>
      ) : null}

      {tab === 'timeline' ? (
        <Card withBorder>
          <Text size="sm" c="dimmed">
            For the full pulling/starting/healthy log + container logs,{' '}
            <Anchor component={Link} href={`/dashboard/gpu-fleet/hosts/${host?.id}`}>
              open the host page
            </Anchor>{' '}
            and click <strong>Timeline</strong> on this deployment row.
          </Text>
          {/* TODO Phase 2: inline the Timeline drawer's content here. */}
        </Card>
      ) : null}
    </PageContainer>
  );
}

function KV({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <Group gap="xs" justify="space-between">
      <Text size="xs" c="dimmed">{label}</Text>
      {mono ? (
        <Code style={{ fontSize: 11 }}>{value ?? '—'}</Code>
      ) : (
        <Text size="sm">{value ?? '—'}</Text>
      )}
    </Group>
  );
}
