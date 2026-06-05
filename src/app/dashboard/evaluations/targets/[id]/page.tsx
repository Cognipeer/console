'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Modal, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPencil, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import CreateTargetModal from '@/components/evaluations/CreateTargetModal';
import type { EvalTargetView, ModelOption } from '@/components/evaluations/types';

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" style={{ minWidth: 140 }}>{label}</Text>
      <Text size="sm" className={mono ? 'ds-mono' : undefined} style={{ textAlign: 'right' }}>{value}</Text>
    </Group>
  );
}

export default function EvaluationTargetDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [target, setTarget] = useState<EvalTargetView | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    if (!id) return;
    const res = await fetch(`/api/evaluation/targets/${id}`, { cache: 'no-store' });
    if (res.status === 404) { setNotFound(true); return; }
    if (res.ok) setTarget((await res.json()).target ?? null);
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
    if (!target) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/evaluation/targets/${target.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${target.name}" was deleted`, color: 'red' });
      router.push('/dashboard/evaluations');
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
      setDeleting(false);
    }
  };

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/evaluations')}>
      Back to evaluations
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (notFound || !target) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Evaluations" title="Target not found" actions={backButton} />
        <Text c="dimmed" size="sm">This evaluation target could not be found.</Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Evaluations · Target"
        title={target.name}
        subtitle={<span>Target <span className="ds-mono">{target.key}</span> · <span className="ds-badge ds-badge-info">{target.kind}</span></span>}
        actions={
          <Group gap="xs">
            {backButton}
            <Button size="sm" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditOpen(true)}>Edit</Button>
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => setDeleteOpen(true)}>Delete</Button>
          </Group>
        }
      />

      <Paper withBorder radius="md" p="lg" maw={620}>
        <Stack gap="sm">
          <Row label="Name" value={target.name} />
          <Row label="Key" value={target.key} mono />
          <Row label="Kind" value={target.kind} />
          <Row label={target.kind === 'agent' ? 'Agent' : 'Model'} value={target.modelKey ?? target.agentKey ?? '—'} mono />
          <Row label="Description" value={target.description || '—'} />
        </Stack>
      </Paper>

      <CreateTargetModal
        opened={editOpen}
        editing={target}
        models={models}
        onClose={() => setEditOpen(false)}
        onCreated={(t) => { setTarget(t); setEditOpen(false); }}
      />

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete target" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{target.name}</strong>? This cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={() => void onDelete()}>Delete</Button>
        </Group>
      </Modal>
    </PageContainer>
  );
}
