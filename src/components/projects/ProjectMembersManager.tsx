'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';

type Member = {
  _id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'project_admin' | 'user';
  projectIds?: string[];
};

export default function ProjectMembersManager(
  {
    projectId,
    readOnly = false,
  }: {
    projectId: string;
    readOnly?: boolean;
  },
) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignEmail, setAssignEmail] = useState('');
  const [assignSuggestions, setAssignSuggestions] = useState<string[]>([]);
  const [assignSuggestionsLoading, setAssignSuggestionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteOpened, setInviteOpened] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'user' | 'project_admin' | 'admin'>('user');

  const fetchMembers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load members');
      }
      const data = (await res.json()) as { users?: Member[] };
      setMembers(data.users ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load members';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    if (readOnly) {
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
          .map((u) => (u.email ?? '').trim())
          .filter(Boolean);
        if (!cancelled) setAssignSuggestions(emails);
      } catch {
        if (!cancelled) setAssignSuggestions([]);
      } finally {
        if (!cancelled) setAssignSuggestionsLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [assignEmail, projectId, readOnly]);

  const rows = useMemo(() => members ?? [], [members]);

  const handleAssignExisting = async () => {
    if (!assignEmail.trim()) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: assignEmail.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || 'Failed to assign user');
      }
      notifications.show({ title: 'Project members', message: 'User assigned', color: 'green' });
      setAssignEmail('');
      await fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to assign user';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (member: Member) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: member._id }),
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

  const handleRoleChange = async (member: Member, role: 'user' | 'project_admin') => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: member._id, role }),
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

  const handleInvite = async () => {
    if (!inviteName.trim() || !inviteEmail.trim()) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/users/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: inviteName.trim(),
          email: inviteEmail.trim(),
          role: inviteRole,
          projectId,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || 'Failed to invite user');
      }
      notifications.show({ title: 'Project members', message: 'User invited', color: 'green' });
      setInviteOpened(false);
      setInviteName('');
      setInviteEmail('');
      setInviteRole('user');
      await fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to invite user';
      notifications.show({ title: 'Project members', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Text size="lg" fw={600}>Users</Text>
          <Text size="sm" c="dimmed">
            {readOnly
              ? 'Project members'
              : 'Assign existing users or invite new users directly to this project.'}
          </Text>
        </div>
        {readOnly ? null : <Button onClick={() => setInviteOpened(true)}>Invite user</Button>}
      </Group>

      {readOnly ? null : (
        <Group align="flex-end" mb="md">
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
          <Button onClick={handleAssignExisting} loading={submitting}>
            Assign
          </Button>
        </Group>
      )}

      <DataTable
        withTableBorder
        borderRadius="sm"
        striped
        highlightOnHover
        idAccessor="_id"
        records={rows}
        fetching={loading}
        minHeight={200}
        noRecordsText="No members"
        columns={readOnly
          ? [
              {
                accessor: 'name',
                title: 'Name',
                render: (m) => (
                  <div>
                    <Text size="sm" fw={500}>{m.name}</Text>
                    <Text size="xs" c="dimmed">{m.email}</Text>
                  </div>
                ),
              },
              {
                accessor: 'role',
                title: 'Role',
                render: (m) => <Text size="sm">{m.role}</Text>,
              },
            ]
          : [
              {
                accessor: 'name',
                title: 'Name',
                render: (m) => (
                  <div>
                    <Text size="sm" fw={500}>{m.name}</Text>
                    <Text size="xs" c="dimmed">{m.email}</Text>
                  </div>
                ),
              },
              {
                accessor: 'role',
                title: 'Role',
                render: (m) => {
                  const isManagedRole = m.role === 'user' || m.role === 'project_admin';
                  if (!isManagedRole) {
                    return <Text size="sm">{m.role}</Text>;
                  }
                  return (
                    <Select
                      data={[
                        { value: 'user', label: 'User' },
                        { value: 'project_admin', label: 'Project Admin' },
                      ]}
                      value={m.role}
                      onChange={(value) => {
                        if (!value) return;
                        handleRoleChange(m, value as 'user' | 'project_admin');
                      }}
                      size="xs"
                      w={160}
                    />
                  );
                },
              },
              {
                accessor: 'actions',
                title: 'Actions',
                textAlign: 'right',
                render: (m) => (
                  <Group gap="xs" justify="flex-end">
                    {m.role === 'owner' || m.role === 'admin' ? null : (
                      <Tooltip label="Remove">
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          loading={submitting}
                          onClick={() => handleRemove(m)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                ),
              },
            ]}
      />

      {readOnly ? null : (
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
              onChange={(e) => setInviteName(e.currentTarget.value)}
              required
            />
            <TextInput
              label="Email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.currentTarget.value)}
              required
            />
            <Select
              label="Role"
              value={inviteRole}
              onChange={(value) => setInviteRole((value as 'user' | 'project_admin' | 'admin') ?? 'user')}
              data={[
                { value: 'user', label: 'User' },
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
      )}
    </Box>
  );
}
