'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconPlus, IconStar, IconUserPlus, IconServer } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { notifyActiveProjectChanged } from '@/components/layout/useEffectivePermissions';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import { useProjects, useSessionRole, useSetActiveProject } from '@/lib/api/queries/projects';
import CreateProjectShell from './CreateProjectShell';
import {
  LAST_LIST_URL_KEY,
  QUICK_FILTERS,
  filterProjectRows,
  parseProjectFilters,
  parseProjectRows,
  projectFiltersToSearch,
  providerBreakdown,
  quickFilterCounts,
  toggleQuickFilter,
  type ProjectListFilters,
  type ProjectListRow,
  type QuickFilter,
} from './projectsListModel';

const LIST_PATH = '/dashboard/projects';

export default function ProjectsList() {
  const t = useTranslations('projectsAccess.list');
  const tDomains = useTranslations('projectsAccess.domains');
  const tRoles = useTranslations('projectsAccess.roles');
  const router = useRouter();
  const pathname = usePathname() ?? LIST_PATH;
  const searchParams = useSearchParams();

  const projectsQuery = useProjects<unknown>({ stats: true });
  const setActiveProject = useSetActiveProject();
  const { data: sessionRole } = useSessionRole();
  const rows = useMemo(() => parseProjectRows(projectsQuery.data), [projectsQuery.data]);
  const activeProjectId = projectsQuery.data?.activeProjectId;
  const loading = projectsQuery.isPending;
  const error = projectsQuery.isError ? errorMessage(projectsQuery.error, t('loadFailed')) : null;
  const [createOpen, setCreateOpen] = useState(false);
  const isTenantAdmin = sessionRole === 'owner' || sessionRole === 'admin';

  // The view lives in the address (?q=&f=), so a refresh, a shared link and the detail page's back link restore it.
  const filters = useMemo(() => parseProjectFilters(searchParams ?? new URLSearchParams()), [searchParams]);
  const search = searchParams?.toString() ?? '';
  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_LIST_URL_KEY, search ? `${pathname}?${search}` : pathname);
    } catch {
      /* storage is unavailable: the back link falls back to the plain list */
    }
  }, [pathname, search]);

  const setFilters = useCallback(
    (next: ProjectListFilters) => {
      const qs = projectFiltersToSearch(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const load = async () => {
    await projectsQuery.refetch();
  };

  const filtered = useMemo(() => filterProjectRows(rows, filters), [rows, filters]);
  const counts = useMemo(() => quickFilterCounts(rows), [rows]);

  const open = (id: string, tab?: string) =>
    router.push(`${LIST_PATH}/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ''}`);

  const setActive = async (id: string) => {
    if (id === activeProjectId) return;
    try {
      await setActiveProject.mutateAsync(id);
      router.refresh();
      // What the navigation shows depends on the active project's limits.
      notifyActiveProjectChanged();
    } catch (err) {
      notifications.show({ color: 'red', message: errorMessage(err, t('setActiveFailed')) });
    }
  };

  const columns: DataGridColumn<ProjectListRow>[] = [
    {
      key: 'project',
      label: t('columns.project'),
      render: (project) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <div className="ds-badge-cluster">
            <span style={{ fontSize: 13, fontWeight: 500 }}>{project.name}</span>
            {project.directoryDefault.length > 0 ? (
              <Tooltip
                multiline
                w={260}
                label={project.directoryDefault
                  .map((rule) =>
                    t('directoryHint', { source: rule.label || t(`sources.${rule.source}`), role: tRoles(rule.role) }),
                  )
                  .join(' ')}
              >
                <span className="ds-badge ds-badge-info">
                  {project.directoryDefault.some((r) => r.source === 'oidc') ? t('ssoDefault') : t('ldapDefault')}
                </span>
              </Tooltip>
            ) : null}
          </div>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {project.key}
          </span>
        </div>
      ),
    },
    {
      key: 'people',
      label: t('columns.people'),
      width: 190,
      render: (project) =>
        project.stats.people === 0 ? (
          <span className="ds-badge ds-badge-warn">{t('noPeople')}</span>
        ) : (
          <div className="ds-col" style={{ gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{project.stats.people}</span>
            <span className="ds-faint" style={{ fontSize: 11 }}>
              {t('peopleDetail', { direct: project.stats.members, groups: project.stats.groups })}
            </span>
          </div>
        ),
    },
    {
      key: 'providers',
      label: t('columns.providers'),
      width: 240,
      render: (project) =>
        project.stats.providers === 0 ? (
          <span className="ds-badge ds-badge-warn">{t('noProvider')}</span>
        ) : (
          <div className="ds-badge-cluster">
            {providerBreakdown(project).map(([domain, count]) => (
              <span key={domain} className="ds-badge">
                {tryDomain(tDomains, domain)} {count}
              </span>
            ))}
          </div>
        ),
    },
    { key: 'agents', label: t('columns.agents'), width: 80, align: 'right', render: (p) => p.stats.agents },
    { key: 'tokens', label: t('columns.tokens'), width: 80, align: 'right', render: (p) => p.stats.tokens },
    {
      key: 'status',
      label: t('columns.status'),
      width: 100,
      render: (project) =>
        project._id === activeProjectId ? (
          <span className="ds-badge ds-badge-ok">
            <span className="ds-badge-dot" />
            {t('active')}
          </span>
        ) : (
          <span className="ds-faint" style={{ fontSize: 12 }}>
            —
          </span>
        ),
    },
  ];

  return (
    <>
      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('loadFailed')} mb="sm">
          {error}
        </Alert>
      ) : null}
      <DataGrid<ProjectListRow>
        records={filtered}
        loading={loading}
        rowKey={(p) => p._id}
        onRowClick={(p) => open(p._id)}
        columns={columns}
        search={{
          value: filters.query,
          onChange: (query) => setFilters({ ...filters, query }),
          placeholder: t('searchPlaceholder'),
        }}
        onRefresh={() => void load()}
        refreshing={projectsQuery.isFetching}
        toolbarRight={
          <>
            <div className="ds-row ds-gap-sm" role="group" aria-label={t('quickFilters')}>
              {QUICK_FILTERS.map((name: QuickFilter) => (
                <Button
                  key={name}
                  size="xs"
                  variant={filters.quick.has(name) ? 'light' : 'default'}
                  color={filters.quick.has(name) ? 'teal' : undefined}
                  aria-pressed={filters.quick.has(name)}
                  onClick={() => setFilters(toggleQuickFilter(filters, name))}
                >
                  {t(`filters.${name}`)} · {counts[name]}
                </Button>
              ))}
            </div>
            {isTenantAdmin ? (
              <Button color="teal" size="xs" leftSection={<IconPlus size={13} stroke={1.7} />} onClick={() => setCreateOpen(true)}>
                {t('newProject')}
              </Button>
            ) : null}
          </>
        }
        empty={{
          title: rows.length > 0 ? t('noMatches') : t('emptyTitle'),
          description: rows.length > 0 ? undefined : isTenantAdmin ? t('emptyAdmin') : t('emptyMember'),
          primaryAction:
            rows.length === 0 && isTenantAdmin
              ? { label: t('newProject'), icon: <IconPlus size={14} stroke={1.7} />, onClick: () => setCreateOpen(true) }
              : undefined,
        }}
        footerLeft={t('footer', { shown: filtered.length, total: rows.length })}
        rowActions={(project) => [
          { id: 'open', label: project.canManage ? t('actions.manage') : t('actions.open'), onClick: () => open(project._id) },
          {
            id: 'assign-provider',
            label: t('actions.assignProvider'),
            icon: <IconServer size={14} />,
            hidden: !project.canManage,
            onClick: () => open(project._id, 'providers'),
          },
          {
            id: 'add-people',
            label: t('actions.addPeople'),
            icon: <IconUserPlus size={14} />,
            hidden: !project.canManage,
            onClick: () => open(project._id, 'members'),
          },
          {
            id: 'set-active',
            label: project._id === activeProjectId ? t('actions.alreadyActive') : t('actions.setActive'),
            icon: <IconStar size={14} />,
            disabled: project._id === activeProjectId,
            onClick: () => void setActive(project._id),
          },
        ]}
      />

      {isTenantAdmin ? (
        <CreateProjectShell
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            open(id);
          }}
        />
      ) : null}
    </>
  );
}

/** A domain's display name, falling back to the raw key for a domain the translations do not know yet. */
function tryDomain(tDomains: (key: string) => string, domain: string): string {
  const label = tDomains(domain);
  return label === `projectsAccess.domains.${domain}` || label.endsWith(`.${domain}`) ? domain : label;
}
