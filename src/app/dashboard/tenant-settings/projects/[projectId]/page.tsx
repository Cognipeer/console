'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Paper, Stack, Tabs, Text } from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import { notifications } from '@mantine/notifications';
import { IconRefresh, IconUsers } from '@tabler/icons-react';
import ProjectMembersManager from '@/components/projects/ProjectMembersManager';
import ProjectProvidersManager from '@/components/projects/ProjectProvidersManager';
import TokenManagement from '@/components/settings/TokenManagement';
import QuotaManagement from '@/components/settings/QuotaManagement';

type Project = {
  _id: string;
  name: string;
  key: string;
};

export default function TenantProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const [activeTab, setActiveTab] = useState<string | null>('users');
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const currentProject = useMemo(() => {
    return projects.find((p) => String(p._id) === String(projectId));
  }, [projects, projectId]);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load projects');
      }
      const data = (await res.json()) as { projects?: Project[] };
      setProjects(data.projects ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load projects';
      notifications.show({ title: 'Project', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects, projectId]);

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconUsers size={18} />}
        title={currentProject?.name ?? 'Project'}
        subtitle="Project settings."
        actions={
          <Button
            variant="light"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={() => void fetchProjects()}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      <Paper shadow="sm" radius="md" withBorder>
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="users">Users</Tabs.Tab>
            <Tabs.Tab value="providers">Providers</Tabs.Tab>
            <Tabs.Tab value="tokens">Tokens</Tabs.Tab>
            <Tabs.Tab value="quotas">Quotas</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="users" pt="md">
            <ProjectMembersManager projectId={projectId} />
          </Tabs.Panel>

          <Tabs.Panel value="providers" pt="md">
            <ProjectProvidersManager projectId={projectId} />
          </Tabs.Panel>

          <Tabs.Panel value="tokens" pt="md">
            <TokenManagement projectId={projectId} />
          </Tabs.Panel>

          <Tabs.Panel value="quotas" pt="md">
            <QuotaManagement projectId={projectId} />
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}
