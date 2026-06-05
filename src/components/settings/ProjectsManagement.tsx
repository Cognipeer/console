'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconEdit, IconPlus, IconStar, IconTrash } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

type Project = {
  _id: string;
  name: string;
  key: string;
  description?: string;
  createdAt?: string;
};

export default function ProjectsManagement() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [sessionRole, setSessionRole] = useState<string | undefined>(undefined);
  const [createOpened, setCreateOpened] = useState(false);
  const [editOpened, setEditOpened] = useState(false);
  const [deleteOpened, setDeleteOpened] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [query, setQuery] = useState('');
  const isTenantAdmin = sessionRole === 'owner' || sessionRole === 'admin';

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
    void fetchProjects();
  }, []);

  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { role?: string };
        setSessionRole(data.role);
      } catch {
        setSessionRole(undefined);
      }
    }

    void fetchSession();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((project) =>
      [project.name, project.key, project.description]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [projects, query]);

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
      await fetchProjects();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set active project';
      notifications.show({ title: 'Projects', message, color: 'red' });
    }
  };

  const handleManage = (projectId: string) => {
    if (!projectId) return;
    router.push(`/dashboard/projects/${encodeURIComponent(projectId)}`);
  };

  const openEditModal = (project: Project) => {
    setEditingProject(project);
    setName(project.name);
    setDescription(project.description || '');
    setEditOpened(true);
  };

  const handleEdit = async () => {
    if (submitting || !editingProject) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(String(editingProject._id))}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to update project');
      }

      notifications.show({ title: 'Projects', message: 'Project updated', color: 'green' });
      setEditOpened(false);
      setEditingProject(null);
      resetForm();
      await fetchProjects();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update project';
      notifications.show({ title: 'Projects', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const openDeleteModal = (project: Project) => {
    setDeletingProject(project);
    setDeleteOpened(true);
  };

  const handleDelete = async () => {
    if (submitting || !deletingProject) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(String(deletingProject._id))}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to delete project');
      }

      notifications.show({ title: 'Projects', message: 'Project deleted', color: 'green' });
      setDeleteOpened(false);
      setDeletingProject(null);
      await fetchProjects();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete project';
      notifications.show({ title: 'Projects', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const columns: DataGridColumn<Project>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (project) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{project.name}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{project.key}</span>
        </div>
      ),
    },
    {
      key: 'description',
      label: 'Description',
      render: (project) => (
        <Text size="sm" c={project.description ? undefined : 'dimmed'}>
          {project.description || '—'}
        </Text>
      ),
    },
    {
      key: 'active',
      label: 'Status',
      width: 110,
      render: (project) =>
        String(project._id) === String(activeProjectId) ? (
          <span className="ds-badge ds-badge-ok">
            <span className="ds-badge-dot" />
            Active
          </span>
        ) : (
          <span className="ds-faint" style={{ fontSize: 12 }}>—</span>
        ),
    },
  ];

  return (
    <>
      <DataGrid<Project>
        records={filtered}
        loading={loading}
        rowKey={(p) => String(p._id)}
        onRowClick={(p) => handleManage(String(p._id))}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search projects',
        }}
        onRefresh={() => void fetchProjects()}
        refreshing={loading}
        toolbarRight={
          isTenantAdmin ? (
            <Button
              color="teal"
              size="xs"
              leftSection={<IconPlus size={13} stroke={1.7} />}
              onClick={() => setCreateOpened(true)}
            >
              Add project
            </Button>
          ) : undefined
        }
        empty={{
          title: 'No projects',
          description: isTenantAdmin
            ? 'Create a project to organize your team and resources.'
            : 'You do not have access to any projects yet.',
          primaryAction: isTenantAdmin
            ? {
                label: 'Add project',
                icon: <IconPlus size={14} stroke={1.7} />,
                onClick: () => setCreateOpened(true),
              }
            : undefined,
        }}
        footerLeft={`Showing ${filtered.length} of ${projects.length} projects`}
        rowActions={(project) => [
          {
            id: 'manage',
            label: isTenantAdmin ? 'Manage' : 'Open',
            onClick: () => handleManage(String(project._id)),
          },
          {
            id: 'set-active',
            label:
              String(project._id) === String(activeProjectId) ? 'Already active' : 'Set active',
            icon: <IconStar size={14} />,
            onClick: () => handleSetActive(String(project._id)),
            disabled: String(project._id) === String(activeProjectId),
          },
          ...(isTenantAdmin
            ? [
                {
                  id: 'edit',
                  label: 'Edit',
                  icon: <IconEdit size={14} />,
                  onClick: () => openEditModal(project),
                },
              ]
            : []),
          ...(isTenantAdmin && project.key !== 'default'
            ? [
                {
                  id: 'delete',
                  label: 'Delete',
                  icon: <IconTrash size={14} />,
                  color: 'red' as const,
                  onClick: () => openDeleteModal(project),
                },
              ]
            : []),
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

      {/* Edit modal */}
      <Modal
        opened={editOpened}
        onClose={() => {
          if (submitting) return;
          setEditOpened(false);
          setEditingProject(null);
        }}
        title="Edit project"
        size="md"
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
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
                setEditOpened(false);
                setEditingProject(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleEdit} loading={submitting}>
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        opened={deleteOpened}
        onClose={() => {
          if (submitting) return;
          setDeleteOpened(false);
          setDeletingProject(null);
        }}
        title="Delete project"
        size="sm"
      >
        <Stack gap="sm">
          <Text size="sm">
            Are you sure you want to delete{' '}
            <Text span fw={600}>{deletingProject?.name}</Text>? This action cannot be undone.
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                if (submitting) return;
                setDeleteOpened(false);
                setDeletingProject(null);
              }}
            >
              Cancel
            </Button>
            <Button color="red" onClick={handleDelete} loading={submitting}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
