'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart } from '@mantine/charts';
import { Badge, Button, Group, Paper, Progress, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { ApiError, apiRequest } from '@/lib/api/client';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { UsageSummary } from '@/lib/limits/usageSummary';
import {
  CREDIT_LEDGER_KINDS,
  describeCreditEntry,
  fetchCreditLedger,
  creditExportUrl,
  fetchCreditMonths,
  fetchCreditSpendGrouped,
  fillDailySpend,
  utcMonth,
  type CreditLedgerEntry,
  type CreditLedgerKind,
  type CreditMonth,
  type CreditSpendGrouped,
  type CreditSpendRow,
} from './creditsApi';
import { formatDate, formatNumber, formatPeriod, runwayText } from './format';

export type { CreditLedgerEntry, CreditLedgerKind } from './creditsApi';

const REDEEM_ERRORS = ['invalid_code', 'code_expired', 'wrong_tenant', 'already_redeemed', 'code_void', 'credits_unavailable'] as const;
const PAGE_SIZES = [25, 50, 100];
const KIND_COLORS: Record<CreditLedgerKind, string> = {
  charge: 'gray',
  redeem: 'teal',
  grant: 'teal',
  revoke: 'red',
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

const SPEND_GROUPS = ['model', 'service', 'project', 'agent'] as const;
type SpendGroup = (typeof SPEND_GROUPS)[number];

function spendLabel(row: CreditSpendRow, t: Translate, group: SpendGroup): string {
  if (row.key === 'unknown') return t('credits.spend.other');
  if (group === 'service') return row.key === 'chat' || row.key === 'embedding' || row.key === 'search' ? t(`credits.services.${row.key}`) : (row.label ?? row.key);
  if (row.key === 'search' || row.service === 'search') return t('credits.services.search');
  return row.label ?? row.key;
}

function BalanceCard({
  summary,
  monthRow,
  isCurrent,
  month,
  t,
  locale,
}: {
  summary: UsageSummary;
  monthRow: CreditMonth | undefined;
  isCurrent: boolean;
  month: string;
  t: Translate;
  locale: string;
}) {
  const credits = summary.credits;
  if (!credits) return null;
  const { included, prepaid, renewal } = credits;
  // The balance is always today's; the monthly card follows the picked month when its history is known.
  const showRow = !isCurrent && monthRow !== undefined;
  const granted = showRow ? monthRow.monthlyGranted : included.granted;
  const used = showRow ? monthRow.monthlyUsed : included.used;
  const monthlyPct = granted > 0 ? Math.min(100, (used / granted) * 100) : 0;
  const remainingMonthly = showRow ? Math.max(0, granted - used - monthRow.monthlyExpired) : Math.max(0, granted - used);
  const lots = credits.oneTimeLots;
  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg">
      <Paper withBorder p="md" radius="md">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">{t('creditCard.balance')}</Text>
          <Text size="xl" fw={700}>{formatNumber(credits.balance, locale)}</Text>
          <Text size="xs" c="dimmed">{runwayText(t, locale, credits.runwayDays)}</Text>
        </Stack>
      </Paper>
      <Paper withBorder p="md" radius="md">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">{t('credits.balanceCard.monthly', { month: formatPeriod(showRow ? month : included.period, locale) })}</Text>
          <Text size="sm" fw={600}>
            {t('credits.balanceCard.monthlyValue', {
              granted: formatNumber(granted, locale),
              used: formatNumber(used, locale),
              remaining: formatNumber(remainingMonthly, locale),
            })}
          </Text>
          <Progress value={monthlyPct} size="sm" aria-label={t('credits.balanceCard.monthlyBar')} />
          {renewal && !showRow ? (
            <Text size="xs" c="dimmed">
              {t('credits.balanceCard.renews', { date: formatDate(renewal.at, locale) ?? '', credits: formatNumber(renewal.includedPerMonth, locale) })}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">{t('credits.balanceCard.includedEnds', { date: formatDate(included.endsAt, locale) ?? '' })}</Text>
          )}
        </Stack>
      </Paper>
      <Paper withBorder p="md" radius="md">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">{t('credits.balanceCard.oneTime')}</Text>
          <Text size="sm" fw={600}>{t('creditCard.prepaidValue', { remaining: formatNumber(prepaid.remaining, locale) })}</Text>
          {lots && lots.length > 0 ? (
            <Stack gap={2}>
              {lots.map((lot) => (
                <Text key={lot.id} size="xs" c="dimmed">
                  {t('credits.balanceCard.lot', {
                    remaining: formatNumber(lot.remaining, locale),
                    credits: formatNumber(lot.credits, locale),
                    expiry: lot.expiresAt
                      ? t('credits.balanceCard.lotEnds', { date: formatDate(lot.expiresAt, locale) ?? '' })
                      : t('credits.balanceCard.noExpiry'),
                  })}
                </Text>
              ))}
            </Stack>
          ) : (
            <Text size="xs" c="dimmed">
              {prepaid.lots > 0
                ? [
                    t('creditCard.prepaidLots', { lots: prepaid.lots }),
                    prepaid.nextExpiry ? t('credits.balanceCard.nextExpiry', { date: formatDate(prepaid.nextExpiry, locale) ?? '' }) : null,
                  ].filter(Boolean).join(' · ')
                : t('credits.balanceCard.noLots')}
            </Text>
          )}
          <Text size="xs" c="dimmed">{t('credits.balanceCard.order')}</Text>
        </Stack>
      </Paper>
    </SimpleGrid>
  );
}

function SpendCard({ month, t, locale, refreshKey }: { month: string; t: Translate; locale: string; refreshKey: number }) {
  const [group, setGroup] = useState<SpendGroup>('model');
  const [spend, setSpend] = useState<CreditSpendGrouped | null>(null);
  const [daily, setDaily] = useState<CreditSpendGrouped | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSpend(null);
    fetchCreditSpendGrouped(month, group)
      .then((data) => {
        if (!cancelled) {
          // An older server that did not group as asked: hide the section rather than show an empty table.
          setSpend(data);
          setUnavailable(data.groupBy !== group);
        }
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [month, group, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setDaily(null);
    // An older server cannot group by day; the chart is then left out.
    fetchCreditSpendGrouped(month, 'day')
      .then((data) => {
        if (!cancelled && data.groupBy === 'day') setDaily(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [month, refreshKey]);

  const chartData = useMemo(() => (daily ? fillDailySpend(month, daily.rows) : []), [daily, month]);

  if (unavailable) return null;
  const rows = spend?.rows ?? [];
  const total = spend?.total;
  const hasSplit = rows.some((row) => row.fromMonthly > 0 || row.fromOneTime > 0);
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="flex-start" mb="sm" wrap="wrap">
        <div>
          <Title order={4}>{t('credits.spend.title')}</Title>
          <Text size="sm" c="dimmed">
            {total ? t('credits.spend.total', { total: formatNumber(total.credits, locale), month: formatPeriod(month, locale) }) : ' '}
          </Text>
        </div>
        <SegmentedControl
          size="xs"
          value={group}
          onChange={(value) => setGroup(value as SpendGroup)}
          data={SPEND_GROUPS.map((value) => ({ value, label: t(`credits.spend.groups.${value}`) }))}
          aria-label={t('credits.spend.groupLabel')}
        />
      </Group>
      {daily && daily.rows.length > 0 ? (
        <Stack gap={4} mb="md">
          <Text size="sm" fw={500}>{t('credits.spend.dailyTitle')}</Text>
          <BarChart
            h={180}
            data={chartData}
            dataKey="day"
            type="stacked"
            withLegend
            tickLine="x"
            series={[
              { name: 'fromMonthly', label: t('credits.spend.fromMonthly'), color: 'blue.6' },
              { name: 'fromOneTime', label: t('credits.spend.fromOneTime'), color: 'teal.6' },
              { name: 'other', label: t('credits.spend.unsplit'), color: 'gray.5' },
            ]}
            xAxisProps={{ tickFormatter: (value: string) => String(Number(value.slice(8))) }}
          />
        </Stack>
      ) : null}
      {spend && rows.length === 0 ? (
        <Text size="sm" c="dimmed">{t('credits.spend.empty')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={520}>
          <Table verticalSpacing="xs" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t(`credits.spend.columns.${group}`)}</Table.Th>
                <Table.Th ta="right">{t('credits.spend.columns.calls')}</Table.Th>
                <Table.Th ta="right">{t('credits.spend.columns.credits')}</Table.Th>
                {hasSplit ? <Table.Th ta="right">{t('credits.spend.fromMonthly')}</Table.Th> : null}
                {hasSplit ? <Table.Th ta="right">{t('credits.spend.fromOneTime')}</Table.Th> : null}
                <Table.Th ta="right">{t('credits.spend.columns.share')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.key}>
                  <Table.Td>
                    <Text size="sm" fw={500}>{spendLabel(row, t, group)}</Text>
                    {group === 'model' && row.label && row.key !== 'search' ? <Text size="xs" c="dimmed">{row.key}</Text> : null}
                  </Table.Td>
                  <Table.Td ta="right">{formatNumber(row.count, locale)}</Table.Td>
                  <Table.Td ta="right"><Text size="sm" fw={600}>{formatNumber(row.credits, locale)}</Text></Table.Td>
                  {hasSplit ? <Table.Td ta="right">{formatNumber(row.fromMonthly, locale)}</Table.Td> : null}
                  {hasSplit ? <Table.Td ta="right">{formatNumber(row.fromOneTime, locale)}</Table.Td> : null}
                  <Table.Td ta="right">
                    {total && total.credits > 0 ? `${Math.round((row.credits / total.credits) * 100)}%` : '—'}
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

function MonthsCard({ months, t, locale }: { months: CreditMonth[]; t: Translate; locale: string }) {
  if (months.length === 0) return null;
  const num = (value: number) => formatNumber(value, locale);
  return (
    <Paper withBorder p="md" radius="md">
      <Title order={4}>{t('credits.months.title')}</Title>
      <Text size="sm" c="dimmed" mb="sm">{t('credits.months.description')}</Text>
      <Table.ScrollContainer minWidth={640}>
        <Table verticalSpacing="xs" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('credits.months.columns.month')}</Table.Th>
              <Table.Th ta="right">{t('credits.months.columns.monthlyGranted')}</Table.Th>
              <Table.Th ta="right">{t('credits.months.columns.monthlyUsed')}</Table.Th>
              <Table.Th ta="right">{t('credits.months.columns.monthlyExpired')}</Table.Th>
              <Table.Th ta="right">{t('credits.months.columns.oneTimeAdded')}</Table.Th>
              <Table.Th ta="right">{t('credits.months.columns.oneTimeUsed')}</Table.Th>
              <Table.Th ta="right">{t('credits.months.columns.charged')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {months.slice(0, 12).map((row) => (
              <Table.Tr key={row.period}>
                <Table.Td>{formatPeriod(row.period, locale)}</Table.Td>
                <Table.Td ta="right">{num(row.monthlyGranted)}</Table.Td>
                <Table.Td ta="right">{num(row.monthlyUsed)}</Table.Td>
                <Table.Td ta="right">{num(row.monthlyExpired)}</Table.Td>
                <Table.Td ta="right">{num(row.oneTimeAdded)}</Table.Td>
                <Table.Td ta="right">{num(row.oneTimeUsed)}</Table.Td>
                <Table.Td ta="right"><Text size="sm" fw={600}>{num(row.charged)}</Text></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

function LedgerCard({ month, t, locale, refreshKey }: { month: string; t: Translate; locale: string; refreshKey: number }) {
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
        month,
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
  }, [kind, model, pageSize, month]);

  useEffect(() => {
    cursors.current = [null];
    void load(1);
  }, [load, refreshKey]);

  // The model filter offers what was charged in the picked month.
  useEffect(() => {
    let cancelled = false;
    setModel('all');
    fetchCreditSpendGrouped(month, 'model')
      .then((spend) => {
        if (cancelled) return;
        setModelOptions(spend.rows.filter((row) => row.key !== 'unknown').map((row) => ({ value: row.key, label: spendLabel(row, t, 'model') })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [month, refreshKey, t]);

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
      key: 'fromMonthly',
      label: t('credits.spend.fromMonthly'),
      align: 'right',
      render: (row) => <Text size="sm">{row.fromMonthly === undefined ? '' : formatNumber(row.fromMonthly, locale)}</Text>,
    },
    {
      key: 'fromOneTime',
      label: t('credits.spend.fromOneTime'),
      align: 'right',
      render: (row) => <Text size="sm">{row.fromOneTime === undefined ? '' : formatNumber(row.fromOneTime, locale)}</Text>,
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
      <Group justify="space-between" align="flex-start" wrap="wrap" mb="sm">
        <div>
          <Title order={4}>{t('credits.ledgerTitle')}</Title>
          <Text size="sm" c="dimmed">{t('credits.ledgerDescription')}</Text>
        </div>
        <Button component="a" href={creditExportUrl(month)} download variant="light" size="xs">
          {t('credits.exportCsv')}
        </Button>
      </Group>
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
  const currentMonth = utcMonth(new Date());
  const [month, setMonth] = useState(currentMonth);
  // null = not loaded yet or not offered by this edition (the picker and the history table are then left out).
  const [months, setMonths] = useState<CreditMonth[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCreditMonths(12)
      .then((rows) => {
        if (!cancelled) setMonths(rows);
      })
      .catch(() => {
        if (!cancelled) setMonths(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const monthOptions = useMemo(() => {
    const periods = new Set<string>([currentMonth, ...(months ?? []).map((row) => row.period)]);
    return [...periods].sort().reverse().map((value) => ({ value, label: formatPeriod(value, locale) }));
  }, [months, currentMonth, locale]);

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
      {months ? (
        <Select
          label={t('credits.monthPicker.label')}
          description={t('credits.monthPicker.hint')}
          data={monthOptions}
          value={month}
          onChange={(value) => setMonth(value ?? currentMonth)}
          allowDeselect={false}
          w={240}
        />
      ) : null}

      <BalanceCard
        summary={summary}
        monthRow={months?.find((row) => row.period === month)}
        isCurrent={month === currentMonth}
        month={month}
        t={t}
        locale={locale}
      />

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

      <SpendCard month={month} t={t} locale={locale} refreshKey={refreshKey} />
      {months ? <MonthsCard months={months} t={t} locale={locale} /> : null}
      <LedgerCard month={month} t={t} locale={locale} refreshKey={refreshKey} />
    </Stack>
  );
}
