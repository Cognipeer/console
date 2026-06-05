'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Anchor, Button, Group, Modal, Stack } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconEye, IconFileText, IconPlus, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateOcrJobModal from './_lib/CreateOcrJobModal';
import {
  formatCost,
  loadBuckets,
  loadModelOptions,
  ocrJobsApi,
  STATUS_BADGE,
  type BucketOption,
  type ModelOption,
  type OcrJobView,
} from './_lib/api';

export default function OcrJobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<OcrJobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpened, createHandlers] = useDisclosure(false);
  const [ocrModels, setOcrModels] = useState<ModelOption[]>([]);
  const [llmModels, setLlmModels] = useState<ModelOption[]>([]);
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<OcrJobView | null>(null);

  const loadJobs = useCallback(async () => {
    setRefreshing(true);
    try {
      setJobs(await ocrJobsApi.list());
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : 'Failed to load jobs', color: 'red' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    void loadModelOptions('ocr').then(setOcrModels);
    void loadModelOptions('llm').then(setLlmModels);
    void loadBuckets().then(setBuckets);
  }, [loadJobs]);

  const hasActive = useMemo(() => jobs.some((j) => j.itemsProcessed + j.itemsFailed < j.itemsTotal), [jobs]);
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void loadJobs(), 3000);
    return () => clearInterval(t);
  }, [hasActive, loadJobs]);

  const stats = useMemo(() => ({
    total: jobs.length,
    active: jobs.filter((j) => j.status === 'active').length,
    documents: jobs.reduce((a, j) => a + j.itemsProcessed, 0),
    cost: jobs.reduce((a, j) => a + (j.costTotal ?? 0), 0),
  }), [jobs]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await ocrJobsApi.remove(deleteTarget.id);
      setDeleteTarget(null);
      await loadJobs();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : 'Delete failed', color: 'red' });
    }
  }, [deleteTarget, loadJobs]);

  const jobsCtl = useTableControls(jobs, {
    searchText: (j) => `${j.name ?? ''} ${j.id} ${j.status} ${j.ocrModelKey} ${j.llmModelKey ?? ''}`,
    searchPlaceholder: 'Filter by name, status, or model…',
  });

  const columns: DataGridColumn<OcrJobView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (j) => (
        <Anchor onClick={() => router.push(`/dashboard/ocr-jobs/${j.id}`)}>
          {j.name || j.id.slice(0, 8)}
        </Anchor>
      ),
    },
    { key: 'status', label: 'Status', render: (j) => <StatusBadge status={STATUS_BADGE[j.status] ?? j.status} label={j.status} /> },
    { key: 'models', label: 'Models', render: (j) => `${j.ocrModelKey}${j.llmModelKey ? ` + ${j.llmModelKey}` : ''}` },
    { key: 'docs', label: 'Documents', render: (j) => `${j.itemsProcessed}/${j.itemsTotal}${j.itemsFailed ? ` (${j.itemsFailed} failed)` : ''}` },
    { key: 'tokens', label: 'Tokens', render: (j) => (j.usage?.totalTokens ?? 0).toLocaleString() },
    { key: 'cost', label: 'Cost', render: (j) => formatCost(j.costTotal, j.costCurrency) },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="OCR Jobs"
        subtitle="Create a job with rules + a bucket, then send documents to it — each file is OCR'd and extracted with token & cost accounting."
        actions={<Button leftSection={<IconPlus size={16} />} onClick={createHandlers.open}>New Job</Button>}
      />

      <Group grow mb="md">
        <StatTile label="Jobs" value={stats.total} />
        <StatTile label="Active" value={stats.active} />
        <StatTile label="Documents processed" value={stats.documents} />
        <StatTile label="Total cost" value={formatCost(stats.cost, jobs[0]?.costCurrency)} />
      </Group>

      <DataGrid<OcrJobView>
        records={jobsCtl.records}
        rowKey={(j) => j.id}
        columns={columns}
        loading={loading}
        refreshing={refreshing}
        search={jobsCtl.search}
        pagination={jobsCtl.pagination}
        footerLeft={jobsCtl.footerLeft('jobs')}
        onRefresh={() => void loadJobs()}
        onRowClick={(j) => router.push(`/dashboard/ocr-jobs/${j.id}`)}
        rowActions={(j) => [
          { id: 'open', label: 'Open', icon: <IconEye size={15} />, onClick: () => router.push(`/dashboard/ocr-jobs/${j.id}`) },
          { id: 'delete', label: 'Delete', icon: <IconTrash size={15} />, color: 'red', divider: true, onClick: () => setDeleteTarget(j) },
        ]}
        empty={{
          icon: <IconFileText size={28} />,
          title: 'No OCR jobs yet',
          description: 'Create a job, then send documents to it.',
          primaryAction: { label: 'New Job', icon: <IconPlus size={16} />, onClick: createHandlers.open },
        }}
      />

      <CreateOcrJobModal
        opened={createOpened}
        onClose={createHandlers.close}
        ocrModels={ocrModels}
        llmModels={llmModels}
        buckets={buckets}
        onCreated={(jobId) => {
          createHandlers.close();
          router.push(`/dashboard/ocr-jobs/${jobId}`);
        }}
      />

      <Modal opened={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete OCR job" size="sm">
        <Stack gap="md">
          <span>Delete this OCR job and all its items? This cannot be undone.</span>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button color="red" onClick={() => void handleDelete()}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </PageContainer>
  );
}
