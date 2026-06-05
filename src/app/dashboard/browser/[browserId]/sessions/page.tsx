'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Drawer,
  Group,
  Image,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconCamera,
  IconFileTypePdf,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type { BrowserSessionEventView, BrowserSessionView } from '@/lib/services/browser';

interface CreateForm {
  name: string;
  url: string;
  artifactBucketKey: string;
  allowList: string;
  blockList: string;
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'idle':
      return 'teal';
    case 'pending':
      return 'yellow';
    case 'closed':
      return 'gray';
    case 'expired':
      return 'orange';
    case 'errored':
      return 'red';
    default:
      return 'gray';
  }
}

export default function BrowserSessionsPage() {
  const params = useParams<{ browserId: string }>();
  const browserId = params?.browserId ?? '';
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);
  const [drawerSession, setDrawerSession] = useState<BrowserSessionView | null>(null);
  const [drawerOpened, drawerHandlers] = useDisclosure(false);

  const form = useForm<CreateForm>({
    initialValues: {
      name: '',
      url: '',
      artifactBucketKey: '',
      allowList: '',
      blockList: '',
    },
  });

  const loadSessions = useCallback(async () => {
    if (!browserId) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/browser/sessions?browserId=${encodeURIComponent(browserId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load sessions');
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [browserId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const allowList = form.values.allowList.split(',').map((s) => s.trim()).filter(Boolean);
      const blockList = form.values.blockList.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await fetch('/api/browser/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          browserId,
          name: form.values.name || undefined,
          artifactBucketKey: form.values.artifactBucketKey || undefined,
          config: {
            access: allowList.length || blockList.length ? { allowList, blockList } : undefined,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create session');
      }
      const data = await res.json();
      const session: BrowserSessionView = data.session;
      // Optionally navigate immediately
      if (form.values.url) {
        await fetch(`/api/browser/sessions/${session.sessionKey}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'goto', url: form.values.url }),
        });
      }
      notifications.show({ color: 'teal', title: 'Created', message: `Session ${session.sessionKey}` });
      createHandlers.close();
      form.reset();
      await loadSessions();
      setDrawerSession(session);
      drawerHandlers.open();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setCreating(false);
    }
  };

  const handleClose = async (session: BrowserSessionView) => {
    await fetch(`/api/browser/sessions/${session.sessionKey}`, { method: 'DELETE' });
    await loadSessions();
  };

  const handleDelete = async (session: BrowserSessionView) => {
    await fetch(`/api/browser/sessions/by-id/${session.id}`, { method: 'DELETE' });
    await loadSessions();
  };

  return (
    <PageContainer>
      <Group gap="xs">
        <Button component={Link} href={`/dashboard/browser/${browserId}`} variant="light" size="xs">
          Browser overview
        </Button>
        <Button component={Link} href="/dashboard/browser" variant="subtle" size="xs" c="dimmed">
          ← All browsers
        </Button>
      </Group>
      <PageHeader
        eyebrow="Operate · Browser sessions"
        title="Browser Sessions"
        subtitle="Live headless browser sessions powered by Playwright"
        actions={
          <Group gap="xs">
            <Button leftSection={<IconRefresh size={16} />} variant="light" onClick={loadSessions} loading={refreshing}>
              Refresh
            </Button>
            <Button leftSection={<IconPlus size={16} />} onClick={createHandlers.open}>
              New session
            </Button>
          </Group>
        }
      />

      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
        URLs are persisted in sanitized form and typed input is redacted before it reaches the event log. Use this view to inspect operational flow without leaking secrets.
      </Alert>

      <Paper withBorder p="md">
        {loading ? (
          <Group justify="center" py="xl"><Loader /></Group>
        ) : sessions.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">No sessions yet. Create one to get started.</Text>
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Key</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Current URL</Table.Th>
                <Table.Th>Events</Table.Th>
                <Table.Th>Last Activity</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sessions.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>{s.name || s.agentKey || '—'}</Table.Td>
                  <Table.Td><Code>{s.sessionKey}</Code></Table.Td>
                  <Table.Td><Badge color={statusColor(s.status)} variant="light">{s.status}</Badge></Table.Td>
                  <Table.Td><Text size="sm" truncate maw={260}>{s.currentUrl ?? '—'}</Text></Table.Td>
                  <Table.Td>{s.eventCount ?? 0}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">{s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : '—'}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end">
                      <Tooltip label="Open viewer">
                        <ActionIcon variant="light" onClick={() => { setDrawerSession(s); drawerHandlers.open(); }}>
                          <IconCamera size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Close session">
                        <ActionIcon variant="light" color="orange" onClick={() => handleClose(s)} disabled={s.status === 'closed' || s.status === 'expired'}>
                          <IconX size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete record">
                        <ActionIcon variant="light" color="red" onClick={() => handleDelete(s)}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      {/* Create modal */}
      <Modal opened={createOpened} onClose={createHandlers.close} title="New browser session" size="lg">
        <Stack gap="sm">
          <TextInput label="Name" placeholder="My session" {...form.getInputProps('name')} />
          <TextInput
            label="Initial URL (optional)"
            placeholder="https://example.com"
            {...form.getInputProps('url')}
          />
          <TextInput
            label="Artifact bucket key (optional)"
            description="Existing files bucket where screenshots and PDFs are persisted. Defaults to the configured fallback bucket."
            {...form.getInputProps('artifactBucketKey')}
          />
          <TextInput
            label="Allow-list (comma-separated)"
            placeholder="*.example.com, github.com"
            {...form.getInputProps('allowList')}
          />
          <TextInput
            label="Block-list (comma-separated)"
            placeholder="*.tracker.com"
            {...form.getInputProps('blockList')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={createHandlers.close}>Cancel</Button>
            <Button onClick={handleCreate} loading={creating}>Create</Button>
          </Group>
        </Stack>
      </Modal>

      {/* Live viewer drawer */}
      <SessionDrawer
        opened={drawerOpened && !!drawerSession}
        onClose={() => { drawerHandlers.close(); setDrawerSession(null); }}
        session={drawerSession}
        onMutated={loadSessions}
      />
    </PageContainer>
  );
}

function SessionDrawer({
  session,
  opened,
  onClose,
  onMutated,
}: {
  session: BrowserSessionView | null;
  opened: boolean;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [events, setEvents] = useState<BrowserSessionEventView[]>([]);
  const [polling, setPolling] = useState(true);
  const [navigateUrl, setNavigateUrl] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!opened || !session || !polling) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/browser/sessions/${session.sessionKey}/screenshot/live`, { cache: 'no-store' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setImgUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      } catch {
        // ignore
      }
    };
    tick();
    intervalRef.current = setInterval(tick, 3500);
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, session?.sessionKey, polling]);

  useEffect(() => {
    if (!opened || !session?.id) return;
    let cancelled = false;

    const loadEvents = async () => {
      try {
        const res = await fetch(`/api/browser/sessions/${session.id}/events?limit=25`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setEvents(data.events ?? []);
        }
      } catch {
        if (!cancelled) {
          setEvents([]);
        }
      }
    };

    void loadEvents();
    return () => {
      cancelled = true;
    };
  }, [opened, session?.id]);

  const runNavigate = async () => {
    if (!session || !navigateUrl) return;
    setActionLoading(true);
    try {
      await fetch(`/api/browser/sessions/${session.sessionKey}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'goto', url: navigateUrl }),
      });
      onMutated();
      const eventsRes = await fetch(`/api/browser/sessions/${session.id}/events?limit=25`, { cache: 'no-store' }).catch(() => null);
      if (eventsRes?.ok) {
        const data = await eventsRes.json();
        setEvents(data.events ?? []);
      }
    } finally {
      setActionLoading(false);
    }
  };

  const persistScreenshot = async () => {
    if (!session) return;
    const res = await fetch(`/api/browser/sessions/${session.sessionKey}/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullPage: true }),
    });
    if (res.ok) {
      const data = await res.json();
      notifications.show({ color: 'teal', title: 'Saved', message: `Screenshot stored: ${data.artifact?.objectKey ?? ''}` });
    } else {
      notifications.show({ color: 'red', title: 'Error', message: 'Failed to persist screenshot' });
    }
  };

  const exportPdf = async () => {
    if (!session) return;
    const res = await fetch(`/api/browser/sessions/${session.sessionKey}/pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      notifications.show({ color: 'teal', title: 'PDF', message: `Stored: ${data.artifact?.objectKey ?? ''}` });
    } else {
      notifications.show({ color: 'red', title: 'Error', message: 'Failed to export PDF' });
    }
  };

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title={session?.sessionKey ?? ''}>
      {session && (
        <Stack gap="md">
          <Group justify="space-between">
            <Group gap="xs">
              <Badge color={statusColor(session.status)} variant="light">{session.status}</Badge>
              <Text size="sm" c="dimmed">{session.currentUrl ?? 'about:blank'}</Text>
            </Group>
            <Switch checked={polling} onChange={(e) => setPolling(e.currentTarget.checked)} label="Live preview" />
          </Group>
          <Group gap="xs">
            <TextInput
              placeholder="https://…"
              value={navigateUrl}
              onChange={(e) => setNavigateUrl(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button leftSection={<IconPlayerPlay size={14} />} onClick={runNavigate} loading={actionLoading}>Go</Button>
          </Group>
          <Group gap="xs">
            <Button leftSection={<IconCamera size={14} />} variant="light" onClick={persistScreenshot}>Save screenshot</Button>
            <Button leftSection={<IconFileTypePdf size={14} />} variant="light" onClick={exportPdf}>Export PDF</Button>
          </Group>
          <Paper withBorder p="xs">
            <ScrollArea h={520}>
              {imgUrl ? (
                <Image src={imgUrl} alt="Live screenshot" fit="contain" />
              ) : (
                <Group justify="center" py="xl"><Loader size="sm" /><Text size="sm" c="dimmed">Capturing…</Text></Group>
              )}
            </ScrollArea>
          </Paper>
          <Paper withBorder p="md">
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={600}>Recent events</Text>
                <Text size="xs" c="dimmed">{events.length} entries</Text>
              </Group>
              {events.length === 0 ? (
                <Text size="sm" c="dimmed">No events recorded yet.</Text>
              ) : (
                <ScrollArea h={220}>
                  <Stack gap="xs">
                    {events.map((event) => (
                      <Paper key={event.id} withBorder p="sm" radius="md">
                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                          <Stack gap={2}>
                            <Group gap="xs">
                              <Badge variant="light" color={event.status === 'error' ? 'red' : 'blue'}>
                                {event.type}
                              </Badge>
                              <Text size="xs" c="dimmed">#{event.sequence}</Text>
                            </Group>
                            <Text size="xs" c="dimmed">
                              {event.url ?? event.selector ?? event.ref ?? 'No target'}
                            </Text>
                            {event.errorMessage ? (
                              <Text size="xs" c="red">{event.errorMessage}</Text>
                            ) : null}
                          </Stack>
                          <Text size="xs" c="dimmed">
                            {event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : '—'}
                          </Text>
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                </ScrollArea>
              )}
            </Stack>
          </Paper>
        </Stack>
      )}
    </Drawer>
  );
}
