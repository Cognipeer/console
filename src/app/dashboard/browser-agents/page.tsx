'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  Select,
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
import { IconPlus, IconRefresh, IconRobot, IconSearch, IconTrash } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import type { BrowserAgentView, BrowserView } from '@/lib/services/browser';

interface CreateForm {
  browserId: string;
  name: string;
  description: string;
  modelKey: string;
  systemPrompt: string;
}

type StatusFilter = 'all' | 'active' | 'inactive' | 'draft';

export default function BrowserAgentsListPage() {
  const [agents, setAgents] = useState<BrowserAgentView[]>([]);
  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [browserFilter, setBrowserFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);

  const form = useForm<CreateForm>({
    initialValues: { browserId: '', name: '', description: '', modelKey: '', systemPrompt: '' },
    validate: {
      browserId: (v) => (!v ? 'Browser is required' : null),
      name: (v) => (v.trim().length < 2 ? 'Name is required' : null),
    },
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [agentsRes, browsersRes] = await Promise.all([
        fetch('/api/browser/agents', { cache: 'no-store' }),
        fetch('/api/browser/browsers', { cache: 'no-store' }),
      ]);
      if (!agentsRes.ok) throw new Error('Failed to load agents');
      const agentsData = await agentsRes.json();
      const browsersData = browsersRes.ok ? await browsersRes.json() : { browsers: [] };
      setAgents(agentsData.agents ?? []);
      setBrowsers(browsersData.browsers ?? []);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const browserById = useMemo(() => {
    const m = new Map<string, BrowserView>();
    for (const b of browsers) m.set(b.id, b);
    return m;
  }, [browsers]);

  const summary = useMemo(() => {
    const active = agents.filter((a) => a.status === 'active').length;
    const disabled = agents.filter((a) => a.status !== 'active').length;
    return { total: agents.length, active, disabled, browsers: browsers.length };
  }, [agents, browsers]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      if (browserFilter !== 'all' && a.browserId !== browserFilter) return false;
      if (!term) return true;
      return (
        a.name.toLowerCase().includes(term) ||
        a.key.toLowerCase().includes(term) ||
        (a.description ?? '').toLowerCase().includes(term)
      );
    });
  }, [agents, search, statusFilter, browserFilter]);

  async function handleCreate(values: CreateForm) {
    setCreating(true);
    try {
      const res = await fetch('/api/browser/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          browserId: values.browserId,
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          modelKey: values.modelKey.trim() || undefined,
          systemPrompt: values.systemPrompt.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to create');
      notifications.show({ color: 'teal', title: 'Created', message: 'Browser agent created' });
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
    if (!confirm('Delete this browser agent?')) return;
    try {
      const res = await fetch(`/api/browser/agents/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      notifications.show({ color: 'teal', title: 'Deleted', message: 'Agent removed' });
      await load();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: err instanceof Error ? err.message : 'Failed' });
    }
  }

  const browserOptions = browsers.map((b) => ({ value: b.id, label: b.name }));

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconRobot size={20} />}
        title="Browser Agents"
        subtitle="Autonomous web agents that drive a browser profile to complete tasks."
        actions={
          <Group gap="xs">
            <Tooltip label="Refresh">
              <ActionIcon variant="subtle" onClick={load} loading={refreshing}>
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Button leftSection={<IconPlus size={14} />} size="xs" onClick={createHandlers.open} disabled={browsers.length === 0}>
              Create Agent
            </Button>
          </Group>
        }
      />

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Summary label="Agents" value={summary.total} color="grape" />
        <Summary label="Active" value={summary.active} color="teal" />
        <Summary label="Inactive / Draft" value={summary.disabled} color="gray" />
        <Summary label="Across browsers" value={summary.browsers} color="indigo" />
      </SimpleGrid>

      <Paper withBorder p="md" radius="lg">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="xs">
            <TextInput
              placeholder="Search by name, key..."
              leftSection={<IconSearch size={14} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              size="xs"
              style={{ minWidth: 240 }}
            />
            <Select
              size="xs"
              placeholder="All browsers"
              value={browserFilter}
              onChange={(v) => setBrowserFilter(v ?? 'all')}
              data={[{ value: 'all', label: 'All browsers' }, ...browserOptions]}
              clearable={false}
              style={{ minWidth: 200 }}
            />
          </Group>
          <SegmentedControl
            size="xs"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            data={[
              { label: 'All', value: 'all' },
              { label: 'Active', value: 'active' },
              { label: 'Inactive', value: 'inactive' },
              { label: 'Draft', value: 'draft' },
            ]}
          />
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="lg">
        {loading ? (
          <Group justify="center" py="xl"><Loader /></Group>
        ) : filtered.length === 0 ? (
          <Stack align="center" py="xl">
            <Text c="dimmed">{agents.length === 0 ? 'No browser agents yet' : 'No agents match your filter'}</Text>
            {browsers.length === 0 && (
              <Button component={Link} href="/dashboard/browser" variant="light" size="xs">
                Create a Browser first
              </Button>
            )}
          </Stack>
        ) : (
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Key</Table.Th>
                <Table.Th>Browser</Table.Th>
                <Table.Th>Model</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((a) => {
                const b = browserById.get(a.browserId);
                return (
                  <Table.Tr key={a.id}>
                    <Table.Td>
                      <Link href={`/dashboard/browser-agents/${a.id}`} style={{ fontWeight: 500 }}>{a.name}</Link>
                      {a.description && <Text size="xs" c="dimmed" lineClamp={1}>{a.description}</Text>}
                    </Table.Td>
                    <Table.Td><Code>{a.key}</Code></Table.Td>
                    <Table.Td>
                      {b ? (
                        <Link href={`/dashboard/browser/${b.id}`} style={{ fontSize: 12 }}>{b.name}</Link>
                      ) : (
                        <Text size="xs" c="dimmed">{a.browserId}</Text>
                      )}
                    </Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{a.modelKey ?? '—'}</Text></Table.Td>
                    <Table.Td>
                      <Badge color={a.status === 'active' ? 'teal' : 'gray'} variant="light">{a.status}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end">
                        <Tooltip label="Delete">
                          <ActionIcon variant="subtle" color="red" onClick={() => handleDelete(a.id)}>
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

      <Modal opened={createOpened} onClose={createHandlers.close} title="Create Browser Agent" size="md">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack>
            <Select
              label="Browser"
              required
              placeholder="Pick a browser profile"
              data={browserOptions}
              {...form.getInputProps('browserId')}
            />
            <TextInput label="Name" required {...form.getInputProps('name')} />
            <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
            <TextInput label="Model key" placeholder="e.g. gpt-4o-mini" {...form.getInputProps('modelKey')} />
            <Textarea label="System prompt (optional)" autosize minRows={3} {...form.getInputProps('systemPrompt')} />
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

function Summary({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Stack gap={2}>
        <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
        <Text fw={700} size="xl" c={color}>{value}</Text>
      </Stack>
    </Paper>
  );
}
