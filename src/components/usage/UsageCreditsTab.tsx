'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { ApiError, apiRequest } from '@/lib/api/client';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { UsageSummary } from '@/lib/limits/usageSummary';
import { formatNumber } from './format';

export type CreditLedgerKind = 'monthly_grant' | 'redeem' | 'charge' | 'refund' | 'adjust' | 'expire';

export interface CreditLedgerEntry {
  id: string;
  at: string;
  kind: CreditLedgerKind;
  credits: number;
  balanceAfter?: number;
  model?: string;
  note?: string;
}

const REDEEM_ERRORS = ['invalid_code', 'code_expired', 'wrong_tenant', 'already_redeemed', 'credits_unavailable'] as const;

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
  const [entries, setEntries] = useState<CreditLedgerEntry[] | null>(null);

  const loadLedger = useCallback(async () => {
    try {
      const data = await apiRequest<{ entries?: CreditLedgerEntry[] }>('/api/usage/credits');
      setEntries(data.entries ?? []);
    } catch {
      // 404 = this edition has no ledger route; any other failure also just hides the table.
      setEntries(null);
    }
  }, []);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const redeem = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setFormError(null);
    try {
      await apiRequest('/api/usage/credits/redeem', { method: 'POST', body: JSON.stringify({ code: trimmed }) });
      notifications.show({ color: 'teal', title: t('credits.redeemed'), message: t('credits.redeemedMessage') });
      setCode('');
      await Promise.all([onRedeemed(), loadLedger()]);
    } catch (error) {
      setFormError(t(`credits.errors.${redeemErrorCode(error)}`));
    } finally {
      setBusy(false);
    }
  };

  const credits = summary.credits;
  const columns: DataGridColumn<CreditLedgerEntry>[] = [
    { key: 'at', label: t('credits.columns.time'), render: (row) => <Text size="sm">{new Date(row.at).toLocaleString(locale)}</Text> },
    { key: 'kind', label: t('credits.columns.kind'), render: (row) => <Text size="sm">{t(`credits.kinds.${row.kind}`)}</Text> },
    {
      key: 'credits',
      label: t('credits.columns.credits'),
      align: 'right',
      render: (row) => <Text size="sm">{row.credits > 0 ? '+' : ''}{formatNumber(row.credits, locale)}</Text>,
    },
    {
      key: 'balance',
      label: t('credits.columns.balance'),
      align: 'right',
      render: (row) => <Text size="sm">{row.balanceAfter === undefined ? '' : formatNumber(row.balanceAfter, locale)}</Text>,
    },
    {
      key: 'detail',
      label: t('credits.columns.detail'),
      render: (row) => <Text size="sm" c="dimmed">{[row.model, row.note].filter(Boolean).join(' · ')}</Text>,
    },
  ];

  return (
    <Stack gap="lg">
      {credits ? (
        <Paper withBorder p="md" radius="md">
          <Text size="sm" c="dimmed">{t('creditCard.balance')}</Text>
          <Text size="xl" fw={700}>{formatNumber(credits.balance, locale)}</Text>
        </Paper>
      ) : null}

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

      {entries ? (
        <Paper withBorder p="md" radius="md">
          <Title order={4} mb="sm">{t('credits.ledgerTitle')}</Title>
          {entries.length === 0 ? (
            <Text size="sm" c="dimmed">{t('credits.ledgerEmpty')}</Text>
          ) : (
            <DataGrid<CreditLedgerEntry> records={entries} rowKey={(row) => row.id} columns={columns} />
          )}
        </Paper>
      ) : null}
    </Stack>
  );
}
