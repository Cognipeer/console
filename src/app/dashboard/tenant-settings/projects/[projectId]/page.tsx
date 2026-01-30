'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
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
                Project settings.
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
