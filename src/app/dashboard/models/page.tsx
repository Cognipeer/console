'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Menu,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import { IconActivity, IconAlertTriangle, IconChartBar, IconEdit, IconEye, IconPlug, IconPlus, IconRefresh, IconTool, IconSparkles, IconBrain, IconCpu, IconTimeline, IconCoins, IconBolt, IconShield } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { ModelProviderView } from '@/lib/services/models/types';
import CreateModelModal from '@/components/models/CreateModelModal';
import ModelGuardrailModal from '@/components/models/ModelGuardrailModal';
import type { IModel } from '@/lib/database';
import dayjs from 'dayjs';
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
  category: 'llm' | 'embedding';
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

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtCost(cost: number, currency = 'USD'): string {
  if (cost === 0) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(cost);
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
  provider?: string; // deprecated legacy field
  providerKey: string;
  providerDriver: string;
  category: 'llm' | 'embedding';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [dashboardData, setDashboardData] = useState<ModelsDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [guardrailModel, setGuardrailModel] = useState<ModelDto | null>(null);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);
  const t = useTranslations('models');
  const tNav = useTranslations('navigation');
  const router = useRouter();

  const loadModels = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/models?includeProviders=true', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Failed to load models');
      }
      const data = await response.json();
      setModels((data.models ?? []) as ModelDto[]);
      setProviders((data.providers ?? []) as ModelProviderView[]);
    } catch (error) {
      console.error('Failed to load models', error);
    } finally {
      setLoading(false);
    }
  };

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/models/dashboard?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json() as ModelsDashboardData;
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
  }, [loadDashboard]);

  const openCreateModal = () => {
    setCreateModalOpen(true);
  };


  const handleModelCreated = ({ model, provider }: { model: IModel; provider: ModelProviderView }) => {
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

    setModels((current) => {
      const filtered = current.filter((existing) => existing._id !== normalized._id);
      return [normalized, ...filtered];
    });
    setProviders((current) => {
      if (current.some((existing) => existing.key === provider.key)) {
        return current;
      }
      return [...current, provider];
    });
    loadModels();
  };

  const llmModels = useMemo(() => models.filter((model) => model.category === 'llm'), [models]);
  const embeddingModels = useMemo(() => models.filter((model) => model.category === 'embedding'), [models]);
  const providerLookup = useMemo(() => {
    const map = new Map<string, ModelProviderView>();
    providers.forEach((provider) => {
      map.set(provider.key, provider);
    });
    return map;
  }, [providers]);

  const renderPricing = (pricing: ModelPricing) => {
    const currency = pricing.currency || 'USD';
    return (
      <Stack gap={3}>
        <Text size="xs" c="dimmed">
          In: {pricing.inputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}/1M
        </Text>
        <Text size="xs" c="dimmed">
          Out: {pricing.outputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}/1M
        </Text>
        {pricing.cachedTokenPer1M ? (
          <Text size="xs" c="dimmed">
            Cache: {pricing.cachedTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}/1M
          </Text>
        ) : null}
      </Stack>
    );
  };

  const renderModelTable = (records: ModelDto[], category: 'llm' | 'embedding') => (
    <Paper withBorder radius="lg" style={{ overflow: 'hidden' }}>
      <Table highlightOnHover verticalSpacing="md" horizontalSpacing="md">
        <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
          <Table.Tr>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.name')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.provider')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.modelId')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.capabilities')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.pricing')}</Table.Th>
            <Table.Th style={{ width: 80, textAlign: 'center', fontWeight: 600 }}>
              {t('list.columns.actions')}
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {records.length === 0 && !loading ? (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Center py="xl">
                  <Stack gap="md" align="center">
                    <ThemeIcon size={60} radius="xl" variant="light" color={category === 'llm' ? 'blue' : 'violet'}>
                      {category === 'llm' ? <IconBrain size={30} /> : <IconCpu size={30} />}
                    </ThemeIcon>
                    <Stack gap={4} align="center">
                      <Text size="sm" fw={500}>
                        {t('list.empty')}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Add your first {category === 'llm' ? 'LLM' : 'embedding'} model to get started
                      </Text>
                    </Stack>
                    <Button onClick={openCreateModal} leftSection={<IconPlus size={16} />} variant="light" color={category === 'llm' ? 'blue' : 'violet'}>
                      {t('actions.create')}
                    </Button>
                  </Stack>
                </Center>
              </Table.Td>
            </Table.Tr>
          ) : null}
          {records.map((model) => (
            <Table.Tr
              key={model._id}
              onClick={() => router.push(`/dashboard/models/${model._id}`)}
              style={{ cursor: 'pointer', transition: 'background-color 0.15s ease' }}
            >
              <Table.Td>
                <Group gap="sm">
                  <ThemeIcon size={36} radius="md" variant="light" color={model.category === 'llm' ? 'blue' : 'violet'}>
                    {model.category === 'llm' ? <IconBrain size={18} /> : <IconCpu size={18} />}
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text fw={600} size="sm">{model.name}</Text>
                    {model.description ? (
                      <Text size="xs" c="dimmed" lineClamp={1} style={{ maxWidth: 200 }}>
                        {model.description}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed" ff="monospace">{model.key}</Text>
                    )}
                  </Stack>
                </Group>
              </Table.Td>
              <Table.Td>
                <Badge 
                  color="gray" 
                  variant="light" 
                  size="sm"
                  leftSection={<IconPlug size={10} />}
                >
                  {providerLookup.get(model.providerKey)?.label || model.provider || model.providerKey}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" ff="monospace" style={{ backgroundColor: 'var(--mantine-color-gray-0)', padding: '4px 8px', borderRadius: 4, display: 'inline-block' }}>
                  {model.modelId}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group gap={6}>
                  {model.isMultimodal ? (
                    <Tooltip label={t('list.capabilities.multimodal')} withArrow>
                      <ThemeIcon size={24} radius="md" variant="light" color="teal">
                        <IconEye size={12} />
                      </ThemeIcon>
                    </Tooltip>
                  ) : null}
                  {model.supportsToolCalls ? (
                    <Tooltip label={t('list.capabilities.tools')} withArrow>
                      <ThemeIcon size={24} radius="md" variant="light" color="orange">
                        <IconTool size={12} />
                      </ThemeIcon>
                    </Tooltip>
                  ) : null}
                  {!model.isMultimodal && !model.supportsToolCalls && (
                    <Text size="xs" c="dimmed">—</Text>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>{renderPricing(model.pricing)}</Table.Td>
              <Table.Td>
                <Center>
                  <Menu withinPortal position="bottom-end" withArrow>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        radius="md"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <IconChartBar size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        component={Link}
                        href={`/dashboard/models/${model._id}`}
                        leftSection={<IconEye size={14} />}
                      >
                        {t('actions.viewDetails')}
                      </Menu.Item>
                      <Menu.Item
                        component={Link}
                        href={`/dashboard/models/${model._id}/edit`}
                        leftSection={<IconEdit size={14} />}
                      >
                        {t('actions.edit')}
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        leftSection={<IconShield size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setGuardrailModel(model);
                        }}
                      >
                        Guardrail Settings
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Center>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {loading ? (
        <Center py="lg">
          <Loader size="sm" color="teal" />
        </Center>
      ) : null}
    </Paper>
  );

  return (
    <Stack gap="md">
      {/* Header */}
      <PageHeader
        icon={<IconBrain size={18} />}
        title={tNav('models')}
        subtitle={t('list.subtitle')}
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              onClick={() => {
                void loadModels();
                void loadDashboard();
              }}
            >
              {t('actions.refresh')}
            </Button>
            <Button
              onClick={openCreateModal}
              size="xs"
              leftSection={<IconPlus size={14} />}
            >
              {t('actions.create')}
            </Button>
          </>
        }
      />

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.totalModels')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {dashboardData?.overview.totalModels ?? models.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <IconSparkles size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.llmModels')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {dashboardData?.overview.llmCount ?? llmModels.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconBrain size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.embeddingModels')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="cyan">
                {dashboardData?.overview.embeddingCount ?? embeddingModels.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="cyan">
              <IconCpu size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.providers')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {dashboardData?.overview.providerCount ?? providers.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconPlug size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Usage Analytics Dashboard */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="lg">
          <div>
            <Group gap="sm">
              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                <IconActivity size={16} />
              </ThemeIcon>
              <div>
                <Text fw={600} size="lg">Usage Analytics</Text>
                <Text size="sm" c="dimmed">Aggregate usage across all models</Text>
              </div>
            </Group>
          </div>
          <Button
            variant="subtle"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            loading={dashboardLoading}
            onClick={() => void loadDashboard()}
          >
            Refresh
          </Button>
        </Group>

        {dashboardLoading && !dashboardData ? (
          <Center py="xl">
            <Loader size="sm" color="teal" />
          </Center>
        ) : (
          <Stack gap="md">
            {/* Usage stat cards */}
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Paper withBorder radius="md" p="md">
                <Group gap="sm">
                  <ThemeIcon size={36} radius="md" variant="light" color="blue">
                    <IconActivity size={18} />
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.4px' }}>Total Calls</Text>
                    <Text fw={700} size="lg">{fmtNum(dashboardData?.overview.totalCalls ?? 0)}</Text>
                    <Text size="xs" c={((dashboardData?.overview.errorRate ?? 0) > 0.05) ? 'red' : 'dimmed'}>
                      {fmtPct(dashboardData?.overview.errorRate ?? 0)} error rate
                    </Text>
                  </Stack>
                </Group>
              </Paper>
              <Paper withBorder radius="md" p="md">
                <Group gap="sm">
                  <ThemeIcon size={36} radius="md" variant="light" color="violet">
                    <IconCpu size={18} />
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.4px' }}>Total Tokens</Text>
                    <Text fw={700} size="lg">{fmtNum(dashboardData?.overview.totalTokens ?? 0)}</Text>
                    <Text size="xs" c="dimmed">
                      in: {fmtNum(dashboardData?.overview.totalInputTokens ?? 0)} / out: {fmtNum(dashboardData?.overview.totalOutputTokens ?? 0)}
                    </Text>
                  </Stack>
                </Group>
              </Paper>
              <Paper withBorder radius="md" p="md">
                <Group gap="sm">
                  <ThemeIcon size={36} radius="md" variant="light" color="teal">
                    <IconBolt size={18} />
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.4px' }}>Avg Latency</Text>
                    <Text fw={700} size="lg">
                      {dashboardData?.overview.avgLatencyMs != null
                        ? `${dashboardData.overview.avgLatencyMs}ms`
                        : '—'}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {fmtNum(dashboardData?.overview.cacheHits ?? 0)} cache hits ({fmtPct(dashboardData?.overview.cacheHitRate ?? 0)})
                    </Text>
                  </Stack>
                </Group>
              </Paper>
              <Paper withBorder radius="md" p="md">
                <Group gap="sm">
                  <ThemeIcon size={36} radius="md" variant="light" color="orange">
                    <IconCoins size={18} />
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.4px' }}>Total Cost</Text>
                    <Text fw={700} size="lg">{fmtCost(dashboardData?.overview.totalCost ?? 0, dashboardData?.overview.currency)}</Text>
                    <Text size="xs" c="dimmed">
                      {fmtNum(dashboardData?.overview.totalToolCalls ?? 0)} tool calls
                    </Text>
                  </Stack>
                </Group>
              </Paper>
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              {/* Top Models by Usage */}
              <Paper withBorder radius="md" p="md">
                <Group gap="sm" mb="sm">
                  <ThemeIcon size={28} radius="md" variant="light" color="teal">
                    <IconChartBar size={14} />
                  </ThemeIcon>
                  <Text fw={600} size="sm">Top Models by Calls</Text>
                </Group>
                {(dashboardData?.topModels ?? []).length === 0 ? (
                  <Text size="sm" c="dimmed" ta="center" py="md">No usage data yet</Text>
                ) : (
                  <Stack gap={8}>
                    {(dashboardData?.topModels ?? []).map((item) => {
                      const maxCalls = Math.max(...(dashboardData?.topModels ?? []).map((m) => m.callCount), 1);
                      const pct = (item.callCount / maxCalls) * 100;
                      return (
                        <Stack gap={4} key={item.key}>
                          <Group justify="space-between">
                            <Group gap={6}>
                              <ThemeIcon size={20} radius="sm" variant="light" color={item.category === 'llm' ? 'blue' : 'violet'}>
                                {item.category === 'llm' ? <IconBrain size={10} /> : <IconCpu size={10} />}
                              </ThemeIcon>
                              <Text size="xs" fw={500} lineClamp={1}>{item.name}</Text>
                            </Group>
                            <Badge size="xs" variant="light" color="teal">{fmtNum(item.callCount)} calls</Badge>
                          </Group>
                          <Progress value={pct} size="xs" color="teal" radius="xl" />
                        </Stack>
                      );
                    })}
                  </Stack>
                )}
              </Paper>

              {/* Daily Trend */}
              <Paper withBorder radius="md" p="md">
                <Group gap="sm" mb="sm">
                  <ThemeIcon size={28} radius="md" variant="light" color="blue">
                    <IconTimeline size={14} />
                  </ThemeIcon>
                  <Text fw={600} size="sm">Recent Trend (Last 14 Days)</Text>
                </Group>
                {(dashboardData?.daily ?? []).length === 0 ? (
                  <Text size="sm" c="dimmed" ta="center" py="md">No activity recorded</Text>
                ) : (
                  <Table verticalSpacing="xs" horizontalSpacing="sm">
                    <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
                      <Table.Tr>
                        <Table.Th style={{ fontWeight: 600, fontSize: '0.75rem' }}>Date</Table.Th>
                        <Table.Th style={{ fontWeight: 600, fontSize: '0.75rem' }}>Calls</Table.Th>
                        <Table.Th style={{ fontWeight: 600, fontSize: '0.75rem' }}>Tokens</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {(dashboardData?.daily ?? []).slice(-7).reverse().map((row) => (
                        <Table.Tr key={row.period}>
                          <Table.Td>
                            <Text size="xs">{dayjs(row.period).format('MMM D')}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge size="xs" variant="light" color="teal">{fmtNum(row.callCount)}</Badge>
                          </Table.Td>
                          <Table.Td>
                            <Badge size="xs" variant="light" color="blue">{fmtNum(row.totalTokens)}</Badge>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Paper>
            </SimpleGrid>

            {/* Error Rate Info */}
            {(dashboardData?.overview.errorRate ?? 0) > 0 && (
              <Paper withBorder radius="md" p="md">
                <Group gap="sm" mb="xs">
                  <ThemeIcon size={28} radius="md" variant="light" color={(dashboardData?.overview.errorRate ?? 0) > 0.1 ? 'red' : 'orange'}>
                    <IconAlertTriangle size={14} />
                  </ThemeIcon>
                  <Text fw={600} size="sm">Error Breakdown</Text>
                </Group>
                <Group gap="xl">
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">Success</Text>
                    <Text fw={600} c="teal">{fmtNum(dashboardData?.overview.successCalls ?? 0)}</Text>
                  </Stack>
                  <Divider orientation="vertical" />
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">Error</Text>
                    <Text fw={600} c="red">{fmtNum(dashboardData?.overview.errorCalls ?? 0)}</Text>
                  </Stack>
                  <Divider orientation="vertical" />
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">Error Rate</Text>
                    <Text fw={600} c={(dashboardData?.overview.errorRate ?? 0) > 0.1 ? 'red' : 'orange'}>
                      {fmtPct(dashboardData?.overview.errorRate ?? 0)}
                    </Text>
                  </Stack>
                </Group>
              </Paper>
            )}
          </Stack>
        )}
      </Paper>

      <Stack gap="lg">
        <Paper p="lg" radius="lg" withBorder>
          <Group gap="sm" mb="md">
            <ThemeIcon variant="gradient" gradient={{ from: 'teal', to: 'cyan', deg: 90 }} radius="md" size="lg">
              <IconBrain size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="md">{t('list.sections.llm')}</Text>
              <Text size="xs" c="dimmed">Large Language Models for chat and completion</Text>
            </div>
            <Badge variant="filled" color="teal" size="lg" ml="auto">{llmModels.length}</Badge>
          </Group>
          {renderModelTable(llmModels, 'llm')}
        </Paper>

        <Paper p="lg" radius="lg" withBorder>
          <Group gap="sm" mb="md">
            <ThemeIcon variant="gradient" gradient={{ from: 'teal', to: 'cyan', deg: 90 }} radius="md" size="lg">
              <IconCpu size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="md">{t('list.sections.embedding')}</Text>
              <Text size="xs" c="dimmed">Embedding models for vector representations</Text>
            </div>
            <Badge variant="filled" color="teal" size="lg" ml="auto">{embeddingModels.length}</Badge>
          </Group>
          {renderModelTable(embeddingModels, 'embedding')}
        </Paper>
      </Stack>

      <CreateModelModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        onCreated={handleModelCreated}
      />

      {guardrailModel && (
        <ModelGuardrailModal
          opened={guardrailModel !== null}
          modelId={guardrailModel._id}
          modelName={guardrailModel.name}
          initialInputGuardrailKey={(guardrailModel as ModelDto & { inputGuardrailKey?: string }).inputGuardrailKey}
          initialOutputGuardrailKey={(guardrailModel as ModelDto & { outputGuardrailKey?: string }).outputGuardrailKey}
          onClose={() => setGuardrailModel(null)}
          onSaved={() => {
            void loadModels();
          }}
        />
      )}
    </Stack>
  );
}
