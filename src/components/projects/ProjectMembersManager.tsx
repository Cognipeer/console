'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconShieldCheck, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import {
  RBAC_SERVICE_DEFINITIONS,
  type ServicePermissionLevel,
  SERVICE_PERMISSION_LEVELS,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

type TenantRole = 'owner' | 'admin' | 'project_admin' | 'user';
type ProjectRole = 'member' | 'project_admin';

type ProjectMember = {
  userId: string;
  email: string;
  implicit: boolean;
  name: string;
  projectRole: ProjectRole | null;
  role: TenantRole;
  servicePermissions?: UserServicePermissions | null;
};

type MemberCapabilities = {
  canAssignMembers: boolean;
  canInviteMembers: boolean;
  canManagePermissions: boolean;
  canManageRoles: boolean;
  canRemoveMembers: boolean;
  isProjectAdmin: boolean;
  isTenantAdmin: boolean;
};

type LegacyMember = {
  _id: string;
  email: string;
  name: string;
  role: TenantRole;
  servicePermissions?: UserServicePermissions | null;
};

const DEFAULT_CAPABILITIES: MemberCapabilities = {
  canAssignMembers: false,
  canInviteMembers: false,
  canManagePermissions: false,
  canManageRoles: false,
  canRemoveMembers: false,
  isProjectAdmin: false,
  isTenantAdmin: false,
};

const PERMISSION_LEVEL_OPTIONS = SERVICE_PERMISSION_LEVELS.map((level) => ({
  label: level === 'none' ? 'None' : level.charAt(0).toUpperCase() + level.slice(1),
  value: level,
}));

function normalizeLegacyMember(member: LegacyMember): ProjectMember {
  const implicit = member.role === 'owner' || member.role === 'admin';

  return {
    email: member.email,
    implicit,
    name: member.name,
    projectRole: implicit ? null : member.role === 'project_admin' ? 'project_admin' : 'member',
    role: member.role,
    servicePermissions: member.servicePermissions ?? null,
    userId: member._id,
  };
}

function getTenantRoleColor(role: TenantRole) {
  switch (role) {
    case 'owner':
      return 'blue';
    case 'admin':
      return 'grape';
    case 'project_admin':
      return 'cyan';
    default:
      return 'gray';
  }
}

function getTenantRoleLabel(role: TenantRole) {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'project_admin':
      return 'Legacy Project Admin';
    default:
      return 'User';
  }
}

function getProjectRoleLabel(role: ProjectRole | null, implicit: boolean) {
  if (implicit) {
    return 'Implicit access';
  }

  return role === 'project_admin' ? 'Project Admin' : 'Member';
}

function getProjectRoleColor(role: ProjectRole | null, implicit: boolean) {
  if (implicit) return 'dark';
  return role === 'project_admin' ? 'teal' : 'gray';
}

function summarizePermissions(member: ProjectMember) {
  if (member.implicit) {
    return 'Inherited from tenant role';
  }

  const overrides = Object.entries(member.servicePermissions ?? {}).filter(([, level]) => level && level !== 'none');
  if (overrides.length === 0) {
    return 'Default project access';
  }

  if (overrides.length === 1) {
    const [serviceId, level] = overrides[0];
    const service = RBAC_SERVICE_DEFINITIONS.find((item) => item.id === serviceId);
    return `${service?.label ?? serviceId}: ${level}`;
  }

  return `${overrides.length} service overrides`;
}

export default function ProjectMembersManager(
  {
    projectId,
    readOnly,
  }: {
    projectId: string;
    readOnly?: boolean;
  },
) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [capabilities, setCapabilities] = useState<MemberCapabilities>(DEFAULT_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [assignEmail, setAssignEmail] = useState('');
  const [assignRole, setAssignRole] = useState<ProjectRole>('member');
  const [assignSuggestions, setAssignSuggestions] = useState<string[]>([]);
  const [assignSuggestionsLoading, setAssignSuggestionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteOpened, setInviteOpened] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'project_admin' | 'admin'>('member');
  const [permissionsOpened, setPermissionsOpened] = useState(false);
  const [memberToEditPermissions, setMemberToEditPermissions] = useState<ProjectMember | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<UserServicePermissions>({});
  const [query, setQuery] = useState('');

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load members');
      }

      const data = (await res.json()) as {
        capabilities?: Partial<MemberCapabilities>;
        members?: ProjectMember[];
        users?: LegacyMember[];
      };

      const nextMembers = data.members ?? (data.users ?? []).map(normalizeLegacyMember);
      setMembers(nextMembers);
      setCapabilities({
        ...DEFAULT_CAPABILITIES,
        ...(data.capabilities ?? {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load members';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const effectiveReadOnly = readOnly ?? !(
    capabilities.canAssignMembers
    || capabilities.canInviteMembers
    || capabilities.canManagePermissions
    || capabilities.canManageRoles
    || capabilities.canRemoveMembers
  );

  useEffect(() => {
    let cancelled = false;

    if (effectiveReadOnly || !capabilities.canAssignMembers) {
      setAssignSuggestions([]);
      setAssignSuggestionsLoading(false);
      return;
    }

    const q = assignEmail.trim();
    if (q.length < 2) {
      setAssignSuggestions([]);
      return;
    }

    setAssignSuggestionsLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/member-candidates?q=${encodeURIComponent(q)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (!cancelled) setAssignSuggestions([]);
          return;
        }

        const data = (await res.json()) as { users?: Array<{ email?: string }> };
        const emails = (data.users ?? [])
          .map((user) => (user.email ?? '').trim())
          .filter(Boolean);

        if (!cancelled) {
          setAssignSuggestions(emails);
        }
      } catch {
        if (!cancelled) {
          setAssignSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setAssignSuggestionsLoading(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [assignEmail, capabilities.canAssignMembers, effectiveReadOnly, projectId]);

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      [m.name, m.email, m.role]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [members, query]);

  const handleAssignExisting = async () => {
    if (!assignEmail.trim() || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        body: JSON.stringify({ email: assignEmail.trim(), role: assignRole }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || 'Failed to assign user');
      }

      notifications.show({ title: 'Project members', message: 'User assigned', color: 'green' });
      setAssignEmail('');
      setAssignRole('member');
      await fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to assign user';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (member: ProjectMember) => {
    if (submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        body: JSON.stringify({ userId: member.userId }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || 'Failed to remove user');
      }

      notifications.show({ title: 'Project members', message: 'User removed', color: 'green' });
      await fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove user';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (member: ProjectMember, role: ProjectRole) => {
    if (submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        body: JSON.stringify({ role, userId: member.userId }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || 'Failed to update role');
      }

      notifications.show({ title: 'Project members', message: 'Role updated', color: 'green' });
      await fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update role';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const openPermissions = (member: ProjectMember) => {
    setMemberToEditPermissions(member);
    setPermissionDraft(member.servicePermissions ?? {});
    setPermissionsOpened(true);
  };

  const savePermissions = async () => {
    if (!memberToEditPermissions || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/permissions`, {
        body: JSON.stringify({
          servicePermissions: permissionDraft,
          userId: memberToEditPermissions.userId,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || 'Failed to update permissions');
      }

      notifications.show({
        title: 'Project members',
        message: 'Project service permissions updated',
        color: 'green',
      });
      setPermissionsOpened(false);
      setMemberToEditPermissions(null);
      await fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update permissions';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleInvite = async () => {
    if (!inviteName.trim() || !inviteEmail.trim() || submitting) return;

    setSubmitting(true);
    try {
      const apiRole = inviteRole === 'member' ? 'user' : inviteRole;
      const res = await fetch('/api/users/invite', {
        body: JSON.stringify({
          email: inviteEmail.trim(),
          name: inviteName.trim(),
          projectId,
          role: apiRole,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || 'Failed to invite user');
      }

      notifications.show({ title: 'Project members', message: 'User invited', color: 'green' });
      setInviteOpened(false);
      setInviteName('');
      setInviteEmail('');
      setInviteRole('member');
      await fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to invite user';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const canEditMemberRole = (member: ProjectMember) =>
    !effectiveReadOnly
    && capabilities.canManageRoles
    && !member.implicit
    && member.role !== 'owner'
    && member.role !== 'admin';

  const canEditMemberPermissions = (member: ProjectMember) =>
    !effectiveReadOnly
    && capabilities.canManagePermissions
    && !member.implicit
    && member.role !== 'owner'
    && member.role !== 'admin';

  const canRemoveMember = (member: ProjectMember) =>
    !effectiveReadOnly
    && capabilities.canRemoveMembers
    && !member.implicit
    && member.role !== 'owner'
    && member.role !== 'admin';

  const columns: DataGridColumn<ProjectMember>[] = [
    {
      key: 'name',
      label: 'Member',
      render: (member) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{member.name}</span>
          <span className="ds-faint" style={{ fontSize: 11 }}>{member.email}</span>
        </div>
      ),
    },
    {
      key: 'tenantRole',
      label: 'Tenant Role',
      width: 170,
      render: (member) => (
        <Badge color={getTenantRoleColor(member.role)} variant="light">
          {getTenantRoleLabel(member.role)}
        </Badge>
      ),
    },
    {
      key: 'projectRole',
      label: 'Project Role',
      width: 180,
      render: (member) =>
        canEditMemberRole(member) ? (
          <Select
            size="xs"
            value={member.projectRole ?? 'member'}
            data={[
              { value: 'member', label: 'Member' },
              { value: 'project_admin', label: 'Project Admin' },
            ]}
            onChange={(value) => {
              if (!value) return;
              void handleRoleChange(member, value as ProjectRole);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <Badge color={getProjectRoleColor(member.projectRole, member.implicit)} variant="light">
            {getProjectRoleLabel(member.projectRole, member.implicit)}
          </Badge>
        ),
    },
    {
      key: 'permissions',
      label: 'Service Access',
      render: (member) => (
        <Text size="sm" c="dimmed">
          {summarizePermissions(member)}
        </Text>
      ),
    },
  ];

  return (
    <>
      {effectiveReadOnly || !capabilities.canAssignMembers ? null : (
        <div className="ds-card" style={{ padding: 16, marginBottom: 12 }}>
          <Group align="flex-end" gap="sm">
            <Select
              label="Assign existing user by email"
              placeholder="user@company.com"
              searchable
              clearable
              data={assignSuggestions}
              value={assignEmail}
              onChange={(value) => setAssignEmail(value ?? '')}
              onSearchChange={setAssignEmail}
              nothingFoundMessage={assignEmail.trim().length >= 2 ? 'No matches' : 'Type to search'}
              rightSection={assignSuggestionsLoading ? <Loader size="xs" /> : undefined}
              rightSectionPointerEvents="none"
              style={{ flex: 1 }}
            />
            <Select
              label="Project role"
              value={assignRole}
              onChange={(value) => setAssignRole((value as ProjectRole) ?? 'member')}
              data={[
                { value: 'member', label: 'Member' },
                { value: 'project_admin', label: 'Project Admin' },
              ]}
              w={180}
            />
            <Button onClick={handleAssignExisting} loading={submitting}>
              Assign
            </Button>
          </Group>
        </div>
      )}

      <DataGrid<ProjectMember>
        records={filteredMembers}
        loading={loading}
        rowKey={(m) => String(m.userId)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search members',
        }}
        onRefresh={() => void fetchMembers()}
        refreshing={loading}
        toolbarRight={
          effectiveReadOnly || !capabilities.canInviteMembers ? undefined : (
            <Button
              color="teal"
              size="xs"
              leftSection={<IconUserPlus size={13} stroke={1.7} />}
              onClick={() => setInviteOpened(true)}
            >
              Invite user
            </Button>
          )
        }
        empty={{
          title: 'No members',
          description: effectiveReadOnly
            ? 'View who can access this project and what access level they inherit.'
            : 'Assign users, manage project roles, and apply project-specific service overrides.',
          primaryAction:
            !effectiveReadOnly && capabilities.canInviteMembers
              ? {
                  label: 'Invite user',
                  icon: <IconUserPlus size={14} stroke={1.7} />,
                  onClick: () => setInviteOpened(true),
                }
              : undefined,
        }}
        footerLeft={`Showing ${filteredMembers.length} of ${members.length} members`}
        rowActions={(member) => {
          const actions = [] as Array<{
            id: string;
            label: string;
            icon: React.ReactNode;
            color?: 'red' | 'teal' | 'gray' | 'blue' | 'orange';
            onClick: () => void;
            disabled?: boolean;
          }>;
          if (canEditMemberPermissions(member)) {
            actions.push({
              id: 'permissions',
              label: 'Project service permissions',
              icon: <IconShieldCheck size={14} />,
              onClick: () => openPermissions(member),
            });
          }
          if (canRemoveMember(member)) {
            actions.push({
              id: 'remove',
              label: 'Remove from project',
              icon: <IconTrash size={14} />,
              color: 'red',
              onClick: () => void handleRemove(member),
              disabled: submitting,
            });
          }
          return actions;
        }}
      />

      {capabilities.canInviteMembers && !effectiveReadOnly ? (
        <Modal
          opened={inviteOpened}
          onClose={() => {
            if (submitting) return;
            setInviteOpened(false);
          }}
          title="Invite user to project"
          size="md"
          centered
        >
          <Stack gap="sm">
            <TextInput
              label="Name"
              value={inviteName}
              onChange={(event) => setInviteName(event.currentTarget.value)}
              required
            />
            <TextInput
              label="Email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.currentTarget.value)}
              required
            />
            <Select
              label="Role"
              value={inviteRole}
              onChange={(value) => setInviteRole((value as 'member' | 'project_admin' | 'admin') ?? 'member')}
              data={[
                { value: 'member', label: 'Project Member' },
                { value: 'project_admin', label: 'Project Admin' },
                { value: 'admin', label: 'Tenant Admin' },
              ]}
            />
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setInviteOpened(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleInvite} loading={submitting}>
                Invite
              </Button>
            </Group>
          </Stack>
        </Modal>
      ) : null}

      <Modal
        opened={permissionsOpened}
        onClose={() => {
          if (submitting) return;
          setPermissionsOpened(false);
          setMemberToEditPermissions(null);
        }}
        title={memberToEditPermissions ? `Project permissions: ${memberToEditPermissions.name}` : 'Project permissions'}
        size="xl"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Override the default project access for this member on individual services.
          </Text>
          <div
            className="ds-tbl-wrap"
            style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8 }}
          >
            <table className="ds-tbl">
              <thead>
                <tr>
                  <th>Service</th>
                  <th style={{ width: 140 }}>Category</th>
                  <th style={{ width: 200 }}>Permission</th>
                </tr>
              </thead>
              <tbody>
                {RBAC_SERVICE_DEFINITIONS.length === 0 ? (
                  <tr>
                    <td colSpan={3}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No permission services
                      </Text>
                    </td>
                  </tr>
                ) : (
                  RBAC_SERVICE_DEFINITIONS.map((service) => (
                    <tr key={service.id}>
                      <td>
                        <div>
                          <Text size="sm" fw={500}>{service.label}</Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>{service.description}</Text>
                        </div>
                      </td>
                      <td>
                        <Badge variant="light" color={service.adminService ? 'grape' : 'gray'}>
                          {service.category}
                        </Badge>
                      </td>
                      <td>
                        <Select
                          size="xs"
                          value={permissionDraft[service.id] ?? 'none'}
                          data={PERMISSION_LEVEL_OPTIONS}
                          onChange={(value) =>
                            setPermissionDraft((current) => ({
                              ...current,
                              [service.id]: (value ?? 'none') as ServicePermissionLevel,
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setPermissionsOpened(false);
                setMemberToEditPermissions(null);
              }}
            >
              Cancel
            </Button>
            <Button loading={submitting} onClick={savePermissions}>
              Save permissions
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
