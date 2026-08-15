'use client';

/**
 * CatalogMatchOverlay — bulk "match from catalog" review surface for the
 * Cost → Pricing page.
 *
 * Takes the observed-but-unpriced model names, asks the model price catalog
 * for suggestions (`/api/model-price-catalog/suggest`), and lists each name
 * with its suggested match: catalog key, per-1M prices, and a confidence
 * badge (exact / normalized / fuzzy — ambiguous names come back unmatched).
 * Every row can be toggled and its prices edited before applying; rows
 * without a match can be priced manually in place. Applying upserts each
 * selected row through the existing `PUT /api/cost/pricing` endpoint with
 * `effectiveFrom` omitted, i.e. the price applies since the beginning.
 *
 * Full-screen FormShell overlay per the project rule for create/edit
 * surfaces (small Mantine Modals are reserved for confirms).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Checkbox, Loader, NumberInput, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCoins, IconDownload, IconRefresh } from '@tabler/icons-react';
import FormShell, { SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

type Confidence = 'exact' | 'normalized' | 'fuzzy';

interface SuggestResponse {
  status: { entries: number; fetchedAt?: string; source: string };
  suggestions: Array<{
    name: string;
    match?: {
      catalogKey: string;
      provider?: string;
      confidence: Confidence;
      pricing: {
        inputTokenPer1M: number;
        outputTokenPer1M: number;
        cachedTokenPer1M?: number;
      };
    };
  }>;
}

interface MatchRow {
  name: string;
  catalogKey?: string;
  provider?: string;
  confidence?: Confidence;
  enabled: boolean;
  inputTokenPer1M: number | string;
  outputTokenPer1M: number | string;
  cachedTokenPer1M: number | string;
}

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  exact: 'teal',
  normalized: 'blue',
  fuzzy: 'orange',
};

interface CatalogMatchOverlayProps {
  opened: boolean;
  onClose: () => void;
  /** Observed model names without pricing, as shown on the Pricing page. */
  names: string[];
  /** 'all' saves tenant-wide entries (mirrors the page's scope toggle). */
  scope: 'project' | 'all';
  /** Called after at least one price was applied, to reload the catalog. */
  onApplied: () => void;
}

export default function CatalogMatchOverlay({
  opened,
  onClose,
  names,
  scope,
  onApplied,
}: CatalogMatchOverlayProps) {
  const t = useTranslations('costPricing.catalogMatch');
  const tConfidence = useTranslations('modelPriceCatalog.confidence');
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [status, setStatus] = useState<SuggestResponse['status'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);

  const loadSuggestions = useCallback(async () => {
    if (names.length === 0) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/model-price-catalog/suggest?names=${encodeURIComponent(names.join(','))}`,
      );
      const payload: SuggestResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Request failed');
      setStatus(payload.status);
      setRows(
        payload.suggestions.map((suggestion) => ({
          name: suggestion.name,
          catalogKey: suggestion.match?.catalogKey,
          provider: suggestion.match?.provider,
          confidence: suggestion.match?.confidence,
          enabled: Boolean(suggestion.match),
          inputTokenPer1M: suggestion.match?.pricing.inputTokenPer1M ?? '',
          outputTokenPer1M: suggestion.match?.pricing.outputTokenPer1M ?? '',
          cachedTokenPer1M: suggestion.match?.pricing.cachedTokenPer1M ?? '',
        })),
      );
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('loadFailedTitle'),
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  }, [names, t]);

  useEffect(() => {
    if (opened) void loadSuggestions();
    // Intentionally keyed on `opened` — re-fetch on every open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/model-price-catalog/refresh', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Request failed');
      notifications.show({
        color: 'teal',
        title: t('refreshedTitle'),
        message: t('refreshedMessage', { entries: payload.status?.entries ?? 0 }),
      });
      await loadSuggestions();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('refreshFailedTitle'),
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const updateRow = (index: number, patch: Partial<MatchRow>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const applicable = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.enabled
          && row.inputTokenPer1M !== ''
          && row.outputTokenPer1M !== '',
      ),
    [rows],
  );
  const matchedCount = useMemo(() => rows.filter((row) => row.catalogKey).length, [rows]);

  const apply = async () => {
    if (applicable.length === 0) return;
    setApplying(true);
    let applied = 0;
    const failures: string[] = [];
    for (const row of applicable) {
      try {
        const response = await fetch('/api/cost/pricing', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelName: row.name,
            pricing: {
              inputTokenPer1M: Number(row.inputTokenPer1M) || 0,
              outputTokenPer1M: Number(row.outputTokenPer1M) || 0,
              cachedTokenPer1M: Number(row.cachedTokenPer1M) || 0,
            },
            // effectiveFrom omitted — the reference price applies since the
            // beginning (epoch version), matching manual "Add pricing".
            ...(scope === 'all' ? { scope: 'all' } : {}),
          }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Request failed');
        }
        applied += 1;
      } catch (error) {
        failures.push(
          `${row.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
    setApplying(false);
    if (applied > 0) {
      notifications.show({
        color: failures.length === 0 ? 'teal' : 'orange',
        title: t('appliedTitle'),
        message: t('appliedMessage', { applied, total: applicable.length }),
      });
      onApplied();
    }
    if (failures.length > 0) {
      notifications.show({
        color: 'red',
        title: t('applyFailedTitle'),
        message: failures.slice(0, 3).join(' · '),
      });
    }
    if (failures.length === 0) onClose();
  };

  const summary = (
    <>
      <SummaryGroup title={t('summary.title')}>
        <SummaryKV label={t('summary.models')} value={rows.length} />
        <SummaryKV label={t('summary.matched')} value={matchedCount} />
        <SummaryKV label={t('summary.selected')} value={applicable.length} />
      </SummaryGroup>
      <SummaryGroup title={t('summary.catalogTitle')}>
        <SummaryKV label={t('summary.catalogEntries')} value={status?.entries ?? '—'} />
        <SummaryKV
          label={t('summary.catalogFetchedAt')}
          value={status?.fetchedAt ? new Date(status.fetchedAt).toLocaleString() : '—'}
        />
        <SummaryKV label={t('summary.catalogSource')} value="LiteLLM" />
      </SummaryGroup>
      <Text size="xs" c="dimmed" mt="sm">
        {t('summary.note')}
      </Text>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconCoins size={16} />}
      title={t('title')}
      subtitle={t('subtitle')}
      summary={summary}
      footerLeft={
        <Text
          component="button"
          size="xs"
          c="dimmed"
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => void refreshCatalog()}
          disabled={refreshing}
        >
          <IconRefresh size={13} />
          {refreshing ? t('refreshing') : t('refresh')}
        </Text>
      }
      footerStatus={t('footerStatus', { selected: applicable.length, total: rows.length })}
      primaryAction={{
        label: t('apply', { count: applicable.length }),
        icon: <IconDownload size={13} />,
        loading: applying,
        disabled: applicable.length === 0 || loading,
        onClick: () => void apply(),
      }}
    >
      {loading ? (
        <Text size="sm" c="dimmed" py="lg" ta="center">
          <Loader size="xs" style={{ marginRight: 8, verticalAlign: 'middle' }} />
          {t('loading')}
        </Text>
      ) : (
        <Table striped withTableBorder verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 32 }} />
              <Table.Th>{t('columns.model')}</Table.Th>
              <Table.Th>{t('columns.match')}</Table.Th>
              <Table.Th style={{ width: 120 }}>{t('columns.input')}</Table.Th>
              <Table.Th style={{ width: 120 }}>{t('columns.output')}</Table.Th>
              <Table.Th style={{ width: 120 }}>{t('columns.cached')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, index) => (
              <Table.Tr key={row.name} opacity={row.enabled ? 1 : 0.55}>
                <Table.Td>
                  <Checkbox
                    checked={row.enabled}
                    onChange={(event) =>
                      updateRow(index, { enabled: event.currentTarget.checked })
                    }
                    aria-label={row.name}
                  />
                </Table.Td>
                <Table.Td>
                  <Text size="sm" fw={600}>{row.name}</Text>
                </Table.Td>
                <Table.Td>
                  {row.catalogKey ? (
                    <>
                      <Text size="sm">{row.catalogKey}</Text>
                      <Badge
                        size="xs"
                        variant="light"
                        color={CONFIDENCE_COLOR[row.confidence ?? 'fuzzy']}
                      >
                        {tConfidence(row.confidence ?? 'fuzzy')}
                      </Badge>
                      {row.provider ? (
                        <Text size="xs" c="dimmed" component="span" ml={6}>
                          {row.provider}
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    <Text size="xs" c="dimmed">{t('noMatch')}</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    size="xs"
                    min={0}
                    decimalScale={4}
                    value={row.inputTokenPer1M}
                    onChange={(value) => updateRow(index, { inputTokenPer1M: value })}
                    disabled={!row.enabled}
                  />
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    size="xs"
                    min={0}
                    decimalScale={4}
                    value={row.outputTokenPer1M}
                    onChange={(value) => updateRow(index, { outputTokenPer1M: value })}
                    disabled={!row.enabled}
                  />
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    size="xs"
                    min={0}
                    decimalScale={4}
                    value={row.cachedTokenPer1M}
                    onChange={(value) => updateRow(index, { cachedTokenPer1M: value })}
                    disabled={!row.enabled}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
            {rows.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text size="sm" c="dimmed" ta="center" py="lg">
                    {t('empty')}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : null}
          </Table.Tbody>
        </Table>
      )}
    </FormShell>
  );
}
