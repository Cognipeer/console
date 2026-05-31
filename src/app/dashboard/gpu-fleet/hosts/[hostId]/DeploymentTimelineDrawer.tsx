'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Code,
  Drawer,
  Group,
  Loader,
  Progress,
  ScrollArea,
  Stack,
  Stepper,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDownload,
  IconHeartbeat,
  IconHourglass,
  IconNotes,
  IconRefresh,
  IconRocket,
  IconX,
} from '@tabler/icons-react';
import { formatRelative, statusColor } from '../../_lib/format';
import type { DeploymentView } from '../../_lib/types';

/**
 * Phase-2 deployment progress drawer. Polls the timeline endpoint every 3s
 * while open. Renders three layers of info:
 *
 *   1. A high-level Stepper that maps lifecycle states onto: Pending →
 *      Pulling → Starting → Healthy (or → Failed at any step).
 *   2. A scrollable log of every command + event that touched this
 *      deployment, in chronological order. Useful when something stalls
 *      and you want the exact moment it went wrong.
 *   3. The current `lastError` from the deployment row.
 */

interface TimelineItem {
  kind: 'command' | 'event';
  id: string;
  type: string;
  status?: string;
  at: string | Date;
  deliveredAt?: string | Date | null;
  completedAt?: string | Date | null;
  lastError?: string | null;
  attempts?: number;
  payload?: Record<string, unknown>;
}

interface TimelineResponse {
  deployment: DeploymentView;
  items: TimelineItem[];
}

interface Props {
  opened: boolean;
  onClose: () => void;
  deploymentId: string | null;
}

const STEP_BY_STATE: Record<DeploymentView['actualState'], number> = {
  pending: 0,
  pulling: 1,
  starting: 2,
  healthy: 3,
  unhealthy: 3,
  stopped: 3,
  failed: 3,
  draining: 3,
  removing: 3,
};

export default function DeploymentTimelineDrawer({ opened, onClose, deploymentId }: Props) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deploymentId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/gpu-fleet/deployments/${deploymentId}/timeline`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as TimelineResponse;
      setData(json);
      setError(null);
    } catch (e) {
      // Surface the error instead of leaving the drawer stuck on "Loading…".
      // Polls every 3s, so it auto-recovers when the endpoint comes back.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  useEffect(() => {
    if (!opened || !deploymentId) return;
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [opened, deploymentId, load]);

  const deployment = data?.deployment ?? null;
  const items = data?.items ?? [];
  const step = deployment ? STEP_BY_STATE[deployment.actualState] ?? 0 : 0;
  const isError = deployment?.actualState === 'failed' || deployment?.actualState === 'unhealthy';

  // Latest pull-progress event (last in chronological list) is what we
  // show in the progress card. For images that haven't reported a total
  // size yet, percent is null and we render a generic "Downloading…".
  const latestPullProgress = (() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.kind === 'event' && item.type === 'image-pull-progress') return item;
    }
    return null;
  })();

  // Elapsed time since the deployment was first queued — useful when a
  // pull is taking forever and the user wonders "is this normal?".
  const firstQueuedAt = items.find((it) => it.kind === 'command' && it.type === 'apply-deployment')?.at;
  const elapsedSeconds = firstQueuedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(firstQueuedAt).getTime()) / 1000))
    : null;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={deployment ? `Deployment · ${deployment.name}` : 'Deployment timeline'}
    >
      {!deployment ? (
        <Stack gap="xs">
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">Loading deployment timeline…</Text>
          </Group>
          {error ? (
            <Code block color="red" style={{ whiteSpace: 'pre-wrap' }}>
              {error}
            </Code>
          ) : null}
        </Stack>
      ) : (
        <Stack gap="md">
          {/* High-level progress */}
          <Stepper active={step} size="sm" color={isError ? 'red' : 'blue'}>
            <Stepper.Step label="Queued" description="command enqueued" icon={<IconHourglass size={14} />} />
            <Stepper.Step label="Pulling" description="docker image" icon={<IconDownload size={14} />} />
            <Stepper.Step label="Starting" description="container booting" icon={<IconRocket size={14} />} />
            <Stepper.Step
              label={isError ? deployment.actualState : 'Healthy'}
              description={isError ? 'see log below' : 'health probe OK'}
              icon={isError ? <IconAlertTriangle size={14} /> : <IconHeartbeat size={14} />}
              color={isError ? 'red' : undefined}
            />
          </Stepper>

          {/* Current state summary */}
          <Group gap="md">
            <Badge color={statusColor(deployment.actualState)} variant="dot" size="lg">
              {deployment.actualState}
            </Badge>
            <Text size="xs" c="dimmed">
              <Code>{deployment.image}</Code>
            </Text>
            {deployment.lastHealthyAt ? (
              <Text size="xs" c="dimmed">last healthy {formatRelative(deployment.lastHealthyAt)}</Text>
            ) : null}
            {elapsedSeconds !== null && !['healthy', 'failed', 'stopped'].includes(deployment.actualState) ? (
              <Text size="xs" c="dimmed">elapsed {formatDuration(elapsedSeconds)}</Text>
            ) : null}
          </Group>

          {/* Pull progress while in 'pulling' state. */}
          {deployment.actualState === 'pulling' && latestPullProgress ? (
            <PullProgressCard event={latestPullProgress} />
          ) : null}

          {deployment.lastError ? (
            <Card withBorder padding="sm" style={{ borderColor: 'var(--mantine-color-red-4)' }}>
              <Group gap="xs" mb={4}>
                <IconAlertTriangle size={14} color="var(--mantine-color-red-7)" />
                <Text size="sm" fw={600} c="red">Last error</Text>
              </Group>
              <Code block style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: 'var(--mantine-color-red-0)' }}>
                {deployment.lastError}
              </Code>
            </Card>
          ) : null}

          {/* Container log inspector — visible whenever there's something
              worth looking at on the host. Auto-fetched on first failure
              transition (server-side), but the user can also request a
              fresh tail with the button. */}
          <ContainerLogInspector
            deploymentId={deployment.id}
            items={items}
            showFetchButton={['starting', 'failed', 'unhealthy', 'healthy'].includes(deployment.actualState)}
          />

          {/* Detailed activity log */}
          <Title order={6}>Activity</Title>
          {items.length === 0 ? (
            <Text size="sm" c="dimmed">No activity recorded yet. {loading ? 'Refreshing…' : ''}</Text>
          ) : (
            <ScrollArea h={420}>
              <Stack gap="xs">
                {items.map((item) => <TimelineRow key={item.id} item={item} />)}
              </Stack>
            </ScrollArea>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const meta = describeItem(item);
  return (
    <Group gap="sm" align="flex-start" wrap="nowrap">
      <Tooltip label={meta.title}>
        <ThemeIcon size="md" color={meta.color} variant="light">
          {meta.icon}
        </ThemeIcon>
      </Tooltip>
      <Stack gap={2} style={{ flex: 1 }}>
        <Group gap="xs">
          <Text size="sm" fw={500}>{meta.title}</Text>
          {item.kind === 'command' && item.status ? (
            <Badge color={commandStatusColor(item.status)} variant="dot" size="xs">{item.status}</Badge>
          ) : null}
        </Group>
        <Text size="xs" c="dimmed">{formatRelative(item.at)}</Text>
        {meta.detail ? <Text size="xs" c="dimmed">{meta.detail}</Text> : null}
        {item.lastError ? <Text size="xs" c="red">{item.lastError}</Text> : null}
      </Stack>
    </Group>
  );
}

interface ItemMeta {
  title: string;
  detail: string | null;
  icon: React.ReactNode;
  color: string;
}

function describeItem(item: TimelineItem): ItemMeta {
  if (item.kind === 'command') {
    return {
      title: commandTitle(item.type),
      detail: item.attempts && item.attempts > 1 ? `attempts: ${item.attempts}` : null,
      icon: <IconHourglass size={14} />,
      color: commandStatusColor(item.status ?? 'pending'),
    };
  }
  // event
  return eventMeta(item);
}

function commandTitle(kind: string): string {
  switch (kind) {
    case 'apply-deployment': return 'Apply deployment command';
    case 'stop-deployment': return 'Stop deployment command';
    case 'remove-deployment': return 'Remove deployment command';
    case 'collect-logs': return 'Collect logs command';
    case 'apply-mig-profile': return 'Apply MIG profile command';
    case 'open-terminal-session': return 'Open terminal session command';
    default: return `${kind} command`;
  }
}

function commandStatusColor(status: string): string {
  switch (status) {
    case 'pending': return 'gray';
    case 'delivered': return 'blue';
    case 'completed': return 'teal';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

function eventMeta(item: TimelineItem): ItemMeta {
  const payload = item.payload ?? {};
  switch (item.type) {
    case 'command-accepted':
      return {
        title: 'Agent acknowledged command',
        detail: null,
        icon: <IconCircleCheck size={14} />,
        color: 'blue',
      };
    case 'command-completed':
      return {
        title: 'Agent completed command',
        detail: typeof payload.detail === 'string' ? payload.detail : null,
        icon: <IconCircleCheck size={14} />,
        color: 'teal',
      };
    case 'command-failed':
      return {
        title: 'Agent failed to apply command',
        detail: typeof payload.error === 'string' ? payload.error : null,
        icon: <IconX size={14} />,
        color: 'red',
      };
    case 'deployment-state-changed':
      return {
        title: `State → ${String(payload.state ?? 'unknown')}`,
        detail: typeof payload.message === 'string'
          ? payload.message
          : typeof payload.containerId === 'string' ? `container ${payload.containerId.slice(0, 12)}` : null,
        icon: stateIcon(String(payload.state ?? '')),
        color: stateColor(String(payload.state ?? '')),
      };
    case 'agent-error':
      return {
        title: `Agent error · ${String(payload.source ?? '')}`,
        detail: typeof payload.error === 'string' ? payload.error : null,
        icon: <IconAlertTriangle size={14} />,
        color: 'red',
      };
    case 'log-snapshot':
      return {
        title: 'Logs snapshot',
        detail: typeof payload.logs === 'string' ? payload.logs.slice(0, 200) : null,
        icon: <IconDownload size={14} />,
        color: 'gray',
      };
    case 'image-pull-progress': {
      const pct = typeof payload.percent === 'number' ? payload.percent : null;
      const dl = typeof payload.bytesDownloaded === 'number' ? payload.bytesDownloaded : 0;
      const total = typeof payload.bytesTotal === 'number' ? payload.bytesTotal : null;
      return {
        title: `Pull progress · ${pct !== null ? `${pct.toFixed(0)}%` : 'sizing…'}`,
        detail: `${formatBytes(dl)}${total !== null ? ` / ${formatBytes(total)}` : ''} · ${String(payload.status ?? '')}`,
        icon: <IconDownload size={14} />,
        color: 'blue',
      };
    }
    default:
      return { title: item.type, detail: null, icon: <IconHourglass size={14} />, color: 'gray' };
  }
}

function stateIcon(state: string): React.ReactNode {
  switch (state) {
    case 'pulling':   return <IconDownload size={14} />;
    case 'starting':  return <IconRocket size={14} />;
    case 'healthy':   return <IconHeartbeat size={14} />;
    case 'unhealthy': return <IconAlertTriangle size={14} />;
    case 'stopped':   return <IconX size={14} />;
    case 'failed':    return <IconAlertTriangle size={14} />;
    default:          return <IconHourglass size={14} />;
  }
}

function stateColor(state: string): string {
  switch (state) {
    case 'healthy':   return 'teal';
    case 'starting':  return 'blue';
    case 'pulling':   return 'blue';
    case 'unhealthy': return 'orange';
    case 'failed':    return 'red';
    case 'stopped':   return 'gray';
    default:          return 'gray';
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function PullProgressCard({ event }: { event: TimelineItem }) {
  const payload = (event.payload ?? {}) as {
    percent?: number | null;
    bytesDownloaded?: number;
    bytesTotal?: number | null;
    status?: string;
    image?: string;
  };
  const percent = typeof payload.percent === 'number' ? payload.percent : null;
  const downloaded = payload.bytesDownloaded ?? 0;
  const total = payload.bytesTotal ?? null;
  return (
    <Stack gap={4} p="sm" style={{ background: 'var(--mantine-color-blue-light)', borderRadius: 8 }}>
      <Group justify="space-between">
        <Text size="sm" fw={500}>
          Pulling image…
        </Text>
        <Text size="xs" c="dimmed">
          {percent !== null ? `${percent.toFixed(1)}%` : 'sizing…'}
        </Text>
      </Group>
      <Progress
        value={percent ?? 0}
        animated={percent === null || percent < 100}
        striped={percent === null}
        color="blue"
        size="sm"
      />
      <Text size="xs" c="dimmed">
        {payload.status ?? 'downloading'}
        {' · '}
        {formatBytes(downloaded)}
        {total !== null ? ` / ${formatBytes(total)}` : ''}
      </Text>
    </Stack>
  );
}

interface ContainerLogInspectorProps {
  deploymentId: string;
  items: TimelineItem[];
  showFetchButton: boolean;
}

/**
 * Surfaces container stdout/stderr in the timeline. The agent emits these
 * via `log-snapshot` events when a `collect-logs` command runs (manually
 * via the button OR automatically when the deployment first hits failed).
 */
function ContainerLogInspector({ deploymentId, items, showFetchButton }: ContainerLogInspectorProps) {
  const [fetching, setFetching] = useState(false);

  // Find the latest log-snapshot event for this deployment.
  const latestLogs = (() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === 'event' && it.type === 'log-snapshot') return it;
    }
    return null;
  })();

  const fetchLogs = async () => {
    setFetching(true);
    try {
      const res = await fetch(`/api/gpu-fleet/deployments/${deploymentId}/fetch-logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tailLines: 300 }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      // Logs will land in the items list within a few seconds — the
      // outer drawer's 3-second poll picks them up. No need to merge
      // anything here.
    } catch {
      // Silent — user can re-click.
    } finally {
      setFetching(false);
    }
  };

  if (!latestLogs && !showFetchButton) return null;

  const logText = latestLogs
    ? ((latestLogs.payload as { logs?: string } | undefined)?.logs ?? '')
    : '';

  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconNotes size={14} />
          <Text size="sm" fw={500}>Container logs</Text>
          {latestLogs ? (
            <Text size="xs" c="dimmed">last fetch {formatRelative(latestLogs.at)}</Text>
          ) : null}
        </Group>
        {showFetchButton ? (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={12} />}
            onClick={fetchLogs}
            loading={fetching}
          >
            Fetch latest
          </Button>
        ) : null}
      </Group>
      {logText ? (
        <ScrollArea h={240} type="auto">
          <Code block style={{ whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.4 }}>
            {logText}
          </Code>
        </ScrollArea>
      ) : (
        <Text size="xs" c="dimmed">
          No logs fetched yet. Click "Fetch latest" — the agent will tail
          the container's stdout/stderr and post it back within a few seconds.
        </Text>
      )}
    </Card>
  );
}
