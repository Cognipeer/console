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
  Drawer,
  Grid,
  Group,
  Image,
  Loader,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconCamera,
  IconCode,
  IconCopy,
  IconDeviceDesktop,
  IconDots,
  IconEdit,
  IconHistory,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconTerminal,
  IconTrash,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import type { BrowserSessionView, BrowserView } from '@/lib/services/browser';

interface CreateSessionForm {
  name: string;
  url: string;
  artifactBucketKey: string;
  allowList: string;
  blockList: string;
}

interface EditBrowserForm {
  name: string;
  description: string;
  defaultModelKey: string;
  artifactBucketKey: string;
  status: 'active' | 'disabled';
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'idle':
    case 'active':
      return 'teal';
    case 'pending':
      return 'yellow';
    case 'closed':
    case 'disabled':
      return 'gray';
    case 'expired':
      return 'orange';
    case 'errored':
      return 'red';
    default:
      return 'gray';
  }
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

export default function BrowserDetailPage() {
  const params = useParams<{ browserId: string }>();
  const browserId = params?.browserId ?? '';

  const [browser, setBrowser] = useState<BrowserView | null>(null);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [activeTab, setActiveTab] = useState<string>('overview');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');

  const [editOpened, editHandlers] = useDisclosure(false);
  const [saving, setSaving] = useState(false);

  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);
  const [drawerSession, setDrawerSession] = useState<BrowserSessionView | null>(null);
  const [drawerOpened, drawerHandlers] = useDisclosure(false);
  const [mcpOpened, mcpHandlers] = useDisclosure(false);

  const sessionForm = useForm<CreateSessionForm>({
    initialValues: { name: '', url: '', artifactBucketKey: '', allowList: '', blockList: '' },
  });

  const editForm = useForm<EditBrowserForm>({
    initialValues: { name: '', description: '', defaultModelKey: '', artifactBucketKey: '', status: 'active' },
    validate: {
      name: (v) => (v.trim().length < 2 ? 'Name is required' : null),
    },
  });

  const loadAll = useCallback(async () => {
    if (!browserId) return;
    setRefreshing(true);
    try {
      const [browserRes, sessionsRes] = await Promise.all([
        fetch(`/api/browser/browsers/${encodeURIComponent(browserId)}`, { cache: 'no-store' }),
        fetch(`/api/browser/sessions?browserId=${encodeURIComponent(browserId)}`, { cache: 'no-store' }),
      ]);

      if (!browserRes.ok) {
        const body = await browserRes.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load browser');
      }

      const browserData = await browserRes.json();
      const sessionsData = sessionsRes.ok ? await sessionsRes.json() : { sessions: [] };

      setBrowser(browserData.browser ?? null);
      setSessions(sessionsData.sessions ?? []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [browserId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (browser) {
      editForm.setValues({
        name: browser.name ?? '',
        description: browser.description ?? '',
        defaultModelKey: browser.defaultModelKey ?? '',
        artifactBucketKey: browser.artifactBucketKey ?? '',
        status: (browser.status as 'active' | 'disabled') ?? 'active',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser?.id]);

  const summary = useMemo(() => {
    const active = sessions.filter((s) => s.status === 'running' || s.status === 'idle').length;
    const errored = sessions.filter((s) => s.status === 'errored').length;
    const closed = sessions.filter((s) => s.status === 'closed' || s.status === 'expired').length;
    return { total: sessions.length, active, errored, closed };
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    return sessions.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (!search) return true;
      return (
        (s.name ?? '').toLowerCase().includes(search) ||
        s.sessionKey.toLowerCase().includes(search) ||
        (s.currentUrl ?? '').toLowerCase().includes(search)
      );
    });
  }, [sessions, searchTerm, statusFilter]);

  const handleEditSubmit = async (values: EditBrowserForm) => {
    if (!browser) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/browser/browsers/${browser.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          defaultModelKey: values.defaultModelKey.trim() || undefined,
          artifactBucketKey: values.artifactBucketKey.trim() || undefined,
          status: values.status,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update');
      }
      notifications.show({ color: 'teal', title: 'Updated', message: 'Browser updated' });
      editHandlers.close();
      await loadAll();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateSession = async () => {
    if (!browser) return;
    setCreating(true);
    try {
      const allowList = sessionForm.values.allowList.split(',').map((s) => s.trim()).filter(Boolean);
      const blockList = sessionForm.values.blockList.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await fetch('/api/browser/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          browserId: browser.id,
          name: sessionForm.values.name || undefined,
          artifactBucketKey: sessionForm.values.artifactBucketKey || undefined,
          config: {
            access: {
              allowList: allowList.length > 0 ? allowList : undefined,
              blockList: blockList.length > 0 ? blockList : undefined,
            },
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed');
      const created: BrowserSessionView = body.session;
      if (sessionForm.values.url.trim()) {
        await fetch(`/api/browser/sessions/${created.sessionKey}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'goto', url: sessionForm.values.url.trim() }),
        }).catch(() => undefined);
      }
      notifications.show({ color: 'teal', title: 'Created', message: `Session ${created.sessionKey}` });
      createHandlers.close();
      sessionForm.reset();
      await loadAll();
      setDrawerSession(created);
      drawerHandlers.open();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setCreating(false);
    }
  };

  const handleCloseSession = async (s: BrowserSessionView) => {
    await fetch(`/api/browser/sessions/${s.sessionKey}`, { method: 'DELETE' });
    await loadAll();
  };

  const handleDeleteSession = async (s: BrowserSessionView) => {
    if (!confirm('Delete this session?')) return;
    await fetch(`/api/browser/sessions/by-id/${s.id}`, { method: 'DELETE' });
    await loadAll();
  };

  if (loading) {
    return <Group justify="center" py="xl"><Loader /></Group>;
  }

  if (!browser) {
    return (
      <Stack p="md">
        <Alert color="red" icon={<IconAlertCircle size={16} />}>Browser not found.</Alert>
        <Anchor component={Link} href="/dashboard/browser">← All browsers</Anchor>
      </Stack>
    );
  }

  const browserStatusVariant: 'ok' | 'paused' | 'err' | 'info' =
    browser.status === 'active'
      ? 'ok'
      : browser.status === 'disabled'
        ? 'paused'
        : browser.status === 'errored'
          ? 'err'
          : 'info';

  const headerActions = (
    <>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconRefresh size={14} stroke={1.7} />}
        loading={refreshing}
        onClick={loadAll}
      >
        Refresh
      </Button>
      <Button
        variant="default"
        size="sm"
        component={Link}
        href={`/dashboard/browser/${encodeURIComponent(browserId)}/sessions`}
        leftSection={<IconHistory size={14} stroke={1.7} />}
      >
        Sessions
      </Button>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconEdit size={14} stroke={1.7} />}
        onClick={editHandlers.open}
      >
        Edit
      </Button>
      <Menu withinPortal position="bottom-end" withArrow>
        <Menu.Target>
          <ActionIcon variant="default" radius="md" size="lg" aria-label="More">
            <IconDots size={15} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconPlug size={14} />} onClick={mcpHandlers.open}>
            Get MCP URL
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );

  return (
    <DetailShell
      backHref="/dashboard/browser"
      backLabel="Back to browsers"
      icon={
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: 'var(--ds-accent-soft)',
            color: 'var(--ds-accent)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <IconWorld size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
            {browser.name}
          </h1>
          <StatusBadge status={browserStatusVariant} label={browser.status} />
          <span className="ds-badge ds-badge-info">{summary.total} sessions</span>
        </>
      }
      meta={
        <>
          <span className="ds-mono">{browser.key}</span>
          {browser.defaultModelKey ? (
            <>
              <span className="ds-faint">·</span>
              <span>model: <span className="ds-mono">{browser.defaultModelKey}</span></span>
            </>
          ) : null}
          {browser.artifactBucketKey ? (
            <>
              <span className="ds-faint">·</span>
              <span>bucket: <span className="ds-mono">{browser.artifactBucketKey}</span></span>
            </>
          ) : null}
          {browser.description ? (
            <>
              <span className="ds-faint">·</span>
              <span>{browser.description}</span>
            </>
          ) : null}
        </>
      }
      actions={headerActions}
    >
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <SummaryCard label="Sessions" value={summary.total} accent="teal" />
        <SummaryCard label="Active" value={summary.active} accent="teal" />
        <SummaryCard label="Errored" value={summary.errored} accent="red" />
      </SimpleGrid>

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v ?? 'overview')} variant="outline">
        <Tabs.List>
          <Tabs.Tab value="overview" leftSection={<IconInfoCircle size={14} />}>Overview</Tabs.Tab>
          <Tabs.Tab value="playground" leftSection={<IconPlayerPlay size={14} />}>Playground</Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconTerminal size={14} />}>Usage</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder p="lg" radius="lg">
                <Stack gap="sm">
                  <Group gap="xs">
                    <ThemeIcon variant="light" color="indigo" radius="md"><IconWorld size={16} /></ThemeIcon>
                    <Text fw={600}>Profile</Text>
                  </Group>
                  <DetailRow label="Browser ID" value={<Code>{browser.id}</Code>} />
                  <DetailRow label="Browser key" value={<Code>{browser.key}</Code>} />
                  <DetailRow label="Status" value={<Badge color={statusColor(browser.status)} variant="light">{browser.status}</Badge>} />
                  <DetailRow label="Default model" value={browser.defaultModelKey ? <Code>{browser.defaultModelKey}</Code> : <Text c="dimmed">—</Text>} />
                  <DetailRow label="Artifact bucket" value={browser.artifactBucketKey ? <Code>{browser.artifactBucketKey}</Code> : <Text c="dimmed">—</Text>} />
                  <DetailRow label="Created" value={<Text size="sm">{formatDate(browser.createdAt)}</Text>} />
                  <DetailRow label="Updated" value={<Text size="sm">{formatDate(browser.updatedAt)}</Text>} />
                  <Group gap="xs" mt="xs">
                    <Button
                      size="xs"
                      variant="light"
                      color="grape"
                      leftSection={<IconPlug size={14} />}
                      onClick={mcpHandlers.open}
                    >
                      Get MCP URL
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder p="lg" radius="lg">
                <Stack gap="sm">
                  <Group gap="xs">
                    <ThemeIcon variant="light" color="teal" radius="md"><IconDeviceDesktop size={16} /></ThemeIcon>
                    <Text fw={600}>Default session config</Text>
                  </Group>
                  <ScrollArea type="auto" h={260}>
                    <Code block style={{ whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(browser.defaultSessionConfig ?? {}, null, 2)}
                    </Code>
                  </ScrollArea>
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="playground" pt="md">
          <Stack gap="md">
            <Paper withBorder p="md" radius="lg">
              <Group justify="space-between" wrap="wrap">
                <Group gap="xs">
                  <TextInput
                    placeholder="Search by name, key, URL..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.currentTarget.value)}
                    style={{ minWidth: 220 }}
                    size="xs"
                  />
                  <Group gap={4}>
                    {['all', 'running', 'idle', 'pending', 'closed', 'expired', 'errored'].map((s) => (
                      <Badge
                        key={s}
                        variant={statusFilter === s ? 'filled' : 'light'}
                        color={s === 'all' ? 'gray' : statusColor(s)}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setStatusFilter(s)}
                      >
                        {s}
                      </Badge>
                    ))}
                  </Group>
                </Group>
                <Button leftSection={<IconPlus size={14} />} onClick={createHandlers.open} size="xs">
                  New session
                </Button>
              </Group>
            </Paper>

            <Paper withBorder p="md" radius="lg">
              {filteredSessions.length === 0 ? (
                <Text c="dimmed" ta="center" py="xl">No sessions yet.</Text>
              ) : (
                <Table highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th>Key</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>URL</Table.Th>
                      <Table.Th>Last activity</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {filteredSessions.map((s) => (
                      <Table.Tr key={s.id}>
                        <Table.Td>{s.name || '—'}</Table.Td>
                        <Table.Td><Code>{s.sessionKey}</Code></Table.Td>
                        <Table.Td><Badge color={statusColor(s.status)} variant="light">{s.status}</Badge></Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed" lineClamp={1} maw={260}>{s.currentUrl ?? '—'}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">{formatDate(s.lastActivityAt)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4} justify="flex-end">
                            <Tooltip label="Open live preview">
                              <ActionIcon variant="light" onClick={() => { setDrawerSession(s); drawerHandlers.open(); }}>
                                <IconCamera size={14} />
                              </ActionIcon>
                            </Tooltip>
                            {s.status !== 'closed' && s.status !== 'expired' && (
                              <Tooltip label="Close session">
                                <ActionIcon variant="light" color="orange" onClick={() => handleCloseSession(s)}>
                                  <IconX size={14} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                            <Tooltip label="Delete session">
                              <ActionIcon variant="light" color="red" onClick={() => handleDeleteSession(s)}>
                                <IconTrash size={14} />
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
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="usage" pt="md">
          <BrowserUsagePanel browser={browser} />
        </Tabs.Panel>
      </Tabs>

      <Modal opened={editOpened} onClose={editHandlers.close} title="Edit Browser" size="md">
        <form onSubmit={editForm.onSubmit(handleEditSubmit)}>
          <Stack>
            <TextInput label="Name" required {...editForm.getInputProps('name')} />
            <Textarea label="Description" autosize minRows={2} {...editForm.getInputProps('description')} />
            <TextInput label="Default model key" {...editForm.getInputProps('defaultModelKey')} />
            <TextInput label="Artifact bucket key" {...editForm.getInputProps('artifactBucketKey')} />
            <Switch
              label="Active"
              checked={editForm.values.status === 'active'}
              onChange={(e) => editForm.setFieldValue('status', e.currentTarget.checked ? 'active' : 'disabled')}
            />
            <Group justify="flex-end">
              <Button variant="subtle" onClick={editHandlers.close} disabled={saving}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal opened={createOpened} onClose={createHandlers.close} title="New session" size="md">
        <Stack>
          <TextInput label="Name (optional)" {...sessionForm.getInputProps('name')} />
          <TextInput label="Initial URL (optional)" placeholder="https://example.com" {...sessionForm.getInputProps('url')} />
          <TextInput label="Artifact bucket override (optional)" {...sessionForm.getInputProps('artifactBucketKey')} />
          <TextInput label="Allowed hosts (comma separated)" {...sessionForm.getInputProps('allowList')} />
          <TextInput label="Blocked hosts (comma separated)" {...sessionForm.getInputProps('blockList')} />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={createHandlers.close} disabled={creating}>Cancel</Button>
            <Button onClick={handleCreateSession} loading={creating}>Create</Button>
          </Group>
        </Stack>
      </Modal>

      <SessionPreviewDrawer
        session={drawerSession}
        opened={drawerOpened && !!drawerSession}
        onClose={() => { drawerHandlers.close(); setDrawerSession(null); }}
      />

      <McpUrlModal
        opened={mcpOpened}
        onClose={mcpHandlers.close}
        browserKey={browser?.key ?? ''}
      />
    </DetailShell>
  );
}

function McpUrlModal({ opened, onClose, browserKey }: { opened: boolean; onClose: () => void; browserKey: string }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const sseUrl = `${origin}/api/client/v1/browser/${browserKey}/mcp/sse`;
  const messageUrl = `${origin}/api/client/v1/browser/${browserKey}/mcp/message?sessionId=<sessionId>`;

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notifications.show({ color: 'teal', title: 'Copied', message: `${label} copied to clipboard` });
    } catch {
      notifications.show({ color: 'red', title: 'Copy failed', message: 'Clipboard not available' });
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Browser MCP endpoint" size="lg">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Connect any MCP-compatible client (e.g. an external agent runtime) to this browser using
          the URLs below. Authenticate with an API token from this project as
          <Text component="span" ff="monospace" size="xs"> Authorization: Bearer &lt;API_TOKEN&gt;</Text>.
          Each SSE connection owns its own browser session for its lifetime.
        </Text>

        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">SSE endpoint</Text>
            <Tooltip label="Copy">
              <ActionIcon variant="subtle" size="sm" onClick={() => copy(sseUrl, 'SSE URL')}>
                <IconCopy size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{sseUrl}</Code>
        </Stack>

        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">JSON-RPC message endpoint</Text>
            <Tooltip label="Copy">
              <ActionIcon variant="subtle" size="sm" onClick={() => copy(messageUrl, 'Message URL')}>
                <IconCopy size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{messageUrl}</Code>
          <Text size="xs" c="dimmed">
            The <Text component="span" ff="monospace" size="xs">sessionId</Text> is provided by
            the SSE <Text component="span" ff="monospace" size="xs">endpoint</Text> event.
          </Text>
        </Stack>

        <Alert color="grape" variant="light" icon={<IconPlug size={16} />}>
          Tools exposed: <Text component="span" ff="monospace" size="xs">browser_navigate, browser_click, browser_hover, browser_type, browser_press, browser_wait, browser_snapshot, browser_extract, browser_screenshot, browser_close</Text>.
          All calls are scoped to this browser and logged under its sessions.
        </Alert>

        <Group justify="flex-end">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Stack gap={2}>
        <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
        <Text fw={700} size="xl" c={accent}>{value}</Text>
      </Stack>
    </Paper>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" align="center">
      <Text size="sm" c="dimmed">{label}</Text>
      <div>{value}</div>
    </Group>
  );
}

function SessionPreviewDrawer({
  session,
  opened,
  onClose,
}: {
  session: BrowserSessionView | null;
  opened: boolean;
  onClose: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [polling, setPolling] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!opened || !session?.sessionKey || !polling) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/browser/sessions/${session.sessionKey}/screenshot/live`, { cache: 'no-store' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setImgUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      } catch {
        // ignore
      }
    };
    tick();
    intervalRef.current = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [opened, session?.sessionKey, polling]);

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title={session?.name || session?.sessionKey || 'Session'}>
      {session && (
        <Stack gap="md">
          <Group justify="space-between">
            <Group gap="xs">
              <Code>{session.sessionKey}</Code>
              <Badge variant="light">{session.status}</Badge>
            </Group>
            <Switch checked={polling} onChange={(e) => setPolling(e.currentTarget.checked)} label="Live preview" />
          </Group>
          <ScrollArea h={520}>
            {imgUrl ? (
              <Image src={imgUrl} alt="Live preview" fit="contain" />
            ) : (
              <Group justify="center" py="md"><Loader size="sm" /></Group>
            )}
          </ScrollArea>
        </Stack>
      )}
    </Drawer>
  );
}

function BrowserUsagePanel({ browser }: { browser: BrowserView }) {
  const apiBase = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const sessionPayload = {
    browserId: browser.id,
    name: 'manual-session',
    config: browser.defaultSessionConfig ?? {
      headless: true,
      viewport: { width: 1440, height: 900 },
    },
  };

  const sdk = `import { ConsoleClient } from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: process.env.COGNIPEER_API_KEY!,
  baseURL: '${apiBase}',
});

const browser = await client.browsers.get('${browser.id}');

const session = await client.browserSessions.create({
  browserId: browser.id,
  name: 'manual-session',
});

await client.browserSessions.action(session.sessionKey, {
  type: 'goto',
  url: 'https://example.com',
});

const snapshot = await client.browserSessions.snapshot(session.sessionKey);
console.log(snapshot.ariaSnapshot);

await client.browserSessions.close(session.sessionKey);`;

  const curlCreateSession = `curl -X POST '${apiBase}/api/client/v1/browser/sessions' \\
  -H 'Authorization: Bearer <API_TOKEN>' \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(sessionPayload, null, 2)}'`;

  const curlAction = `curl -X POST '${apiBase}/api/client/v1/browser/sessions/<sessionKey>/actions' \\
  -H 'Authorization: Bearer <API_TOKEN>' \\
  -H 'Content-Type: application/json' \\
  -d '{
  "type": "goto",
  "url": "https://example.com"
}'`;

  const curlSnapshot = `curl '${apiBase}/api/client/v1/browser/sessions/<sessionKey>/snapshot' \\
  -H 'Authorization: Bearer <API_TOKEN>'`;

  return (
    <Stack gap="md">
      <Alert color="blue" icon={<IconInfoCircle size={16} />}>
        Use this browser as the parent profile for sessions. Pass <Code>browserId</Code> when creating sessions and filter by it when listing.
      </Alert>

      <Paper withBorder p="lg" radius="lg">
        <Stack gap="sm">
          <Group gap="xs"><IconCode size={16} /><Text fw={600}>Console SDK</Text></Group>
          <ScrollArea type="auto"><Code block style={{ whiteSpace: 'pre-wrap', minWidth: 720 }}>{sdk}</Code></ScrollArea>
        </Stack>
      </Paper>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Paper withBorder p="lg" radius="lg">
          <Stack gap="sm">
            <Text fw={600}>Create a session</Text>
            <ScrollArea type="auto"><Code block style={{ whiteSpace: 'pre-wrap', minWidth: 420 }}>{curlCreateSession}</Code></ScrollArea>
            <Text size="xs" c="dimmed">POST /api/client/v1/browser/sessions</Text>
          </Stack>
        </Paper>
        <Paper withBorder p="lg" radius="lg">
          <Stack gap="sm">
            <Text fw={600}>Drive an action</Text>
            <ScrollArea type="auto"><Code block style={{ whiteSpace: 'pre-wrap', minWidth: 420 }}>{curlAction}</Code></ScrollArea>
            <Text size="xs" c="dimmed">POST /api/client/v1/browser/sessions/:sessionKey/actions</Text>
          </Stack>
        </Paper>
        <Paper withBorder p="lg" radius="lg">
          <Stack gap="sm">
            <Text fw={600}>Get an aria snapshot</Text>
            <ScrollArea type="auto"><Code block style={{ whiteSpace: 'pre-wrap', minWidth: 420 }}>{curlSnapshot}</Code></ScrollArea>
            <Text size="xs" c="dimmed">GET /api/client/v1/browser/sessions/:sessionKey/snapshot</Text>
          </Stack>
        </Paper>
        <Paper withBorder p="lg" radius="lg">
          <Stack gap="sm">
            <Text fw={600}>List sessions for this browser</Text>
            <ScrollArea type="auto">
              <Code block style={{ whiteSpace: 'pre-wrap', minWidth: 420 }}>{`curl '${apiBase}/api/client/v1/browser/sessions?browserId=${browser.id}' \\
  -H 'Authorization: Bearer <API_TOKEN>'`}</Code>
            </ScrollArea>
            <Text size="xs" c="dimmed">GET /api/client/v1/browser/sessions?browserId=...</Text>
          </Stack>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p="md" radius="md">
        <Group gap="xs"><Title order={6}>Tip</Title></Group>
        <Text size="sm" c="dimmed" mt={4}>
          For autonomous flows that summarize or take actions across multiple pages, use a Browser Agent built on top of this profile.
        </Text>
      </Paper>
    </Stack>
  );
}
