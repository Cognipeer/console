'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Code,
  CopyButton,
  FileInput,
  Group,
  Modal,
  Stack,
  Tabs,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCopy,
  IconCheck,
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
  IconSend,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import {
  fileToBase64,
  formatCost,
  ocrJobsApi,
  STATUS_BADGE,
  type ItemSourceDraft,
  type OcrJobItemView,
  type OcrJobView,
} from '../_lib/api';

const preStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto', fontSize: 12, margin: 0,
};

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Group justify="space-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--ds-border-subtle)' }}>
      <span style={{ color: 'var(--ds-text-subtle)' }}>{label}</span>
      <strong>{value}</strong>
    </Group>
  );
}

function num(v?: number): string {
  return (v ?? 0).toLocaleString();
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <CopyButton value={code}>
        {({ copied, copy }) => (
          <Button size="compact-xs" variant="subtle" onClick={copy} style={{ position: 'absolute', top: 6, right: 6, zIndex: 1 }} leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </CopyButton>
      <Code block style={{ fontSize: 12, paddingRight: 70 }}>{code}</Code>
    </div>
  );
}

export default function OcrJobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const router = useRouter();

  const [job, setJob] = useState<OcrJobView | null>(null);
  const [items, setItems] = useState<OcrJobItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState('');
  const [sending, setSending] = useState(false);
  const [viewItem, setViewItem] = useState<OcrJobItemView | null>(null);
  const [origin, setOrigin] = useState('https://your-console');

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    try {
      const [j, its] = await Promise.all([ocrJobsApi.get(jobId), ocrJobsApi.items(jobId)]);
      setJob(j);
      setItems(its);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : 'Failed to load job', color: 'red' });
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  const hasActive = useMemo(() => items.some((i) => i.status === 'pending' || i.status === 'running'), [items]);
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [hasActive, load]);

  const handleSend = async () => {
    const drafts: ItemSourceDraft[] = [];
    for (const file of files) {
      const data = await fileToBase64(file);
      drafts.push({ source: { kind: 'inline', data, fileName: file.name, contentType: file.type || undefined }, fileName: file.name });
    }
    for (const url of urls.split('\n').map((u) => u.trim()).filter(Boolean)) {
      drafts.push({ source: { kind: 'url', url } });
    }
    if (drafts.length === 0) {
      notifications.show({ message: 'Add files or URLs to send', color: 'red' });
      return;
    }
    setSending(true);
    try {
      await ocrJobsApi.sendFiles(jobId, drafts, 'async');
      notifications.show({ message: `${drafts.length} document(s) queued`, color: 'green' });
      setFiles([]);
      setUrls('');
      await load();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : 'Send failed', color: 'red' });
    } finally {
      setSending(false);
    }
  };

  const toggleStatus = async () => {
    if (!job) return;
    try {
      const updated = job.status === 'active' ? await ocrJobsApi.pause(jobId) : await ocrJobsApi.resume(jobId);
      setJob(updated);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : 'Failed', color: 'red' });
    }
  };

  const columns: DataGridColumn<OcrJobItemView>[] = [
    { key: 'file', label: 'Document', render: (it) => it.fileName || `#${it.index}` },
    { key: 'status', label: 'Status', render: (it) => <StatusBadge status={STATUS_BADGE[it.status] ?? it.status} label={it.status} /> },
    { key: 'tokens', label: 'Tokens', render: (it) => num(it.usage?.totalTokens) },
    { key: 'pages', label: 'Pages', render: (it) => it.usage?.pages ?? it.result?.pages ?? '—' },
    { key: 'cost', label: 'Cost', render: (it) => formatCost(it.costTotal, it.costCurrency) },
  ];

  // Usage metrics derived from job aggregates.
  const usage = job?.usage;
  const processed = job?.itemsProcessed ?? 0;
  const failed = job?.itemsFailed ?? 0;
  const completed = processed + failed;
  const successRate = completed > 0 ? Math.round((processed / completed) * 100) : 0;
  const avg = (total?: number) => (processed > 0 ? (total ?? 0) / processed : 0);

  const apiBase = `${origin}/api/client/v1/ocr-jobs/${jobId}`;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={<button type="button" onClick={() => router.push('/dashboard/ocr-jobs')} style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit' }}><IconArrowLeft size={14} /> OCR Jobs</button>}
        title={job?.name || (job ? job.id.slice(0, 8) : 'OCR Job')}
        subtitle={job ? `${job.ocrModelKey}${job.llmModelKey ? ` + ${job.llmModelKey}` : ''} · outputs: ${job.outputs.join(', ')} · bucket: ${job.bucketKey}` : undefined}
        actions={job ? (
          <Group gap="xs">
            <Button variant="light" leftSection={job.status === 'active' ? <IconPlayerPause size={15} /> : <IconPlayerPlay size={15} />} onClick={() => void toggleStatus()}>
              {job.status === 'active' ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="light" leftSection={<IconDownload size={15} />} onClick={() => window.open(ocrJobsApi.exportUrl(jobId, 'json'), '_blank')}>JSON</Button>
            <Button variant="light" leftSection={<IconDownload size={15} />} onClick={() => window.open(ocrJobsApi.exportUrl(jobId, 'csv'), '_blank')}>CSV</Button>
          </Group>
        ) : undefined}
      />

      {job && (
        <Group grow mb="md">
          <StatTile label="Status" value={<StatusBadge status={STATUS_BADGE[job.status] ?? job.status} label={job.status} />} />
          <StatTile label="Documents" value={`${processed}/${job.itemsTotal}${failed ? ` · ${failed} failed` : ''}`} />
          <StatTile label="Total tokens" value={num(job.usage?.totalTokens)} />
          <StatTile label="Total cost" value={formatCost(job.costTotal, job.costCurrency)} />
        </Group>
      )}

      <Tabs defaultValue="documents">
        <Tabs.List>
          <Tabs.Tab value="documents">Documents</Tabs.Tab>
          <Tabs.Tab value="usage">Usage</Tabs.Tab>
          <Tabs.Tab value="api">API</Tabs.Tab>
        </Tabs.List>

        {/* ── Documents ── */}
        <Tabs.Panel value="documents" pt="md">
          <div style={{ border: '1px solid var(--ds-border)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <Stack gap="sm">
              <strong>Send documents</strong>
              <FileInput placeholder="Choose files (PDF, images…)" multiple value={files} onChange={setFiles} clearable />
              <Textarea label="Or document URLs (one per line)" placeholder="https://example.com/doc.pdf" autosize minRows={2} value={urls} onChange={(e) => setUrls(e.currentTarget.value)} />
              <Group justify="flex-end">
                <Button leftSection={<IconSend size={15} />} loading={sending} disabled={job?.status !== 'active'} onClick={() => void handleSend()}>Send to job</Button>
              </Group>
              {job && job.status !== 'active' && <span style={{ color: 'var(--ds-text-subtle)' }}>Job is {job.status}; resume it to send documents.</span>}
            </Stack>
          </div>

          <DataGrid<OcrJobItemView>
            records={items}
            rowKey={(it) => it.id}
            columns={columns}
            loading={loading}
            onRefresh={() => void load()}
            onRowClick={(it) => setViewItem(it)}
            rowActions={(it) => [{ id: 'view', label: 'View result', onClick: () => setViewItem(it) }]}
            empty={{ title: 'No documents yet', description: 'Send documents to this job to start processing.' }}
          />
        </Tabs.Panel>

        {/* ── Usage ── */}
        <Tabs.Panel value="usage" pt="md">
          {job && (
            <Group align="flex-start" grow>
              <div style={{ border: '1px solid var(--ds-border)', borderRadius: 8, padding: 16 }}>
                <strong>Documents</strong>
                <MetricRow label="Total sent" value={num(job.itemsTotal)} />
                <MetricRow label="Processed" value={num(processed)} />
                <MetricRow label="Failed" value={num(failed)} />
                <MetricRow label="Success rate" value={`${successRate}%`} />
                <MetricRow label="Pages processed" value={num(usage?.pages)} />
              </div>

              <div style={{ border: '1px solid var(--ds-border)', borderRadius: 8, padding: 16 }}>
                <strong>Tokens</strong>
                <MetricRow label="Input" value={num(usage?.inputTokens)} />
                <MetricRow label="Output" value={num(usage?.outputTokens)} />
                <MetricRow label="Total" value={num(usage?.totalTokens)} />
                <MetricRow label="OCR stage" value={num(usage?.ocrTokens)} />
                <MetricRow label="LLM stage" value={num(usage?.llmTokens)} />
              </div>

              <div style={{ border: '1px solid var(--ds-border)', borderRadius: 8, padding: 16 }}>
                <strong>Cost</strong>
                <MetricRow label="OCR" value={formatCost(job.costOcr, job.costCurrency)} />
                <MetricRow label="LLM" value={formatCost(job.costLlm, job.costCurrency)} />
                <MetricRow label="Total" value={formatCost(job.costTotal, job.costCurrency)} />
                <MetricRow label="Avg cost / doc" value={formatCost(avg(job.costTotal), job.costCurrency)} />
                <MetricRow label="Avg tokens / doc" value={num(Math.round(avg(usage?.totalTokens)))} />
              </div>
            </Group>
          )}
        </Tabs.Panel>

        {/* ── API ── */}
        <Tabs.Panel value="api" pt="md">
          <Stack gap="md">
            <span style={{ color: 'var(--ds-text-subtle)' }}>
              Integrate with this job using a project API token (send as <Code>Authorization: Bearer $TOKEN</Code>). The job id is <Code>{jobId}</Code>.
            </span>

            <div>
              <strong>Send documents (multipart upload)</strong>
              <CodeBlock code={`curl -X POST "${apiBase}/files" \\
  -H "Authorization: Bearer $COGNIPEER_API_TOKEN" \\
  -F "files=@/path/to/document.pdf" \\
  -F "files=@/path/to/image.png"`} />
            </div>

            <div>
              <strong>Send documents (JSON: base64 / url / bucket ref)</strong>
              <CodeBlock code={`curl -X POST "${apiBase}/files" \\
  -H "Authorization: Bearer $COGNIPEER_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "items": [
      { "source": { "kind": "url", "url": "https://example.com/doc.pdf" } },
      { "source": { "kind": "inline", "data": "<base64>", "fileName": "a.png", "contentType": "image/png" } }
    ]
  }'`} />
            </div>

            <div>
              <strong>Check status & per-document results</strong>
              <CodeBlock code={`curl "${apiBase}" -H "Authorization: Bearer $COGNIPEER_API_TOKEN"
curl "${apiBase}/items" -H "Authorization: Bearer $COGNIPEER_API_TOKEN"
curl "${apiBase}/usage" -H "Authorization: Bearer $COGNIPEER_API_TOKEN"`} />
            </div>

            <div>
              <strong>Export results</strong>
              <CodeBlock code={`curl "${apiBase}/export?format=csv" -H "Authorization: Bearer $COGNIPEER_API_TOKEN" -o results.csv
curl "${apiBase}/export?format=jsonl" -H "Authorization: Bearer $COGNIPEER_API_TOKEN" -o results.jsonl`} />
            </div>

            <div>
              <strong>Webhook (per document)</strong>
              <span style={{ color: 'var(--ds-text-subtle)', display: 'block', marginBottom: 6 }}>
                When a callback URL is configured, each document POSTs an HMAC-signed payload (<Code>x-cognipeer-signature: t=&lt;ts&gt;,v1=&lt;hmac&gt;</Code>):
              </span>
              <CodeBlock code={`{
  "id": "evt_…",
  "event": "ocr.item.succeeded",
  "jobId": "${jobId}",
  "data": {
    "itemId": "…", "fileName": "doc.pdf",
    "result": { "fullText": "…", "summary": "…", "structured": { } },
    "usage": { "totalTokens": 1234, "pages": 3 },
    "cost": 0.0042, "currency": "USD"
  }
}`} />
            </div>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <Modal opened={!!viewItem} onClose={() => setViewItem(null)} title={viewItem?.fileName || 'Document'} size="xl">
        {viewItem && (
          <Stack gap="sm">
            <Group gap="xs">
              <StatusBadge status={STATUS_BADGE[viewItem.status] ?? viewItem.status} label={viewItem.status} />
              <span>{num(viewItem.usage?.totalTokens)} tokens · {formatCost(viewItem.costTotal, viewItem.costCurrency)}</span>
            </Group>
            {viewItem.errorMessage && <div style={{ color: 'var(--ds-danger)' }}>{viewItem.errorMessage}</div>}
            {viewItem.result && (
              <Tabs defaultValue={viewItem.result.fullText !== undefined ? 'text' : viewItem.result.summary !== undefined ? 'summary' : 'structured'}>
                <Tabs.List>
                  {viewItem.result.fullText !== undefined && <Tabs.Tab value="text">Full text</Tabs.Tab>}
                  {viewItem.result.summary !== undefined && <Tabs.Tab value="summary">Summary</Tabs.Tab>}
                  {viewItem.result.structured !== undefined && <Tabs.Tab value="structured">Structured</Tabs.Tab>}
                </Tabs.List>
                {viewItem.result.fullText !== undefined && <Tabs.Panel value="text" pt="xs"><pre style={preStyle}>{viewItem.result.fullText}</pre></Tabs.Panel>}
                {viewItem.result.summary !== undefined && <Tabs.Panel value="summary" pt="xs"><pre style={preStyle}>{viewItem.result.summary}</pre></Tabs.Panel>}
                {viewItem.result.structured !== undefined && <Tabs.Panel value="structured" pt="xs"><pre style={preStyle}>{JSON.stringify(viewItem.result.structured, null, 2)}</pre></Tabs.Panel>}
              </Tabs>
            )}
          </Stack>
        )}
      </Modal>
    </PageContainer>
  );
}
