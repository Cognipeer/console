'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Group,
  Modal,
  Stack,
  Textarea,
  TextInput,
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
import type { CrawlerView } from '@/lib/services/crawler';

interface CreateForm {
  name: string;
  description: string;
}

export default function CrawlersListPage() {
  const router = useRouter();
  const [crawlers, setCrawlers] = useState<CrawlerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CrawlerView | null>(null);

  const form = useForm<CreateForm>({
    initialValues: { name: '', description: '' },
    validate: {
      name: (v) => (v.trim().length < 2 ? 'Name is required' : null),
    },
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/crawler/crawlers', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load crawlers');
      const data = await res.json();
      setCrawlers(data.crawlers ?? []);
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

  const summary = useMemo(() => {
    const active = crawlers.filter((c) => c.status === 'active').length;
    const disabled = crawlers.filter((c) => c.status === 'disabled').length;
    const withRag = crawlers.filter((c) => c.rag?.enabled).length;
    return { total: crawlers.length, active, disabled, withRag };
  }, [crawlers]);

  const filtered = useMemo(() => {
    return crawlers.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !c.name.toLowerCase().includes(q) &&
          !c.key.toLowerCase().includes(q) &&
          !(c.description ?? '').toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [crawlers, statusFilter, query]);

  async function handleCreate(values: CreateForm) {
    setCreating(true);
    try {
      const res = await fetch('/api/crawler/crawlers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to create');
      }
      notifications.show({ color: 'teal', title: 'Created', message: 'Crawler created' });
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
      const res = await fetch(`/api/crawler/crawlers/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ color: 'teal', title: 'Deleted', message: 'Crawler removed' });
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

  const columns: DataGridColumn<CrawlerView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (c) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {c.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{c.key}</span>
        </div>
      ),
    },
    {
      key: 'urls',
      label: 'URLs',
      render: (c) => {
        const count = c.seeds?.length ?? 0;
        return (
          <span className="ds-badge">{count} URL{count === 1 ? '' : 's'}</span>
        );
      },
    },
    {
      key: 'engine',
      label: 'Engine',
      render: (c) => <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>{c.engine}</span>,
    },
    {
      key: 'depth',
      label: 'Depth × pages',
      render: (c) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {c.maxDepth} × {c.maxPages === 0 ? '∞' : c.maxPages}
        </span>
      ),
    },
    {
      key: 'rag',
      label: 'RAG',
      render: (c) =>
        c.rag?.enabled ? (
          <span className="ds-badge ds-badge-ok">{c.rag.ragModuleKey}</span>
        ) : (
          <span className="ds-faint">—</span>
        ),
    },
    {
      key: 'webhook',
      label: 'Webhook',
      render: (c) =>
        c.webhook?.url ? (
          <span className="ds-badge ds-badge-ok">on</span>
        ) : (
          <span className="ds-faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (c) => (
        <StatusBadge status={c.status === 'active' ? 'active' : 'paused'} />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Data · Crawlers"
        title="Crawlers"
        subtitle="Define web crawlers that fetch pages, convert to markdown and optionally feed your knowledge engine."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={createHandlers.open}
          >
            Create crawler
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Crawlers"
          icon={<IconWorld size={14} stroke={1.7} />}
          value={summary.total}
        />
        <StatTile label="Active" value={summary.active} />
        <StatTile label="Disabled" value={summary.disabled} />
        <StatTile label="With RAG" value={summary.withRag} />
      </div>

      <DataGrid<CrawlerView>
        records={filtered}
        loading={loading}
        rowKey={(c) => c.id}
        onRowClick={(c) => router.push(`/dashboard/crawler/${c.id}`)}
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
          title: 'No crawlers yet',
          description: 'Create your first crawler to start ingesting websites into markdown.',
          primaryAction: {
            label: 'Create your first crawler',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: createHandlers.open,
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${crawlers.length} crawlers`}
        rowActions={(c) => [
          {
            id: 'open',
            label: 'Open crawler',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/crawler/${c.id}`),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(c),
          },
        ]}
      />

      <Modal
        opened={createOpened}
        onClose={createHandlers.close}
        title="Create crawler"
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
            <span className="ds-faint" style={{ fontSize: 12 }}>
              The crawler is a configuration container. You will add URLs and
              tune engine / HTTP / RAG / webhook on the detail page after
              creation.
            </span>
            <Group justify="flex-end">
              <Button
                variant="subtle"
                onClick={createHandlers.close}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" loading={creating}>Create</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete crawler"
        centered
        size="sm"
      >
        <Stack gap="md">
          <span>
            Delete <strong>{deleteTarget?.name}</strong>? This also removes all
            past jobs and results.
          </span>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={confirmDelete}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </PageContainer>
  );
}
