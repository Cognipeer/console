'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Grid,
  Group,
  Image,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconBolt,
  IconCode,
  IconEdit,
  IconInfoCircle,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
  IconRobot,
  IconTerminal,
  IconWorld,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import type {
  BrowserAgentRunResult,
  BrowserAgentView,
  BrowserSessionEventView,
  BrowserSessionView,
  BrowserView,
} from '@/lib/services/browser';

interface EditAgentForm {
  name: string;
  description: string;
  modelKey: string;
  systemPrompt: string;
  status: 'active' | 'inactive' | 'draft';
}

function formatDate(value: unknown): string {
  if (!value) return '—';
  try {
    const date = value instanceof Date ? value : new Date(value as string);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  } catch {
    return '—';
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'active':
    case 'running':
    case 'idle':
    case 'success':
      return 'teal';
    case 'draft':
    case 'pending':
      return 'yellow';
    case 'inactive':
    case 'closed':
    case 'expired':
      return 'gray';
    case 'error':
    case 'errored':
      return 'red';
    default:
      return 'gray';
  }
}

function summarizeEvent(event: BrowserSessionEventView): string {
  if (event.errorMessage) return event.errorMessage;
  if (event.data?.reason && typeof event.data.reason === 'string') return event.data.reason;
  if (event.data?.url && typeof event.data.url === 'string') return event.data.url;
  if (event.url) return event.url;
  if (event.ref) return `ref ${event.ref}`;
  if (event.selector) return event.selector;
  if (event.data) {
    const preview = JSON.stringify(event.data);
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  }
  return 'No extra details';
}

export default function BrowserAgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params?.agentId ?? '';

  const [agent, setAgent] = useState<BrowserAgentView | null>(null);
  const [browser, setBrowser] = useState<BrowserView | null>(null);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  const [editOpened, editHandlers] = useDisclosure(false);
  const [saving, setSaving] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [liveSession, setLiveSession] = useState<BrowserSessionView | null>(null);
  const [liveEvents, setLiveEvents] = useState<BrowserSessionEventView[]>([]);
  const [liveScreenshotUrl, setLiveScreenshotUrl] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<BrowserAgentRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const livePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveScreenshotUrlRef = useRef<string | null>(null);

  const editForm = useForm<EditAgentForm>({
    initialValues: {
      name: '',
      description: '',
      modelKey: '',
      systemPrompt: '',
      status: 'active',
    },
    validate: {
      name: (value) => (value.trim().length < 2 ? 'Name is required' : null),
    },
  });

  const loadAll = useCallback(async () => {
    if (!agentId) return;
    setRefreshing(true);
    try {
      const agentRes = await fetch(`/api/browser/agents/${encodeURIComponent(agentId)}`, { cache: 'no-store' });
      if (!agentRes.ok) {
        const body = await agentRes.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load agent');
      }

      const agentData = await agentRes.json();
      const nextAgent: BrowserAgentView | null = agentData.agent ?? null;
      setAgent(nextAgent);

      if (!nextAgent) {
        setBrowser(null);
        setSessions([]);
        return;
      }

      const [browserRes, sessionsRes] = await Promise.all([
        fetch(`/api/browser/browsers/${encodeURIComponent(nextAgent.browserId)}`, { cache: 'no-store' }),
        fetch(`/api/browser/sessions?agentId=${encodeURIComponent(nextAgent.id)}`, { cache: 'no-store' }),
      ]);

      const browserData = browserRes.ok ? await browserRes.json() : { browser: null };
      const sessionsData = sessionsRes.ok ? await sessionsRes.json() : { sessions: [] };
      const nextSessions: BrowserSessionView[] = sessionsData.sessions ?? [];

      setBrowser(browserData.browser ?? null);
      setSessions(nextSessions);

      setLiveSession((current) => {
        if (!current) return current;
        return nextSessions.find((session) => session.id === current.id) ?? current;
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to load agent',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!agent || !editOpened) return;
    editForm.setValues({
      name: agent.name ?? '',
      description: agent.description ?? '',
      modelKey: agent.modelKey ?? '',
      systemPrompt: agent.systemPrompt ?? '',
      status: agent.status,
    });
  }, [agent, editOpened]);

  useEffect(() => {
    if (!selectedSessionKey) return;
    const selected = sessions.find((session) => session.sessionKey === selectedSessionKey);
    if (selected) {
      setLiveSession((current) => (current?.id === selected.id ? current : selected));
    }
  }, [selectedSessionKey, sessions]);

  useEffect(() => {
    return () => {
      if (livePollRef.current) clearInterval(livePollRef.current);
      if (liveScreenshotUrlRef.current) {
        URL.revokeObjectURL(liveScreenshotUrlRef.current);
        liveScreenshotUrlRef.current = null;
      }
    };
  }, []);

  const reusableSessions = useMemo(
    () => sessions.filter((session) => ['pending', 'idle', 'running'].includes(session.status)),
    [sessions],
  );

  const sessionOptions = useMemo(
    () => [
      { value: '', label: 'Create a fresh session for this run' },
      ...reusableSessions.map((session) => ({
        value: session.sessionKey,
        label: `${session.name || session.sessionKey} (${session.status})`,
      })),
    ],
    [reusableSessions],
  );

  const summary = useMemo(() => {
    const active = sessions.filter((session) => ['running', 'idle'].includes(session.status)).length;
    const errored = sessions.filter((session) => session.status === 'errored').length;
    const lastActivity = sessions
      .map((session) => (session.lastActivityAt ? new Date(session.lastActivityAt).getTime() : 0))
      .reduce((max, value) => Math.max(max, value), 0);

    return {
      total: sessions.length,
      active,
      errored,
      lastActivity: lastActivity ? new Date(lastActivity).toLocaleString() : '—',
    };
  }, [sessions]);

  const pollLiveState = useCallback(async (session: BrowserSessionView) => {
    try {
      const [eventsRes, screenshotRes] = await Promise.all([
        fetch(`/api/browser/sessions/${encodeURIComponent(session.id)}/events?limit=25`, { cache: 'no-store' }),
        fetch(`/api/browser/sessions/${encodeURIComponent(session.sessionKey)}/screenshot/live`, { cache: 'no-store' }),
      ]);

      if (eventsRes.ok) {
        const eventsData = await eventsRes.json();
        setLiveEvents(eventsData.events ?? []);
      }

      if (screenshotRes.ok) {
        const blob = await screenshotRes.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (liveScreenshotUrlRef.current) {
          URL.revokeObjectURL(liveScreenshotUrlRef.current);
        }
        liveScreenshotUrlRef.current = objectUrl;
        setLiveScreenshotUrl((current) => {
          return objectUrl;
        });
      }
    } catch {
      // Keep the panel alive even when the browser session is between actions.
    }
  }, []);

  useEffect(() => {
    if (livePollRef.current) {
      clearInterval(livePollRef.current);
      livePollRef.current = null;
    }

    if (activeTab !== 'playground' || !liveSession) return;

    pollLiveState(liveSession);
    livePollRef.current = setInterval(() => {
      pollLiveState(liveSession);
    }, running ? 2500 : 5000);

    return () => {
      if (livePollRef.current) {
        clearInterval(livePollRef.current);
        livePollRef.current = null;
      }
    };
  }, [activeTab, liveSession, running, pollLiveState]);

  const ensureSessionForRun = useCallback(async (): Promise<BrowserSessionView> => {
    if (!agent) throw new Error('Agent is not loaded');

    const chosenSession = selectedSessionKey
      ? reusableSessions.find((session) => session.sessionKey === selectedSessionKey)
      : null;

    if (chosenSession) {
      return chosenSession;
    }

    const res = await fetch('/api/browser/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        browserId: agent.browserId,
        agentId: agent.id,
        agentKey: agent.key,
        name: `${agent.name} playground`,
        artifactBucketKey: agent.artifactBucketKey || undefined,
        config: agent.browserConfig || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || 'Failed to create session');
    }
    return body.session as BrowserSessionView;
  }, [agent, reusableSessions, selectedSessionKey]);

  const handleRun = useCallback(async () => {
    if (!agent) return;
    if (!prompt.trim()) {
      notifications.show({ color: 'red', title: 'Prompt required', message: 'Enter a task for the agent.' });
      return;
    }

    setActiveTab('playground');
    setRunning(true);
    setLastResult(null);

    try {
      const session = await ensureSessionForRun();
      setSelectedSessionKey(session.sessionKey);
      setLiveSession(session);
      setLiveEvents([]);
      await pollLiveState(session);

      const res = await fetch(`/api/browser/agents/${encodeURIComponent(agent.id)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          sessionKey: session.sessionKey,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || 'Run failed');
      }

      setLastResult(body.result as BrowserAgentRunResult);
      notifications.show({
        color: 'teal',
        title: 'Run complete',
        message: `Agent finished in ${body.result.durationMs} ms`,
      });

      await loadAll();
      await pollLiveState(session);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Run failed',
        message: error instanceof Error ? error.message : 'Failed to run agent',
      });
    } finally {
      setRunning(false);
    }
  }, [agent, ensureSessionForRun, loadAll, pollLiveState, prompt]);

  const handleEditSubmit = useCallback(async (values: EditAgentForm) => {
    if (!agent) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/browser/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          modelKey: values.modelKey.trim() || undefined,
          systemPrompt: values.systemPrompt.trim() || undefined,
          status: values.status,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to update agent');

      notifications.show({ color: 'teal', title: 'Updated', message: 'Browser agent updated.' });
      editHandlers.close();
      await loadAll();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Update failed',
        message: error instanceof Error ? error.message : 'Failed to update agent',
      });
    } finally {
      setSaving(false);
    }
  }, [agent, editHandlers, loadAll]);

  if (loading) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  if (!agent) {
    return (
      <Stack p="md">
        <Alert color="red" icon={<IconAlertCircle size={16} />}>
          Browser agent not found.
        </Alert>
        <Anchor component={Link} href="/dashboard/browser-agents">
          Back to Browser Agents
        </Anchor>
      </Stack>
    );
  }

  return (
    <Stack gap="md" p="md">
      <Group gap="xs">
        <Button
          component={Link}
          href="/dashboard/browser-agents"
          variant="subtle"
          size="xs"
          leftSection={<IconArrowLeft size={14} />}
        >
          All browser agents
        </Button>
      </Group>

      <PageHeader
        icon={<IconRobot size={20} />}
        title={agent.name}
        subtitle={agent.description || 'Autonomous browser agent'}
        actions={
          <Group gap="xs">
            <Badge color={getStatusColor(agent.status)} variant="light" size="lg">
              {agent.status}
            </Badge>
            <Tooltip label="Refresh">
              <ActionIcon variant="subtle" onClick={loadAll} loading={refreshing}>
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Button leftSection={<IconEdit size={14} />} variant="light" size="xs" onClick={editHandlers.open}>
              Edit
            </Button>
            <Button leftSection={<IconPlayerPlay size={14} />} size="xs" onClick={() => setActiveTab('playground')}>
              Open Playground
            </Button>
          </Group>
        }
      />

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <MetricCard label="Sessions" value={String(summary.total)} color="indigo" />
        <MetricCard label="Active" value={String(summary.active)} color="teal" />
        <MetricCard label="Errored" value={String(summary.errored)} color="red" />
        <MetricCard label="Last activity" value={summary.lastActivity} color="gray" small />
      </SimpleGrid>

      <Tabs value={activeTab} onChange={(value) => setActiveTab(value ?? 'overview')} variant="outline">
        <Tabs.List>
          <Tabs.Tab value="overview" leftSection={<IconInfoCircle size={14} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="playground" leftSection={<IconPlayerPlay size={14} />}>
            Playground
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconTerminal size={14} />}>
            Usage
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder p="lg" radius="lg">
                <Stack gap="sm">
                  <Group gap="xs">
                    <ThemeIcon variant="light" color="grape" radius="md">
                      <IconRobot size={16} />
                    </ThemeIcon>
                    <Text fw={600}>Agent profile</Text>
                  </Group>
                  <DetailRow label="Agent ID" value={<Code>{agent.id}</Code>} />
                  <DetailRow label="Agent key" value={<Code>{agent.key}</Code>} />
                  <DetailRow label="Model" value={agent.modelKey ? <Code>{agent.modelKey}</Code> : <Text c="dimmed">—</Text>} />
                  <DetailRow label="Status" value={<Badge color={getStatusColor(agent.status)} variant="light">{agent.status}</Badge>} />
                  <DetailRow label="Artifact bucket" value={agent.artifactBucketKey ? <Code>{agent.artifactBucketKey}</Code> : <Text c="dimmed">—</Text>} />
                  <DetailRow label="Created" value={<Text size="sm">{formatDate(agent.createdAt)}</Text>} />
                  <DetailRow label="Updated" value={<Text size="sm">{formatDate(agent.updatedAt)}</Text>} />
                </Stack>
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder p="lg" radius="lg">
                <Stack gap="sm">
                  <Group gap="xs">
                    <ThemeIcon variant="light" color="indigo" radius="md">
                      <IconWorld size={16} />
                    </ThemeIcon>
                    <Text fw={600}>Parent browser</Text>
                  </Group>
                  {browser ? (
                    <>
                      <DetailRow
                        label="Browser"
                        value={
                          <Anchor component={Link} href={`/dashboard/browser/${browser.id}`}>
                            {browser.name}
                          </Anchor>
                        }
                      />
                      <DetailRow label="Browser key" value={<Code>{browser.key}</Code>} />
                      <DetailRow label="Browser status" value={<Badge color={getStatusColor(browser.status)} variant="light">{browser.status}</Badge>} />
                      <DetailRow label="Default model" value={browser.defaultModelKey ? <Code>{browser.defaultModelKey}</Code> : <Text c="dimmed">—</Text>} />
                    </>
                  ) : (
                    <Text size="sm" c="dimmed">
                      Browser could not be resolved.
                    </Text>
                  )}
                </Stack>
              </Paper>
            </Grid.Col>

            <Grid.Col span={12}>
              <Paper withBorder p="lg" radius="lg">
                <Stack gap="sm">
                  <Group gap="xs">
                    <ThemeIcon variant="light" color="teal" radius="md">
                      <IconTerminal size={16} />
                    </ThemeIcon>
                    <Text fw={600}>System prompt</Text>
                  </Group>
                  <ScrollArea h={220}>
                    <Code block style={{ whiteSpace: 'pre-wrap' }}>
                      {agent.systemPrompt?.trim() || 'Uses the default autonomous browser system prompt.'}
                    </Code>
                  </ScrollArea>
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="playground" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <Stack gap="md">
                <Paper withBorder p="lg" radius="lg">
                  <Stack gap="sm">
                    <Group gap="xs">
                      <ThemeIcon variant="light" color="grape" radius="md">
                        <IconBolt size={16} />
                      </ThemeIcon>
                      <Text fw={600}>Run the agent</Text>
                    </Group>
                    <Textarea
                      label="Prompt"
                      description="The agent will act directly. It should only ask back if the task is impossible without missing information."
                      autosize
                      minRows={7}
                      placeholder="Open https://example.com, inspect the pricing page, and summarize the differences between tiers."
                      value={prompt}
                      onChange={(event) => setPrompt(event.currentTarget.value)}
                    />
                    <Select
                      label="Session"
                      description="Reuse a live session or let the playground create a fresh one before running."
                      data={sessionOptions}
                      value={selectedSessionKey ?? ''}
                      onChange={(value) => setSelectedSessionKey(value || null)}
                    />
                    <Group justify="space-between" align="flex-start">
                      <Text size="xs" c="dimmed" maw={260}>
                        Right side shows what the agent is doing live, using session events and periodic browser screenshots.
                      </Text>
                      <Button leftSection={<IconPlayerPlay size={14} />} onClick={handleRun} loading={running}>
                        Run agent
                      </Button>
                    </Group>
                  </Stack>
                </Paper>

                <Paper withBorder p="lg" radius="lg">
                  <Stack gap="sm">
                    <Group gap="xs">
                      <ThemeIcon variant="light" color="blue" radius="md">
                        <IconTerminal size={16} />
                      </ThemeIcon>
                      <Text fw={600}>Latest output</Text>
                    </Group>
                    {lastResult ? (
                      <>
                        <Group gap="xs">
                          <Badge color={getStatusColor(lastResult.status)} variant="light">
                            {lastResult.status}
                          </Badge>
                          <Code>{lastResult.sessionKey}</Code>
                          <Text size="xs" c="dimmed">
                            {lastResult.toolCalls} tool calls · {lastResult.durationMs} ms
                          </Text>
                        </Group>
                        <ScrollArea h={220}>
                          <Code block style={{ whiteSpace: 'pre-wrap' }}>
                            {lastResult.output || lastResult.errorMessage || 'No output returned.'}
                          </Code>
                        </ScrollArea>
                      </>
                    ) : (
                      <Text size="sm" c="dimmed">
                        No run yet. Start a playground run to see the final answer here.
                      </Text>
                    )}
                  </Stack>
                </Paper>
              </Stack>
            </Grid.Col>

            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Stack gap="md">
                <Paper withBorder p="lg" radius="lg">
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Group gap="xs">
                        <ThemeIcon variant="light" color="teal" radius="md">
                          <IconPhoto size={16} />
                        </ThemeIcon>
                        <Text fw={600}>Live browser view</Text>
                      </Group>
                      <Text size="xs" c="dimmed" mt={4}>
                        Screenshot refreshes automatically while the agent is working.
                      </Text>
                    </div>
                    {liveSession ? (
                      <Group gap="xs">
                        <Code>{liveSession.sessionKey}</Code>
                        <Badge color={getStatusColor(liveSession.status)} variant="light">
                          {liveSession.status}
                        </Badge>
                      </Group>
                    ) : null}
                  </Group>

                  <Paper mt="md" withBorder radius="md" p="xs" bg="var(--mantine-color-dark-8)">
                    {liveScreenshotUrl ? (
                      <Image src={liveScreenshotUrl} alt="Live browser screenshot" fit="contain" />
                    ) : (
                      <Group justify="center" py="xl">
                        {running ? <Loader size="sm" /> : <Text size="sm" c="dimmed">No live screenshot yet.</Text>}
                      </Group>
                    )}
                  </Paper>
                </Paper>

                <Paper withBorder p="lg" radius="lg">
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Group gap="xs">
                        <ThemeIcon variant="light" color="orange" radius="md">
                          <IconBolt size={16} />
                        </ThemeIcon>
                        <Text fw={600}>Live activity</Text>
                      </Group>
                      <Text size="xs" c="dimmed" mt={4}>
                        Timeline of persisted browser events for the current session.
                      </Text>
                    </div>
                    {running ? <Badge color="teal">Running</Badge> : <Badge variant="light">Idle</Badge>}
                  </Group>

                  <ScrollArea h={380} mt="md">
                    {liveSession ? (
                      liveEvents.length > 0 ? (
                        <Stack gap="xs">
                          {liveEvents.map((event) => (
                            <Paper key={event.id} withBorder p="sm" radius="md">
                              <Group justify="space-between" align="flex-start" wrap="nowrap">
                                <div>
                                  <Group gap="xs">
                                    <Badge variant="light">#{event.sequence}</Badge>
                                    <Badge color={getStatusColor(event.status || event.type)} variant="light">
                                      {event.type}
                                    </Badge>
                                    {event.status ? (
                                      <Badge color={getStatusColor(event.status)} variant="dot">
                                        {event.status}
                                      </Badge>
                                    ) : null}
                                  </Group>
                                  <Text size="sm" mt={6}>{summarizeEvent(event)}</Text>
                                  <Text size="xs" c="dimmed" mt={4}>
                                    {formatDate(event.createdAt)}
                                    {event.durationMs ? ` · ${event.durationMs} ms` : ''}
                                  </Text>
                                </div>
                              </Group>
                            </Paper>
                          ))}
                        </Stack>
                      ) : (
                        <Group justify="center" py="xl">
                          {running ? <Loader size="sm" /> : <Text size="sm" c="dimmed">No events yet for this session.</Text>}
                        </Group>
                      )
                    ) : (
                      <Text size="sm" c="dimmed">
                        Start a run or choose a reusable session to inspect its activity here.
                      </Text>
                    )}
                  </ScrollArea>
                </Paper>
              </Stack>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="usage" pt="md">
          <BrowserAgentUsagePanel agent={agent} browser={browser} />
        </Tabs.Panel>
      </Tabs>

      <Modal opened={editOpened} onClose={editHandlers.close} title="Edit Browser Agent" size="lg">
        <form onSubmit={editForm.onSubmit(handleEditSubmit)}>
          <Stack>
            <TextInput label="Name" required {...editForm.getInputProps('name')} />
            <Textarea label="Description" autosize minRows={2} {...editForm.getInputProps('description')} />
            <TextInput label="Model key" {...editForm.getInputProps('modelKey')} />
            <Select
              label="Status"
              data={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
                { value: 'draft', label: 'Draft' },
              ]}
              {...editForm.getInputProps('status')}
            />
            <Textarea label="System prompt" autosize minRows={6} {...editForm.getInputProps('systemPrompt')} />
            <Group justify="flex-end">
              <Button variant="subtle" onClick={editHandlers.close} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}

function MetricCard({
  label,
  value,
  color,
  small = false,
}: {
  label: string;
  value: string;
  color: string;
  small?: boolean;
}) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Stack gap={2}>
        <Text size="xs" c="dimmed" tt="uppercase">
          {label}
        </Text>
        <Text fw={700} size={small ? 'sm' : 'xl'} c={color}>
          {value}
        </Text>
      </Stack>
    </Paper>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" align="center">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <div>{value}</div>
    </Group>
  );
}

function BrowserAgentUsagePanel({
  agent,
  browser,
}: {
  agent: BrowserAgentView;
  browser: BrowserView | null;
}) {
  const apiBase = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const sdkExample = `import { ConsoleClient } from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: process.env.COGNIPEER_API_KEY!,
  baseURL: '${apiBase}',
});

const result = await client.browserAgents.run('${agent.id}', {
  prompt: 'Open https://example.com and summarize the hero section in 3 bullets.',
});

console.log(result.output);`;

  const curlRun = `curl -X POST '${apiBase}/api/client/v1/browser/agents/${agent.id}/run' \\
  -H 'Authorization: Bearer <API_TOKEN>' \\
  -H 'Content-Type: application/json' \\
  -d '{
  "prompt": "Open https://example.com and summarize the hero section in 3 bullets."
}'`;

  const curlGet = `curl '${apiBase}/api/client/v1/browser/agents/${agent.id}' \\
  -H 'Authorization: Bearer <API_TOKEN>'`;

  const curlList = `curl '${apiBase}/api/client/v1/browser/agents${browser ? `?browserId=${browser.id}` : ''}' \\
  -H 'Authorization: Bearer <API_TOKEN>'`;

  return (
    <Stack gap="md">
      <Alert color="blue" icon={<IconInfoCircle size={16} />}>
        Browser Agents run against their parent browser profile and can reuse an existing session by passing a
        <Code>sessionKey</Code> in the run request.
      </Alert>

      <Paper withBorder p="lg" radius="lg">
        <Stack gap="sm">
          <Group gap="xs">
            <IconCode size={16} />
            <Text fw={600}>Console SDK</Text>
          </Group>
          <ScrollArea type="auto">
            <Code block style={{ whiteSpace: 'pre-wrap', minWidth: 720 }}>
              {sdkExample}
            </Code>
          </ScrollArea>
        </Stack>
      </Paper>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <UsageCard title="Run agent" command={curlRun} hint="POST /api/client/v1/browser/agents/:id/run" />
        <UsageCard title="Get agent" command={curlGet} hint="GET /api/client/v1/browser/agents/:id" />
        <UsageCard title="List agents" command={curlList} hint="GET /api/client/v1/browser/agents" />
        <Paper withBorder p="lg" radius="lg">
          <Stack gap="sm">
            <Text fw={600}>Return shape</Text>
            <Code block style={{ whiteSpace: 'pre-wrap' }}>{`{
  "result": {
    "sessionKey": "bs_...",
    "sessionId": "...",
    "output": "Agent summary",
    "toolCalls": 4,
    "durationMs": 3810,
    "status": "success"
  }
}`}</Code>
          </Stack>
        </Paper>
      </SimpleGrid>
    </Stack>
  );
}

function UsageCard({ title, command, hint }: { title: string; command: string; hint: string }) {
  return (
    <Paper withBorder p="lg" radius="lg">
      <Stack gap="sm">
        <Text fw={600}>{title}</Text>
        <ScrollArea type="auto">
          <Code block style={{ whiteSpace: 'pre-wrap', minWidth: 420 }}>{command}</Code>
        </ScrollArea>
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      </Stack>
    </Paper>
  );
}