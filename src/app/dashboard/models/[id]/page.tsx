'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Button,
  Center,
  Code,
  CopyButton,
  Loader,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsSplit,
  IconBook,
  IconBrain,
  IconMicrophone,
  IconScan,
  IconSpeakerphone,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClipboard,
  IconCopy,
  IconCpu,
  IconDots,
  IconExternalLink,
  IconLayoutDashboard,
  IconPinned,
  IconPlayerPlay,
  IconRefresh,
  IconSettings,
  IconTimeline,
  IconTool,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import ModelPlayground from '@/components/playground/ModelPlayground';
import SttPlayground from '@/components/playground/SttPlayground';
import TtsPlayground from '@/components/playground/TtsPlayground';
import OcrPlayground from '@/components/playground/OcrPlayground';
import PageContainer from '@/components/common/ui/PageContainer';
import TabsBar from '@/components/common/ui/TabsBar';
import StatusBadge from '@/components/common/ui/StatusBadge';
import Spark from '@/components/common/ui/Spark';
import Toolbar from '@/components/common/ui/Toolbar';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';
import type { IDynamicRoutingConfig } from '@/lib/database';

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
  provider?: string;
  providerKey?: string;
  providerDriver?: string;
  category: 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  semanticCache?: SemanticCacheConfigDto;
  inputGuardrailKey?: string;
  outputGuardrailKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface GuardrailLite {
  key: string;
  name: string;
  type: 'preset' | 'custom';
  action: string;
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

interface RoutingInfoDto {
  routerKey: string;
  strategy: 'rule-based' | 'model-based';
  decision: 'rule' | 'model' | 'default' | 'fallback';
  chosenModelKey: string;
  matchedRuleLabel?: string;
  deciderLabel?: string;
  deciderModelKey?: string;
  deciderLatencyMs?: number;
  reason: string;
  signals?: Record<string, unknown>;
  childRequestId?: string;
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
  routing?: RoutingInfoDto;
  providerRequest?: Record<string, unknown>;
  providerResponse?: Record<string, unknown>;
  createdAt?: string;
}

interface ModelProviderDto {
  key: string;
  label: string;
  driver: string;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50];

function fmtCurrency(amount: number, currency = 'USD') {
  return amount.toLocaleString(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function fmtNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#cc7d4f',
  cognipeer: '#16b3ab',
  azure: '#0078d4',
  aws: '#ff9900',
  bedrock: '#ff9900',
  google: '#ea4335',
  vertex: '#ea4335',
  ollama: '#7c3aed',
  self: '#7c3aed',
};

function providerColor(key: string): string {
  const k = (key || '').toLowerCase();
  for (const [name, color] of Object.entries(PROVIDER_COLORS)) {
    if (k.includes(name)) return color;
  }
  return '#9aa7b6';
}

function relativeDate(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) {
    const hours = Math.max(1, Math.floor(diff / (60 * 60 * 1000)));
    return `${hours}h ago`;
  }
  const days = Math.floor(diff / day);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

type DetailTab = 'overview' | 'playground' | 'routing' | 'configure' | 'logs' | 'usage';

/** Reads the routing config off a model when it is a Dynamic LLM. */
function dynamicConfigOf(model: { settings?: Record<string, unknown> } | null): IDynamicRoutingConfig | null {
  const dyn = model?.settings?.dynamic;
  if (dyn && typeof dyn === 'object' && typeof (dyn as { strategy?: unknown }).strategy === 'string') {
    return dyn as IDynamicRoutingConfig;
  }
  return null;
}

export default function ModelDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const t = useTranslations('modelDetail');

  const [model, setModel] = useState<ModelDetailDto | null>(null);
  const [usage, setUsage] = useState<UsageAggregateDto | null>(null);
  const [logs, setLogs] = useState<UsageLogDto[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(25);
  const [hasMoreLogs, setHasMoreLogs] = useState(false);
  const [providers, setProviders] = useState<ModelProviderDto[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedLog, setSelectedLog] = useState<UsageLogDto | null>(null);
  const [logModalOpened, { open: openLogModal, close: closeLogModal }] =
    useDisclosure(false);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [logFilter, setLogFilter] = useState('');
  const [logLevel, setLogLevel] = useState<'all' | 'error'>('all');

  const modelId = params?.id;

  const selectedProvider = useMemo(() => {
    if (!model?.providerKey) return null;
    return providers.find((provider) => provider.key === model.providerKey) ?? null;
  }, [model?.providerKey, providers]);

  const providerLabel = useMemo(() => {
    if (!model) return '';
    return selectedProvider?.label || model.providerKey || model.provider || '';
  }, [model, selectedProvider]);

  const providerColorKey = useMemo(() => {
    if (!model) return '';
    return (
      selectedProvider?.driver ||
      model.providerDriver ||
      model.providerKey ||
      model.provider ||
      ''
    );
  }, [model, selectedProvider]);

  const fetchDetail = async (showNotifications = false) => {
    if (!modelId) return;
    setRefreshing(!loading);
    try {
      const usageParams = buildDashboardDateSearchParams(dateFilter);
      usageParams.set('groupBy', 'day');
      const [modelResponse, usageResponse, providerResponse, guardrailResponse] = await Promise.all([
        fetch(`/api/models/${modelId}`),
        fetch(`/api/models/${modelId}/usage?${usageParams.toString()}`),
        fetch('/api/models/providers'),
        fetch('/api/guardrails?enabled=true'),
      ]);
      if (!modelResponse.ok) throw new Error('modelFailed');
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
      if (guardrailResponse.ok) {
        const guardrailData = await guardrailResponse.json();
        setGuardrails(guardrailData.guardrails ?? []);
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
      const logsResponse = await fetch(
        `/api/models/${modelId}/logs?${params.toString()}`,
      );
      if (logsResponse.ok) {
        const logsData = await logsResponse.json();
        const next: UsageLogDto[] = logsData.logs ?? [];
        setLogs(next);
        setHasMoreLogs(next.length === logsPageSize);
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
    void fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, dateFilter]);

  useEffect(() => {
    void fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, logsPage, logsPageSize, dateFilter]);

  const successRate = useMemo(() => {
    if (!usage?.totalCalls || usage.totalCalls === 0) return 0;
    return Math.round((usage.successCalls / usage.totalCalls) * 100);
  }, [usage]);

  const costCurrency = usage?.costSummary?.currency || model?.pricing?.currency || 'USD';
  const totalCost = usage?.costSummary?.totalCost ?? 0;

  const chartData = useMemo(() => {
    if (!usage?.timeseries || usage.timeseries.length === 0) return [];
    return usage.timeseries.map((entry) => ({
      date: entry.period,
      Cost: entry.totalCost ?? 0,
      Calls: entry.callCount,
      Tokens: entry.totalTokens,
    }));
  }, [usage]);

  const sparkData = useMemo(() => {
    if (!usage?.timeseries || usage.timeseries.length === 0) {
      return Array.from({ length: 16 }, (_, i) =>
        20 + Math.sin(i * 0.6) * 12 + (i / 16) * 8,
      );
    }
    return usage.timeseries.map((e) => e.callCount + 1);
  }, [usage]);

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (logLevel === 'error' && l.status !== 'error') return false;
      if (logFilter) {
        const q = logFilter.toLowerCase();
        return (
          (l.requestId ?? '').toLowerCase().includes(q) ||
          l.route.toLowerCase().includes(q) ||
          (l.errorMessage ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [logs, logLevel, logFilter]);

  const handleDelete = async () => {
    if (!model || deleting) return;
    const confirmed = window.confirm(t('actions.deleteConfirm'));
    if (!confirmed) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/models/${model._id}`, { method: 'DELETE' });
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
          error instanceof Error ? error.message : t('notifications.deleteErrorMessage'),
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
          <Button
            leftSection={<IconArrowLeft size={16} />}
            onClick={() => router.push('/dashboard/models')}
          >
            {t('actions.backToList')}
          </Button>
        </Stack>
      </Center>
    );
  }

  const endpointBase = typeof window !== 'undefined' ? window.location.origin : '';
  const endpointPath =
    model.category === 'llm'
      ? '/api/client/v1/chat/completions'
      : model.category === 'embedding'
        ? '/api/client/v1/embeddings'
        : model.category === 'stt'
          ? '/api/client/v1/audio/transcriptions'
          : model.category === 'tts'
            ? '/api/client/v1/audio/speech'
            : model.category === 'ocr'
              ? '/api/client/v1/ocr'
              : '/api/client/v1/embeddings';
  const endpointUrl = `${endpointBase}${endpointPath}`;

  const dynamic = dynamicConfigOf(model);
  const isDynamic = Boolean(dynamic);

  // A Dynamic LLM has no real provider runtime, so its playground would error.
  const playgroundCategories = ['llm', 'stt', 'tts', 'ocr'] as const;
  const hasPlayground =
    !isDynamic && (playgroundCategories as readonly string[]).includes(model.category);

  const tabs: Array<{ id: DetailTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <IconLayoutDashboard size={14} stroke={1.7} /> },
    ...(hasPlayground
      ? [{ id: 'playground' as const, label: 'Playground', icon: <IconPlayerPlay size={14} stroke={1.7} /> }]
      : []),
    ...(isDynamic
      ? [{ id: 'routing' as const, label: 'Routing', icon: <IconArrowsSplit size={14} stroke={1.7} /> }]
      : []),
    { id: 'configure', label: 'Configure', icon: <IconSettings size={14} stroke={1.7} /> },
    { id: 'logs', label: 'Logs', icon: <IconTimeline size={14} stroke={1.7} /> },
    { id: 'usage', label: 'Usage', icon: <IconBook size={14} stroke={1.7} /> },
  ];

  return (
    <PageContainer>
      {/* Header */}
      <header className="ds-page-header" style={{ alignItems: 'center' }}>
        <div className="ds-row ds-gap-md" style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 12,
              background: 'var(--ds-accent-soft)',
              color: 'var(--ds-accent)',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            {model.category === 'llm' ? (
              <IconBrain size={26} stroke={1.7} />
            ) : model.category === 'stt' ? (
              <IconMicrophone size={26} stroke={1.7} />
            ) : model.category === 'tts' ? (
              <IconSpeakerphone size={26} stroke={1.7} />
            ) : model.category === 'ocr' ? (
              <IconScan size={26} stroke={1.7} />
            ) : (
              <IconCpu size={26} stroke={1.7} />
            )}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 4,
              }}
            >
              <h1
                className="ds-h2 ds-mono"
                style={{ margin: 0, whiteSpace: 'nowrap' }}
              >
                {model.name}
              </h1>
              <StatusBadge status="active" />
              {isDynamic ? (
                <span className="ds-badge ds-badge-teal">dynamic</span>
              ) : (
                <span className="ds-badge">{model.category}</span>
              )}
              {model.isMultimodal ? (
                <span className="ds-badge ds-badge-info">vision</span>
              ) : null}
              {model.supportsToolCalls ? (
                <span className="ds-badge ds-badge-warn">tools</span>
              ) : null}
              {model.semanticCache?.enabled ? (
                <span className="ds-badge ds-badge-teal">cache</span>
              ) : null}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                fontSize: 12.5,
                color: 'var(--ds-text-muted)',
              }}
            >
              <span className="ds-row ds-gap-xs">
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: providerColor(providerColorKey),
                    display: 'inline-block',
                  }}
                />
                {providerLabel}
              </span>
              <span className="ds-faint">·</span>
              <span className="ds-mono" style={{ whiteSpace: 'nowrap' }}>
                {model.modelId}
              </span>
              {model.updatedAt ? (
                <>
                  <span className="ds-faint">·</span>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    Updated {relativeDate(model.updatedAt)}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="ds-row ds-gap-sm" style={{ flexShrink: 0 }}>
          <Tooltip label="Pin to favorites" withArrow>
            <ActionIcon variant="subtle" color="gray" radius="md" size="lg">
              <IconPinned size={15} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
          <CopyButton value={endpointUrl} timeout={1500}>
            {({ copied, copy }) => (
              <Button
                variant="default"
                size="sm"
                leftSection={
                  copied ? (
                    <IconCheck size={14} stroke={2} />
                  ) : (
                    <IconClipboard size={14} stroke={1.7} />
                  )
                }
                onClick={copy}
              >
                {copied ? 'Copied' : 'Endpoint'}
              </Button>
            )}
          </CopyButton>
          {hasPlayground ? (
            <Button
              variant="default"
              size="sm"
              leftSection={<IconPlayerPlay size={13} stroke={1.7} />}
              onClick={() => setTab('playground')}
            >
              Test
            </Button>
          ) : null}
          <Menu withinPortal position="bottom-end" withArrow>
            <Menu.Target>
              <ActionIcon variant="default" radius="md" size="lg">
                <IconDots size={15} stroke={1.7} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                component={Link}
                href={`/dashboard/models/${model._id}/edit`}
                leftSection={<IconSettings size={14} />}
              >
                {t('actions.edit')}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconBook size={14} />}
                onClick={() => openDocs('api-client')}
              >
                Docs
              </Menu.Item>
              <Menu.Item
                leftSection={<IconRefresh size={14} />}
                onClick={() => {
                  void fetchDetail(true);
                  void fetchLogs();
                }}
              >
                {t('actions.refresh')}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={14} />}
                disabled={deleting}
                onClick={() => void handleDelete()}
              >
                {t('actions.delete')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </header>

      <TabsBar
        items={tabs.map((t) => ({ id: t.id, label: (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t.icon}
            {t.label}
          </span>
        ) }))}
        activeId={tab}
        onChange={(id) => setTab(id as DetailTab)}
      />

      {tab === 'overview' ? (
        <OverviewTab
          model={model}
          usage={usage}
          providerLabel={providerLabel}
          totalCost={totalCost}
          costCurrency={costCurrency}
          successRate={successRate}
          sparkData={sparkData}
          chartData={chartData}
          recentLogs={logs.slice(0, 6)}
          endpointUrl={endpointUrl}
          dateFilter={dateFilter}
          setDateFilter={setDateFilter}
          refreshing={refreshing}
          onRefresh={() => {
            void fetchDetail(true);
            void fetchLogs();
          }}
          onOpenLog={(l) => {
            setSelectedLog(l);
            openLogModal();
          }}
        />
      ) : null}

      {tab === 'playground' && model.category === 'llm' ? (
        <ModelPlayground
          modelKey={model.key}
          defaultUser={`Hello! Tell me what you can do.`}
        />
      ) : null}

      {tab === 'playground' && model.category === 'stt' ? (
        <SttPlayground modelKey={model.key} />
      ) : null}

      {tab === 'playground' && model.category === 'tts' ? (
        <TtsPlayground modelKey={model.key} />
      ) : null}

      {tab === 'playground' && model.category === 'ocr' ? (
        <OcrPlayground
          modelKey={model.key}
          configuredMode={
            (model.settings?.ocr as { mode?: 'native' | 'vlm' } | undefined)?.mode
          }
        />
      ) : null}

      {tab === 'routing' && dynamic ? (
        <RoutingTab
          config={dynamic}
          logs={logs}
          onOpenLog={(l) => {
            setSelectedLog(l);
            openLogModal();
          }}
        />
      ) : null}

      {tab === 'configure' ? (
        <ConfigureTab model={model} guardrails={guardrails} onDelete={handleDelete} deleting={deleting} />
      ) : null}

      {tab === 'logs' ? (
        <LogsTab
          logs={filteredLogs}
          loading={logsLoading}
          page={logsPage}
          pageSize={logsPageSize}
          setPage={setLogsPage}
          setPageSize={setLogsPageSize}
          hasMore={hasMoreLogs}
          query={logFilter}
          setQuery={setLogFilter}
          level={logLevel}
          setLevel={setLogLevel}
          onOpen={(l) => {
            setSelectedLog(l);
            openLogModal();
          }}
          tLogs={t}
          costCurrency={costCurrency}
        />
      ) : null}

      {tab === 'usage' ? <UsageTab model={model} /> : null}

      {/* Request Details Modal */}
      <Modal
        opened={logModalOpened}
        onClose={closeLogModal}
        title={t('logs.modal.title')}
        size="xl"
      >
        {selectedLog ? (
          <Stack gap="md">
            <div className="ds-card ds-card-pad-sm">
              <Stack gap="xs">
                <div className="ds-row ds-gap-xs">
                  <StatusBadge status={selectedLog.status === 'success' ? 'ok' : 'err'} />
                  {selectedLog.latencyMs ? (
                    <span className="ds-badge ds-badge-info">
                      {Math.round(selectedLog.latencyMs)} ms
                    </span>
                  ) : null}
                  {selectedLog.toolCalls !== undefined &&
                  selectedLog.toolCalls > 0 ? (
                    <span className="ds-badge ds-badge-warn">
                      <IconTool size={10} stroke={2} />
                      {t('logs.modal.toolCalls', { count: selectedLog.toolCalls })}
                    </span>
                  ) : null}
                  {selectedLog.cacheHit === true ? (
                    <span className="ds-badge ds-badge-teal">
                      {t('logs.cacheHit')}
                    </span>
                  ) : null}
                  {selectedLog.cacheHit === false && selectedLog.status === 'success' ? (
                    <span className="ds-badge">{t('logs.cacheMiss')}</span>
                  ) : null}
                </div>
                <Text size="sm">
                  <strong>{t('logs.modal.requestId')}:</strong>{' '}
                  <code>{selectedLog.requestId || '—'}</code>
                </Text>
                <Text size="sm">
                  <strong>{t('logs.route')}:</strong> {selectedLog.route}
                </Text>
                <Text size="sm">
                  <strong>{t('logs.timestamp')}:</strong>{' '}
                  {selectedLog.createdAt
                    ? new Date(selectedLog.createdAt).toLocaleString()
                    : '—'}
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
                {selectedLog.errorMessage ? (
                  <Text size="sm" c="red">
                    <strong>{t('logs.modal.error')}:</strong>{' '}
                    {selectedLog.errorMessage}
                  </Text>
                ) : null}
                {selectedLog.routing ? (
                  <>
                    <Text size="sm">
                      <strong>Routed to:</strong>{' '}
                      <code>{selectedLog.routing.chosenModelKey}</code>{' '}
                      <span className="ds-badge ds-badge-info">{selectedLog.routing.decision}</span>
                    </Text>
                    <Text size="sm" c="dimmed">
                      {selectedLog.routing.reason}
                    </Text>
                  </>
                ) : null}
              </Stack>
            </div>

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
        ) : null}
      </Modal>
    </PageContainer>
  );
}

/* ───────────────────────── Overview Tab ───────────────────────── */

interface OverviewTabProps {
  model: ModelDetailDto;
  usage: UsageAggregateDto | null;
  providerLabel: string;
  totalCost: number;
  costCurrency: string;
  successRate: number;
  sparkData: number[];
  chartData: Array<{ date: string; Cost: number; Calls: number; Tokens: number }>;
  recentLogs: UsageLogDto[];
  endpointUrl: string;
  dateFilter: ReturnType<typeof defaultDashboardDateFilter>;
  setDateFilter: (v: ReturnType<typeof defaultDashboardDateFilter>) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenLog: (l: UsageLogDto) => void;
}

function OverviewTab({
  model,
  usage,
  providerLabel,
  totalCost,
  costCurrency,
  successRate,
  sparkData,
  chartData,
  recentLogs,
  endpointUrl,
  dateFilter,
  setDateFilter,
  refreshing,
  onRefresh,
  onOpenLog,
}: OverviewTabProps) {
  const periods: Array<{ id: 'last_day' | 'last_7_days' | 'last_30_days' | 'total'; label: string }> = [
    { id: 'last_day', label: '24h' },
    { id: 'last_7_days', label: '7d' },
    { id: 'last_30_days', label: '30d' },
    { id: 'total', label: 'All' },
  ];

  const curlSample =
    model.category === 'llm'
      ? `curl -X POST ${endpointUrl} \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.key}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`
      : `curl -X POST ${endpointUrl} \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.key}",
    "input": "The quick brown fox"
  }'`;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 320px',
        gap: 16,
      }}
      className="ds-detail-grid"
    >
      {/* Left column */}
      <div className="ds-col ds-gap-md">
        {/* Performance card */}
        <div className="ds-card ds-card-pad-lg">
          <div className="ds-row-between" style={{ marginBottom: 14 }}>
            <div className="ds-h3">Performance · {periodLabel(dateFilter.period)}</div>
            <div className="ds-row ds-gap-xs">
              {periods.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    setDateFilter({ period: p.id, dateRange: [null, null] })
                  }
                  className={`ds-period-btn ${dateFilter.period === p.id ? 'active' : ''}`}
                >
                  {p.label}
                </button>
              ))}
              <ActionIcon
                variant="subtle"
                color="gray"
                radius="md"
                size="md"
                loading={refreshing}
                onClick={onRefresh}
                aria-label="Refresh"
              >
                <IconRefresh size={14} stroke={1.7} />
              </ActionIcon>
            </div>
          </div>
          <div
            className="ds-row ds-gap-lg"
            style={{
              marginBottom: 18,
              paddingBottom: 18,
              borderBottom: '1px solid var(--ds-border-soft)',
              flexWrap: 'wrap',
            }}
          >
            <MetricBlock label="Total calls" value={fmtNumber(usage?.totalCalls ?? 0)} />
            <MetricBlock label="Success rate" value={`${successRate}`} unit="%" />
            <MetricBlock
              label="Avg latency"
              value={usage?.avgLatencyMs != null ? `${Math.round(usage.avgLatencyMs)}` : '—'}
              unit={usage?.avgLatencyMs != null ? 'ms' : undefined}
            />
            <MetricBlock label="Tokens" value={fmtNumber(usage?.totalTokens ?? 0)} />
            <MetricBlock
              label="Spend"
              value={totalCost > 0 ? fmtCurrency(totalCost, costCurrency) : '—'}
            />
            <MetricBlock label="Errors" value={fmtNumber(usage?.errorCalls ?? 0)} />
          </div>
          <div>
            <div className="ds-row-between" style={{ marginBottom: 8 }}>
              <span className="ds-muted" style={{ fontSize: 12 }}>
                Calls per period
              </span>
              <span className="ds-faint" style={{ fontSize: 11 }}>
                {chartData.length} buckets
              </span>
            </div>
            {chartData.length > 1 ? (
              <AreaChart
                h={140}
                data={chartData}
                dataKey="date"
                series={[{ name: 'Calls', color: 'teal.6' }]}
                curveType="monotone"
                withDots={false}
                withGradient
                gridAxis="x"
                tickLine="x"
                tooltipAnimationDuration={150}
              />
            ) : (
              <Spark data={sparkData} height={120} color="var(--ds-accent)" />
            )}
          </div>
        </div>

        {/* Endpoint card */}
        <div className="ds-card ds-card-pad-lg">
          <div className="ds-row-between" style={{ marginBottom: 12 }}>
            <div className="ds-h3">Endpoint</div>
            <CopyButton value={curlSample} timeout={1500}>
              {({ copied, copy }) => (
                <Button
                  variant="default"
                  size="xs"
                  leftSection={
                    copied ? (
                      <IconCheck size={12} stroke={2} />
                    ) : (
                      <IconCopy size={12} stroke={1.7} />
                    )
                  }
                  onClick={copy}
                >
                  {copied ? 'Copied' : 'Copy curl'}
                </Button>
              )}
            </CopyButton>
          </div>
          <Code block style={{ fontSize: 12, whiteSpace: 'pre' }}>
            {curlSample}
          </Code>
        </div>

        {/* Recent requests */}
        <div className="ds-card">
          <div className="ds-row-between" style={{ padding: '14px 18px' }}>
            <div className="ds-h3">Recent requests</div>
            <Button
              variant="subtle"
              size="xs"
              rightSection={<IconArrowRight size={12} stroke={1.7} />}
              component={Link}
              href="/dashboard/tracing"
            >
              Open tracing
            </Button>
          </div>
          {recentLogs.length === 0 ? (
            <div className="ds-empty" style={{ padding: 36 }}>
              <Text size="sm" c="dimmed">
                No recent requests yet.
              </Text>
            </div>
          ) : (
            <div className="ds-tbl-wrap">
              <table className="ds-tbl">
                <thead>
                  <tr>
                    <th>Request ID</th>
                    <th>Started</th>
                    <th style={{ textAlign: 'right' }}>Tokens</th>
                    <th style={{ textAlign: 'right' }}>Latency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogs.map((l, i) => (
                    <tr
                      key={l._id ?? `${l.requestId}-${i}`}
                      className="clickable"
                      onClick={() => onOpenLog(l)}
                    >
                      <td
                        className="ds-mono"
                        style={{ fontSize: 12, color: 'var(--ds-text)' }}
                      >
                        {l.requestId ?? '—'}
                      </td>
                      <td
                        className="ds-muted"
                        style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}
                      >
                        {l.createdAt ? relativeDate(l.createdAt) : '—'}
                      </td>
                      <td
                        className="ds-mono"
                        style={{
                          textAlign: 'right',
                          fontSize: 12,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {fmtNumber(l.totalTokens)}
                      </td>
                      <td
                        className="ds-mono"
                        style={{
                          textAlign: 'right',
                          fontSize: 12,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {l.latencyMs ? `${Math.round(l.latencyMs)}ms` : '—'}
                      </td>
                      <td>
                        <StatusBadge status={l.status === 'success' ? 'ok' : 'err'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Right column */}
      <div className="ds-col ds-gap-md">
        <div className="ds-card ds-card-pad-lg">
          <div className="ds-h4" style={{ marginBottom: 12 }}>
            Details
          </div>
          {[
            ['Model ID', <span key="mid" className="ds-mono" style={{ fontSize: 12 }}>{model.modelId}</span>],
            ['Key', <span key="k" className="ds-mono" style={{ fontSize: 12 }}>{model.key}</span>],
            ['Provider', <span key="p">{providerLabel}</span>],
            ['Type', <span key="t" className="ds-badge">{model.category}</span>],
            ['Status', <StatusBadge key="s" status="active" />],
            ['Cache', <span key="c">{model.semanticCache?.enabled ? 'On' : 'Off'}</span>],
            ['Created', <span key="cr" className="ds-faint" style={{ fontSize: 12.5 }}>{model.createdAt ? new Date(model.createdAt).toLocaleDateString() : '—'}</span>],
            ['Updated', <span key="up" className="ds-faint" style={{ fontSize: 12.5 }}>{relativeDate(model.updatedAt)}</span>],
          ].map(([k, v], i) => (
            <div
              key={k as string}
              className="ds-row-between"
              style={{
                padding: '7px 0',
                borderTop: i ? '1px solid var(--ds-border-soft)' : 'none',
                fontSize: 12.5,
              }}
            >
              <span className="ds-muted">{k}</span>
              <span style={{ minWidth: 0, textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>

        <div className="ds-card ds-card-pad-lg">
          <div className="ds-h4" style={{ marginBottom: 12 }}>
            Pricing
          </div>
          <Stack gap="xs">
            <div className="ds-row-between" style={{ fontSize: 12.5 }}>
              <span className="ds-muted">Input</span>
              <span className="ds-mono">
                {model.pricing.inputTokenPer1M.toFixed(2)} {model.pricing.currency || 'USD'}/1M
              </span>
            </div>
            <div className="ds-row-between" style={{ fontSize: 12.5 }}>
              <span className="ds-muted">Output</span>
              <span className="ds-mono">
                {model.pricing.outputTokenPer1M.toFixed(2)} {model.pricing.currency || 'USD'}/1M
              </span>
            </div>
            {model.pricing.cachedTokenPer1M ? (
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">Cached</span>
                <span className="ds-mono">
                  {model.pricing.cachedTokenPer1M.toFixed(2)} {model.pricing.currency || 'USD'}/1M
                </span>
              </div>
            ) : null}
          </Stack>
        </div>

        {Object.keys(model.settings || {}).length > 0 ? (
          <div className="ds-card ds-card-pad-lg">
            <div className="ds-h4" style={{ marginBottom: 12 }}>
              Settings
            </div>
            <Stack gap="xs">
              {Object.entries(model.settings).map(([k, v]) => (
                <div
                  key={k}
                  className="ds-row-between"
                  style={{ fontSize: 12.5 }}
                >
                  <span className="ds-muted">{k}</span>
                  <span
                    className="ds-mono"
                    style={{
                      maxWidth: 150,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {typeof v === 'string' ? v : JSON.stringify(v)}
                  </span>
                </div>
              ))}
            </Stack>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MetricBlock({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="ds-muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 4,
          marginTop: 4,
        }}
      >
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
        {unit ? (
          <span className="ds-faint" style={{ fontSize: 12 }}>
            {unit}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ───────────────────────── Configure Tab ───────────────────────── */

function ConfigureTab({
  model,
  guardrails,
  onDelete,
  deleting,
}: {
  model: ModelDetailDto;
  guardrails: GuardrailLite[];
  onDelete: () => void;
  deleting: boolean;
}) {
  const inputGuardrail = guardrails.find((g) => g.key === model.inputGuardrailKey);
  const outputGuardrail = guardrails.find((g) => g.key === model.outputGuardrailKey);

  const renderGuardrail = (
    key: string | undefined,
    resolved: GuardrailLite | undefined,
  ) => {
    if (!key) return <span className="ds-faint">None</span>;
    return (
      <span className="ds-row ds-gap-xs" style={{ justifyContent: 'flex-end' }}>
        <span>{resolved?.name ?? key}</span>
        {resolved ? (
          <span className={`ds-badge ${resolved.action === 'block' ? 'ds-badge-err' : resolved.action === 'warn' ? 'ds-badge-warn' : 'ds-badge-info'}`}>
            {resolved.action}
          </span>
        ) : (
          <span className="ds-badge ds-badge-warn">missing</span>
        )}
      </span>
    );
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 280px',
        gap: 16,
      }}
      className="ds-detail-grid"
    >
      <div className="ds-col ds-gap-md">
        <div className="ds-card ds-card-pad-lg">
          <div className="ds-h3" style={{ marginBottom: 4 }}>
            General
          </div>
          <div
            className="ds-muted"
            style={{ fontSize: 12.5, marginBottom: 16 }}
          >
            Display name and routing identifier for this deployment.
          </div>
          <div className="ds-col ds-gap-md">
            <div>
              {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
              <label className="ds-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
                Display name
              </label>
              <input className="ds-input" defaultValue={model.name} readOnly />
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
              }}
            >
              <div>
                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
              <label className="ds-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
                  Endpoint key
                </label>
                <input
                  className="ds-input ds-mono"
                  defaultValue={model.key}
                  readOnly
                />
              </div>
              <div>
                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
              <label className="ds-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
                  Model ID
                </label>
                <input
                  className="ds-input ds-mono"
                  defaultValue={model.modelId}
                  readOnly
                />
              </div>
            </div>
            {model.description ? (
              <div>
                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
              <label className="ds-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
                  Description
                </label>
                <textarea
                  className="ds-input"
                  rows={2}
                  defaultValue={model.description}
                  readOnly
                />
              </div>
            ) : null}
          </div>
        </div>

        {model.semanticCache?.enabled ? (
          <div className="ds-card ds-card-pad-lg">
            <div className="ds-h3" style={{ marginBottom: 4 }}>
              Semantic cache
            </div>
            <div
              className="ds-muted"
              style={{ fontSize: 12.5, marginBottom: 16 }}
            >
              Reuses semantically similar prompts to reduce cost.
            </div>
            <Stack gap="xs">
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">Vector provider</span>
                <span className="ds-mono">{model.semanticCache.vectorProviderKey}</span>
              </div>
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">Vector index</span>
                <span className="ds-mono">{model.semanticCache.vectorIndexKey}</span>
              </div>
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">Embedding model</span>
                <span className="ds-mono">{model.semanticCache.embeddingModelKey}</span>
              </div>
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">Similarity threshold</span>
                <span className="ds-mono">
                  {model.semanticCache.similarityThreshold.toFixed(2)}
                </span>
              </div>
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">TTL</span>
                <span className="ds-mono">{model.semanticCache.ttlSeconds}s</span>
              </div>
            </Stack>
          </div>
        ) : null}

        {model.category === 'llm' ? (
          <div className="ds-card ds-card-pad-lg">
            <div className="ds-row-between" style={{ marginBottom: 4 }}>
              <div className="ds-h3">Guardrails</div>
              <Button
                component={Link}
                href={`/dashboard/models/${model._id}/edit`}
                variant="subtle"
                size="xs"
                leftSection={<IconSettings size={12} stroke={1.7} />}
                style={{ paddingInline: 8 }}
              >
                Edit
              </Button>
            </div>
            <div className="ds-muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
              Safety checks applied automatically on every request to this model.
            </div>
            <Stack gap="xs">
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">Input guardrail</span>
                {renderGuardrail(model.inputGuardrailKey, inputGuardrail)}
              </div>
              <div className="ds-row-between" style={{ fontSize: 12.5 }}>
                <span className="ds-muted">Output guardrail</span>
                {renderGuardrail(model.outputGuardrailKey, outputGuardrail)}
              </div>
            </Stack>
          </div>
        ) : null}

        <div
          className="ds-card ds-card-pad-lg"
          style={{ borderColor: 'rgba(201, 59, 59, 0.2)' }}
        >
          <div
            className="ds-h3"
            style={{ marginBottom: 4, color: 'var(--ds-err)' }}
          >
            Danger zone
          </div>
          <div
            className="ds-muted"
            style={{ fontSize: 12.5, marginBottom: 16 }}
          >
            Irreversible actions for this deployment.
          </div>
          <div
            className="ds-row-between"
            style={{
              padding: '12px 0',
              borderTop: '1px solid var(--ds-border-soft)',
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                Delete deployment
              </div>
              <div className="ds-muted" style={{ fontSize: 12 }}>
                This cannot be undone.
              </div>
            </div>
            <Button
              variant="default"
              color="red"
              size="sm"
              loading={deleting}
              onClick={onDelete}
              leftSection={<IconTrash size={13} stroke={1.7} />}
              style={{ color: 'var(--ds-err)' }}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>

      <div className="ds-col ds-gap-md">
        <div className="ds-card ds-card-pad-lg">
          <div className="ds-h4" style={{ marginBottom: 12 }}>
            Save changes
          </div>
          <p
            className="ds-muted"
            style={{ fontSize: 12.5, marginBottom: 12 }}
          >
            Configuration is read-only here. Use the edit page to change settings.
          </p>
          <Button
            component={Link}
            href={`/dashboard/models/${model._id}/edit`}
            color="teal"
            fullWidth
            leftSection={<IconSettings size={13} stroke={1.7} />}
          >
            Open editor
          </Button>
        </div>
        <div className="ds-card ds-card-pad-lg">
          <div className="ds-h4" style={{ marginBottom: 8 }}>
            Help
          </div>
          <div
            className="ds-muted"
            style={{ fontSize: 12.5, lineHeight: 1.5 }}
          >
            Learn how routing, caching and guardrails interact for inference
            endpoints.
          </div>
          <Button
            component={Link}
            href="/dashboard/docs"
            variant="subtle"
            size="xs"
            mt="sm"
            rightSection={<IconExternalLink size={11} stroke={1.7} />}
            style={{ paddingLeft: 0 }}
          >
            Read docs
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Routing Tab (Dynamic LLM) ───────────────────────── */

function RoutingTab({
  config,
  logs,
  onOpenLog,
}: {
  config: IDynamicRoutingConfig;
  logs: UsageLogDto[];
  onOpenLog: (l: UsageLogDto) => void;
}) {
  const decisions = logs.filter((l) => l.routing);

  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16 }}
      className="ds-detail-grid"
    >
      {/* Left: decision log */}
      <div className="ds-card">
        <div className="ds-row-between" style={{ padding: '14px 18px' }}>
          <div className="ds-h3">Routing decisions</div>
          <span className="ds-faint" style={{ fontSize: 12 }}>
            {decisions.length} recent
          </span>
        </div>
        {decisions.length === 0 ? (
          <div className="ds-empty" style={{ padding: 36 }}>
            <Text size="sm" c="dimmed">
              No routing decisions recorded yet. Send a request to this model key to see how it
              routes.
            </Text>
          </div>
        ) : (
          <div className="ds-tbl-wrap">
            <table className="ds-tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Routed to</th>
                  <th>Decision</th>
                  <th>Reason</th>
                  <th style={{ textAlign: 'right' }}>Latency</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((l, i) => (
                  <tr
                    key={l._id ?? `${l.requestId}-${i}`}
                    className="clickable"
                    onClick={() => onOpenLog(l)}
                  >
                    <td className="ds-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {l.createdAt ? relativeDate(l.createdAt) : '—'}
                    </td>
                    <td className="ds-mono" style={{ fontSize: 12 }}>
                      {l.routing?.chosenModelKey ?? '—'}
                    </td>
                    <td>
                      <span
                        className={`ds-badge ${
                          l.routing?.decision === 'fallback' ? 'ds-badge-warn' : 'ds-badge-info'
                        }`}
                      >
                        {l.routing?.decision}
                        {l.routing?.matchedRuleLabel ? ` · ${l.routing.matchedRuleLabel}` : ''}
                        {l.routing?.deciderLabel ? ` · ${l.routing.deciderLabel}` : ''}
                      </span>
                    </td>
                    <td className="ds-muted" style={{ fontSize: 12, maxWidth: 260 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          maxWidth: 260,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {l.routing?.reason}
                      </span>
                    </td>
                    <td
                      className="ds-mono"
                      style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                    >
                      {l.latencyMs ? `${Math.round(l.latencyMs)}ms` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Right: config summary */}
      <div className="ds-col ds-gap-md">
        <div className="ds-card ds-card-pad-lg">
          <div className="ds-h4" style={{ marginBottom: 12 }}>
            Configuration
          </div>
          <Stack gap="xs">
            <div className="ds-row-between" style={{ fontSize: 12.5 }}>
              <span className="ds-muted">Strategy</span>
              <span className="ds-badge">{config.strategy}</span>
            </div>
            <div className="ds-row-between" style={{ fontSize: 12.5 }}>
              <span className="ds-muted">Default</span>
              <span className="ds-mono">{config.defaultModelKey}</span>
            </div>
            <div className="ds-row-between" style={{ fontSize: 12.5 }}>
              <span className="ds-muted">Fallback</span>
              <span className="ds-mono">{config.fallbackModelKey || '—'}</span>
            </div>
          </Stack>
        </div>

        {config.strategy === 'rule-based' ? (
          <div className="ds-card ds-card-pad-lg">
            <div className="ds-h4" style={{ marginBottom: 12 }}>
              Rules ({config.rules?.length ?? 0})
            </div>
            <Stack gap="sm">
              {(config.rules ?? []).map((rule, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 12.5,
                    borderTop: i ? '1px solid var(--ds-border-soft)' : 'none',
                    paddingTop: i ? 8 : 0,
                  }}
                >
                  <div className="ds-row-between">
                    <span style={{ fontWeight: 500 }}>{rule.label || `rule ${i + 1}`}</span>
                    <span className="ds-mono ds-faint">→ {rule.targetModelKey}</span>
                  </div>
                  <div className="ds-faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {(rule.matchType ?? 'all') === 'any' ? 'any of: ' : 'all of: '}
                    {rule.conditions
                      .map((c) => `${c.signal} ${c.operator}${c.value !== undefined ? ` ${c.value}` : ''}`)
                      .join(' , ')}
                  </div>
                </div>
              ))}
            </Stack>
          </div>
        ) : (
          <div className="ds-card ds-card-pad-lg">
            <div className="ds-h4" style={{ marginBottom: 12 }}>
              Decider
            </div>
            <div className="ds-row-between" style={{ fontSize: 12.5, marginBottom: 8 }}>
              <span className="ds-muted">Model</span>
              <span className="ds-mono">{config.decider?.modelKey}</span>
            </div>
            <Stack gap="sm">
              {(config.decider?.labels ?? []).map((label, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 12.5,
                    borderTop: i ? '1px solid var(--ds-border-soft)' : 'none',
                    paddingTop: i ? 8 : 0,
                  }}
                >
                  <div className="ds-row-between">
                    <span style={{ fontWeight: 500 }}>{label.label}</span>
                    <span className="ds-mono ds-faint">→ {label.targetModelKey}</span>
                  </div>
                  {label.description ? (
                    <div className="ds-faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {label.description}
                    </div>
                  ) : null}
                </div>
              ))}
            </Stack>
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Logs Tab ───────────────────────── */

interface LogsTabProps {
  logs: UsageLogDto[];
  loading: boolean;
  page: number;
  pageSize: number;
  setPage: (n: number) => void;
  setPageSize: (n: number) => void;
  hasMore: boolean;
  query: string;
  setQuery: (v: string) => void;
  level: 'all' | 'error';
  setLevel: (v: 'all' | 'error') => void;
  onOpen: (l: UsageLogDto) => void;
  tLogs: ReturnType<typeof useTranslations>;
  costCurrency: string;
}

function LogsTab({
  logs,
  loading,
  page,
  pageSize,
  setPage,
  setPageSize,
  hasMore,
  query,
  setQuery,
  level,
  setLevel,
  onOpen,
  tLogs,
}: LogsTabProps) {
  return (
    <div className="ds-card" style={{ overflow: 'hidden' }}>
      <Toolbar
        searchValue={query}
        onSearchChange={setQuery}
        searchPlaceholder="Filter logs…"
      >
        <select
          className="ds-select"
          value={level}
          onChange={(e) => setLevel(e.target.value as 'all' | 'error')}
          style={{ minWidth: 120 }}
        >
          <option value="all">All levels</option>
          <option value="error">Errors only</option>
        </select>
        <div style={{ flex: 1 }} />
        <div className="ds-row ds-gap-xs">
          {PAGE_SIZE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`ds-period-btn ${pageSize === s ? 'active' : ''}`}
              onClick={() => {
                setPageSize(s);
                setPage(1);
              }}
            >
              {s}/page
            </button>
          ))}
        </div>
      </Toolbar>

      {loading ? (
        <Center py="xl">
          <Loader size="sm" color="teal" />
        </Center>
      ) : logs.length === 0 ? (
        <div className="ds-empty" style={{ padding: 48 }}>
          <Text size="sm" c="dimmed">
            {tLogs('logs.empty')}
          </Text>
        </div>
      ) : (
        <div className="ds-tbl-wrap">
          <table className="ds-tbl">
            <thead>
              <tr>
                <th>{tLogs('logs.timestamp')}</th>
                <th>{tLogs('logs.route')}</th>
                <th>{tLogs('logs.status')}</th>
                <th style={{ textAlign: 'right' }}>{tLogs('logs.latency')}</th>
                <th style={{ textAlign: 'right' }}>{tLogs('logs.tokens')}</th>
                <th>Request ID</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr
                  key={l._id ?? `${l.route}-${l.createdAt}`}
                  className="clickable"
                  onClick={() => onOpen(l)}
                >
                  <td className="ds-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {l.createdAt ? new Date(l.createdAt).toLocaleString() : '—'}
                  </td>
                  <td className="ds-mono" style={{ fontSize: 12 }}>
                    {l.route}
                  </td>
                  <td>
                    <div className="ds-row ds-gap-xs">
                      <StatusBadge status={l.status === 'success' ? 'ok' : 'err'} />
                      {l.cacheHit === true ? (
                        <span className="ds-badge ds-badge-teal">cache</span>
                      ) : null}
                    </div>
                  </td>
                  <td
                    className="ds-mono"
                    style={{
                      textAlign: 'right',
                      fontSize: 12,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {l.latencyMs ? `${Math.round(l.latencyMs)}ms` : '—'}
                  </td>
                  <td
                    className="ds-mono"
                    style={{
                      textAlign: 'right',
                      fontSize: 12,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {l.totalTokens.toLocaleString()}
                  </td>
                  <td className="ds-mono ds-faint" style={{ fontSize: 12 }}>
                    {l.requestId ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        className="ds-row-between"
        style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--ds-border-soft)',
          fontSize: 12.5,
          color: 'var(--ds-text-muted)',
        }}
      >
        <span>Page {page}</span>
        <div className="ds-row ds-gap-sm">
          <Button
            variant="default"
            size="xs"
            disabled={page <= 1 || loading}
            leftSection={<IconChevronLeft size={12} />}
            onClick={() => setPage(Math.max(1, page - 1))}
          >
            Prev
          </Button>
          <Button
            variant="default"
            size="xs"
            disabled={!hasMore || loading}
            rightSection={<IconChevronRight size={12} />}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Usage (code samples) Tab ───────────────────────── */

function UsageTab({ model }: { model: ModelDetailDto }) {
  const base =
    typeof window !== 'undefined' ? window.location.origin : 'https://your-host';
  const isLlm = model.category === 'llm';

  const curl = isLlm
    ? `curl -X POST ${base}/api/client/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.key}",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user",   "content": "Hello!" }
    ],
    "temperature": 0.7
  }'`
    : `curl -X POST ${base}/api/client/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.key}",
    "input": "The quick brown fox"
  }'`;

  const ts = isLlm
    ? `import ConsoleClient from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: 'YOUR_API_TOKEN',
  baseUrl: '${base}',
});

const response = await client.chat.completions({
  model: '${model.key}',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);`
    : `import ConsoleClient from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: 'YOUR_API_TOKEN',
  baseUrl: '${base}',
});

const response = await client.embeddings.create({
  model: '${model.key}',
  input: 'The quick brown fox',
});

console.log(response.data[0].embedding);`;

  const python = isLlm
    ? `import httpx

response = httpx.post(
    "${base}/api/client/v1/chat/completions",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
    json={
        "model": "${model.key}",
        "messages": [{"role": "user", "content": "Hello!"}],
    },
)
print(response.json()["choices"][0]["message"]["content"])`
    : `import httpx

response = httpx.post(
    "${base}/api/client/v1/embeddings",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
    json={"model": "${model.key}", "input": "The quick brown fox"},
)
print(response.json()["data"][0]["embedding"][:5])`;

  const openai = isLlm
    ? `from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_TOKEN",
    base_url="${base}/api/client/v1",
)

response = client.chat.completions.create(
    model="${model.key}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`
    : null;

  return (
    <div className="ds-col ds-gap-md">
      <div className="ds-card ds-card-pad-lg">
        <div className="ds-h4" style={{ marginBottom: 8 }}>
          Model key
        </div>
        <div className="ds-row ds-gap-sm">
          <Code style={{ flex: 1, fontSize: 12 }}>{model.key}</Code>
          <CopyButton value={model.key} timeout={1500}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                variant={copied ? 'filled' : 'default'}
                color={copied ? 'teal' : undefined}
                leftSection={
                  copied ? (
                    <IconCheck size={12} stroke={2} />
                  ) : (
                    <IconCopy size={12} stroke={1.7} />
                  )
                }
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        </div>
      </div>

      <CodeBlock title={`cURL — ${isLlm ? 'Chat completion' : 'Embeddings'}`} code={curl} />
      <CodeBlock
        title={`TypeScript SDK — ${isLlm ? 'Chat completion' : 'Embeddings'}`}
        code={ts}
      />
      <CodeBlock
        title={`Python (httpx) — ${isLlm ? 'Chat completion' : 'Embeddings'}`}
        code={python}
      />
      {openai ? <CodeBlock title="Python — OpenAI compatible" code={openai} /> : null}
    </div>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="ds-card ds-card-pad-lg">
      <div className="ds-row-between" style={{ marginBottom: 10 }}>
        <div className="ds-h4">{title}</div>
        <CopyButton value={code} timeout={1500}>
          {({ copied, copy }) => (
            <Button
              variant="default"
              size="xs"
              leftSection={
                copied ? (
                  <IconCheck size={12} stroke={2} />
                ) : (
                  <IconCopy size={12} stroke={1.7} />
                )
              }
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </div>
      <Code block style={{ fontSize: 12, whiteSpace: 'pre' }}>
        {code}
      </Code>
    </div>
  );
}

function periodLabel(period: string): string {
  switch (period) {
    case 'total':
      return 'all time';
    case 'last_day':
      return 'last 24h';
    case 'last_7_days':
      return 'last 7 days';
    case 'last_30_days':
      return 'last 30 days';
    case 'custom':
      return 'custom range';
    default:
      return period;
  }
}
