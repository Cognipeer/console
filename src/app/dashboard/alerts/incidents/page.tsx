'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, CloseButton, Group, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCheck,
  IconEye,
  IconLock,
  IconRestore,
  IconSearch,
  IconShieldCheck,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridBulkAction, type DataGridColumn, type DataGridRowAction } from '@/components/common/ui/DataGrid';
import { useConfirm } from '@/components/common/confirm';
import { formatDateTime, formatRelative } from '@/components/iam/timeFormat';
import LoadError from '@/components/alerts/LoadError';
import { isAbortError, readApiError } from '@/components/alerts/apiError';
import {
  authorableModules,
  entityHref,
  entityOf,
  entityTypeLabel,
  formatDurationBetween,
  inferModule,
  metricLabel,
  moduleColor,
  moduleLabel,
} from '@/components/alerts/alertCatalog';
import { useAlertMeta } from '@/components/alerts/useAlertMeta';
import type { IncidentCounts, IncidentDto, IncidentSeverity, IncidentStatus } from '@/components/alerts/alertTypes';
import {
  BULK_ACTIONS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  bulkEligible,
  describeRowValue,
  severityBadgeClass,
  statusActionKey,
  statusBadgeClass,
  type BulkAction,
} from '@/components/alerts/incidentUi';
import { useLocale, useTranslations } from '@/lib/i18n';

const PAGE_SIZE_OPTIONS = [25, 50, 100];
const HIGHLIGHT_MS = 2500;

type StatusTab = IncidentStatus | 'all';

const ACTION_ICONS: Record<string, typeof IconCheck> = {
  acknowledged: IconEye,
  investigating: IconSearch,
  resolved: IconCheck,
  closed: IconLock,
  open: IconRestore,
};

function severityParam(value: string | null): string {
  return INCIDENT_SEVERITIES.includes((value ?? '') as IncidentSeverity) ? (value as string) : '';
}

function statusParam(value: string | null): StatusTab | null {
  if (value === 'all') return 'all';
  return INCIDENT_STATUSES.includes(value as IncidentStatus) ? (value as IncidentStatus) : null;
}

export default function IncidentsPage() {
  const t = useTranslations('incidents');
  const ta = useTranslations('alerts');
  const locale = useLocale();
  const { confirm } = useConfirm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { meta, catalog } = useAlertMeta();

  const highlightId = searchParams?.get('highlight') ?? null;
  const ruleId = searchParams?.get('ruleId') ?? '';
  const entityKey = searchParams?.get('entityKey') ?? '';

  const [tab, setTab] = useState<StatusTab>(() => statusParam(searchParams?.get('status') ?? null) ?? (highlightId ? 'all' : 'open'));
  const [severity, setSeverity] = useState(() => severityParam(searchParams?.get('severity') ?? null));
  const [moduleFilter, setModuleFilter] = useState(searchParams?.get('module') ?? '');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]!);
  const [ruleFilter, setRuleFilter] = useState(ruleId);
  const [entityFilter, setEntityFilter] = useState(entityKey);

  const [incidents, setIncidents] = useState<IncidentDto[]>([]);
  const [counts, setCounts] = useState<IncidentCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<IncidentDto | null>(null);
  const [busy, setBusy] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  const load = useCallback(
    async (silent = false) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams();
        if (tab !== 'all') params.set('status', tab);
        if (severity) params.set('severity', severity);
        if (moduleFilter) params.set('module', moduleFilter);
        if (ruleFilter) params.set('ruleId', ruleFilter);
        if (entityFilter) params.set('entityKey', entityFilter);
        params.set('limit', String(pageSize));
        params.set('skip', String((page - 1) * pageSize));
        const res = await fetch(`/api/alerts/incidents?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error(await readApiError(res, t('loadError')));
        const data = (await res.json()) as { incidents?: IncidentDto[]; total?: number; hasMore?: boolean; counts?: IncidentCounts };
        setIncidents(data.incidents ?? []);
        setTotal(data.total ?? 0);
        setHasMore(Boolean(data.hasMore));
        setCounts(data.counts ?? null);
        setLoadError(null);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : t('loadError'));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [tab, severity, moduleFilter, ruleFilter, entityFilter, page, pageSize, t],
  );

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  // The filters come from the URL (a link from a rule, an entity page or an e-mail). Following another link to this same
  // page (the sub-navigation, a different rule) changes the URL without remounting, so the state is re-seeded from it.
  const urlKey = searchParams?.toString() ?? '';
  useEffect(() => {
    const params = new URLSearchParams(urlKey);
    setTab(statusParam(params.get('status')) ?? (params.get('highlight') ? 'all' : 'open'));
    setSeverity(severityParam(params.get('severity')));
    setModuleFilter(params.get('module') ?? '');
    setRuleFilter(params.get('ruleId') ?? '');
    setEntityFilter(params.get('entityKey') ?? '');
    setPage(1);
  }, [urlKey]);

  // A selection never outlives the page it was made on.
  useEffect(() => setSelected(new Set()), [tab, severity, moduleFilter, ruleFilter, entityFilter, page, pageSize]);

  // ?highlight=<id>: an incident outside the loaded page (an e-mail deep link) is fetched and shown on top.
  const loadedIds = useMemo(() => new Set(incidents.map((incident) => incident._id)), [incidents]);
  // The highlight id that was already looked up: a 404 (or a failure) is not retried after every refresh.
  const attemptedHighlight = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || loading || loadedIds.has(highlightId)) {
      if (pinned && loadedIds.has(pinned._id)) setPinned(null);
      return;
    }
    if (pinned?._id === highlightId || attemptedHighlight.current === highlightId) return;
    attemptedHighlight.current = highlightId;
    const controller = new AbortController();
    fetch(`/api/alerts/incidents/${encodeURIComponent(highlightId)}`, { signal: controller.signal })
      .then(async (res) => (res.ok ? ((await res.json()) as { incident?: IncidentDto }) : null))
      .then((data) => {
        if (data?.incident) setPinned(data.incident);
      })
      .catch(() => {
        // the highlight is a convenience; a missing incident just shows no highlight
      });
    return () => controller.abort();
  }, [highlightId, loading, loadedIds, pinned]);

  const records = useMemo(() => {
    const base = pinned && !loadedIds.has(pinned._id) ? [pinned, ...incidents] : incidents;
    const needle = search.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((incident) => {
      const entity = entityOf(incident);
      return [incident.ruleName, incident.metric, metricLabel(catalog, incident.metric, ta), entity?.key ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [incidents, pinned, loadedIds, search, ta, catalog]);

  // Scroll to and flash the highlighted row, once, when it first appears on screen.
  const flashed = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || loading || flashed.current === highlightId) return;
    const marker = [...document.querySelectorAll<HTMLElement>('[data-incident-row]')].find((node) => node.dataset.incidentRow === highlightId);
    const row = marker?.closest('tr');
    if (!marker || !row) return;
    flashed.current = highlightId;
    marker.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    row.setAttribute('data-highlighted', 'true');
    row.style.transition = 'background-color 0.6s ease';
    row.style.backgroundColor = 'var(--ds-accent-soft)';
    window.setTimeout(() => {
      row.style.backgroundColor = '';
      row.removeAttribute('data-highlighted');
    }, HIGHLIGHT_MS);
  }, [highlightId, loading, records]);

  // ── Actions ────────────────────────────────────────────────────────────
  const changeStatus = async (incident: IncidentDto, status: IncidentStatus) => {
    try {
      const res = await fetch(`/api/alerts/incidents/${incident._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('statusUpdateError')));
      notifications.show({ title: t('statusUpdated'), message: t('statusUpdatedMessage', { status: t(`status.${status}`) }), color: 'teal' });
      void load(true);
    } catch (error) {
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('statusUpdateError'), color: 'red' });
    }
  };

  const runBulk = async (action: BulkAction, rows: IncidentDto[]) => {
    const eligible = bulkEligible(rows, action);
    if (eligible.length === 0) {
      notifications.show({ title: t('bulk.nothingTitle'), message: t('bulk.nothingToDo'), color: 'blue' });
      return;
    }
    if (action !== 'acknowledge') {
      const ok = await confirm({
        title: t(`bulk.confirm.${action}.title`),
        message: t(`bulk.confirm.${action}.message`, { count: eligible.length }),
        confirmLabel: t(`bulk.${action}`),
        tone: action === 'close' ? 'warning' : 'neutral',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/alerts/incidents/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: eligible.map((incident) => incident._id), action }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('bulk.failed')));
      const data = (await res.json()) as { updated?: number; failed?: Array<{ id: string; error: string }> };
      const failed = data.failed?.length ?? 0;
      notifications.show({
        title: t('bulk.doneTitle'),
        message: failed > 0 ? t('bulk.donePartial', { updated: data.updated ?? 0, failed }) : t('bulk.done', { updated: data.updated ?? 0 }),
        color: failed > 0 ? 'orange' : 'teal',
      });
      setSelected(new Set());
      void load(true);
    } catch (error) {
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('bulk.failed'), color: 'red' });
    } finally {
      setBusy(false);
    }
  };

  // ── Grid ───────────────────────────────────────────────────────────────
  const tabs = [
    ...INCIDENT_STATUSES.map((status) => ({ id: status as string, label: t(`status.${status}`), count: counts?.[status] ?? 0 })),
    { id: 'all', label: t('status.all'), count: counts ? INCIDENT_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0) : 0 },
  ];

  const columns: DataGridColumn<IncidentDto>[] = [
    {
      key: 'incident',
      label: t('columns.incident'),
      render: (incident) => {
        const moduleId = inferModule(catalog, incident.metric, incident.module);
        return (
          <div style={{ minWidth: 0 }}>
            <Link href={`/dashboard/alerts/incidents/${incident._id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <Text size="sm" fw={600} lineClamp={1} data-incident-row={incident._id}>
                {incident.ruleName}
              </Text>
            </Link>
            <Group gap={6} mt={2} wrap="nowrap">
              <Badge size="xs" variant="light" color={moduleColor(moduleId)}>
                {moduleLabel(moduleId, ta)}
              </Badge>
              <Text size="xs" c="dimmed" lineClamp={1}>
                {metricLabel(catalog, incident.metric, ta)}
              </Text>
            </Group>
          </div>
        );
      },
    },
    {
      key: 'entity',
      label: t('columns.entity'),
      render: (incident) => {
        const entity = entityOf(incident);
        if (!entity) return <Text size="xs" c="dimmed">—</Text>;
        const href = entityHref(entity.type, entity.key);
        const chip = (
          <span className="ds-badge" title={entityTypeLabel(entity.type, ta)}>
            <span className="ds-mono" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entity.key}
            </span>
          </span>
        );
        return href ? (
          <Link href={href} style={{ textDecoration: 'none' }}>
            {chip}
          </Link>
        ) : (
          chip
        );
      },
    },
    {
      key: 'severity',
      label: t('columns.severity'),
      render: (incident) => <span className={severityBadgeClass(incident.severity)}>{t(`severity.${incident.severity}`)}</span>,
    },
    {
      key: 'status',
      label: t('columns.status'),
      render: (incident) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <span className={statusBadgeClass(incident.status)}>{t(`status.${incident.status}`)}</span>
          {incident.autoResolved ? <span className="ds-badge ds-badge-teal">{t('autoResolved')}</span> : null}
        </div>
      ),
    },
    {
      key: 'value',
      label: t('columns.value'),
      render: (incident) => {
        const text = describeRowValue(incident, catalog, ta, locale);
        return (
          <div>
            <Text size="sm" fw={600}>
              {text.value}
            </Text>
            {text.compare ? (
              <Text size="xs" c="dimmed">
                {text.compare}
              </Text>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'fired',
      label: t('columns.fired'),
      render: (incident) => (
        <Text size="xs" title={formatDateTime(incident.firedAt, locale)}>
          {formatRelative(incident.firedAt, locale)}
        </Text>
      ),
    },
    {
      key: 'duration',
      label: t('columns.duration'),
      render: (incident) => (
        <Text size="xs">{formatDurationBetween(incident.firedAt, incident.resolvedAt ?? incident.closedAt ?? null)}</Text>
      ),
    },
  ];

  const rowActions = (incident: IncidentDto): DataGridRowAction<IncidentDto>[] => [
    { id: 'view', label: t('viewDetail'), icon: <IconEye size={14} />, onClick: () => router.push(`/dashboard/alerts/incidents/${incident._id}`) },
    { id: 'divider', divider: true },
    ...INCIDENT_TRANSITIONS[incident.status].map((status): DataGridRowAction<IncidentDto> => {
      const Icon = ACTION_ICONS[status] ?? IconCheck;
      const key = statusActionKey(status, incident.status);
      return { id: status, label: t(key), icon: <Icon size={14} />, color: status === 'resolved' ? 'teal' : undefined, onClick: () => void changeStatus(incident, status) };
    }),
  ];

  const bulkActions: DataGridBulkAction<IncidentDto>[] = BULK_ACTIONS.map((action) => ({
    label: t(`bulk.${action}`),
    icon: action === 'acknowledge' ? <IconEye size={13} /> : action === 'resolve' ? <IconCheck size={13} /> : <IconLock size={13} />,
    color: action === 'resolve' ? 'teal' : undefined,
    onClick: (rows) => {
      if (!busy) void runBulk(action, rows);
    },
  }));

  const moduleOptions = [
    { value: '', label: t('filters.allModules') },
    ...authorableModules(catalog, meta?.validModules).map((module) => ({ value: module as string, label: moduleLabel(module, ta) })),
  ];

  const openCount = counts?.open ?? 0;
  const activeFilters = (
    <>
      {ruleFilter ? (
        <Badge variant="light" color="gray" rightSection={<CloseButton size="xs" aria-label={t('filters.clearRule')} onClick={() => { setRuleFilter(''); setPage(1); }} />}>
          {t('filters.ruleChip')}
        </Badge>
      ) : null}
      {entityFilter ? (
        <Badge variant="light" color="gray" rightSection={<CloseButton size="xs" aria-label={t('filters.clearEntity')} onClick={() => { setEntityFilter(''); setPage(1); }} />}>
          {t('filters.entityChip', { entity: entityFilter })}
        </Badge>
      ) : null}
    </>
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Group gap="xs">
            {openCount > 0 ? (
              <Badge color="red" variant="filled" size="lg">
                {openCount} {t('openIncidents')}
              </Badge>
            ) : null}
            <Button component={Link} href="/dashboard/alerts" variant="light" size="xs" leftSection={<IconArrowLeft size={14} />}>
              {t('backToAlerts')}
            </Button>
          </Group>
        }
      />

      {loadError ? (
        <div style={{ marginBottom: 12 }}>
          <LoadError message={loadError} onRetry={() => void load(records.length > 0)} />
        </div>
      ) : null}

      <DataGrid<IncidentDto>
        records={records}
        rowKey={(incident) => incident._id}
        columns={columns}
        loading={loading}
        refreshing={refreshing || busy}
        onRefresh={() => void load(true)}
        tabs={tabs}
        activeTab={tab}
        onTabChange={(id) => {
          setTab(id as StatusTab);
          setPage(1);
        }}
        search={{ value: search, onChange: setSearch, placeholder: t('searchPlaceholder') }}
        filters={[
          {
            value: severity,
            onChange: (value) => {
              setSeverity(value);
              setPage(1);
            },
            options: [{ value: '', label: t('filters.allSeverities') }, ...INCIDENT_SEVERITIES.map((entry) => ({ value: entry, label: t(`severity.${entry}`) }))],
            ariaLabel: t('filterBySeverity'),
            width: 150,
          },
          {
            value: moduleFilter,
            onChange: (value) => {
              setModuleFilter(value);
              setPage(1);
            },
            options: moduleOptions,
            ariaLabel: t('filters.module'),
            width: 170,
          },
        ]}
        toolbarRight={activeFilters}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        bulkActions={bulkActions}
        rowHref={(incident) => `/dashboard/alerts/incidents/${incident._id}`}
        rowActions={rowActions}
        empty={{
          icon: <IconShieldCheck size={28} />,
          title: t('noIncidents'),
          description: t('noIncidentsDescription'),
        }}
        pagination={{
          page,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setPage(1);
          },
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          total,
          hasMore,
        }}
        footerLeft={t('showing', { shown: records.length, total })}
      />
    </PageContainer>
  );
}
