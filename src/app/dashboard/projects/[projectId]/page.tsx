'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { Button, Group, Paper, Stack, Tabs, Text, ThemeIcon, Title } from '@mantine/core';
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

export default function ProjectDetailPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [activeTab, setActiveTab] = useState<string | null>('users');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const ready = Boolean(activeProjectId && String(activeProjectId) === String(projectId));

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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set active project';
      notifications.show({ title: 'Project', message, color: 'red' });
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  useEffect(() => {
    if (!loading) {
      ensureActiveProject();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeProjectId, projectId]);

  return (
    <Stack gap="md">
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-cyan-0) 0%, var(--mantine-color-blue-0) 100%)',
          borderColor: 'var(--mantine-color-cyan-2)',
        }}
      >
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'cyan', to: 'blue', deg: 135 }}
            >
              <IconUsers size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>{currentProject?.name ?? 'Project'}</Title>
              <Text size="sm" c="dimmed" mt={4}>
                Project settings and access control.
              </Text>
            </div>
          </Group>

          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            onClick={() => void fetchProjects()}
            loading={loading}
          >
            Refresh
          </Button>
        </Group>
      </Paper>

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
            {ready ? (
              <ProjectProvidersManager projectId={projectId} />
            ) : (
              <Text size="sm" c="dimmed" p="md">
                Switching active project…
              </Text>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="tokens" pt="md">
            {ready ? (
              <TokenManagement />
            ) : (
              <Text size="sm" c="dimmed" p="md">
                Switching active project…
              </Text>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="quotas" pt="md">
            {ready ? (
              <QuotaManagement projectId={projectId} />
            ) : (
              <Text size="sm" c="dimmed" p="md">
                Switching active project…
              </Text>
            )}
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}
