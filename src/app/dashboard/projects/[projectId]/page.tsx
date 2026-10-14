'use client';

import { Suspense, use, useEffect, useMemo, useState } from 'react';
import { Button, Paper, Tabs, Text } from '@mantine/core';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconRefresh } from '@tabler/icons-react';
import { useRouter, useSearchParams } from 'next/navigation';
import ProjectMembersManager from '@/components/projects/ProjectMembersManager';
import ProjectProvidersManager from '@/components/projects/ProjectProvidersManager';
import QuotaManagement from '@/components/settings/QuotaManagement';
import { notifyActiveProjectChanged } from '@/components/layout/useEffectivePermissions';

type Project = {
  _id: string;
  name: string;
  key: string;
};

/**
 * The Users tab. `?member=<userId>` opens that member's project permission editor
 * (the Access check links here from "Project limit" reasons).
 */
function ProjectMembers({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const param = searchParams?.get('member') ?? null;
  // Kept after the address is cleaned up below, until the editor has been opened.
  const [memberId, setMemberId] = useState<string | null>(param);
  useEffect(() => {
    if (!param) return;
    setMemberId(param);
    // A one-shot link: drop it from the address so a refresh does not reopen the editor.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('member');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* the History API is unavailable (embedded frame): the link just stays */
    }
  }, [param]);
  return <ProjectMembersManager projectId={projectId} openMemberId={memberId} />;
}

export default function ProjectDetailPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string | null>('users');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [sessionRole, setSessionRole] = useState<string | undefined>(undefined);

  const ready = Boolean(activeProjectId && String(activeProjectId) === String(projectId));
  const isTenantAdmin = sessionRole === 'owner' || sessionRole === 'admin';

  const currentProject = useMemo(() => {
    const found = projects.find((p) => String(p._id) === String(projectId));
    return found;
  }, [projects, projectId]);

  const fetchProjects = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load projects');
      }
      const data = (await res.json()) as { projects?: Project[]; activeProjectId?: string };
      setProjects(data.projects ?? []);
      setActiveProjectId(data.activeProjectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load projects';
      notifications.show({ title: 'Project', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const ensureActiveProject = async () => {
    if (!projectId) return;
    if (activeProjectId && String(activeProjectId) === String(projectId)) return;

    try {
      const res = await fetch('/api/projects/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to set active project');
      }
      setActiveProjectId(projectId);
      // What the navigation shows depends on the active project's limits.
      notifyActiveProjectChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set active project';
      notifications.show({ title: 'Project', message, color: 'red' });
    }
  };

  const fetchSession = async () => {
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { role?: string };
      setSessionRole(data.role);
    } catch {
      setSessionRole(undefined);
    }
  };

  useEffect(() => {
    void fetchProjects();
    void fetchSession();
  }, []);

  useEffect(() => {
    if (!loading) {
      ensureActiveProject();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeProjectId, projectId]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · Project"
        title={currentProject?.name ?? 'Project'}
        subtitle="Project access, providers, and quotas."
        actions={
          <>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/projects')}
            >
              Back
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              onClick={() => void fetchProjects()}
              loading={loading}
            >
              Refresh
            </Button>
          </>
        }
      />

      <Paper shadow="sm" radius="md" withBorder>
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="users">Users</Tabs.Tab>
            <Tabs.Tab value="providers">Providers</Tabs.Tab>
            {isTenantAdmin ? <Tabs.Tab value="quotas">Quotas</Tabs.Tab> : null}
          </Tabs.List>

          <Tabs.Panel value="users" pt="md">
            <Suspense fallback={null}>
              <ProjectMembers projectId={projectId} />
            </Suspense>
          </Tabs.Panel>

          <Tabs.Panel value="providers" pt="md">
            {ready ? (
              <ProjectProvidersManager projectId={projectId} />
            ) : (
              <Text size="sm" c="dimmed" p="md">
                Switching active project…
              </Text>
            )}
          </Tabs.Panel>

          {isTenantAdmin ? (
            <Tabs.Panel value="quotas" pt="md">
              {ready ? (
                <QuotaManagement projectId={projectId} />
              ) : (
                <Text size="sm" c="dimmed" p="md">
                  Switching active project…
                </Text>
              )}
            </Tabs.Panel>
          ) : null}
        </Tabs>
      </Paper>
    </PageContainer>
  );
}
