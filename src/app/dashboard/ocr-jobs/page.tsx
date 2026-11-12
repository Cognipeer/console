'use client';

import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Anchor, Button, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconEye, IconFileText, IconPlus, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import { useDeleteResource } from '@/components/common/confirm';
import { useDeleteOcrJob, useOcrBucketOptions, useOcrJobs } from '@/lib/api/queries/ocrJobs';
import { useModelsByCategory } from '@/lib/api/queries/rag';
import CreateOcrJobModal from './_lib/CreateOcrJobModal';
import { formatCost, STATUS_BADGE, type ModelOption, type OcrJobView } from './_lib/api';

/** How often the jobs are reread while one still has documents to process. */
const POLL_MS = 3000;

const asOptions = (models: Array<{ key: string; name?: string }> | undefined): ModelOption[] =>
  (models ?? []).map((m) => ({ value: m.key, label: m.name ?? '' }));

export default function OcrJobsPage() {
  const router = useRouter();
  const tConfirm = useTranslations('common.confirm');
  const deleteResource = useDeleteResource();
  const jobsQuery = useOcrJobs(POLL_MS);
  const deleteJob = useDeleteOcrJob();
  const jobs = useMemo<OcrJobView[]>(() => jobsQuery.data ?? [], [jobsQuery.data]);
  const loading = jobsQuery.isPending;
  const refreshing = jobsQuery.isFetching;
  const [createOpened, createHandlers] = useDisclosure(false);
  const ocrModelsQuery = useModelsByCategory('ocr');
  const llmModelsQuery = useModelsByCategory('llm');
  const ocrModels = useMemo(() => asOptions(ocrModelsQuery.data), [ocrModelsQuery.data]);
  const llmModels = useMemo(() => asOptions(llmModelsQuery.data), [llmModelsQuery.data]);
  const buckets = useOcrBucketOptions().data ?? [];

  const stats = useMemo(() => ({
    total: jobs.length,
    active: jobs.filter((j) => j.status === 'active').length,
    documents: jobs.reduce((a, j) => a + j.itemsProcessed, 0),
    cost: jobs.reduce((a, j) => a + (j.costTotal ?? 0), 0),
  }), [jobs]);

  const handleDelete = useCallback(async (job: OcrJobView) => {
    await deleteResource({
      noun: tConfirm('nouns.ocrJob'),
      name: job.name ?? job.id,
      action: async () => {
        await deleteJob.mutateAsync(job.id);
      },
      extraWarning: tConfirm('extras.ocrJobItems'),
    });
  }, [deleteResource, tConfirm, deleteJob]);

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
        onRefresh={() => void jobsQuery.refetch()}
        onRowClick={(j) => router.push(`/dashboard/ocr-jobs/${j.id}`)}
        rowActions={(j) => [
          { id: 'open', label: 'Open', icon: <IconEye size={15} />, onClick: () => router.push(`/dashboard/ocr-jobs/${j.id}`) },
          { id: 'delete', label: 'Delete', icon: <IconTrash size={15} />, color: 'red', divider: true, onClick: () => void handleDelete(j) },
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
    </PageContainer>
  );
}
