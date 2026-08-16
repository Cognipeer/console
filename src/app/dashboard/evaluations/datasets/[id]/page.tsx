'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Group, Loader, Modal, Paper, Progress, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconCopy, IconPencil, IconPlus, IconTags, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import CloneDatasetModal, { type CloneDatasetPayload, type CloneDatasetResult } from '@/components/evaluations/CloneDatasetModal';
import CreateDatasetModal from '@/components/evaluations/CreateDatasetModal';
import DatasetItemEditor from '@/components/evaluations/DatasetItemEditor';
import LabelDatasetModal, { type LabelSelectionPayload } from '@/components/evaluations/LabelDatasetModal';
import LabelItemModal from '@/components/evaluations/LabelItemModal';
import LabelSummaryPanel, { type LabelFilter } from '@/components/evaluations/LabelSummaryPanel';
import { summarizeItem } from '@/components/evaluations/datasetItemHelpers';
import type { AnalysisDefinitionView, AnalysisRunView } from '@/components/analysis/types';
import type {
  EvalDatasetItemView,
  EvalDatasetView,
  EvalLabelSummaryView,
  ModelOption,
} from '@/components/evaluations/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100];
/** How often the in-flight labeling run is polled. */
const LABEL_RUN_POLL_MS = 2500;

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

  // AI labeling: definitions to run, the distribution panel, the active segment
  // filter, the in-flight run, and the per-item human review modal.
  const [definitions, setDefinitions] = useState<AnalysisDefinitionView[]>([]);
  const [definitionsLoading, setDefinitionsLoading] = useState(true);
  const [labelSummary, setLabelSummary] = useState<EvalLabelSummaryView | null>(null);
  const [labelSummaryTruncated, setLabelSummaryTruncated] = useState(false);
  const [labelFilter, setLabelFilter] = useState<LabelFilter | null>(null);
  const [labelModalOpen, setLabelModalOpen] = useState(false);
  const [cloneModalOpen, setCloneModalOpen] = useState(false);
  const [labelRun, setLabelRun] = useState<AnalysisRunView | null>(null);
  const [labelingItem, setLabelingItem] = useState<EvalDatasetItemView | null>(null);
  const [savingLabels, setSavingLabels] = useState(false);

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
      if (labelFilter) {
        query.set('label', labelFilter.key);
        query.set('labelValue', labelFilter.value);
      }
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
  }, [id, page, pageSize, debouncedSearch, labelFilter]);

  const loadLabelSummary = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/evaluation/datasets/${id}/labels`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setLabelSummary(data.summary ?? null);
    setLabelSummaryTruncated(!!data.truncated);
  }, [id]);

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

  // Label definitions + the current distribution. Both are read-only context
  // for the labeling controls, so a failure here must not block the page.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/analysis/definitions', { cache: 'no-store' });
        if (res.ok) setDefinitions((await res.json()).definitions ?? []);
      } finally {
        setDefinitionsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    void loadLabelSummary();
  }, [loadLabelSummary]);

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

  // Selecting a segment re-queries from the first page.
  useEffect(() => { setPage(1); }, [labelFilter]);

  const refresh = async () => {
    await Promise.all([loadDataset(), loadItems(), loadLabelSummary()]);
  };

  // ── Labeling run progress ────────────────────────────────────────────
  // The run handle is parked on the dataset, so a reload picks the banner back
  // up instead of leaving a background job invisible.
  const activeLabelRunId = labelRun?.id ?? dataset?.metadata?.labeling?.runId ?? null;
  const labelRunSettled = labelRun?.status === 'completed' || labelRun?.status === 'failed';
  const notifiedRunRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeLabelRunId || labelRunSettled) return;
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/analysis/runs/${activeLabelRunId}`, { cache: 'no-store' });
      if (!res.ok || cancelled) return;
      const run = (await res.json()).run as AnalysisRunView | undefined;
      if (!run || cancelled) return;
      setLabelRun(run);
      if (run.status !== 'completed' && run.status !== 'failed') return;
      if (notifiedRunRef.current !== run.id) {
        notifiedRunRef.current = run.id;
        notifications.show(
          run.status === 'completed'
            ? {
                title: 'Labeling finished',
                message: `${run.aggregate?.completed ?? run.progress.completed} item(s) labeled`,
                color: 'teal',
              }
            : { title: 'Labeling failed', message: run.error ?? 'The labeling run failed', color: 'red' },
        );
      }
      await Promise.all([loadItems(), loadLabelSummary(), loadDataset()]);
    };
    void tick();
    const timer = setInterval(() => void tick(), LABEL_RUN_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeLabelRunId, labelRunSettled, loadItems, loadLabelSummary, loadDataset]);

  const onStartLabeling = async (definitionKey: string, selection: LabelSelectionPayload): Promise<string | null> => {
    if (!dataset) return null;
    const res = await fetch(`/api/evaluation/datasets/${dataset.id}/label`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definitionKey, selection }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to start labeling');
    const run = (data as { run?: AnalysisRunView }).run ?? null;
    if (run) {
      notifiedRunRef.current = null;
      setLabelRun(run);
      notifications.show({ title: 'Labeling started', message: `${run.progress.total} item(s) queued`, color: 'teal' });
    }
    await loadDataset();
    return run?.id ?? null;
  };

  const onCloneDataset = async (payload: CloneDatasetPayload): Promise<CloneDatasetResult | null> => {
    if (!dataset) return null;
    const res = await fetch(`/api/evaluation/datasets/${dataset.id}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to clone dataset');
    const result = data as { dataset?: { id: string; name: string }; copied?: number };
    if (!result.dataset) return null;
    notifications.show({
      title: 'Dataset created',
      message: `"${result.dataset.name}" · ${result.copied ?? 0} item(s) copied`,
      color: 'teal',
    });
    router.push(`/dashboard/evaluations/datasets/${result.dataset.id}`);
    return { dataset: result.dataset, copied: result.copied ?? 0 };
  };

  const onSaveLabels = async (labels: Record<string, string>) => {
    if (!dataset || !labelingItem) return;
    setSavingLabels(true);
    try {
      const res = await fetch(
        `/api/evaluation/datasets/${dataset.id}/items/${encodeURIComponent(labelingItem.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels: Object.keys(labels).length > 0 ? labels : null }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Failed to save labels');
      }
      notifications.show({ title: 'Labels saved', message: `"${labelingItem.id}" is now human-labeled`, color: 'teal' });
      setLabelingItem(null);
      await Promise.all([loadItems(), loadLabelSummary()]);
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to save labels', color: 'red' });
    } finally {
      setSavingLabels(false);
    }
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
    {
      key: 'labels',
      label: 'Labels',
      render: (it) => {
        const entries = Object.entries(it.labels ?? {}).filter(([, v]) => v !== null && v !== '');
        if (entries.length === 0) return <span className="ds-faint" style={{ fontSize: 12 }}>—</span>;
        const human = it.labelMeta?.source === 'human';
        return (
          <Group gap={4} wrap="wrap">
            {entries.slice(0, 3).map(([key, value]) => (
              <span key={key} className="ds-badge" title={`${key}: ${String(value)}`}>
                {String(value)}
              </span>
            ))}
            {entries.length > 3 ? <span className="ds-faint" style={{ fontSize: 12 }}>+{entries.length - 3}</span> : null}
            {human ? <span className="ds-badge" title="Reviewed by a human">✓</span> : null}
          </Group>
        );
      },
    },
    { key: 'tags', label: 'Tags', render: (it) => <span className="ds-faint" style={{ fontSize: 12 }}>{(it.tags ?? []).join(', ') || '—'}</span> },
  ];

  const labelingDefinition = useMemo(() => {
    const key = labelingItem?.labelMeta?.definitionKey;
    return key ? definitions.find((d) => d.key === key) ?? null : null;
  }, [labelingItem, definitions]);

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
            <Button
              size="sm"
              variant="light"
              leftSection={<IconTags size={14} />}
              onClick={() => setLabelModalOpen(true)}
              disabled={dataset.itemCount === 0}
            >
              Label with AI
            </Button>
            <Button
              size="sm"
              variant="light"
              leftSection={<IconCopy size={14} />}
              onClick={() => setCloneModalOpen(true)}
              disabled={dataset.itemCount === 0}
            >
              Clone
            </Button>
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

      {labelRun && (labelRun.status === 'pending' || labelRun.status === 'running') ? (
        <Alert color="blue" variant="light" title="Labeling in progress" mb="lg" maw={620}>
          <Stack gap={6}>
            <Text size="sm">
              {labelRun.progress.completed + labelRun.progress.failed} of {labelRun.progress.total} item(s) processed
              {labelRun.progress.failed > 0 ? ` · ${labelRun.progress.failed} failed` : ''}
            </Text>
            <Progress
              value={labelRun.progress.total > 0
                ? ((labelRun.progress.completed + labelRun.progress.failed) / labelRun.progress.total) * 100
                : 0}
              size="sm"
              radius="sm"
              animated
            />
          </Stack>
        </Alert>
      ) : null}

      {labelSummary ? (
        <LabelSummaryPanel
          summary={labelSummary}
          truncated={labelSummaryTruncated}
          active={labelFilter}
          onSelect={setLabelFilter}
        />
      ) : null}

      <Group justify="space-between" align="baseline" mb="xs">
        <Text fw={600} size="sm">Test cases</Text>
        {labelFilter ? (
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              Filtered to <span className="ds-mono">{labelFilter.key} = {labelFilter.value}</span>
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={() => setLabelFilter(null)}>Clear</Button>
          </Group>
        ) : null}
      </Group>
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
          { id: 'labels', label: 'Edit labels', icon: <IconTags size={14} />, onClick: () => setLabelingItem(it) },
          { divider: true },
          { id: 'delete', label: 'Delete', color: 'red', icon: <IconTrash size={14} />, onClick: () => setItemToDelete(it) },
        ]}
        toolbarRight={
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={openNewItem}>
            Add item
          </Button>
        }
        empty={{
          title: debouncedSearch || labelFilter ? 'No matching items' : 'No items',
          description: debouncedSearch || labelFilter
            ? 'No test cases match this filter.'
            : 'This dataset has no test cases yet.',
          primaryAction: { label: 'Add item', icon: <IconPlus size={14} />, onClick: openNewItem },
        }}
      />

      <LabelDatasetModal
        opened={labelModalOpen}
        datasetName={dataset.name}
        itemCount={dataset.itemCount}
        labeledCount={labelSummary?.labeled ?? 0}
        definitions={definitions}
        definitionsLoading={definitionsLoading}
        onClose={() => setLabelModalOpen(false)}
        onRun={onStartLabeling}
      />

      <CloneDatasetModal
        opened={cloneModalOpen}
        datasetName={dataset.name}
        itemCount={dataset.itemCount}
        labelSummary={labelSummary}
        onClose={() => setCloneModalOpen(false)}
        onClone={onCloneDataset}
      />

      <LabelItemModal
        opened={labelingItem !== null}
        item={labelingItem}
        definition={labelingDefinition}
        saving={savingLabels}
        onClose={() => setLabelingItem(null)}
        onSave={(labels) => void onSaveLabels(labels)}
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
