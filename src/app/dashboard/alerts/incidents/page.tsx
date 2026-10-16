'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, CloseButton, Group, Switch, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconBellOff,
  IconBellRinging,
  IconCheck,
  IconEye,
  IconKeyboard,
  IconLock,
  IconRefresh,
  IconRestore,
  IconSearch,
  IconShieldCheck,
  IconUserCheck,
  IconUserPlus,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridBulkAction, type DataGridColumn, type DataGridRowAction } from '@/components/common/ui/DataGrid';
import TabsBar from '@/components/common/ui/TabsBar';
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
import { userLabel as resolveUserLabel, useUserDirectory } from '@/components/alerts/useUserDirectory';
import type { IncidentCounts, IncidentDto, IncidentSeverity, IncidentStatsDto, IncidentStatus } from '@/components/alerts/alertTypes';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  bulkEligible,
  describeRowValue,
  isSnoozed,
  severityBadgeClass,
  statusActionKey,
  statusBadgeClass,
  type BulkAction,
} from '@/components/alerts/incidentUi';
import AssignDialog from '@/components/alerts/inbox/AssignDialog';
import IncidentGroups from '@/components/alerts/inbox/IncidentGroups';
import InboxKpis from '@/components/alerts/inbox/InboxKpis';
import PreviewPane from '@/components/alerts/inbox/PreviewPane';
import ShortcutsHelp from '@/components/alerts/inbox/ShortcutsHelp';
import ViewsMenu from '@/components/alerts/inbox/ViewsMenu';
import {
  BUILTIN_VIEWS,
  INBOX_GROUPS,
  INBOX_SORTS,
  activeView,
  changedIds,
  filtersToQuery,
  groupIncidents,
  listQuery,
  loadSavedViews,
  moveFocus,
  newSavedView,
  parseFilters,
  resolveShortcut,
  savedViewsKey,
  statsRangeParam,
  storeSavedViews,
  viewFilters,
  visibleOrder,
  type InboxFilters,
  type InboxGroup,
  type InboxView,
  type StatsRange,
  type StatusTab,
} from '@/components/alerts/inbox/inboxModel';
import { SnoozeDialog } from '@/components/alerts/incident/SnoozeMenu';
import { useEntityLinks } from '@/components/alerts/incident/useEntityLinks';
import { useLocale, useTranslations } from '@/lib/i18n';

const PAGE_SIZE_OPTIONS = [25, 50, 100];
const HIGHLIGHT_MS = 2500;
const FLASH_MS = 4000;
const POLL_MS = 15_000;
const STATS_REFRESH_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 350;
const INBOX_PATH = '/dashboard/alerts/incidents';

const ACTION_ICONS: Record<string, typeof IconCheck> = {
  acknowledged: IconEye,
  investigating: IconSearch,
  resolved: IconCheck,
  closed: IconLock,
  open: IconRestore,
};

interface BulkOptions {
  assignedTo?: string | null;
  until?: string;
  /** Ask first (the bulk bar does; a keyboard shortcut on one row does not). */
  confirm?: boolean;
  /** Clear the selection afterwards. */
  clearSelection?: boolean;
}

export default function IncidentsPage() {
  const t = useTranslations('incidents');
  const ta = useTranslations('alerts');
  const locale = useLocale();
  const { confirm } = useConfirm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { meta, catalog } = useAlertMeta();
  const directory = useUserDirectory();
  const wide = useMediaQuery('(min-width: 1180px)');

  const urlKey = searchParams?.toString() ?? '';
  const highlightId = searchParams?.get('highlight') ?? null;
  const filters = useMemo(() => parseFilters(new URLSearchParams(urlKey)), [urlKey]);
  const range = useMemo(() => statsRangeParam(new URLSearchParams(urlKey).get('range')), [urlKey]);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]!);
  const [live, setLive] = useState(true);

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
  const [stats, setStats] = useState<IncidentStatsDto | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [snoozeRows, setSnoozeRows] = useState<IncidentDto[] | null>(null);
  const [assignRows, setAssignRows] = useState<IncidentDto[] | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [savedViews, setSavedViews] = useState<InboxView[]>([]);

  const previousRows = useRef<IncidentDto[] | null>(null);
  const serverTime = useRef<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  // ── URL as the single source of the filters ───────────────────────────────
  const navigate = useCallback(
    (next: InboxFilters, nextRange: StatsRange = range) => {
      const query = filtersToQuery(next, { range: nextRange }).toString();
      router.replace(`${INBOX_PATH}?${query}`, { scroll: false });
    },
    [router, range],
  );
  const patchFilters = useCallback(
    (patch: Partial<InboxFilters>) => {
      setPage(1);
      navigate({ ...filters, ...patch });
    },
    [filters, navigate],
  );

  // Search is typed locally and committed to the URL (and so to the server query) after a pause.
  const committedQ = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== committedQ.current) {
      committedQ.current = filters.q;
      setSearchInput(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    const next = searchInput.trim();
    if (next === filters.q) return;
    const timer = window.setTimeout(() => {
      committedQ.current = next;
      patchFilters({ q: next });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput, filters.q, patchFilters]);

  // ── Data ──────────────────────────────────────────────────────────────────
  const controllerRef = useRef<AbortController | null>(null);
  const load = useCallback(
    async (silent = false) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/alerts/incidents?${listQuery(filters, page, pageSize).toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error(await readApiError(res, t('loadError')));
        const data = (await res.json()) as { incidents?: IncidentDto[]; total?: number; hasMore?: boolean; counts?: IncidentCounts; serverTime?: string };
        const rows = data.incidents ?? [];
        if (silent) {
          const changed = changedIds(previousRows.current, rows);
          if (changed.size > 0) {
            setFlash(changed);
            if (flashTimer.current) window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlash(new Set()), FLASH_MS);
          }
        }
        previousRows.current = rows;
        serverTime.current = data.serverTime ?? new Date().toISOString();
        setIncidents(rows);
        setTotal(data.total ?? 0);
        setHasMore(Boolean(data.hasMore));
        setCounts(data.counts ?? null);
        setUpdatedAt(Date.now());
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
    [filters, page, pageSize, t],
  );

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/alerts/incidents/stats?range=${range}`, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error('stats');
      setStats((await res.json()) as IncidentStatsDto);
      setStatsFailed(false);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return;
      setStatsFailed(true);
    }
  }, [range]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStats(controller.signal);
    const timer = window.setInterval(() => void loadStats(), STATS_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadStats]);

  // Live refresh: a cheap "anything changed since?" probe every 15 s while the tab is visible; a change reloads the page of rows
  // (so every filter, sort and the paging still apply) and the new or changed rows are flagged for a few seconds.
  const probe = useCallback(async () => {
    if (!serverTime.current) return;
    try {
      const res = await fetch(`/api/alerts/incidents?updatedAfter=${encodeURIComponent(serverTime.current)}&limit=1`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { incidents?: IncidentDto[]; serverTime?: string };
      if ((data.incidents?.length ?? 0) > 0) {
        void load(true);
        void loadStats();
      } else if (data.serverTime) {
        serverTime.current = data.serverTime;
        setUpdatedAt(Date.now());
      }
    } catch {
      // a failed probe is retried on the next tick
    }
  }, [load, loadStats]);

  useEffect(() => {
    if (!live) return;
    const run = () => {
      if (document.visibilityState === 'visible') void probe();
    };
    const timer = window.setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [live, probe]);

  // "Updated Ns ago" needs a clock.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => () => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
  }, []);

  // A link to this page from elsewhere (a rule, an entity, an e-mail, the sub-navigation) changes the URL without remounting.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setCollapsed(new Set());
  }, [urlKey]);
  // A selection never outlives the page it was made on.
  useEffect(() => setSelected(new Set()), [page, pageSize]);

  // Saved views live in this browser, per signed-in user (and per host: a tenant has its own address).
  const storageKey = directory.meId ? savedViewsKey(typeof window !== 'undefined' ? window.location.host : '', directory.meId) : null;
  const browserStorage = useCallback((): Storage | null => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    if (storageKey) setSavedViews(loadSavedViews(browserStorage(), storageKey));
  }, [storageKey, browserStorage]);

  // ?highlight=<id>: an incident outside the loaded page (an e-mail deep link) is fetched and shown on top.
  const loadedIds = useMemo(() => new Set(incidents.map((incident) => incident._id)), [incidents]);
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

  const records = useMemo(() => (pinned && !loadedIds.has(pinned._id) ? [pinned, ...incidents] : incidents), [incidents, pinned, loadedIds]);
  const groupBy = filters.group;
  const groups = useMemo(() => (groupBy === 'none' ? [] : groupIncidents(records, groupBy)), [records, groupBy]);
  const order = useMemo(() => visibleOrder(records, groupBy, collapsed), [records, groupBy, collapsed]);
  const previewIncident = useMemo(() => records.find((incident) => incident._id === previewId) ?? null, [records, previewId]);

  const linkEntities = useMemo(
    () => records.flatMap((incident) => { const entity = entityOf(incident); return entity?.type ? [{ type: entity.type, key: entity.key }] : []; }),
    [records],
  );
  const links = useEntityLinks(linkEntities);

  // Scroll to and flash the highlighted row, once, when it first appears on screen.
  const flashed = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || loading || flashed.current === highlightId) return;
    const marker = [...document.querySelectorAll<HTMLElement>('[data-incident-row]')].find((node) => node.dataset.incidentRow === highlightId);
    const row = marker?.closest<HTMLElement>('tr, [data-row-container]');
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

  // Marks on the drawn rows: a bar for rows the live refresh just changed, an outline for the keyboard focus.
  useEffect(() => {
    for (const marker of document.querySelectorAll<HTMLElement>('[data-incident-row]')) {
      const row = marker.closest<HTMLElement>('tr, [data-row-container]');
      if (!row) continue;
      const id = marker.dataset.incidentRow ?? '';
      row.style.boxShadow = flash.has(id) ? 'inset 4px 0 0 var(--ds-accent)' : '';
      row.style.outline = id === focusedId ? '2px solid var(--ds-accent)' : '';
      row.style.outlineOffset = '-2px';
    }
  }, [records, flash, focusedId, groupBy, collapsed]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const refreshAll = useCallback(() => {
    void load(true);
    void loadStats();
  }, [load, loadStats]);

  const changeStatus = async (incident: IncidentDto, status: IncidentStatus) => {
    try {
      const res = await fetch(`/api/alerts/incidents/${incident._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('statusUpdateError')));
      notifications.show({ title: t('statusUpdated'), message: t('statusUpdatedMessage', { status: t(`status.${status}`) }), color: 'teal' });
      refreshAll();
    } catch (error) {
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('statusUpdateError'), color: 'red' });
    }
  };

  const runBulk = async (action: BulkAction, rows: IncidentDto[], options: BulkOptions = {}) => {
    const eligible = bulkEligible(rows, action);
    if (eligible.length === 0) {
      notifications.show({ title: t('bulk.nothingTitle'), message: t('bulk.nothingToDo'), color: 'blue' });
      return;
    }
    if (options.confirm && (action === 'resolve' || action === 'close' || action === 'reopen')) {
      const ok = await confirm({
        title: action === 'reopen' ? t('ux.bulk.reopenTitle') : t(`bulk.confirm.${action}.title`),
        message: action === 'reopen' ? t('ux.bulk.reopenMessage', { count: eligible.length }) : t(`bulk.confirm.${action}.message`, { count: eligible.length }),
        confirmLabel: action === 'reopen' ? t('reopen') : t(`bulk.${action}`),
        tone: action === 'close' ? 'warning' : 'neutral',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ids: eligible.map((incident) => incident._id), action };
      if (action === 'assign') body.assignedTo = options.assignedTo ?? null;
      if (action === 'snooze') body.until = options.until;
      const res = await fetch('/api/alerts/incidents/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await readApiError(res, t('bulk.failed')));
      const data = (await res.json()) as { updated?: number; failed?: Array<{ id: string; error: string }> };
      const failed = data.failed?.length ?? 0;
      notifications.show({
        title: t('bulk.doneTitle'),
        message: failed > 0 ? t('bulk.donePartial', { updated: data.updated ?? 0, failed }) : t('bulk.done', { updated: data.updated ?? 0 }),
        color: failed > 0 ? 'orange' : 'teal',
      });
      if (options.clearSelection) setSelected(new Set());
      refreshAll();
    } catch (error) {
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('bulk.failed'), color: 'red' });
    } finally {
      setBusy(false);
    }
  };

  const toggleSelect = useCallback(
    (id: string) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const selectGroup = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  // ── Views ──────────────────────────────────────────────────────────────────
  const allViews = useMemo(() => [...BUILTIN_VIEWS, ...savedViews], [savedViews]);
  const currentView = activeView(filters, allViews);
  const applyView = (view: InboxView) => {
    setPage(1);
    navigate({ ...viewFilters(view), group: filters.group });
  };
  const saveView = (name: string) => {
    if (!storageKey) return;
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `v${Date.now().toString(36)}`;
    const next = [...savedViews, newSavedView(name, filters, id)];
    if (storeSavedViews(browserStorage(), storageKey, next)) setSavedViews(next);
    else notifications.show({ title: t('error'), message: t('ux.views.storeFailed'), color: 'red' });
  };
  const deleteView = (id: string) => {
    if (!storageKey) return;
    const next = savedViews.filter((view) => view.id !== id);
    storeSavedViews(browserStorage(), storageKey, next);
    setSavedViews(next);
  };

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const stateRef = useRef({ order, selected, focusedId, previewId, records });
  stateRef.current = { order, selected, focusedId, previewId, records };
  const actionsRef = useRef({ runBulk });
  actionsRef.current = { runBulk };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const action = resolveShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        targetTag: target?.tagName,
        targetEditable: Boolean(target?.isContentEditable),
        targetRole: target?.getAttribute?.('role'),
        targetType: (target as HTMLInputElement | null)?.type ?? null,
      });
      if (!action) return;
      // A dialog (or an open menu) owns the keyboard.
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      const { order: rows, selected: chosen, focusedId: focus, previewId: preview, records: all } = stateRef.current;
      const focusedRow = all.find((incident) => incident._id === focus) ?? null;
      const targets = chosen.size > 0 ? all.filter((incident) => chosen.has(incident._id)) : focusedRow ? [focusedRow] : [];
      switch (action) {
        case 'next':
        case 'prev': {
          event.preventDefault();
          const id = moveFocus(rows.map((incident) => incident._id), focus, action === 'next' ? 1 : -1);
          setFocusedId(id);
          if (id && preview) setPreviewId(id);
          document.querySelectorAll<HTMLElement>('[data-incident-row]').forEach((node) => {
            if (node.dataset.incidentRow === id) node.closest('tr, [data-row-container]')?.scrollIntoView?.({ block: 'nearest' });
          });
          break;
        }
        case 'select':
          if (focus) {
            event.preventDefault();
            toggleSelect(focus);
          }
          break;
        case 'acknowledge':
          if (targets.length) void actionsRef.current.runBulk('acknowledge', targets, { clearSelection: chosen.size > 0 });
          break;
        case 'resolve':
          if (targets.length) void actionsRef.current.runBulk('resolve', targets, { confirm: targets.length > 1, clearSelection: chosen.size > 0 });
          break;
        case 'snooze':
          if (targets.length) {
            event.preventDefault();
            setSnoozeRows(targets);
          }
          break;
        case 'assignMe':
          if (targets.length) void actionsRef.current.runBulk('assign', targets, { assignedTo: 'me', clearSelection: chosen.size > 0 });
          break;
        case 'search':
          event.preventDefault();
          document.querySelector<HTMLInputElement>('[data-inbox-search]')?.focus();
          break;
        case 'open':
          if (focus) router.push(`${INBOX_PATH}/${focus}`);
          break;
        case 'help':
          event.preventDefault();
          setHelpOpen(true);
          break;
        case 'escape':
          if (preview) setPreviewId(null);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, toggleSelect]);

  // ── Grid ───────────────────────────────────────────────────────────────────
  const tabs = [
    ...INCIDENT_STATUSES.map((status) => ({ id: status as string, label: t(`status.${status}`), count: counts?.[status] ?? 0 })),
    { id: 'all', label: t('status.all'), count: counts ? INCIDENT_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0) : 0 },
  ];

  const userLabel = (id: string | null | undefined, serverName?: string | null): string =>
    resolveUserLabel(id, directory, { you: t('you'), system: t('system') }, serverName);

  const columns: DataGridColumn<IncidentDto>[] = [
    {
      key: 'incident',
      label: t('columns.incident'),
      render: (incident) => {
        const moduleId = inferModule(catalog, incident.metric, incident.module);
        return (
          <div style={{ minWidth: 0 }}>
            <Link href={`${INBOX_PATH}/${incident._id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
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
        const href = entityHref(entity.type, entity.key, links);
        const chip = (
          <span className="ds-badge" title={entity.type ? entityTypeLabel(entity.type, ta) : undefined}>
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
          {isSnoozed(incident) ? <span className="ds-badge" title={formatDateTime(incident.snoozedUntil, locale)}>{t('ux.snooze.badge')}</span> : null}
        </div>
      ),
    },
    {
      key: 'assignee',
      label: t('ux.columns.assignee'),
      render: (incident) => (
        <Text size="xs" c={incident.assignedTo ? undefined : 'dimmed'}>
          {incident.assignedTo ? userLabel(incident.assignedTo, incident.assignedToName) : t('unassignedLabel')}
        </Text>
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
    { id: 'view', label: t('viewDetail'), icon: <IconEye size={14} />, onClick: () => router.push(`${INBOX_PATH}/${incident._id}`) },
    { id: 'divider', divider: true },
    ...INCIDENT_TRANSITIONS[incident.status].map((status): DataGridRowAction<IncidentDto> => {
      const Icon = ACTION_ICONS[status] ?? IconCheck;
      const key = statusActionKey(status, incident.status);
      return { id: status, label: t(key), icon: <Icon size={14} />, color: status === 'resolved' ? 'teal' : undefined, onClick: () => void changeStatus(incident, status) };
    }),
    ...(incident.assignedTo ? [] : [{ id: 'assignMe', label: t('assignToMe'), icon: <IconUserCheck size={14} />, onClick: () => void runBulk('assign', [incident], { assignedTo: 'me' }) } as DataGridRowAction<IncidentDto>]),
    ...(isSnoozed(incident)
      ? [{ id: 'unsnooze', label: t('ux.snooze.clear'), icon: <IconBellRinging size={14} />, onClick: () => void runBulk('unsnooze', [incident]) } as DataGridRowAction<IncidentDto>]
      : bulkEligible([incident], 'snooze').length > 0
        ? [{ id: 'snooze', label: t('ux.snooze.button'), icon: <IconBellOff size={14} />, onClick: () => setSnoozeRows([incident]) } as DataGridRowAction<IncidentDto>]
        : []),
  ];

  const bulkSpecs: Array<{ id: string; label: string; icon: ReactNode; color?: DataGridBulkAction<IncidentDto>['color']; run: (rows: IncidentDto[]) => void }> = [
    { id: 'acknowledge', label: t('bulk.acknowledge'), icon: <IconEye size={13} />, run: (rows) => void runBulk('acknowledge', rows, { confirm: true, clearSelection: true }) },
    { id: 'resolve', label: t('bulk.resolve'), icon: <IconCheck size={13} />, color: 'teal', run: (rows) => void runBulk('resolve', rows, { confirm: true, clearSelection: true }) },
    { id: 'close', label: t('bulk.close'), icon: <IconLock size={13} />, run: (rows) => void runBulk('close', rows, { confirm: true, clearSelection: true }) },
    { id: 'reopen', label: t('reopen'), icon: <IconRestore size={13} />, run: (rows) => void runBulk('reopen', rows, { confirm: true, clearSelection: true }) },
    { id: 'assign', label: t('ux.bulk.assign'), icon: <IconUserPlus size={13} />, run: (rows) => setAssignRows(rows) },
    { id: 'snooze', label: t('ux.bulk.snooze'), icon: <IconBellOff size={13} />, run: (rows) => setSnoozeRows(rows) },
    { id: 'unsnooze', label: t('ux.bulk.unsnooze'), icon: <IconBellRinging size={13} />, run: (rows) => void runBulk('unsnooze', rows, { clearSelection: true }) },
  ];
  const bulkActions: DataGridBulkAction<IncidentDto>[] = bulkSpecs.map((spec) => ({
    label: spec.label,
    icon: spec.icon,
    color: spec.color,
    onClick: (rows) => {
      if (!busy) spec.run(rows);
    },
  }));

  const moduleOptions = [
    { value: '', label: t('filters.allModules') },
    ...authorableModules(catalog, meta?.validModules).map((module) => ({ value: module as string, label: moduleLabel(module, ta) })),
  ];

  const secondsAgo = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null;
  void tick;
  const updatedLabel = secondsAgo == null ? '' : secondsAgo < 5 ? t('ux.live.justNow') : t('ux.live.ago', { seconds: secondsAgo });

  const openCount = counts?.open ?? 0;
  const selectedRows = records.filter((incident) => selected.has(incident._id));

  const filterChips = (
    <>
      {filters.ruleId ? (
        <Badge variant="light" color="gray" rightSection={<CloseButton size="xs" aria-label={t('filters.clearRule')} onClick={() => patchFilters({ ruleId: '' })} />}>
          {t('filters.ruleChip')}
        </Badge>
      ) : null}
      {filters.entityKey ? (
        <Badge variant="light" color="gray" rightSection={<CloseButton size="xs" aria-label={t('filters.clearEntity')} onClick={() => patchFilters({ entityKey: '' })} />}>
          {t('filters.entityChip', { entity: filters.entityKey })}
        </Badge>
      ) : null}
    </>
  );

  const assigneeValue = filters.assignee === 'me' || filters.assignee === 'unassigned' || filters.assignee === '' ? filters.assignee : 'user';
  const toolbarSelect = (props: { value: string; onChange: (value: string) => void; label: string; options: Array<{ value: string; label: string }>; width?: number }) => (
    <select className="ds-select" aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} style={{ width: props.width }}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  const filterBar = (
    <div className="ds-card" style={{ marginBottom: 12 }}>
      <div className="ds-toolbar" style={{ flexWrap: 'wrap' }}>
        <ViewsMenu activeId={currentView?.id ?? null} saved={savedViews} onApply={applyView} onSave={saveView} onDelete={deleteView} canSave={Boolean(storageKey && browserStorage())} />
        <div className="ds-toolbar-search">
          <IconSearch size={14} stroke={1.7} color="var(--ds-text-muted)" />
          <input
            data-inbox-search
            type="text"
            value={searchInput}
            maxLength={200}
            placeholder={t('ux.searchPlaceholder')}
            aria-label={t('ux.searchPlaceholder')}
            onChange={(event) => setSearchInput(event.currentTarget.value)}
          />
        </div>
        {toolbarSelect({
          value: filters.severity,
          onChange: (value) => patchFilters({ severity: value as '' | IncidentSeverity }),
          label: t('filterBySeverity'),
          width: 140,
          options: [{ value: '', label: t('filters.allSeverities') }, ...INCIDENT_SEVERITIES.map((entry) => ({ value: entry, label: t(`severity.${entry}`) }))],
        })}
        {toolbarSelect({ value: filters.module, onChange: (value) => patchFilters({ module: value }), label: t('filters.module'), width: 160, options: moduleOptions })}
        {toolbarSelect({
          value: assigneeValue,
          onChange: (value) => patchFilters({ assignee: value === 'user' ? filters.assignee : value }),
          label: t('ux.filters.assignee'),
          width: 150,
          options: [
            { value: '', label: t('ux.filters.anyAssignee') },
            { value: 'me', label: t('ux.filters.assignedToMe') },
            { value: 'unassigned', label: t('ux.filters.unassigned') },
            ...(assigneeValue === 'user' ? [{ value: 'user', label: userLabel(filters.assignee) }] : []),
          ],
        })}
        {toolbarSelect({
          value: filters.snoozed,
          onChange: (value) => patchFilters({ snoozed: value as '' | 'true' | 'false' }),
          label: t('ux.filters.snoozed'),
          width: 140,
          options: [
            { value: '', label: t('ux.filters.snoozedAny') },
            { value: 'true', label: t('ux.filters.snoozedOnly') },
            { value: 'false', label: t('ux.filters.notSnoozed') },
          ],
        })}
        {toolbarSelect({
          value: filters.sort,
          onChange: (value) => patchFilters({ sort: value as InboxFilters['sort'] }),
          label: t('ux.sort.label'),
          width: 170,
          options: INBOX_SORTS.map((sort) => ({ value: sort, label: t(`ux.sort.${sort}`) })),
        })}
        {toolbarSelect({
          value: filters.group,
          onChange: (value) => {
            setPage(1);
            navigate({ ...filters, group: value as InboxGroup });
          },
          label: t('ux.groups.label'),
          width: 150,
          options: INBOX_GROUPS.map((group) => ({ value: group, label: t(`ux.groups.${group}`) })),
        })}
        {filterChips}
      </div>
    </div>
  );

  const liveControls = (
    <div className="ds-row" style={{ gap: 10 }}>
      <Switch size="xs" checked={live} onChange={(event) => setLive(event.currentTarget.checked)} label={t('ux.live.label')} aria-label={t('ux.live.label')} />
      {updatedLabel ? (
        <Text size="xs" c="dimmed" aria-live="off">
          {live ? updatedLabel : t('ux.live.paused', { when: updatedLabel })}
        </Text>
      ) : null}
      <Button variant="subtle" color="gray" size="compact-xs" leftSection={<IconRefresh size={13} />} loading={refreshing} onClick={refreshAll}>
        {t('ux.refresh')}
      </Button>
    </div>
  );

  const emptyState = {
    icon: <IconShieldCheck size={28} />,
    title: t('noIncidents'),
    description: t('noIncidentsDescription'),
  };

  const preview = previewIncident ? (
    <PreviewPane
      incident={previewIncident}
      catalog={catalog}
      links={links}
      userLabel={userLabel}
      busy={busy}
      onClose={() => setPreviewId(null)}
      onStatus={(status) => void changeStatus(previewIncident, status)}
      onSnooze={() => setSnoozeRows([previewIncident])}
      onUnsnooze={() => void runBulk('unsnooze', [previewIncident])}
      onAssignMe={() => void runBulk('assign', [previewIncident], { assignedTo: 'me' })}
    />
  ) : null;

  const pager = (
    <div className="ds-row-between" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
      <Text size="xs" c="dimmed">
        {t('showing', { shown: records.length, total })}
      </Text>
      <div className="ds-row" style={{ gap: 8 }}>
        <select className="ds-select" aria-label={t('ux.pager.pageSize')} value={pageSize} onChange={(event) => { setPageSize(Number(event.currentTarget.value)); setPage(1); }}>
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <Button size="xs" variant="default" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          {t('ux.pager.prev')}
        </Button>
        <Text size="xs">{page}</Text>
        <Button size="xs" variant="default" disabled={!hasMore} onClick={() => setPage(page + 1)}>
          {t('ux.pager.next')}
        </Button>
      </div>
    </div>
  );

  const groupLabel = (group: { key: string; incidents: IncidentDto[] }) => {
    const first = group.incidents[0]!;
    if (groupBy === 'rule') return first.ruleName;
    const entity = entityOf(first);
    return entity ? `${entity.type ? entityTypeLabel(entity.type, ta) : ''} ${entity.key}`.trim() : t('ux.groups.noEntity');
  };

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
            <Button variant="default" size="xs" leftSection={<IconKeyboard size={14} />} onClick={() => setHelpOpen(true)}>
              {t('ux.shortcuts.button')}
            </Button>
            <Button component={Link} href="/dashboard/alerts" variant="light" size="xs" leftSection={<IconArrowLeft size={14} />}>
              {t('backToAlerts')}
            </Button>
          </Group>
        }
      />

      <InboxKpis
        range={range}
        onRangeChange={(next) => navigate(filters, next)}
        stats={stats}
        failed={statsFailed}
      />

      {loadError ? (
        <div style={{ marginBottom: 12 }}>
          <LoadError message={loadError} onRetry={() => void load(records.length > 0)} />
        </div>
      ) : null}

      <TabsBar items={tabs} activeId={filters.status} onChange={(id) => patchFilters({ status: id as StatusTab })} />
      {filterBar}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: preview && wide ? 'minmax(0, 1fr) 360px' : 'minmax(0, 1fr)', alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>
          {groupBy === 'none' ? (
            <DataGrid<IncidentDto>
              records={records}
              rowKey={(incident) => incident._id}
              columns={columns}
              loading={loading}
              refreshing={refreshing || busy}
              toolbarRight={liveControls}
              selectable
              selected={selected}
              onSelectionChange={setSelected}
              bulkActions={bulkActions}
              onRowClick={(incident) => {
                setPreviewId(incident._id);
                setFocusedId(incident._id);
              }}
              rowHref={(incident) => `${INBOX_PATH}/${incident._id}`}
              rowActions={rowActions}
              empty={emptyState}
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
          ) : (
            <>
              <div className="ds-row-between" style={{ marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {selected.size > 0 ? (
                    <>
                      <Text size="sm" c="dimmed">
                        {t('ux.groups.selected', { count: selected.size })}
                      </Text>
                      {bulkSpecs.map((spec) => (
                        <Button key={spec.id} size="xs" variant="default" color={spec.color} leftSection={spec.icon} disabled={busy} onClick={() => spec.run(selectedRows)}>
                          {spec.label}
                        </Button>
                      ))}
                    </>
                  ) : null}
                </div>
                {liveControls}
              </div>
              {loading && records.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('ux.loading')}
                </Text>
              ) : records.length === 0 ? (
                <div className="ds-empty">
                  {emptyState.icon}
                  <div style={{ fontWeight: 600 }}>{emptyState.title}</div>
                  <div className="ds-muted">{emptyState.description}</div>
                </div>
              ) : (
                <IncidentGroups
                  groups={groups}
                  by={groupBy}
                  collapsed={collapsed}
                  onToggle={(key) =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  onSelectGroup={selectGroup}
                  previewId={previewId}
                  onPreview={(incident) => {
                    setPreviewId(incident._id);
                    setFocusedId(incident._id);
                  }}
                  groupLabel={groupLabel}
                  links={links}
                />
              )}
              {pager}
            </>
          )}
        </div>
        {preview && wide ? preview : null}
      </div>
      {preview && !wide ? <div style={{ marginTop: 12 }}>{preview}</div> : null}

      <SnoozeDialog
        opened={snoozeRows !== null}
        count={snoozeRows?.length ?? 1}
        loading={busy}
        onClose={() => setSnoozeRows(null)}
        onConfirm={(until) => {
          const rows = snoozeRows ?? [];
          setSnoozeRows(null);
          void runBulk('snooze', rows, { until: until.toISOString(), clearSelection: rows.length > 1 });
        }}
      />
      <AssignDialog
        opened={assignRows !== null}
        count={assignRows?.length ?? 1}
        directory={directory}
        loading={busy}
        onClose={() => setAssignRows(null)}
        onConfirm={(assignedTo) => {
          const rows = assignRows ?? [];
          setAssignRows(null);
          void runBulk('assign', rows, { assignedTo, clearSelection: rows.length > 1 });
        }}
      />
      <ShortcutsHelp opened={helpOpen} onClose={() => setHelpOpen(false)} />
    </PageContainer>
  );
}
