'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource, ResourceUsageSection } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { IconArrowLeft, IconPencil, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import CreateTargetModal from '@/components/evaluations/CreateTargetModal';
import type { EvalTargetView, ModelOption } from '@/components/evaluations/types';

/** What a target's primary reference is called, per kind. */
const REFERENCE_LABEL: Record<EvalTargetView['kind'], string> = {
  agent: 'Agent',
  model: 'Model',
  rag: 'Knowledge Engine module',
  external: 'Endpoint',
};

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
  const deleteResource = useDeleteResource();
  const tq = useTranslations('common.confirm.qos');
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [target, setTarget] = useState<EvalTargetView | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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
    const done = await deleteResource({
      noun: tq('nouns.evaluationTarget'),
      name: target.name,
      type: 'evaluation-target',
      id: target.id,
      action: async () => {
        const res = await fetch(`/api/evaluation/targets/${target.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(tq('deleteFailed'));
      },
    });
    if (!done) return;
    notifications.show({ title: 'Deleted', message: `"${target.name}" was deleted`, color: 'red' });
    router.push('/dashboard/evaluations');
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
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => void onDelete()}>Delete</Button>
          </Group>
        }
      />

      <Paper withBorder radius="md" p="lg" maw={620}>
        <Stack gap="sm">
          <Row label="Name" value={target.name} />
          <Row label="Key" value={target.key} mono />
          <Row label="Kind" value={target.kind} />
          <Row label={REFERENCE_LABEL[target.kind]} value={target.modelKey ?? target.agentKey ?? target.ragModuleKey ?? '—'} mono />
          {target.kind === 'rag' && (
            <>
              <Row label="Top K" value={target.retrievalTopK ?? 'module default'} />
              <Row label="Minimum score" value={target.retrievalMinScore ?? 'module default'} />
            </>
          )}
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


      <div style={{ marginTop: 16 }}>
        <ResourceUsageSection type="evaluation-target" id={target.id} />
      </div>
    </PageContainer>
  );
}
