'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Group,
  Modal,
  Stack,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconEye,
  IconPlus,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import type {
  BrowserSessionView,
  BrowserView,
} from '@/lib/services/browser';

interface CreateForm {
  name: string;
  description: string;
  artifactBucketKey: string;
  defaultModelKey: string;
}

interface RowMetrics {
  sessions: number;
  activeSessions: number;
}

export default function BrowsersListPage() {
  const router = useRouter();
  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BrowserView | null>(null);

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
      const sessionsData = sessionsRes.ok
        ? await sessionsRes.json()
        : { sessions: [] };
      setBrowsers(browsersData.browsers ?? []);
      setSessions(sessionsData.sessions ?? []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    const activeSessions = sessions.filter(
      (s) => s.status === 'running' || s.status === 'idle',
    ).length;
    return {
      total: browsers.length,
      active,
      disabled,
      sessions: sessions.length,
      activeSessions,
    };
  }, [browsers, sessions]);

  const filtered = useMemo(() => {
    return browsers.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !b.name.toLowerCase().includes(q) &&
          !b.key.toLowerCase().includes(q) &&
          !(b.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [browsers, statusFilter, query]);

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
      notifications.show({
        color: 'teal',
        title: 'Created',
        message: 'Browser created',
      });
      createHandlers.close();
      form.reset();
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/browser/browsers/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to delete');
      }
      notifications.show({
        color: 'teal',
        title: 'Deleted',
        message: 'Browser removed',
      });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  const columns: DataGridColumn<BrowserView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (b) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {b.name}
          </span>
          {b.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {b.description.length > 60
                ? `${b.description.slice(0, 60)}…`
                : b.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {b.key}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'key',
      label: 'Key',
      render: (b) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {b.key}
        </span>
      ),
    },
    {
      key: 'model',
      label: 'Default model',
      render: (b) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {b.defaultModelKey ?? '—'}
        </span>
      ),
    },
    {
      key: 'sessions',
      label: 'Sessions',
      render: (b) => {
        const m = metricsById.get(b.id) ?? { sessions: 0, activeSessions: 0 };
        return (
          <div className="ds-row ds-gap-xs">
            <span className="ds-badge">{m.sessions}</span>
            {m.activeSessions > 0 ? (
              <span className="ds-badge ds-badge-ok">{m.activeSessions} live</span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (b) => (
        <StatusBadge status={b.status === 'active' ? 'active' : 'paused'} />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Browsers"
        title="Browsers"
        subtitle="Headless browser profiles. Create a browser, then add sessions or run agents on top of it."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={createHandlers.open}
          >
            Create browser
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Browsers"
          icon={<IconWorld size={14} stroke={1.7} />}
          value={summary.total}
        />
        <StatTile label="Active" value={summary.active} />
        <StatTile label="Disabled" value={summary.disabled} />
        <StatTile
          label="Sessions"
          value={summary.sessions}
          delta={`${summary.activeSessions} live`}
        />
      </div>

      <DataGrid<BrowserView>
        records={filtered}
        loading={loading}
        rowKey={(b) => b.id}
        onRowClick={(b) => router.push(`/dashboard/browser/${b.id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search by name, key, description…',
        }}
        filters={[
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by status',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ]}
        onRefresh={load}
        refreshing={refreshing}
        empty={{
          icon: <IconWorld size={26} stroke={1.7} />,
          title: 'No browsers yet',
          description:
            'Create your first browser profile to start running automation sessions.',
          primaryAction: {
            label: 'Create your first browser',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: createHandlers.open,
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${browsers.length} browsers`}
        rowActions={(b) => [
          {
            id: 'open',
            label: 'Open browser',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/browser/${b.id}`),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(b),
          },
        ]}
      />

      <Modal
        opened={createOpened}
        onClose={createHandlers.close}
        title="Create browser"
        size="md"
      >
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack>
            <TextInput label="Name" required {...form.getInputProps('name')} />
            <Textarea
              label="Description"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
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
              <Button
                variant="subtle"
                onClick={createHandlers.close}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" loading={creating}>
                Create
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete browser"
        centered
        size="sm"
      >
        <Stack gap="md">
          <span>
            Delete browser <strong>{deleteTarget?.name}</strong>? Sessions and
            agents must be removed first.
          </span>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={confirmDelete}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </PageContainer>
  );
}
