'use client';

/**
 * Cost Management — observed-model spend overview.
 *
 * Lists every model observed in usage (gateway + agent observability) with
 * its pricing status. Models the Model Hub knows are priced automatically;
 * models only seen in traces can be given a reference price here, which the
 * ingest applies from then on. Unpriced models surface prominently so spend
 * blind spots are visible instead of silently reading as $0.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCoins,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import { resolveDashboardDateFilter } from '@/lib/utils/dashboardDateFilter';
import { useTranslations } from '@/lib/i18n';

interface ObservedModelEntry {
  modelKey: string;
  modelName: string;
  status: 'hub' | 'external' | 'unpriced';
  providerKey?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  costBySource: Record<string, number>;
  modelCalls: number;
  pricing?: {
    currency?: string;
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M?: number;
  };
}

interface ObservedModelCosts {
  fromDay?: string;
  toDay?: string;
  totals: {
    requests: number;
    totalTokens: number;
    costUsd: number;
    unpricedTokens: number;
    unpricedModels: number;
  };
  entries: ObservedModelEntry[];
}

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

const STATUS_BADGE: Record<ObservedModelEntry['status'], { color: string; label: string }> = {
  hub: { color: 'teal', label: 'Model Hub' },
  external: { color: 'blue', label: 'External pricing' },
  unpriced: { color: 'orange', label: 'Unpriced' },
};

interface PricingDraft {
  modelName: string;
  inputTokenPer1M: number | string;
  outputTokenPer1M: number | string;
  cachedTokenPer1M: number | string;
  /** True when editing an existing external entry (name locked). */
  existing: boolean;
}

export default function CostPage() {
  const t = useTranslations('navigation');
  const [data, setData] = useState<ObservedModelCosts | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const [draft, setDraft] = useState<PricingDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const resolved = resolveDashboardDateFilter(dateFilter.period, {
        from: dateFilter.dateRange[0] ?? undefined,
        to: dateFilter.dateRange[1] ?? undefined,
      });
      if (resolved.from) params.set('from', resolved.from.toISOString());
      if (resolved.to) params.set('to', resolved.to.toISOString());
      const response = await fetch(`/api/cost/models?${params.toString()}`);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      setData(await response.json());
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Cost overview failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePricing = async () => {
    if (!draft) return;
    setSaving(true);
    try {
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
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      notifications.show({
        color: 'teal',
        title: 'Pricing saved',
        message: `New usage of "${draft.modelName}" will be priced from now on`,
      });
      setDraft(null);
      void load();
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

  const openEditor = (entry?: ObservedModelEntry) => {
    setDraft({
      modelName: entry?.modelKey ?? '',
      inputTokenPer1M: entry?.pricing?.inputTokenPer1M ?? '',
      outputTokenPer1M: entry?.pricing?.outputTokenPer1M ?? '',
      cachedTokenPer1M: entry?.pricing?.cachedTokenPer1M ?? '',
      existing: Boolean(entry),
    });
  };

  const unpriced = useMemo(
    () => (data?.entries ?? []).filter((entry) => entry.status === 'unpriced'),
    [data],
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Cost"
        title={t('cost')}
        subtitle={t('costDescription')}
      />

      <Group justify="space-between" mb="md">
        <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
        <Group gap="lg">
          {data ? (
            <>
              <Text size="sm" c="dimmed">
                Total spend <Text component="span" fw={700}>{formatUsd(data.totals.costUsd)}</Text>
              </Text>
              <Text size="sm" c="dimmed">
                Tokens <Text component="span" fw={700}>{formatCount(data.totals.totalTokens)}</Text>
              </Text>
            </>
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

      {unpriced.length > 0 ? (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={16} />}
          title={`${unpriced.length} model(s) have usage but no pricing`}
          mb="md"
        >
          {formatCount(data?.totals.unpricedTokens ?? 0)} tokens were recorded at $0 because
          these models are not in the Model Hub and have no reference price. Add pricing to
          make their spend visible from now on.
        </Alert>
      ) : null}

      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Model</Table.Th>
            <Table.Th>Pricing source</Table.Th>
            <Table.Th ta="right">Requests</Table.Th>
            <Table.Th ta="right">Tokens</Table.Th>
            <Table.Th ta="right">Spend</Table.Th>
            <Table.Th ta="right">via Observability</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(data?.entries ?? []).map((entry) => {
            const badge = STATUS_BADGE[entry.status];
            const tracingCost = entry.costBySource.tracing ?? 0;
            return (
              <Table.Tr key={entry.modelKey}>
                <Table.Td>
                  <Text size="sm" fw={600}>{entry.modelName}</Text>
                  {entry.modelName !== entry.modelKey ? (
                    <Text size="xs" c="dimmed">{entry.modelKey}</Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  <Badge color={badge.color} variant="light">{badge.label}</Badge>
                </Table.Td>
                <Table.Td ta="right">{formatCount(entry.requests)}</Table.Td>
                <Table.Td ta="right">{formatCount(entry.totalTokens)}</Table.Td>
                <Table.Td ta="right">
                  {entry.status === 'unpriced' ? (
                    <Tooltip label="Recorded at $0 — add pricing">
                      <Text size="sm" c="orange" fw={600}>—</Text>
                    </Tooltip>
                  ) : (
                    <Text size="sm" fw={600}>{formatUsd(entry.costUsd)}</Text>
                  )}
                </Table.Td>
                <Table.Td ta="right">
                  <Text size="sm" c="dimmed">{tracingCost > 0 ? formatUsd(tracingCost) : '—'}</Text>
                </Table.Td>
                <Table.Td ta="right">
                  {entry.status !== 'hub' ? (
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
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={() => void removePricing(entry.modelKey)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </Group>
                  ) : (
                    <Text size="xs" c="dimmed">Managed in Model Hub</Text>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
          {!loading && (data?.entries.length ?? 0) === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={7}>
                <Text size="sm" c="dimmed" ta="center" py="lg">
                  No model usage observed in this window yet.
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
            <Text size="xs" c="dimmed">
              Applied to usage ingested from now on; previously recorded usage is not repriced.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDraft(null)}>Cancel</Button>
              <Button loading={saving} onClick={() => void savePricing()} disabled={!draft.modelName.trim()}>
                Save pricing
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
    </PageContainer>
  );
}
