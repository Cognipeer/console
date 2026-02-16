'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  Stack,
  Group,
  Text,
  Badge,
  Paper,
  Grid,
  Title,
  Divider,
  Button,
  Tooltip,
  ThemeIcon,
  Timeline,
  Box,
  Anchor,
  CopyButton,
  ActionIcon,
  Loader,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconClock,
  IconActivity,
  IconBrain,
  IconTool,
  IconCopy,
  IconCheck,
  IconTimeline,
  IconExternalLink,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import duration from 'dayjs/plugin/duration';
import PageHeader from '@/components/layout/PageHeader';
import { formatDuration, formatNumber, resolveStatusColor } from '@/lib/utils/tracingUtils';

dayjs.extend(relativeTime);
dayjs.extend(duration);

interface ThreadSession {
  sessionId: string;
  agentName?: string;
  agentVersion?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalEvents?: number;
  totalTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  modelsUsed?: string[];
  toolsUsed?: string[];
}

interface ThreadDetail {
  threadId: string;
  status: string;
  agents: string[];
  sessionsCount: number;
  startedAt?: string;
  endedAt?: string;
  totalDurationMs: number;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  modelsUsed: string[];
  toolsUsed: string[];
  sessions: ThreadSession[];
}

export default function ThreadDetailPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);
  const router = useRouter();
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchThread = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/tracing/threads/${encodeURIComponent(threadId)}`);

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch thread');
      }

      const data = await response.json();
      setThread(data);
    } catch (err) {
      console.error('Failed to load thread:', err);
      setError(err instanceof Error ? err.message : 'Failed to load thread');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    fetchThread();
  }, [fetchThread]);

  // Auto-refresh if any session is in_progress
  useEffect(() => {
    if (!thread) return;
    const hasInProgress = thread.sessions.some((s) => s.status === 'in_progress');
    if (!hasInProgress) return;

    const interval = setInterval(() => fetchThread(), 5000);
    return () => clearInterval(interval);
  }, [thread, fetchThread]);

  if (loading) {
    return (
      <Stack align="center" p="xl">
        <Loader size="lg" />
        <Text c="dimmed">Loading thread...</Text>
      </Stack>
    );
  }

  if (error || !thread) {
    return (
      <Stack align="center" p="xl">
        <Text c="red">{error || 'Thread not found'}</Text>
        <Button variant="light" onClick={() => router.push('/dashboard/tracing/threads')}>
          Back to Threads
        </Button>
      </Stack>
    );
  }

  const totalTokens = thread.totalInputTokens + thread.totalOutputTokens;

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconTimeline size={18} />}
        title="Thread Detail"
        subtitle={`Thread ${threadId.substring(0, 16)}${threadId.length > 16 ? '...' : ''}`}
        actions={
          <Button
            leftSection={<IconArrowLeft size={14} />}
            variant="light"
            size="xs"
            onClick={() => router.push('/dashboard/tracing/threads')}
          >
            Back to Threads
          </Button>
        }
      />

      {/* Thread Summary Cards */}
      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card withBorder shadow="sm" p="md">
            <Stack gap="xs">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Thread ID</Text>
              <Group gap="xs">
                <Text size="sm" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {thread.threadId}
                </Text>
                <CopyButton value={thread.threadId}>
                  {({ copied, copy }) => (
                    <ActionIcon size="xs" variant="subtle" onClick={copy}>
                      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    </ActionIcon>
                  )}
                </CopyButton>
              </Group>
              <Divider my={4} />
              <Group gap="xs">
                <Text size="xs" c="dimmed">Status:</Text>
                <Badge size="xs" variant="light" radius="xl" color={resolveStatusColor(thread.status)}>
                  {thread.status.toUpperCase()}
                </Badge>
              </Group>
              <Group gap="xs">
                <Text size="xs" c="dimmed">Started:</Text>
                <Text size="xs">{thread.startedAt ? dayjs(thread.startedAt).format('MMM D, YYYY HH:mm:ss') : '—'}</Text>
              </Group>
              <Group gap="xs">
                <Text size="xs" c="dimmed">Duration:</Text>
                <Text size="xs">{formatDuration(thread.totalDurationMs)}</Text>
              </Group>
            </Stack>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card withBorder shadow="sm" p="md">
            <Stack gap="xs">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Agents</Text>
              <Group gap={4}>
                {thread.agents.map((agent) => (
                  <Badge key={agent} size="sm" variant="outline" color="blue">
                    {agent}
                  </Badge>
                ))}
              </Group>
              <Divider my={4} />
              <Group gap="lg">
                <div>
                  <Text size="xs" c="dimmed">Sessions</Text>
                  <Text size="lg" fw={700}>{thread.sessionsCount}</Text>
                </div>
                <div>
                  <Text size="xs" c="dimmed">Events</Text>
                  <Text size="lg" fw={700}>{formatNumber(thread.totalEvents)}</Text>
                </div>
              </Group>
            </Stack>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card withBorder shadow="sm" p="md">
            <Stack gap="xs">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Tokens</Text>
              <Group gap="lg">
                <div>
                  <Text size="xs" c="dimmed">Total</Text>
                  <Text size="lg" fw={700}>{formatNumber(totalTokens)}</Text>
                </div>
                <div>
                  <Text size="xs" c="dimmed">Input</Text>
                  <Text size="sm">{formatNumber(thread.totalInputTokens)}</Text>
                </div>
                <div>
                  <Text size="xs" c="dimmed">Output</Text>
                  <Text size="sm">{formatNumber(thread.totalOutputTokens)}</Text>
                </div>
              </Group>
              <Divider my={4} />
              {thread.modelsUsed.length > 0 && (
                <Group gap={4}>
                  <Text size="xs" c="dimmed">Models:</Text>
                  {thread.modelsUsed.slice(0, 3).map((m) => (
                    <Badge key={m} size="xs" variant="light" color="grape">{m}</Badge>
                  ))}
                  {thread.modelsUsed.length > 3 && (
                    <Text size="xs" c="dimmed">+{thread.modelsUsed.length - 3}</Text>
                  )}
                </Group>
              )}
              {thread.toolsUsed.length > 0 && (
                <Group gap={4}>
                  <Text size="xs" c="dimmed">Tools:</Text>
                  {thread.toolsUsed.slice(0, 3).map((t) => (
                    <Badge key={t} size="xs" variant="light" color="teal">{t}</Badge>
                  ))}
                  {thread.toolsUsed.length > 3 && (
                    <Text size="xs" c="dimmed">+{thread.toolsUsed.length - 3}</Text>
                  )}
                </Group>
              )}
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>

      {/* Session Timeline */}
      <Paper withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group justify="space-between">
            <Title order={5}>Session Timeline</Title>
            <Badge size="sm" variant="light">{thread.sessionsCount} sessions</Badge>
          </Group>

          <Timeline active={thread.sessions.length - 1} bulletSize={28} lineWidth={2}>
            {thread.sessions.map((session, index) => (
              <Timeline.Item
                key={session.sessionId}
                bullet={
                  <ThemeIcon
                    size={28}
                    radius="xl"
                    variant="light"
                    color={resolveStatusColor(session.status)}
                  >
                    {session.status === 'in_progress' ? (
                      <IconActivity size={14} />
                    ) : session.status === 'error' ? (
                      <IconActivity size={14} />
                    ) : (
                      <IconBrain size={14} />
                    )}
                  </ThemeIcon>
                }
                title={
                  <Group gap="xs">
                    <Text fw={600} size="sm">
                      {session.agentName || 'Unknown Agent'}
                    </Text>
                    {session.agentVersion && (
                      <Badge size="xs" variant="outline" color="gray">
                        v{session.agentVersion}
                      </Badge>
                    )}
                    <Badge size="xs" variant="light" radius="xl" color={resolveStatusColor(session.status)}>
                      {(session.status || 'unknown').toUpperCase()}
                    </Badge>
                  </Group>
                }
              >
                <Card withBorder p="sm" mt="xs" radius="md">
                  <Stack gap="xs">
                    <Group gap="lg" wrap="wrap">
                      <Group gap={4}>
                        <IconClock size={12} color="gray" />
                        <Text size="xs" c="dimmed">
                          {session.startedAt
                            ? dayjs(session.startedAt).format('HH:mm:ss')
                            : '—'}
                        </Text>
                      </Group>
                      <Group gap={4}>
                        <Text size="xs" c="dimmed">Duration:</Text>
                        <Text size="xs">{formatDuration(session.durationMs)}</Text>
                      </Group>
                      <Group gap={4}>
                        <Text size="xs" c="dimmed">Events:</Text>
                        <Text size="xs">{formatNumber(session.totalEvents)}</Text>
                      </Group>
                      <Group gap={4}>
                        <Text size="xs" c="dimmed">Tokens:</Text>
                        <Text size="xs">{formatNumber(session.totalTokens)}</Text>
                      </Group>
                    </Group>

                    {session.modelsUsed && session.modelsUsed.length > 0 && (
                      <Group gap={4}>
                        <IconBrain size={12} color="gray" />
                        {session.modelsUsed.map((m) => (
                          <Badge key={m} size="xs" variant="light" color="grape">{m}</Badge>
                        ))}
                      </Group>
                    )}

                    {session.toolsUsed && session.toolsUsed.length > 0 && (
                      <Group gap={4}>
                        <IconTool size={12} color="gray" />
                        {session.toolsUsed.map((t) => (
                          <Badge key={t} size="xs" variant="light" color="teal">{t}</Badge>
                        ))}
                      </Group>
                    )}

                    <Group gap="xs">
                      <Tooltip label={session.sessionId}>
                        <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                          {session.sessionId.substring(0, 12)}...
                        </Text>
                      </Tooltip>
                      <Anchor
                        size="xs"
                        onClick={() => router.push(`/dashboard/tracing/sessions/${session.sessionId}`)}
                        style={{ cursor: 'pointer' }}
                      >
                        <Group gap={2}>
                          <Text size="xs">View Details</Text>
                          <IconExternalLink size={10} />
                        </Group>
                      </Anchor>
                    </Group>
                  </Stack>
                </Card>
              </Timeline.Item>
            ))}
          </Timeline>
        </Stack>
      </Paper>
    </Stack>
  );
}
