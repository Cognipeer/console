'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Group, Loader, Modal, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import CreateDatasetModal from '@/components/evaluations/CreateDatasetModal';
import DatasetItemEditor from '@/components/evaluations/DatasetItemEditor';
import { summarizeItem } from '@/components/evaluations/datasetItemHelpers';
import type { EvalDatasetItemView, EvalDatasetView, ModelOption } from '@/components/evaluations/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" style={{ minWidth: 140 }}>{label}</Text>
      <Text size="sm" className={mono ? 'ds-mono' : undefined} style={{ textAlign: 'right' }}>{value}</Text>
    </Group>
  );
}

export default function EvaluationDatasetDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [dataset, setDataset] = useState<EvalDatasetView | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Items are paginated server-side — datasets can hold thousands of items.
  const [items, setItems] = useState<EvalDatasetItemView[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Per-item editor / delete state.
  const [itemEditorOpen, setItemEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<EvalDatasetItemView | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<EvalDatasetItemView | null>(null);
  const [deletingItem, setDeletingItem] = useState(false);

  const loadDataset = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/evaluation/datasets/${id}`, { cache: 'no-store' });
    if (res.status === 404) { setNotFound(true); return; }
    if (res.ok) setDataset((await res.json()).dataset ?? null);
  }, [id]);

  const loadItems = useCallback(async (signal?: AbortSignal) => {
    if (!id) return;
    setItemsLoading(true);
    setItemsError(null);
    try {
      const query = new URLSearchParams();
      query.set('limit', String(pageSize));
      query.set('skip', String((page - 1) * pageSize));
      if (debouncedSearch) query.set('search', debouncedSearch);
      const res = await fetch(`/api/evaluation/datasets/${id}/items?${query.toString()}`, {
        cache: 'no-store',
        signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setItemsError((data as { error?: string }).error || `Failed to load items (${res.status})`);
        return;
      }
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotalItems(typeof data.total === 'number' ? data.total : 0);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setItemsError(err instanceof Error ? err.message : 'Failed to load items');
    } finally {
      if (!signal?.aborted) setItemsLoading(false);
    }
  }, [id, page, pageSize, debouncedSearch]);

  useEffect(() => {
    (async () => {
      try {
        await loadDataset();
        const mRes = await fetch('/api/models?category=llm', { cache: 'no-store' });
        if (mRes.ok) setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadDataset]);

  useEffect(() => {
    const controller = new AbortController();
    void loadItems(controller.signal);
    return () => controller.abort();
  }, [loadItems]);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Clamp the page when the item count shrinks (e.g. after deleting the last
  // item of the final page) so the user is never stranded on an empty page.
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(totalItems / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [totalItems, pageSize, page]);

  const refresh = async () => {
    await Promise.all([loadDataset(), loadItems()]);
  };

  const onDelete = async () => {
    if (!dataset) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/evaluation/datasets/${dataset.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${dataset.name}" was deleted`, color: 'red' });
      router.push('/dashboard/evaluations/datasets');
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
      setDeleting(false);
    }
  };

  const onSaveItem = async (item: EvalDatasetItemView) => {
    if (!dataset) return;
    setSavingItem(true);
    try {
      const res = editingItem
        ? await fetch(`/api/evaluation/datasets/${dataset.id}/items/${encodeURIComponent(editingItem.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: item.input,
              expected: item.expected ?? null,
              tools: item.tools ?? null,
              toolResults: item.toolResults ?? null,
              tags: item.tags ?? null,
            }),
          })
        : await fetch(`/api/evaluation/datasets/${dataset.id}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [item] }),
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Failed to save item');
      }
      notifications.show({ title: editingItem ? 'Item updated' : 'Item added', message: `"${item.id}"`, color: 'teal' });
      setItemEditorOpen(false);
      setEditingItem(null);
      await refresh();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to save item', color: 'red' });
    } finally {
      setSavingItem(false);
    }
  };

  const onDeleteItem = async () => {
    if (!itemToDelete || !dataset) return;
    setDeletingItem(true);
    try {
      const res = await fetch(
        `/api/evaluation/datasets/${dataset.id}/items/${encodeURIComponent(itemToDelete.id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Failed to delete item');
      }
      notifications.show({ title: 'Item deleted', message: `"${itemToDelete.id}" was removed`, color: 'red' });
      setItemToDelete(null);
      await refresh();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete item', color: 'red' });
    } finally {
      setDeletingItem(false);
    }
  };

  const openItem = (it: EvalDatasetItemView) => {
    setEditingItem(it);
    setItemEditorOpen(true);
  };
  const openNewItem = () => {
    setEditingItem(null);
    setItemEditorOpen(true);
  };

  const itemColumns: DataGridColumn<EvalDatasetItemView>[] = [
    { key: 'id', label: 'ID', render: (it) => <span className="ds-mono" style={{ fontSize: 12 }}>{it.id}</span> },
    {
      key: 'input',
      label: 'Input',
      render: (it) => {
        const user = it.input.find((m) => m.role === 'user')?.content ?? it.input[0]?.content ?? '';
        const short = user.length > 90 ? `${user.slice(0, 90)}…` : user;
        return <span title={user}>{short || '—'}</span>;
      },
    },
    {
      key: 'turns',
      label: 'Turns',
      align: 'right',
      width: 60,
      render: (it) => <span className="ds-mono" style={{ fontSize: 12 }}>{summarizeItem(it).turns}</span>,
    },
    {
      key: 'tools',
      label: 'Tools',
      align: 'right',
      width: 60,
      render: (it) => {
        const n = summarizeItem(it).tools;
        return <span className="ds-mono" style={{ fontSize: 12 }}>{n || '—'}</span>;
      },
    },
    {
      key: 'expected',
      label: 'Expected',
      render: (it) => {
        const s = summarizeItem(it);
        if (!s.hasReference && !s.hasExpectedToolCalls && !s.hasAssertions) {
          return <span className="ds-faint" style={{ fontSize: 12 }}>—</span>;
        }
        return (
          <Group gap={4} wrap="wrap">
            {s.hasReference ? <span className="ds-badge">reference</span> : null}
            {s.hasExpectedToolCalls ? <span className="ds-badge">tool calls</span> : null}
            {s.hasAssertions ? <span className="ds-badge">assertions</span> : null}
          </Group>
        );
      },
    },
    { key: 'tags', label: 'Tags', render: (it) => <span className="ds-faint" style={{ fontSize: 12 }}>{(it.tags ?? []).join(', ') || '—'}</span> },
  ];

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/evaluations/datasets')}>
      Back to datasets
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (notFound || !dataset) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Evaluations" title="Dataset not found" actions={backButton} />
        <Text c="dimmed" size="sm">This evaluation dataset could not be found.</Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Evaluations · Dataset"
        title={dataset.name}
        subtitle={<span>Dataset <span className="ds-mono">{dataset.key}</span> · <span className="ds-badge">{dataset.source}</span></span>}
        actions={
          <Group gap="xs">
            {backButton}
            <Button size="sm" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditOpen(true)}>Edit</Button>
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => setDeleteOpen(true)}>Delete</Button>
          </Group>
        }
      />

      {(() => {
        // Background-job failures (traffic snapshot / generation) must be
        // visible here — the wizard may long be closed when the job dies.
        const snap = dataset.metadata?.snapshot as { status?: string; error?: string } | undefined;
        const gen = dataset.metadata?.generation;
        const failure = snap?.status === 'failed'
          ? { title: 'Traffic snapshot failed', error: snap.error }
          : gen?.status === 'failed'
            ? { title: 'Dataset generation failed', error: gen.error }
            : null;
        return failure ? (
          <Alert color="red" variant="light" title={failure.title} mb="lg" maw={620}>
            {failure.error ?? 'No error detail was recorded.'}
          </Alert>
        ) : null;
      })()}

      <Paper withBorder radius="md" p="lg" maw={620} mb="lg">
        <Stack gap="sm">
          <Row label="Name" value={dataset.name} />
          <Row label="Key" value={dataset.key} mono />
          <Row label="Source" value={dataset.source} />
          <Row label="Items" value={dataset.itemCount} />
          <Row label="Description" value={dataset.description || '—'} />
        </Stack>
      </Paper>

      <Text fw={600} size="sm" mb="xs">Test cases</Text>
      {itemsError ? (
        <Alert color="red" variant="light" title="Failed to load items" mb="xs" maw={620}>
          {itemsError}{' '}
          <Button size="compact-xs" variant="subtle" onClick={() => void loadItems()}>
            Retry
          </Button>
        </Alert>
      ) : null}
      <DataGrid<EvalDatasetItemView>
        records={items}
        rowKey={(it) => it.id}
        columns={itemColumns}
        loading={itemsLoading}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Filter by id, input, or tag…',
        }}
        pagination={{
          page,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          total: totalItems,
          hasMore: page < totalPages,
        }}
        footerLeft={
          <Text size="xs" c="dimmed">
            {totalItems.toLocaleString()} item{totalItems === 1 ? '' : 's'}
            {debouncedSearch ? ' (filtered)' : ''}
          </Text>
        }
        onRowClick={openItem}
        rowActions={(it) => [
          { id: 'open', label: 'Open', icon: <IconPencil size={14} />, onClick: () => openItem(it) },
          { divider: true },
          { id: 'delete', label: 'Delete', color: 'red', icon: <IconTrash size={14} />, onClick: () => setItemToDelete(it) },
        ]}
        toolbarRight={
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={openNewItem}>
            Add item
          </Button>
        }
        empty={{
          title: debouncedSearch ? 'No matching items' : 'No items',
          description: debouncedSearch
            ? 'No test cases match this filter.'
            : 'This dataset has no test cases yet.',
          primaryAction: { label: 'Add item', icon: <IconPlus size={14} />, onClick: openNewItem },
        }}
      />

      <CreateDatasetModal
        opened={editOpen}
        editing={dataset}
        models={models}
        onClose={() => setEditOpen(false)}
        onCreated={(d) => { setDataset(d); setEditOpen(false); void loadItems(); }}
      />

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete dataset" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{dataset.name}</strong>? This cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={() => void onDelete()}>Delete</Button>
        </Group>
      </Modal>

      <DatasetItemEditor
        opened={itemEditorOpen}
        item={editingItem}
        idEditable={!editingItem}
        existingIds={items.map((it) => it.id)}
        // Unique by construction — a count-derived id collides as soon as any
        // item was ever deleted or the list is filtered (server enforces
        // uniqueness either way and the page surfaces the 409).
        suggestedId={`item-${Date.now().toString(36)}`}
        saving={savingItem}
        onClose={() => { setItemEditorOpen(false); setEditingItem(null); }}
        onSave={(item) => void onSaveItem(item)}
      />

      <Modal opened={itemToDelete !== null} onClose={() => setItemToDelete(null)} title="Delete item" centered size="sm">
        <Text size="sm" mb="lg">
          Delete item <span className="ds-mono">{itemToDelete?.id}</span>? This cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setItemToDelete(null)}>Cancel</Button>
          <Button color="red" loading={deletingItem} onClick={() => void onDeleteItem()}>Delete</Button>
        </Group>
      </Modal>
    </PageContainer>
  );
}
