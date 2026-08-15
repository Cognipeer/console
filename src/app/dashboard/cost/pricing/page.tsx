'use client';

/**
 * Pricing — unified model pricing catalog.
 *
 * Lists every model in scope: Model Hub models (priced by the hub), models
 * observed via agent observability, and external pricing entries. Prices are
 * effective-dated — a price can be entered retroactively and recorded spend
 * can be recalculated from that date. Viewable per project or across all
 * projects ("total"), like the dashboard.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Popover,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCalendar,
  IconCoins,
  IconHistory,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import CatalogMatchOverlay from '@/components/cost/CatalogMatchOverlay';
import CatalogPriceFill from '@/components/models/CatalogPriceFill';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import { useTranslations } from '@/lib/i18n';
import { resolveDashboardDateFilter, parseLocalDate } from '@/lib/utils/dashboardDateFilter';

interface PricingVersion {
  /** 'YYYY-MM-DD'; '' = since the beginning. */
  effectiveFrom: string;
  pricing: {
    currency?: string;
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M?: number;
  };
  updatedAt?: string;
}

interface CatalogEntry {
  modelKey: string;
  modelName: string;
  status: 'hub' | 'external' | 'unpriced';
  providerKey?: string;
  entryScope?: 'project' | 'tenant';
  pricing?: PricingVersion['pricing'];
  versions?: PricingVersion[];
  observed: boolean;
  requests: number;
  totalTokens: number;
  costUsd: number;
  modelCalls: number;
  lastUsedDay?: string;
}

interface PricingCatalog {
  fromDay?: string;
  toDay?: string;
  totals: { models: number; hub: number; external: number; unpriced: number };
  entries: CatalogEntry[];
}

type Scope = 'project' | 'all';

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatRate(pricing?: PricingVersion['pricing']): string {
  if (!pricing) return '—';
  const parts = [`in $${pricing.inputTokenPer1M}`, `out $${pricing.outputTokenPer1M}`];
  if (pricing.cachedTokenPer1M) parts.push(`cached $${pricing.cachedTokenPer1M}`);
  return `${parts.join(' · ')} / 1M`;
}

function toUtcDayString(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

const STATUS_BADGE: Record<CatalogEntry['status'], { color: string; label: string }> = {
  hub: { color: 'teal', label: 'Model Hub' },
  external: { color: 'blue', label: 'External pricing' },
  unpriced: { color: 'orange', label: 'Unpriced' },
};

interface PricingDraft {
  modelName: string;
  inputTokenPer1M: number | string;
  outputTokenPer1M: number | string;
  cachedTokenPer1M: number | string;
  /** Local date the price takes effect; null = since the beginning. */
  effectiveFrom: Date | null;
  /** Recalculate recorded spend from `effectiveFrom` after saving. */
  applyRetroactively: boolean;
  existing: boolean;
}

export default function PricingPage() {
  const t = useTranslations('costPricing');
  const [scope, setScope] = useState<Scope>('project');
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const [data, setData] = useState<PricingCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<PricingDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [repricing, setRepricing] = useState<string | null>(null);
  const [catalogMatchOpen, setCatalogMatchOpen] = useState(false);

  const rangeParams = useCallback(() => {
    const params = new URLSearchParams();
    const resolved = resolveDashboardDateFilter(dateFilter.period, {
      from: dateFilter.dateRange[0] ?? undefined,
      to: dateFilter.dateRange[1] ?? undefined,
    });
    if (resolved.from) params.set('from', resolved.from.toISOString());
    if (resolved.to) params.set('to', resolved.to.toISOString());
    if (scope === 'all') params.set('scope', 'all');
    return params;
  }, [dateFilter, scope]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/cost/pricing/catalog?${rangeParams().toString()}`);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      setData(await response.json());
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Pricing catalog failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  }, [rangeParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const runReprice = useCallback(
    async (modelName: string, fromDay?: string) => {
      setRepricing(modelName);
      try {
        const body: Record<string, string> = { modelName };
        if (fromDay) body.from = `${fromDay}T00:00:00.000Z`;
        if (scope === 'all') body.scope = 'all';
        const response = await fetch('/api/cost/pricing/reprice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? 'Request failed');
        notifications.show({
          color: 'teal',
          title: 'Spend recalculated',
          message: `${modelName}: ${payload.rowsUpdated} day-rows updated (${formatUsd(payload.costBefore)} → ${formatUsd(payload.costAfter)})`,
        });
        void load();
      } catch (error) {
        notifications.show({
          color: 'red',
          title: 'Recalculation failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        setRepricing(null);
      }
    },
    [scope, load],
  );

  const savePricing = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const effectiveFrom = draft.effectiveFrom ? toUtcDayString(draft.effectiveFrom) : undefined;
      const response = await fetch('/api/cost/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelName: draft.modelName,
          pricing: {
            inputTokenPer1M: Number(draft.inputTokenPer1M) || 0,
            outputTokenPer1M: Number(draft.outputTokenPer1M) || 0,
            cachedTokenPer1M: Number(draft.cachedTokenPer1M) || 0,
          },
          effectiveFrom,
          ...(scope === 'all' ? { scope: 'all' } : {}),
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      notifications.show({
        color: 'teal',
        title: 'Pricing saved',
        message: effectiveFrom
          ? `"${draft.modelName}" priced from ${effectiveFrom}`
          : `"${draft.modelName}" priced for all recorded and future usage`,
      });
      const { modelName, applyRetroactively } = draft;
      setDraft(null);
      if (applyRetroactively) {
        await runReprice(modelName, effectiveFrom);
      } else {
        void load();
      }
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Could not save pricing',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  };

  const removePricing = async (modelName: string) => {
    try {
      const response = await fetch(`/api/cost/pricing/${encodeURIComponent(modelName)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      notifications.show({ color: 'teal', title: 'Pricing removed', message: modelName });
      void load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Could not remove pricing',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const openEditor = (entry?: CatalogEntry) => {
    setDraft({
      modelName: entry?.modelKey ?? '',
      inputTokenPer1M: entry?.pricing?.inputTokenPer1M ?? '',
      outputTokenPer1M: entry?.pricing?.outputTokenPer1M ?? '',
      cachedTokenPer1M: entry?.pricing?.cachedTokenPer1M ?? '',
      effectiveFrom: null,
      applyRetroactively: false,
      existing: Boolean(entry && entry.status === 'external'),
    });
  };

  const unpricedObserved = useMemo(
    () => (data?.entries ?? []).filter((entry) => entry.status === 'unpriced' && entry.observed),
    [data],
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Cost"
        title="Pricing"
        subtitle="Reference prices for every model in scope — hub models, observed agent models, and external entries. Prices are effective-dated and recorded spend can be recalculated."
      />

      <Group justify="space-between" mb="md" wrap="wrap">
        <Group gap="sm">
          <SegmentedControl
            value={scope}
            onChange={(value) => setScope(value as Scope)}
            data={[
              { value: 'project', label: 'This project' },
              { value: 'all', label: 'All projects' },
            ]}
          />
          <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
        </Group>
        <Group gap="lg">
          {data ? (
            <Text size="sm" c="dimmed">
              {data.totals.models} models · {data.totals.hub} hub · {data.totals.external} external ·{' '}
              <Text component="span" c={data.totals.unpriced > 0 ? 'orange' : 'dimmed'} fw={600}>
                {data.totals.unpriced} unpriced
              </Text>
            </Text>
          ) : null}
          {unpricedObserved.length > 0 ? (
            <Button
              size="xs"
              variant="light"
              color="grape"
              leftSection={<IconSparkles size={14} />}
              onClick={() => setCatalogMatchOpen(true)}
            >
              {t('matchFromCatalog')}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => openEditor()}
          >
            Add pricing
          </Button>
        </Group>
      </Group>

      {unpricedObserved.length > 0 ? (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={16} />}
          title={`${unpricedObserved.length} observed model(s) have no pricing`}
          mb="md"
        >
          Their usage is recorded at $0. Add a price — optionally dated in the past — and
          recalculate to make recorded spend visible. {t('matchFromCatalogHint')}
        </Alert>
      ) : null}

      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Model</Table.Th>
            <Table.Th>Pricing source</Table.Th>
            <Table.Th>Current price</Table.Th>
            <Table.Th ta="right">Requests</Table.Th>
            <Table.Th ta="right">Tokens</Table.Th>
            <Table.Th ta="right">Spend</Table.Th>
            <Table.Th>Last used</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(data?.entries ?? []).map((entry) => {
            const badge = STATUS_BADGE[entry.status];
            const versions = entry.versions ?? [];
            return (
              <Table.Tr key={entry.modelKey.toLowerCase()}>
                <Table.Td>
                  <Text size="sm" fw={600}>{entry.modelName}</Text>
                  {entry.modelName !== entry.modelKey ? (
                    <Text size="xs" c="dimmed">{entry.modelKey}</Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Badge color={badge.color} variant="light">{badge.label}</Badge>
                    {entry.entryScope === 'tenant' ? (
                      <Tooltip label="Applies to every project">
                        <Badge color="gray" variant="light">All projects</Badge>
                      </Tooltip>
                    ) : null}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Text size="sm">{formatRate(entry.pricing)}</Text>
                    {entry.status === 'external' && versions.length > 1 ? (
                      <Popover width={320} position="bottom" shadow="md">
                        <Popover.Target>
                          <Tooltip label="Price history">
                            <ActionIcon size="sm" variant="subtle" aria-label="Price history">
                              <IconHistory size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Popover.Target>
                        <Popover.Dropdown>
                          <Stack gap={4}>
                            <Text size="xs" fw={600}>Price history</Text>
                            {[...versions].reverse().map((version) => (
                              <Group key={version.effectiveFrom || 'epoch'} justify="space-between" gap="xs">
                                <Text size="xs" c="dimmed">
                                  {version.effectiveFrom || 'From the beginning'}
                                </Text>
                                <Text size="xs">{formatRate(version.pricing)}</Text>
                              </Group>
                            ))}
                          </Stack>
                        </Popover.Dropdown>
                      </Popover>
                    ) : null}
                  </Group>
                </Table.Td>
                <Table.Td ta="right">{entry.observed ? formatCount(entry.requests) : '—'}</Table.Td>
                <Table.Td ta="right">{entry.observed ? formatCount(entry.totalTokens) : '—'}</Table.Td>
                <Table.Td ta="right">
                  {entry.status === 'unpriced' && entry.observed ? (
                    <Tooltip label="Recorded at $0 — add pricing">
                      <Text size="sm" c="orange" fw={600}>—</Text>
                    </Tooltip>
                  ) : (
                    <Text size="sm" fw={600}>{entry.observed ? formatUsd(entry.costUsd) : '—'}</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">{entry.lastUsedDay ?? '—'}</Text>
                </Table.Td>
                <Table.Td ta="right">
                  {entry.status === 'hub' ? (
                    <Text size="xs" c="dimmed">Managed in Model Hub</Text>
                  ) : (
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        leftSection={entry.status === 'unpriced' ? <IconCoins size={14} /> : <IconPencil size={14} />}
                        onClick={() => openEditor(entry)}
                      >
                        {entry.status === 'unpriced' ? 'Set pricing' : 'Edit'}
                      </Button>
                      {entry.status === 'external' ? (
                        <>
                          <Tooltip label="Recalculate recorded spend with the effective-dated prices">
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              loading={repricing === entry.modelKey}
                              leftSection={<IconRefresh size={14} />}
                              onClick={() => void runReprice(entry.modelKey)}
                            >
                              Recalculate
                            </Button>
                          </Tooltip>
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => void removePricing(entry.modelKey)}
                          >
                            Remove
                          </Button>
                        </>
                      ) : null}
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
          {!loading && (data?.entries.length ?? 0) === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={8}>
                <Text size="sm" c="dimmed" ta="center" py="lg">
                  No models in scope yet — they appear here from the Model Hub and from agent
                  observability traces.
                </Text>
              </Table.Td>
            </Table.Tr>
          ) : null}
        </Table.Tbody>
      </Table>

      <Modal
        opened={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.existing ? `Pricing — ${draft.modelName}` : 'Add model pricing'}
      >
        {draft ? (
          <Stack gap="sm">
            <TextInput
              label="Model name"
              description="Exactly as it appears in trace events (case-insensitive)"
              value={draft.modelName}
              onChange={(event) =>
                setDraft({ ...draft, modelName: event.currentTarget.value })
              }
              disabled={draft.existing}
              required
            />
            <Group justify="flex-end">
              <CatalogPriceFill
                modelId={draft.modelName}
                onApply={(pricing) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          inputTokenPer1M: pricing.inputTokenPer1M,
                          outputTokenPer1M: pricing.outputTokenPer1M,
                          cachedTokenPer1M: pricing.cachedTokenPer1M,
                        }
                      : current,
                  )
                }
              />
            </Group>
            <NumberInput
              label="Input tokens — USD per 1M"
              value={draft.inputTokenPer1M}
              onChange={(value) => setDraft({ ...draft, inputTokenPer1M: value })}
              min={0}
              decimalScale={4}
            />
            <NumberInput
              label="Output tokens — USD per 1M"
              value={draft.outputTokenPer1M}
              onChange={(value) => setDraft({ ...draft, outputTokenPer1M: value })}
              min={0}
              decimalScale={4}
            />
            <NumberInput
              label="Cached input tokens — USD per 1M (optional)"
              value={draft.cachedTokenPer1M}
              onChange={(value) => setDraft({ ...draft, cachedTokenPer1M: value })}
              min={0}
              decimalScale={4}
            />
            <DatePickerInput
              label="Effective from"
              description="Leave empty to apply since the beginning. Past dates enable retroactive pricing."
              placeholder="Since the beginning"
              value={draft.effectiveFrom}
              onChange={(value) => setDraft({ ...draft, effectiveFrom: parseLocalDate(value) })}
              maxDate={new Date()}
              clearable
              leftSection={<IconCalendar size={14} stroke={1.5} />}
            />
            <Switch
              label="Recalculate recorded spend"
              description="Reprice usage already recorded (from the effective date, or all of it when no date is set)."
              checked={draft.applyRetroactively}
              onChange={(event) =>
                setDraft({ ...draft, applyRetroactively: event.currentTarget.checked })
              }
            />
            {scope === 'all' ? (
              <Text size="xs" c="dimmed">
                Saved as a tenant-wide entry — applies to every project without its own entry.
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDraft(null)}>Cancel</Button>
              <Button loading={saving} onClick={() => void savePricing()} disabled={!draft.modelName.trim()}>
                Save pricing
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>

      <CatalogMatchOverlay
        opened={catalogMatchOpen}
        onClose={() => setCatalogMatchOpen(false)}
        names={unpricedObserved.map((entry) => entry.modelKey)}
        scope={scope}
        onApplied={() => void load()}
      />
    </PageContainer>
  );
}
