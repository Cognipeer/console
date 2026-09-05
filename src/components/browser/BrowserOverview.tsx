'use client';

/**
 * What a browser profile is doing — not what fields it has.
 *
 * The old overview was two cards of label/value rows: id, key, status,
 * model, bucket, created, updated. Every one of those is true and none of
 * them is a reason to open the page. An operator arrives asking whether this
 * browser is working, what ran on it, and what is holding a Chromium open
 * right now — so that is what leads, and the identity fields sit in one
 * compact strip at the bottom where they are still copyable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowsSplit,
  IconClockPause,
  IconExternalLink,
  IconPlayerPlay,
  IconPlug,
  IconWorld,
} from '@tabler/icons-react';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import BrowserProfilePanel from '@/components/browser/BrowserProfilePanel';
import type { BrowserFlowView, BrowserSessionView, BrowserView } from '@/lib/services/browser';

interface Props {
  browser: BrowserView;
  sessions: BrowserSessionView[];
  onUpdated: (browser: BrowserView) => void;
  onOpenMcp: () => void;
  onNewSession: () => void;
}

const LIVE_STATUSES = new Set(['running', 'idle', 'pending']);
const DAY_MS = 86_400_000;

function statusVariant(status: string): 'active' | 'paused' | 'error' {
  if (status === 'running' || status === 'idle') return 'active';
  if (status === 'errored') return 'error';
  return 'paused';
}

function since(value: unknown): string {
  if (!value) return '—';
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return '—';
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / DAY_MS)}d ago`;
}

function duration(session: BrowserSessionView): string {
  const start = session.startedAt ? new Date(session.startedAt).getTime() : undefined;
  if (!start) return '—';
  const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export default function BrowserOverview({
  browser,
  sessions,
  onUpdated,
  onOpenMcp,
  onNewSession,
}: Props) {
  const router = useRouter();
  const [flows, setFlows] = useState<BrowserFlowView[]>([]);

  const loadFlows = useCallback(async () => {
    const res = await fetch(`/api/browser/flows?browserId=${encodeURIComponent(browser.id)}`, {
      cache: 'no-store',
    });
    if (res.ok) setFlows((await res.json()).flows ?? []);
  }, [browser.id]);

  useEffect(() => {
    void loadFlows();
  }, [loadFlows]);

  const stats = useMemo(() => {
    const cutoff = Date.now() - 7 * DAY_MS;
    const recent = sessions.filter((s) => new Date(s.createdAt ?? 0).getTime() >= cutoff);
    const live = sessions.filter((s) => LIVE_STATUSES.has(s.status));
    const failed = recent.filter((s) => s.status === 'errored');
    const actions = recent.reduce((total, s) => total + (s.eventCount ?? 0), 0);

    // Sessions per day over the last week, oldest first — enough shape to see
    // "this runs nightly" or "this stopped three days ago" at a glance.
    const spark = Array.from({ length: 7 }, (_, index) => {
      const from = Date.now() - (7 - index) * DAY_MS;
      const to = from + DAY_MS;
      return sessions.filter((s) => {
        const at = new Date(s.createdAt ?? 0).getTime();
        return at >= from && at < to;
      }).length;
    });

    return { live: live.length, recent: recent.length, failed: failed.length, actions, spark };
  }, [sessions]);

  const recentSessions = useMemo(
    () => [...sessions]
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, 8),
    [sessions],
  );

  const activeFlows = useMemo(() => flows.filter((flow) => flow.status !== 'disabled'), [flows]);

  return (
    <Stack gap="md">
      {/* ── What is happening ────────────────────────────── */}
      <div className="ds-stat-grid">
        <StatTile
          label="Live sessions"
          icon={<IconWorld size={14} stroke={1.7} />}
          value={stats.live}
          delta={stats.live > 0 ? 'holding a browser open' : undefined}
        />
        <StatTile
          label="Sessions · 7d"
          value={stats.recent}
          spark={stats.spark}
        />
        <StatTile
          label="Failed · 7d"
          value={stats.failed}
          deltaDir={stats.failed > 0 ? 'up' : null}
          delta={stats.failed > 0 ? 'needs a look' : 'clean'}
        />
        <StatTile label="Actions · 7d" value={stats.actions} />
      </div>

      <Group grow align="stretch" wrap="wrap">
        {/* ── Recent activity ────────────────────────────── */}
        <Paper withBorder p="md" radius="lg" style={{ minWidth: 320 }}>
          <Group justify="space-between" mb="sm">
            <Group gap="xs">
              <ThemeIcon variant="light" color="teal" radius="md"><IconClockPause size={16} /></ThemeIcon>
              <Text fw={600} size="sm">Recent sessions</Text>
            </Group>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => router.push(`/dashboard/browser/${browser.id}/sessions`)}
            >
              View all
            </Button>
          </Group>

          {recentSessions.length === 0 ? (
            <Stack gap="xs" align="flex-start">
              <Text size="xs" c="dimmed" fs="italic">
                Nothing has run on this browser yet.
              </Text>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlayerPlay size={13} />}
                onClick={() => router.push(`/dashboard/browser/playground?browserId=${browser.id}`)}
              >
                Drive it in the playground
              </Button>
            </Stack>
          ) : (
            <Stack gap={0}>
              {recentSessions.map((s) => (
                <Group
                  key={s.id}
                  gap="xs"
                  wrap="nowrap"
                  py={7}
                  style={{ borderBottom: '1px solid var(--ds-border)', cursor: 'pointer' }}
                  onClick={() => router.push(`/dashboard/browser/${browser.id}/sessions?session=${s.sessionKey}`)}
                >
                  <StatusBadge status={statusVariant(s.status)} label={s.status} />
                  <Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate>
                    {s.currentUrl || s.name || s.sessionKey}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace">{s.eventCount ?? 0}</Text>
                  <Text size="xs" c="dimmed" ff="monospace" w={38} ta="right">{duration(s)}</Text>
                  <Text size="xs" c="dimmed" w={62} ta="right">{since(s.createdAt)}</Text>
                </Group>
              ))}
            </Stack>
          )}
        </Paper>

        {/* ── Flows on this browser ──────────────────────── */}
        <Paper withBorder p="md" radius="lg" style={{ minWidth: 320 }}>
          <Group justify="space-between" mb="sm">
            <Group gap="xs">
              <ThemeIcon variant="light" color="grape" radius="md"><IconArrowsSplit size={16} /></ThemeIcon>
              <Text fw={600} size="sm">Flows</Text>
            </Group>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => router.push('/dashboard/browser/flows')}
            >
              All flows
            </Button>
          </Group>

          {activeFlows.length === 0 ? (
            <Stack gap="xs" align="flex-start">
              <Text size="xs" c="dimmed" fs="italic">
                No flows recorded on this browser. Drive a task once in the playground, then
                record it — the replay needs no model.
              </Text>
              <Button
                size="xs"
                variant="light"
                color="grape"
                leftSection={<IconPlayerPlay size={13} />}
                onClick={() => router.push(`/dashboard/browser/playground?browserId=${browser.id}`)}
              >
                Open playground
              </Button>
            </Stack>
          ) : (
            <Stack gap={0}>
              {activeFlows.slice(0, 8).map((flow) => (
                <Group
                  key={flow.id}
                  gap="xs"
                  wrap="nowrap"
                  py={7}
                  style={{ borderBottom: '1px solid var(--ds-border)', cursor: 'pointer' }}
                  onClick={() => router.push(`/dashboard/browser/flows/${flow.id}`)}
                >
                  <Badge
                    size="xs"
                    variant="light"
                    color={flow.status === 'active' ? 'teal' : 'gray'}
                  >
                    {flow.status}
                  </Badge>
                  <Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate>{flow.name}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{flow.steps.length} steps</Text>
                  {flow.lastRun ? (
                    <Badge
                      size="xs"
                      variant="light"
                      color={flow.lastRun.status === 'succeeded' ? 'teal' : 'red'}
                    >
                      {since(flow.lastRun.startedAt)}
                    </Badge>
                  ) : (
                    <Text size="xs" c="dimmed">never run</Text>
                  )}
                </Group>
              ))}
            </Stack>
          )}
        </Paper>
      </Group>

      {/* ── Identity + quick actions, compact ─────────────── */}
      <Paper withBorder p="md" radius="lg">
        <Group justify="space-between" wrap="wrap" gap="md">
          <Group gap="lg" wrap="wrap">
            <IdentityField label="Key" value={<Code>{browser.key}</Code>} />
            <IdentityField label="ID" value={<Code>{browser.id}</Code>} />
            <IdentityField
              label="Status"
              value={<StatusBadge status={browser.status === 'active' ? 'active' : 'paused'} label={browser.status} />}
            />
            <IdentityField
              label="Artifacts"
              value={browser.artifactBucketKey
                ? <Code>{browser.artifactBucketKey}</Code>
                : <Text size="xs" c="dimmed">default bucket</Text>}
            />
            {browser.defaultModelKey ? (
              <IdentityField label="Model" value={<Code>{browser.defaultModelKey}</Code>} />
            ) : null}
          </Group>

          <Group gap="xs">
            <Tooltip label="Drive this browser by hand">
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlayerPlay size={13} />}
                onClick={() => router.push(`/dashboard/browser/playground?browserId=${browser.id}`)}
              >
                Playground
              </Button>
            </Tooltip>
            <Button size="xs" variant="light" leftSection={<IconExternalLink size={13} />} onClick={onNewSession}>
              New session
            </Button>
            <Button size="xs" variant="light" color="grape" leftSection={<IconPlug size={13} />} onClick={onOpenMcp}>
              MCP URL
            </Button>
          </Group>
        </Group>
      </Paper>

      {/* Profile + session defaults keep their own panel — they are settings,
          not status, and they are long enough to deserve the room. */}
      <BrowserProfilePanel browser={browser} onUpdated={onUpdated} />
    </Stack>
  );
}

function IdentityField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text size="10px" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.06em' }}>
        {label}
      </Text>
      <div style={{ marginTop: 2 }}>{value}</div>
    </div>
  );
}
