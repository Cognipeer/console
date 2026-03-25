'use client';

import { useMemo, useState } from 'react';
import { Group, Select, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';

type Project = {
  _id: string;
  name: string;
  key: string;
};

export default function ProjectSelector() {
  const [submitting, setSubmitting] = useState(false);

  const projectsQuery = useQuery<{ projects: Project[]; activeProjectId?: string }>(
    {
      queryKey: ['projects'],
      queryFn: async () => {
        const res = await fetch('/api/projects', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error('Failed to load projects');
        }
        return (await res.json()) as { projects: Project[]; activeProjectId?: string };
      },
      refetchOnMount: 'always',
    },
  );

  const options = useMemo(() => {
    const projects = projectsQuery.data?.projects ?? [];
    return projects
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ value: project._id, label: project.name }));
  }, [projectsQuery.data?.projects]);

  const active = projectsQuery.data?.activeProjectId;
  const loading = projectsQuery.isLoading;
  const errorMessage = projectsQuery.isError
    ? (projectsQuery.error instanceof Error
        ? projectsQuery.error.message
        : 'Failed to load projects')
    : undefined;

  const handleChange = async (value: string | null) => {
    if (!value || value === active) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/projects/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to set active project');
      }

      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      notifications.show({
        title: 'Project',
        message,
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Group gap="xs" wrap="nowrap">
      <Select
        w={{ base: 140, sm: 220 }}
        data={options}
        value={active ?? null}
        onChange={handleChange}
        disabled={submitting || loading || Boolean(errorMessage) || options.length <= 1}
        searchable
        placeholder={errorMessage ? 'Projects unavailable' : loading ? 'Loading…' : 'Select project'}
        comboboxProps={{ withinPortal: true }}
      />
      {errorMessage ? (
        <Text size="xs" c="red">
          {errorMessage}
        </Text>
      ) : null}
    </Group>
  );
}
