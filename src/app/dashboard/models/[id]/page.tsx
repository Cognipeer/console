'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Center,
  Code,
  Divider,
  Grid,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconBook, IconBrain, IconChartBar, IconRefresh, IconTool, IconFileSearch } from '@tabler/icons-react';
import { IconEye, IconPlug, IconSettings, IconCurrencyDollar, IconTimeline } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { Playground } from '@/components/playground';

interface ModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
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

export default function ModelDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const t = useTranslations('modelDetail');
  const tModels = useTranslations('models');
  const [model, setModel] = useState<ModelDetailDto | null>(null);
  const [usage, setUsage] = useState<UsageAggregateDto | null>(null);
  const [logs, setLogs] = useState<UsageLogDto[]>([]);
  const [providers, setProviders] = useState<ProviderDefinitionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedLog, setSelectedLog] = useState<UsageLogDto | null>(null);
  const [logModalOpened, { open: openLogModal, close: closeLogModal }] = useDisclosure(false);

  const modelId = params?.id;

  const providerLabel = useMemo(() => {
    if (!model) return '';
    return providers.find((provider) => provider.id === model.provider)?.label || model.provider;
  }, [model, providers]);

  const fetchDetail = async (showNotifications = false) => {
    if (!modelId) return;
    setRefreshing(!loading);
    try {
      const [modelResponse, usageResponse, logsResponse, providerResponse] = await Promise.all([
        fetch(`/api/models/${modelId}`),
        fetch(`/api/models/${modelId}/usage?groupBy=day`),
        fetch(`/api/models/${modelId}/logs?limit=25`),
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

      if (logsResponse.ok) {
        const logsData = await logsResponse.json();
        setLogs(logsData.logs ?? []);
      } else {
        setLogs([]);
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

  useEffect(() => {
    setLoading(true);
    fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const renderPricing = (pricing: ModelPricing) => {
    const currency = pricing.currency || 'USD';
    return (
      <Stack gap={4}>
        <Group gap={6} align="center">
          <ThemeIcon variant="light" color="blue" size="sm" radius="md">
            <IconCurrencyDollar size={14} />
          </ThemeIcon>
          <Text fw={600}>{t('pricing.title')}</Text>
        </Group>
        <Text size="sm" c="dimmed">
          {tModels('list.pricing.prompt', {
            price: pricing.inputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 }),
            currency,
          })}
        </Text>
        <Text size="sm" c="dimmed">
          {tModels('list.pricing.completion', {
            price: pricing.outputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 }),
            currency,
          })}
        </Text>
        {pricing.cachedTokenPer1M ? (
          <Text size="sm" c="dimmed">
            {tModels('list.pricing.cached', {
              price: pricing.cachedTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 }),
              currency,
            })}
          </Text>
        ) : null}
      </Stack>
    );
  };

  const successRate = useMemo(() => {
    if (!usage?.totalCalls || usage.totalCalls === 0) return 0;
    return Math.round((usage.successCalls / usage.totalCalls) * 100);
  }, [usage]);

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

  return (
    <Stack gap="lg">
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}
      >
        <Group justify="space-between" align="flex-start">
          <Group gap="md" align="flex-start">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 135 }}
            >
              <IconBrain size={26} />
            </ThemeIcon>
            <div>
              <Group gap={8} align="center">
                <Title order={2}>{model.name}</Title>
                <Badge color={model.category === 'llm' ? 'indigo' : 'teal'} variant="light">
                  {model.category === 'llm' ? tModels('list.badges.llm') : tModels('list.badges.embedding')}
                </Badge>
              </Group>
              <Group gap={8} mt={6}>
                <Badge color="grape" variant="light">
                  {providerLabel}
                </Badge>
                <Badge variant="light" color="gray">
                  {model.modelId}
                </Badge>
              </Group>
              {model.description ? (
                <Text size="sm" c="dimmed" mt={6}>
                  {model.description}
                </Text>
              ) : (
                <Text size="sm" c="dimmed" mt={6}>
                  View model configuration, capabilities, and usage.
                </Text>
              )}
            </div>
          </Group>
          <Group gap="xs">
            <Button
              onClick={() => openDocs('api-client')}
              variant="light"
              leftSection={<IconBook size={16} />}
            >
              Docs
            </Button>
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              loading={refreshing}
              onClick={() => fetchDetail(true)}
            >
              {t('actions.refresh')}
            </Button>
            <Button
              component={Link}
              href={`/dashboard/models/${model._id}/edit`}
              leftSection={<IconSettings size={16} />}
            >
              {t('actions.edit')}
            </Button>
          </Group>
        </Group>
      </Paper>

      <Grid>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap={12}>
              <Group gap={8}>
                <ThemeIcon variant="light" color="indigo" radius="md">
                  <IconChartBar size={16} />
                </ThemeIcon>
                <Text fw={600}>{t('sections.overview')}</Text>
              </Group>
              <Stack gap={6}>
                <Text size="sm"><strong>{t('fields.key')}:</strong> <code>{model.key}</code></Text>
                <Text size="sm"><strong>{t('fields.provider')}:</strong> {providerLabel}</Text>
                <Text size="sm"><strong>{t('fields.modelId')}:</strong> {model.modelId}</Text>
                <Text size="sm"><strong>{t('fields.createdAt')}:</strong> {model.createdAt ? new Date(model.createdAt).toLocaleString() : '—'}</Text>
                <Text size="sm"><strong>{t('fields.updatedAt')}:</strong> {model.updatedAt ? new Date(model.updatedAt).toLocaleString() : '—'}</Text>
              </Stack>
              <Group gap={8}>
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
              </Group>
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder radius="lg" p="lg">
            {renderPricing(model.pricing)}
          </Paper>
        </Grid.Col>
      </Grid>

      <Grid>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Paper withBorder radius="lg" p="lg">
            <Group gap={8} mb="sm">
              <ThemeIcon variant="light" color="blue" radius="md">
                <IconTimeline size={16} />
              </ThemeIcon>
              <Text fw={600}>{t('sections.usage')}</Text>
            </Group>
            {usage ? (
              <Stack gap="md">
                <Grid>
                  <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
                    <StatCard label={t('stats.totalCalls')} value={usage.totalCalls.toLocaleString()} />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
                    <StatCard label={t('stats.successRate')} value={`${successRate}%`} />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
                    <StatCard
                      label={t('stats.totalTokens')}
                      value={usage.totalTokens.toLocaleString()}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
                    <StatCard
                      label={t('stats.avgLatency')}
                      value={usage.avgLatencyMs ? `${Math.round(usage.avgLatencyMs)} ms` : '—'}
                    />
                  </Grid.Col>
                </Grid>
                {usage.costSummary ? (
                  <Paper withBorder radius="md" p="sm">
                    <Stack gap={4}>
                      <Text fw={600}>{t('stats.cost.title')}</Text>
                      <Text size="sm" c="dimmed">
                        {t('stats.cost.total', {
                          amount: (usage.costSummary.totalCost ?? 0).toLocaleString(undefined, {
                            style: 'currency',
                            currency: usage.costSummary.currency || 'USD',
                          }),
                        })}
                      </Text>
                    </Stack>
                  </Paper>
                ) : null}
                <Divider label={t('sections.timeseries')} labelPosition="left" />
                <ScrollArea h={240} type="auto">
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('timeseries.period')}</Table.Th>
                        <Table.Th>{t('timeseries.calls')}</Table.Th>
                        <Table.Th>{t('timeseries.tokens')}</Table.Th>
                        <Table.Th>{t('timeseries.cost')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {(usage.timeseries || []).length > 0 ? (
                        usage.timeseries!.map((entry) => (
                          <Table.Tr key={entry.period}>
                            <Table.Td>{entry.period}</Table.Td>
                            <Table.Td>{entry.callCount.toLocaleString()}</Table.Td>
                            <Table.Td>{entry.totalTokens.toLocaleString()}</Table.Td>
                            <Table.Td>
                              {entry.totalCost !== undefined
                                ? entry.totalCost.toLocaleString(undefined, {
                                    style: 'currency',
                                    currency: usage.costSummary?.currency || 'USD',
                                  })
                                : '—'}
                            </Table.Td>
                          </Table.Tr>
                        ))
                      ) : (
                        <Table.Tr>
                          <Table.Td colSpan={4}>
                            <Center py="md">
                              <Text size="sm" c="dimmed">
                                {t('timeseries.empty')}
                              </Text>
                            </Center>
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              </Stack>
            ) : (
              <Center py="sm">
                <Text size="sm" c="dimmed">
                  {t('stats.noUsage')}
                </Text>
              </Center>
            )}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder radius="lg" p="lg">
            <Group gap={8} mb="sm">
              <ThemeIcon variant="light" color="grape" radius="md">
                <IconPlug size={16} />
              </ThemeIcon>
              <Text fw={600}>{t('sections.settings')}</Text>
            </Group>
            <Stack gap={8}>
              {Object.entries(model.settings || {}).length > 0 ? (
                Object.entries(model.settings).map(([key, value]) => (
                  <div key={key}>
                    <Text size="xs" c="dimmed" tt="uppercase">
                      {key}
                    </Text>
                    <Text size="sm">{typeof value === 'string' ? value : JSON.stringify(value)}</Text>
                  </div>
                ))
              ) : (
                <Text size="sm" c="dimmed">
                  {t('settings.empty')}
                </Text>
              )}
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>

      <Paper withBorder radius="lg" p="lg">
        <Group gap={8} mb="sm">
          <ThemeIcon variant="light" color="teal" radius="md">
            <IconTimeline size={16} />
          </ThemeIcon>
          <Text fw={600}>{t('sections.logs')}</Text>
        </Group>
        <ScrollArea h={280} type="auto">
          <Table highlightOnHover striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('logs.timestamp')}</Table.Th>
                <Table.Th>{t('logs.route')}</Table.Th>
                <Table.Th>{t('logs.status')}</Table.Th>
                <Table.Th>{t('logs.latency')}</Table.Th>
                <Table.Th>{t('logs.tokens')}</Table.Th>
                <Table.Th w={60}>{t('logs.details')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {logs.length > 0 ? (
                logs.map((log) => (
                  <Table.Tr key={log._id || `${log.route}-${log.createdAt}`}>
                    <Table.Td>{log.createdAt ? new Date(log.createdAt).toLocaleString() : '—'}</Table.Td>
                    <Table.Td>{log.route}</Table.Td>
                    <Table.Td>
                      <Badge color={log.status === 'success' ? 'teal' : 'red'} variant="light">
                        {log.status === 'success' ? t('logs.success') : t('logs.error')}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{log.latencyMs ? `${Math.round(log.latencyMs)} ms` : '—'}</Table.Td>
                    <Table.Td>
                      {t('logs.tokenSummary', {
                        input: log.inputTokens.toLocaleString(),
                        output: log.outputTokens.toLocaleString(),
                      })}
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={t('logs.viewDetails')}>
                        <ActionIcon
                          variant="subtle"
                          color="blue"
                          size="sm"
                          onClick={() => {
                            setSelectedLog(log);
                            openLogModal();
                          }}
                        >
                          <IconFileSearch size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                ))
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
        <Anchor size="xs" mt="sm" onClick={() => router.push(`/dashboard/models/${model._id}/edit`)}>
          {t('logs.viewAndEdit')}
        </Anchor>
      </Paper>

      {/* Playground - only for LLM models */}
      {model.category === 'llm' && (
        <Playground
          initialModelKey={model.key}
          hideModelSelector
          chatHeight={450}
        />
      )}

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

interface StatCardProps {
  label: string;
  value: string;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <Paper withBorder radius="lg" p="md">
      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text fw={600}>{value}</Text>
      </Stack>
    </Paper>
  );
}
