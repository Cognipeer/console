'use client';

import { useEffect, useMemo, useState } from 'react';
import { Paper, Stack, Tabs, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import ProjectMembersManager from '@/components/projects/ProjectMembersManager';
import ProjectProvidersManager from '@/components/projects/ProjectProvidersManager';
import TokenManagement from '@/components/settings/TokenManagement';

type Project = {
  _id: string;
  name: string;
  key: string;
};

export default function ProjectSettingsPage() {
  const [activeTab, setActiveTab] = useState<string | null>('users');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | undefined>(undefined);

  const currentProject = useMemo(() => {
    if (!activeProjectId) return undefined;
    return projects.find((p) => String(p._id) === String(activeProjectId));
  }, [projects, activeProjectId]);

  const membersReadOnly = role !== 'owner' && role !== 'admin' && role !== 'project_admin';

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
      notifications.show({ title: 'Settings', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const fetchSession = async () => {
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { role?: string };
      setRole(data.role);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchProjects();
    fetchSession();
  }, []);

  return (
    <Stack gap="md">
      <div>
        <Title order={2}>{currentProject?.name ?? 'Settings'}</Title>
        <Text size="sm" c="dimmed" mt={4}>
          Project settings and access control.
        </Text>
      </div>

      <Paper shadow="sm" radius="md" withBorder>
        {!activeProjectId ? (
          <Text size="sm" c="dimmed" p="md">
            {loading
              ? 'Loading…'
              : projects.length
                ? 'Select an active project to continue.'
                : 'No projects available.'}
          </Text>
        ) : (
          <Tabs value={activeTab} onChange={setActiveTab}>
            <Tabs.List>
              <Tabs.Tab value="users">Users</Tabs.Tab>
              <Tabs.Tab value="providers">Providers</Tabs.Tab>
              <Tabs.Tab value="tokens">Tokens</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="users" pt="md">
              <ProjectMembersManager projectId={String(activeProjectId)} readOnly={membersReadOnly} />
            </Tabs.Panel>

            <Tabs.Panel value="providers" pt="md">
              <ProjectProvidersManager projectId={String(activeProjectId)} />
            </Tabs.Panel>

            <Tabs.Panel value="tokens" pt="md">
              <TokenManagement />
            </Tabs.Panel>
          </Tabs>
        )}
      </Paper>
    </Stack>
  );
}
