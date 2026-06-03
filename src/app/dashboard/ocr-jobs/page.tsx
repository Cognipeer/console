'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Anchor,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconEye, IconFileText, IconPlus, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import SchemaBuilder from './_lib/SchemaBuilder';
import {
  formatCost,
  loadBuckets,
  loadModelOptions,
  ocrJobsApi,
  STATUS_BADGE,
  type BucketOption,
  type CreateOcrJobBody,
  type ModelOption,
  type OcrJobView,
  type OcrOutputKind,
} from './_lib/api';

interface CreateForm {
  name: string;
  bucketKey: string;
  ocrModelKey: string;
  llmModelKey: string;
  outputs: OcrOutputKind[];
  summaryPrompt: string;
  language: string;
  pdfMaxPages: number | '';
  callbackUrl: string;
  callbackSecret: string;
}

export default function OcrJobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<OcrJobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);
  const [ocrModels, setOcrModels] = useState<ModelOption[]>([]);
  const [llmModels, setLlmModels] = useState<ModelOption[]>([]);
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  const [schema, setSchema] = useState<Record<string, unknown> | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<OcrJobView | null>(null);

  const form = useForm<CreateForm>({
    initialValues: {
      name: '', bucketKey: '', ocrModelKey: '', llmModelKey: '',
      outputs: ['full_text'], summaryPrompt: '', language: '', pdfMaxPages: '',
      callbackUrl: '', callbackSecret: '',
    },
    validate: {
      ocrModelKey: (v) => (v ? null : 'OCR model is required'),
      bucketKey: (v) => (v ? null : 'A storage bucket is required'),
    },
  });

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

  const handleCreate = form.onSubmit(async (values) => {
    const outputs = values.outputs.length ? values.outputs : (['full_text'] as OcrOutputKind[]);
    const needsLlm = outputs.includes('summary') || outputs.includes('structured');
    if (needsLlm && !values.llmModelKey) {
      notifications.show({ message: 'Select an LLM model for summary/structured outputs', color: 'red' });
      return;
    }
    if (outputs.includes('structured') && !schema) {
      notifications.show({ message: 'Define a structured schema (Builder or JSON)', color: 'red' });
      return;
    }
    const body: CreateOcrJobBody = {
      name: values.name || undefined,
      bucketKey: values.bucketKey,
      ocrModelKey: values.ocrModelKey,
      llmModelKey: needsLlm ? values.llmModelKey : undefined,
      outputs,
      summaryPrompt: values.summaryPrompt || undefined,
      structuredSchema: outputs.includes('structured') ? schema : undefined,
      language: values.language || undefined,
      pdfMaxPages: typeof values.pdfMaxPages === 'number' ? values.pdfMaxPages : undefined,
      callbackUrl: values.callbackUrl || undefined,
      callbackSecret: values.callbackSecret || undefined,
    };
    setCreating(true);
    try {
      const job = await ocrJobsApi.create(body);
      notifications.show({ message: 'OCR job created', color: 'green' });
      createHandlers.close();
      form.reset();
      setSchema(undefined);
      router.push(`/dashboard/ocr-jobs/${job.id}`);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : 'Failed to create job', color: 'red' });
    } finally {
      setCreating(false);
    }
  });

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
        records={jobs}
        rowKey={(j) => j.id}
        columns={columns}
        loading={loading}
        refreshing={refreshing}
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

      <Modal opened={createOpened} onClose={createHandlers.close} title="New OCR Job" size="lg">
        <form onSubmit={handleCreate}>
          <Stack gap="sm">
            <TextInput label="Name" placeholder="Optional" {...form.getInputProps('name')} />
            <Select
              label="Storage bucket"
              placeholder={buckets.length ? 'Select a bucket' : 'No buckets — create one in Document Store'}
              data={buckets}
              searchable
              required
              {...form.getInputProps('bucketKey')}
            />
            <Group grow>
              <Select label="OCR model" placeholder="Select OCR model" data={ocrModels} searchable required {...form.getInputProps('ocrModelKey')} />
              <Select label="LLM model" placeholder="For summary / structured" data={llmModels} searchable clearable {...form.getInputProps('llmModelKey')} />
            </Group>

            <Checkbox.Group label="Outputs" {...form.getInputProps('outputs')}>
              <Group mt="xs">
                <Checkbox value="full_text" label="Full text" />
                <Checkbox value="summary" label="Summary" />
                <Checkbox value="structured" label="Structured (JSON)" />
              </Group>
            </Checkbox.Group>

            {form.values.outputs.includes('summary') && (
              <Textarea label="Summary prompt" placeholder="Optional instruction" autosize minRows={2} {...form.getInputProps('summaryPrompt')} />
            )}

            {form.values.outputs.includes('structured') && (
              <div>
                <div className="ds-input-label" style={{ marginBottom: 4 }}>Structured schema</div>
                <SchemaBuilder value={schema} onChange={setSchema} />
              </div>
            )}

            <Group grow>
              <TextInput label="Language hint" placeholder="tr, en…" {...form.getInputProps('language')} />
              <NumberInput label="PDF max pages" placeholder="empty = unlimited" min={0} {...form.getInputProps('pdfMaxPages')} />
            </Group>

            <Group grow>
              <TextInput label="Callback URL" placeholder="https://…/webhook" {...form.getInputProps('callbackUrl')} />
              <TextInput label="Callback secret" placeholder="HMAC secret" {...form.getInputProps('callbackSecret')} />
            </Group>

            <Group justify="flex-end" mt="sm">
              <Button variant="default" type="button" onClick={createHandlers.close}>Cancel</Button>
              <Button type="submit" loading={creating}>Create</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

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
