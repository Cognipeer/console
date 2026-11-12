'use client';

import { useEffect, useMemo, useState } from 'react';
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
  Tabs,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { ResourceUsageSection, useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
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
import type { VectorQueryResponse } from '@/lib/services/vector';
import { errorMessage, isApiError } from '@/lib/api/client';
import {
  useDeleteVectorIndex,
  useDeleteVectorItem,
  useQueryVectorIndex,
  useUpdateVectorIndex,
  useUpsertVectorItem,
  useVectorIndex,
  useVectorIndexStats,
} from '@/lib/api/queries/vector';
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
  /** Live count from the provider; undefined when it cannot report one. */
  vectorCount?: number;
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
  const params = useParams()!;
  const router = useRouter();
  const deleteResource = useDeleteResource();
  const tSafe = useTranslations('common.confirm.dataSafety');
  const tPlatform = useTranslations('platformStorage');
  const { openDocs } = useDocsDrawer();
  const providerKeyParam = params.providerKey;
  const indexKeyParam = params.externalId;
  const providerKey = Array.isArray(providerKeyParam) ? providerKeyParam[0] : providerKeyParam;
  const indexKey = Array.isArray(indexKeyParam) ? indexKeyParam[0] : indexKeyParam;

  const indexQuery = useVectorIndex(providerKey, indexKey);
  const provider = indexQuery.data?.provider ?? null;
  const index = indexQuery.data?.index ?? null;
  // First load only: a refresh keeps the page on screen.
  const loading = indexQuery.isLoading;
  const refreshing = indexQuery.isFetching && !indexQuery.isLoading;
  const [queryResult, setQueryResult] = useState<VectorQueryResponse | null>(null);
  const runQuery = useQueryVectorIndex();
  const queryLoading = runQuery.isPending;
  const deleteIndex = useDeleteVectorIndex();
  const updateIndex = useUpdateVectorIndex();
  const upsertItem = useUpsertVectorItem();
  const deleteItem = useDeleteVectorItem();
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [upsertModalOpen, setUpsertModalOpen] = useState(false);
  const [deleteVectorId, setDeleteVectorId] = useState('');
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const statsParams = useMemo(() => {
    const params = buildDashboardDateSearchParams(dateFilter);
    if (providerKey) params.set('providerKey', providerKey);
    return params;
  }, [dateFilter, providerKey]);
  const statsQuery = useVectorIndexStats<StatsData>(providerKey, indexKey, statsParams);
  const stats = statsQuery.data ?? null;
  const statsLoading = statsQuery.isFetching;

  const description = useMemo(() => {
    if (!index?.metadata) return '';
    const value = index.metadata.description;
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    return String(value);
  }, [index?.metadata]);

  /** Operators this driver can push down, declared by its provider contract. */
  const filterOperators = useMemo(() => {
    const declared = provider?.driverCapabilities?.['vector.filterOperators'];
    return Array.isArray(declared) ? declared.map(String) : [];
  }, [provider?.driverCapabilities]);

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

  // A missing index sends the user back to the list; any other failure to load it is told.
  const loadError = indexQuery.error;
  useEffect(() => {
    if (!loadError) return;
    if (isApiError(loadError) && loadError.status === 404) {
      router.push('/dashboard/vector');
      return;
    }
    console.error(loadError);
    notifications.show({
      color: 'red',
      title: 'Unable to load index',
      message: errorMessage(loadError, 'Unexpected error'),
    });
  }, [loadError, router]);

  const handleDelete = async () => {
    if (!provider || !index) return;
    await deleteResource({
      noun: tSafe('nouns.vectorIndex'),
      name: index.name,
      type: 'vector-index',
      id: index._id ? String(index._id) : undefined,
      extraWarning: tSafe('vectorIndexExtra'),
      action: async () => {
        try {
          await deleteIndex.mutateAsync({ indexKey: index.key, providerKey: provider.key });
        } catch (error) {
          throw new Error(errorMessage(error, 'Failed to delete index'));
        }
        notifications.show({
          color: 'green',
          title: 'Vector index deleted',
          message: `${index.name} has been removed.`,
        });
        router.push('/dashboard/vector');
      },
    });
  };

  const handleUpdateIndex = async (values: { name: string; description?: string }) => {
    if (!provider || !index) return;
    try {
      await updateIndex.mutateAsync({
        indexKey: index.key,
        providerKey: provider.key,
        name: values.name,
        metadata: values.description ? { description: values.description } : {},
      });
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
        message: errorMessage(error, 'Unexpected error'),
      });
    }
  };

  const handleQuery = queryForm.onSubmit(async (values) => {
    if (!provider || !index) return;
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

      setQueryResult(
        await runQuery.mutateAsync({
          indexKey: index.key,
          providerKey: provider.key,
          vector,
          topK: values.topK,
          filter,
        }),
      );
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Query failed',
        message: errorMessage(error, 'Unexpected error'),
      });
    }
  });

  const handleUpsertItem = async (payload: { id: string; values: number[]; metadata?: Record<string, unknown> }) => {
    if (!provider || !index) return;
    try {
      await upsertItem.mutateAsync({
        indexKey: index.key,
        providerKey: provider.key,
        id: payload.id,
        values: payload.values,
        metadata: payload.metadata,
      });
      notifications.show({
        color: 'green',
        title: 'Vector item upserted',
        message: `${payload.id} has been stored.`,
      });
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to upsert item',
        message: errorMessage(error, 'Unexpected error'),
      });
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!provider || !index) return;
    await deleteResource({
      noun: tSafe('nouns.vectorItem'),
      name: itemId,
      action: async () => {
        try {
          await deleteItem.mutateAsync({ indexKey: index.key, providerKey: provider.key, id: itemId });
        } catch (error) {
          throw new Error(errorMessage(error, 'Failed to delete vector item'));
        }
        notifications.show({
          color: 'green',
          title: 'Vector item removed',
          message: `${itemId} has been deleted.`,
        });
      },
    });
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
            Back to knowledge indexes
          </Button>
        </Stack>
      </Center>
    );
  }

  // Prefer the live count from the stats endpoint; no provider stores one on
  // the index record, so the metadata value is only a legacy fallback.
  const vectorCount = typeof stats?.vectorCount === 'number'
    ? stats.vectorCount
    : (typeof index.metadata?.vectorCount === 'number' ? index.metadata.vectorCount : undefined);
  // A platform index carries the size the platform meters; any other reads what its provider reported.
  const indexSize = provider.platform
    ? (index.storedBytes ?? 0)
    : (typeof index.metadata?.indexSize === 'number' ? index.metadata.indexSize : undefined);
  const lastIndexed = index.metadata?.lastIndexed as string | undefined;

  /* ── Usage code snippets ── */
  const curlUpsert = [
    `curl -X POST https://your-cognipeer-host/api/client/v1/vector/providers/${providerKey}/indexes/${indexKey}/upsert \\`,
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
    `curl -X POST https://your-cognipeer-host/api/client/v1/vector/providers/${providerKey}/indexes/${indexKey}/query \\`,
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
    `import ConsoleClient from '@cognipeer/console-sdk';`,
    ``,
    `const client = new ConsoleClient({`,
    `  apiKey: 'YOUR_API_TOKEN',`,
    `  baseUrl: 'https://your-cognipeer-host',`,
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
    `import ConsoleClient from '@cognipeer/console-sdk';`,
    ``,
    `const client = new ConsoleClient({`,
    `  apiKey: 'YOUR_API_TOKEN',`,
    `  baseUrl: 'https://your-cognipeer-host',`,
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

  type TopKRow = NonNullable<typeof stats>['topKDistribution'][number];
  type QueryMatchRow = NonNullable<typeof queryResult>['matches'][number];
  const topKColumns: DataGridColumn<TopKRow>[] = [
    { key: 'topK', label: 'Top K', render: (row) => <Text size="sm" fw={500}>{row.topK}</Text> },
    { key: 'count', label: 'Query Count', render: (row) => row.count.toLocaleString() },
    {
      key: 'share',
      label: 'Share',
      render: (row) => {
        const total = stats?.totals.totalQueries ?? 0;
        const pct = total > 0 ? ((row.count / total) * 100).toFixed(1) : '0.0';
        return `${pct}%`;
      },
    },
  ];
  const matchColumns: DataGridColumn<QueryMatchRow>[] = [
    { key: 'id', label: 'ID', render: (match) => match.id },
    { key: 'score', label: 'Score', render: (match) => match.score.toFixed(4) },
    {
      key: 'metadata',
      label: 'Metadata',
      render: (match) => (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
          {stringifyMetadata(match.metadata)}
        </Text>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Vector index"
        title={index.name}
        subtitle={provider.platform ? `Provider ${provider.label} • ${tPlatform('badge')}` : `Provider ${provider.label} • Driver ${provider.driver}`}
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
              onClick={() => openDocs('knowledge-vector-stores')}
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
              onClick={() => void indexQuery.refetch()}
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
            <Group justify="flex-end">
              <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            </Group>

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
                    {provider.platform ? null : (
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">Driver</Text>
                        <Text size="sm" fw={500}>{provider.driver}</Text>
                      </Group>
                    )}
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
                    <DataGrid<TopKRow>
                      records={stats.topKDistribution}
                      rowKey={(row) => String(row.topK)}
                      columns={topKColumns}
                    />
                  </Paper>
                )}
              </Stack>
            )}
            {index?._id ? (
              <Paper withBorder radius="lg" p="lg">
                <ResourceUsageSection type="vector-index" id={String(index._id)} />
              </Paper>
            ) : null}
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
                {index.externalId ? (
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
                ) : null}
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
                  <Text size="sm" fw={500}>{provider.platform ? provider.label : `${provider.label} (${provider.driver})`}</Text>
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
                      label="Metadata filter (JSON)"
                      description={
                        filterOperators.length > 0
                          ? `Supported operators: ${filterOperators.join(', ')}. A bare value means equality.`
                          : 'This provider cannot push metadata filters down, so filtered queries are rejected.'
                      }
                      placeholder='{ "category": "support", "depth": { "$lte": 2 } }'
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
                    <DataGrid<QueryMatchRow>
                      records={queryResult.matches}
                      rowKey={(match) => match.id}
                      columns={matchColumns}
                    />
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
    </PageContainer>
  );
}
