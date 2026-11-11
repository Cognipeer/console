'use client';

import { Button, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { CapacityDimension, MonthlyDimension, UsageRow, UsageSummary } from '@/lib/limits/usageSummary';
import UsageBar from './UsageBar';
import { formatBytes, formatDate, formatNumber, formatPeriod, runwayText } from './format';

type Translate = (key: string, values?: Record<string, string | number>) => string;

const MAIN_CAPACITY: CapacityDimension[] = ['apiRpm', 'agent', 'flow', 'job', 'crawler', 'browser'];
const EXTRA_CAPACITY: CapacityDimension[] = ['realtime', 'sandbox'];

function valueText(
  t: Translate,
  locale: string,
  used: number,
  limit: number | undefined,
  format = formatNumber,
  usedKey: 'usedOnly' | 'usedThisMonth' = 'usedOnly',
): string {
  const usedText = format(used, locale);
  if (limit === undefined) return `${t(usedKey, { used: usedText })} · ${t('noLimit')}`;
  return t('of', { used: usedText, limit: format(limit, locale) });
}

function CapacityRows({ rows, t, locale }: { rows: Array<UsageRow<CapacityDimension>>; t: Translate; locale: string }) {
  return (
    <Stack gap="md">
      {rows.map((row) => (
        <UsageBar
          key={row.dimension}
          label={t(`rows.${row.dimension}`)}
          valueText={valueText(t, locale, row.used, row.limit)}
          used={row.used}
          limit={row.limit}
          peak={row.peak24h}
          peakText={row.peak24h !== undefined ? t('peak', { value: formatNumber(row.peak24h, locale) }) : undefined}
        />
      ))}
    </Stack>
  );
}

export default function UsageOverviewTab({
  summary,
  onOpenCredits,
}: {
  summary: UsageSummary;
  onOpenCredits: () => void;
}) {
  const t = useTranslations('usage');
  const locale = useLocale();
  const { plan, credits } = summary;

  const capacityOf = (ids: CapacityDimension[]) =>
    ids.map((id) => summary.capacity.find((row) => row.dimension === id)).filter((row): row is UsageRow<CapacityDimension> => !!row);
  const monthlyRows: Array<UsageRow<MonthlyDimension>> = summary.monthly;
  const resetsOn = formatDate(summary.resetsAt, locale);

  const seatText = (kind: 'console' | 'portal') => {
    const seats = plan?.seats[kind];
    if (!seats) return '';
    return seats.limit === undefined
      ? t(kind === 'console' ? 'plan.consoleNoLimit' : 'plan.portalNoLimit', { used: seats.used })
      : t(kind === 'console' ? 'plan.console' : 'plan.portal', { used: seats.used, limit: seats.limit });
  };

  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 1, md: credits ? 2 : 1 }} spacing="md">
        <Paper withBorder p="md" radius="md">
          <Title order={4} mb="sm">{t('plan.title')}</Title>
          {plan ? (
            <Stack gap={6}>
              <Text fw={600}>{plan.name ?? plan.id}</Text>
              <Text size="sm" c="dimmed">{t('plan.seats')}: {seatText('console')} · {seatText('portal')}</Text>
              {plan.capacityPacks !== undefined ? (
                <Text size="sm" c="dimmed">{t('plan.packs')}: {plan.capacityPacks}</Text>
              ) : null}
              <Text size="sm" c="dimmed">
                {t('plan.renews')}: {formatDate(plan.expiresAt, locale) ?? t('plan.notSet')}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>{t('plan.managed')}</Text>
            </Stack>
          ) : (
            <Stack gap={4}>
              <Text fw={600}>{t('noPlan')}</Text>
              <Text size="sm" c="dimmed">{t('noPlanDescription')}</Text>
            </Stack>
          )}
        </Paper>

        {credits ? (
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm">
              <Title order={4}>{t('creditCard.title')}</Title>
              <Button variant="subtle" size="compact-sm" onClick={onOpenCredits}>
                {t('creditCard.open')}
              </Button>
            </Group>
            <Stack gap={6}>
              <Text size="xl" fw={700}>
                {t('creditCard.balance')}: {formatNumber(credits.balance, locale)}
              </Text>
              <Text size="sm" c="dimmed">
                {t('creditCard.included')}: {t('creditCard.includedValue', {
                  used: formatNumber(credits.included.used, locale),
                  granted: formatNumber(credits.included.granted, locale),
                })} · {t('creditCard.includedEnds', { date: formatDate(credits.included.endsAt, locale) ?? '' })}
              </Text>
              <Text size="sm" c="dimmed">
                {t('creditCard.prepaid')}: {t('creditCard.prepaidValue', { remaining: formatNumber(credits.prepaid.remaining, locale) })}
                {credits.prepaid.lots > 0 ? ` · ${t('creditCard.prepaidLots', { lots: credits.prepaid.lots })}` : ''}
              </Text>
              <Text size="sm" c="dimmed">
                {t('creditCard.runway')}: {runwayText(t, locale, credits.runwayDays)}
              </Text>
            </Stack>
          </Paper>
        ) : null}
      </SimpleGrid>

      <Paper withBorder p="md" radius="md">
        <Title order={4}>{t('capacity.title')}</Title>
        <Text size="sm" c="dimmed" mb="md">{t('capacity.description')}</Text>
        <CapacityRows rows={capacityOf(MAIN_CAPACITY)} t={t} locale={locale} />
        <Text size="xs" c="dimmed" mt="md">
          {t(summary.counterScope === 'cluster' ? 'scopeCluster' : 'scopePod')}
        </Text>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="md">{t('monthly.title', { month: formatPeriod(summary.period, locale) })}</Title>
        <Stack gap="md">
          {monthlyRows.map((row) => (
            <UsageBar
              key={row.dimension}
              label={t(`rows.${row.dimension}`)}
              valueText={
                row.dimension === 'searches'
                  ? `${t('usedThisMonth', { used: formatNumber(row.used, locale) })} · ${t('paidWithCredits')}`
                  : valueText(t, locale, row.used, row.limit, formatNumber, 'usedThisMonth')
              }
              used={row.used}
              limit={row.limit}
            />
          ))}
        </Stack>
        {resetsOn ? <Text size="xs" c="dimmed" mt="md">{t('monthly.resetsOn', { date: resetsOn })}</Text> : null}
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="md">{t('storageRealtime.title')}</Title>
        <Stack gap="md">
          <UsageBar
            label={t('storageRealtime.storage')}
            valueText={valueText(t, locale, summary.storage.usedBytes, summary.storage.limitBytes, formatBytes)}
            used={summary.storage.usedBytes}
            limit={summary.storage.limitBytes}
          />
          <CapacityRows rows={capacityOf(EXTRA_CAPACITY)} t={t} locale={locale} />
        </Stack>
      </Paper>
    </Stack>
  );
}
