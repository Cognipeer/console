'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconRefresh, IconSearch, IconTrash, IconWorld } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import type { BrowserSessionView, BrowserView } from '@/lib/services/browser';

interface CreateForm {
  name: string;
  description: string;
  artifactBucketKey: string;
  defaultModelKey: string;
}

type StatusFilter = 'all' | 'active' | 'disabled';

interface RowMetrics {
  sessions: number;
  activeSessions: number;
}

export default function BrowsersListPage() {
  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);

  const form = useForm<CreateForm>({
    initialValues: { name: '', description: '', artifactBucketKey: '', defaultModelKey: '' },
    validate: { name: (v) => (v.trim().length < 2 ? 'Name is required' : null) },
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [browsersRes, sessionsRes] = await Promise.all([
        fetch('/api/browser/browsers', { cache: 'no-store' }),
        fetch('/api/browser/sessions', { cache: 'no-store' }),
      ]);
      if (!browsersRes.ok) throw new Error('Failed to load browsers');
      const browsersData = await browsersRes.json();
      const sessionsData = sessionsRes.ok ? await sessionsRes.json() : { sessions: [] };
      setBrowsers(browsersData.browsers ?? []);
      setSessions(sessionsData.sessions ?? []);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const metricsById = useMemo(() => {
    const map = new Map<string, RowMetrics>();
    for (const b of browsers) map.set(b.id, { sessions: 0, activeSessions: 0 });
    for (const s of sessions) {
      const m = map.get(s.browserId ?? '');
      if (!m) continue;
      m.sessions += 1;
      if (s.status === 'running' || s.status === 'idle') m.activeSessions += 1;
    }
    return map;
  }, [browsers, sessions]);

  const summary = useMemo(() => {
    const active = browsers.filter((b) => b.status === 'active').length;
    const disabled = browsers.filter((b) => b.status === 'disabled').length;
    const activeSessions = sessions.filter((s) => s.status === 'running' || s.status === 'idle').length;
    return {
      total: browsers.length,
      active,
      disabled,
      sessions: sessions.length,
      activeSessions,
    };
  }, [browsers, sessions]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return browsers.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (!term) return true;
      return (
        b.name.toLowerCase().includes(term) ||
        b.key.toLowerCase().includes(term) ||
        (b.description ?? '').toLowerCase().includes(term)
      );
    });
  }, [browsers, statusFilter, search]);

  async function handleCreate(values: CreateForm) {
    setCreating(true);
    try {
      const res = await fetch('/api/browser/browsers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          artifactBucketKey: values.artifactBucketKey.trim() || undefined,
          defaultModelKey: values.defaultModelKey.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to create');
      }
      notifications.show({ color: 'teal', title: 'Created', message: 'Browser created' });
      createHandlers.close();
      form.reset();
      await load();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this browser? Sessions and agents must be removed first.')) return;
    try {
      const res = await fetch(`/api/browser/browsers/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to delete');
      }
      notifications.show({ color: 'teal', title: 'Deleted', message: 'Browser removed' });
      await load();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    }
  }

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconWorld size={20} />}
        title="Browsers"
        subtitle="Headless browser profiles. Create a browser, then add sessions or run agents on top of it."
        actions={
          <Group gap="xs">
            <Tooltip label="Refresh">
              <ActionIcon variant="subtle" onClick={load} loading={refreshing}>
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Button leftSection={<IconPlus size={14} />} size="xs" onClick={createHandlers.open}>
              Create Browser
            </Button>
          </Group>
        }
      />

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Summary label="Browsers" value={summary.total} color="indigo" />
        <Summary label="Active" value={summary.active} color="teal" />
        <Summary label="Disabled" value={summary.disabled} color="gray" />
        <Summary label="Sessions" value={summary.sessions} hint={`${summary.activeSessions} live`} color="blue" />
      </SimpleGrid>

      <Paper withBorder p="md" radius="lg">
        <Group justify="space-between" wrap="wrap">
          <TextInput
            placeholder="Search by name, key, description..."
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            size="xs"
            style={{ minWidth: 280 }}
          />
          <SegmentedControl
            size="xs"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            data={[
              { label: 'All', value: 'all' },
              { label: 'Active', value: 'active' },
              { label: 'Disabled', value: 'disabled' },
            ]}
          />
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="lg">
        {loading ? (
          <Group justify="center" py="xl"><Loader /></Group>
        ) : filtered.length === 0 ? (
          <Stack align="center" py="xl">
            <Text c="dimmed">{browsers.length === 0 ? 'No browsers yet' : 'No browsers match your filter'}</Text>
            {browsers.length === 0 && (
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={createHandlers.open}>
                Create your first Browser
              </Button>
            )}
          </Stack>
        ) : (
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Key</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Default Model</Table.Th>
                <Table.Th>Sessions</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((b) => {
                const m = metricsById.get(b.id) ?? { sessions: 0, activeSessions: 0 };
                return (
                  <Table.Tr key={b.id}>
                    <Table.Td>
                      <Link href={`/dashboard/browser/${b.id}`} style={{ fontWeight: 500 }}>{b.name}</Link>
                      {b.description && <Text size="xs" c="dimmed" lineClamp={1}>{b.description}</Text>}
                    </Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{b.key}</Text></Table.Td>
                    <Table.Td>
                      <Badge color={b.status === 'active' ? 'teal' : 'gray'} variant="light">{b.status}</Badge>
                    </Table.Td>
                    <Table.Td><Text size="xs">{b.defaultModelKey ?? '—'}</Text></Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge variant="light" color="blue">{m.sessions}</Badge>
                        {m.activeSessions > 0 && <Badge variant="light" color="teal">{m.activeSessions} live</Badge>}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end">
                        <Tooltip label="Delete">
                          <ActionIcon variant="subtle" color="red" onClick={() => handleDelete(b.id)}>
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      <Modal opened={createOpened} onClose={createHandlers.close} title="Create Browser" size="md">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack>
            <TextInput label="Name" required {...form.getInputProps('name')} />
            <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
            <TextInput
              label="Default Model Key"
              description="Used as a default for browser agents under this browser"
              {...form.getInputProps('defaultModelKey')}
            />
            <TextInput
              label="Artifact Bucket Key"
              description="File bucket for screenshots and PDFs"
              {...form.getInputProps('artifactBucketKey')}
            />
            <Group justify="flex-end">
              <Button variant="subtle" onClick={createHandlers.close} disabled={creating}>Cancel</Button>
              <Button type="submit" loading={creating}>Create</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}

function Summary({ label, value, color, hint }: { label: string; value: number; color: string; hint?: string }) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Stack gap={2}>
        <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
        <Text fw={700} size="xl" c={color}>{value}</Text>
        {hint && <Text size="xs" c="dimmed">{hint}</Text>}
      </Stack>
    </Paper>
  );
}
