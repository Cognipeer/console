'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Box,
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
  Tabs,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
  Accordion,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { ResourceUsageSection, useConfirm, useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
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
  IconScan,
  IconSearch,
  IconSearchOff,
  IconTrash,
  IconChartBar,
  IconChartHistogram,
  IconActivity,
  IconFileUpload,
  IconDownload,
  IconUpload,
  IconAlertTriangle,
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
  documentExtractionNote,
  type ChunkFormValues,
} from '@/components/rag/ragModuleForm';
import { englishOcrText } from '@/components/extraction/ocrEnglish';
import { describeOcr, ocrIsOn, type OcrSettings } from '@/components/extraction/ocrForm';
import type { IRagChunkConfig, RagChunkStrategy } from '@/lib/database';

/** How often a document still being ingested is re-read. */
const DOC_POLL_INTERVAL_MS = 2500;

/** What the file picker offers; pictures and scans are readable only while the module's OCR is on. */
const DOCUMENT_ACCEPT = '.pdf,.doc,.docx,.txt,.md,.csv,.json,.xml,.html,.htm,.xlsx,.xls,.pptx,.ppt,.rtf,.odt';
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff';
/** Documents per import request; keeps each body well under the server's body limit. */
const IMPORT_BATCH_SIZE = 1000;
const IMPORT_FORMAT_NAME = 'cognipeer.rag-module';

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
  extraction?: { ocr?: OcrSettings | null } | null;
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
  /** How the text was read (OCR pages) and, while the file is still being read, where that stands. */
  extraction?: {
    sourceType?: string;
    pageCount?: number;
    ocrPages?: number;
    ocrImages?: number;
    stage?: 'queued' | 'running';
    progress?: { completed: number; total: number };
    warnings?: string[];
  };
}

/** What the Status column says about the OCR of a document: the finished run, or the one in flight. */
const extractionNote = (doc: RagDocumentView): string | undefined => documentExtractionNote(doc.extraction);

/**
 * A match as the query endpoint returns it — not as the service produced it.
 * A module set to `responseDetail: 'text'` has every field but `content`
 * stripped by shapeRagQueryResponse, so nothing here may be assumed present.
 */
interface RagQueryMatch {
  id?: string;
  score?: number;
  content?: string;
  fileName?: string;
  chunkIndex?: number;
  metadata?: Record<string, unknown>;
}

interface RagQueryResult {
  matches: RagQueryMatch[];
  query: string;
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
  /** Absent on logs written before latency was recorded. */
  latencyMs?: number;
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

/** A latency that was never recorded gets no colour, rather than the "slow" red. */
function latencyColor(ms?: number) {
  if (typeof ms !== 'number') return 'gray';
  return ms < 500 ? 'teal' : ms < 2000 ? 'yellow' : 'red';
}

function scoreColor(score: number) {
  return score >= 0.8 ? 'teal' : score >= 0.5 ? 'yellow' : 'red';
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

interface InlineLoadErrorProps {
  message: string;
  onRetry: () => void;
}

/**
 * A failed load must look different from "there is nothing here yet" --
 * without this, documents/usage/insights sections that failed to fetch
 * rendered exactly like a genuinely empty tenant, with the actual failure
 * visible only in devtools (F-19, finance-institution assessment,
 * 2026-09-05).
 */
function InlineLoadError({ message, onRetry }: InlineLoadErrorProps) {
  return (
    <Center py="xl">
      <Stack gap="sm" align="center">
        <ThemeIcon size={64} radius="xl" variant="light" color="red">
          <IconAlertTriangle size={32} />
        </ThemeIcon>
        <Text size="sm" c="dimmed" ta="center" maw={360}>{message}</Text>
        <Button size="xs" variant="light" color="red" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
          Retry
        </Button>
      </Stack>
    </Center>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function RagModuleDetailPage() {
  const params = useParams()!;
  const router = useRouter();
  const deleteResource = useDeleteResource();
  const { confirm } = useConfirm();
  const tSafe = useTranslations('common.confirm.dataSafety');
  const moduleKey = Array.isArray(params.key) ? params.key[0] : params.key;

  /* state */
  const [mod, setMod] = useState<RagModuleView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  /* documents */
  const [documents, setDocuments] = useState<RagDocumentView[]>([]);
  const [docTotal, setDocTotal] = useState(0);
  const [docPage, setDocPage] = useState(1);
  const [docPageSize, setDocPageSize] = useState(25);
  const [docSearch, setDocSearch] = useState('');
  const [docStatus, setDocStatus] = useState('all');
  const [debouncedDocSearch] = useDebouncedValue(docSearch.trim(), 300);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
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
  const [usageError, setUsageError] = useState<string | null>(null);
  /** 'own' when the caller does not administer the module: the logs are only their queries (the counters are not). */
  const [queryLogScope, setQueryLogScope] = useState<'all' | 'own'>('all');

  /* insight panels */
  const [scoreBuckets, setScoreBuckets] = useState<ScoreBucket[]>([]);
  const [zeroQueries, setZeroQueries] = useState<RagQueryLogView[]>([]);
  /** The zero-result feed's own answer: it is fetched apart from the history and may come back on its own. */
  const [zeroQueriesScope, setZeroQueriesScope] = useState<'all' | 'own'>('all');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);

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
      const params = new URLSearchParams({
        limit: String(docPageSize),
        offset: String((docPage - 1) * docPageSize),
      });
      if (debouncedDocSearch) params.set('search', debouncedDocSearch);
      if (docStatus !== 'all') params.set('status', docStatus);
      const res = await fetch(
        `/api/rag/modules/${encodeURIComponent(moduleKey)}/documents?${params.toString()}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        throw new Error(`Failed to load documents (HTTP ${res.status})`);
      }
      const data = await res.json();
      const total = typeof data.total === 'number' ? data.total : (data.documents ?? []).length;
      // Deleting the last row of the last page leaves that page empty; step back
      // instead of showing "no documents" over a module that still has some.
      if ((data.documents ?? []).length === 0 && total > 0 && docPage > 1) {
        setDocPage(Math.max(1, Math.ceil(total / docPageSize)));
        return;
      }
      setDocuments(data.documents ?? []);
      setDocTotal(total);
      setDocsError(null);
    } catch (e) {
      console.error('[rag docs]', e);
      // A failed load must not be mistaken for "zero documents" -- the table
      // below only renders its empty state when docsError is also cleared.
      setDocsError(e instanceof Error ? e.message : 'Failed to load documents');
    } finally {
      setDocsLoading(false);
    }
  }, [moduleKey, docPage, docPageSize, debouncedDocSearch, docStatus]);

  const loadUsage = useCallback(async () => {
    if (!moduleKey) return;
    setUsageLoading(true);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}/usage?limit=50`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Failed to load usage (HTTP ${res.status})`);
      }
      const data = await res.json();
      setQueryLogs(data.logs ?? []);
      setQueryLogScope(data.scope === 'own' ? 'own' : 'all');
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
      setUsageError(null);
    } catch (e) {
      console.error('[rag usage]', e);
      setUsageError(e instanceof Error ? e.message : 'Failed to load usage');
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
      if (!distributionRes.ok || !zeroRes.ok) {
        const failedStatus = !distributionRes.ok ? distributionRes.status : zeroRes.status;
        throw new Error(`Failed to load insights (HTTP ${failedStatus})`);
      }
      const [distributionData, zeroData] = await Promise.all([distributionRes.json(), zeroRes.json()]);
      setScoreBuckets(distributionData.buckets ?? []);
      setZeroQueries(zeroData.logs ?? []);
      setZeroQueriesScope(zeroData.scope === 'own' ? 'own' : 'all');
      setInsightsError(null);
    } catch (e) {
      console.error('[rag insights]', e);
      setInsightsError(e instanceof Error ? e.message : 'Failed to load insights');
    } finally {
      setInsightsLoading(false);
    }
  }, [moduleKey]);

  useEffect(() => {
    void loadModule('initial');
  }, [loadModule]);

  // Paging and searching refetch only the document list; usage and insights
  // describe the whole module and do not change with the page.
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    void loadUsage();
    void loadInsights();
  }, [loadUsage, loadInsights]);

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
    (doc) => doc.status === 'pending' || doc.status === 'processing' || Boolean(doc.extraction?.stage),
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
    await deleteResource({
      noun: tSafe('nouns.ragModule'),
      name: mod.name,
      type: 'rag-module',
      id: mod._id,
      extraWarning: tSafe('ragModuleExtra'),
      action: async () => {
        const res = await fetch(`/api/rag/modules/${encodeURIComponent(mod.key)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete module');
        notifications.show({ color: 'green', title: 'Deleted', message: `${mod.name} removed.` });
        router.push('/dashboard/rag');
      },
    });
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
    await deleteResource({
      noun: tSafe('nouns.ragDocument'),
      name: doc.fileName,
      extraWarning: tSafe('ragDocumentExtra'),
      action: async () => {
        const res = await fetch(
          `/api/rag/modules/${encodeURIComponent(moduleKey!)}/documents/${encodeURIComponent(doc._id)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) throw new Error('Failed to delete document');
        notifications.show({ color: 'green', title: 'Document deleted', message: `${doc.fileName} removed.` });
        await loadDocuments();
        await loadModule('refresh');
      },
    });
  };

  const [reingestingDocId, setReingestingDocId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (!moduleKey) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}/export`, { cache: 'no-store' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${moduleKey}.rag.jsonl`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notifications.show({ color: 'red', title: 'Export failed', message: String(error) });
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    if (!moduleKey) return;
    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
      // The export header is informational here; each batch is posted as plain JSONL.
      if (lines.length > 0 && lines[0].includes(`"format":"${IMPORT_FORMAT_NAME}"`)) lines.shift();

      const url = `/api/rag/modules/${encodeURIComponent(moduleKey)}/import`;
      let imported = 0;
      let failed = 0;
      let batchError: string | undefined;

      for (let start = 0; start < lines.length; start += IMPORT_BATCH_SIZE) {
        const batch = lines.slice(start, start + IMPORT_BATCH_SIZE).join('\n');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: batch }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          batchError = body.error || `Import failed (${res.status}) at document ${start + 1}`;
          break;
        }
        imported += body.imported;
        failed += body.failed;
      }

      if (batchError) throw new Error(`${batchError}. ${imported} document(s) were queued before it.`);
      notifications.show({
        color: failed > 0 ? 'orange' : 'green',
        title: 'Import finished',
        message: `${imported} of ${lines.length} document(s) queued${failed > 0 ? `, ${failed} failed` : ''}.`,
      });
      void loadDocuments(true);
    } catch (error) {
      notifications.show({ color: 'red', title: 'Import failed', message: String(error) });
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const zeroQueryColumns: DataGridColumn<RagQueryLogView>[] = [
    {
      key: 'query',
      label: 'Query',
      render: (log) => <Text size="sm" lineClamp={2} maw={400}>{log.query}</Text>,
    },
    {
      key: 'why',
      label: 'Why',
      align: 'center',
      render: (log) => {
        // A query the store answered and the threshold emptied is a
        // tuning problem; one the store never answered is a content gap.
        // Logs written before the count existed can say neither: absent
        // is not zero, and calling it a content gap sends the user
        // looking for documents that may well be there.
        const preFilter = log.preFilterMatchCount;
        const recorded = typeof preFilter === 'number';
        const filtered = recorded && preFilter > 0;
        return (
          <Badge
            variant="light"
            color={!recorded ? 'gray' : filtered ? 'yellow' : 'red'}
            size="sm"
          >
            {!recorded
              ? 'reason not recorded'
              : filtered
                ? `${preFilter} below min score`
                : 'nothing retrieved'}
          </Badge>
        );
      },
    },
    {
      key: 'bestScore',
      label: 'Best score',
      align: 'center',
      render: (log) => (
        <Text size="xs" c="dimmed" ff="monospace">
          {typeof log.topScore === 'number' ? log.topScore.toFixed(3) : '—'}
        </Text>
      ),
    },
    {
      key: 'time',
      label: 'Time',
      render: (log) => <Text size="xs" c="dimmed">{formatDate(log.createdAt)}</Text>,
    },
  ];

  const historyColumns: DataGridColumn<RagQueryLogView>[] = [
    {
      key: 'query',
      label: 'Query',
      render: (log) => <Text size="sm" lineClamp={2} maw={400}>{log.query}</Text>,
    },
    {
      key: 'topK',
      label: 'Top K',
      align: 'center',
      render: (log) => <Badge variant="light" color="gray" size="sm">{log.topK}</Badge>,
    },
    {
      key: 'matches',
      label: 'Matches',
      align: 'center',
      render: (log) => <Badge variant="filled" color="violet" size="sm">{log.matchCount}</Badge>,
    },
    {
      key: 'latency',
      label: 'Latency',
      align: 'center',
      render: (log) => (
        <Badge variant="light" color={latencyColor(log.latencyMs)} size="sm">
          {typeof log.latencyMs === 'number' ? `${log.latencyMs}ms` : '—'}
        </Badge>
      ),
    },
    {
      key: 'time',
      label: 'Time',
      render: (log) => <Text size="xs" c="dimmed">{formatDate(log.createdAt)}</Text>,
    },
  ];

  const docColumns: DataGridColumn<RagDocumentView>[] = [
    {
      key: 'fileName',
      label: 'File Name',
      render: (doc) => (
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={28} radius="md" variant="light" color="cyan">
            <IconFileText size={15} />
          </ThemeIcon>
          <Text size="sm" fw={500} lineClamp={1}>{doc.fileName}</Text>
        </Group>
      ),
    },
    {
      key: 'chunks',
      label: 'Chunks',
      align: 'center',
      width: 90,
      // A document still being ingested has no count yet; 0 would read as
      // "this file produced nothing".
      render: (doc) => (
        <Badge
          variant={typeof doc.chunkCount === 'number' ? 'filled' : 'light'}
          color={typeof doc.chunkCount === 'number' ? 'orange' : 'gray'}
          size="md"
          radius="sm"
        >
          {doc.chunkCount ?? '—'}
        </Badge>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (doc) => (
        <>
          <Group gap={6} wrap="nowrap">
            <Badge variant="light" color={statusColor(doc.status)} size="sm">{doc.status}</Badge>
            {!doc.extraction?.stage && extractionNote(doc) ? (
              <Badge
                variant="outline"
                color="grape"
                size="sm"
                title={doc.extraction?.warnings?.length ? doc.extraction.warnings.join(', ') : undefined}
              >
                {extractionNote(doc)}
              </Badge>
            ) : null}
          </Group>
          {doc.extraction?.stage ? <Text size="xs" c="dimmed" mt={2}>{extractionNote(doc)}</Text> : null}
          {doc.errorMessage && <Text size="xs" c="red" mt={2}>{doc.errorMessage}</Text>}
        </>
      ),
    },
    {
      key: 'indexedAt',
      label: 'Indexed At',
      render: (doc) => <Text size="xs" c="dimmed">{formatDate(doc.lastIndexedAt)}</Text>,
    },
    {
      key: 'createdAt',
      label: 'Created',
      render: (doc) => <Text size="xs" c="dimmed">{formatDate(doc.createdAt)}</Text>,
    },
  ];

  /**
   * The whole-module rebuild is a server-side run now. It used to be a
   * sequential loop of one POST per document from this tab, which died with the
   * tab and left half the module on the old configuration.
   */
  const handleReindexAll = async () => {
    const reindexCount = mod?.totalDocuments ?? docTotal;
    if (!moduleKey || reindexCount === 0) return;
    const ok = await confirm({
      title: tSafe('reindexAll.title'),
      message: tSafe('reindexAll.message', { count: reindexCount }),
      confirmLabel: tSafe('reindexAll.confirm'),
      tone: 'warning',
    });
    if (!ok) return;
    await reindex.start();
  };

  /** Reads the stored original of a document again with the module's current OCR setting (a re-index never does). */
  const handleReextractDocument = async (doc: RagDocumentView) => {
    const ok = await confirm({
      title: 'Re-extract this document?',
      message: `“${doc.fileName}” is read again from its stored original with the module’s current text extraction setting, then indexed again. Scanned pages are read with OCR when it is on, which can take a while and uses the OCR model.`,
      confirmLabel: 'Re-extract',
      tone: 'warning',
    });
    if (!ok) return;
    setReingestingDocId(doc._id);
    try {
      const res = await fetch(
        `/api/rag/modules/${encodeURIComponent(moduleKey!)}/documents/${encodeURIComponent(doc._id)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reextract: true }) },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Re-extract failed');
      }
      notifications.show({ color: 'green', title: 'Re-extract complete', message: `${doc.fileName} was read again.` });
      await loadDocuments();
      await loadModule('refresh');
    } catch (error) {
      notifications.show({ color: 'red', title: 'Re-extract failed', message: String(error) });
    } finally {
      setReingestingDocId(null);
    }
  };

  const handleReingestDocument = async (doc: RagDocumentView) => {
    const ok = await confirm({
      title: tSafe('reingest.title'),
      message: tSafe('reingest.message', { name: doc.fileName }),
      confirmLabel: tSafe('reingest.confirm'),
      tone: 'warning',
    });
    if (!ok) return;
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
    // The snippet has to show what THIS module returns: a text-only module
    // strips everything but the content before the response leaves the API.
    mod.responseDetail === 'text'
      ? `// [{ content: '...' }, ...] — this module's response detail is "text only"`
      : `// [{ score: 0.92, content: '...', fileName: 'doc.txt', chunkIndex: 3 }, ...]`,
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
              {mod.totalDocuments ?? '—'}
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
                value={mod.totalDocuments ?? '—'}
                icon={<IconFileText size={24} />}
                color="cyan"
              />
              <KpiCard
                label="Chunks"
                value={mod.totalChunks ?? '—'}
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
              {insightsError ? (
                <InlineLoadError message={insightsError} onRetry={() => void loadInsights()} />
              ) : (
                <ScoreDistributionChart
                  buckets={scoreBuckets}
                  minScore={mod.defaultMinScore ?? 0}
                  loading={insightsLoading}
                />
              )}
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
                  {zeroQueriesScope === 'own' && (
                    <Text size="sm" c="dimmed">
                      Only your own queries are listed. Knowledge base administrators see everyone&apos;s.
                    </Text>
                  )}
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

              {insightsError ? (
                <InlineLoadError message={insightsError} onRetry={() => void loadInsights()} />
              ) : (
                <DataGrid<RagQueryLogView>
                  records={zeroQueries}
                  rowKey={(log) => log._id}
                  columns={zeroQueryColumns}
                  loading={insightsLoading}
                  empty={{
                    title: zeroQueriesScope === 'own'
                      ? 'None of your queries came back empty.'
                      : 'No zero-result queries logged. Every query found something.',
                  }}
                />
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
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Text Extraction (OCR)</Text>
                  {ocrIsOn(mod.extraction?.ocr) ? (
                    <Text size="sm">{describeOcr(englishOcrText, mod.extraction?.ocr)}</Text>
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
                  {/* Three states. Absent is not "on": the service decides per
                      query, isolating only when another module shares the index. */}
                  <Text size="sm">
                    {typeof mod.isolateByModule !== 'boolean'
                      ? 'Not set — on only while another module shares this index'
                      : mod.isolateByModule
                        ? 'On — queries stay inside this module'
                        : 'Off — the index is shared with an outside pipeline'}
                  </Text>
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Reranker</Text>
                  {mod.rerankerKey ? (
                    <Badge
                      variant="light"
                      color="teal"
                      component={Link}
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
            <Paper withBorder radius="lg" p="lg">
              <ResourceUsageSection type="rag-module" id={mod._id} />
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
                      accept={ocrIsOn(mod.extraction?.ocr) ? `${DOCUMENT_ACCEPT},${IMAGE_ACCEPT}` : DOCUMENT_ACCEPT}
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
                  <Text size="sm" c="dimmed">
                    {debouncedDocSearch
                      ? `${docTotal} document(s) match "${debouncedDocSearch}"`
                      : `${docTotal} document(s) in this module`}
                  </Text>
                </div>
                <Group gap="xs">
                  <Tooltip label="Download every document's source text as JSONL" withArrow>
                    <Button
                      variant="light"
                      size="xs"
                      leftSection={exporting ? <Loader size={12} /> : <IconDownload size={14} />}
                      onClick={() => void handleExport()}
                      disabled={exporting || docsLoading || (mod.totalDocuments ?? docTotal) === 0}
                    >
                      Export
                    </Button>
                  </Tooltip>
                  <Tooltip label="Import a JSONL export; documents are re-chunked and re-embedded with this module" withArrow>
                    <Button
                      variant="light"
                      size="xs"
                      leftSection={importing ? <Loader size={12} /> : <IconUpload size={14} />}
                      onClick={() => importInputRef.current?.click()}
                      disabled={importing}
                    >
                      Import
                    </Button>
                  </Tooltip>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept=".jsonl,.ndjson,application/x-ndjson"
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) void handleImportFile(file);
                    }}
                  />
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
                      disabled={Boolean(reindex.activeRun) || docsLoading || (mod.totalDocuments ?? docTotal) === 0}
                      loading={reindex.busy}
                    >
                      {reindex.activeRun ? 'Re-index running…' : 'Re-index All'}
                    </Button>
                  </Tooltip>
                </Group>
              </Group>

              {docsError ? (
                <InlineLoadError message={docsError} onRetry={() => void loadDocuments()} />
              ) : (
                <DataGrid<RagDocumentView>
                  records={documents}
                  rowKey={(doc) => doc._id}
                  loading={docsLoading}
                  columns={docColumns}
                  search={{
                    value: docSearch,
                    onChange: (value) => {
                      setDocSearch(value);
                      setDocPage(1);
                    },
                    placeholder: 'Search by file name…',
                  }}
                  filters={[
                    {
                      value: docStatus,
                      onChange: (value) => {
                        setDocStatus(value);
                        setDocPage(1);
                      },
                      ariaLabel: 'Filter by status',
                      width: 150,
                      options: [
                        { value: 'all', label: 'All statuses' },
                        { value: 'indexed', label: 'Indexed' },
                        { value: 'processing', label: 'Processing' },
                        { value: 'pending', label: 'Pending' },
                        { value: 'failed', label: 'Failed' },
                      ],
                    },
                  ]}
                  rowActions={(doc) => [
                    {
                      id: 'reingest',
                      label: 'Re-ingest',
                      icon: <IconRefresh size={14} />,
                      disabled: reingestingDocId === doc._id,
                      onClick: () => void handleReingestDocument(doc),
                    },
                    ...(doc.fileKey
                      ? [{
                        id: 'reextract',
                        label: 'Re-extract',
                        icon: <IconScan size={14} />,
                        disabled: reingestingDocId === doc._id || Boolean(doc.extraction?.stage),
                        onClick: () => void handleReextractDocument(doc),
                      }]
                      : []),
                    {
                      id: 'delete',
                      label: 'Delete',
                      icon: <IconTrash size={14} />,
                      color: 'red',
                      onClick: () => void handleDeleteDocument(doc),
                    },
                  ]}
                  onRefresh={() => void loadDocuments()}
                  refreshing={docsLoading}
                  empty={{
                    icon: <IconFileText size={28} />,
                    title: debouncedDocSearch || docStatus !== 'all' ? 'No document matches' : 'No documents yet',
                    description: debouncedDocSearch || docStatus !== 'all'
                      ? 'Try a different search or status filter.'
                      : 'Ingest your first document above.',
                  }}
                  pagination={{
                    page: docPage,
                    onPageChange: setDocPage,
                    pageSize: docPageSize,
                    onPageSizeChange: (size) => {
                      setDocPageSize(size);
                      setDocPage(1);
                    },
                    pageSizeOptions: [10, 25, 50, 100],
                    total: docTotal,
                  }}
                  footerLeft={
                    docTotal === 0
                      ? undefined
                      : `${(docPage - 1) * docPageSize + 1}–${Math.min(docPage * docPageSize, docTotal)} of ${docTotal}`
                  }
                />
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
                    {mod.responseDetail === 'text' ? (
                      <Text size="xs" c="dimmed">
                        This module answers with text only, so the response carries no scores,
                        ids or metadata. Switch Response detail to &quot;Full&quot; to see them.
                      </Text>
                    ) : null}
                  </div>
                </Group>

                {queryResult.matches.length === 0 ? (
                  <Center py="lg">
                    <Text c="dimmed" size="sm">No matches found.</Text>
                  </Center>
                ) : (
                  <Accordion variant="separated" radius="md">
                    {queryResult.matches.map((match, idx) => (
                      <Accordion.Item key={match.id ?? String(idx)} value={String(idx)}>
                        <Accordion.Control>
                          <Group justify="space-between" wrap="nowrap" pr="md">
                            <Group gap="sm">
                              <Badge variant="filled" color="violet" size="sm" radius="sm">
                                #{idx + 1}
                              </Badge>
                              {/* Stripped by a text-only response — the rank badge stands
                                  in for it, rather than claiming an unknown file. */}
                              {match.fileName ? (
                                <Text size="sm" fw={500}>{match.fileName}</Text>
                              ) : null}
                              {typeof match.chunkIndex === 'number' && (
                                <Badge variant="light" color="gray" size="xs">
                                  Chunk {match.chunkIndex}
                                </Badge>
                              )}
                            </Group>
                            {typeof match.score === 'number' ? (
                              <Group gap="xs">
                                <Text size="xs" c="dimmed">Score:</Text>
                                <Badge variant="light" color={scoreColor(match.score)} size="sm">
                                  {match.score.toFixed(4)}
                                </Badge>
                              </Group>
                            ) : null}
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
                  <Text size="sm" c="dimmed">
                    {queryLogScope === 'own'
                      ? 'Your recent queries against this module (last 50). Knowledge base administrators see everyone\'s.'
                      : 'Recent queries against this module (last 50)'}
                  </Text>
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

              {usageError ? (
                <InlineLoadError message={usageError} onRetry={() => void loadUsage()} />
              ) : (
                <DataGrid<RagQueryLogView>
                  records={queryLogs}
                  rowKey={(log) => log._id}
                  columns={historyColumns}
                  loading={usageLoading}
                  empty={{
                    icon: <IconActivity size={32} />,
                    title: queryLogScope === 'own'
                      ? 'You have not queried this module yet.'
                      : 'No queries logged yet. Use the Playground or SDK to run queries.',
                  }}
                />
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
