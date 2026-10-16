'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Alert, Button, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconExternalLink, IconPlus } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { tryTranslate } from '@/components/resources/i18nLookup';
import { iamHref } from '@/components/iam/links';
import { newLimitHref } from '@/components/iam/limits/links';
import {
  appliesToProject,
  formatAmountValue,
  humanizeKey,
  limitAmounts,
  sortLimitRows,
  targetNounOf,
  type LimitAmount,
  type LimitRow,
} from '@/components/iam/limits/limitsModel';
import { useLimits } from '@/components/iam/limits/useLimits';
import { useTranslations } from '@/lib/i18n';
import { isTenantWideKind } from '@/lib/quota/types';

interface LimitsTabProps {
  projectId: string;
  /** Tenant owners/admins may add limits (the buttons lead into IAM → Limits, which needs that access). */
  canManage?: boolean;
}

const INLINE_AMOUNTS = 3;

/** The original project-wide quota (the old project Quotas form saved it under this label). */
export function isLegacyProjectQuota(row: Pick<LimitRow, 'label' | 'scope' | 'projectId'>): boolean {
  return Boolean(row.projectId) && row.scope === 'tenant' && (row.label ?? '').trim().toLowerCase() === 'project quota';
}

export default function LimitsTab({ projectId, canManage = false }: LimitsTabProps) {
  const t = useTranslations('projectsAccess.limits');
  const tLimits = useTranslations('iamLimits');
  const tScopes = useTranslations('settings.quotaSection.scopes');
  const tDomains = useTranslations('settings.quotaSection.domains');

  const { rows, loading, refreshing, error, forbidden, reload } = useLimits();
  const applying = useMemo(
    () => sortLimitRows(rows.filter((row) => appliesToProject(row, projectId))),
    [rows, projectId],
  );

  const amountLabel = (amount: LimitAmount): string => {
    const [group, first, second] = amount.path.split('.');
    if (group === 'rateLimit') {
      const kind = tryTranslate(tLimits, `amounts.kind.${first}`, 'iamLimits') ?? humanizeKey(first);
      const window = tryTranslate(tLimits, `amounts.window.${second}`, 'iamLimits') ?? second;
      return `${kind} / ${window}`;
    }
    if (group === 'budget') return tLimits(first === 'dailySpendLimit' ? 'amounts.spendDaily' : 'amounts.spendMonthly');
    return tryTranslate(tLimits, `amounts.${group}.${first}`, 'iamLimits') ?? humanizeKey(first);
  };

  const kindLabel = (row: LimitRow): string => {
    if (row.target.type === 'agent') return tLimits('target.agent');
    const noun = row.scope === 'resource' || row.scope === 'provider' ? targetNounOf(row) : null;
    return (noun && tryTranslate(tLimits, `form.targetLabel.${noun}`, 'iamLimits')) || tScopes(row.scope);
  };

  const columns: DataGridColumn<LimitRow>[] = [
    {
      key: 'limit',
      label: t('columns.limit'),
      width: 260,
      render: (row) => (
        <Stack gap={3}>
          <div className="ds-badge-cluster">
            <Text size="sm" fw={600} lineClamp={1}>
              {row.label || t('untitled')}
            </Text>
            {isLegacyProjectQuota(row) ? (
              <Tooltip label={t('legacyHint')} multiline w={240}>
                <span className="ds-badge ds-badge-info">{t('legacy')}</span>
              </Tooltip>
            ) : null}
            {!row.projectId && isTenantWideKind(row) ? (
              <Tooltip label={t('tenantWideHint')} multiline w={240}>
                <span className="ds-badge">{t('tenantWide')}</span>
              </Tooltip>
            ) : null}
          </div>
          {row.description ? (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {row.description}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: 'appliesTo',
      label: t('columns.appliesTo'),
      width: 240,
      render: (row) => (
        <Stack gap={2}>
          <div className="ds-badge-cluster">
            <span className="ds-badge">{kindLabel(row)}</span>
          </div>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {row.scope === 'tenant' ? t('everyone') : (row.target.label ?? row.target.id ?? '—')}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'service',
      label: t('columns.service'),
      width: 130,
      render: (row) => <Text size="sm">{tDomains(row.domain)}</Text>,
    },
    {
      key: 'amounts',
      label: t('columns.amounts'),
      render: (row) => {
        const amounts = limitAmounts(row.limits);
        if (amounts.length === 0) {
          return (
            <Text size="xs" c="dimmed">
              {t('amountsNone')}
            </Text>
          );
        }
        const chip = (amount: LimitAmount) => `${amountLabel(amount)}: ${formatAmountValue(amount)}`;
        const rest = amounts.slice(INLINE_AMOUNTS);
        return (
          <div className="ds-badge-cluster">
            {amounts.slice(0, INLINE_AMOUNTS).map((amount) => (
              <span key={amount.path} className="ds-badge">
                {chip(amount)}
              </span>
            ))}
            {rest.length > 0 ? (
              <Tooltip
                multiline
                w={280}
                label={
                  <Stack gap={2}>
                    {amounts.map((amount) => (
                      <Text key={amount.path} size="xs">
                        {chip(amount)}
                      </Text>
                    ))}
                  </Stack>
                }
              >
                <span className="ds-badge ds-badge-info">{t('amountsMore', { count: rest.length })}</span>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'status',
      label: t('columns.status'),
      width: 90,
      render: (row) =>
        row.enabled ? (
          <span className="ds-badge ds-badge-ok">{t('enabled')}</span>
        ) : (
          <span className="ds-badge">{t('disabled')}</span>
        ),
    },
  ];

  const openInIam = iamHref('limits', { projectId });

  return (
    <Stack gap="sm">
      <div>
        <Text fw={600} size="sm">
          {t('title')}
        </Text>
        <Text size="xs" c="dimmed" maw={720}>
          {t('description')}
        </Text>
      </div>
      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('loadFailed')}>
          {forbidden ? t('forbidden') : error}
        </Alert>
      ) : null}
      <DataGrid<LimitRow>
        records={applying}
        rowKey={(row) => String(row._id)}
        columns={columns}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => void reload()}
        toolbarRight={
          canManage ? (
            <>
              <Button
                component={Link}
                href={openInIam}
                variant="default"
                size="xs"
                leftSection={<IconExternalLink size={13} stroke={1.7} />}
              >
                {t('openInIam')}
              </Button>
              <Button
                component={Link}
                href={newLimitHref({ projectId })}
                color="teal"
                size="xs"
                leftSection={<IconPlus size={13} stroke={1.7} />}
              >
                {t('addLimit')}
              </Button>
            </>
          ) : undefined
        }
        empty={{ title: t('emptyTitle'), description: t('emptyDescription') }}
        footerLeft={t('footer', { count: applying.length })}
      />
    </Stack>
  );
}

