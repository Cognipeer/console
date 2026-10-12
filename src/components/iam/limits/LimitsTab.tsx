'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Button, Group, SimpleGrid, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconActivity,
  IconAlertTriangle,
  IconBrain,
  IconBuildingBank,
  IconCopy,
  IconDatabase,
  IconEdit,
  IconFiles,
  IconGauge,
  IconKey,
  IconPackage,
  IconPlus,
  IconRobot,
  IconServer,
  IconTrash,
  IconUser,
  IconUsersGroup,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn, type DataGridRowAction } from '@/components/common/ui/DataGrid';
import StatTile from '@/components/common/ui/StatTile';
import { useTableControls } from '@/components/common/ui/useTableControls';
import { useDeleteResource } from '@/components/common/confirm';
import { QuotaPolicyModal, type QuotaPolicyFormData } from '@/components/quota/QuotaPolicyModal';
import { tryTranslate } from '@/components/resources/i18nLookup';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import { useLocale, useTranslations } from '@/lib/i18n';
import { QUOTA_DOMAINS, QUOTA_SCOPES, type QuotaDomain, type QuotaScope } from '@/lib/quota/types';
import { parseLimitLink } from './links';
import {
  duplicateSeed,
  filterLimitRows,
  formatAmountValue,
  humanizeKey,
  isInertLimit,
  limitAmounts,
  limitStats,
  sortLimitRows,
  targetNounOf,
  type LimitAmount,
  type LimitRow,
} from './limitsModel';
import { LimitsApiError, useLimits, useProjectOptions } from './useLimits';

interface LimitsTabProps {
  /** Create / edit / delete needs `iam` admin; without it the tab is a read-only view. */
  canManage: boolean;
}

/** Design-system badge tone per kind of target. */
const SCOPE_BADGE: Record<QuotaScope, string> = {
  tenant: 'ds-badge-info',
  group: 'ds-badge-grape',
  user: 'ds-badge-ok',
  token: 'ds-badge-warn',
  resource: '',
  provider: '',
};

const SCOPE_ICON: Record<QuotaScope, ReactNode> = {
  tenant: <IconBuildingBank size={12} />,
  group: <IconUsersGroup size={12} />,
  user: <IconUser size={12} />,
  token: <IconKey size={12} />,
  resource: <IconPackage size={12} />,
  provider: <IconServer size={12} />,
};

/** What a resource limit points at, when it is more specific than "a resource". */
const NOUN_ICON: Partial<Record<NonNullable<ReturnType<typeof targetNounOf>>, ReactNode>> = {
  model: <IconBrain size={12} />,
  vectorIndex: <IconDatabase size={12} />,
  fileBucket: <IconFiles size={12} />,
  agent: <IconRobot size={12} />,
  agentName: <IconActivity size={12} />,
};

/** The amounts shown inline in a row; the rest are in the tooltip. */
const INLINE_AMOUNTS = 3;

export default function LimitsTab({ canManage }: LimitsTabProps) {
  const t = useTranslations('iamLimits');
  const locale = useLocale();
  const tScopes = useTranslations('settings.quotaSection.scopes');
  const tDomains = useTranslations('settings.quotaSection.domains');
  const tConfirm = useTranslations('common.confirm.qos');
  const searchParams = useSearchParams();
  const deleteResource = useDeleteResource();

  const { rows, loading, refreshing, error, forbidden, saving, reload, save, setEnabled, remove } = useLimits();
  const projectOptions = useProjectOptions();

  const [scopeFilter, setScopeFilter] = useState<QuotaScope | 'all'>('all');
  const [domainFilter, setDomainFilter] = useState<QuotaDomain | 'all'>('all');
  // Searched here, not by the table's own box: that one lower-cases with the plain mapping, which cannot
  // tell "İstanbul" from "istanbul" (see searchFold).
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<LimitRow | null>(null);
  const [seed, setSeed] = useState<Partial<QuotaPolicyFormData> | null>(null);

  // `?tab=limits&new=1&principalType=group&principalId=<id>[&domain=...]` opens
  // the editor on a new limit prefilled for that target (once). See ./links.ts.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || !canManage) return;
    const link = parseLimitLink(searchParams);
    if (!link.isNew) return;
    deepLinkHandled.current = true;
    setSeed(link.seed);
    setEditing(null);
    setEditorOpen(true);
  }, [searchParams, canManage]);

  const stats = useMemo(() => limitStats(rows), [rows]);
  const filtered = useMemo(
    () => sortLimitRows(filterLimitRows(rows, { scope: scopeFilter, domain: domainFilter, query })),
    [rows, scopeFilter, domainFilter, query],
  );
  const grid = useTableControls(filtered, { filterKey: `${scopeFilter}|${domainFilter}|${query}` });

  const openNew = useCallback(() => {
    setEditing(null);
    setSeed(null);
    setEditorOpen(true);
  }, []);
  const openEdit = useCallback((row: LimitRow) => {
    setEditing(row);
    setSeed(null);
    setEditorOpen(true);
  }, []);
  const openDuplicate = useCallback(
    (row: LimitRow) => {
      setEditing(null);
      setSeed(duplicateSeed(row, (label) => t('copyOf', { label: label || t('untitled') })));
      setEditorOpen(true);
    },
    [t],
  );
  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditing(null);
    setSeed(null);
  }, []);

  const describe = useCallback(
    (err: unknown): string => {
      if (err instanceof LimitsApiError) {
        const known = err.code ? tryTranslate(t, `errors.${err.code}`, 'iamLimits') : undefined;
        if (known) return known;
        if (err.status === 403) return t('errors.forbidden');
        return err.message;
      }
      return err instanceof Error ? err.message : String(err);
    },
    [t],
  );

  const handleSubmit = useCallback(
    async (data: QuotaPolicyFormData) => {
      try {
        const { warnings } = await save(editing ? String(editing._id) : null, data);
        notifications.show({
          color: warnings.includes('project_required') ? 'yellow' : 'green',
          message: warnings.includes('project_required') ? t('notifications.savedInert') : t('notifications.saved'),
        });
        closeEditor();
      } catch (err) {
        notifications.show({ color: 'red', title: t('notifications.failed'), message: describe(err) });
      }
    },
    [save, editing, closeEditor, describe, t],
  );

  const handleToggle = useCallback(
    async (row: LimitRow, enabled: boolean) => {
      try {
        await setEnabled(row, enabled);
        notifications.show({ color: 'green', message: enabled ? t('notifications.enabled') : t('notifications.disabled') });
      } catch (err) {
        notifications.show({ color: 'red', title: t('notifications.failed'), message: describe(err) });
      }
    },
    [setEnabled, describe, t],
  );

  const handleDelete = useCallback(
    async (row: LimitRow) => {
      const id = String(row._id);
      await deleteResource({
        noun: tConfirm('nouns.quotaPolicy'),
        name: row.label,
        type: 'quota-policy',
        id,
        action: async () => {
          await remove(row);
        },
      });
    },
    [deleteResource, remove, tConfirm],
  );

  const amountLabel = useCallback(
    (amount: LimitAmount): string => {
      const [group, first, second] = amount.path.split('.');
      if (group === 'rateLimit') {
        const kind = tryTranslate(t, `amounts.kind.${first}`, 'iamLimits') ?? humanizeKey(first);
        const window = tryTranslate(t, `amounts.window.${second}`, 'iamLimits') ?? second;
        return `${kind} / ${window}`;
      }
      if (group === 'budget') return t(first === 'dailySpendLimit' ? 'amounts.spendDaily' : 'amounts.spendMonthly');
      return tryTranslate(t, `amounts.${group}.${first}`, 'iamLimits') ?? humanizeKey(first);
    },
    [t],
  );

  /**
   * What kind of thing the limit points at: "Group", "Person"... and, for a resource or provider
   * limit, what that resource is ("Model", "Vector index", "File bucket"...) rather than the
   * catch-all "Resource".
   */
  const kindLabel = (row: LimitRow): string => {
    if (row.target.type === 'agent') return t('target.agent');
    const noun = row.scope === 'resource' || row.scope === 'provider' ? targetNounOf(row) : null;
    return (noun && tryTranslate(t, `form.targetLabel.${noun}`, 'iamLimits')) || tScopes(row.scope);
  };

  const kindIcon = (row: LimitRow): ReactNode => {
    if (row.target.type === 'agent') return <IconRobot size={12} />;
    const noun = row.scope === 'resource' || row.scope === 'provider' ? targetNounOf(row) : null;
    return (noun && NOUN_ICON[noun]) || SCOPE_ICON[row.scope];
  };

  const targetCell = (row: LimitRow) => {
    const { target } = row;
    return (
      <Stack gap={3}>
        <div className="ds-badge-cluster">
          <span className={`ds-badge ${SCOPE_BADGE[row.scope]}`}>
            {kindIcon(row)}
            {kindLabel(row)}
          </span>
          {row.scope === 'group' ? (
            <Tooltip label={row.groupMode === 'shared' ? t('mode.sharedHint') : t('mode.perMemberHint')} multiline w={260}>
              <span className="ds-badge">{row.groupMode === 'shared' ? t('mode.shared') : t('mode.perMember')}</span>
            </Tooltip>
          ) : null}
        </div>
        {row.scope === 'tenant' ? (
          <Text size="xs" c="dimmed">
            {t('target.everyone')}
          </Text>
        ) : (
          // The NAME first, with the key (or e-mail, or description) underneath; a target that no longer exists is called out.
          <div className="ds-badge-cluster">
            <Text size="sm" fw={500} lineClamp={1} title={target.label ?? target.id}>
              {target.label ?? target.id ?? '—'}
            </Text>
            {target.missing ? (
              <Tooltip label={t('target.notFoundHint')} multiline w={260}>
                <span className="ds-badge ds-badge-err">{t('target.notFound')}</span>
              </Tooltip>
            ) : null}
          </div>
        )}
        {target.sublabel ? (
          <Text size="xs" c="dimmed" lineClamp={1} title={target.sublabel}>
            {target.sublabel}
          </Text>
        ) : null}
      </Stack>
    );
  };

  const amountsCell = (row: LimitRow) => {
    const amounts = limitAmounts(row.limits);
    if (amounts.length === 0) {
      return (
        <Text size="xs" c="dimmed">
          {t('amounts.none')}
        </Text>
      );
    }
    const chip = (amount: LimitAmount) => `${amountLabel(amount)}: ${formatAmountValue(amount)}`;
    const shown = amounts.slice(0, INLINE_AMOUNTS);
    const rest = amounts.slice(INLINE_AMOUNTS);
    return (
      <div className="ds-badge-cluster">
        {shown.map((amount) => (
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
            <span className="ds-badge ds-badge-info">{t('amounts.more', { count: rest.length })}</span>
          </Tooltip>
        ) : null}
      </div>
    );
  };

  const columns: DataGridColumn<LimitRow>[] = [
    {
      key: 'limit',
      label: t('columns.limit'),
      width: 230,
      render: (row) => (
        <Stack gap={2}>
          <Text size="sm" fw={600} lineClamp={1}>
            {row.label || t('untitled')}
          </Text>
          {row.description ? (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {row.description}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    { key: 'appliesTo', label: t('columns.appliesTo'), width: 250, render: targetCell },
    {
      key: 'service',
      label: t('columns.service'),
      width: 150,
      render: (row) => <span className="ds-badge ds-badge-grape">{tDomains(row.domain)}</span>,
    },
    {
      key: 'project',
      label: t('columns.project'),
      width: 150,
      render: (row) =>
        isInertLimit(row) ? (
          <Tooltip label={t('inactive.hint')} multiline w={280}>
            <span className="ds-badge ds-badge-warn">
              <IconAlertTriangle size={12} />
              {t('inactive.badge')}
            </span>
          </Tooltip>
        ) : (
          <Text size="sm" c={row.projectName ? undefined : 'dimmed'}>
            {row.projectName ?? t('project.all')}
          </Text>
        ),
    },
    { key: 'amounts', label: t('columns.amounts'), render: amountsCell },
    {
      key: 'priority',
      label: t('columns.priority'),
      align: 'right',
      width: 90,
      render: (row) => (
        <Text size="sm" ff="monospace">
          {row.priority}
        </Text>
      ),
    },
    {
      key: 'active',
      label: t('columns.active'),
      width: 80,
      render: (row) => (
        // The row opens the editor on click; flipping the switch must not.
        <div role="presentation" onClick={(event) => event.stopPropagation()}>
          <Switch
            size="sm"
            checked={row.enabled}
            disabled={!canManage}
            aria-label={t('columns.active')}
            onChange={(event) => void handleToggle(row, event.currentTarget.checked)}
          />
        </div>
      ),
    },
  ];

  const empty = rows.length === 0
    ? {
        icon: <IconGauge size={24} stroke={1.6} />,
        title: t('empty.title'),
        description: t('empty.description'),
        ...(canManage ? { primaryAction: { label: t('newLimit'), icon: <IconPlus size={14} />, onClick: openNew } } : {}),
      }
    : { icon: <IconGauge size={24} stroke={1.6} />, title: t('empty.noMatch') };

  // Nothing loaded and the load failed: say only that. Tiles of zeros and "No limits yet"
  // beside the error would read as "there are none".
  if (error && rows.length === 0 && !loading) {
    return (
      <Stack gap="md" lang={locale}>
        <Text size="sm" c="dimmed" maw={760}>
          {t('intro')}
        </Text>
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('loadFailed')}>
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{forbidden ? t('loadForbidden') : error}</Text>
            {forbidden ? null : (
              <Button size="xs" variant="default" onClick={() => void reload()} loading={refreshing}>
                {t('retry')}
              </Button>
            )}
          </Stack>
        </Alert>
      </Stack>
    );
  }

  return (
    // `lang`: the page's own is "en", and the upper-cased tile labels and column headings would lose their
    // Turkish dots ("LIMITLER", not "LİMİTLER").
    <Stack gap="md" lang={locale}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed" maw={760}>
          {t('intro')}
        </Text>
        {canManage ? null : (
          <span className="ds-badge">{t('readOnly')}</span>
        )}
      </Group>

      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('loadFailed')}>
          {forbidden ? t('loadForbidden') : error}
        </Alert>
      ) : null}

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <StatTile label={t('stats.total')} value={stats.total} icon={<IconGauge size={14} />} />
        <StatTile label={t('stats.groups')} value={stats.groupLimits} icon={<IconUsersGroup size={14} />} />
        <StatTile label={t('stats.agents')} value={stats.agentLimits} icon={<IconRobot size={14} />} />
        <StatTile label={t('stats.inactive')} value={stats.inert} icon={<IconAlertTriangle size={14} />} />
      </SimpleGrid>

      <DataGrid<LimitRow>
        records={grid.records}
        rowKey={(row) => String(row._id)}
        columns={columns}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => void reload()}
        search={{ value: query, onChange: setQuery, placeholder: t('filters.search') }}
        filters={[
          {
            value: scopeFilter,
            onChange: (value) => setScopeFilter(value as QuotaScope | 'all'),
            ariaLabel: t('filters.scope'),
            width: 180,
            options: [
              { value: 'all', label: t('filters.allScopes') },
              ...QUOTA_SCOPES.map((scope) => ({ value: scope, label: tScopes(scope) })),
            ],
          },
          {
            value: domainFilter,
            onChange: (value) => setDomainFilter(value as QuotaDomain | 'all'),
            ariaLabel: t('filters.domain'),
            width: 200,
            options: [
              { value: 'all', label: t('filters.allDomains') },
              ...QUOTA_DOMAINS.map((domain) => ({ value: domain, label: tDomains(domain) })),
            ],
          },
        ]}
        toolbarRight={
          canManage ? (
            <Button color="teal" size="xs" leftSection={<IconPlus size={13} stroke={1.7} />} onClick={openNew}>
              {t('newLimit')}
            </Button>
          ) : undefined
        }
        onRowClick={canManage ? openEdit : undefined}
        rowActions={
          canManage
            ? (): DataGridRowAction<LimitRow>[] => [
                { id: 'edit', label: t('actions.edit'), icon: <IconEdit size={14} />, onClick: openEdit },
                { id: 'duplicate', label: t('actions.duplicate'), icon: <IconCopy size={14} />, onClick: openDuplicate },
                { id: 'sep', divider: true },
                { id: 'delete', label: t('actions.delete'), icon: <IconTrash size={14} />, color: 'red', onClick: handleDelete },
              ]
            : undefined
        }
        empty={empty}
        pagination={grid.pagination}
        footerLeft={t('footer', { shown: grid.records.length, total: grid.filteredCount })}
      />

      <QuotaPolicyModal
        opened={editorOpen}
        onClose={closeEditor}
        onSubmit={handleSubmit}
        policy={editing as unknown as IQuotaPolicy | null}
        loading={saving}
        defaultDomain="llm"
        allowedDomains={[...QUOTA_DOMAINS]}
        allowedScopes={[...QUOTA_SCOPES]}
        projects={projectOptions}
        seed={seed}
        title={editing ? t('form.editTitle') : t('form.createTitle')}
        subtitle={t('form.subtitle')}
      />
    </Stack>
  );
}
