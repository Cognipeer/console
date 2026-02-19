'use client';

import { useCallback, useEffect, useState } from 'react';
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
  Stack,
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
import PageHeader from '@/components/layout/PageHeader';
import {
  IconArrowLeft,
  IconBook2,
  IconCheck,
  IconClockHour4,
  IconCode,
  IconCopy,
  IconDatabase,
  IconFileText,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconChartBar,
  IconActivity,
  IconFileUpload,
} from '@tabler/icons-react';

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
  chunkConfig: {
    strategy: string;
    chunkSize: number;
    chunkOverlap: number;
    separators?: string[];
    encoding?: string;
  };
  status: string;
  totalDocuments?: number;
  totalChunks?: number;
  createdAt?: string;
  updatedAt?: string;
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
  latencyMs: number;
  createdAt?: string;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function strategyLabel(strategy: string) {
  switch (strategy) {
    case 'recursive_character':
      return 'Recursive Character';
    case 'token':
      return 'Token Based';
    default:
      return strategy;
  }
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

  /* playground */
  const [queryResult, setQueryResult] = useState<RagQueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  /* usage */
  const [queryLogs, setQueryLogs] = useState<RagQueryLogView[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  const queryForm = useForm({
    initialValues: { query: '', topK: 5 },
    validate: {
      query: (v) => (!v.trim() ? 'Query is required' : null),
      topK: (v) => (v < 1 ? 'Must be at least 1' : null),
    },
  });

  /* ── Data loading ────────────────────────────────────────────────────── */

  const loadModule = useCallback(
    async (isRefresh = false) => {
      if (!moduleKey) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/rag/modules/${encodeURIComponent(moduleKey)}`, { cache: 'no-store' });
        if (!res.ok) {
          if (res.status === 404) { router.push('/dashboard/rag'); return; }
          throw new Error('Failed to load RAG module');
        }
        const data = await res.json();
        setMod(data.module ?? null);
      } catch (error) {
        console.error(error);
        notifications.show({ color: 'red', title: 'Error', message: String(error) });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [moduleKey, router],
  );

  const loadDocuments = useCallback(async () => {
    if (!moduleKey) return;
    setDocsLoading(true);
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
      }
    } catch (e) {
      console.error('[rag usage]', e);
    } finally {
      setUsageLoading(false);
    }
  }, [moduleKey]);

  useEffect(() => {
    void loadModule(false);
  }, [loadModule]);

  useEffect(() => {
    if (mod) {
      void loadDocuments();
      void loadUsage();
    }
  }, [mod, loadDocuments, loadUsage]);

  /* ── Actions ──────────────────────────────────────────────────────────── */

  const handleDelete = async () => {
    if (!mod) return;
    if (!window.confirm(`Delete RAG module "${mod.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(mod.key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete module');
      notifications.show({ color: 'green', title: 'Deleted', message: `${mod.name} removed.` });
      router.push('/dashboard/rag');
    } catch (error) {
      notifications.show({ color: 'red', title: 'Error', message: String(error) });
    }
  };

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
        body: JSON.stringify({ fileName: ingestFileName.trim(), content: ingestContent }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to ingest document');
      }
      notifications.show({ color: 'green', title: 'Document ingested', message: `${ingestFileName} is being processed.` });
      setIngestFileName('');
      setIngestContent('');
      await loadDocuments();
      await loadModule(true);
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
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to ingest file');
      }
      notifications.show({ color: 'green', title: 'File ingested', message: `${ingestFile.name} is being processed.` });
      setIngestFile(null);
      await loadDocuments();
      await loadModule(true);
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
      await loadModule(true);
    } catch (error) {
      notifications.show({ color: 'red', title: 'Error', message: String(error) });
    }
  };

  const [reingestingDocId, setReingestingDocId] = useState<string | null>(null);

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
      await loadModule(true);
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
        body: JSON.stringify({ query: values.query, topK: values.topK }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Query failed');
      }
      const data = await res.json();
      setQueryResult(data.result ?? null);
      // refresh usage after query
      void loadUsage();
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
          <Text c="dimmed">RAG module not found.</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/rag')}>
            Back to RAG modules
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
    `import CognipeerClient from '@cognipeer/console-sdk';`,
    ``,
    `const client = new CognipeerClient({`,
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
    <Stack gap="md">
      <PageHeader
        icon={<IconBook2 size={18} />}
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
              leftSection={refreshing ? <Loader size={12} /> : <IconRefresh size={14} />}
              onClick={() => void loadModule(true)}
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
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                      Documents
                    </Text>
                    <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                      {mod.totalDocuments ?? 0}
                    </Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="cyan">
                    <IconFileText size={24} />
                  </ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                      Chunks
                    </Text>
                    <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                      {mod.totalChunks ?? 0}
                    </Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="orange">
                    <IconDatabase size={24} />
                  </ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                      Total Queries
                    </Text>
                    <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                      {queryLogs.length}
                    </Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="violet">
                    <IconSearch size={24} />
                  </ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                      Avg Latency
                    </Text>
                    <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                      {queryLogs.length > 0
                        ? `${Math.round(queryLogs.reduce((s, l) => s + l.latencyMs, 0) / queryLogs.length)}ms`
                        : '—'}
                    </Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="teal">
                    <IconClockHour4 size={24} />
                  </ThemeIcon>
                </Group>
              </Paper>
            </SimpleGrid>

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
                <Stack gap={4}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Created</Text>
                  <Text size="sm">{formatDate(mod.createdAt)}</Text>
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
                  <Text size="sm" c="dimmed">Add a new document to this RAG module. Upload a file or paste text content.</Text>
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
                    <Group justify="flex-end">
                      <Button
                        leftSection={ingesting ? <Loader size={14} /> : <IconFileUpload size={14} />}
                        onClick={() => void handleFileIngest()}
                        disabled={ingesting || !ingestFile}
                        loading={ingesting}
                      >
                        Upload &amp; Ingest
                      </Button>
                    </Group>
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
                    <Group justify="flex-end">
                      <Button
                        leftSection={ingesting ? <Loader size={14} /> : <IconFileUpload size={14} />}
                        onClick={() => void handleIngest()}
                        disabled={ingesting || !ingestFileName.trim() || !ingestContent.trim()}
                        loading={ingesting}
                      >
                        Ingest Document
                      </Button>
                    </Group>
                  </>
                )}
              </Stack>
            </Paper>

            {/* Document List */}
            <Paper withBorder radius="lg" p="lg">
              <Group justify="space-between" mb="md">
                <div>
                  <Text fw={600} size="lg">Documents</Text>
                  <Text size="sm" c="dimmed">{documents.length} document(s) in this module</Text>
                </div>
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
                Ask questions against this RAG module. The system will embed your query, search the vector index, and return the most relevant chunks.
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
    </Stack>
  );
}
