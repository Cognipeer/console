'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  CopyButton,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput, type DatesRangeValue } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCalendar,
  IconCheck,
  IconCopy,
  IconDownload,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useLocale, useTranslations } from '@/lib/i18n';
import { parseLocalDate } from '@/lib/utils/dashboardDateFilter';
import {
  fetchPrincipalDetail,
  IamApiError,
  iamLinks,
  isAbortError,
  isPrincipalType,
  isSimulatable,
  type PrincipalRef,
} from '../principals/client';
import { formatDateTime, formatRelativeTime, shortId, translateOr, type Translate } from '../principals/format';
import { PagerControls, useCursorPager } from '../principals/pager';
import PrincipalPicker from '../principals/PrincipalPicker';
import { formatAuditText } from './summaryText';
import { useServiceLabels } from '../principals/serviceLabels';
import { badgeVariant, PrincipalAvatar } from '../principals/visuals';
import {
  actionLabelKey,
  AUDIT_KINDS,
  auditFiltersFromParams,
  auditFiltersKey,
  auditPrincipalTypes,
  catalogActionOf,
  downloadAuditCsv,
  emptyAuditFilters,
  fetchAudit,
  hasActiveFilters,
  isoToRange,
  lastDaysRange,
  normalizeFiltersForKind,
  rangeToIso,
  saveBlob,
  type AuditFilters,
  type AuditItem,
  type AuditKind,
  type AuditPage,
} from './client';

const NS = 'iamAudit';
const PAGE_SIZE = 25;
const NO_PARAMS = new URLSearchParams();

interface ListState {
  /** The segment the loaded page belongs to (columns differ per segment). */
  forKind: AuditKind | null;
  page: AuditPage | null;
  loading: boolean;
  error: string | null;
}

const CODE_COLOR: Record<string, string> = {
  forbidden: 'red',
  route_not_declared: 'orange',
  ip_not_allowed: 'orange',
  // The engine could not decide (HTTP 503): not a policy answer, so it is not red like a denial.
  authorization_unavailable: 'yellow',
};

function describeError(err: unknown, t: Translate): string {
  if (err instanceof IamApiError) {
    if (err.status === 403) return t('errors.forbidden');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" fw={500}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}

function Dash() {
  return (
    <Text size="sm" c="dimmed">
      —
    </Text>
  );
}

// ── cells ─────────────────────────────────────────────────────────────────

function PrincipalCell({ principal }: { principal: AuditItem['principal'] }) {
  if (!principal) return <Dash />;
  // An id with no name behind it (the person or token was removed since): a short id, the whole one on hover.
  const unnamed = principal.label === principal.id;
  const shown = unnamed ? shortId(principal.id) : principal.label;
  const body = (
    <Group gap={8} wrap="nowrap" title={unnamed ? principal.id : undefined}>
      <PrincipalAvatar type={principal.type} label={shown} size={24} />
      <Text size="sm" c={unnamed ? 'dimmed' : undefined} ff={unnamed ? 'monospace' : undefined} style={{ minWidth: 0 }} truncate>
        {shown}
      </Text>
    </Group>
  );
  if (!isPrincipalType(principal.type)) return body;
  return (
    <Anchor component={Link} href={iamLinks.principal(principal.type, principal.id)} c="inherit" underline="hover">
      {body}
    </Anchor>
  );
}

function TimeCell({ at, locale }: { at: string | null; locale: string }) {
  return (
    <Tooltip label={formatRelativeTime(at, { locale })} withArrow disabled={!at} openDelay={300}>
      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {formatDateTime(at, locale)}
      </Text>
    </Tooltip>
  );
}

function ServiceCell({ item, labelOf, t }: { item: AuditItem; labelOf: (s: string) => string; t: Translate }) {
  if (!item.service && !item.action) return <Dash />;
  return (
    <div style={{ minWidth: 0 }}>
      {item.service ? (
        <Text size="sm" fw={500}>
          {labelOf(item.service)}
        </Text>
      ) : null}
      {item.action ? (
        <Text size="xs" c="dimmed" ff="monospace">
          {translateOr(t, NS, `actions.${actionLabelKey(item)}`, actionLabelKey(item))}
        </Text>
      ) : null}
    </div>
  );
}

function RequestCell({ item, t }: { item: AuditItem; t: Translate }) {
  if (!item.route && !item.method && !item.code) return <Dash />;
  return (
    <Stack gap={4} align="flex-start">
      {item.route || item.method ? (
        <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
          {[item.method, item.route].filter(Boolean).join(' ')}
        </Text>
      ) : null}
      {item.code ? (
        <Badge size="sm" variant={badgeVariant(CODE_COLOR[item.code] ?? 'gray')} color={CODE_COLOR[item.code] ?? 'gray'} tt="none">
          {translateOr(t, NS, `codes.${item.code}`, item.code)}
        </Badge>
      ) : null}
    </Stack>
  );
}

function DecisionCell({ item, t }: { item: AuditItem; t: Translate }) {
  if (item.decisionId) {
    return (
      <Group gap={2} wrap="nowrap">
        <Tooltip label={t('links.openCheck')} withArrow openDelay={300}>
          <Anchor component={Link} href={iamLinks.decision(item.decisionId)} size="xs" ff="monospace">
            {shortId(item.decisionId)}
          </Anchor>
        </Tooltip>
        <CopyButton value={item.decisionId} timeout={1500}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? t('links.copied') : t('links.copyDecision')} withArrow>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={copy} aria-label={t('links.copyDecision')}>
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
    );
  }
  // No recorded decision: re-run the same check from the principal and the required level.
  const action = catalogActionOf(item);
  if (item.principal && isSimulatable(item.principal.type) && action) {
    return (
      <Anchor component={Link} href={iamLinks.simulate(item.principal.type, item.principal.id, action)} size="xs">
        {t('links.recheck')}
      </Anchor>
    );
  }
  return <Dash />;
}

function PolicyCell({ policyId }: { policyId: string | null }) {
  if (!policyId) return <Dash />;
  return (
    <Anchor component={Link} href={iamLinks.policy(policyId)} size="xs" ff="monospace" title={policyId}>
      {shortId(policyId)}
    </Anchor>
  );
}

function SummaryCell({ text }: { text: string }) {
  if (!text) return <Dash />;
  return (
    <Text size="sm" lineClamp={2} title={text} style={{ minWidth: 200, maxWidth: 440 }}>
      {text}
    </Text>
  );
}

// ── tab ───────────────────────────────────────────────────────────────────

export default function AuditTab() {
  const t = useTranslations(NS);
  const tCenter = useTranslations('iamCenter');
  const locale = useLocale();
  // Null outside the app router (a test, a pages-router host): then there are no filters in the address bar.
  const searchParams = useSearchParams();
  const { labelOf, options: serviceOptions } = useServiceLabels();

  // Initial filters come from the address bar (links from the Principals tab).
  const [filters, setFilters] = useState<AuditFilters>(() => auditFiltersFromParams(searchParams ?? NO_PARAMS));
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [state, setState] = useState<ListState>({ forKind: null, page: null, loading: true, error: null });

  const filtersKey = auditFiltersKey(filters);
  const pager = useCursorPager(filtersKey);

  // A link with other filters while this tab stays mounted re-applies them.
  const urlFilters = useMemo(() => auditFiltersFromParams(searchParams ?? NO_PARAMS), [searchParams]);
  const urlKey = auditFiltersKey(urlFilters);
  const [appliedUrlKey, setAppliedUrlKey] = useState(urlKey);
  if (urlKey !== appliedUrlKey) {
    setAppliedUrlKey(urlKey);
    setFilters(urlFilters);
  }

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchAudit(filters, { limit: PAGE_SIZE, cursor: pager.cursor }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setState({ forKind: filters.kind, page, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setState((s) => ({ ...s, loading: false, error: describeError(err, t) }));
      });
    return () => controller.abort();
  }, [filters, pager.cursor, reload, t]);

  // The principal filter shows a name; a link only carries the id, so look the name up.
  const principalKey = filters.principalType && filters.principalId ? `${filters.principalType}:${filters.principalId}` : '';
  const knownLabel = principalKey ? labels[principalKey] : undefined;
  const filterType = filters.principalType;
  const filterId = filters.principalId;
  useEffect(() => {
    if (!principalKey || knownLabel || !filterType || !filterId) return;
    const controller = new AbortController();
    fetchPrincipalDetail(filterType, filterId, null, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setLabels((l) => ({ ...l, [principalKey]: detail.principal.label }));
      })
      .catch(() => {
        /* the id stays as the label */
      });
    return () => controller.abort();
  }, [principalKey, knownLabel, filterType, filterId]);

  const principalRef: PrincipalRef | null =
    filterType && filterId ? { type: filterType, id: filterId, label: knownLabel ?? filterId } : null;

  const setKind = (kind: AuditKind) => setFilters((f) => normalizeFiltersForKind({ ...f, kind }));
  const setRange = (range: DatesRangeValue) => {
    const { from, to } = rangeToIso([parseLocalDate(range[0]), parseLocalDate(range[1])]);
    setFilters((f) => ({ ...f, from, to }));
  };
  const setService = (service: string | null) => setFilters((f) => ({ ...f, service }));
  const setPrincipal = (next: PrincipalRef | null) => {
    if (next) {
      setLabels((l) => ({ ...l, [`${next.type}:${next.id}`]: next.label }));
      setFilters((f) => ({ ...f, principalType: next.type, principalId: next.id }));
    } else {
      setFilters((f) => ({ ...f, principalType: null, principalId: null }));
    }
  };
  const clearFilters = () => setFilters((f) => emptyAuditFilters(f.kind));

  const exportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const download = await downloadAuditCsv(filters);
      saveBlob(download);
      if (download.truncated) {
        notifications.show({ color: 'yellow', title: t('export.button'), message: t('export.truncated'), autoClose: 12000 });
      }
    } catch (err) {
      notifications.show({ color: 'red', title: t('export.failed'), message: describeError(err, t) });
    } finally {
      setExporting(false);
    }
  }, [filters, t]);

  const items = state.forKind === filters.kind ? (state.page?.items ?? []) : [];
  const nextCursor = state.forKind === filters.kind ? (state.page?.nextCursor ?? null) : null;
  // Only the warnings this tab can word (an unknown one from a newer server is ignored).
  const pageWarnings = (state.forKind === filters.kind ? (state.page?.warnings ?? []) : []).filter(
    (w) => w === 'group_members_truncated' || w === 'paging_capped',
  );

  const columns = useMemo<DataGridColumn<AuditItem>[]>(() => {
    const time: DataGridColumn<AuditItem> = {
      key: 'time',
      label: t('columns.time'),
      width: 170,
      render: (row) => <TimeCell at={row.at} locale={locale} />,
    };
    const principal: DataGridColumn<AuditItem> = {
      key: 'principal',
      label: t('columns.principal'),
      width: 200,
      render: (row) => <PrincipalCell principal={row.principal} />,
    };
    const service: DataGridColumn<AuditItem> = {
      key: 'service',
      label: t('columns.service'),
      width: 160,
      render: (row) => <ServiceCell item={row} labelOf={labelOf} t={t} />,
    };
    const request: DataGridColumn<AuditItem> = {
      key: 'request',
      label: t('columns.request'),
      width: 220,
      render: (row) => <RequestCell item={row} t={t} />,
    };
    const decision: DataGridColumn<AuditItem> = {
      key: 'decision',
      label: t('columns.decision'),
      width: 130,
      render: (row) => <DecisionCell item={row} t={t} />,
    };
    const policy: DataGridColumn<AuditItem> = {
      key: 'policy',
      label: t('columns.policy'),
      width: 110,
      render: (row) => <PolicyCell policyId={row.policyId} />,
    };
    const summary: DataGridColumn<AuditItem> = {
      key: 'summary',
      label: t('columns.summary'),
      render: (row) => <SummaryCell text={formatAuditText(row, t, tCenter)} />,
    };
    const actor: DataGridColumn<AuditItem> = {
      key: 'actor',
      label: t('columns.actor'),
      width: 190,
      render: (row) =>
        row.actor ? (
          <Text size="sm" truncate>
            {row.actor}
          </Text>
        ) : (
          <Dash />
        ),
    };
    const event: DataGridColumn<AuditItem> = {
      key: 'event',
      label: t('columns.event'),
      width: 210,
      render: (row) =>
        row.action ? (
          <Badge variant="default" tt="none">
            {translateOr(t, NS, `events.${row.action}`, row.action)}
          </Badge>
        ) : (
          <Dash />
        ),
    };

    if (filters.kind === 'changes') return [time, actor, event, policy, summary];
    return [time, principal, service, request, decision, summary];
  }, [filters.kind, labelOf, locale, t, tCenter]);

  // A failed load must not read as an empty trail: the grid's empty state carries the error.
  const empty = state.error
    ? {
        icon: <IconAlertTriangle size={28} stroke={1.5} color="var(--mantine-color-red-6)" />,
        title: t('errors.loadFailed'),
        description: state.error,
        primaryAction: {
          label: t('errors.retry'),
          icon: <IconRefresh size={14} />,
          onClick: () => setReload((n) => n + 1),
        },
      }
    : hasActiveFilters(filters)
      ? { title: t('empty.filteredTitle'), description: t('empty.filteredHint') }
      : {
          title: t(`empty.${filters.kind}.title`),
          description: t(`empty.${filters.kind}.hint`),
        };

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center" gap="md" wrap="wrap">
        <SegmentedControl
          value={filters.kind}
          onChange={(v) => setKind(v as AuditKind)}
          aria-label={t('segments.label')}
          data={AUDIT_KINDS.map((k) => ({ value: k, label: t(`segments.${k}`) }))}
        />
        <Button
          size="xs"
          variant="default"
          leftSection={<IconDownload size={14} stroke={1.7} />}
          loading={exporting}
          onClick={() => void exportCsv()}
        >
          {t('export.button')}
        </Button>
      </Group>

      <Text size="sm" c="dimmed" maw={760}>
        {t(`hint.${filters.kind}`)}
      </Text>

      <Paper withBorder p="sm" radius="md">
        <Group gap="md" align="flex-end" wrap="wrap">
          <FilterField label={t('filters.dateRange')}>
            <DatePickerInput
              type="range"
              size="xs"
              w={{ base: '100%', sm: 250 }}
              clearable
              value={isoToRange(filters.from, filters.to)}
              onChange={setRange}
              placeholder={filters.kind === 'denials' ? t('filters.dateRangeDefault') : t('filters.dateRangePlaceholder')}
              valueFormat="MMM D, YYYY"
              aria-label={t('filters.dateRange')}
              leftSection={<IconCalendar size={14} stroke={1.5} />}
              presets={[
                { label: t('filters.presets.today'), value: lastDaysRange(1) },
                { label: t('filters.presets.week'), value: lastDaysRange(7) },
                { label: t('filters.presets.month'), value: lastDaysRange(30) },
              ]}
            />
          </FilterField>
          <FilterField label={t('filters.service')}>
            <Select
              size="xs"
              w={{ base: '100%', sm: 210 }}
              searchable
              clearable
              data={serviceOptions}
              value={filters.service}
              onChange={setService}
              placeholder={t('filters.allServices')}
              aria-label={t('filters.service')}
              nothingFoundMessage={t('filters.noService')}
              comboboxProps={{ withinPortal: true }}
            />
          </FilterField>
          <FilterField label={filters.kind === 'changes' ? t('filters.changedBy') : t('filters.principal')}>
            <div style={{ width: 'min(100%, 440px)', minWidth: 'min(100%, 300px)' }}>
              <PrincipalPicker
                key={filters.kind}
                types={auditPrincipalTypes(filters.kind)}
                value={principalRef}
                onChange={setPrincipal}
                placeholder={t('filters.anyPrincipal')}
                ariaLabel={filters.kind === 'changes' ? t('filters.changedBy') : t('filters.principal')}
              />
            </div>
          </FilterField>
          <Group gap="xs" ml="auto" wrap="nowrap">
            {hasActiveFilters(filters) ? (
              <Button size="xs" variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={clearFilters}>
                {t('filters.clear')}
              </Button>
            ) : null}
            <Tooltip label={t('refresh')} withArrow>
              <ActionIcon
                variant="default"
                size="md"
                loading={state.loading}
                onClick={() => setReload((n) => n + 1)}
                aria-label={t('refresh')}
              >
                <IconRefresh size={14} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </Paper>

      {state.error && items.length > 0 ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.loadFailed')}>
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{state.error}</Text>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => setReload((n) => n + 1)}>
              {t('errors.retry')}
            </Button>
          </Stack>
        </Alert>
      ) : null}

      {pageWarnings.map((warning) => (
        <Alert key={warning} color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t(`warnings.${warning}`)}
        </Alert>
      ))}

      <DataGrid<AuditItem>
        records={items}
        rowKey={(row) => row.id}
        columns={columns}
        loading={state.loading}
        empty={empty}
        footerLeft={items.length > 0 ? t('showing', { count: items.length }) : undefined}
        footerRight={
          <PagerControls
            page={pager.page}
            hasNext={nextCursor !== null}
            loading={state.loading}
            onPrev={pager.prev}
            onNext={() => nextCursor && pager.next(nextCursor)}
            previousLabel={t('pager.previous')}
            nextLabel={t('pager.next')}
            pageLabel={t('pager.page', { page: pager.page })}
          />
        }
      />
    </Stack>
  );
}
