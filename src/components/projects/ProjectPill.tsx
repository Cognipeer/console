'use client';

import { useMemo, useState } from 'react';
import { Loader, Menu, Text, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';

type Project = {
  _id: string;
  name: string;
  key: string;
};

export default function ProjectPill() {
  const [submitting, setSubmitting] = useState(false);

  const projectsQuery = useQuery<{ projects: Project[]; activeProjectId?: string }>(
    {
      queryKey: ['projects'],
      queryFn: async () => {
        const res = await fetch('/api/projects', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load projects');
        return (await res.json()) as { projects: Project[]; activeProjectId?: string };
      },
      refetchOnMount: 'always',
    },
  );

  const projects = useMemo(() => {
    return (projectsQuery.data?.projects ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projectsQuery.data?.projects]);

  const activeId = projectsQuery.data?.activeProjectId;
  const activeProject = projects.find((p) => p._id === activeId);
  const loading = projectsQuery.isLoading;
  const errorMessage = projectsQuery.isError
    ? projectsQuery.error instanceof Error
      ? projectsQuery.error.message
      : 'Failed to load projects'
    : undefined;

  const handleSwitch = async (projectId: string) => {
    if (!projectId || projectId === activeId) return;
    setSubmitting(true);
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
      window.location.reload();
    } catch (error) {
      notifications.show({
        title: 'Project',
        message: error instanceof Error ? error.message : 'Unexpected error',
        color: 'red',
      });
      setSubmitting(false);
    }
  };

  if (errorMessage) {
    return (
      <Text size="xs" c="red" px="sm">
        {errorMessage}
      </Text>
    );
  }

  return (
    <Menu
      position="bottom-end"
      shadow="md"
      width={240}
      withinPortal
      disabled={loading || submitting || projects.length === 0}
    >
      <Menu.Target>
        <UnstyledButton className="ds-project-pill" aria-label="Switch project">
          <span className="ds-project-dot" aria-hidden="true" />
          <span className="ds-project-label">
            {loading ? 'Loading…' : activeProject?.name ?? 'Default Project'}
          </span>
          {submitting ? (
            <Loader size={12} color="teal" />
          ) : (
            <IconChevronDown size={13} stroke={1.7} />
          )}
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Switch project</Menu.Label>
        {projects.map((p) => (
          <Menu.Item
            key={p._id}
            onClick={() => void handleSwitch(p._id)}
            rightSection={
              p._id === activeId ? (
                <IconCheck size={13} stroke={2} color="var(--ds-accent)" />
              ) : null
            }
          >
            <Text size="sm" fw={p._id === activeId ? 600 : 400}>
              {p.name}
            </Text>
            <Text size="xs" c="dimmed" className="ds-mono">
              {p.key}
            </Text>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
