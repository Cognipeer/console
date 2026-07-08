'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Button,
  Center,
  Loader,
  Progress,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowsSplit,
  IconBolt,
  IconBrain,
  IconChartBar,
  IconCoins,
  IconCpu,
  IconEdit,
  IconExternalLink,
  IconEye,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconShield,
  IconSparkles,
  IconTimeline,
  IconTrash,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import type { ModelProviderView } from '@/lib/services/models/types';
import CreateModelModal from '@/components/models/CreateModelModal';
import ModelProviderModal from '@/components/models/ModelProviderModal';
import CreateDynamicModelModal, {
  type CandidateModel,
  type DynamicModelInit,
} from '@/components/models/CreateDynamicModelModal';
import ModelGuardrailModal from '@/components/models/ModelGuardrailModal';
import type { IDynamicRoutingConfig, IModel } from '@/lib/database';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

interface ModelsDashboardOverview {
  totalModels: number;
  llmCount: number;
  embeddingCount: number;
  providerCount: number;
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalToolCalls: number;
  cacheHits: number;
  cacheHitRate: number;
  avgLatencyMs: number | null;
  totalCost: number;
  currency: string;
  errorRate: number;
}

interface ModelTopEntry {
  key: string;
  name: string;
  category: 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr';
  callCount: number;
  totalTokens: number;
  totalCost: number;
  errorRate: number;
  avgLatencyMs: number | null;
}

interface DailyEntry {
  period: string;
  callCount: number;
  totalTokens: number;
}

interface ModelsDashboardData {
  overview: ModelsDashboardOverview;
  topModels: ModelTopEntry[];
  daily: DailyEntry[];
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** A Dynamic LLM is a virtual `llm` model carrying a routing config. */
function dynamicConfigOf(m: { settings?: Record<string, unknown> }): IDynamicRoutingConfig | null {
  const dyn = m.settings?.dynamic;
  if (dyn && typeof dyn === 'object' && typeof (dyn as { strategy?: unknown }).strategy === 'string') {
    return dyn as IDynamicRoutingConfig;
  }
  return null;
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtCost(cost: number, currency = 'USD'): string {
  if (cost === 0) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cost);
}

interface ModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
}

interface ModelDto {
  _id: string;
  name: string;
  description?: string;
  key: string;
  provider?: string;
  providerKey: string;
  providerDriver: string;
  category: 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

type ModelCategory = 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr';
type CategoryFilter = 'all' | ModelCategory;
type CapabilityFilter = 'all' | 'multimodal' | 'tools';

const MODEL_TYPE_KEYS: ModelCategory[] = ['llm', 'embedding', 'rerank', 'stt', 'tts', 'ocr'];

/** Human-readable labels for each model category — kept in sync with the left sub-nav. */
const TYPE_LABELS: Record<CategoryFilter, string> = {
  all: 'All models',
  llm: 'LLM',
  embedding: 'Embedding',
  rerank: 'Rerank',
  stt: 'Speech-to-Text',
  tts: 'Text-to-Speech',
  ocr: 'OCR',
};

export default function ModelsPage() {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [dashboardData, setDashboardData] = useState<ModelsDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [dynamicModalOpen, setDynamicModalOpen] = useState(false);
  const [dynamicEdit, setDynamicEdit] = useState<DynamicModelInit | null>(null);
  const [guardrailModel, setGuardrailModel] = useState<ModelDto | null>(null);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();

  const [capability, setCapability] = useState<CapabilityFilter>('all');
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const t = useTranslations('models');
  const tNav = useTranslations('navigation');
  const router = useRouter();
  const searchParams = useSearchParams();

  // The model type is driven by the left sub-nav via the `?type=` query param.
  const typeParam = searchParams.get('type');
  const activeType: CategoryFilter =
    typeParam && MODEL_TYPE_KEYS.includes(typeParam as ModelCategory)
      ? (typeParam as ModelCategory)
      : 'all';

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/models?includeProviders=true', {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Failed to load models');
      const data = await response.json();
      setModels((data.models ?? []) as ModelDto[]);
      setProviders((data.providers ?? []) as ModelProviderView[]);
    } catch (error) {
      console.error('Failed to load models', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/models/dashboard?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = (await res.json()) as ModelsDashboardData;
        setDashboardData(data);
      }
    } catch (err) {
      console.error('Failed to load models dashboard', err);
    } finally {
      setDashboardLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    void loadModels();
    void loadDashboard();
  }, [loadModels, loadDashboard]);

  const handleModelCreated = ({
    model,
    provider,
  }: {
    model: IModel;
    provider: ModelProviderView;
  }) => {
    const normalized: ModelDto = {
      _id: String(model._id ?? crypto.randomUUID()),
      name: model.name,
      description: model.description,
      key: model.key,
      provider: model.provider,
      providerKey: model.providerKey,
      providerDriver: model.providerDriver,
      category: model.category,
      modelId: model.modelId,
      isMultimodal: model.isMultimodal,
      supportsToolCalls: model.supportsToolCalls,
      pricing: model.pricing as ModelPricing,
      settings: model.settings ?? {},
      createdAt: model.createdAt ? String(model.createdAt) : undefined,
      updatedAt: model.updatedAt ? String(model.updatedAt) : undefined,
    };
    setModels((current) => [
      normalized,
      ...current.filter((m) => m._id !== normalized._id),
    ]);
    setProviders((current) =>
      current.some((p) => p.key === provider.key) ? current : [...current, provider],
    );
    void loadModels();
  };

  const handleProviderCreated = (provider: ModelProviderView) => {
    setProviders((current) =>
      current.some((p) => p.key === provider.key) ? current : [...current, provider],
    );
    // Chain straight into model creation so the freshly-added provider is ready to pick.
    setCreateModalOpen(true);
  };

  const providerLookup = useMemo(() => {
    const map = new Map<string, ModelProviderView>();
    providers.forEach((p) => map.set(p.key, p));
    return map;
  }, [providers]);

  const usageByKey = useMemo(() => {
    const map = new Map<string, ModelTopEntry>();
    (dashboardData?.topModels ?? []).forEach((m) => map.set(m.key, m));
    return map;
  }, [dashboardData]);

  const counts = useMemo(() => {
    const llm = models.filter((m) => m.category === 'llm').length;
    const embedding = models.filter((m) => m.category === 'embedding').length;
    const multimodal = models.filter((m) => m.isMultimodal).length;
    return { all: models.length, llm, embedding, multimodal };
  }, [models]);

  // Routing targets: real LLM models only (a router can't target another router).
  const dynamicCandidates = useMemo<CandidateModel[]>(
    () =>
      models
        .filter((m) => m.category === 'llm' && !dynamicConfigOf(m))
        .map((m) => ({ key: m.key, name: m.name })),
    [models],
  );

  const openDynamicCreate = () => {
    setDynamicEdit(null);
    setDynamicModalOpen(true);
  };

  const openDynamicEdit = (m: ModelDto) => {
    const dynamic = dynamicConfigOf(m);
    if (!dynamic) return;
    setDynamicEdit({ _id: m._id, name: m.name, description: m.description, key: m.key, dynamic });
    setDynamicModalOpen(true);
  };

  const filtered = useMemo(() => {
    return models.filter((m) => {
      if (activeType !== 'all' && m.category !== activeType) return false;
      if (capability === 'multimodal' && !m.isMultimodal) return false;
      if (capability === 'tools' && !m.supportsToolCalls) return false;
      if (providerFilter !== 'all' && m.providerKey !== providerFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        const matches =
          m.name.toLowerCase().includes(q) ||
          m.key.toLowerCase().includes(q) ||
          m.modelId.toLowerCase().includes(q) ||
          (m.description ?? '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [models, activeType, capability, query, providerFilter]);

  const modelsCtl = useTableControls(filtered, {
    filterKey: `${activeType}|${capability}|${query}|${providerFilter}`,
  });

  const handleDeleteModel = async (model: ModelDto) => {
    const confirmed = window.confirm(t('actions.deleteConfirm'));
    if (!confirmed) return;
    setDeletingModelId(model._id);
    try {
      const response = await fetch(`/api/models/${model._id}`, { method: 'DELETE' });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to delete model' }));
        throw new Error(error.error ?? 'Failed to delete model');
      }
      setModels((current) => current.filter((m) => m._id !== model._id));
      void loadDashboard();
      notifications.show({
        color: 'green',
        title: t('actions.delete'),
        message: t('actions.deleteSuccess'),
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('actions.deleteFailedTitle'),
        message:
          error instanceof Error ? error.message : t('actions.deleteFailedMessage'),
      });
    } finally {
      setDeletingModelId(null);
    }
  };

  const refreshAll = () => {
    void loadModels();
    void loadDashboard();
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          activeType === 'all'
            ? 'Build · Models'
            : `Build · Models · ${TYPE_LABELS[activeType]}`
        }
        title={activeType === 'all' ? tNav('models') : TYPE_LABELS[activeType]}
        subtitle={
          activeType === 'all'
            ? `Manage inference endpoints across providers. ${models.length} deployed in this project.`
            : `${TYPE_LABELS[activeType]} endpoints · ${filtered.length} of ${models.length} models.`
        }
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="default"
              size="sm"
              leftSection={<IconPlug size={14} stroke={1.7} />}
              onClick={() => setProviderModalOpen(true)}
            >
              Add provider
            </Button>
            <Button
              variant="subtle"
              size="sm"
              leftSection={<IconExternalLink size={14} stroke={1.7} />}
              component={Link}
              href="/dashboard/providers"
            >
              Browse providers
            </Button>
            <Button
              variant="default"
              size="sm"
              leftSection={<IconArrowsSplit size={14} stroke={1.7} />}
              onClick={openDynamicCreate}
            >
              Dynamic LLM
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlus size={14} stroke={1.7} />}
              onClick={() => setCreateModalOpen(true)}
            >
              {t('actions.create')}
            </Button>
          </>
        }
      />

      {/* Stat tiles */}
      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label={t('metrics.totalModels')}
          icon={<IconSparkles size={14} stroke={1.7} />}
          value={dashboardData?.overview.totalModels ?? models.length}
        />
        <StatTile
          label={t('metrics.llmModels')}
          icon={<IconBrain size={14} stroke={1.7} />}
          value={dashboardData?.overview.llmCount ?? counts.llm}
        />
        <StatTile
          label={t('metrics.embeddingModels')}
          icon={<IconCpu size={14} stroke={1.7} />}
          value={dashboardData?.overview.embeddingCount ?? counts.embedding}
        />
        <StatTile
          label={t('metrics.providers')}
          icon={<IconPlug size={14} stroke={1.7} />}
          value={dashboardData?.overview.providerCount ?? providers.length}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <DataGrid<ModelDto>
          records={modelsCtl.records}
          loading={loading}
          rowKey={(m) => m._id}
          pagination={modelsCtl.pagination}
          onRowClick={(m) => router.push(`/dashboard/models/${m._id}`)}
          search={{
            value: query,
            onChange: setQuery,
            placeholder: 'Filter by name, key, or model id…',
          }}
          filters={[
            {
              value: capability,
              onChange: (v) => setCapability(v as CapabilityFilter),
              ariaLabel: 'Filter by capability',
              width: 150,
              options: [
                { value: 'all', label: 'All capabilities' },
                { value: 'multimodal', label: 'Multimodal' },
                { value: 'tools', label: 'Tool calls' },
              ],
            },
            {
              value: providerFilter,
              onChange: setProviderFilter,
              ariaLabel: 'Filter by provider',
              width: 160,
              options: [
                { value: 'all', label: 'All providers' },
                ...providers.map((p) => ({
                  value: p.key,
                  label: p.label || p.key,
                })),
              ],
            },
          ]}
          onRefresh={refreshAll}
          selectable
          selected={selected}
          onSelectionChange={setSelected}
          bulkActions={[
            {
              label: 'Delete',
              icon: <IconTrash size={12} stroke={1.7} />,
              color: 'red',
              onClick: (rows) => {
                rows.forEach((m) => void handleDeleteModel(m));
                setSelected(new Set());
              },
            },
          ]}
          empty={{
            icon: <IconBrain size={26} stroke={1.7} />,
            title: t('list.empty'),
            description: 'Add your first model to get started.',
            primaryAction: {
              label: t('actions.create'),
              icon: <IconPlus size={14} stroke={1.7} />,
              onClick: () => setCreateModalOpen(true),
            },
          }}
          footerLeft={`Showing ${modelsCtl.records.length} of ${filtered.length} models`}
          columns={modelColumns(t, providerLookup, usageByKey, dashboardData)}
          rowActions={(m) => [
            {
              id: 'view',
              label: t('actions.viewDetails'),
              icon: <IconEye size={14} />,
              onClick: () => router.push(`/dashboard/models/${m._id}`),
            },
            {
              id: 'edit',
              label: t('actions.edit'),
              icon: <IconEdit size={14} />,
              onClick: () =>
                dynamicConfigOf(m)
                  ? openDynamicEdit(m)
                  : router.push(`/dashboard/models/${m._id}/edit`),
            },
            { divider: true },
            {
              id: 'guardrail',
              label: 'Guardrail settings',
              icon: <IconShield size={14} />,
              onClick: () => setGuardrailModel(m),
            },
            {
              id: 'delete',
              label: t('actions.delete'),
              icon: <IconTrash size={14} />,
              color: 'red',
              disabled: deletingModelId === m._id,
              onClick: () => void handleDeleteModel(m),
            },
          ]}
        />
      </div>

      {/* Usage analytics */}
      <div className="ds-card ds-card-pad-lg">
        <div className="ds-row-between" style={{ marginBottom: 14 }}>
          <div>
            <div className="ds-h3">Usage analytics</div>
            <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              Aggregate usage across all models · {periodLabel(dateFilter.period)}
            </div>
          </div>
          <Button
            variant="subtle"
            size="xs"
            leftSection={<IconRefresh size={12} stroke={1.7} />}
            loading={dashboardLoading}
            onClick={() => void loadDashboard()}
          >
            Refresh
          </Button>
        </div>

        {dashboardLoading && !dashboardData ? (
          <Center py="xl">
            <Loader size="sm" color="teal" />
          </Center>
        ) : (
          <Stack gap="md">
            <div className="ds-stat-grid">
              <StatTile
                label="Total calls"
                icon={<IconActivity size={14} stroke={1.7} />}
                value={fmtNum(dashboardData?.overview.totalCalls ?? 0)}
                delta={`${fmtPct(dashboardData?.overview.errorRate ?? 0)} error rate`}
                deltaDir={
                  (dashboardData?.overview.errorRate ?? 0) > 0.05 ? 'down' : null
                }
              />
              <StatTile
                label="Total tokens"
                icon={<IconCpu size={14} stroke={1.7} />}
                value={fmtNum(dashboardData?.overview.totalTokens ?? 0)}
                delta={`in: ${fmtNum(
                  dashboardData?.overview.totalInputTokens ?? 0,
                )} · out: ${fmtNum(dashboardData?.overview.totalOutputTokens ?? 0)}`}
              />
              <StatTile
                label="Avg latency"
                icon={<IconBolt size={14} stroke={1.7} />}
                value={
                  dashboardData?.overview.avgLatencyMs != null
                    ? `${dashboardData.overview.avgLatencyMs}`
                    : '—'
                }
                unit={dashboardData?.overview.avgLatencyMs != null ? 'ms' : undefined}
                delta={`${fmtNum(dashboardData?.overview.cacheHits ?? 0)} cache hits (${fmtPct(
                  dashboardData?.overview.cacheHitRate ?? 0,
                )})`}
              />
              <StatTile
                label="Total cost"
                icon={<IconCoins size={14} stroke={1.7} />}
                value={fmtCost(
                  dashboardData?.overview.totalCost ?? 0,
                  dashboardData?.overview.currency,
                )}
                delta={`${fmtNum(dashboardData?.overview.totalToolCalls ?? 0)} tool calls`}
              />
            </div>

            <div className="ds-grid-two">
              {/* Top models */}
              <div
                style={{
                  border: '1px solid var(--ds-border-soft)',
                  borderRadius: 'var(--ds-r-sm)',
                  padding: 14,
                }}
              >
                <div className="ds-row ds-gap-sm" style={{ marginBottom: 10 }}>
                  <ThemeIcon size={26} radius="md" variant="light" color="teal">
                    <IconChartBar size={13} />
                  </ThemeIcon>
                  <div className="ds-h4">Top models by calls</div>
                </div>
                {(dashboardData?.topModels ?? []).length === 0 ? (
                  <Text size="sm" c="dimmed" ta="center" py="md">
                    No usage data yet
                  </Text>
                ) : (
                  <Stack gap={10}>
                    {(dashboardData?.topModels ?? []).slice(0, 5).map((item) => {
                      const maxCalls = Math.max(
                        ...(dashboardData?.topModels ?? []).map((x) => x.callCount),
                        1,
                      );
                      const pct = (item.callCount / maxCalls) * 100;
                      return (
                        <Stack gap={4} key={item.key}>
                          <div className="ds-row-between">
                            <div className="ds-row ds-gap-xs">
                              <ThemeIcon
                                size={20}
                                radius="sm"
                                variant="light"
                                color={item.category === 'llm' ? 'teal' : 'violet'}
                              >
                                {item.category === 'llm' ? (
                                  <IconBrain size={11} />
                                ) : (
                                  <IconCpu size={11} />
                                )}
                              </ThemeIcon>
                              <Text size="xs" fw={500} lineClamp={1}>
                                {item.name}
                              </Text>
                            </div>
                            <span className="ds-badge ds-badge-teal">
                              {fmtNum(item.callCount)} calls
                            </span>
                          </div>
                          <Progress
                            value={pct}
                            size="xs"
                            color="teal"
                            radius="xl"
                          />
                        </Stack>
                      );
                    })}
                  </Stack>
                )}
              </div>

              {/* Daily trend */}
              <div
                style={{
                  border: '1px solid var(--ds-border-soft)',
                  borderRadius: 'var(--ds-r-sm)',
                  padding: 14,
                }}
              >
                <div className="ds-row ds-gap-sm" style={{ marginBottom: 10 }}>
                  <ThemeIcon size={26} radius="md" variant="light" color="blue">
                    <IconTimeline size={13} />
                  </ThemeIcon>
                  <div className="ds-h4">Recent trend (last 14 days)</div>
                </div>
                {(dashboardData?.daily ?? []).length === 0 ? (
                  <Text size="sm" c="dimmed" ta="center" py="md">
                    No activity recorded
                  </Text>
                ) : (
                  <div className="ds-tbl-wrap">
                    <table className="ds-tbl">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th style={{ textAlign: 'right' }}>Calls</th>
                          <th style={{ textAlign: 'right' }}>Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(dashboardData?.daily ?? [])
                          .slice(-7)
                          .reverse()
                          .map((row) => (
                            <tr key={row.period}>
                              <td className="ds-mono" style={{ fontSize: 12 }}>
                                {dayjs(row.period).format('MMM D')}
                              </td>
                              <td
                                style={{
                                  textAlign: 'right',
                                  fontVariantNumeric: 'tabular-nums',
                                }}
                              >
                                {fmtNum(row.callCount)}
                              </td>
                              <td
                                style={{
                                  textAlign: 'right',
                                  fontVariantNumeric: 'tabular-nums',
                                }}
                              >
                                {fmtNum(row.totalTokens)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {(dashboardData?.overview.errorRate ?? 0) > 0 ? (
              <div
                className="ds-row ds-gap-md"
                style={{
                  border: '1px solid var(--ds-border-soft)',
                  borderRadius: 'var(--ds-r-sm)',
                  padding: 14,
                  background: 'var(--ds-surface-1)',
                }}
              >
                <ThemeIcon
                  size={28}
                  radius="md"
                  variant="light"
                  color={
                    (dashboardData?.overview.errorRate ?? 0) > 0.1 ? 'red' : 'orange'
                  }
                >
                  <IconAlertTriangle size={14} />
                </ThemeIcon>
                <div className="ds-row ds-gap-lg" style={{ flex: 1 }}>
                  <div className="ds-col" style={{ gap: 2 }}>
                    <span className="ds-eyebrow">Success</span>
                    <span style={{ fontWeight: 600, color: 'var(--ds-ok)' }}>
                      {fmtNum(dashboardData?.overview.successCalls ?? 0)}
                    </span>
                  </div>
                  <div className="ds-col" style={{ gap: 2 }}>
                    <span className="ds-eyebrow">Error</span>
                    <span style={{ fontWeight: 600, color: 'var(--ds-err)' }}>
                      {fmtNum(dashboardData?.overview.errorCalls ?? 0)}
                    </span>
                  </div>
                  <div className="ds-col" style={{ gap: 2 }}>
                    <span className="ds-eyebrow">Error rate</span>
                    <span
                      style={{
                        fontWeight: 600,
                        color:
                          (dashboardData?.overview.errorRate ?? 0) > 0.1
                            ? 'var(--ds-err)'
                            : 'var(--ds-warn)',
                      }}
                    >
                      {fmtPct(dashboardData?.overview.errorRate ?? 0)}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </Stack>
        )}
      </div>

      <ModelProviderModal
        opened={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        onCreated={handleProviderCreated}
      />

      <CreateModelModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        defaultCategory={activeType === 'all' ? undefined : activeType}
        onCreated={handleModelCreated}
        onAddProvider={() => setProviderModalOpen(true)}
      />

      <CreateDynamicModelModal
        opened={dynamicModalOpen}
        onClose={() => setDynamicModalOpen(false)}
        candidates={dynamicCandidates}
        editModel={dynamicEdit}
        onSaved={() => {
          void loadModels();
          void loadDashboard();
        }}
      />

      {guardrailModel ? (
        <ModelGuardrailModal
          opened={guardrailModel !== null}
          modelId={guardrailModel._id}
          modelName={guardrailModel.name}
          initialInputGuardrailKey={
            (guardrailModel as ModelDto & { inputGuardrailKey?: string })
              .inputGuardrailKey
          }
          initialOutputGuardrailKey={
            (guardrailModel as ModelDto & { outputGuardrailKey?: string })
              .outputGuardrailKey
          }
          onClose={() => setGuardrailModel(null)}
          onSaved={() => void loadModels()}
        />
      ) : null}
    </PageContainer>
  );
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
  const k = key.toLowerCase();
  for (const [name, color] of Object.entries(PROVIDER_COLORS)) {
    if (k.includes(name)) return color;
  }
  return '#9aa7b6';
}

function fmtNumPricing(value: number): string {
  if (value === 0) return '0';
  if (value < 1) return value.toFixed(3);
  if (value < 10) return value.toFixed(2);
  return value.toFixed(2);
}

function modelColumns(
  t: ReturnType<typeof useTranslations>,
  providerLookup: Map<string, ModelProviderView>,
  usageByKey: Map<string, ModelTopEntry>,
  dashboardData: ModelsDashboardData | null,
): DataGridColumn<ModelDto>[] {
  return [
    {
      key: 'name',
      label: 'Name',
      render: (m) => (
        <div
          className="ds-col"
          style={{ gap: 2, whiteSpace: 'nowrap' }}
        >
          <span
            style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}
          >
            {m.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {m.key}
          </span>
        </div>
      ),
    },
    {
      key: 'provider',
      label: 'Provider',
      render: (m) => (
        <span
          className="ds-row ds-gap-xs"
          style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: providerColor(
                providerLookup.get(m.providerKey)?.driver ||
                  m.providerDriver ||
                  m.providerKey,
              ),
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          {providerLookup.get(m.providerKey)?.label ||
            m.provider ||
            m.providerKey}
        </span>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (m) => (
        <div className="ds-row ds-gap-xs">
          {dynamicConfigOf(m) ? (
            <span className="ds-badge ds-badge-teal" title="Dynamic LLM router">
              dynamic
            </span>
          ) : (
            <span className="ds-badge">{m.category}</span>
          )}
          {m.isMultimodal ? (
            <span className="ds-badge ds-badge-info" title={t('list.capabilities.multimodal')}>
              vision
            </span>
          ) : null}
          {m.supportsToolCalls ? (
            <span className="ds-badge ds-badge-warn" title={t('list.capabilities.tools')}>
              tools
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: () => <StatusBadge status="active" />,
    },
    {
      key: 'calls',
      label: 'Calls',
      align: 'right',
      render: (m) => {
        const usage = usageByKey.get(m.key);
        return (
          <span
            className="ds-mono"
            style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
          >
            {usage ? fmtNum(usage.callCount) : '—'}
          </span>
        );
      },
    },
    {
      key: 'latency',
      label: 'Avg latency',
      align: 'right',
      render: (m) => {
        const usage = usageByKey.get(m.key);
        if (usage?.avgLatencyMs == null) return '—';
        return (
          <span
            className="ds-mono"
            style={{
              fontSize: 12.5,
              fontVariantNumeric: 'tabular-nums',
              color:
                usage.avgLatencyMs > 800
                  ? 'var(--ds-warn)'
                  : 'var(--ds-text)',
            }}
          >
            {Math.round(usage.avgLatencyMs)}ms
          </span>
        );
      },
    },
    {
      key: 'spend',
      label: 'Spend',
      align: 'right',
      render: (m) => {
        const usage = usageByKey.get(m.key);
        return (
          <span
            className="ds-mono"
            style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
          >
            {usage && usage.totalCost > 0
              ? fmtCost(usage.totalCost, dashboardData?.overview.currency)
              : '—'}
          </span>
        );
      },
    },
    {
      key: 'pricing',
      label: 'Pricing',
      render: (m) => (
        <div className="ds-col" style={{ gap: 2, fontSize: 11.5 }}>
          <span className="ds-muted ds-mono">
            in: {fmtNumPricing(m.pricing.inputTokenPer1M)}/1M
          </span>
          <span className="ds-muted ds-mono">
            out: {fmtNumPricing(m.pricing.outputTokenPer1M)}/1M
          </span>
        </div>
      ),
    },
  ];
}

function periodLabel(period: string): string {
  switch (period) {
    case 'total':
      return 'all time';
    case 'last_day':
      return 'last 24 hours';
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
