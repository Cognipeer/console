'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Center,
  Code,
  CopyButton,
  Grid,
  Group,
  Loader,
  NumberInput,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconActivity,
  IconArrowLeft,
  IconBook,
  IconCalendar,
  IconChartBar,
  IconCheck,
  IconClockHour4,
  IconCode,
  IconCopy,
  IconDatabase,
  IconDeviceFloppy,
  IconPlayerPlay,
  IconRefresh,
  IconRuler2,
  IconTargetArrow,
  IconTrash,
} from '@tabler/icons-react';
import type { VectorIndexRecord, VectorQueryResponse, VectorProviderView } from '@/lib/services/vector';
import EditVectorIndexModal from '@/components/vector/EditVectorIndexModal';
import UpsertVectorItemModal from '@/components/vector/UpsertVectorItemModal';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface DailyStats {
  date: string;
  queryCount: number;
  avgLatencyMs: number;
  avgScore: number;
  filterCount: number;
}

interface StatsData {
  daily: DailyStats[];
  totals: {
    totalQueries: number;
    avgLatencyMs: number;
    minLatencyMs: number;
    maxLatencyMs: number;
    avgScore: number;
  };
  topKDistribution: Array<{ topK: number; count: number }>;
  days: number;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatBytes(bytes?: number) {
  if (!bytes) return '—';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function stringifyMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return '—';
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return '—';
  }
}

function resolveProviderHandle(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  const candidates = ['providerExternalId', 'indexArn', 'externalId', 'arn'];
  for (const key of candidates) {
    const value = metadata[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function resolveBucketName(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  const raw = metadata['bucketName'];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

interface KpiCardProps {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: string;
}

function KpiCard({ icon, color, label, value }: KpiCardProps) {
  return (
    <Paper withBorder radius="lg" p="md">
      <Group gap={8} mb={4}>
        <ThemeIcon variant="light" color={color} size="sm" radius="md">
          {icon}
        </ThemeIcon>
        <Text size="xs" c="dimmed" tt="uppercase" fw={500}>
          {label}
        </Text>
      </Group>
      <Text fw={700} size="lg">{value}</Text>
    </Paper>
  );
}

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

/* ── Page ─────────────────────────────────────────────────────────────── */

export default function VectorIndexDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const providerKeyParam = params.providerKey;
  const indexKeyParam = params.externalId;
  const providerKey = Array.isArray(providerKeyParam) ? providerKeyParam[0] : providerKeyParam;
  const indexKey = Array.isArray(indexKeyParam) ? indexKeyParam[0] : indexKeyParam;

  const [provider, setProvider] = useState<VectorProviderView | null>(null);
  const [index, setIndex] = useState<VectorIndexRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [queryResult, setQueryResult] = useState<VectorQueryResponse | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [upsertModalOpen, setUpsertModalOpen] = useState(false);
  const [deleteVectorId, setDeleteVectorId] = useState('');
  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  const description = useMemo(() => {
    if (!index?.metadata) return '';
    const value = index.metadata.description;
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    return String(value);
  }, [index?.metadata]);

  const providerHandle = useMemo(() => resolveProviderHandle(index?.metadata), [index?.metadata]);
  const bucketName = useMemo(() => resolveBucketName(index?.metadata), [index?.metadata]);

  const queryForm = useForm({
    initialValues: {
      vector: '',
      topK: 5,
      filter: '',
    },
    validate: {
      vector: (value) => (!value ? 'Vector values are required' : null),
      topK: (value) => (value <= 0 ? 'Top K must be positive' : null),
    },
  });

  const loadIndex = useCallback(async (isRefresh = false) => {
    if (!providerKey || !indexKey) {
      setIndex(null);
      setProvider(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(indexKey)}?providerKey=${encodeURIComponent(providerKey)}`,
        { cache: 'no-store' },
      );
      if (!response.ok) {
        if (response.status === 404) {
          router.push('/dashboard/vector');
          return;
        }
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to load vector index');
      }
      const data = await response.json();
      setIndex(data.index ?? null);
      setProvider(data.provider ?? null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [providerKey, indexKey, router]);

  const loadStats = useCallback(async () => {
    if (!providerKey || !indexKey) return;
    setStatsLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      params.set('providerKey', providerKey);
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(indexKey)}/stats?${params.toString()}`,
        { cache: 'no-store' },
      );
      if (response.ok) {
        const data = await response.json();
        setStats(data as StatsData);
      }
    } catch (error) {
      console.error('[vector stats]', error);
    } finally {
      setStatsLoading(false);
    }
  }, [providerKey, indexKey, dateFilter]);

  useEffect(() => {
    void loadIndex(false);
  }, [loadIndex]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const handleDelete = async () => {
    if (!provider || !index) return;
    const confirmed = window.confirm(`Delete index "${index.name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}?providerKey=${encodeURIComponent(provider.key)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to delete index');
      }
      notifications.show({
        color: 'green',
        title: 'Vector index deleted',
        message: `${index.name} has been removed.`,
      });
      router.push('/dashboard/vector');
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to delete index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleUpdateIndex = async (values: { name: string; description?: string }) => {
    if (!provider || !index) return;
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name,
            metadata: values.description ? { description: values.description } : {},
          }),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to update index');
      }
      const data = await response.json();
      setIndex(data.index ?? null);
      notifications.show({
        color: 'green',
        title: 'Index updated',
        message: `${values.name} has been updated.`,
      });
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to update index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleQuery = queryForm.onSubmit(async (values) => {
    if (!provider || !index) return;
    setQueryLoading(true);
    setQueryResult(null);
    try {
      const vector = values.vector
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
        .map((segment) => Number(segment));

      if (vector.length === 0 || vector.some((value) => Number.isNaN(value))) {
        throw new Error('Vector must contain numeric values separated by commas.');
      }

      let filter: Record<string, unknown> | undefined;
      if (values.filter) {
        try {
          filter = JSON.parse(values.filter) as Record<string, unknown>;
        } catch {
          throw new Error('Filter must be valid JSON.');
        }
      }

      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}/query?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: { vector, topK: values.topK, filter } }),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to run query');
      }
      const data = await response.json();
      setQueryResult(data.result ?? null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Query failed',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setQueryLoading(false);
    }
  });

  const handleUpsertItem = async (payload: { id: string; values: number[]; metadata?: Record<string, unknown> }) => {
    if (!provider || !index) return;
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}/upsert?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vectors: [{ id: payload.id, values: payload.values, metadata: payload.metadata }],
          }),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to upsert item');
      }
      notifications.show({
        color: 'green',
        title: 'Vector item upserted',
        message: `${payload.id} has been stored.`,
      });
      await loadIndex();
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to upsert item',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!provider || !index) return;
    const confirmed = window.confirm(`Remove vector item "${itemId}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(index.key)}/vectors?providerKey=${encodeURIComponent(provider.key)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [itemId] }),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to delete vector item');
      }
      notifications.show({
        color: 'green',
        title: 'Vector item removed',
        message: `${itemId} has been deleted.`,
      });
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to delete item',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  if (!index || !provider) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">Vector index not found.</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/vector')}>
            Back to vector indexes
          </Button>
        </Stack>
      </Center>
    );
  }

  const vectorCount = typeof index.metadata?.vectorCount === 'number' ? index.metadata.vectorCount : undefined;
  const indexSize = typeof index.metadata?.indexSize === 'number' ? index.metadata.indexSize : undefined;
  const lastIndexed = index.metadata?.lastIndexed as string | undefined;

  /* ── Usage code snippets ── */
  const curlUpsert = [
    `curl -X POST https://your-cgate-host/api/client/v1/vector/providers/${providerKey}/indexes/${indexKey}/upsert \\`,
    `  -H "Authorization: Bearer YOUR_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "vectors": [`,
    `      {`,
    `        "id": "vec-001",`,
    `        "values": [0.1, 0.2, 0.3, 0.4],`,
    `        "metadata": { "source": "doc-1", "category": "support" }`,
    `      }`,
    `    ]`,
    `  }'`,
  ].join('\n');

  const curlQuery = [
    `curl -X POST https://your-cgate-host/api/client/v1/vector/providers/${providerKey}/indexes/${indexKey}/query \\`,
    `  -H "Authorization: Bearer YOUR_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "query": {`,
    `      "vector": [0.1, 0.2, 0.3, 0.4],`,
    `      "topK": 10,`,
    `      "filter": { "category": "support" }`,
    `    }`,
    `  }'`,
  ].join('\n');

  const sdkUpsert = [
    `import CgateClient from '@cognipeer/cgate-sdk';`,
    ``,
    `const client = new CgateClient({`,
    `  apiKey: 'YOUR_API_TOKEN',`,
    `  baseUrl: 'https://your-cgate-host',`,
    `});`,
    ``,
    `await client.vectors.upsert('${providerKey}', '${indexKey}', {`,
    `  vectors: [`,
    `    {`,
    `      id: 'vec-001',`,
    `      values: [0.1, 0.2, 0.3, 0.4],`,
    `      metadata: { source: 'doc-1', category: 'support' },`,
    `    },`,
    `  ],`,
    `});`,
  ].join('\n');

  const sdkQuery = [
    `import CgateClient from '@cognipeer/cgate-sdk';`,
    ``,
    `const client = new CgateClient({`,
    `  apiKey: 'YOUR_API_TOKEN',`,
    `  baseUrl: 'https://your-cgate-host',`,
    `});`,
    ``,
    `const result = await client.vectors.query('${providerKey}', '${indexKey}', {`,
    `  query: {`,
    `    vector: [0.1, 0.2, 0.3, 0.4],`,
    `    topK: 10,`,
    `    filter: { category: 'support' },`,
    `  },`,
    `});`,
    ``,
    `console.log(result.matches);`,
    `// [{ id: 'vec-001', score: 0.9832, metadata: { source: 'doc-1' } }, ...]`,
  ].join('\n');

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconDatabase size={18} />}
        title={index.name}
        subtitle={`Provider ${provider.label} • Driver ${provider.driver}`}
        actions={
          <>
            <Badge>{index.metric}</Badge>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/vector')}
            >
              Back
            </Button>
            <Button
              onClick={() => openDocs('api-vectors')}
              variant="light"
              size="xs"
              leftSection={<IconBook size={14} />}
            >
              Docs
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              onClick={() => void loadIndex(true)}
              loading={refreshing}
            >
              Refresh
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconDeviceFloppy size={14} />}
              onClick={() => setEditModalOpen(true)}
            >
              Edit details
            </Button>
            <Button color="red" size="xs" leftSection={<IconTrash size={14} />} onClick={() => void handleDelete()}>
              Delete
            </Button>
          </>
        }
      />

      <Group justify="flex-end">
        <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
      </Group>

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconDatabase size={14} />}>Overview</Tabs.Tab>
          <Tabs.Tab value="details" leftSection={<IconActivity size={14} />}>Details</Tabs.Tab>
          <Tabs.Tab value="playground" leftSection={<IconPlayerPlay size={14} />}>Playground</Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconCode size={14} />}>Usage</Tabs.Tab>
        </Tabs.List>

        {/* ════════════════ Overview Tab ════════════════ */}
        <Tabs.Panel value="overview">
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 6 }}>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Dimension</Text>
                    <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>{index.dimension}</Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="violet"><IconRuler2 size={24} /></ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Metric</Text>
                    <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} tt="capitalize">{index.metric}</Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="teal"><IconTargetArrow size={24} /></ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Vectors</Text>
                    <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                      {vectorCount !== undefined ? vectorCount.toLocaleString() : '—'}
                    </Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="blue"><IconDatabase size={24} /></ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Index Size</Text>
                    <Text fw={600} size="sm" style={{ paddingTop: '0.4rem' }}>{formatBytes(indexSize)}</Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="grape"><IconActivity size={24} /></ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Created</Text>
                    <Text fw={600} size="sm" style={{ paddingTop: '0.4rem' }}>{formatDate(index.createdAt)}</Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="blue"><IconCalendar size={24} /></ThemeIcon>
                </Group>
              </Paper>
              <Paper withBorder radius="lg" p="lg">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Last Updated</Text>
                    <Text fw={600} size="sm" style={{ paddingTop: '0.4rem' }}>{formatDate(index.updatedAt)}</Text>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color="orange"><IconRefresh size={24} /></ThemeIcon>
                </Group>
              </Paper>
            </SimpleGrid>

            <Grid>
              <Grid.Col span={{ base: 12, md: 8 }}>
                <Paper withBorder radius="lg" p="lg" h="100%">
                  <Stack gap="sm">
                    <Text fw={600}>Index Information</Text>
                    <Group justify="space-between">
                      <Text size="sm" c="dimmed">Provider</Text>
                      <Text size="sm" fw={500}>{provider.label}</Text>
                    </Group>
                    <Group justify="space-between">
                      <Text size="sm" c="dimmed">Driver</Text>
                      <Text size="sm" fw={500}>{provider.driver}</Text>
                    </Group>
                    <Group justify="space-between">
                      <Text size="sm" c="dimmed">Index Key</Text>
                      <Text size="sm" fw={500} style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>{index.key}</Text>
                    </Group>
                    {providerHandle ? (
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">Provider Handle</Text>
                        <Text size="sm" fw={500}>{providerHandle}</Text>
                      </Group>
                    ) : null}
                    {bucketName ? (
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">Bucket</Text>
                        <Text size="sm" fw={500}>{bucketName}</Text>
                      </Group>
                    ) : null}
                    {lastIndexed ? (
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">Last Indexed</Text>
                        <Text size="sm" fw={500}>{formatDate(lastIndexed)}</Text>
                      </Group>
                    ) : null}
                    {description ? (
                      <>
                        <Text size="sm" c="dimmed" mt="xs">Description</Text>
                        <Text size="sm">{description}</Text>
                      </>
                    ) : null}
                  </Stack>
                </Paper>
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 4 }}>
                <Paper withBorder radius="lg" p="lg" h="100%">
                  <Stack gap="sm">
                    <Text fw={600}>Quick Actions</Text>
                    <Button fullWidth onClick={() => setUpsertModalOpen(true)}>
                      Upsert vector
                    </Button>
                    <Button
                      fullWidth
                      variant="light"
                      onClick={() => setEditModalOpen(true)}
                      leftSection={<IconDeviceFloppy size={14} />}
                    >
                      Edit details
                    </Button>
                    <Button
                      fullWidth
                      variant="light"
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={() => void handleDelete()}
                    >
                      Delete index
                    </Button>
                  </Stack>
                </Paper>
              </Grid.Col>
            </Grid>

            {statsLoading ? (
              <Center py="xl"><Loader size="sm" /></Center>
            ) : (
              <Stack gap="md">
                <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }}>
                  <KpiCard
                    icon={<IconActivity size={16} />}
                    color="blue"
                    label="Total Queries"
                    value={stats ? stats.totals.totalQueries.toLocaleString() : '—'}
                  />
                  <KpiCard
                    icon={<IconClockHour4 size={16} />}
                    color="orange"
                    label="Avg Latency"
                    value={stats ? `${stats.totals.avgLatencyMs} ms` : '—'}
                  />
                  <KpiCard
                    icon={<IconClockHour4 size={16} />}
                    color="teal"
                    label="Min Latency"
                    value={stats ? `${stats.totals.minLatencyMs} ms` : '—'}
                  />
                  <KpiCard
                    icon={<IconClockHour4 size={16} />}
                    color="red"
                    label="Max Latency"
                    value={stats ? `${stats.totals.maxLatencyMs} ms` : '—'}
                  />
                  <KpiCard
                    icon={<IconTargetArrow size={16} />}
                    color="violet"
                    label="Avg Score"
                    value={stats ? stats.totals.avgScore.toFixed(3) : '—'}
                  />
                </SimpleGrid>

                <Paper withBorder radius="lg" p="lg">
                  <Group gap={8} mb="md">
                    <ThemeIcon variant="light" color="blue" radius="md"><IconChartBar size={16} /></ThemeIcon>
                    <Text fw={600}>Daily Query Volume (last {stats?.days ?? 30} days)</Text>
                  </Group>
                  {stats && stats.daily.some((d) => d.queryCount > 0) ? (
                    <AreaChart
                      h={240}
                      data={stats.daily}
                      dataKey="date"
                      series={[{ name: 'queryCount', label: 'Queries', color: 'blue.6' }]}
                      curveType="monotone"
                      withDots={false}
                      withGradient
                      gridAxis="xy"
                      tooltipAnimationDuration={200}
                    />
                  ) : (
                    <Center h={240}>
                      <Text size="sm" c="dimmed">No query data for the selected period.</Text>
                    </Center>
                  )}
                </Paper>

                <Grid>
                  <Grid.Col span={{ base: 12, md: 6 }}>
                    <Paper withBorder radius="lg" p="lg">
                      <Group gap={8} mb="md">
                        <ThemeIcon variant="light" color="orange" radius="md"><IconClockHour4 size={16} /></ThemeIcon>
                        <Text fw={600}>Avg Latency (ms)</Text>
                      </Group>
                      {stats && stats.daily.some((d) => d.avgLatencyMs > 0) ? (
                        <AreaChart
                          h={200}
                          data={stats.daily}
                          dataKey="date"
                          series={[{ name: 'avgLatencyMs', label: 'Latency (ms)', color: 'orange.6' }]}
                          curveType="monotone"
                          withDots={false}
                          withGradient
                          gridAxis="xy"
                          tooltipAnimationDuration={200}
                        />
                      ) : (
                        <Center h={200}><Text size="sm" c="dimmed">No latency data.</Text></Center>
                      )}
                    </Paper>
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 6 }}>
                    <Paper withBorder radius="lg" p="lg">
                      <Group gap={8} mb="md">
                        <ThemeIcon variant="light" color="violet" radius="md"><IconTargetArrow size={16} /></ThemeIcon>
                        <Text fw={600}>Avg Similarity Score</Text>
                      </Group>
                      {stats && stats.daily.some((d) => d.avgScore > 0) ? (
                        <AreaChart
                          h={200}
                          data={stats.daily}
                          dataKey="date"
                          series={[{ name: 'avgScore', label: 'Avg Score', color: 'violet.6' }]}
                          curveType="monotone"
                          withDots={false}
                          withGradient
                          gridAxis="xy"
                          tooltipAnimationDuration={200}
                        />
                      ) : (
                        <Center h={200}><Text size="sm" c="dimmed">No score data.</Text></Center>
                      )}
                    </Paper>
                  </Grid.Col>
                </Grid>

                {stats && stats.topKDistribution.length > 0 && (
                  <Paper withBorder radius="lg" p="lg">
                    <Text fw={600} mb="md">Top-K Distribution</Text>
                    <Table highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Top K</Table.Th>
                          <Table.Th>Query Count</Table.Th>
                          <Table.Th>Share</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {stats.topKDistribution.map((row) => {
                          const pct = stats.totals.totalQueries > 0
                            ? ((row.count / stats.totals.totalQueries) * 100).toFixed(1)
                            : '0.0';
                          return (
                            <Table.Tr key={row.topK}>
                              <Table.Td><Text size="sm" fw={500}>{row.topK}</Text></Table.Td>
                              <Table.Td>{row.count.toLocaleString()}</Table.Td>
                              <Table.Td>{pct}%</Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </Paper>
                )}
              </Stack>
            )}
          </Stack>
        </Tabs.Panel>

        {/* ════════════════ Details Tab ════════════════ */}
        <Tabs.Panel value="details">
          <Stack gap="md">
            <Paper withBorder radius="lg" p="lg">
              <Stack gap="sm">
                <Text fw={600}>Index Identifiers</Text>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Index Key</Text>
                  <Group gap="xs">
                    <Code fz="xs">{index.key}</Code>
                    <CopyButton value={index.key} timeout={2000}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                          <Button
                            size="xs"
                            variant={copied ? 'filled' : 'subtle'}
                            color={copied ? 'teal' : 'gray'}
                            onClick={copy}
                            leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                          >
                            {copied ? 'Copied' : 'Copy'}
                          </Button>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </Group>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">External ID</Text>
                  <Group gap="xs">
                    <Code fz="xs">{index.externalId}</Code>
                    <CopyButton value={index.externalId} timeout={2000}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                          <Button
                            size="xs"
                            variant={copied ? 'filled' : 'subtle'}
                            color={copied ? 'teal' : 'gray'}
                            onClick={copy}
                            leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                          >
                            {copied ? 'Copied' : 'Copy'}
                          </Button>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </Group>
                </Group>
                {providerHandle ? (
                  <Group justify="space-between">
                    <Text size="sm" c="dimmed">Provider Handle</Text>
                    <Code fz="xs">{providerHandle}</Code>
                  </Group>
                ) : null}
                {bucketName ? (
                  <Group justify="space-between">
                    <Text size="sm" c="dimmed">Bucket Name</Text>
                    <Code fz="xs">{bucketName}</Code>
                  </Group>
                ) : null}
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Dimension</Text>
                  <Text size="sm" fw={500}>{index.dimension}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Metric</Text>
                  <Text size="sm" fw={500} tt="capitalize">{index.metric}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Provider</Text>
                  <Text size="sm" fw={500}>{provider.label} ({provider.driver})</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Created</Text>
                  <Text size="sm">{formatDate(index.createdAt)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Updated</Text>
                  <Text size="sm">{formatDate(index.updatedAt)}</Text>
                </Group>
              </Stack>
            </Paper>

            {index.metadata && Object.keys(index.metadata).length > 0 ? (
              <Paper withBorder radius="lg" p="lg">
                <Text fw={600} mb="sm">Raw Metadata</Text>
                <ScrollArea type="auto">
                  <Code block fz="xs" style={{ whiteSpace: 'pre-wrap' }}>
                    {stringifyMetadata(index.metadata)}
                  </Code>
                </ScrollArea>
              </Paper>
            ) : null}
          </Stack>
        </Tabs.Panel>

        {/* ════════════════ Playground Tab ════════════════ */}
        <Tabs.Panel value="playground">
          <Group align="flex-start" grow>
            <Paper withBorder radius="lg" p="lg" style={{ flex: 1 }}>
              <Stack gap="md">
                <Stack gap="xs">
                  <Text fw={600}>Manage vectors</Text>
                  <Text size="sm" c="dimmed">
                    Vectors live in your provider. Use these actions to sync data without storing local snapshots.
                  </Text>
                </Stack>
                <Group justify="flex-start">
                  <Button onClick={() => setUpsertModalOpen(true)}>Upsert vector</Button>
                </Group>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const trimmed = deleteVectorId.trim();
                    if (!trimmed) {
                      notifications.show({
                        color: 'yellow',
                        title: 'Vector ID required',
                        message: 'Enter the vector identifier you want to remove.',
                      });
                      return;
                    }
                    void (async () => {
                      await handleDeleteItem(trimmed);
                      setDeleteVectorId('');
                    })();
                  }}
                >
                  <Stack gap="xs">
                    <Text size="sm" fw={500}>Delete vector by ID</Text>
                    <TextInput
                      placeholder="vector-id"
                      value={deleteVectorId}
                      onChange={(event) => setDeleteVectorId(event.currentTarget.value)}
                    />
                    <Group justify="flex-end">
                      <Button type="submit" variant="light" color="red" leftSection={<IconTrash size={16} />}>
                        Delete
                      </Button>
                    </Group>
                  </Stack>
                </form>
                <Text size="xs" c="dimmed">
                  Need bulk operations? Use the API endpoints or your provider&apos;s console for imports and exports.
                </Text>
              </Stack>
            </Paper>

            <Paper withBorder radius="lg" p="lg" style={{ flex: 1 }}>
              <Stack gap="md">
                <Text fw={600}>Run similarity query</Text>
                <form onSubmit={handleQuery}>
                  <Stack gap="sm">
                    <Textarea
                      label="Vector"
                      placeholder="1.2, 3.4, ..."
                      minRows={3}
                      autosize
                      {...queryForm.getInputProps('vector')}
                    />
                    <NumberInput
                      label="Top K"
                      min={1}
                      {...queryForm.getInputProps('topK')}
                    />
                    <Textarea
                      label="Filter (JSON)"
                      placeholder='{ "category": "support" }'
                      minRows={2}
                      autosize
                      {...queryForm.getInputProps('filter')}
                    />
                    <Group justify="flex-end">
                      <Button type="submit" loading={queryLoading}>Run query</Button>
                    </Group>
                  </Stack>
                </form>

                {queryResult && (
                  <Stack gap="sm">
                    <Text size="sm" c="dimmed">{queryResult.matches.length} matches</Text>
                    <Table highlightOnHover verticalSpacing="sm">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>ID</Table.Th>
                          <Table.Th>Score</Table.Th>
                          <Table.Th>Metadata</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {queryResult.matches.map((match) => (
                          <Table.Tr key={match.id}>
                            <Table.Td>{match.id}</Table.Td>
                            <Table.Td>{match.score.toFixed(4)}</Table.Td>
                            <Table.Td>
                              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                                {stringifyMetadata(match.metadata)}
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Stack>
                )}
              </Stack>
            </Paper>
          </Group>
        </Tabs.Panel>

        {/* ════════════════ Usage Tab ════════════════ */}
        <Tabs.Panel value="usage">
          <Stack gap="md">
            <Paper withBorder radius="lg" p="lg">
              <Text fw={600} mb="sm">Index Reference</Text>
              <Stack gap="xs">
                <Group gap="sm">
                  <Text size="sm" c="dimmed" style={{ minWidth: 120 }}>Provider Key</Text>
                  <Code fz="sm">{providerKey}</Code>
                  <CopyButton value={providerKey ?? ''} timeout={2000}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                        <Button
                          size="xs"
                          variant={copied ? 'filled' : 'subtle'}
                          color={copied ? 'teal' : 'gray'}
                          onClick={copy}
                          leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
                <Group gap="sm">
                  <Text size="sm" c="dimmed" style={{ minWidth: 120 }}>Index Key</Text>
                  <Code fz="sm">{indexKey}</Code>
                  <CopyButton value={indexKey ?? ''} timeout={2000}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                        <Button
                          size="xs"
                          variant={copied ? 'filled' : 'subtle'}
                          color={copied ? 'teal' : 'gray'}
                          onClick={copy}
                          leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
              </Stack>
            </Paper>

            <UsageCodeBlock title="cURL — Upsert Vectors" code={curlUpsert} />
            <UsageCodeBlock title="cURL — Similarity Query" code={curlQuery} />
            <UsageCodeBlock title="TypeScript SDK — Upsert" code={sdkUpsert} />
            <UsageCodeBlock title="TypeScript SDK — Query" code={sdkQuery} />

            <Paper withBorder radius="lg" p="lg">
              <Text fw={600} mb="xs">Query Response Format</Text>
              <Text size="xs" c="dimmed" mb="sm">
                Replace <Code fz="xs">YOUR_API_TOKEN</Code> with an API token from Settings → API Tokens.
              </Text>
              <Code block fz="xs">{[
                '{',
                '  "result": {',
                '    "matches": [',
                '      {',
                '        "id": "vec-001",',
                '        "score": 0.9832,',
                '        "metadata": { "source": "doc-1", "category": "support" }',
                '      }',
                '    ]',
                '  }',
                '}',
              ].join('\n')}</Code>
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <EditVectorIndexModal
        opened={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        initialName={index.name}
        initialDescription={description}
        onSubmit={handleUpdateIndex}
      />

      <UpsertVectorItemModal
        opened={upsertModalOpen}
        onClose={() => setUpsertModalOpen(false)}
        expectedDimension={index.dimension}
        onSubmit={handleUpsertItem}
      />
    </Stack>
  );
}
