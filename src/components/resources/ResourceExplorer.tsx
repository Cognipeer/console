'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  CopyButton,
  Drawer,
  Group,
  Loader,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Tooltip,
  ActionIcon,
} from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconCopy, IconExternalLink } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTranslations } from '@/lib/i18n';
import { tryTranslate } from './i18nLookup';
import ResourceUsagePanel, { type ResourceEdgeView, type ResourceRefView } from './ResourceUsagePanel';
import ResourceHealthPanel, {
  explainIssue,
  SeverityBadge,
  type HealthIssue,
  type HealthSummary,
} from './ResourceHealthPanel';

type StatusTone = 'ok' | 'off' | 'warn' | 'neutral';

// Mirrors the ResourceListItem / ResourceDetail contract of GET /api/resources.
interface ResourceListItem {
  crn: string;
  type: string;
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  status: string | null;
  statusTone: StatusTone;
  createdBy: string | null;
  createdByLabel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  issueCount?: number;
  issueSeverity?: 'error' | 'warning' | null;
}

interface ResourceDetail extends ResourceListItem {
  uses?: ResourceEdgeView[];
  usedBy?: ResourceEdgeView[];
  issues?: HealthIssue[];
  updatedBy: string | null;
  updatedByLabel: string | null;
  attributes: Array<{ key: string; value: string | number | boolean | null }>;
  detailUrl: string | null;
}

interface ResourceTypeInfo {
  type: string;
  service: string;
  category: string;
  scope: string;
  edition: string;
}

interface ListResponse {
  items: ResourceListItem[];
  total: number;
  counts: Record<string, number>;
  types: ResourceTypeInfo[];
  projects: Array<{ id: string; name: string }>;
  /** Distinct statuses after project/q/type filters (not the status filter). */
  statuses: string[];
  errors: Array<{ type: string; message: string }>;
  truncated: Array<{ type: string; limit: number }>;
  generatedAt: string;
}

const CATEGORY_ORDER = ['agents', 'knowledge', 'models', 'safety', 'quality', 'operations'];
const ALL = '';
const TENANT = 'tenant';

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'ds-badge-ok',
  off: '',
  warn: 'ds-badge-warn',
  neutral: 'ds-badge-info',
};

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86400_000],
    ['month', 30 * 86400_000],
    ['day', 86400_000],
    ['hour', 3600_000],
    ['minute', 60_000],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(-Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'second');
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function ResourceExplorer() {
  const t = useTranslations('resources');

  const [type, setType] = useState<string>(ALL);
  const [projectId, setProjectId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [tab, setTab] = useState<string>('resources');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [healthSummary, setHealthSummary] = useState<HealthSummary | null>(null);
  const [healthReload, setHealthReload] = useState(0);

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResourceListItem | null>(null);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [detailState, setDetailState] = useState<'loading' | 'done' | 'failed'>('loading');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  // True while the drawer shows a bare reference (no list row behind it).
  const [selectedIsStub, setSelectedIsStub] = useState(false);

  const requestSeq = useRef(0);
  const detailSeq = useRef(0);
  const pendingRefresh = useRef(false);

  // Debounce the free-text search; reset paging when the applied query changes.
  useEffect(() => {
    const handle = setTimeout(() => {
      setQ((prev) => {
        if (prev !== searchInput) setPage(1);
        return searchInput;
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    const refresh = pendingRefresh.current;
    pendingRefresh.current = false;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (projectId) params.set('projectId', projectId);
      if (q.trim()) params.set('q', q.trim());
      if (status) params.set('status', status);
      if (onlyIssues) params.set('health', 'issues');
      params.set('limit', String(pageSize));
      params.set('offset', String((page - 1) * pageSize));
      if (refresh) params.set('refresh', '1');
      const res = await fetch(`/api/resources?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('loadFailed'));
      }
      const body = (await res.json()) as ListResponse;
      if (seq !== requestSeq.current) return;
      setData(body);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [type, projectId, q, status, onlyIssues, page, pageSize, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/resources/health', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { summary: HealthSummary };
      setHealthSummary(body.summary);
    } catch {
      // The header badge is a convenience; the lists work without it.
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleRefresh = () => {
    pendingRefresh.current = true;
    void load();
    void loadSummary();
    setHealthReload((n) => n + 1);
  };

  const typeInfo = useMemo(() => {
    const map = new Map<string, ResourceTypeInfo>();
    for (const info of data?.types ?? []) map.set(info.type, info);
    return map;
  }, [data?.types]);

  const typeLabel = useCallback(
    (value: string) => {
      return tryTranslate(t, `types.${value}`) ?? value;
    },
    [t],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, ResourceTypeInfo[]>();
    for (const info of data?.types ?? []) {
      const list = groups.get(info.category) ?? [];
      list.push(info);
      groups.set(info.category, list);
    }
    const ordered = [...CATEGORY_ORDER, ...[...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c))];
    return ordered
      .filter((c) => groups.has(c))
      .map((c) => ({
        category: c,
        types: (groups.get(c) ?? []).sort((a, b) => typeLabel(a.type).localeCompare(typeLabel(b.type))),
      }));
  }, [data?.types, typeLabel]);

  const counts = data?.counts ?? {};
  const totalAll = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const projectName = (row: ResourceListItem) => row.projectName ?? (row.projectId ? row.projectId : t('tenantWide'));

  const columns: DataGridColumn<ResourceListItem>[] = [
    {
      key: 'name',
      label: t('colName'),
      render: (row) => (
        <div>
          <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
            {row.issueCount && row.issueSeverity ? (
              <Tooltip label={t('issueCount', { count: row.issueCount })} withArrow>
                <IconAlertCircle
                  size={15}
                  aria-label={t('issueCount', { count: row.issueCount })}
                  color={row.issueSeverity === 'error' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-yellow-7)'}
                  style={{ flexShrink: 0 }}
                />
              </Tooltip>
            ) : null}
            {row.name}
          </div>
          {row.key ? (
            <div
              style={{
                fontFamily: 'var(--ds-font-mono, monospace)',
                fontSize: 11.5,
                color: 'var(--ds-text-muted)',
              }}
            >
              {row.key}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'type',
      label: t('colType'),
      render: (row) => <span className="ds-badge">{typeLabel(row.type)}</span>,
    },
    { key: 'project', label: t('colProject'), render: (row) => projectName(row) },
    {
      key: 'status',
      label: t('colStatus'),
      render: (row) =>
        row.status ? (
          <span className={`ds-badge ${TONE_CLASS[row.statusTone] ?? ''}`}>
            <span className="ds-badge-dot" />
            {row.status}
          </span>
        ) : (
          <Text size="sm" c="dimmed">—</Text>
        ),
    },
    { key: 'owner', label: t('colOwner'), render: (row) => row.createdByLabel ?? '—' },
    {
      key: 'updated',
      label: t('colUpdated'),
      render: (row) => (
        <span title={formatDate(row.updatedAt)}>{formatRelative(row.updatedAt)}</span>
      ),
    },
  ];

  // Open the drawer for a bare reference (health issue / usage panel). The list
  // row isn't at hand, so a minimal stub stands in until the detail arrives.
  const openRef = (ref: ResourceRefView) => {
    if (!ref.id) return;
    void openRow(
      {
      crn: ref.crn ?? '',
      type: ref.type,
      id: ref.id,
      key: ref.key,
      name: ref.name ?? ref.key ?? ref.id,
      description: null,
      projectId: ref.projectId,
      projectName: ref.projectName,
      status: null,
      statusTone: 'neutral',
      createdBy: null,
      createdByLabel: null,
      createdAt: null,
      updatedAt: null,
      },
      true,
    );
  };

  const openRow = async (row: ResourceListItem, stub = false) => {
    const seq = ++detailSeq.current;
    setSelected(row);
    setSelectedIsStub(stub);
    setDetail(null);
    setDetailState('loading');
    setOpenError(false);
    try {
      const res = await fetch(
        `/api/resources/${encodeURIComponent(row.type)}/${encodeURIComponent(row.id)}`,
        { cache: 'no-store' },
      );
      // A slower response for a previously clicked row must not overwrite this one.
      if (seq !== detailSeq.current) return;
      if (!res.ok) {
        setDetailState('failed');
        return;
      }
      const body = (await res.json()) as { resource: ResourceDetail };
      if (seq !== detailSeq.current) return;
      setDetail(body.resource);
      setDetailState('done');
    } catch {
      // The list row already carries the core fields; the drawer degrades to those.
      if (seq === detailSeq.current) setDetailState('failed');
    }
  };

  const handleOpen = async () => {
    const url = detail?.detailUrl;
    if (!url || !selected) return;
    // A previous switch already failed and the warning is showing: this click is
    // the explicit "open anyway".
    if (!openError) {
      setOpening(true);
      let switched = true;
      try {
        // Project-scoped pages read the ACTIVE project, so switch first (same
        // endpoint as the project switcher).
        if (selected.projectId) {
          const res = await fetch('/api/projects/active', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: selected.projectId }),
          });
          switched = res.ok;
        }
      } catch {
        switched = false;
      }
      setOpening(false);
      if (!switched) {
        // Stay on the page so the warning is actually seen; the button now offers "open anyway".
        setOpenError(true);
        return;
      }
    }
    // Full navigation so the layout re-reads the new active project.
    window.location.assign(url);
  };

  const view = detail ?? (selected as ResourceDetail | null);
  // A bare reference whose detail failed has no status/dates to show: hide the empty rows.
  const showStubFields = !(selectedIsStub && !detail && detailState === 'failed');

  const filterProjects = [
    { value: ALL, label: t('allProjects') },
    { value: TENANT, label: t('tenantWide') },
    ...(data?.projects ?? []).map((p) => ({ value: p.id, label: p.name })),
  ];
  const filterStatuses = [
    { value: ALL, label: t('allStatuses') },
    // The selected status stays listed even if the current type/project has none of it.
    ...(status && !(data?.statuses ?? []).includes(status) ? [status] : [])
      .concat(data?.statuses ?? [])
      .map((s) => ({ value: s, label: s })),
  ];

  const selectType = (value: string) => {
    setType(value);
    setPage(1);
  };

  const navItem = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '5px 10px',
    border: 0,
    borderRadius: 6,
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 13,
    background: active ? 'var(--ds-bg-hover, rgba(128,128,128,0.15))' : 'transparent',
    color: 'inherit',
    fontWeight: active ? 600 : 400,
  });

  return (
    <Stack gap="md">
      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('loadFailed')}>
          {error}
        </Alert>
      ) : null}
      {data && data.errors.length > 0 ? (
        <Alert color="orange" icon={<IconAlertTriangle size={16} />} title={t('errorsTitle')}>
          {data.errors.map((e) => (
            <div key={e.type}>
              <strong>{typeLabel(e.type)}</strong>: {e.message}
            </div>
          ))}
        </Alert>
      ) : null}
      {data && data.truncated.length > 0 ? (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title={t('truncatedTitle')}>
          {data.truncated.map((tr) => (
            <div key={tr.type}>
              {t('truncatedBody', { type: typeLabel(tr.type), limit: tr.limit })}
            </div>
          ))}
        </Alert>
      ) : null}

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'resources')} keepMounted={false}>
        <Group justify="space-between" align="center" mb="sm">
          <Tabs.List>
            <Tabs.Tab value="resources">{t('tabResources')}</Tabs.Tab>
            <Tabs.Tab value="health">{t('tabHealth')}</Tabs.Tab>
          </Tabs.List>
          {healthSummary && (healthSummary.error > 0 || healthSummary.warning > 0) ? (
            <span className={`ds-badge ${healthSummary.error > 0 ? 'ds-badge-err' : 'ds-badge-warn'}`}>
              <span className="ds-badge-dot" />
              {t('healthSummary', { errors: healthSummary.error, warnings: healthSummary.warning })}
            </span>
          ) : healthSummary ? (
            <span className="ds-badge ds-badge-ok">
              <span className="ds-badge-dot" />
              {t('healthClean')}
            </span>
          ) : null}
        </Group>

        <Tabs.Panel value="health">
          <ResourceHealthPanel
            types={data?.types ?? []}
            reloadToken={healthReload}
            onOpen={openRef}
            onSummary={setHealthSummary}
          />
        </Tabs.Panel>

        <Tabs.Panel value="resources">
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <nav style={{ width: 230, flexShrink: 0 }} aria-label={t('title')}>
          <button type="button" style={navItem(type === ALL)} onClick={() => selectType(ALL)}>
            <span>{t('all')}</span>
            <span className="ds-muted">{totalAll}</span>
          </button>
          {grouped.map((group) => {
            const groupTotal = group.types.reduce((sum, info) => sum + (counts[info.type] ?? 0), 0);
            return (
              <div key={group.category} style={{ marginTop: 12 }}>
                <div
                  className="ds-eyebrow"
                  style={{ display: 'flex', justifyContent: 'space-between', padding: '0 10px 4px' }}
                >
                  <span>{t(`categories.${group.category}`)}</span>
                  <span>{groupTotal}</span>
                </div>
                {group.types.map((info) => (
                  <button
                    key={info.type}
                    type="button"
                    style={navItem(type === info.type)}
                    onClick={() => selectType(info.type)}
                  >
                    <span>{typeLabel(info.type)}</span>
                    <span className="ds-muted">{counts[info.type] ?? 0}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        <div style={{ flex: 1, minWidth: 320 }}>
          <DataGrid<ResourceListItem>
            records={data?.items ?? []}
            rowKey={(row) => `${row.type}:${row.id}`}
            columns={columns}
            loading={loading}
            onRowClick={(row) => void openRow(row)}
            search={{
              value: searchInput,
              onChange: setSearchInput,
              placeholder: t('searchPlaceholder'),
            }}
            filters={[
              {
                value: projectId,
                onChange: (v) => {
                  setProjectId(v);
                  setPage(1);
                },
                options: filterProjects,
                ariaLabel: t('projectFilter'),
                width: 170,
              },
              {
                value: status,
                onChange: (v) => {
                  setStatus(v);
                  setPage(1);
                },
                options: filterStatuses,
                ariaLabel: t('statusFilter'),
                width: 150,
              },
            ]}
            toolbarRight={
              <Switch
                size="xs"
                checked={onlyIssues}
                onChange={(e) => {
                  setOnlyIssues(e.currentTarget.checked);
                  setPage(1);
                }}
                label={t('onlyIssues')}
              />
            }
            onRefresh={handleRefresh}
            refreshing={loading}
            empty={{ title: t('emptyTitle'), description: t('emptyDescription') }}
            pagination={{
              page,
              onPageChange: setPage,
              pageSize,
              onPageSizeChange: (n) => {
                setPageSize(n);
                setPage(1);
              },
              pageSizeOptions: [25, 50, 100, 200],
              total: data?.total ?? 0,
              hasMore: (data?.total ?? 0) > page * pageSize,
            }}
            footerLeft={
              data && data.total > 0
                ? t('showing', {
                    from: (page - 1) * pageSize + 1,
                    to: Math.min(page * pageSize, data.total),
                    total: data.total,
                  })
                : undefined
            }
          />
        </div>
      </div>
        </Tabs.Panel>
      </Tabs>

      <Drawer
        opened={Boolean(selected)}
        onClose={() => {
          detailSeq.current++;
          setSelected(null);
          setDetail(null);
        }}
        position="right"
        size="lg"
        title={t('drawerTitle')}
      >
        {view ? (
          <Stack gap="md">
            <div>
              <Text fw={600} size="lg">{view.name}</Text>
              {view.description ? <Text size="sm" c="dimmed">{view.description}</Text> : null}
            </div>
            <Table withRowBorders={false} verticalSpacing={6}>
              <Table.Tbody>
                <Row label={t('fieldType')}>{typeLabel(view.type)}</Row>
                {view.key ? <Row label={t('fieldKey')} mono>{view.key}</Row> : null}
                <Row label={t('fieldId')} mono>{view.id}</Row>
                {view.crn ? (
                <Row label={t('fieldCrn')} mono>
                  <Group gap={6} wrap="nowrap">
                    <span style={{ wordBreak: 'break-all' }}>{view.crn}</span>
                    <CopyButton value={view.crn} timeout={1500}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? t('copied') : t('copy')} withArrow>
                          <ActionIcon variant="subtle" size="sm" onClick={copy} aria-label={t('copy')}>
                            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </Group>
                </Row>
                ) : null}
                <Row label={t('fieldProject')}>{projectName(view)}</Row>
                {showStubFields ? (<>
                <Row label={t('fieldStatus')}>
                  {view.status ? (
                    <span className={`ds-badge ${TONE_CLASS[view.statusTone] ?? ''}`}>
                      <span className="ds-badge-dot" />
                      {view.status}
                    </span>
                  ) : (
                    '—'
                  )}
                </Row>
                <Row label={t('fieldCreated')}>
                  {formatDate(view.createdAt)}
                  {view.createdByLabel ? ` · ${t('by', { name: view.createdByLabel })}` : ''}
                </Row>
                <Row label={t('fieldUpdated')}>
                  {formatDate(view.updatedAt)}
                  {detail?.updatedByLabel ? ` · ${t('by', { name: detail.updatedByLabel })}` : ''}
                </Row>
                </>) : null}
              </Table.Tbody>
            </Table>

            <div>
              <Text fw={600} size="sm" mb={4}>{t('attributes')}</Text>
              {detail && detail.attributes.length > 0 ? (
                <Table withRowBorders verticalSpacing={4}>
                  <Table.Tbody>
                    {detail.attributes.map((a) => (
                      <Table.Tr key={a.key}>
                        <Table.Td w="40%"><Text size="sm" c="dimmed">{a.key}</Text></Table.Td>
                        <Table.Td><Text size="sm">{a.value === null ? '—' : String(a.value)}</Text></Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              ) : (
                detailState === 'loading' ? (
                  <Loader size="xs" />
                ) : (
                  <Text size="sm" c="dimmed">
                    {detailState === 'failed' ? t('detailFailed') : t('noAttributes')}
                  </Text>
                )
              )}
            </div>

            {detail?.issues && detail.issues.length > 0 ? (
              <div>
                <Text fw={600} size="sm" mb={4}>{t('drawerIssues')}</Text>
                <Stack gap={6}>
                  {detail.issues.map((issue) => (
                    <div
                      key={issue.id}
                      style={{
                        border: '1px solid var(--ds-border, rgba(128,128,128,0.25))',
                        borderRadius: 8,
                        padding: '8px 10px',
                      }}
                    >
                      <Group gap={8} wrap="nowrap" align="flex-start">
                        <SeverityBadge severity={issue.severity} />
                        <div>
                          <Text size="sm" fw={500}>{t(`health.kind.${issue.kind}`)}</Text>
                          <Text size="xs" c="dimmed">{explainIssue(t, issue)}</Text>
                          {issue.targetKey ? (
                            <Text size="xs" c="dimmed" style={{ fontFamily: 'var(--ds-font-mono, monospace)' }}>
                              {issue.targetKey}
                            </Text>
                          ) : null}
                        </div>
                      </Group>
                    </div>
                  ))}
                </Stack>
              </div>
            ) : null}

            {detail ? (
              <ResourceUsagePanel uses={detail.uses} usedBy={detail.usedBy} onOpen={openRef} />
            ) : null}

            {openError ? (
              <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
                {t('openFailed')}
              </Alert>
            ) : null}
            {detail?.detailUrl ? (
              <Group>
                <Button
                  leftSection={<IconExternalLink size={16} />}
                  loading={opening}
                  onClick={() => void handleOpen()}
                >
                  {openError ? t('openAnyway') : t('open')}
                </Button>
              </Group>
            ) : null}
          </Stack>
        ) : null}
      </Drawer>
    </Stack>
  );
}

function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <Table.Tr>
      <Table.Td w="28%" style={{ verticalAlign: 'top' }}>
        <Text size="sm" c="dimmed">{label}</Text>
      </Table.Td>
      <Table.Td>
        <Text
          size="sm"
          component="div"
          style={mono ? { fontFamily: 'var(--ds-font-mono, monospace)', fontSize: 12.5 } : undefined}
        >
          {children}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}
