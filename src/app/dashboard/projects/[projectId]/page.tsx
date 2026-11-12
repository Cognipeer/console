'use client';

import { Suspense, use, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFolder } from '@tabler/icons-react';
import DetailShell, { type DetailShellTab } from '@/components/common/ui/DetailShell';
import { notifyActiveProjectChanged } from '@/components/layout/useEffectivePermissions';
import LimitsTab from '@/components/projects/detail/LimitsTab';
import MembersTab from '@/components/projects/detail/MembersTab';
import OverviewTab from '@/components/projects/detail/OverviewTab';
import SettingsTab, { type ProjectSummary } from '@/components/projects/detail/SettingsTab';
import TokensTab from '@/components/projects/detail/TokensTab';
import ProjectProvidersManager from '@/components/projects/ProjectProvidersManager';
import { LAST_LIST_URL_KEY, sanitizeListUrl } from '@/components/projects/projectsListModel';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import { useProjects, useSessionRole, useSetActiveProject } from '@/lib/api/queries/projects';

const TABS = ['overview', 'members', 'providers', 'tokens', 'limits', 'settings'] as const;
type TabId = (typeof TABS)[number];

/** Old spellings of a tab that bookmarks and the Access check may still carry. */
const TAB_ALIASES: Record<string, TabId> = { users: 'members', quotas: 'limits' };

function ProjectDetail({ projectId }: { projectId: string }) {
  const t = useTranslations('projectsAccess.detail');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const projectsQuery = useProjects<ProjectSummary>();
  const setActiveProject = useSetActiveProject();
  const { data: sessionRole, isPending: sessionPending } = useSessionRole();
  const sessionLoaded = !sessionPending;
  // The id this page made active itself; until the list is read again it is the better answer.
  const [activatedId, setActivatedId] = useState<string | undefined>(undefined);
  const project = useMemo(
    () => (projectsQuery.data?.projects ?? []).find((p) => String(p._id) === String(projectId)) ?? null,
    [projectsQuery.data, projectId],
  );
  const activeProjectId = activatedId ?? projectsQuery.data?.activeProjectId;
  const loading = projectsQuery.isPending;
  const [backHref, setBackHref] = useState('/dashboard/projects');

  const isTenantAdmin = sessionRole === 'owner' || sessionRole === 'admin';
  const ready = Boolean(activeProjectId && String(activeProjectId) === String(projectId));

  // The list's own address (its search and filters), kept by the list in sessionStorage.
  useEffect(() => {
    try {
      setBackHref(sanitizeListUrl(sessionStorage.getItem(LAST_LIST_URL_KEY)));
    } catch {
      /* storage is unavailable: the plain list */
    }
  }, []);

  const tabParam = searchParams?.get('tab') ?? '';
  const tabs = useMemo<TabId[]>(() => TABS.filter((tab) => tab !== 'limits' || isTenantAdmin), [isTenantAdmin]);
  // A deep link to Limits waits for the role instead of flashing the overview first.
  const allowed = (tab: TabId) => tab !== 'limits' || isTenantAdmin || !sessionLoaded;
  // `?member=` (the Access check's link) lands on the people tab; otherwise the overview.
  const requested = (TAB_ALIASES[tabParam] ?? tabParam) as TabId;
  const activeTab: TabId = (TABS as readonly string[]).includes(requested) && allowed(requested)
    ? requested
    : searchParams?.get('member')
      ? 'members'
      : 'overview';

  const changeTab = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? '');
      next.set('tab', id);
      // A one-shot deep link belongs to the tab it opened.
      if (id !== 'members') next.delete('member');
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // The project list could not be read (first load or a refresh): say so once per failure.
  useEffect(() => {
    if (!projectsQuery.isError) return;
    notifications.show({ color: 'red', message: errorMessage(projectsQuery.error, t('loadFailed')) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsQuery.errorUpdatedAt]);

  const fetchProject = async () => {
    setActivatedId(undefined);
    await projectsQuery.refetch();
  };

  // The providers tab (and what it lists) works on the active project: make this one active.
  useEffect(() => {
    if (loading || ready || !projectId) return;
    void (async () => {
      try {
        await setActiveProject.mutateAsync(projectId);
        setActivatedId(projectId);
        // What the navigation shows depends on the active project's limits.
        notifyActiveProjectChanged();
      } catch (error) {
        notifications.show({ color: 'red', message: errorMessage(error, t('loadFailed')) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, ready, projectId, t]);

  const shellTabs: DetailShellTab[] = tabs.map((id) => ({ id, label: t(`tabs.${id}`) }));

  return (
    <DetailShell
      backHref={backHref}
      backLabel={t('backTooltip')}
      icon={<IconFolder size={16} />}
      title={<h1 className="ds-h2">{project?.name ?? t('back')}</h1>}
      meta={
        project ? (
          <>
            <span className="ds-mono">{project.key}</span>
            {ready ? <span className="ds-badge ds-badge-ok">{t('active')}</span> : null}
          </>
        ) : undefined
      }
      tabs={shellTabs}
      activeTab={activeTab}
      onTabChange={changeTab}
    >
      {activeTab === 'overview' ? <OverviewTab projectId={projectId} /> : null}
      {activeTab === 'members' ? <MembersTab projectId={projectId} projectName={project?.name} /> : null}
      {activeTab === 'providers' ? (
        ready ? (
          <ProjectProvidersManager projectId={projectId} />
        ) : (
          <Text size="sm" c="dimmed" p="md">
            {t('switching')}
          </Text>
        )
      ) : null}
      {activeTab === 'tokens' ? <TokensTab projectId={projectId} /> : null}
      {activeTab === 'limits' && isTenantAdmin ? <LimitsTab projectId={projectId} canManage /> : null}
      {activeTab === 'settings' && project ? (
        <SettingsTab project={project} canManage={isTenantAdmin} backHref={backHref} onSaved={() => void fetchProject()} />
      ) : null}
    </DetailShell>
  );
}

export default function ProjectDetailPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  return (
    <Suspense fallback={null}>
      <ProjectDetail projectId={projectId} />
    </Suspense>
  );
}
