'use client';

import { useEffect, useMemo, useState } from 'react';
import { Paper, Stack, Tabs, Text, Title, Group, ThemeIcon, Center, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFolder, IconUsers, IconPlug, IconKey } from '@tabler/icons-react';
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
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'var(--mantine-color-gray-0)',
          borderColor: 'var(--mantine-color-gray-2)',
        }}>
        <Group gap="md">
          <ThemeIcon
            size={50}
            radius="xl"
            variant="light"
            color="gray">
            <IconFolder size={26} />
          </ThemeIcon>
          <div>
            <Title order={2}>{currentProject?.name ?? 'Project Settings'}</Title>
            <Text size="sm" c="dimmed" mt={4}>
              Project settings and access control.
            </Text>
          </div>
        </Group>
      </Paper>

      <Paper radius="lg" withBorder style={{ overflow: 'hidden' }}>
        {!activeProjectId ? (
          <Center py="xl">
            {loading ? (
              <Loader size="md" color="teal" />
            ) : (
              <Stack gap="sm" align="center">
                <ThemeIcon size={60} radius="xl" variant="light" color="gray">
                  <IconFolder size={30} />
                </ThemeIcon>
                <Text size="sm" c="dimmed">
                  {projects.length
                    ? 'Select an active project to continue.'
                    : 'No projects available.'}
                </Text>
              </Stack>
            )}
          </Center>
        ) : (
          <Tabs value={activeTab} onChange={setActiveTab} variant="default">
            <Tabs.List style={{ borderBottom: '1px solid var(--mantine-color-gray-2)', padding: '0 16px' }}>
              <Tabs.Tab 
                value="users" 
                leftSection={<IconUsers size={16} />}
                style={{ padding: '16px 20px' }}>
                Users
              </Tabs.Tab>
              <Tabs.Tab 
                value="providers" 
                leftSection={<IconPlug size={16} />}
                style={{ padding: '16px 20px' }}>
                Providers
              </Tabs.Tab>
              <Tabs.Tab 
                value="tokens" 
                leftSection={<IconKey size={16} />}
                style={{ padding: '16px 20px' }}>
                Tokens
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="users" p="lg">
              <ProjectMembersManager projectId={String(activeProjectId)} readOnly={membersReadOnly} />
            </Tabs.Panel>

            <Tabs.Panel value="providers" p="lg">
              <ProjectProvidersManager projectId={String(activeProjectId)} />
            </Tabs.Panel>

            <Tabs.Panel value="tokens" p="lg">
              <TokenManagement />
            </Tabs.Panel>
          </Tabs>
        )}
      </Paper>
    </Stack>
  );
}
