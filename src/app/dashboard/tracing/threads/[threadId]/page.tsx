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
  CopyButton,
  ActionIcon,
  Loader,
  ScrollArea,
  Alert,
  Code,
  SimpleGrid,
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
  IconInfoCircle,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import duration from 'dayjs/plugin/duration';
import PageHeader from '@/components/layout/PageHeader';
import {
  formatDuration,
  formatNumber,
  resolveStatusColor,
  formatRelativeTime,
  humanize,
  formatToolName,
} from '@/lib/utils/tracingUtils';

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

type SectionEntry = {
  [key: string]: unknown;
  title?: string;
  label?: string;
  kind?: string;
  id?: string;
  role?: string;
  tool?: string;
  contentType?: string;
  truncated?: boolean;
  content?: unknown;
};

interface SessionDetailResponse {
  session: {
    sessionId: string;
    status?: string;
  };
  events: Array<{
    id: string;
    sequence?: number;
    type?: string;
    label?: string;
    status?: string;
    timestamp?: string;
    actor?: unknown;
    metadata?: Record<string, unknown>;
    sections?: SectionEntry[];
    model?: string;
    error?: { message?: string } | null;
    durationMs?: number;
    toolName?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  }>;
}

type TracingEvent = SessionDetailResponse['events'][number];

const SECTION_HEADER_PROPS = [
  'label',
  'title',
  'kind',
  'id',
  'role',
  'tool',
  'contentType',
  'truncated',
  'metadata',
];

const isInProgressStatus = (status?: string) => {
  const value = (status || '').toLowerCase();
  return value === 'in_progress' || value === 'in-progress' || value === 'running';
};

const formatActor = (actor: unknown): string => {
  if (!actor) return '';
  if (typeof actor === 'string') {
    if (actor.includes('_')) {
      return actor
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    return actor;
  }
  if (typeof actor === 'object') {
    const record = actor as Record<string, unknown>;

    if (Object.keys(record).length === 0) return '';

    const parts = [record.scope, record.name, record.role, record.version]
      .map((value) => {
        if (typeof value === 'string' && value.trim() !== '') {
          if (value.includes('_')) {
            return value
              .toLowerCase()
              .split('_')
              .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ');
          }
          return value;
        }
        return null;
      })
      .filter((value): value is string => value !== null);

    if (parts.length > 0) {
      return parts.join(' · ');
    }

    return '';
  }

  return String(actor);
};

const formatSectionContent = (content: unknown): string => {
  if (content === null || content === undefined) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
};

const shouldDisplaySectionField = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }

  return true;
};

const renderSectionFieldValue = (value: unknown) => {
  if (typeof value === 'object' && value !== null) {
    return <Code block>{formatSectionContent(value)}</Code>;
  }

  const formatted = formatSectionContent(value);

  if (formatted.length > 160 || formatted.includes('\n')) {
    return <Code block>{formatted}</Code>;
  }

  return <Text size="sm">{formatted}</Text>;
};

const SectionCard = ({ section, index }: { section: SectionEntry; index: number }) => {
  const kind = typeof section.kind === 'string' ? section.kind : undefined;
  const role = typeof section.role === 'string' ? section.role : undefined;
  const tool = typeof section.tool === 'string' ? section.tool : undefined;
  const truncated = Boolean(section.truncated);
  const identifier = typeof section.id === 'string' ? section.id : undefined;
  const contentType = typeof section.contentType === 'string' ? section.contentType : undefined;

  const headerLabel =
    (typeof section.label === 'string' && section.label.trim().length > 0 && section.label) ||
    (typeof section.title === 'string' && section.title.trim().length > 0 && section.title) ||
    (kind ? humanize(kind) : `Section ${index + 1}`);

  const badges: Array<{ key: string; label: string }> = [];

  if (kind) {
    badges.push({ key: 'kind', label: humanize(kind) });
  }

  if (role) {
    badges.push({ key: 'role', label: humanize(role) });
  }

  if (tool) {
    badges.push({ key: 'tool', label: tool });
  }

  if (truncated) {
    badges.push({ key: 'truncated', label: 'Truncated' });
  }

  return (
    <Card withBorder shadow="xs" radius="md" p="md">
      <Stack gap={10}>
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Text fw={600} size="sm">
              {headerLabel}
            </Text>
            {(identifier || contentType) && (
              <Text size="xs" c="dimmed">
                {identifier}
                {identifier && contentType ? ' · ' : ''}
                {contentType}
              </Text>
            )}
          </Stack>
          <Group gap="xs">
            {badges.map((badge) => (
              <Badge key={badge.key} size="xs" variant="light" color="gray">
                {badge.label}
              </Badge>
            ))}
          </Group>
        </Group>

        <Stack gap="sm">
          {Object.entries(section)
            .filter(([key]) => !SECTION_HEADER_PROPS.includes(key))
            .filter(([, value]) => shouldDisplaySectionField(value))
            .map(([key, value]) => (
              <Stack key={key} gap={4}>
                <Text size="xs" c="dimmed">
                  {humanize(key)}
                </Text>
                {renderSectionFieldValue(value)}
              </Stack>
            ))}
        </Stack>
      </Stack>
    </Card>
  );
};

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
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSessionEvents, setSelectedSessionEvents] = useState<TracingEvent[]>([]);
  const [sessionEventsLoading, setSessionEventsLoading] = useState(false);
  const [sessionEventsError, setSessionEventsError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const hasInProgressSession = thread
    ? thread.sessions.some((session) => isInProgressStatus(session.status))
    : false;

  const selectedSession = thread?.sessions.find((session) => session.sessionId === selectedSessionId) || null;
  const hasInProgressSelectedSession = isInProgressStatus(selectedSession?.status);

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

  const fetchSessionEvents = useCallback(async (sessionId: string) => {
    try {
      setSessionEventsLoading(true);
      setSessionEventsError(null);

      const response = await fetch(`/api/tracing/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch session events');
      }

      const data: SessionDetailResponse = await response.json();
      const events = (data.events || []).slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      setSelectedSessionEvents(events);
      setSelectedEventId(events[0]?.id ?? null);
    } catch (err) {
      console.error('Failed to load session events:', err);
      setSelectedSessionEvents([]);
      setSelectedEventId(null);
      setSessionEventsError(err instanceof Error ? err.message : 'Failed to load session events');
    } finally {
      setSessionEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchThread();
  }, [fetchThread]);

  useEffect(() => {
    if (!thread || thread.sessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }

    if (!selectedSessionId || !thread.sessions.some((session) => session.sessionId === selectedSessionId)) {
      setSelectedSessionId(thread.sessions[0].sessionId);
    }
  }, [thread, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSelectedSessionEvents([]);
      setSelectedEventId(null);
      return;
    }

    void fetchSessionEvents(selectedSessionId);
  }, [selectedSessionId, fetchSessionEvents]);

  // Auto-refresh if any session is in_progress
  useEffect(() => {
    if (!hasInProgressSession) return;

    const interval = setInterval(() => fetchThread(), 4000);
    return () => clearInterval(interval);
  }, [hasInProgressSession, fetchThread]);

  useEffect(() => {
    if (!selectedSessionId || !hasInProgressSelectedSession) return;

    const interval = setInterval(() => {
      void fetchSessionEvents(selectedSessionId);
    }, 4000);

    return () => clearInterval(interval);
  }, [selectedSessionId, hasInProgressSelectedSession, fetchSessionEvents]);

  const selectedEvent = selectedSessionEvents.find((event) => event.id === selectedEventId) || null;

  const selectedEventTokenStats = (() => {
    if (!selectedEvent) {
      return {
        isAiCall: false,
        hasData: false,
        input: null as number | null,
        output: null as number | null,
        cached: null as number | null,
      };
    }

    const input = typeof selectedEvent.inputTokens === 'number' ? selectedEvent.inputTokens : null;
    const output = typeof selectedEvent.outputTokens === 'number' ? selectedEvent.outputTokens : null;
    const cached = typeof selectedEvent.cachedInputTokens === 'number' ? selectedEvent.cachedInputTokens : null;
    const hasData = [input, output, cached].some((value) => value !== null);

    return {
      isAiCall: selectedEvent.type === 'ai_call',
      hasData,
      input,
      output,
      cached,
    };
  })();

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
          <>
            <Badge size="sm" variant="filled" radius="xl" color={resolveStatusColor(thread.status)}>
              {thread.status.toUpperCase()}
            </Badge>
            {hasInProgressSession && (
              <Badge size="sm" variant="light" radius="xl" color="blue">
                Auto-refreshing
              </Badge>
            )}
            <Button
              leftSection={<IconArrowLeft size={14} />}
              variant="light"
              size="xs"
              onClick={() => router.push('/dashboard/tracing/threads')}
            >
              Back to Threads
            </Button>
          </>
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
                  <Badge key={agent} size="sm" variant="light" color="blue">
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
                    <Badge key={m} size="xs" variant="light" color="cyan">{m}</Badge>
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
                    <Badge key={t} size="xs" variant="light" color="violet">{t}</Badge>
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

      <Grid>
        <Grid.Col span={{ base: 12, xl: 4 }}>
          <Paper withBorder shadow="sm" p="md" h="100%">
            <Stack gap="md" h="100%">
              <Group justify="space-between">
                <Title order={5}>Sessions</Title>
                <Badge size="sm" variant="light">{thread.sessionsCount} sessions</Badge>
              </Group>

              <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
                <Timeline active={thread.sessions.length - 1} bulletSize={28} lineWidth={2}>
                  {thread.sessions.map((session) => {
                    const isSelected = selectedSessionId === session.sessionId;

                    return (
                      <Timeline.Item
                        key={session.sessionId}
                        bullet={
                          <ThemeIcon
                            size={28}
                            radius="xl"
                            variant="light"
                            color={resolveStatusColor(session.status)}
                          >
                            {isInProgressStatus(session.status) ? (
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
                              <Badge size="xs" variant="light" color="gray">
                                v{session.agentVersion}
                              </Badge>
                            )}
                            <Badge size="xs" variant="light" radius="xl" color={resolveStatusColor(session.status)}>
                              {(session.status || 'unknown').toUpperCase()}
                            </Badge>
                          </Group>
                        }
                      >
                        <Card
                          withBorder
                          p="sm"
                          mt="xs"
                          radius="md"
                          onClick={() => setSelectedSessionId(session.sessionId)}
                          style={{
                            cursor: 'pointer',
                            borderColor: isSelected ? 'var(--mantine-color-gray-4)' : undefined,
                            backgroundColor: isSelected ? 'var(--mantine-color-gray-0)' : undefined,
                          }}
                        >
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
                                  <Badge key={m} size="xs" variant="light" color="cyan">{m}</Badge>
                                ))}
                              </Group>
                            )}

                            {session.toolsUsed && session.toolsUsed.length > 0 && (
                              <Group gap={4}>
                                <IconTool size={12} color="gray" />
                                {session.toolsUsed.map((t) => (
                                  <Badge key={t} size="xs" variant="light" color="violet">{t}</Badge>
                                ))}
                              </Group>
                            )}

                            <Group gap="xs">
                              <Tooltip label={session.sessionId}>
                                <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                                  {session.sessionId.substring(0, 12)}...
                                </Text>
                              </Tooltip>
                              {isSelected && (
                                <Badge size="xs" variant="light" color="gray">
                                  Selected
                                </Badge>
                              )}
                            </Group>
                          </Stack>
                        </Card>
                      </Timeline.Item>
                    );
                  })}
                </Timeline>
              </ScrollArea>
            </Stack>
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, xl: 4 }}>
          <Card withBorder p="md" h="100%">
            <Stack gap="md" h="100%">
              <Text fw={600}>Events</Text>
              {sessionEventsLoading ? (
                <Box p="xl" style={{ textAlign: 'center' }}>
                  <Text c="dimmed">Loading events...</Text>
                </Box>
              ) : sessionEventsError ? (
                <Alert icon={<IconInfoCircle size={14} />} color="red" variant="light">
                  {sessionEventsError}
                </Alert>
              ) : selectedSessionEvents.length === 0 ? (
                <Box p="xl" style={{ textAlign: 'center' }}>
                  <Text c="dimmed">No events recorded for this session.</Text>
                </Box>
              ) : (
                <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
                  <Stack gap="sm">
                    {selectedSessionEvents.map((event) => {
                      const isSelected = event.id === selectedEventId;

                      return (
                        <Paper
                          key={event.id}
                          withBorder
                          radius="md"
                          p="sm"
                          onClick={() => setSelectedEventId(event.id)}
                          style={{
                            cursor: 'pointer',
                            borderColor: isSelected ? 'var(--mantine-color-gray-4)' : undefined,
                            backgroundColor: isSelected ? 'var(--mantine-color-gray-0)' : undefined,
                          }}
                        >
                          <Stack gap={6}>
                            <Group justify="space-between" align="flex-start">
                              <Stack gap={2} style={{ flex: 1 }}>
                                <Text size="sm" fw={600} lineClamp={1}>
                                  {event.label ? humanize(event.label) : humanize(event.type) || 'Event'}
                                </Text>
                                <Text size="xs" c="dimmed">
                                  #{event.sequence ?? '—'} · {event.timestamp ? dayjs(event.timestamp).format('MMM D, YYYY HH:mm:ss') : '—'}
                                </Text>
                              </Stack>
                              {event.status && (
                                <Badge size="xs" variant="light" radius="xl" color={resolveStatusColor(event.status)}>
                                  {event.status.toUpperCase()}
                                </Badge>
                              )}
                            </Group>

                            <Group gap="xs">
                              {event.toolName && (
                                <Badge size="xs" variant="light" color="violet">
                                  {formatToolName(event.toolName)}
                                </Badge>
                              )}
                              {(event.inputTokens || event.outputTokens) && (
                                <Badge size="xs" variant="light" color="gray">
                                  {formatNumber((event.inputTokens || 0) + (event.outputTokens || 0))} tokens
                                </Badge>
                              )}
                            </Group>

                            {(formatRelativeTime(event.timestamp) !== '—' || formatActor(event.actor)) && (
                              <Text size="xs" c="dimmed">
                                {formatRelativeTime(event.timestamp)}{formatActor(event.actor) ? ` · ${formatActor(event.actor)}` : ''}
                              </Text>
                            )}
                          </Stack>
                        </Paper>
                      );
                    })}
                  </Stack>
                </ScrollArea>
              )}
            </Stack>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, xl: 4 }}>
          <Card withBorder p="md" h="100%">
            <Stack gap="md" h="100%">
              <Text fw={600}>Event detail</Text>
              {selectedEvent ? (
                <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
                  <Stack gap="md">
                    <Stack gap={4}>
                      <Text size="lg" fw={600}>
                        {selectedEvent.label ? humanize(selectedEvent.label) : humanize(selectedEvent.type) || 'Event'}
                      </Text>
                      <Group gap="xs">
                        {selectedEvent.status && (
                          <Badge size="sm" variant="light" radius="xl" color={resolveStatusColor(selectedEvent.status)}>
                            {selectedEvent.status.toUpperCase()}
                          </Badge>
                        )}
                        <Text size="xs" c="dimmed">#{selectedEvent.sequence ?? '—'}</Text>
                      </Group>
                      <Text size="sm" c="dimmed">
                        {selectedEvent.timestamp ? dayjs(selectedEvent.timestamp).format('MMM D, YYYY HH:mm:ss') : '—'} · {formatRelativeTime(selectedEvent.timestamp)}
                      </Text>
                      {formatActor(selectedEvent.actor) && (
                        <Text size="sm" c="dimmed">
                          Actor: {formatActor(selectedEvent.actor)}
                        </Text>
                      )}
                    </Stack>

                    <Stack gap={6}>
                      {selectedEvent.toolName && (
                        <Group gap="xs">
                          <Text size="sm" c="dimmed">Tool:</Text>
                          <Badge size="sm" variant="light" color="violet">
                            {formatToolName(selectedEvent.toolName)}
                          </Badge>
                        </Group>
                      )}
                      {selectedEvent.model && (
                        <Group gap="xs">
                          <Text size="sm" c="dimmed">Model:</Text>
                          <Badge size="sm" variant="light" color="cyan">{selectedEvent.model}</Badge>
                        </Group>
                      )}
                      {selectedEvent.durationMs !== undefined && (
                        <Group gap="xs">
                          <Text size="sm" c="dimmed">Duration:</Text>
                          <Text size="sm" fw={500}>{formatDuration(selectedEvent.durationMs)}</Text>
                        </Group>
                      )}
                      {selectedEventTokenStats.isAiCall && selectedEventTokenStats.hasData ? (
                        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
                          <Card withBorder p="sm">
                            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                              Input
                            </Text>
                            <Text size="md" fw={600} mt={4}>
                              {typeof selectedEventTokenStats.input === 'number'
                                ? formatNumber(selectedEventTokenStats.input)
                                : '—'}
                            </Text>
                          </Card>
                          <Card withBorder p="sm">
                            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                              Output
                            </Text>
                            <Text size="md" fw={600} mt={4}>
                              {typeof selectedEventTokenStats.output === 'number'
                                ? formatNumber(selectedEventTokenStats.output)
                                : '—'}
                            </Text>
                          </Card>
                          <Card withBorder p="sm">
                            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                              Cache
                            </Text>
                            <Text size="md" fw={600} mt={4}>
                              {typeof selectedEventTokenStats.cached === 'number'
                                ? formatNumber(selectedEventTokenStats.cached)
                                : '—'}
                            </Text>
                          </Card>
                        </SimpleGrid>
                      ) : (selectedEvent.inputTokens || selectedEvent.outputTokens) ? (
                        <Group gap="xs">
                          {selectedEvent.inputTokens ? (
                            <Badge size="xs" variant="light" color="blue">
                              {formatNumber(selectedEvent.inputTokens)} in
                            </Badge>
                          ) : null}
                          {selectedEvent.outputTokens ? (
                            <Badge size="xs" variant="light" color="indigo">
                              {formatNumber(selectedEvent.outputTokens)} out
                            </Badge>
                          ) : null}
                        </Group>
                      ) : null}
                      {selectedEvent.error?.message && (
                        <Alert icon={<IconInfoCircle size={14} />} color="red" variant="light">
                          {selectedEvent.error.message}
                        </Alert>
                      )}
                    </Stack>

                    {selectedEvent.metadata && Object.keys(selectedEvent.metadata).length > 0 && (
                      <Stack gap={6}>
                        <Text size="sm" fw={600}>
                          Metadata
                        </Text>
                        <Paper withBorder p="sm">
                          <Code block>{JSON.stringify(selectedEvent.metadata, null, 2)}</Code>
                        </Paper>
                      </Stack>
                    )}

                    <Stack gap="sm">
                      <Text size="sm" fw={600}>
                        Sections
                      </Text>
                      {selectedEvent.sections && selectedEvent.sections.length > 0 ? (
                        <Stack gap="sm">
                          {selectedEvent.sections.map((section, index) => {
                            const key =
                              (typeof section.id === 'string' && section.id.length > 0 && `id-${section.id}`) ||
                              (typeof section.label === 'string' && section.label.length > 0 && `label-${section.label}-${index}`) ||
                              (typeof section.title === 'string' && section.title.length > 0 && `title-${section.title}-${index}`) ||
                              `section-${index}`;

                            return <SectionCard key={key} section={section} index={index} />;
                          })}
                        </Stack>
                      ) : (
                        <Text size="sm" c="dimmed">
                          No structured sections for this event.
                        </Text>
                      )}
                    </Stack>
                  </Stack>
                </ScrollArea>
              ) : (
                <Box p="xl" style={{ textAlign: 'center' }}>
                  <Text c="dimmed">Select a session and event to see details.</Text>
                </Box>
              )}
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
