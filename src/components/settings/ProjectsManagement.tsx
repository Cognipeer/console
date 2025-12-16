'use client';

import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Group, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';

type Project = {
  _id: string;
  name: string;
  key: string;
  description?: string;
  createdAt?: string;
};

export default function ProjectsManagement() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [createOpened, setCreateOpened] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');

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
      notifications.show({ title: 'Projects', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const rows = useMemo(() => projects ?? [], [projects]);

  const resetForm = () => {
    setName('');
    setKey('');
    setDescription('');
  };

  const handleCreate = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, key: key || undefined, description: description || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to create project');
      }

      notifications.show({ title: 'Projects', message: 'Project created', color: 'green' });
      setCreateOpened(false);
      resetForm();
      await fetchProjects();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create project';
      notifications.show({ title: 'Projects', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetActive = async (projectId: string) => {
    if (!projectId || projectId === activeProjectId) return;
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
      const message = error instanceof Error ? error.message : 'Failed to set active project';
      notifications.show({ title: 'Projects', message, color: 'red' });
    }
  };

  const handleManage = (projectId: string) => {
    if (!projectId) return;
    window.location.assign(`/dashboard/tenant-settings/projects/${encodeURIComponent(projectId)}`);
  };

  return (
    <Box p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Text size="lg" fw={600}>
            Projects
          </Text>
          <Text size="sm" c="dimmed">
            Create and switch projects.
          </Text>
        </div>
        <Button onClick={() => setCreateOpened(true)}>Add Project</Button>
      </Group>

      <DataTable
        withTableBorder
        borderRadius="sm"
        striped
        highlightOnHover
        records={rows}
        fetching={loading}
        minHeight={200}
        noRecordsText="No projects"
        columns={[
          {
            accessor: 'name',
            title: 'Name',
            render: (project) => (
              <div>
                <Text size="sm" fw={500}>
                  {project.name}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace">
                  {project.key}
                </Text>
              </div>
            ),
          },
          {
            accessor: 'description',
            title: 'Description',
            render: (project) => (
              <Text size="sm" c={project.description ? undefined : 'dimmed'}>
                {project.description || '—'}
              </Text>
            ),
          },
          {
            accessor: 'actions',
            title: 'Actions',
            textAlign: 'right',
            render: (project) => (
              <Group gap="xs" justify="flex-end">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => handleManage(String(project._id))}
                >
                  Manage
                </Button>
                <Button
                  size="xs"
                  variant={String(project._id) === String(activeProjectId) ? 'filled' : 'light'}
                  onClick={() => handleSetActive(String(project._id))}
                  disabled={String(project._id) === String(activeProjectId)}
                >
                  {String(project._id) === String(activeProjectId) ? 'Active' : 'Set active'}
                </Button>
              </Group>
            ),
          },
        ]}
      />

      <Modal
        opened={createOpened}
        onClose={() => {
          if (submitting) return;
          setCreateOpened(false);
        }}
        title="Create project"
        size="md"
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
          />
          <TextInput
            label="Key (optional)"
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            placeholder="auto-generated if empty"
          />
          <Textarea
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            minRows={3}
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                if (submitting) return;
                setCreateOpened(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} loading={submitting}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
