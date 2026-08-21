'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Center,
  Code,
  CopyButton,
  FileInput,
  Group,
  Loader,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Slider,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
  ActionIcon,
  Box,
  Accordion,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import {
  IconArrowLeft,
  IconCheck,
  IconClockHour4,
  IconCode,
  IconCopy,
  IconDatabase,
  IconEdit,
  IconFileText,
  IconFilter,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconSearchOff,
  IconTrash,
  IconChartBar,
  IconChartHistogram,
  IconActivity,
  IconFileUpload,
} from '@tabler/icons-react';
import EditRagModuleModal from '@/components/rag/EditRagModuleModal';
import ChunkConfigFields from '@/components/rag/ChunkConfigFields';
import RagReindexBanner, { useRagReindex } from '@/components/rag/RagReindexBanner';
import ScoreDistributionChart, { type ScoreBucket } from '@/components/rag/ScoreDistributionChart';
import {
  CHUNK_STRATEGIES,
  DEFAULT_CHUNK_FORM_VALUES,
  buildChunkConfig,
  chunkFieldErrors,
  chunkFormValues,
  hasChunkFieldErrors,
  type ChunkFormValues,
} from '@/components/rag/ragModuleForm';
import type { IRagChunkConfig, RagChunkStrategy } from '@/lib/database';

/** How often a document still being ingested is re-read. */
const DOC_POLL_INTERVAL_MS = 2500;

/** Which busy indicator a reload drives — 'silent' drives none, for polling. */
type LoadIndicator = 'initial' | 'refresh' | 'silent';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface RagModuleView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  fileBucketKey?: string;
  fileProviderKey?: string;
  chunkConfig: IRagChunkConfig;
  status: string;
  hybrid?: { enabled: boolean; mode?: 'rrf' | 'weighted'; alpha?: number; k?: number } | null;
  isolateByModule?: boolean | null;
  reindexRequired?: boolean;
  rerankerKey?: string | null;
  rerankerOversample?: number | null;
  defaultTopK?: number | null;
  defaultMinScore?: number | null;
  defaultFilter?: Record<string, unknown> | null;
  filterableFields?: string[] | null;
  responseDetail?: 'full' | 'text' | null;
  totalDocuments?: number;
  totalChunks?: number;
  createdAt?: string;
  updatedAt?: string;
  lastReindexAt?: string;
}

interface RagDocumentView {
  _id: string;
  ragModuleKey: string;
  fileKey?: string;
  fileName: string;
  status: string;
  chunkCount?: number;
  errorMessage?: string;
  lastIndexedAt?: string;
  createdAt?: string;
}

interface RagQueryMatch {
  id: string;
  score: number;
  content?: string;
  fileName?: string;
  chunkIndex?: number;
  metadata?: Record<string, unknown>;
}

interface RagQueryResult {
  matches: RagQueryMatch[];
  query: string;
  topK: number;
  latencyMs: number;
}

interface RagQueryLogView {
  _id: string;
  query: string;
  topK: number;
  matchCount: number;
  /** Matches the store returned before the minScore filter, when it was recorded. */
  preFilterMatchCount?: number;
  topScore?: number;
  minScoreApplied?: number;
  latencyMs: number;
  createdAt?: string;
}

interface UsageTotals {
  total: number;
  avgLatencyMs: number;
  zeroMatchCount: number;
  minScoreFilteredCount: number;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function strategyLabel(strategy: string) {
  return CHUNK_STRATEGIES[strategy as RagChunkStrategy]?.label ?? strategy;
}

/** A KPI the API could not aggregate is blank, never the size of the last page. */
function kpiValue(value: number | null | undefined) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function shareOf(part: number, whole: number) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

function statusColor(status: string) {
  switch (status) {
    case 'active':
    case 'indexed':
      return 'teal';
    case 'processing':
    case 'pending':
      return 'yellow';
    case 'failed':
      return 'red';
    default:
      return 'gray';
  }
}

/* ── Sub-components ──────────────────────────────────────────────────── */

interface UsageCodeBlockProps {
  title: string;
  code: string;
}

function UsageCodeBlock({ title, code }: UsageCodeBlockProps) {
  return (
    <Paper withBorder radius="lg" p="lg">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">{title}</Text>
        <CopyButton value={code} timeout={2000}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy code'} withArrow>
              <Button
                size="xs"
                variant={copied ? 'filled' : 'outline'}
                color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
      <Code block fz="xs">{code}</Code>
    </Paper>
  );
}

interface KpiCardProps {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  color: string;
  hint?: ReactNode;
}

function KpiCard({ label, value, icon, color, hint }: KpiCardProps) {
  return (
    <Paper withBorder radius="lg" p="lg">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
            {label}
          </Text>
          <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
            {value}
          </Text>
          {hint ? <Text size="xs" c="dimmed">{hint}</Text> : null}
        </Stack>
        <ThemeIcon size={48} radius="xl" variant="light" color={color}>
          {icon}
        </ThemeIcon>
      </Group>
    </Paper>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function RagModuleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const moduleKey = Array.isArray(params.key) ? params.key[0] : params.key;

  /* state */
  const [mod, setMod] = useState<RagModuleView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  /* documents */
  const [documents, setDocuments] = useState<RagDocumentView[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestFileName, setIngestFileName] = useState('');
  const [ingestContent, setIngestContent] = useState('');
  const [ingestMode, setIngestMode] = useState<string>('file');
  const [ingestFile, setIngestFile] = useState<File | null>(null);

  /* per-document chunking override, seeded from the module's own config */
  const [chunkOverrideOn, setChunkOverrideOn] = useState(false);
  const [chunkOverride, setChunkOverride] = useState<ChunkFormValues>({ ...DEFAULT_CHUNK_FORM_VALUES });

  const [editModalOpen, setEditModalOpen] = useState(false);

  /* playground */
  const [queryResult, setQueryResult] = useState<RagQueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  /* usage */
  const [queryLogs, setQueryLogs] = useState<RagQueryLogView[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageTotals, setUsageTotals] = useState<UsageTotals | null>(null);

  /* insight panels */
  const [scoreBuckets, setScoreBuckets] = useState<ScoreBucket[]>([]);
  const [zeroQueries, setZeroQueries] = useState<RagQueryLogView[]>([]);
  const [insightsLoading, setInsightsLoading] = useState(false);

  const queryForm = useForm({
    initialValues: { query: '', topK: 5, minScore: 0, filter: '' },
    validate: {
      query: (v) => (!v.trim() ? 'Query is required' : null),
      topK: (v) => (v < 1 ? 'Must be at least 1' : null),
      filter: (v) => {
        if (!v.trim()) return null;
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return 'Filter must be a JSON object';
          }
          return null;
        } catch {
          return 'Filter must be valid JSON';
        }
      },
    },
  });

  // Prefill the Playground's Top K / Min score with the module's own
  // defaults once the module loads, without clobbering values the user
  // has since typed in (e.g. after a later refresh/edit).
  const queryDefaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (mod && !queryDefaultsAppliedRef.current) {
      queryDefaultsAppliedRef.current = true;
      queryForm.setValues({
        topK: mod.defaultTopK ?? 5,
        minScore: mod.defaultMinScore ?? 0,
      });
      // An override is an edit of the module's config, so it starts as a copy
      // of it rather than as the factory defaults.
      setChunkOverride(chunkFormValues(mod.chunkConfig));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod]);

  /* ── Data loading ────────────────────────────────────────────────────── */

  const loadModule = useCallback(
    async (indicator: LoadIndicator = 'initial') => {
      if (!moduleKey) return;
      if (indicator === 'refresh') setRefreshing(true);
      else if (indicator === 'initial') setLoading(true);
      try {
        const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}`, { cache: 'no-store' });
        if (!res.ok) {
          if (res.status === 404) { router.push('/dashboard/rag'); return; }
          throw new Error('Failed to load Knowledge Engine module');
        }
        const data = await res.json();
        setMod(data.module ?? null);
      } catch (error) {
        console.error(error);
        // A poll that fails must not stack up toasts behind the user's back.
        if (indicator !== 'silent') {
          notifications.show({ color: 'red', title: 'Error', message: String(error) });
        }
      } finally {
        if (indicator !== 'silent') {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [moduleKey, router],
  );

  const loadDocuments = useCallback(async (silent = false) => {
    if (!moduleKey) return;
    if (!silent) setDocsLoading(true);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}/documents`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents ?? []);
      }
    } catch (e) {
      console.error('[rag docs]', e);
    } finally {
      setDocsLoading(false);
    }
  }, [moduleKey]);

  const loadUsage = useCallback(async () => {
    if (!moduleKey) return;
    setUsageLoading(true);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}/usage?limit=50`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setQueryLogs(data.logs ?? []);
        setUsageTotals(
          typeof data.total === 'number' && typeof data.avgLatencyMs === 'number'
            ? {
              total: data.total,
              avgLatencyMs: data.avgLatencyMs,
              zeroMatchCount: data.zeroMatchCount ?? 0,
              minScoreFilteredCount: data.minScoreFilteredCount ?? 0,
            }
            : null,
        );
      }
    } catch (e) {
      console.error('[rag usage]', e);
    } finally {
      setUsageLoading(false);
    }
  }, [moduleKey]);

  const loadInsights = useCallback(async () => {
    if (!moduleKey) return;
    setInsightsLoading(true);
    const base = `/api/rag/modules/${encodeURIComponent(moduleKey)}`;
    try {
      const [distributionRes, zeroRes] = await Promise.all([
        fetch(`${base}/score-distribution`, { cache: 'no-store' }),
        fetch(`${base}/queries?zeroOnly=true&limit=25`, { cache: 'no-store' }),
      ]);
      if (distributionRes.ok) {
        const data = await distributionRes.json();
        setScoreBuckets(data.buckets ?? []);
      }
      if (zeroRes.ok) {
        const data = await zeroRes.json();
        setZeroQueries(data.logs ?? []);
      }
    } catch (e) {
      console.error('[rag insights]', e);
    } finally {
      setInsightsLoading(false);
    }
  }, [moduleKey]);

  useEffect(() => {
    void loadModule('initial');
  }, [loadModule]);

  useEffect(() => {
    void loadDocuments();
    void loadUsage();
    void loadInsights();
  }, [loadDocuments, loadUsage, loadInsights]);

  /* ── Re-index runs ────────────────────────────────────────────────────── */

  const onReindexSettled = useCallback(() => {
    void loadDocuments(true);
    void loadModule('silent');
  }, [loadDocuments, loadModule]);

  const reindex = useRagReindex(moduleKey, onReindexSettled);

  // A document sits in `pending`/`processing` until the ingest job finishes with
  // it. Without this the row stayed at its initial status until the user
  // happened to press Refresh, which read as an ingest that had hung.
  const documentsSettling = documents.some(
    (doc) => doc.status === 'pending' || doc.status === 'processing',
  );
  useEffect(() => {
    if (!documentsSettling) return undefined;
    const timer = setInterval(() => {
      void loadDocuments(true);
      void loadModule('silent');
    }, DOC_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [documentsSettling, loadDocuments, loadModule]);

  /* ── Actions ──────────────────────────────────────────────────────────── */

  const handleDelete = async () => {
    if (!mod) return;
    if (!window.confirm(`Delete Knowledge Engine module "${mod.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(mod.key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete module');
      notifications.show({ color: 'green', title: 'Deleted', message: `${mod.name} removed.` });
      router.push('/dashboard/rag');
    } catch (error) {
      notifications.show({ color: 'red', title: 'Error', message: String(error) });
    }
  };

  const chunkOverrideErrors = chunkFieldErrors(chunkOverride);
  const chunkOverrideInvalid = chunkOverrideOn && hasChunkFieldErrors(chunkOverrideErrors);

  /** Only sent when the user opened the override — otherwise the module's own config applies. */
  const ingestChunkConfig = (): IRagChunkConfig | undefined =>
    (chunkOverrideOn ? buildChunkConfig(chunkOverride) : undefined);

  const handleIngest = async () => {
    if (!ingestFileName.trim() || !ingestContent.trim()) {
      notifications.show({ color: 'orange', title: 'Missing fields', message: 'File name and content are required.' });
      return;
    }
    setIngesting(true);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey!)}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: ingestFileName.trim(),
          content: ingestContent,
          chunkConfig: ingestChunkConfig(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to ingest document');
      }
      notifications.show({ color: 'green', title: 'Document ingested', message: `${ingestFileName} is being processed.` });
      setIngestFileName('');
      setIngestContent('');
      await loadDocuments();
      await loadModule('refresh');
    } catch (error) {
      notifications.show({ color: 'red', title: 'Ingest failed', message: String(error) });
    } finally {
      setIngesting(false);
    }
  };

  const handleFileIngest = async () => {
    if (!ingestFile) {
      notifications.show({ color: 'orange', title: 'No file selected', message: 'Please select a file to upload.' });
      return;
    }
    setIngesting(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(ingestFile);
      });

      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey!)}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: ingestFile.name,
          data: dataUrl,
          contentType: ingestFile.type || undefined,
          chunkConfig: ingestChunkConfig(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to ingest file');
      }
      notifications.show({ color: 'green', title: 'File ingested', message: `${ingestFile.name} is being processed.` });
      setIngestFile(null);
      await loadDocuments();
      await loadModule('refresh');
    } catch (error) {
      notifications.show({ color: 'red', title: 'Ingest failed', message: String(error) });
    } finally {
      setIngesting(false);
    }
  };

  const handleDeleteDocument = async (doc: RagDocumentView) => {
    if (!window.confirm(`Delete document "${doc.fileName}"? This will remove all associated chunks.`)) return;
    try {
      const res = await fetch(
        `/api/rag/modules/${encodeURIComponent(moduleKey!)}/documents/${encodeURIComponent(doc._id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error('Failed to delete document');
      notifications.show({ color: 'green', title: 'Document deleted', message: `${doc.fileName} removed.` });
      await loadDocuments();
      await loadModule('refresh');
    } catch (error) {
      notifications.show({ color: 'red', title: 'Error', message: String(error) });
    }
  };

  const [reingestingDocId, setReingestingDocId] = useState<string | null>(null);

  /**
   * The whole-module rebuild is a server-side run now. It used to be a
   * sequential loop of one POST per document from this tab, which died with the
   * tab and left half the module on the old configuration.
   */
  const handleReindexAll = async () => {
    if (!moduleKey || documents.length === 0) return;
    if (!window.confirm(`Re-index all ${documents.length} document(s)? Every chunk is rebuilt in the background; queries keep answering from the current vectors until it finishes.`)) return;
    await reindex.start();
  };

  const handleReingestDocument = async (doc: RagDocumentView) => {
    if (!window.confirm(`Re-ingest "${doc.fileName}"? Existing chunks will be deleted and re-processed.`)) return;
    setReingestingDocId(doc._id);
    try {
      const res = await fetch(
        `/api/rag/modules/${encodeURIComponent(moduleKey!)}/documents/${encodeURIComponent(doc._id)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Re-ingest failed');
      }
      notifications.show({ color: 'green', title: 'Re-ingest complete', message: `${doc.fileName} re-processed.` });
      await loadDocuments();
      await loadModule('refresh');
    } catch (error) {
      notifications.show({ color: 'red', title: 'Re-ingest failed', message: String(error) });
    } finally {
      setReingestingDocId(null);
    }
  };

  const handleQuery = queryForm.onSubmit(async (values) => {
    if (!moduleKey) return;
    setQueryLoading(true);
    setQueryResult(null);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: values.query,
          topK: values.topK,
          minScore: values.minScore || undefined,
          filter: values.filter.trim() ? JSON.parse(values.filter) : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Query failed');
      }
      const data = await res.json();
      setQueryResult(data.result ?? null);
      // refresh usage after query
      void loadUsage();
      void loadInsights();
    } catch (error) {
      notifications.show({ color: 'red', title: 'Query failed', message: String(error) });
    } finally {
      setQueryLoading(false);
    }
  });

  /* ── Render Guards ──────────────────────────────────────────────────── */

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="sm" color="violet" />
      </Center>
    );
  }

  if (!mod) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">Knowledge Engine module not found.</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/rag')}>
            Back to Knowledge Engine modules
          </Button>
        </Stack>
      </Center>
    );
  }

  /* ── Code snippets ─────────────────────────────────────────────────── */

  const curlIngest = [
    `curl -X POST https://your-cognipeer-host/api/client/v1/rag/modules/${mod.key}/ingest \\`,
    `  -H "Authorization: Bearer YOUR_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "fileName": "document.txt",`,
    `    "content": "Your document content here..."`,
    `  }'`,
  ].join('\n');

  const curlQuery = [
    `curl -X POST https://your-cognipeer-host/api/client/v1/rag/modules/${mod.key}/query \\`,
    `  -H "Authorization: Bearer YOUR_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "query": "What is ...",`,
    `    "topK": 5`,
    `  }'`,
  ].join('\n');

  const sdkIngest = [
    `import ConsoleClient from '@cognipeer/console-sdk';`,
    ``,
    `const client = new ConsoleClient({`,
    `  apiKey: 'YOUR_API_TOKEN',`,
    `  baseUrl: 'https://your-cognipeer-host',`,
    `});`,
    ``,
    `await client.rag.ingest('${mod.key}', {`,
    `  fileName: 'document.txt',`,
    `  content: 'Your document content here...',`,
    `});`,
  ].join('\n');

  const sdkQuery = [
    `const result = await client.rag.query('${mod.key}', {`,
    `  query: 'What is ...',`,
    `  topK: 5,`,
    `});`,
    ``,
    `console.log(result.matches);`,
    `// [{ score: 0.92, content: '...', fileName: 'doc.txt', chunkIndex: 3 }, ...]`,
  ].join('\n');

  const sdkDelete = [
    `await client.rag.deleteDocument('${mod.key}', 'DOCUMENT_ID');`,
  ].join('\n');

  const curlReingest = [
    `# Re-ingest using existing chunks (no new content needed)`,
    `curl -X POST https://your-cognipeer-host/api/client/v1/rag/modules/${mod.key}/documents/DOCUMENT_ID \\`,
    `  -H "Authorization: Bearer YOUR_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{}'`,
    ``,
    `# Re-ingest with new content`,
    `curl -X POST https://your-cognipeer-host/api/client/v1/rag/modules/${mod.key}/documents/DOCUMENT_ID \\`,
    `  -H "Authorization: Bearer YOUR_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "content": "Updated document content..."`,
    `  }'`,
    ``,
    `# Re-ingest with base64 file`,
    `curl -X POST https://your-cognipeer-host/api/client/v1/rag/modules/${mod.key}/documents/DOCUMENT_ID \\`,
    `  -H "Authorization: Bearer YOUR_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "fileName": "updated.pdf",`,
    `    "base64": "JVBERi0xLjQKJ..."`,
    `  }'`,
  ].join('\n');

  const sdkReingest = [
    `// Re-ingest using existing chunks`,
    `await client.rag.reingestDocument('${mod.key}', 'DOCUMENT_ID');`,
    ``,
    `// Re-ingest with new content`,
    `await client.rag.reingestDocument('${mod.key}', 'DOCUMENT_ID', {`,
    `  content: 'Updated document content...',`,
    `});`,
    ``,
    `// Re-ingest with base64 file`,
    `await client.rag.reingestFile('${mod.key}', 'DOCUMENT_ID', {`,
    `  fileName: 'updated.pdf',`,
    `  base64: 'JVBERi0xLjQKJ...',`,
    `  contentType: 'application/pdf',`,
    `});`,
  ].join('\n');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Knowledge Engine module"
        title={mod.name}
        subtitle={`Key: ${mod.key} • Embedding: ${mod.embeddingModelKey} • Strategy: ${strategyLabel(mod.chunkConfig.strategy)}`}
        actions={
          <>
            <Badge variant="light" color={statusColor(mod.status)}>{mod.status}</Badge>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/rag')}
            >
              Back
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconEdit size={14} />}
              onClick={() => setEditModalOpen(true)}
            >
              Edit
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={refreshing ? <Loader size={12} /> : <IconRefresh size={14} />}
              onClick={() => void loadModule('refresh')}
              disabled={refreshing}
            >
              Refresh
            </Button>
            <Button
              color="red"
              size="xs"
              leftSection={<IconTrash size={14} />}
              onClick={() => void handleDelete()}
            >
              Delete
            </Button>
          </>
        }
      />

      <RagReindexBanner {...reindex} reindexRequired={Boolean(mod.reindexRequired)} />

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconChartBar size={14} />}>Overview</Tabs.Tab>
          <Tabs.Tab value="documents" leftSection={<IconFileText size={14} />}>
            Documents
            <Badge variant="filled" color="violet" size="xs" ml={6}>
              {mod.totalDocuments ?? 0}
            </Badge>
          </Tabs.Tab>
          <Tabs.Tab value="playground" leftSection={<IconPlayerPlay size={14} />}>Playground</Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconCode size={14} />}>Usage</Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<IconActivity size={14} />}>History</Tabs.Tab>
        </Tabs.List>

        {/* ═══════════════════ Overview Tab ═══════════════════ */}
        <Tabs.Panel value="overview">
          <Stack gap="md">
            {/* KPI Cards */}
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
              <KpiCard
                label="Documents"
                value={mod.totalDocuments ?? 0}
                icon={<IconFileText size={24} />}
                color="cyan"
              />
              <KpiCard
                label="Chunks"
                value={mod.totalChunks ?? 0}
                icon={<IconDatabase size={24} />}
                color="orange"
              />
              <KpiCard
                label="Total Queries"
                value={kpiValue(usageTotals?.total)}
                icon={<IconSearch size={24} />}
                color="violet"
              />
              <KpiCard
                label="Avg Latency"
                value={usageTotals && usageTotals.total > 0 ? `${usageTotals.avgLatencyMs}ms` : '—'}
                icon={<IconClockHour4 size={24} />}
                color="teal"
              />
              <KpiCard
                label="Zero-result queries"
                value={kpiValue(usageTotals?.zeroMatchCount)}
                icon={<IconSearchOff size={24} />}
                color="red"
                hint={
                  usageTotals && usageTotals.total > 0
                    ? `${shareOf(usageTotals.zeroMatchCount, usageTotals.total)} of all queries — nothing was retrieved at all`
                    : 'Nothing was retrieved at all'
                }
              />
              <KpiCard
                label="Filtered by min score"
                value={kpiValue(usageTotals?.minScoreFilteredCount)}
                icon={<IconFilter size={24} />}
                color="yellow"
                hint={
                  usageTotals && usageTotals.total > 0
                    ? `${shareOf(usageTotals.minScoreFilteredCount, usageTotals.total)} of all queries — matches were found, the threshold discarded them`
                    : 'Matches were found, the threshold discarded them'
                }
              />
            </SimpleGrid>

            {/* Score distribution — what the min-score slider is actually cutting */}
            <Paper withBorder radius="lg" p="lg">
              <Group gap={8} mb="md">
                <ThemeIcon variant="light" color="violet" radius="md"><IconChartHistogram size={16} /></ThemeIcon>
                <div>
                  <Text fw={600}>Score distribution</Text>
                  <Text size="sm" c="dimmed">
                    The best score of every logged query, against the module&apos;s minimum of {(mod.defaultMinScore ?? 0).toFixed(2)}.
                  </Text>
                </div>
              </Group>
              <ScoreDistributionChart
                buckets={scoreBuckets}
                minScore={mod.defaultMinScore ?? 0}
                loading={insightsLoading}
              />
            </Paper>

            {/* Content gaps */}
            <Paper withBorder radius="lg" p="lg">
              <Group justify="space-between" mb="md">
                <div>
                  <Text fw={600} size="lg">Queries that found nothing</Text>
                  <Text size="sm" c="dimmed">
                    Every one of these is a question this module has no answer for — either the content is
                    missing or the minimum score is set too high.
                  </Text>
                </div>
                <Button
                  variant="light"
                  size="xs"
                  leftSection={insightsLoading ? <Loader size={12} /> : <IconRefresh size={14} />}
                  onClick={() => void loadInsights()}
                  disabled={insightsLoading}
                >
                  Refresh
                </Button>
              </Group>

              {insightsLoading ? (
                <Center py="xl"><Loader size="sm" color="violet" /></Center>
              ) : zeroQueries.length === 0 ? (
                <Center py="xl">
                  <Text size="sm" c="dimmed">No zero-result queries logged. Every query found something.</Text>
                </Center>
              ) : (
                <Box style={{ overflow: 'hidden', borderRadius: 'var(--mantine-radius-md)' }}>
                  <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                    <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
                      <Table.Tr>
                        <Table.Th>Query</Table.Th>
                        <Table.Th style={{ textAlign: 'center' }}>Why</Table.Th>
                        <Table.Th style={{ textAlign: 'center' }}>Best score</Table.Th>
                        <Table.Th>Time</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {zeroQueries.map((log) => {
                        // A query the store answered and the threshold emptied is a
                        // tuning problem; one the store never answered is a content gap.
                        const filtered = (log.preFilterMatchCount ?? 0) > 0;
                        return (
                          <Table.Tr key={log._id}>
                            <Table.Td style={{ maxWidth: 400 }}>
                              <Text size="sm" lineClamp={2}>{log.query}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Center>
                                <Badge variant="light" color={filtered ? 'yellow' : 'red'} size="sm">
                                  {filtered
                                    ? `${log.preFilterMatchCount} below min score`
                                    : 'nothing retrieved'}
                                </Badge>
                              </Center>
                            </Table.Td>
                            <Table.Td>
                              <Center>
                                <Text size="xs" c="dimmed" ff="monospace">
                                  {typeof log.topScore === 'number' ? log.topScore.toFixed(3) : '—'}
                                </Text>
                              </Center>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs" c="dimmed">{formatDate(log.createdAt)}</Text>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Box>
              )}
            </Paper>

            {/* Module Configuration */}
            <Paper withBorder radius="lg" p="lg">
              <Text fw={600} size="lg" mb="md">Module Configuration</Text>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Key</Text>
                  <Text size="sm" ff="monospace">{mod.key}</Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Embedding Model</Text>
                  <Text size="sm">{mod.embeddingModelKey}</Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Vector Provider</Text>
                  <Text size="sm">{mod.vectorProviderKey}</Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Vector Index</Text>
                  <Text size="sm">{mod.vectorIndexKey}</Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Chunk Strategy</Text>
                  <Badge variant="light" color="grape">{strategyLabel(mod.chunkConfig.strategy)}</Badge>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Chunk Size / Overlap</Text>
                  <Text size="sm">{mod.chunkConfig.chunkSize} / {mod.chunkConfig.chunkOverlap}</Text>
                </Stack>
                {mod.chunkConfig.separators && mod.chunkConfig.separators.length > 0 && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Separators</Text>
                    <Group gap={4}>
                      {mod.chunkConfig.separators.map((s, i) => (
                        <Badge key={i} variant="light" color="gray" size="sm">{s || '(empty)'}</Badge>
                      ))}
                    </Group>
                  </Stack>
                )}
                {mod.chunkConfig.encoding && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Encoding</Text>
                    <Text size="sm">{mod.chunkConfig.encoding}</Text>
                  </Stack>
                )}
                {mod.chunkConfig.semanticThreshold !== undefined && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Topic-shift Threshold</Text>
                    <Text size="sm">{mod.chunkConfig.semanticThreshold.toFixed(2)}</Text>
                  </Stack>
                )}
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Parent Window</Text>
                  <Text size="sm">
                    {mod.chunkConfig.parentWindowSize
                      ? `${mod.chunkConfig.parentWindowSize} chars`
                      : 'Off — the chunk itself is returned'}
                  </Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Contextual Headers</Text>
                  {mod.chunkConfig.contextualHeader?.enabled ? (
                    <Badge variant="light" color="grape" size="sm">
                      {mod.chunkConfig.contextualHeader.modelKey ?? 'answer model'}
                    </Badge>
                  ) : (
                    <Text size="sm" c="dimmed">Off</Text>
                  )}
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Hybrid Retrieval</Text>
                  {mod.hybrid?.enabled ? (
                    <Text size="sm">
                      {mod.hybrid.mode === 'weighted'
                        ? `Weighted — dense ${(mod.hybrid.alpha ?? 0.5).toFixed(2)}`
                        : `Reciprocal rank fusion — k ${mod.hybrid.k ?? 60}`}
                    </Text>
                  ) : (
                    <Text size="sm" c="dimmed">Off — vector search only</Text>
                  )}
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Module Isolation</Text>
                  <Text size="sm">
                    {mod.isolateByModule === false
                      ? 'Off — the index is shared with an outside pipeline'
                      : 'On — queries stay inside this module'}
                  </Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Reranker</Text>
                  {mod.rerankerKey ? (
                    <Badge
                      variant="light"
                      color="teal"
                      component="a"
                      href={`/dashboard/reranker/${encodeURIComponent(mod.rerankerKey)}`}
                      style={{ cursor: 'pointer' }}
                    >
                      {mod.rerankerKey}
                    </Badge>
                  ) : (
                    <Text size="sm" c="dimmed">None (vector ranking only)</Text>
                  )}
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Default Top K</Text>
                  <Text size="sm">{mod.defaultTopK ?? 5}</Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Default Min Score</Text>
                  <Text size="sm">{(mod.defaultMinScore ?? 0).toFixed(2)}</Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Created</Text>
                  <Text size="sm">{formatDate(mod.createdAt)}</Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Last Re-index</Text>
                  <Text size="sm">{formatDate(mod.lastReindexAt)}</Text>
                </Stack>
              </SimpleGrid>
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* ═══════════════════ Documents Tab ═══════════════════ */}
        <Tabs.Panel value="documents">
          <Stack gap="md">
            {/* Ingest Form */}
            <Paper withBorder radius="lg" p="lg">
              <Group justify="space-between" mb="md">
                <div>
                  <Text fw={600} size="lg">Ingest Document</Text>
                  <Text size="sm" c="dimmed">Add a new document to this Knowledge Engine module. Upload a file or paste text content.</Text>
                </div>
              </Group>
              <Stack gap="sm">
                <SegmentedControl
                  value={ingestMode}
                  onChange={setIngestMode}
                  data={[
                    { label: 'Upload File', value: 'file' },
                    { label: 'Paste Text', value: 'text' },
                  ]}
                  size="sm"
                />

                {ingestMode === 'file' ? (
                  <>
                    <FileInput
                      label="Select File"
                      placeholder="Click to select a file (PDF, DOCX, TXT, MD, etc.)"
                      accept=".pdf,.doc,.docx,.txt,.md,.csv,.json,.xml,.html,.htm,.xlsx,.xls,.pptx,.ppt,.rtf,.odt"
                      value={ingestFile}
                      onChange={setIngestFile}
                      clearable
                    />
                    {ingestFile && (
                      <Text size="xs" c="dimmed">
                        {ingestFile.name} — {(ingestFile.size / 1024).toFixed(1)} KB
                      </Text>
                    )}
                  </>
                ) : (
                  <>
                    <TextInput
                      label="File Name"
                      placeholder="e.g. product-manual.txt"
                      value={ingestFileName}
                      onChange={(e) => setIngestFileName(e.currentTarget.value)}
                    />
                    <Textarea
                      label="Content"
                      placeholder="Paste your document content here..."
                      value={ingestContent}
                      onChange={(e) => setIngestContent(e.currentTarget.value)}
                      autosize
                      minRows={6}
                      maxRows={16}
                    />
                  </>
                )}

                {/* Collapsed by default: almost every ingest wants the module's own chunking. */}
                <Accordion variant="contained" radius="md" chevronPosition="left">
                  <Accordion.Item value="chunking">
                    <Accordion.Control>
                      <Group gap="xs">
                        <Text size="sm" fw={500}>Chunking for this document</Text>
                        <Badge size="xs" variant="light" color={chunkOverrideOn ? 'violet' : 'gray'}>
                          {chunkOverrideOn
                            ? 'overridden'
                            : `module default — ${strategyLabel(mod.chunkConfig.strategy)}`}
                        </Badge>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Stack gap="sm">
                        <Switch
                          label="Override the module's chunking for this document"
                          description="A 200-page manual and a FAQ CSV rarely want the same splitter. Only this document is affected."
                          checked={chunkOverrideOn}
                          onChange={(e) => setChunkOverrideOn(e.currentTarget.checked)}
                        />
                        {chunkOverrideOn ? (
                          <ChunkConfigFields
                            values={chunkOverride}
                            onChange={(patch) => setChunkOverride((prev) => ({ ...prev, ...patch }))}
                            errors={chunkOverrideErrors}
                          />
                        ) : null}
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>

                <Group justify="flex-end">
                  <Button
                    leftSection={ingesting ? <Loader size={14} /> : <IconFileUpload size={14} />}
                    onClick={() => void (ingestMode === 'file' ? handleFileIngest() : handleIngest())}
                    disabled={
                      ingesting
                      || chunkOverrideInvalid
                      || (ingestMode === 'file'
                        ? !ingestFile
                        : !ingestFileName.trim() || !ingestContent.trim())
                    }
                    loading={ingesting}
                  >
                    {ingestMode === 'file' ? 'Upload & Ingest' : 'Ingest Document'}
                  </Button>
                </Group>
              </Stack>
            </Paper>

            {/* Document List */}
            <Paper withBorder radius="lg" p="lg">
              <Group justify="space-between" mb="md">
                <div>
                  <Text fw={600} size="lg">Documents</Text>
                  <Text size="sm" c="dimmed">{documents.length} document(s) in this module</Text>
                </div>
                <Group gap="xs">
                  <Tooltip
                    label="Rebuild every document's chunks in the background — the run survives closing this tab"
                    withArrow
                  >
                    <Button
                      variant="light"
                      color="violet"
                      size="xs"
                      leftSection={<IconRefresh size={14} />}
                      onClick={() => void handleReindexAll()}
                      disabled={Boolean(reindex.activeRun) || docsLoading || documents.length === 0}
                      loading={reindex.busy}
                    >
                      {reindex.activeRun ? 'Re-index running…' : 'Re-index All'}
                    </Button>
                  </Tooltip>
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={docsLoading ? <Loader size={12} /> : <IconRefresh size={14} />}
                    onClick={() => void loadDocuments()}
                    disabled={docsLoading}
                  >
                    Refresh
                  </Button>
                </Group>
              </Group>

              {docsLoading ? (
                <Center py="xl"><Loader size="sm" color="violet" /></Center>
              ) : documents.length === 0 ? (
                <Center py="xl">
                  <Stack gap="sm" align="center">
                    <ThemeIcon size={64} radius="xl" variant="light" color="gray">
                      <IconFileText size={32} />
                    </ThemeIcon>
                    <Text size="sm" c="dimmed">No documents yet. Ingest your first document above.</Text>
                  </Stack>
                </Center>
              ) : (
                <Box style={{ overflow: 'hidden', borderRadius: 'var(--mantine-radius-md)' }}>
                  <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                    <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
                      <Table.Tr>
                        <Table.Th>File Name</Table.Th>
                        <Table.Th style={{ textAlign: 'center' }}>Chunks</Table.Th>
                        <Table.Th>Status</Table.Th>
                        <Table.Th>Indexed At</Table.Th>
                        <Table.Th>Created</Table.Th>
                        <Table.Th style={{ textAlign: 'center' }}>Actions</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {documents.map((doc) => (
                        <Table.Tr key={doc._id}>
                          <Table.Td>
                            <Group gap="sm">
                              <ThemeIcon size={32} radius="md" variant="light" color="cyan">
                                <IconFileText size={16} />
                              </ThemeIcon>
                              <Text size="sm" fw={500}>{doc.fileName}</Text>
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Center>
                              <Badge variant="filled" color="orange" size="md" radius="sm">
                                {doc.chunkCount ?? 0}
                              </Badge>
                            </Center>
                          </Table.Td>
                          <Table.Td>
                            <Badge variant="light" color={statusColor(doc.status)} size="sm">
                              {doc.status}
                            </Badge>
                            {doc.errorMessage && (
                              <Text size="xs" c="red" mt={2}>{doc.errorMessage}</Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">{formatDate(doc.lastIndexedAt)}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">{formatDate(doc.createdAt)}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Center>
                              <Group gap={4}>
                                <Tooltip label="Re-ingest document" withArrow>
                                  <ActionIcon
                                    variant="light"
                                    color="violet"
                                    radius="md"
                                    loading={reingestingDocId === doc._id}
                                    onClick={() => void handleReingestDocument(doc)}
                                  >
                                    <IconRefresh size={16} />
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label="Delete document" withArrow>
                                  <ActionIcon
                                    variant="light"
                                    color="red"
                                    radius="md"
                                    onClick={() => void handleDeleteDocument(doc)}
                                  >
                                    <IconTrash size={16} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Center>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Box>
              )}
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* ═══════════════════ Playground Tab ═══════════════════ */}
        <Tabs.Panel value="playground">
          <Stack gap="md">
            <Paper withBorder radius="lg" p="lg">
              <Text fw={600} size="lg" mb="xs">Query Playground</Text>
              <Text size="sm" c="dimmed" mb="md">
                Ask questions against this Knowledge Engine module. The system will embed your query, search the vector index, and return the most relevant chunks.
              </Text>

              <form onSubmit={handleQuery}>
                <Stack gap="sm">
                  <Textarea
                    label="Query"
                    placeholder="Ask a question about your documents..."
                    autosize
                    minRows={3}
                    maxRows={8}
                    {...queryForm.getInputProps('query')}
                  />
                  <Box maw={280}>
                    <Text size="sm" fw={500} mb={4}>Min score</Text>
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      marks={[
                        { value: 0, label: '0' },
                        { value: 0.5, label: '0.5' },
                        { value: 1, label: '1' },
                      ]}
                      label={(v) => v.toFixed(2)}
                      value={queryForm.values.minScore}
                      onChange={(v) => queryForm.setFieldValue('minScore', v)}
                    />
                  </Box>
                  <Textarea
                    label="Metadata filter (JSON)"
                    description={
                      mod?.filterableFields?.length
                        ? `Filterable fields: ${mod.filterableFields.join(', ')}. A bare value means equality; operators $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists compose with $and / $or / $not.`
                        : 'Optional. A bare value means equality; operators $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists compose with $and / $or / $not.'
                    }
                    placeholder='{ "source": "crawler", "depth": { "$lte": 2 } }'
                    minRows={2}
                    autosize
                    {...queryForm.getInputProps('filter')}
                  />
                  <Group align="flex-end">
                    <NumberInput
                      label="Top K"
                      min={1}
                      max={100}
                      w={100}
                      {...queryForm.getInputProps('topK')}
                    />
                    <Button
                      type="submit"
                      leftSection={queryLoading ? <Loader size={14} /> : <IconSearch size={14} />}
                      loading={queryLoading}
                      disabled={queryLoading}
                    >
                      Search
                    </Button>
                  </Group>
                </Stack>
              </form>
            </Paper>

            {/* Query Results */}
            {queryResult && (
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" mb="md">
                  <div>
                    <Text fw={600} size="lg">Results</Text>
                    <Text size="sm" c="dimmed">
                      {queryResult.matches.length} match(es) — {queryResult.latencyMs}ms
                    </Text>
                  </div>
                </Group>

                {queryResult.matches.length === 0 ? (
                  <Center py="lg">
                    <Text c="dimmed" size="sm">No matches found.</Text>
                  </Center>
                ) : (
                  <Accordion variant="separated" radius="md">
                    {queryResult.matches.map((match, idx) => (
                      <Accordion.Item key={match.id || idx} value={String(idx)}>
                        <Accordion.Control>
                          <Group justify="space-between" wrap="nowrap" pr="md">
                            <Group gap="sm">
                              <Badge variant="filled" color="violet" size="sm" radius="sm">
                                #{idx + 1}
                              </Badge>
                              <Text size="sm" fw={500}>
                                {match.fileName ?? 'Unknown file'}
                              </Text>
                              {match.chunkIndex !== undefined && (
                                <Badge variant="light" color="gray" size="xs">
                                  Chunk {match.chunkIndex}
                                </Badge>
                              )}
                            </Group>
                            <Group gap="xs">
                              <Text size="xs" c="dimmed">Score:</Text>
                              <Badge
                                variant="light"
                                color={match.score >= 0.8 ? 'teal' : match.score >= 0.5 ? 'yellow' : 'red'}
                                size="sm"
                              >
                                {match.score.toFixed(4)}
                              </Badge>
                            </Group>
                          </Group>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Stack gap="sm">
                            <ScrollArea.Autosize mah={300}>
                              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                {match.content ?? '(no content)'}
                              </Text>
                            </ScrollArea.Autosize>
                            {match.metadata && Object.keys(match.metadata).length > 0 && (
                              <div>
                                <Text size="xs" c="dimmed" fw={600} mb={4}>Metadata</Text>
                                <Code block fz="xs">
                                  {JSON.stringify(match.metadata, null, 2)}
                                </Code>
                              </div>
                            )}
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    ))}
                  </Accordion>
                )}
              </Paper>
            )}
          </Stack>
        </Tabs.Panel>

        {/* ═══════════════════ Usage Tab ═══════════════════ */}
        <Tabs.Panel value="usage">
          <Stack gap="md">
            {/* Code Snippets */}
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <UsageCodeBlock title="cURL — Ingest Document" code={curlIngest} />
              <UsageCodeBlock title="cURL — Query" code={curlQuery} />
              <UsageCodeBlock title="cURL — Re-ingest" code={curlReingest} />
              <UsageCodeBlock title="SDK — Ingest" code={sdkIngest} />
              <UsageCodeBlock title="SDK — Query" code={sdkQuery} />
              <UsageCodeBlock title="SDK — Re-ingest" code={sdkReingest} />
              <UsageCodeBlock title="SDK — Delete Document" code={sdkDelete} />
            </SimpleGrid>
          </Stack>
        </Tabs.Panel>

        {/* ═══════════════════ History Tab ═══════════════════ */}
        <Tabs.Panel value="history">
          <Stack gap="md">
            <Paper withBorder radius="lg" p="lg">
              <Group justify="space-between" mb="md">
                <div>
                  <Text fw={600} size="lg">Query History</Text>
                  <Text size="sm" c="dimmed">Recent queries against this module (last 50)</Text>
                </div>
                <Button
                  variant="light"
                  size="xs"
                  leftSection={usageLoading ? <Loader size={12} /> : <IconRefresh size={14} />}
                  onClick={() => void loadUsage()}
                  disabled={usageLoading}
                >
                  Refresh
                </Button>
              </Group>

              {usageLoading ? (
                <Center py="xl"><Loader size="sm" /></Center>
              ) : queryLogs.length === 0 ? (
                <Center py="xl">
                  <Stack gap="sm" align="center">
                    <ThemeIcon size={64} radius="xl" variant="light" color="gray">
                      <IconActivity size={32} />
                    </ThemeIcon>
                    <Text c="dimmed" size="sm">No queries logged yet. Use the Playground or SDK to run queries.</Text>
                  </Stack>
                </Center>
              ) : (
                <Box style={{ overflow: 'hidden', borderRadius: 'var(--mantine-radius-md)' }}>
                  <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                    <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
                      <Table.Tr>
                        <Table.Th>Query</Table.Th>
                        <Table.Th style={{ textAlign: 'center' }}>Top K</Table.Th>
                        <Table.Th style={{ textAlign: 'center' }}>Matches</Table.Th>
                        <Table.Th style={{ textAlign: 'center' }}>Latency</Table.Th>
                        <Table.Th>Time</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {queryLogs.map((log) => (
                        <Table.Tr key={log._id}>
                          <Table.Td style={{ maxWidth: 400 }}>
                            <Text size="sm" lineClamp={2}>{log.query}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Center>
                              <Badge variant="light" color="gray" size="sm">{log.topK}</Badge>
                            </Center>
                          </Table.Td>
                          <Table.Td>
                            <Center>
                              <Badge variant="filled" color="violet" size="sm">{log.matchCount}</Badge>
                            </Center>
                          </Table.Td>
                          <Table.Td>
                            <Center>
                              <Badge
                                variant="light"
                                color={log.latencyMs < 500 ? 'teal' : log.latencyMs < 2000 ? 'yellow' : 'red'}
                                size="sm"
                              >
                                {log.latencyMs}ms
                              </Badge>
                            </Center>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">{formatDate(log.createdAt)}</Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Box>
              )}
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <EditRagModuleModal
        opened={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        module={mod}
        onUpdated={(updated) => {
          setMod(updated as unknown as RagModuleView);
          setEditModalOpen(false);
          // Changing the chunking or the embedding model enqueues a run
          // server-side; pick it up so the progress banner appears at once.
          void reindex.refresh(true);
        }}
      />
    </PageContainer>
  );
}
