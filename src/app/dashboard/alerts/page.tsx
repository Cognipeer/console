'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Switch, Text } from '@mantine/core';
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
  IconLayoutList,
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
import { apiErrorMessage } from '@/components/alerts/apiError';
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
import type { AlertRuleDto } from '@/components/alerts/alertTypes';
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
import { duplicateRuleSeed, prefillFromParams } from '@/components/alerts/ruleForm';
import { pluralKey } from '@/components/alerts/plural';
import {
  useAlertRules,
  useAlertTemplates,
  useDeleteAlertRule,
  usePrimeAlertMeta,
  useToggleAlertRule,
} from '@/lib/api/queries/alerts';
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

  // Status, owner, search and sort are applied by the server; only the module filter works on the loaded list.
  const [filters, setFilters] = useState<RuleListFilters>(DEFAULT_RULE_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [moduleFilter, setModuleFilter] = useState('all');
  const [page, setPage] = useState(1);
  const directory = useUserDirectory();

  const [formOpened, formControls] = useDisclosure(false);
  const [editingRule, setEditingRule] = useState<AlertRuleDto | null>(null);
  const [prefill, setPrefill] = useState<Record<string, unknown> | undefined>();


  // Rule templates: the default-set banner and the "Customize…" deep link read the template list.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const templateParam = searchParams?.get('template') ?? null;
  const templatesQuery = useAlertTemplates();
  const templateList = templatesQuery.data ?? null;
  const bannerStorageKey = templateList ? `alerts.defaultBanner.dismissed.${templateList.projectId}` : null;
  useEffect(() => {
    if (!bannerStorageKey) return;
    try {
      setBannerDismissed(localStorage.getItem(bannerStorageKey) === '1');
    } catch {
      setBannerDismissed(false);
    }
  }, [bannerStorageKey]);
  const dismissBanner = () => {
    setBannerDismissed(true);
    if (!bannerStorageKey) return;
    try {
      localStorage.setItem(bannerStorageKey, '1');
    } catch {
      // The banner just comes back next time.
    }
  };
  const defaultTemplates = (templateList?.items ?? []).filter((item) => item.default && item.availability.available);
  const missingDefaults = defaultTemplates.filter((item) => item.state === 'available').length;

  // ── Load ───────────────────────────────────────────────────────────────
  const rulesQuery = useMemo(() => buildRulesQuery(filters), [filters]);
  const rulesRequest = useAlertRules(rulesQuery);
  const data = rulesRequest.data;
  const rules = useMemo(() => data?.rules ?? [], [data]);
  const meta = data?.meta ?? null;
  const states = useMemo(() => data?.states ?? {}, [data]);
  const derived = useMemo(() => data?.derived ?? {}, [data]);
  const stats = useMemo(() => data?.stats ?? {}, [data]);
  const statsCapped = Boolean(data?.statsCapped);
  const kpis = data?.kpis ?? null;
  const matching = typeof data?.total === 'number' ? data.total : null;
  // The first load shows the skeleton; a changed filter or sort refreshes in place.
  const loading = rulesRequest.isPending;
  const refreshing = rulesRequest.isFetching && !loading;
  const loadError = rulesRequest.isError ? apiErrorMessage(rulesRequest.error, t('loadRulesError')) : null;
  const { refetch: refetchRules } = rulesRequest;
  const reload = useCallback(() => void refetchRules(), [refetchRules]);
  const catalog = useMemo(() => createAlertCatalog(meta?.catalog), [meta?.catalog]);

  // The other alert screens reuse the server's meta instead of asking for it again.
  const primeAlertMeta = usePrimeAlertMeta();
  useEffect(() => primeAlertMeta(meta), [meta, primeAlertMeta]);

  // The template list says which templates already became rules: it is read again when the rule count changes.
  const reloadTemplates = templatesQuery.refetch;
  const ruleCount = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    if (ruleCount.current !== null && ruleCount.current !== rules.length) void reloadTemplates();
    ruleCount.current = rules.length;
  }, [data, rules.length, reloadTemplates]);

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

  // ?template=<key> ("Customize…" in the template gallery) opens the create form with that template's rule.
  useEffect(() => {
    if (!templateParam || loading || !templateList) return;
    router.replace(pathname ?? '/dashboard/alerts');
    const item = templateList.items.find((entry) => entry.key === templateParam);
    if (!item) return;
    setEditingRule(null);
    setPrefill({ ...item.input, template: { key: item.key, version: item.version } } as Record<string, unknown>);
    formControls.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateParam, loading, templateList]);

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
  const toggleRule = useToggleAlertRule();
  const handleToggle = async (rule: AlertRuleDto, enabled: boolean) => {
    try {
      await toggleRule.mutateAsync({ id: rule._id, enabled });
    } catch (error) {
      notifications.show({ title: t('error'), message: apiErrorMessage(error, t('toggleError')), color: 'red' });
    }
  };

  const removeRule = useDeleteAlertRule();
  const handleDelete = async (rule: AlertRuleDto) => {
    const done = await deleteResource({
      noun: tq('nouns.alertRule'),
      name: rule.name,
      type: 'alert-rule',
      id: rule._id,
      action: async () => {
        try {
          await removeRule.mutateAsync(rule._id);
        } catch (error) {
          throw new Error(apiErrorMessage(error, t('deleteError')));
        }
      },
    });
    if (!done) return;
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
            {rule.template ? (
              <Badge component="span" size="xs" variant="outline" color="gray" ml={6} style={{ verticalAlign: 'middle' }}>
                {t('templates.templateBadge')}
              </Badge>
            ) : null}
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
        <MuteMenu rule={rule} muted={isMuted(rule, derived[rule._id])} disabled={!rule.enabled && !isMuted(rule, derived[rule._id])} />
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
            <Button
              component={Link}
              href="/dashboard/alerts/templates"
              variant="default"
              size="sm"
              leftSection={<IconLayoutList size={14} stroke={1.7} />}
            >
              {t('templates.button')}
            </Button>
            <Button color="teal" size="sm" leftSection={<IconBellPlus size={14} stroke={1.7} />} onClick={openCreate}>
              {t('newRule')}
            </Button>
          </>
        }
      />

      {loadError && rules.length === 0 ? (
        <LoadError message={loadError} onRetry={reload} />
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
              <LoadError message={loadError} onRetry={reload} />
            </div>
          ) : null}

          {!pageEmpty && missingDefaults > 0 && !bannerDismissed ? (
            <Alert color="blue" variant="light" mb="md" withCloseButton closeButtonLabel={t('templates.bannerDismiss')} onClose={dismissBanner}>
              <Text size="sm" component="span">
                {t(pluralKey('templates.bannerText', missingDefaults), { missing: missingDefaults, total: defaultTemplates.length })}
              </Text>{' '}
              <Text size="sm" component={Link} href="/dashboard/alerts/templates?show=default" fw={600} style={{ color: 'inherit' }}>
                {t('templates.bannerReview')}
              </Text>
            </Alert>
          ) : null}

          <DataGrid<AlertRuleDto>
            records={pageRules}
            rowKey={(rule) => rule._id}
            columns={columns}
            loading={loading}
            refreshing={refreshing}
            onRefresh={reload}
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
              primaryAction: pageEmpty
                ? defaultTemplates.length > 0
                  ? {
                      label: t('templates.addDefaults', { count: defaultTemplates.length }),
                      icon: <IconLayoutList size={14} />,
                      onClick: () => router.push('/dashboard/alerts/templates?show=default&select=default'),
                    }
                  : { label: t('createFirstRule'), icon: <IconBellPlus size={14} />, onClick: openCreate }
                : undefined,
              extra: pageEmpty ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <Button component={Link} href="/dashboard/alerts/templates" variant="default" size="sm">
                      {t('templates.browse')}
                    </Button>
                    {defaultTemplates.length > 0 ? (
                      <Button variant="default" size="sm" onClick={openCreate}>
                        {t('createFirstRule')}
                      </Button>
                    ) : null}
                  </div>
                  <Text size="xs" c="dimmed" mt="sm">
                    {t('templates.emptyNote')}
                  </Text>
                </>
              ) : undefined,
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
        onSuccess={reload}
        mode={editingRule ? 'edit' : 'create'}
        ruleId={editingRule?._id}
        meta={meta}
        initialData={editingRule ? (editingRule as unknown as Record<string, unknown>) : prefill}
      />
    </PageContainer>
  );
}
