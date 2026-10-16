'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Switch, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconBell,
  IconBellOff,
  IconBellPlus,
  IconBroadcast,
  IconCheck,
  IconCopy,
  IconEdit,
  IconExclamationCircle,
  IconFlame,
  IconHistory,
  IconRipple,
  IconTrash,
} from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { StatGridSkeleton } from '@/components/common/ui/Skeletons';
import StatTile from '@/components/common/ui/StatTile';
import Spark from '@/components/common/ui/Spark';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useDeleteResource } from '@/components/common/confirm';
import { formatDateTime, formatRelative } from '@/components/iam/timeFormat';
import AlertRuleForm from '@/components/alerts/AlertRuleForm';
import LoadError from '@/components/alerts/LoadError';
import { isAbortError, readApiError } from '@/components/alerts/apiError';
import {
  authorableModules,
  conditionMode,
  createAlertCatalog,
  inferModule,
  metricLabel,
  moduleColor,
  moduleLabel,
  MODE_COLORS,
  ruleStateView,
  summarizeCondition,
  summarizeTarget,
} from '@/components/alerts/alertCatalog';
import type {
  AlertMeta,
  AlertRuleDto,
  RuleDerivedDto,
  RuleKpisDto,
  RuleStatsDto,
  StateCounts,
} from '@/components/alerts/alertTypes';
import MuteMenu from '@/components/alerts/rules/MuteMenu';
import {
  DEFAULT_RULE_FILTERS,
  RULE_SORTS,
  RULE_STATUS_FILTERS,
  buildRulesQuery,
  dailySeries,
  firedLast7d,
  isMuted,
  isNoisy,
  type RuleListFilters,
  type RuleSort,
  type RuleStatusFilter,
} from '@/components/alerts/rules/ruleListUi';
import { useUserDirectory } from '@/components/alerts/useUserDirectory';
import { primeAlertMeta } from '@/components/alerts/useAlertMeta';
import { duplicateRuleSeed, prefillFromParams } from '@/components/alerts/ruleForm';
import { pluralKey } from '@/components/alerts/plural';
import { useLocale, useTranslations } from '@/lib/i18n';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

export default function AlertsPage() {
  const t = useTranslations('alerts');
  const tq = useTranslations('common.confirm.qos');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const deleteResource = useDeleteResource();

  const [rules, setRules] = useState<AlertRuleDto[]>([]);
  const [meta, setMeta] = useState<AlertMeta | null>(null);
  const [states, setStates] = useState<Record<string, StateCounts>>({});
  const [derived, setDerived] = useState<Record<string, RuleDerivedDto>>({});
  const [stats, setStats] = useState<Record<string, RuleStatsDto>>({});
  const [statsCapped, setStatsCapped] = useState(false);
  const [kpis, setKpis] = useState<RuleKpisDto | null>(null);
  const [matching, setMatching] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Status, owner, search and sort are applied by the server; only the module filter works on the loaded list.
  const [filters, setFilters] = useState<RuleListFilters>(DEFAULT_RULE_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [moduleFilter, setModuleFilter] = useState('all');
  const [page, setPage] = useState(1);
  const directory = useUserDirectory();

  const [formOpened, formControls] = useDisclosure(false);
  const [editingRule, setEditingRule] = useState<AlertRuleDto | null>(null);
  const [prefill, setPrefill] = useState<Record<string, unknown> | undefined>();

  const catalog = useMemo(() => createAlertCatalog(meta?.catalog), [meta?.catalog]);

  // ── Load ───────────────────────────────────────────────────────────────
  const controllerRef = useRef<AbortController | null>(null);
  const loadedOnce = useRef(false);
  const rulesQuery = useMemo(() => buildRulesQuery(filters), [filters]);
  const load = useCallback(
    async (silent = false) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/alerts/rules?${rulesQuery}`, { signal: controller.signal });
        if (!res.ok) throw new Error(await readApiError(res, t('loadRulesError')));
        const data = (await res.json()) as {
          rules?: AlertRuleDto[];
          meta?: AlertMeta;
          states?: Record<string, StateCounts>;
          derived?: Record<string, RuleDerivedDto>;
          stats?: Record<string, RuleStatsDto>;
          statsCapped?: boolean;
          kpis?: RuleKpisDto;
          total?: number;
        };
        setRules(data.rules ?? []);
        setDerived(data.derived ?? {});
        setStats(data.stats ?? {});
        setStatsCapped(Boolean(data.statsCapped));
        setKpis(data.kpis ?? null);
        setMatching(typeof data.total === 'number' ? data.total : null);
        loadedOnce.current = true;
        setMeta(data.meta ?? null);
        primeAlertMeta(data.meta);
        setStates(data.states ?? {});
        setLoadError(null);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : t('loadRulesError'));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [t, rulesQuery],
  );

  // The first load shows the skeleton; a changed filter or sort refreshes in place.
  useEffect(() => {
    void load(loadedOnce.current);
    return () => controllerRef.current?.abort();
  }, [load]);

  // The search box commits to the server query after a pause, not on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      setFilters((current) => (current.q === searchInput.trim() ? current : { ...current, q: searchInput.trim() }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // ── Deep links ─────────────────────────────────────────────────────────
  // ?create=1&module=agents&metric=agent_error_rate&entityType=agent&entityKey=<name> opens the create form prefilled
  // (tracing pages, report drill-downs); ?edit=<ruleId> opens a rule (incident detail). The parameters are consumed:
  // the URL is cleaned so a reload or a later "New rule" does not open the form again.
  const createParam = searchParams?.get('create') ?? null;
  const moduleParam = searchParams?.get('module') ?? null;
  const metricParam = searchParams?.get('metric') ?? null;
  const entityTypeParam = searchParams?.get('entityType') ?? null;
  const entityKeyParam = searchParams?.get('entityKey') ?? null;
  const editParam = searchParams?.get('edit') ?? null;

  // The create form opens once the first rules request has settled, so it starts with the server's catalog and mode
  // availability (not the bundled fallback) whenever the server answered.
  useEffect(() => {
    if (createParam !== '1' || loading) return;
    setEditingRule(null);
    setPrefill(
      prefillFromParams(
        { module: moduleParam, metric: metricParam, entityType: entityTypeParam, entityKey: entityKeyParam },
        catalog,
      ) as Record<string, unknown>,
    );
    formControls.open();
    router.replace(pathname ?? '/dashboard/alerts');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createParam, loading, moduleParam, metricParam, entityTypeParam, entityKeyParam]);

  useEffect(() => {
    if (!editParam || loading) return;
    const rule = rules.find((entry) => entry._id === editParam);
    router.replace(pathname ?? '/dashboard/alerts');
    if (!rule) return;
    setPrefill(undefined);
    setEditingRule(rule);
    formControls.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam, loading, rules]);

  // ── Actions ────────────────────────────────────────────────────────────
  const handleToggle = async (rule: AlertRuleDto, enabled: boolean) => {
    setRules((prev) => prev.map((entry) => (entry._id === rule._id ? { ...entry, enabled } : entry)));
    try {
      const res = await fetch(`/api/alerts/rules/${rule._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('toggleError')));
    } catch (error) {
      setRules((prev) => prev.map((entry) => (entry._id === rule._id ? { ...entry, enabled: !enabled } : entry)));
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('toggleError'), color: 'red' });
    }
  };

  const handleDelete = async (rule: AlertRuleDto) => {
    const done = await deleteResource({
      noun: tq('nouns.alertRule'),
      name: rule.name,
      type: 'alert-rule',
      id: rule._id,
      action: async () => {
        const res = await fetch(`/api/alerts/rules/${rule._id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await readApiError(res, t('deleteError')));
      },
    });
    if (!done) return;
    setRules((prev) => prev.filter((entry) => entry._id !== rule._id));
    notifications.show({ title: t('ruleDeleted'), message: t('ruleDeletedMessage'), color: 'teal' });
  };

  const openCreate = () => {
    setEditingRule(null);
    setPrefill(undefined);
    formControls.open();
  };

  const openEdit = (rule: AlertRuleDto) => {
    setPrefill(undefined);
    setEditingRule(rule);
    formControls.open();
  };

  /** Copy a rule into the create form. Secrets are never readable, so only email channels carry over. */
  const duplicate = (rule: AlertRuleDto) => {
    const { seed, droppedChannels } = duplicateRuleSeed(rule, t('copyOf', { name: rule.name }));
    if (droppedChannels > 0) {
      notifications.show({ title: t('duplicateNoticeTitle'), message: t('duplicateChannelsDropped'), color: 'blue' });
    }
    setEditingRule(null);
    setPrefill(seed as Record<string, unknown>);
    formControls.open();
  };

  const closeForm = () => {
    formControls.close();
    setEditingRule(null);
    setPrefill(undefined);
  };

  // ── Derived ────────────────────────────────────────────────────────────
  const firingTotal = useMemo(() => Object.values(states).reduce((sum, entry) => sum + (entry?.firing ?? 0), 0), [states]);
  // The server's KPIs cover the whole rule set; a response without them (older server) falls back to the loaded list.
  const kpiValues = {
    active: kpis?.enabled ?? rules.filter((rule) => rule.enabled).length,
    firing: kpis ? Math.max(kpis.firing, firingTotal) : firingTotal,
    muted: kpis?.muted ?? rules.filter((rule) => isMuted(rule, derived[rule._id])).length,
    noisy: kpis?.noisy ?? Object.values(stats).filter((entry) => isNoisy(entry)).length,
  };

  const visible = useMemo(
    () => (moduleFilter === 'all' ? rules : rules.filter((rule) => inferModule(catalog, rule.metric, rule.module) === moduleFilter)),
    [rules, moduleFilter, catalog],
  );
  const filtersActive = filters.status !== 'all' || filters.owner !== 'all' || filters.q !== '' || moduleFilter !== 'all';

  useEffect(() => setPage(1), [filters, moduleFilter]);
  const pageRules = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rulesTotal = matching !== null && moduleFilter === 'all' ? matching : visible.length;

  // Owner = who created the rule. The list of people is only there for viewers who may list users.
  const ownerOptions = useMemo(
    () => [
      { value: 'all', label: t('rulesUx.ownerAll') },
      { value: 'me', label: t('rulesUx.ownerMe') },
      ...Object.entries(directory.names)
        .filter(([id]) => id !== directory.meId)
        .map(([id, name]) => ({ value: id, label: name })),
    ],
    [t, directory.names, directory.meId],
  );

  const moduleOptions = useMemo(
    () => [
      { value: 'all', label: t('filters.allModules') },
      ...authorableModules(catalog, meta?.validModules).map((module) => ({ value: module as string, label: moduleLabel(module, t) })),
    ],
    [catalog, meta?.validModules, t],
  );

  const columns: DataGridColumn<AlertRuleDto>[] = [
    {
      key: 'name',
      label: t('columns.rule'),
      render: (rule) => (
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} lineClamp={1}>
            {rule.name}
          </Text>
          {rule.description ? (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {rule.description}
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      key: 'metric',
      label: t('columns.metric'),
      render: (rule) => {
        const moduleId = inferModule(catalog, rule.metric, rule.module);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
            <Badge size="xs" variant="light" color={moduleColor(moduleId)}>
              {moduleLabel(moduleId, t)}
            </Badge>
            <Text size="xs" c="dimmed">
              {metricLabel(catalog, rule.metric, t)}
            </Text>
          </div>
        );
      },
    },
    {
      key: 'target',
      label: t('columns.target'),
      render: (rule) => {
        const target = summarizeTarget(rule, t);
        return (
          <Text size="xs" className={target.kind === 'selected' ? 'ds-mono' : undefined} lineClamp={2} title={target.keys.join(', ') || undefined}>
            {target.label}
          </Text>
        );
      },
    },
    {
      key: 'condition',
      label: t('columns.condition'),
      render: (rule) => {
        const mode = conditionMode(rule.condition);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
            <Badge size="xs" variant="light" color={MODE_COLORS[mode]}>
              {t(`mode.${mode}`)}
            </Badge>
            <Text size="xs" c="dimmed">
              {summarizeCondition(rule, catalog, t, locale)}
            </Text>
          </div>
        );
      },
    },
    {
      key: 'state',
      label: t('columns.state'),
      render: (rule) => {
        const view = ruleStateView(rule, states[rule._id], meta?.modes);
        const flags = derived[rule._id];
        const muted = isMuted(rule, flags);
        const mutedBadge = muted ? (
          <span
            className="ds-badge ds-badge-warn"
            title={rule.mutedUntil ? t('rulesUx.mutedUntil', { time: formatDateTime(rule.mutedUntil, locale) }) : undefined}
          >
            {rule.mutedUntil ? t('rulesUx.mutedUntilShort', { time: formatRelative(rule.mutedUntil, locale) }) : t('rulesUx.mutedBadge')}
          </span>
        ) : null;
        const noDataBadge =
          flags?.status === 'noData' ? (
            <span className="ds-badge ds-badge-info" title={t('rulesUx.noDataHint')}>
              {t('rulesUx.noDataBadge')}
            </span>
          ) : null;
        if (view.kind === 'paused') return <span className="ds-badge">{t('state.paused')}</span>;
        if (view.kind === 'blocked') {
          return (
            <span
              className="ds-badge ds-badge-warn"
              title={t(view.reason === 'license_required' ? 'state.needsEnterpriseLicense' : 'state.needsEnterpriseBuild')}
            >
              {t('state.needsEnterprise')}
            </span>
          );
        }
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {mutedBadge}
            {noDataBadge}
            {view.firing > 0 ? (
              <Link
                href={`/dashboard/alerts/incidents?ruleId=${encodeURIComponent(rule._id)}&status=all`}
                className="ds-badge ds-badge-err"
                style={{ textDecoration: 'none' }}
              >
                {t('state.firing', { count: view.firing })}
              </Link>
            ) : null}
            {view.pending > 0 ? <span className="ds-badge ds-badge-warn">{t('state.pending', { count: view.pending })}</span> : null}
            {(view.ok > 0 || (view.firing === 0 && view.pending === 0)) && !noDataBadge ? (
              <span className="ds-badge ds-badge-ok">{view.ok > 0 ? t('state.okCount', { count: view.ok }) : t('state.ok')}</span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'noise',
      label: t('rulesUx.noiseColumn'),
      render: (rule) => {
        const entry = stats[rule._id];
        const fired = firedLast7d(entry);
        if (fired === 0) {
          return (
            <Text size="xs" c="dimmed">
              {entry || Object.keys(stats).length > 0 ? '0' : '—'}
            </Text>
          );
        }
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={t(pluralKey('rulesUx.noiseTitle', fired), { count: fired })}>
            <div style={{ width: 64, flex: '0 0 64px' }} aria-hidden="true">
              <Spark data={dailySeries(entry)} height={22} filled={false} color={isNoisy(entry) ? 'var(--ds-danger, #e03131)' : undefined} />
            </div>
            <Text size="xs" fw={600}>
              {fired}
            </Text>
            {isNoisy(entry) ? <span className="ds-badge ds-badge-warn">{t('rulesUx.noisyBadge')}</span> : null}
          </div>
        );
      },
    },
    {
      key: 'lastFired',
      label: t('columns.lastFired'),
      render: (rule) =>
        rule.lastTriggeredAt ? (
          <Text size="xs" title={formatDateTime(rule.lastTriggeredAt, locale)}>
            {formatRelative(rule.lastTriggeredAt, locale)}
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            {t('neverFired')}
          </Text>
        ),
    },
    {
      key: 'mute',
      label: t('rulesUx.muteColumn'),
      align: 'center',
      render: (rule) => (
        <MuteMenu rule={rule} muted={isMuted(rule, derived[rule._id])} onChanged={() => void load(true)} disabled={!rule.enabled && !isMuted(rule, derived[rule._id])} />
      ),
    },
    {
      key: 'enabled',
      label: t('columns.enabled'),
      align: 'center',
      render: (rule) => (
        <Switch
          size="sm"
          checked={rule.enabled}
          aria-label={rule.enabled ? t('clickToDisable') : t('clickToEnable')}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => void handleToggle(rule, event.currentTarget.checked)}
        />
      ),
    },
  ];

  const pageEmpty = rules.length === 0 && !filtersActive;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            <Button
              component={Link}
              href="/dashboard/alerts/incidents"
              variant="default"
              size="sm"
              leftSection={<IconExclamationCircle size={14} stroke={1.7} />}
            >
              {t('incidentsLink')}
            </Button>
            <Button
              component={Link}
              href="/dashboard/alerts/channels"
              variant="default"
              size="sm"
              leftSection={<IconBroadcast size={14} stroke={1.7} />}
            >
              {t('libraryUx.pageLink')}
            </Button>
            <Button component={Link} href="/dashboard/alerts/history" variant="default" size="sm" leftSection={<IconHistory size={14} stroke={1.7} />}>
              {t('viewHistory')}
            </Button>
            <Button color="teal" size="sm" leftSection={<IconBellPlus size={14} stroke={1.7} />} onClick={openCreate}>
              {t('newRule')}
            </Button>
          </>
        }
      />

      {loadError && rules.length === 0 ? (
        <LoadError message={loadError} onRetry={() => void load()} />
      ) : (
        <>
          {loading ? (
            <StatGridSkeleton count={4} style={{ marginBottom: 16 }} />
          ) : (
            <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
              <StatTile label={t('activeRules')} value={kpiValues.active} icon={<IconCheck size={14} stroke={1.7} />} />
              <StatTile label={t('firingNow')} value={kpiValues.firing} icon={<IconFlame size={14} stroke={1.7} />} />
              <StatTile label={t('rulesUx.kpiMuted')} value={kpiValues.muted} icon={<IconBellOff size={14} stroke={1.7} />} />
              <StatTile label={t('rulesUx.kpiNoisy')} value={kpiValues.noisy} icon={<IconRipple size={14} stroke={1.7} />} />
            </div>
          )}
          {loadError ? (
            <div style={{ marginBottom: 12 }}>
              <LoadError message={loadError} onRetry={() => void load(true)} />
            </div>
          ) : null}

          <DataGrid<AlertRuleDto>
            records={pageRules}
            rowKey={(rule) => rule._id}
            columns={columns}
            loading={loading}
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            onRowClick={openEdit}
            search={{ value: searchInput, onChange: setSearchInput, placeholder: t('searchPlaceholder') }}
            filters={[
              { value: moduleFilter, onChange: setModuleFilter, options: moduleOptions, ariaLabel: t('filters.module'), width: 170 },
              {
                value: filters.status,
                onChange: (value) => setFilters((current) => ({ ...current, status: value as RuleStatusFilter })),
                options: RULE_STATUS_FILTERS.map((status) => ({
                  value: status,
                  label: status === 'all' ? t('filters.allStatuses') : t(`rulesUx.status.${status}`),
                })),
                ariaLabel: t('filters.status'),
                width: 150,
              },
              {
                value: filters.owner,
                onChange: (value) => setFilters((current) => ({ ...current, owner: value })),
                options: ownerOptions,
                ariaLabel: t('rulesUx.owner'),
                width: 160,
              },
              {
                value: filters.sort,
                onChange: (value) => setFilters((current) => ({ ...current, sort: value as RuleSort })),
                options: RULE_SORTS.map((sort) => ({ value: sort, label: t(`rulesUx.sort.${sort}`) })),
                ariaLabel: t('rulesUx.sortLabel'),
                width: 190,
              },
            ]}
            rowActions={(rule) => [
              { id: 'edit', label: t('edit'), icon: <IconEdit size={14} />, onClick: openEdit },
              { id: 'duplicate', label: t('duplicate'), icon: <IconCopy size={14} />, onClick: duplicate },
              { id: 'divider', divider: true },
              { id: 'delete', label: t('delete'), icon: <IconTrash size={14} />, color: 'red', onClick: () => void handleDelete(rule) },
            ]}
            empty={{
              icon: <IconBell size={28} />,
              title: pageEmpty ? t('noRules') : t('noMatchingRules'),
              description: pageEmpty ? t('noRulesDescription') : t('noMatchingRulesDescription'),
              primaryAction: pageEmpty ? { label: t('createFirstRule'), icon: <IconBellPlus size={14} />, onClick: openCreate } : undefined,
            }}
            pagination={{
              page,
              onPageChange: setPage,
              pageSize: PAGE_SIZE,
              total: visible.length,
              hasMore: page * PAGE_SIZE < visible.length,
            }}
            footerLeft={
              <>
                {t(pluralKey('showingRules', rulesTotal), { shown: pageRules.length, total: rulesTotal })}
                {statsCapped ? ` · ${t('rulesUx.statsCapped')}` : ''}
              </>
            }
          />
        </>
      )}

      <AlertRuleForm
        opened={formOpened}
        onClose={closeForm}
        onSuccess={() => void load(true)}
        mode={editingRule ? 'edit' : 'create'}
        ruleId={editingRule?._id}
        meta={meta}
        initialData={editingRule ? (editingRule as unknown as Record<string, unknown>) : prefill}
      />
    </PageContainer>
  );
}
