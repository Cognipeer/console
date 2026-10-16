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

const TABS = ['overview', 'members', 'providers', 'tokens', 'limits', 'settings'] as const;
type TabId = (typeof TABS)[number];

/** Old spellings of a tab that bookmarks and the Access check may still carry. */
const TAB_ALIASES: Record<string, TabId> = { users: 'members', quotas: 'limits' };

function ProjectDetail({ projectId }: { projectId: string }) {
  const t = useTranslations('projectsAccess.detail');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [sessionRole, setSessionRole] = useState<string | undefined>(undefined);
  const [sessionLoaded, setSessionLoaded] = useState(false);
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

  const fetchProject = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || t('loadFailed'));
      }
      const data = (await res.json()) as { projects?: ProjectSummary[]; activeProjectId?: string };
      setProject((data.projects ?? []).find((p) => String(p._id) === String(projectId)) ?? null);
      setActiveProjectId(data.activeProjectId);
    } catch (error) {
      notifications.show({ color: 'red', message: error instanceof Error ? error.message : t('loadFailed') });
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void fetchProject();
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as { role?: string }) : null))
      .then((data) => setSessionRole(data?.role))
      .catch(() => setSessionRole(undefined))
      .finally(() => setSessionLoaded(true));
  }, [fetchProject]);

  // The providers tab (and what it lists) works on the active project: make this one active.
  useEffect(() => {
    if (loading || ready || !projectId) return;
    void (async () => {
      try {
        const res = await fetch('/api/projects/active', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || t('loadFailed'));
        }
        setActiveProjectId(projectId);
        // What the navigation shows depends on the active project's limits.
        notifyActiveProjectChanged();
      } catch (error) {
        notifications.show({ color: 'red', message: error instanceof Error ? error.message : t('loadFailed') });
      }
    })();
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
