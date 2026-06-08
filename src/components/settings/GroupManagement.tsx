'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Group, Modal, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconFolders, IconPlus, IconShieldCheck, IconTrash, IconUsers } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { PermissionService, ServicePermissionLevel, UserServicePermissions } from '@/lib/security/rbac';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

interface GroupRow {
  _id: string;
  name: string;
  description: string | null;
  tenantRole: 'admin' | 'project_admin' | 'user' | null;
  servicePermissions?: UserServicePermissions;
  source: 'local' | 'ldap';
  memberCount?: number;
  projectCount?: number;
}

interface GroupMember {
  userId: string;
  name: string | null;
  email: string | null;
  role: 'admin' | 'member';
  source: 'local' | 'ldap';
}

interface GroupProjectAssignment {
  projectId: string;
  role: 'member' | 'project_admin';
  servicePermissions: UserServicePermissions;
}

interface TenantUser {
  _id: string;
  name: string;
  email: string;
}

interface ProjectOption {
  _id: string;
  name: string;
}

interface PermissionServiceOption {
  id: PermissionService;
  label: string;
  description: string;
  category: string;
  adminService?: boolean;
}

const TENANT_ROLE_OPTIONS = [
  { value: '', label: 'No tenant role (project access only)' },
  { value: 'user', label: 'User' },
  { value: 'project_admin', label: 'Project Admin' },
  { value: 'admin', label: 'Admin' },
];

export default function GroupManagement() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [permissionServices, setPermissionServices] = useState<PermissionServiceOption[]>([]);

  // Create/edit
  const [editorOpened, setEditorOpened] = useState(false);
  const [editing, setEditing] = useState<GroupRow | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [tenantRoleDraft, setTenantRoleDraft] = useState('');
  const [permDraft, setPermDraft] = useState<UserServicePermissions>({});
  const [saving, setSaving] = useState(false);

  // Members
  const [membersOpened, setMembersOpened] = useState(false);
  const [membersGroup, setMembersGroup] = useState<GroupRow | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [tenantUsers, setTenantUsers] = useState<TenantUser[]>([]);
  const [memberToAdd, setMemberToAdd] = useState<string | null>(null);

  // Projects
  const [projectsOpened, setProjectsOpened] = useState(false);
  const [projectsGroup, setProjectsGroup] = useState<GroupRow | null>(null);
  const [assignments, setAssignments] = useState<GroupProjectAssignment[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectToAdd, setProjectToAdd] = useState<string | null>(null);
  const [projectRoleToAdd, setProjectRoleToAdd] = useState<'member' | 'project_admin'>('member');

  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null);

  const notifyError = (message: string) =>
    notifications.show({ title: 'Error', message, color: 'red' });
  const notifyOk = (message: string) =>
    notifications.show({ title: 'Success', message, color: 'green' });

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/groups');
      if (!res.ok) throw new Error('Failed to load groups');
      const data = await res.json();
      setGroups(data.groups ?? []);
    } catch {
      notifyError('Failed to load groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/users/permissions/services');
        if (res.ok) {
          const data = await res.json();
          setPermissionServices(data.services ?? []);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => [g.name, g.description].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  }, [groups, query]);

  // ── Create / edit ──────────────────────────────────────────────────────────
  const openCreate = () => {
    setEditing(null);
    setNameDraft('');
    setDescDraft('');
    setTenantRoleDraft('');
    setPermDraft({});
    setEditorOpened(true);
  };

  const openEdit = (group: GroupRow) => {
    setEditing(group);
    setNameDraft(group.name);
    setDescDraft(group.description ?? '');
    setTenantRoleDraft(group.tenantRole ?? '');
    setPermDraft(group.servicePermissions ?? {});
    setEditorOpened(true);
  };

  const saveGroup = async () => {
    if (!nameDraft.trim()) {
      notifyError('Group name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: nameDraft.trim(),
        description: descDraft.trim() || undefined,
        tenantRole: tenantRoleDraft || null,
        servicePermissions: permDraft,
      };
      const res = editing
        ? await fetch(`/api/groups/${encodeURIComponent(editing._id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(editing.source === 'ldap' ? { ...payload, name: undefined } : payload),
          })
        : await fetch('/api/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to save group');
      notifyOk(editing ? 'Group updated' : 'Group created');
      setEditorOpened(false);
      await fetchGroups();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : 'Failed to save group');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(deleteTarget._id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to delete group');
      notifyOk('Group deleted');
      setDeleteTarget(null);
      await fetchGroups();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : 'Failed to delete group');
    }
  };

  // ── Members ──────────────────────────────────────────────────────────────────
  const openMembers = async (group: GroupRow) => {
    setMembersGroup(group);
    setMembersOpened(true);
    setMemberToAdd(null);
    try {
      const [detailRes, usersRes] = await Promise.all([
        fetch(`/api/groups/${encodeURIComponent(group._id)}`),
        fetch('/api/users'),
      ]);
      const detail = await detailRes.json();
      const usersData = await usersRes.json();
      setMembers(detail.members ?? []);
      setTenantUsers(usersData.users ?? []);
    } catch {
      notifyError('Failed to load members');
    }
  };

  const addMember = async () => {
    if (!membersGroup || !memberToAdd) return;
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(membersGroup._id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: memberToAdd, role: 'member' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to add member');
      setMemberToAdd(null);
      await openMembers(membersGroup);
      await fetchGroups();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : 'Failed to add member');
    }
  };

  const removeMember = async (userId: string) => {
    if (!membersGroup) return;
    try {
      const res = await fetch(
        `/api/groups/${encodeURIComponent(membersGroup._id)}/members/${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to remove member');
      await openMembers(membersGroup);
      await fetchGroups();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : 'Failed to remove member');
    }
  };

  // ── Projects ─────────────────────────────────────────────────────────────────
  const openProjects = async (group: GroupRow) => {
    setProjectsGroup(group);
    setProjectsOpened(true);
    setProjectToAdd(null);
    setProjectRoleToAdd('member');
    try {
      const [detailRes, projectsRes] = await Promise.all([
        fetch(`/api/groups/${encodeURIComponent(group._id)}`),
        fetch('/api/projects'),
      ]);
      const detail = await detailRes.json();
      const projectsData = await projectsRes.json();
      setAssignments(detail.projects ?? []);
      setProjectOptions((projectsData.projects ?? []).map((p: { _id: string; name: string }) => ({ _id: String(p._id), name: p.name })));
    } catch {
      notifyError('Failed to load project assignments');
    }
  };

  const assignProject = async () => {
    if (!projectsGroup || !projectToAdd) return;
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(projectsGroup._id)}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projectToAdd, role: projectRoleToAdd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to assign project');
      setProjectToAdd(null);
      await openProjects(projectsGroup);
      await fetchGroups();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : 'Failed to assign project');
    }
  };

  const removeProject = async (projectId: string) => {
    if (!projectsGroup) return;
    try {
      const res = await fetch(
        `/api/groups/${encodeURIComponent(projectsGroup._id)}/projects/${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to remove assignment');
      await openProjects(projectsGroup);
      await fetchGroups();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : 'Failed to remove assignment');
    }
  };

  const projectName = (id: string) => projectOptions.find((p) => p._id === id)?.name ?? id;
  const availableUsers = tenantUsers.filter((u) => !members.some((m) => m.userId === String(u._id)));
  const availableProjects = projectOptions.filter((p) => !assignments.some((a) => a.projectId === p._id));

  const columns: DataGridColumn<GroupRow>[] = [
    {
      key: 'name',
      label: 'Group',
      render: (g) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{g.name}</span>
          {g.description ? <span className="ds-faint" style={{ fontSize: 11 }}>{g.description}</span> : null}
        </div>
      ),
    },
    {
      key: 'tenantRole',
      label: 'Tenant role',
      width: 130,
      render: (g) =>
        g.tenantRole ? (
          <Badge variant="light" color={g.tenantRole === 'admin' ? 'grape' : g.tenantRole === 'project_admin' ? 'cyan' : 'gray'}>
            {g.tenantRole}
          </Badge>
        ) : (
          <Text size="xs" c="dimmed">—</Text>
        ),
    },
    {
      key: 'members',
      label: 'Members',
      width: 90,
      render: (g) => <Text size="sm">{g.memberCount ?? 0}</Text>,
    },
    {
      key: 'projects',
      label: 'Projects',
      width: 90,
      render: (g) => <Text size="sm">{g.projectCount ?? 0}</Text>,
    },
    {
      key: 'source',
      label: 'Source',
      width: 100,
      render: (g) => (
        <Badge variant="light" color={g.source === 'ldap' ? 'indigo' : 'gray'}>
          {g.source === 'ldap' ? 'LDAP' : 'Local'}
        </Badge>
      ),
    },
  ];

  return (
    <>
      <DataGrid<GroupRow>
        records={filtered}
        loading={loading}
        rowKey={(g) => String(g._id)}
        columns={columns}
        search={{ value: query, onChange: setQuery, placeholder: 'Search groups' }}
        onRefresh={() => void fetchGroups()}
        refreshing={loading}
        toolbarRight={
          <Button color="teal" size="xs" leftSection={<IconPlus size={13} stroke={1.7} />} onClick={openCreate}>
            New group
          </Button>
        }
        empty={{
          title: 'No groups yet',
          primaryAction: { label: 'New group', icon: <IconPlus size={14} stroke={1.7} />, onClick: openCreate },
        }}
        footerLeft={`Showing ${filtered.length} of ${groups.length} groups`}
        rowActions={(g) => [
          { id: 'members', label: 'Members', icon: <IconUsers size={14} />, onClick: () => void openMembers(g) },
          { id: 'projects', label: 'Projects', icon: <IconFolders size={14} />, onClick: () => void openProjects(g) },
          { id: 'edit', label: 'Edit grants', icon: <IconShieldCheck size={14} />, onClick: () => openEdit(g) },
          ...(g.source === 'ldap'
            ? []
            : [{ id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red' as const, onClick: () => setDeleteTarget(g) }]),
        ]}
      />

      {/* Create / edit grants */}
      <Modal
        opened={editorOpened}
        onClose={() => setEditorOpened(false)}
        title={editing ? `Edit group: ${editing.name}` : 'New group'}
        size="xl"
      >
        <Stack gap="sm">
          {editing?.source === 'ldap' && (
            <Text size="xs" c="dimmed">
              This group is synced from LDAP. Its name and membership are managed by the directory; you can still configure its grants here.
            </Text>
          )}
          <TextInput
            label="Name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.currentTarget.value)}
            disabled={editing?.source === 'ldap'}
            required
          />
          <Textarea
            label="Description"
            value={descDraft}
            onChange={(e) => setDescDraft(e.currentTarget.value)}
            autosize
            minRows={2}
          />
          <Select
            label="Tenant role granted to members"
            description="Unioned with each member's own role — only ever raises access."
            value={tenantRoleDraft}
            data={TENANT_ROLE_OPTIONS}
            onChange={(v) => setTenantRoleDraft(v ?? '')}
          />
          <Text size="sm" fw={500} mt="xs">Tenant service permissions</Text>
          <div className="ds-tbl-wrap" style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8, maxHeight: 320, overflow: 'auto' }}>
            <table className="ds-tbl">
              <thead>
                <tr><th>Service</th><th style={{ width: 120 }}>Category</th><th style={{ width: 180 }}>Permission</th></tr>
              </thead>
              <tbody>
                {permissionServices.map((service) => (
                  <tr key={service.id}>
                    <td><Text size="sm" fw={500}>{service.label}</Text></td>
                    <td><Badge variant="light" color={service.adminService ? 'grape' : 'gray'}>{service.category}</Badge></td>
                    <td>
                      <Select
                        size="xs"
                        value={permDraft[service.id] ?? 'none'}
                        data={[
                          { value: 'none', label: 'None' },
                          { value: 'read', label: 'Read' },
                          { value: 'write', label: 'Write' },
                          { value: 'admin', label: 'Admin' },
                        ]}
                        onChange={(value) =>
                          setPermDraft((cur) => ({ ...cur, [service.id]: (value ?? 'none') as ServicePermissionLevel }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEditorOpened(false)}>Cancel</Button>
            <Button loading={saving} onClick={saveGroup}>{editing ? 'Save' : 'Create'}</Button>
          </Group>
        </Stack>
      </Modal>

      {/* Members */}
      <Modal opened={membersOpened} onClose={() => setMembersOpened(false)} title={membersGroup ? `Members: ${membersGroup.name}` : 'Members'} size="lg">
        <Stack gap="sm">
          {membersGroup?.source === 'ldap' ? (
            <Text size="xs" c="dimmed">Membership is reconciled from LDAP on each login and cannot be edited here.</Text>
          ) : (
            <Group align="flex-end" gap="sm">
              <Select
                style={{ flex: 1 }}
                label="Add member"
                placeholder="Select a user"
                searchable
                value={memberToAdd}
                onChange={setMemberToAdd}
                data={availableUsers.map((u) => ({ value: String(u._id), label: `${u.name} (${u.email})` }))}
              />
              <Button onClick={addMember} disabled={!memberToAdd}>Add</Button>
            </Group>
          )}
          <div className="ds-tbl-wrap" style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8 }}>
            <table className="ds-tbl">
              <thead><tr><th>Name</th><th style={{ width: 100 }}>Source</th><th style={{ width: 80 }} /></tr></thead>
              <tbody>
                {members.length === 0 ? (
                  <tr><td colSpan={3}><Text size="sm" c="dimmed" ta="center" py="md">No members</Text></td></tr>
                ) : (
                  members.map((m) => (
                    <tr key={m.userId}>
                      <td><Text size="sm" fw={500}>{m.name ?? m.userId}</Text><Text size="xs" c="dimmed">{m.email}</Text></td>
                      <td><Badge variant="light" color={m.source === 'ldap' ? 'indigo' : 'gray'}>{m.source === 'ldap' ? 'LDAP' : 'Local'}</Badge></td>
                      <td>
                        {m.source === 'ldap' || membersGroup?.source === 'ldap' ? null : (
                          <Button size="compact-xs" color="red" variant="subtle" onClick={() => void removeMember(m.userId)}>Remove</Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Stack>
      </Modal>

      {/* Projects */}
      <Modal opened={projectsOpened} onClose={() => setProjectsOpened(false)} title={projectsGroup ? `Project access: ${projectsGroup.name}` : 'Project access'} size="lg">
        <Stack gap="sm">
          <Group align="flex-end" gap="sm">
            <Select
              style={{ flex: 1 }}
              label="Assign project"
              placeholder="Select a project"
              searchable
              value={projectToAdd}
              onChange={setProjectToAdd}
              data={availableProjects.map((p) => ({ value: p._id, label: p.name }))}
            />
            <Select
              label="Role"
              value={projectRoleToAdd}
              onChange={(v) => setProjectRoleToAdd((v as 'member' | 'project_admin') ?? 'member')}
              data={[{ value: 'member', label: 'Member' }, { value: 'project_admin', label: 'Project Admin' }]}
            />
            <Button onClick={assignProject} disabled={!projectToAdd}>Assign</Button>
          </Group>
          <div className="ds-tbl-wrap" style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8 }}>
            <table className="ds-tbl">
              <thead><tr><th>Project</th><th style={{ width: 140 }}>Role</th><th style={{ width: 80 }} /></tr></thead>
              <tbody>
                {assignments.length === 0 ? (
                  <tr><td colSpan={3}><Text size="sm" c="dimmed" ta="center" py="md">No project assignments</Text></td></tr>
                ) : (
                  assignments.map((a) => (
                    <tr key={a.projectId}>
                      <td><Text size="sm" fw={500}>{projectName(a.projectId)}</Text></td>
                      <td><Badge variant="light" color={a.role === 'project_admin' ? 'cyan' : 'gray'}>{a.role}</Badge></td>
                      <td><Button size="compact-xs" color="red" variant="subtle" onClick={() => void removeProject(a.projectId)}>Remove</Button></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Stack>
      </Modal>

      {/* Delete */}
      <Modal opened={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete group" size="md">
        <Text size="sm" mb="md">
          Delete group <strong>{deleteTarget?.name}</strong>? Members lose any access this group granted. This cannot be undone.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="red" onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>
    </>
  );
}
