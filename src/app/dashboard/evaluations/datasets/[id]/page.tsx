'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Modal, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPencil, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import CreateDatasetModal from '@/components/evaluations/CreateDatasetModal';
import type { EvalDatasetItemView, EvalDatasetView, ModelOption } from '@/components/evaluations/types';

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

  const load = async () => {
    if (!id) return;
    const res = await fetch(`/api/evaluation/datasets/${id}`, { cache: 'no-store' });
    if (res.status === 404) { setNotFound(true); return; }
    if (res.ok) setDataset((await res.json()).dataset ?? null);
  };

  useEffect(() => {
    (async () => {
      try {
        await load();
        const mRes = await fetch('/api/models?category=llm', { cache: 'no-store' });
        if (mRes.ok) setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
      key: 'expected',
      label: 'Expected',
      render: (it) => {
        const ref = (it.expected as { reference?: string; mustContain?: string[] } | undefined);
        const text = ref?.reference ?? (ref?.mustContain ? `contains: ${ref.mustContain.join(', ')}` : '');
        const short = text.length > 70 ? `${text.slice(0, 70)}…` : text;
        return <span className="ds-muted" style={{ fontSize: 12 }} title={text}>{short || '—'}</span>;
      },
    },
    { key: 'tags', label: 'Tags', render: (it) => <span className="ds-faint" style={{ fontSize: 12 }}>{(it.tags ?? []).join(', ') || '—'}</span> },
  ];

  const items: EvalDatasetItemView[] = Array.isArray(dataset?.items) ? dataset.items : [];
  const itemsCtl = useTableControls(items, {
    searchText: (it) =>
      `${it.id} ${it.input.map((m) => m.content).join(' ')} ${(it.tags ?? []).join(' ')}`,
    searchPlaceholder: 'Filter by id, input, or tag…',
  });

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

      <Paper withBorder radius="md" p="lg" maw={620} mb="lg">
        <Stack gap="sm">
          <Row label="Name" value={dataset.name} />
          <Row label="Key" value={dataset.key} mono />
          <Row label="Source" value={dataset.source} />
          <Row label="Items" value={dataset.items.length} />
          <Row label="Description" value={dataset.description || '—'} />
        </Stack>
      </Paper>

      <Text fw={600} size="sm" mb="xs">Test cases</Text>
      <DataGrid<EvalDatasetItemView>
        records={itemsCtl.records}
        rowKey={(it) => it.id}
        columns={itemColumns}
        search={itemsCtl.search}
        pagination={itemsCtl.pagination}
        footerLeft={itemsCtl.footerLeft('items')}
        empty={{ title: 'No items', description: 'This dataset has no test cases yet — edit it to add some.' }}
      />

      <CreateDatasetModal
        opened={editOpen}
        editing={dataset}
        models={models}
        onClose={() => setEditOpen(false)}
        onCreated={(d) => { setDataset(d); setEditOpen(false); }}
      />

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete dataset" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{dataset.name}</strong>? This cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={() => void onDelete()}>Delete</Button>
        </Group>
      </Modal>
    </PageContainer>
  );
}
