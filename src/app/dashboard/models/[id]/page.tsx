'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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
  Modal,
  Paper,
  Progress,
  RingProgress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconBook,
  IconBrain,
  IconChartBar,
  IconRefresh,
  IconTool,
  IconCoin,
  IconActivity,
  IconClockHour4,
  IconCheck,
  IconCode,
  IconCopy,
  IconPlayerPlay,
  IconTrash,
  IconX,
  IconDatabase,
} from '@tabler/icons-react';
import { IconEye, IconPlug, IconSettings, IconCurrencyDollar, IconTimeline } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { Playground } from '@/components/playground';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

interface ModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
}

interface SemanticCacheConfigDto {
  enabled: boolean;
  vectorProviderKey: string;
  vectorIndexKey: string;
  embeddingModelKey: string;
  similarityThreshold: number;
  ttlSeconds: number;
}

interface ModelDetailDto {
  _id: string;
  name: string;
  description?: string;
  key: string;
  provider: string;
  category: 'llm' | 'embedding';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, string>;
  semanticCache?: SemanticCacheConfigDto;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface CostSummary {
  currency: string;
  inputCost?: number;
  outputCost?: number;
  cachedCost?: number;
  totalCost?: number;
}

interface UsageTimeseriesEntry {
  period: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  totalCost?: number;
  cacheHits?: number;
}

interface UsageAggregateDto {
  modelKey: string;
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  totalToolCalls: number;
  cacheHits: number;
  cacheMisses: number;
  avgLatencyMs: number | null;
  costSummary?: CostSummary;
  timeseries?: UsageTimeseriesEntry[];
}

interface UsageLogDto {
  _id?: string;
  requestId?: string;
  route: string;
  status: 'success' | 'error';
  latencyMs?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  totalTokens: number;
  errorMessage?: string;
  toolCalls?: number;
  cacheHit?: boolean;
  providerRequest?: Record<string, unknown>;
  providerResponse?: Record<string, unknown>;
  createdAt?: string;
}

interface ProviderDefinitionDto {
  id: string;
  label: string;
  description: string;
  categories: Array<'llm' | 'embedding'>;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50];

function fmtCurrency(amount: number, currency = 'USD') {
  return amount.toLocaleString(undefined, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function ModelDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const t = useTranslations('modelDetail');
  const tModels = useTranslations('models');
  const [model, setModel] = useState<ModelDetailDto | null>(null);
  const [usage, setUsage] = useState<UsageAggregateDto | null>(null);
  const [logs, setLogs] = useState<UsageLogDto[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(25);
  const [hasMoreLogs, setHasMoreLogs] = useState(false);
  const [providers, setProviders] = useState<ProviderDefinitionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedLog, setSelectedLog] = useState<UsageLogDto | null>(null);
  const [logModalOpened, { open: openLogModal, close: closeLogModal }] = useDisclosure(false);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  const modelId = params?.id;

  const providerLabel = useMemo(() => {
    if (!model) return '';
    return providers.find((provider) => provider.id === model.provider)?.label || model.provider;
  }, [model, providers]);

  const fetchDetail = async (showNotifications = false) => {
    if (!modelId) return;
    setRefreshing(!loading);
    try {
      const usageParams = buildDashboardDateSearchParams(dateFilter);
      usageParams.set('groupBy', 'day');
      const [modelResponse, usageResponse, providerResponse] = await Promise.all([
        fetch(`/api/models/${modelId}`),
        fetch(`/api/models/${modelId}/usage?${usageParams.toString()}`),
        fetch('/api/models/providers'),
      ]);

      if (!modelResponse.ok) {
        throw new Error('modelFailed');
      }

      const modelData = await modelResponse.json();
      setModel(modelData.model);

      if (usageResponse.ok) {
        const usageData = await usageResponse.json();
        setUsage(usageData.usage);
      } else {
        setUsage(null);
      }

      if (providerResponse.ok) {
        const providerData = await providerResponse.json();
        setProviders(providerData.providers ?? []);
      }

      if (showNotifications) {
        notifications.show({
          title: t('notifications.refreshedTitle'),
          message: t('notifications.refreshedMessage'),
          color: 'teal',
        });
      }
    } catch (error) {
      console.error('Failed to load model detail', error);
      notifications.show({
        title: t('notifications.errorTitle'),
        message: t('notifications.errorMessage'),
        color: 'red',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const fetchLogs = async () => {
    if (!modelId) return;
    setLogsLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      params.set('limit', String(logsPageSize));
      params.set('skip', String((logsPage - 1) * logsPageSize));

      const logsResponse = await fetch(`/api/models/${modelId}/logs?${params.toString()}`);
      if (logsResponse.ok) {
        const logsData = await logsResponse.json();
        const nextLogs: UsageLogDto[] = logsData.logs ?? [];
        setLogs(nextLogs);
        setHasMoreLogs(nextLogs.length === logsPageSize);
      } else {
        setLogs([]);
        setHasMoreLogs(false);
      }
    } catch (error) {
      console.error('Failed to load model logs', error);
      setLogs([]);
      setHasMoreLogs(false);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setLogsPage(1);
    fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, dateFilter]);

  useEffect(() => {
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, logsPage, logsPageSize, dateFilter]);

  const successRate = useMemo(() => {
    if (!usage?.totalCalls || usage.totalCalls === 0) return 0;
    return Math.round((usage.successCalls / usage.totalCalls) * 100);
  }, [usage]);

  const costCurrency = usage?.costSummary?.currency || model?.pricing?.currency || 'USD';
  const totalCost = usage?.costSummary?.totalCost ?? 0;

  // Build chart data from timeseries
  const chartData = useMemo(() => {
    if (!usage?.timeseries || usage.timeseries.length === 0) return [];
    return usage.timeseries.map((entry) => ({
      date: entry.period,
      Cost: entry.totalCost ?? 0,
      Calls: entry.callCount,
      Tokens: entry.totalTokens,
    }));
  }, [usage]);

  const handleDelete = async () => {
    if (!model || deleting) return;

    const confirmed = window.confirm(t('actions.deleteConfirm'));
    if (!confirmed) return;

    setDeleting(true);
    try {
      const response = await fetch(`/api/models/${model._id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: t('notifications.deleteErrorMessage') }));
        throw new Error(error.error ?? t('notifications.deleteErrorMessage'));
      }

      notifications.show({
        title: t('notifications.deleteSuccessTitle'),
        message: t('notifications.deleteSuccessMessage'),
        color: 'teal',
      });
      router.push('/dashboard/models');
    } catch (error) {
      notifications.show({
        title: t('notifications.deleteErrorTitle'),
        message:
          error instanceof Error
            ? error.message
            : t('notifications.deleteErrorMessage'),
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (!model) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">{t('errors.notFound')}</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/models')}>
            {t('actions.backToList')}
          </Button>
        </Stack>
      </Center>
    );
  }

  const curlChat = `curl -X POST https://your-cognipeer-host/api/client/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.key}",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user",   "content": "Hello, how are you?" }
    ],
    "temperature": 0.7,
    "max_tokens": 512
  }'`;

  const curlStream = `curl -X POST https://your-cognipeer-host/api/client/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.key}",
    "messages": [{ "role": "user", "content": "Tell me a joke" }],
    "stream": true
  }'`;

  const curlEmbed = `curl -X POST https://your-cognipeer-host/api/client/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.key}",
    "input": "The quick brown fox jumps over the lazy dog"
  }'`;

  const sdkChat = `import CognipeerClient from '@cognipeer/console-sdk';

const client = new CognipeerClient({
  apiKey: 'YOUR_API_TOKEN',
  baseUrl: 'https://your-cognipeer-host',
});

// Non-streaming
const response = await client.chat.completions({
  model: '${model.key}',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user',   content: 'Hello!' },
  ],
  temperature: 0.7,
});

console.log(response.choices[0].message.content);`;

  const sdkStream = `import CognipeerClient from '@cognipeer/console-sdk';

const client = new CognipeerClient({
  apiKey: 'YOUR_API_TOKEN',
  baseUrl: 'https://your-cognipeer-host',
});

// Streaming
const stream = await client.chat.streamCompletions({
  model: '${model.key}',
  messages: [{ role: 'user', content: 'Tell me a story' }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}`;

  const sdkEmbed = `import CognipeerClient from '@cognipeer/console-sdk';

const client = new CognipeerClient({
  apiKey: 'YOUR_API_TOKEN',
  baseUrl: 'https://your-cognipeer-host',
});

const response = await client.embeddings.create({
  model: '${model.key}',
  input: 'The quick brown fox jumps over the lazy dog',
});

console.log(response.data[0].embedding);`;

  const pythonChat = `import httpx

response = httpx.post(
    "https://your-cognipeer-host/api/client/v1/chat/completions",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
    json={
        "model": "${model.key}",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user",   "content": "Hello!"},
        ],
        "temperature": 0.7,
    },
)

data = response.json()
print(data["choices"][0]["message"]["content"])`;

  const pythonEmbed = `import httpx

response = httpx.post(
    "https://your-cognipeer-host/api/client/v1/embeddings",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
    json={
        "model": "${model.key}",
        "input": "The quick brown fox jumps over the lazy dog",
    },
)

data = response.json()
print(data["data"][0]["embedding"][:5])  # first 5 dims`;

  const openaiCompat = `from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_TOKEN",
    base_url="https://your-cognipeer-host/api/client/v1",
)

response = client.chat.completions.create(
    model="${model.key}",
    messages=[{"role": "user", "content": "Hello!"}],
)

print(response.choices[0].message.content)`;

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconBrain size={18} />}
        title={model.name}
        subtitle={model.description || 'View model configuration, capabilities, and usage.'}
        actions={
          <>
            <Badge color={model.category === 'llm' ? 'indigo' : 'teal'} variant="light">
              {model.category === 'llm' ? tModels('list.badges.llm') : tModels('list.badges.embedding')}
            </Badge>
            <Badge color="grape" variant="light">
              {providerLabel}
            </Badge>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/models')}
            >
              Back
            </Button>
            <Button
              onClick={() => openDocs('api-client')}
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
              loading={refreshing}
              onClick={() => {
                void fetchDetail(true);
                void fetchLogs();
              }}
            >
              {t('actions.refresh')}
            </Button>
            <Button
              component={Link}
              href={`/dashboard/models/${model._id}/edit`}
              size="xs"
              leftSection={<IconSettings size={14} />}
            >
              {t('actions.edit')}
            </Button>
            <Button
              variant="light"
              color="red"
              size="xs"
              leftSection={<IconTrash size={14} />}
              loading={deleting}
              onClick={() => void handleDelete()}
            >
              {t('actions.delete')}
            </Button>
          </>
        }
      />

      <Tabs defaultValue="dashboard" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="dashboard" leftSection={<IconChartBar size={14} />}>
            Dashboard
          </Tabs.Tab>
          {model.category === 'llm' && (
            <Tabs.Tab value="playground" leftSection={<IconPlayerPlay size={14} />}>
              Playground
            </Tabs.Tab>
          )}
          <Tabs.Tab value="history" leftSection={<IconTimeline size={14} />}>
            History
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconCode size={14} />}>
            Usage
          </Tabs.Tab>
        </Tabs.List>

        {/* ════════════════ Dashboard Tab ════════════════ */}
        <Tabs.Panel value="dashboard">
          <Stack gap="md">
            <Group justify="flex-end">
              <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            </Group>

            {/* ── Top KPI Cards ── */}
            <SimpleGrid cols={{ base: 2, sm: 3, md: 6 }} spacing="md">
              <KpiCard
                icon={<IconCoin size={18} />}
                color="green"
                label="Total Spend"
                value={usage ? fmtCurrency(totalCost, costCurrency) : '—'}
                highlight
              />
              <KpiCard
                icon={<IconActivity size={18} />}
                color="blue"
                label={t('stats.totalCalls')}
                value={usage ? fmtNumber(usage.totalCalls) : '—'}
              />
              <KpiCard
                icon={<IconCheck size={18} />}
                color="teal"
                label={t('stats.successRate')}
                value={usage ? `${successRate}%` : '—'}
              />
              <KpiCard
                icon={<IconDatabase size={18} />}
                color="violet"
                label={t('stats.totalTokens')}
                value={usage ? fmtNumber(usage.totalTokens) : '—'}
              />
              <KpiCard
                icon={<IconClockHour4 size={18} />}
                color="orange"
                label={t('stats.avgLatency')}
                value={usage?.avgLatencyMs ? `${Math.round(usage.avgLatencyMs)} ms` : '—'}
              />
              <KpiCard
                icon={<IconX size={18} />}
                color="red"
                label="Errors"
                value={usage ? fmtNumber(usage.errorCalls) : '—'}
              />
            </SimpleGrid>

            {/* ── Daily Cost Chart + Cost Breakdown ── */}
            <Grid>
              <Grid.Col span={{ base: 12, md: 8 }}>
                <Paper withBorder radius="lg" p="lg" h="100%">
                  <Group gap={8} mb="md">
                    <ThemeIcon variant="light" color="green" radius="md">
                      <IconCoin size={16} />
                    </ThemeIcon>
                    <Text fw={600}>Daily Cost & Usage</Text>
                  </Group>
                  {chartData.length > 0 ? (
                    <AreaChart
                      h={260}
                      data={chartData}
                      dataKey="date"
                      series={[
                        { name: 'Cost', color: 'green.6' },
                      ]}
                      curveType="monotone"
                      withDots={false}
                      withGradient
                      gridAxis="xy"
                      valueFormatter={(value) => fmtCurrency(value as number, costCurrency)}
                      tooltipAnimationDuration={200}
                    />
                  ) : (
                    <Center h={260}>
                      <Text size="sm" c="dimmed">No daily data available yet.</Text>
                    </Center>
                  )}
                </Paper>
              </Grid.Col>

              <Grid.Col span={{ base: 12, md: 4 }}>
                <Stack gap="md" h="100%">
                  {/* Cost breakdown */}
                  <Paper withBorder radius="lg" p="lg" style={{ flex: 1 }}>
                    <Group gap={8} mb="md">
                      <ThemeIcon variant="light" color="blue" radius="md">
                        <IconCurrencyDollar size={16} />
                      </ThemeIcon>
                      <Text fw={600}>Cost Breakdown</Text>
                    </Group>
                    {usage?.costSummary ? (
                      <Stack gap="sm">
                        <CostRow label="Input tokens" value={usage.costSummary.inputCost ?? 0} total={totalCost} currency={costCurrency} color="blue" />
                        <CostRow label="Output tokens" value={usage.costSummary.outputCost ?? 0} total={totalCost} currency={costCurrency} color="indigo" />
                        <CostRow label="Cached tokens" value={usage.costSummary.cachedCost ?? 0} total={totalCost} currency={costCurrency} color="cyan" />
                        <Group justify="space-between" mt="xs" pt="xs" style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}>
                          <Text size="sm" fw={600}>Total</Text>
                          <Text size="sm" fw={700} c="green">{fmtCurrency(totalCost, costCurrency)}</Text>
                        </Group>
                      </Stack>
                    ) : (
                      <Center py="md">
                        <Text size="sm" c="dimmed">No cost data yet.</Text>
                      </Center>
                    )}
                  </Paper>

                  {/* Pricing card */}
                  <Paper withBorder radius="lg" p="lg" style={{ flex: 1 }}>
                    <Group gap={8} mb="sm">
                      <ThemeIcon variant="light" color="grape" radius="md">
                        <IconCurrencyDollar size={16} />
                      </ThemeIcon>
                      <Text fw={600}>{t('pricing.title')}</Text>
                    </Group>
                    <Stack gap={6}>
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">Input</Text>
                        <Text size="sm" fw={500}>{model.pricing.inputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {model.pricing.currency || 'USD'}</Text>
                      </Group>
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">Output</Text>
                        <Text size="sm" fw={500}>{model.pricing.outputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {model.pricing.currency || 'USD'}</Text>
                      </Group>
                      {model.pricing.cachedTokenPer1M ? (
                        <Group justify="space-between">
                          <Text size="sm" c="dimmed">Cached</Text>
                          <Text size="sm" fw={500}>{model.pricing.cachedTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {model.pricing.currency || 'USD'}</Text>
                        </Group>
                      ) : null}
                    </Stack>
                  </Paper>
                </Stack>
              </Grid.Col>
            </Grid>

            {/* ── Model Info + Settings + Cache ── */}
            <Grid>
              <Grid.Col span={{ base: 12, md: 4 }}>
                <Paper withBorder radius="lg" p="lg" h="100%">
                  <Group gap={8} mb="sm">
                    <ThemeIcon variant="light" color="indigo" radius="md">
                      <IconChartBar size={16} />
                    </ThemeIcon>
                    <Text fw={600}>{t('sections.overview')}</Text>
                  </Group>
                  <Stack gap={8}>
                    <InfoRow label={t('fields.key')} value={model.key} mono />
                    <InfoRow label={t('fields.provider')} value={providerLabel} />
                    <InfoRow label={t('fields.modelId')} value={model.modelId} mono />
                    <InfoRow label={t('fields.createdAt')} value={model.createdAt ? new Date(model.createdAt).toLocaleDateString() : '—'} />
                    <InfoRow label={t('fields.updatedAt')} value={model.updatedAt ? new Date(model.updatedAt).toLocaleDateString() : '—'} />
                  </Stack>
                  <Group gap={8} mt="md">
                    {model.isMultimodal ? (
                      <Badge variant="light" color="violet" leftSection={<IconEye size={14} />}>
                        {tModels('list.capabilities.multimodal')}
                      </Badge>
                    ) : null}
                    {model.supportsToolCalls ? (
                      <Badge variant="light" color="lime" leftSection={<IconTool size={14} />}>
                        {tModels('list.capabilities.tools')}
                      </Badge>
                    ) : null}
                    {model.semanticCache?.enabled ? (
                      <Badge variant="light" color="cyan">
                        {t('sections.semanticCache')}
                      </Badge>
                    ) : null}
                  </Group>
                </Paper>
              </Grid.Col>

              <Grid.Col span={{ base: 12, md: 4 }}>
                <Paper withBorder radius="lg" p="lg" h="100%">
                  <Group gap={8} mb="sm">
                    <ThemeIcon variant="light" color="grape" radius="md">
                      <IconPlug size={16} />
                    </ThemeIcon>
                    <Text fw={600}>{t('sections.settings')}</Text>
                  </Group>
                  <Stack gap={8}>
                    {Object.entries(model.settings || {}).length > 0 ? (
                      Object.entries(model.settings).map(([key, value]) => (
                        <InfoRow key={key} label={key} value={typeof value === 'string' ? value : JSON.stringify(value)} />
                      ))
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t('settings.empty')}
                      </Text>
                    )}
                  </Stack>
                </Paper>
              </Grid.Col>

              <Grid.Col span={{ base: 12, md: 4 }}>
                <Paper withBorder radius="lg" p="lg" h="100%">
                  <Group gap={8} mb="sm">
                    <ThemeIcon variant="light" color="teal" radius="md">
                      <IconActivity size={16} />
                    </ThemeIcon>
                    <Text fw={600}>Performance & Cache</Text>
                  </Group>
                  {usage ? (
                    <Stack gap="sm">
                      <Group justify="center" mb="xs">
                        <RingProgress
                          size={100}
                          thickness={10}
                          roundCaps
                          sections={[
                            { value: successRate, color: 'teal' },
                            { value: 100 - successRate, color: 'red' },
                          ]}
                          label={
                            <Text ta="center" size="sm" fw={700}>
                              {successRate}%
                            </Text>
                          }
                        />
                      </Group>
                      <Group justify="space-between">
                        <Text size="xs" c="dimmed">Success</Text>
                        <Text size="sm" fw={500} c="teal">{fmtNumber(usage.successCalls)}</Text>
                      </Group>
                      <Group justify="space-between">
                        <Text size="xs" c="dimmed">Errors</Text>
                        <Text size="sm" fw={500} c="red">{fmtNumber(usage.errorCalls)}</Text>
                      </Group>
                      {(usage.cacheHits > 0 || usage.cacheMisses > 0) && (
                        <>
                          <Group justify="space-between" mt="xs">
                            <Text size="xs" c="dimmed">Cache hits</Text>
                            <Text size="sm" fw={500}>{fmtNumber(usage.cacheHits)}</Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="xs" c="dimmed">Cache hit rate</Text>
                            <Text size="sm" fw={500}>
                              {usage.totalCalls > 0 ? `${Math.round((usage.cacheHits / usage.totalCalls) * 100)}%` : '—'}
                            </Text>
                          </Group>
                        </>
                      )}
                      <Group justify="space-between">
                        <Text size="xs" c="dimmed">Tool calls</Text>
                        <Text size="sm" fw={500}>{fmtNumber(usage.totalToolCalls)}</Text>
                      </Group>
                    </Stack>
                  ) : (
                    <Center py="md">
                      <Text size="sm" c="dimmed">{t('stats.noUsage')}</Text>
                    </Center>
                  )}
                </Paper>
              </Grid.Col>
            </Grid>
          </Stack>
        </Tabs.Panel>

        {/* ════════════════ Playground Tab ════════════════ */}
        {model.category === 'llm' && (
          <Tabs.Panel value="playground">
            <Playground
              initialModelKey={model.key}
              hideModelSelector
              chatHeight={550}
            />
          </Tabs.Panel>
        )}

        {/* ════════════════ History Tab ════════════════ */}
        <Tabs.Panel value="history">
          <Paper withBorder radius="lg" p="lg">
            <Group gap={8} mb="sm">
              <ThemeIcon variant="light" color="teal" radius="md">
                <IconTimeline size={16} />
              </ThemeIcon>
              <Text fw={600}>{t('sections.logs')}</Text>
              <Badge variant="light" color="gray" size="sm" ml="auto">Page {logsPage}</Badge>
            </Group>

            <Group align="end" gap="sm" mb="md" wrap="wrap">
              <Group gap={6}>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <Button
                    key={size}
                    size="xs"
                    variant={logsPageSize === size ? 'filled' : 'light'}
                    onClick={() => {
                      setLogsPageSize(size);
                      setLogsPage(1);
                    }}
                  >
                    {size}/page
                  </Button>
                ))}
              </Group>
            </Group>

            {logsLoading ? (
              <Center py="md">
                <Loader size="sm" />
              </Center>
            ) : null}

            <ScrollArea type="auto">
              <Table highlightOnHover striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('logs.timestamp')}</Table.Th>
                    <Table.Th>{t('logs.route')}</Table.Th>
                    <Table.Th>{t('logs.status')}</Table.Th>
                    <Table.Th>{t('logs.latency')}</Table.Th>
                    <Table.Th>{t('logs.tokens')}</Table.Th>
                    <Table.Th>Cost</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {logs.length > 0 ? (
                    logs.map((log) => {
                      const reqCost = model.pricing
                        ? (log.inputTokens / 1_000_000) * model.pricing.inputTokenPer1M +
                          (log.outputTokens / 1_000_000) * model.pricing.outputTokenPer1M
                        : undefined;
                      return (
                        <Table.Tr
                          key={log._id || `${log.route}-${log.createdAt}`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            setSelectedLog(log);
                            openLogModal();
                          }}
                        >
                          <Table.Td>{log.createdAt ? new Date(log.createdAt).toLocaleString() : '—'}</Table.Td>
                          <Table.Td>{log.route}</Table.Td>
                          <Table.Td>
                            <Group gap={4}>
                              <Badge color={log.status === 'success' ? 'teal' : 'red'} variant="light" size="sm">
                                {log.status === 'success' ? t('logs.success') : t('logs.error')}
                              </Badge>
                              {log.cacheHit === true && (
                                <Badge color="cyan" variant="light" size="xs">
                                  {t('logs.cacheHit')}
                                </Badge>
                              )}
                            </Group>
                          </Table.Td>
                          <Table.Td>{log.latencyMs ? `${Math.round(log.latencyMs)} ms` : '—'}</Table.Td>
                          <Table.Td>
                            {t('logs.tokenSummary', {
                              input: log.inputTokens.toLocaleString(),
                              output: log.outputTokens.toLocaleString(),
                            })}
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {reqCost !== undefined ? fmtCurrency(reqCost, costCurrency) : '—'}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })
                  ) : (
                    <Table.Tr>
                      <Table.Td colSpan={6}>
                        <Center py="md">
                          <Text size="sm" c="dimmed">
                            {t('logs.empty')}
                          </Text>
                        </Center>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </ScrollArea>

            <Group justify="space-between" mt="md">
              <Button
                variant="default"
                size="xs"
                disabled={logsPage <= 1 || logsLoading}
                onClick={() => setLogsPage((prev) => Math.max(1, prev - 1))}
              >
                Previous
              </Button>
              <Text size="sm" c="dimmed">
                Page {logsPage}
              </Text>
              <Button
                variant="default"
                size="xs"
                disabled={!hasMoreLogs || logsLoading}
                onClick={() => setLogsPage((prev) => prev + 1)}
              >
                Next
              </Button>
            </Group>
          </Paper>
        </Tabs.Panel>

        {/* ════════════════ Usage Tab ════════════════ */}
        <Tabs.Panel value="usage">
          <Stack gap="md">
            {/* Model key */}
            <Paper withBorder radius="lg" p="lg">
              <Text fw={600} mb="xs">Model Key</Text>
              <Group gap="sm">
                <Code fz="sm" style={{ flex: 1 }}>{model.key}</Code>
                <CopyButton value={model.key} timeout={2000}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                      <Button
                        size="xs"
                        variant={copied ? 'filled' : 'light'}
                        color={copied ? 'teal' : 'blue'}
                        onClick={copy}
                        leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            </Paper>

            {model.category === 'llm' ? (
              <>
                {/* cURL — Chat Completion */}
                <UsageCodeBlock title="cURL — Chat Completion" code={curlChat} />

                {/* cURL — Streaming */}
                <UsageCodeBlock title="cURL — Streaming" code={curlStream} />

                {/* TypeScript SDK */}
                <UsageCodeBlock title="TypeScript SDK — Chat Completion" code={sdkChat} language="typescript" />

                {/* TypeScript SDK — Streaming */}
                <UsageCodeBlock title="TypeScript SDK — Streaming" code={sdkStream} language="typescript" />

                {/* Python */}
                <UsageCodeBlock title="Python (httpx)" code={pythonChat} language="python" />

                {/* OpenAI-compatible */}
                <UsageCodeBlock title="Python — OpenAI Compatible" code={openaiCompat} language="python" />
              </>
            ) : (
              <>
                {/* cURL — Embeddings */}
                <UsageCodeBlock title="cURL — Embeddings" code={curlEmbed} />

                {/* TypeScript SDK — Embeddings */}
                <UsageCodeBlock title="TypeScript SDK — Embeddings" code={sdkEmbed} language="typescript" />

                {/* Python — Embeddings */}
                <UsageCodeBlock title="Python (httpx) — Embeddings" code={pythonEmbed} language="python" />
              </>
            )}

            {/* Response format */}
            <Paper withBorder radius="lg" p="lg">
              <Text fw={600} mb="xs">Response Format</Text>
              <Text size="xs" c="dimmed" mb="sm">
                All responses follow the OpenAI-compatible format. Replace <Code fz="xs">YOUR_API_TOKEN</Code> with an API token from Settings.
              </Text>
              {model.category === 'llm' ? (
                <Code block fz="xs">
{`{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "model": "${model.key}",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 12,
    "total_tokens": 37
  }
}`}
                </Code>
              ) : (
                <Code block fz="xs">
{`{
  "object": "list",
  "model": "${model.key}",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0023, -0.0091, 0.0154, ...]
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "total_tokens": 10
  }
}`}
                </Code>
              )}
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {/* Request Details Modal */}
      <Modal
        opened={logModalOpened}
        onClose={closeLogModal}
        title={t('logs.modal.title')}
        size="xl"
      >
        {selectedLog && (
          <Stack gap="md">
            {/* Summary info */}
            <Paper withBorder radius="md" p="sm">
              <Stack gap="xs">
                <Group gap="xs" wrap="wrap">
                  <Badge color={selectedLog.status === 'success' ? 'teal' : 'red'} variant="light">
                    {selectedLog.status === 'success' ? t('logs.success') : t('logs.error')}
                  </Badge>
                  {selectedLog.latencyMs && (
                    <Badge variant="light" color="blue">
                      {Math.round(selectedLog.latencyMs)} ms
                    </Badge>
                  )}
                  {selectedLog.toolCalls !== undefined && selectedLog.toolCalls > 0 && (
                    <Badge variant="light" color="orange" leftSection={<IconTool size={12} />}>
                      {t('logs.modal.toolCalls', { count: selectedLog.toolCalls })}
                    </Badge>
                  )}
                  {selectedLog.cacheHit === true && (
                    <Badge variant="light" color="cyan">
                      {t('logs.cacheHit')}
                    </Badge>
                  )}
                  {selectedLog.cacheHit === false && selectedLog.status === 'success' && (
                    <Badge variant="light" color="gray">
                      {t('logs.cacheMiss')}
                    </Badge>
                  )}
                </Group>
                <Text size="sm">
                  <strong>{t('logs.modal.requestId')}:</strong>{' '}
                  <code>{selectedLog.requestId || '—'}</code>
                </Text>
                <Text size="sm">
                  <strong>{t('logs.route')}:</strong> {selectedLog.route}
                </Text>
                <Text size="sm">
                  <strong>{t('logs.timestamp')}:</strong>{' '}
                  {selectedLog.createdAt ? new Date(selectedLog.createdAt).toLocaleString() : '—'}
                </Text>
                <Text size="sm">
                  <strong>{t('logs.modal.tokens')}:</strong>{' '}
                  {t('logs.modal.tokenBreakdown', {
                    input: selectedLog.inputTokens.toLocaleString(),
                    output: selectedLog.outputTokens.toLocaleString(),
                    cached: (selectedLog.cachedInputTokens || 0).toLocaleString(),
                    total: selectedLog.totalTokens.toLocaleString(),
                  })}
                </Text>
                {selectedLog.errorMessage && (
                  <Text size="sm" c="red">
                    <strong>{t('logs.modal.error')}:</strong> {selectedLog.errorMessage}
                  </Text>
                )}
              </Stack>
            </Paper>

            {/* Request / Response tabs */}
            <Tabs defaultValue="request">
              <Tabs.List>
                <Tabs.Tab value="request">{t('logs.modal.request')}</Tabs.Tab>
                <Tabs.Tab value="response">{t('logs.modal.response')}</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="request" pt="sm">
                <ScrollArea h={400} type="auto">
                  {selectedLog.providerRequest ? (
                    <Code block style={{ whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(selectedLog.providerRequest, null, 2)}
                    </Code>
                  ) : (
                    <Center py="md">
                      <Text size="sm" c="dimmed">
                        {t('logs.modal.noRequest')}
                      </Text>
                    </Center>
                  )}
                </ScrollArea>
              </Tabs.Panel>

              <Tabs.Panel value="response" pt="sm">
                <ScrollArea h={400} type="auto">
                  {selectedLog.providerResponse ? (
                    <Code block style={{ whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(selectedLog.providerResponse, null, 2)}
                    </Code>
                  ) : (
                    <Center py="md">
                      <Text size="sm" c="dimmed">
                        {t('logs.modal.noResponse')}
                      </Text>
                    </Center>
                  )}
                </ScrollArea>
              </Tabs.Panel>
            </Tabs>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

interface KpiCardProps {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: string;
  highlight?: boolean;
}

function KpiCard({ icon, color, label, value, highlight }: KpiCardProps) {
  return (
    <Paper
      withBorder
      radius="lg"
      p="md"
      style={highlight ? { borderColor: `var(--mantine-color-${color}-6)`, borderWidth: 2 } : undefined}
    >
      <Group gap={8} mb={4}>
        <ThemeIcon variant="light" color={color} size="sm" radius="md">
          {icon}
        </ThemeIcon>
        <Text size="xs" c="dimmed" tt="uppercase" fw={500}>
          {label}
        </Text>
      </Group>
      <Text fw={700} size={highlight ? 'xl' : 'lg'}>
        {value}
      </Text>
    </Paper>
  );
}

interface CostRowProps {
  label: string;
  value: number;
  total: number;
  currency: string;
  color: string;
}

function CostRow({ label, value, total, currency, color }: CostRowProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <Stack gap={2}>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">{label}</Text>
        <Text size="xs" fw={500}>{fmtCurrency(value, currency)} ({pct}%)</Text>
      </Group>
      <Progress value={pct} color={color} size="xs" radius="xl" />
    </Stack>
  );
}

interface InfoRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function InfoRow({ label, value, mono }: InfoRowProps) {
  return (
    <Group justify="space-between" gap="sm" wrap="nowrap">
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm" fw={500} ta="right" truncate style={mono ? { fontFamily: 'var(--mantine-font-family-monospace)' } : undefined}>
        {value}
      </Text>
    </Group>
  );
}

interface UsageCodeBlockProps {
  title: string;
  code: string;
  language?: string;
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
