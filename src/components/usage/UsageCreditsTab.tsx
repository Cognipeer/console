'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Group, Paper, Progress, SegmentedControl, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { ApiError, apiRequest } from '@/lib/api/client';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { UsageSummary } from '@/lib/limits/usageSummary';
import {
  CREDIT_LEDGER_KINDS,
  describeCreditEntry,
  fetchCreditLedger,
  fetchCreditSpend,
  utcMonth,
  type CreditLedgerEntry,
  type CreditLedgerKind,
  type CreditSpend,
  type CreditSpendModel,
} from './creditsApi';
import { formatDate, formatNumber, formatPeriod, runwayText } from './format';

export type { CreditLedgerEntry, CreditLedgerKind } from './creditsApi';

const REDEEM_ERRORS = ['invalid_code', 'code_expired', 'wrong_tenant', 'already_redeemed', 'credits_unavailable'] as const;
const PAGE_SIZES = [25, 50, 100];
const KIND_COLORS: Record<CreditLedgerKind, string> = {
  charge: 'gray',
  redeem: 'teal',
  monthly_grant: 'blue',
  refund: 'teal',
  adjust: 'violet',
  expire: 'orange',
};

/** The error code of a refused redeem call, whichever envelope the route answered in. */
export function redeemErrorCode(error: unknown): string {
  if (!(error instanceof ApiError)) return 'unknown';
  const payload = error.payload as { code?: unknown; error?: unknown } | undefined;
  const nested = payload?.error as { code?: unknown } | string | undefined;
  const candidates = [
    payload?.code,
    typeof nested === 'object' ? nested?.code : undefined,
    typeof nested === 'string' ? nested : undefined,
  ];
  const found = candidates.find((value): value is string => typeof value === 'string' && (REDEEM_ERRORS as readonly string[]).includes(value));
  return found ?? 'unknown';
}

type Translate = ReturnType<typeof useTranslations>;

function spendLabel(row: CreditSpendModel, t: Translate): string {
  if (row.model === 'search' || row.service === 'search') return t('credits.services.search');
  return row.label ?? row.model ?? t('credits.spend.other');
}

function spendUsage(row: CreditSpendModel, t: Translate, locale: string): string {
  if (row.model === 'search' || row.service === 'search') {
    return t('credits.spend.searchUsage', { count: formatNumber(row.count, locale), units: formatNumber(row.units, locale) });
  }
  if (row.service === 'embedding') return t('credits.spend.embeddingUsage', { input: formatNumber(row.inputTokens, locale) });
  return t('credits.spend.chatUsage', { input: formatNumber(row.inputTokens, locale), output: formatNumber(row.outputTokens, locale) });
}

function BalanceCard({ summary, t, locale }: { summary: UsageSummary; t: Translate; locale: string }) {
  const credits = summary.credits;
  if (!credits) return null;
  const { included, prepaid } = credits;
  const includedPct = included.granted > 0 ? Math.min(100, (included.used / included.granted) * 100) : 0;
  return (
    <Paper withBorder p="md" radius="md">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">{t('creditCard.balance')}</Text>
          <Text size="xl" fw={700}>{formatNumber(credits.balance, locale)}</Text>
          <Text size="xs" c="dimmed">{runwayText(t, locale, credits.runwayDays)}</Text>
        </Stack>
        <Stack gap={4}>
          <Text size="sm" c="dimmed">{t('credits.balanceCard.included', { month: formatPeriod(included.period, locale) })}</Text>
          <Text size="sm" fw={600}>
            {t('creditCard.includedValue', { used: formatNumber(included.used, locale), granted: formatNumber(included.granted, locale) })}
          </Text>
          <Progress value={includedPct} size="sm" aria-label={t('credits.balanceCard.includedBar')} />
          <Text size="xs" c="dimmed">{t('credits.balanceCard.includedEnds', { date: formatDate(included.endsAt, locale) ?? '' })}</Text>
        </Stack>
        <Stack gap={4}>
          <Text size="sm" c="dimmed">{t('creditCard.prepaid')}</Text>
          <Text size="sm" fw={600}>{t('creditCard.prepaidValue', { remaining: formatNumber(prepaid.remaining, locale) })}</Text>
          <Text size="xs" c="dimmed">
            {prepaid.lots > 0
              ? [
                  t('creditCard.prepaidLots', { lots: prepaid.lots }),
                  prepaid.nextExpiry ? t('credits.balanceCard.nextExpiry', { date: formatDate(prepaid.nextExpiry, locale) ?? '' }) : null,
                ].filter(Boolean).join(' · ')
              : t('credits.balanceCard.noLots')}
          </Text>
          <Text size="xs" c="dimmed">{t('credits.balanceCard.order')}</Text>
        </Stack>
      </SimpleGrid>
    </Paper>
  );
}

function SpendCard({ t, locale, refreshKey }: { t: Translate; locale: string; refreshKey: number }) {
  const [monthsBack, setMonthsBack] = useState('0');
  const [spend, setSpend] = useState<CreditSpend | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const month = utcMonth(new Date(), Number(monthsBack));

  useEffect(() => {
    let cancelled = false;
    fetchCreditSpend({ month })
      .then((data) => {
        if (!cancelled) {
          setSpend(data);
          setUnavailable(false);
        }
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [month, refreshKey]);

  if (unavailable) return null;
  const rows = spend?.models ?? [];
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="flex-start" mb="sm" wrap="wrap">
        <div>
          <Title order={4}>{t('credits.spend.title')}</Title>
          <Text size="sm" c="dimmed">
            {spend ? t('credits.spend.total', { total: formatNumber(spend.total, locale), month: formatPeriod(month, locale) }) : ' '}
          </Text>
        </div>
        <SegmentedControl
          size="xs"
          value={monthsBack}
          onChange={setMonthsBack}
          data={[
            { value: '0', label: t('credits.spend.thisMonth') },
            { value: '1', label: t('credits.spend.lastMonth') },
          ]}
          aria-label={t('credits.spend.periodLabel')}
        />
      </Group>
      {spend && rows.length === 0 ? (
        <Text size="sm" c="dimmed">{t('credits.spend.empty')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="xs" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('credits.spend.columns.model')}</Table.Th>
                <Table.Th>{t('credits.spend.columns.usage')}</Table.Th>
                <Table.Th ta="right">{t('credits.spend.columns.calls')}</Table.Th>
                <Table.Th ta="right">{t('credits.spend.columns.credits')}</Table.Th>
                <Table.Th ta="right">{t('credits.spend.columns.share')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.model ?? 'other'}>
                  <Table.Td>
                    <Text size="sm" fw={500}>{spendLabel(row, t)}</Text>
                    {row.label && row.model && row.model !== 'search' ? <Text size="xs" c="dimmed">{row.model}</Text> : null}
                  </Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{spendUsage(row, t, locale)}</Text></Table.Td>
                  <Table.Td ta="right">{formatNumber(row.count, locale)}</Table.Td>
                  <Table.Td ta="right"><Text size="sm" fw={600}>{formatNumber(row.credits, locale)}</Text></Table.Td>
                  <Table.Td ta="right">
                    {spend && spend.total > 0 ? `${Math.round((row.credits / spend.total) * 100)}%` : '—'}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Paper>
  );
}

function LedgerCard({ t, locale, refreshKey }: { t: Translate; locale: string; refreshKey: number }) {
  const [kind, setKind] = useState<'all' | CreditLedgerKind>('all');
  const [model, setModel] = useState('all');
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<CreditLedgerEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([]);
  /** cursors[i] loads page i + 1; null = the newest entries. */
  const cursors = useRef<Array<string | null>>([null]);
  const requestId = useRef(0);

  const load = useCallback(async (target: number) => {
    const cursor = cursors.current[target - 1];
    if (cursor === undefined) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const result = await fetchCreditLedger({
        limit: pageSize,
        cursor,
        ...(kind !== 'all' ? { kind } : {}),
        ...(model !== 'all' ? { model } : {}),
      });
      if (id !== requestId.current) return;
      cursors.current = cursors.current.slice(0, target);
      if (result.nextCursor) cursors.current[target] = result.nextCursor;
      setEntries(result.entries);
      setHasMore(result.nextCursor !== null);
      setPage(target);
      setUnavailable(false);
    } catch {
      // 404 = this edition has no ledger; any other failure also hides the table.
      if (id === requestId.current) setUnavailable(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [kind, model, pageSize]);

  useEffect(() => {
    cursors.current = [null];
    void load(1);
  }, [load, refreshKey]);

  // The model filter offers what was charged recently (this month and last month).
  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    Promise.all([fetchCreditSpend({ month: utcMonth(now) }), fetchCreditSpend({ month: utcMonth(now, 1) })])
      .then((spends) => {
        if (cancelled) return;
        const seen = new Map<string, string>();
        for (const row of spends.flatMap((spend) => spend.models)) {
          if (row.model && !seen.has(row.model)) seen.set(row.model, spendLabel(row, t));
        }
        setModelOptions([...seen].map(([value, label]) => ({ value, label })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey, t]);

  const columns: DataGridColumn<CreditLedgerEntry>[] = useMemo(() => [
    {
      key: 'at',
      label: t('credits.columns.time'),
      render: (row) => <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{new Date(row.at).toLocaleString(locale)}</Text>,
    },
    {
      key: 'kind',
      label: t('credits.columns.kind'),
      render: (row) => <Badge variant="light" color={KIND_COLORS[row.kind] ?? 'gray'}>{t(`credits.kinds.${row.kind}`)}</Badge>,
    },
    {
      key: 'detail',
      label: t('credits.columns.detail'),
      render: (row) => <Text size="sm" c="dimmed">{describeCreditEntry(row, t, (n) => formatNumber(n, locale))}</Text>,
    },
    {
      key: 'credits',
      label: t('credits.columns.credits'),
      align: 'right',
      render: (row) => (
        <Text size="sm" fw={600} c={row.credits > 0 ? 'teal' : undefined} style={{ whiteSpace: 'nowrap' }}>
          {row.credits > 0 ? '+' : ''}{formatNumber(row.credits, locale)}
        </Text>
      ),
    },
    {
      key: 'balance',
      label: t('credits.columns.balance'),
      align: 'right',
      render: (row) => <Text size="sm">{row.balanceAfter === undefined ? '' : formatNumber(row.balanceAfter, locale)}</Text>,
    },
  ], [t, locale]);

  if (unavailable) return null;
  const filtered = kind !== 'all' || model !== 'all';
  return (
    <Paper withBorder p="md" radius="md">
      <Title order={4}>{t('credits.ledgerTitle')}</Title>
      <Text size="sm" c="dimmed" mb="sm">{t('credits.ledgerDescription')}</Text>
      <DataGrid<CreditLedgerEntry>
        records={entries ?? []}
        rowKey={(row) => row.id}
        columns={columns}
        loading={loading || entries === null}
        filters={[
          {
            value: kind,
            onChange: (value) => setKind(value as 'all' | CreditLedgerKind),
            options: [
              { value: 'all', label: t('credits.filters.allKinds') },
              ...CREDIT_LEDGER_KINDS.map((value) => ({ value, label: t(`credits.kinds.${value}`) })),
            ],
            ariaLabel: t('credits.filters.kind'),
            width: 170,
          },
          {
            value: model,
            onChange: setModel,
            options: [{ value: 'all', label: t('credits.filters.allModels') }, ...modelOptions],
            ariaLabel: t('credits.filters.model'),
            width: 200,
          },
        ]}
        onRefresh={() => {
          cursors.current = [null];
          void load(1);
        }}
        refreshing={loading}
        empty={{ title: filtered ? t('credits.ledgerEmptyFiltered') : t('credits.ledgerEmpty') }}
        pagination={{
          page,
          onPageChange: (next) => void load(next),
          pageSize,
          onPageSizeChange: setPageSize,
          pageSizeOptions: PAGE_SIZES,
          hasMore,
        }}
      />
    </Paper>
  );
}

export default function UsageCreditsTab({
  summary,
  onRedeemed,
}: {
  summary: UsageSummary;
  onRedeemed: () => Promise<void>;
}) {
  const t = useTranslations('usage');
  const locale = useLocale();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const redeem = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setFormError(null);
    try {
      await apiRequest('/api/usage/credits/redeem', { method: 'POST', body: JSON.stringify({ code: trimmed }) });
      notifications.show({ color: 'teal', title: t('credits.redeemed'), message: t('credits.redeemedMessage') });
      setCode('');
      await onRedeemed();
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setFormError(t(`credits.errors.${redeemErrorCode(error)}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="lg">
      <BalanceCard summary={summary} t={t} locale={locale} />

      <Paper withBorder p="md" radius="md">
        <Title order={4}>{t('credits.redeemTitle')}</Title>
        <Text size="sm" c="dimmed" mb="sm">{t('credits.redeemDescription')}</Text>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void redeem();
          }}
        >
          <Group align="flex-end" gap="sm" wrap="wrap">
            <TextInput
              label={t('credits.codeLabel')}
              placeholder={t('credits.codePlaceholder')}
              value={code}
              onChange={(event) => {
                setCode(event.currentTarget.value);
                if (formError) setFormError(null);
              }}
              error={formError}
              style={{ flex: '1 1 260px', maxWidth: 420 }}
              autoComplete="off"
            />
            <Button type="submit" loading={busy} disabled={code.trim() === ''}>
              {t('credits.redeem')}
            </Button>
          </Group>
        </form>
      </Paper>

      <SpendCard t={t} locale={locale} refreshKey={refreshKey} />
      <LedgerCard t={t} locale={locale} refreshKey={refreshKey} />
    </Stack>
  );
}
