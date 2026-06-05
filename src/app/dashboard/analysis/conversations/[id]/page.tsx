'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Code, Group, Loader, Modal, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type { AnalysisConversationView } from '@/components/analysis/types';

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

export default function AnalysisConversationDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [convo, setConvo] = useState<AnalysisConversationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const res = await fetch(`/api/analysis/conversations/${id}`, { cache: 'no-store' });
        if (res.status === 404) { setNotFound(true); return; }
        if (res.ok) setConvo((await res.json()).conversation ?? null);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const onDelete = async () => {
    if (!convo) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/analysis/conversations/${convo.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${convo.name || convo.key}" was deleted`, color: 'red' });
      router.push('/dashboard/analysis/conversations');
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
      setDeleting(false);
    }
  };

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/analysis/conversations')}>
      Back to conversations
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (notFound || !convo) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Analysis" title="Conversation not found" actions={backButton} />
        <Text c="dimmed" size="sm">This conversation could not be found.</Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Analysis · Conversation"
        title={convo.name || convo.key}
        subtitle={
          <span>
            <span className="ds-mono">{convo.key}</span> · <span className="ds-badge">{convo.source}</span>
            {' · '}{convo.transcript.length} turns · last analyzed {fmtDate(convo.lastAnalyzedAt)}
          </span>
        }
        actions={
          <Group gap="xs">
            {backButton}
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => setDeleteOpen(true)}>Delete</Button>
          </Group>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
        <Paper withBorder radius="md" p="lg">
          <Text fw={600} size="sm" mb="sm">Transcript</Text>
          <Stack gap="sm">
            {convo.transcript.map((m, i) => (
              <div key={i}>
                <Text size="xs" c="dimmed" fw={600} tt="uppercase">{m.role}</Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</Text>
              </div>
            ))}
          </Stack>
        </Paper>

        <Stack gap="md">
          <Paper withBorder radius="md" p="md">
            <Text fw={600} size="sm" mb="xs">Reference fields</Text>
            {convo.referenceFields && Object.keys(convo.referenceFields).length > 0 ? (
              <Code block fz="xs" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(convo.referenceFields, null, 2)}</Code>
            ) : <Text size="xs" c="dimmed">None (ground truth for accuracy scoring).</Text>}
          </Paper>
          <Paper withBorder radius="md" p="md">
            <Text fw={600} size="sm" mb="xs">Extracted fields</Text>
            {convo.extractedFields && Object.keys(convo.extractedFields).length > 0 ? (
              <Code block fz="xs" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(convo.extractedFields, null, 2)}</Code>
            ) : <Text size="xs" c="dimmed">Not analyzed yet (run a definition with “store” mode).</Text>}
          </Paper>
        </Stack>
      </div>

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete conversation" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{convo.name || convo.key}</strong>? This cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={() => void onDelete()}>Delete</Button>
        </Group>
      </Modal>
    </PageContainer>
  );
}
