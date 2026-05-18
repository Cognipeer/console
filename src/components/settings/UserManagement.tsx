'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Group, Modal, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconMail, IconShieldCheck, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import InviteUserModal from './InviteUserModal';
import { useTranslations } from '@/lib/i18n';
import type { PermissionService, ServicePermissionLevel, UserServicePermissions } from '@/lib/security/rbac';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

interface User {
  _id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'project_admin' | 'user';
  createdAt: string;
  invitedBy?: string;
  invitedAt?: string;
  inviteAcceptedAt?: string;
  servicePermissions?: UserServicePermissions;
}

interface PermissionServiceOption {
  id: PermissionService;
  label: string;
  description: string;
  category: string;
  adminService?: boolean;
}

export default function UserManagement() {
  const [users, setUsers] = useState<User[]>([]);
  const [permissionServices, setPermissionServices] = useState<PermissionServiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteModalOpened, setInviteModalOpened] = useState(false);
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [permissionsModalOpened, setPermissionsModalOpened] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [userToEditPermissions, setUserToEditPermissions] = useState<User | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<UserServicePermissions>({});
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [query, setQuery] = useState('');
  const t = useTranslations('settings.userManagement');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/users');
      if (!response.ok) {
        throw new Error(t('errors.fetch'));
      }
      const data = await response.json();
      setUsers(data.users || []);
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: t('errors.load'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [t, tNotifications]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    async function loadPermissionServices() {
      try {
        const response = await fetch('/api/users/permissions/services');
        if (!response.ok) return;
        const data = await response.json() as { services?: PermissionServiceOption[] };
        setPermissionServices(data.services ?? []);
      } catch {
        setPermissionServices([]);
      }
    }
    void loadPermissionServices();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((user) =>
      [user.name, user.email, user.role]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [users, query]);

  const handleDeleteUser = (user: User) => {
    setUserToDelete(user);
    setDeleteModalOpened(true);
  };

  const handleEditPermissions = (user: User) => {
    setUserToEditPermissions(user);
    setPermissionDraft(user.servicePermissions ?? {});
    setPermissionsModalOpened(true);
  };

  const savePermissions = async () => {
    if (!userToEditPermissions) return;
    setSavingPermissions(true);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(userToEditPermissions._id)}/permissions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servicePermissions: permissionDraft }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to update permissions');
      }

      notifications.show({
        title: tCommon('success'),
        message: 'Permissions updated',
        color: 'green',
      });
      setPermissionsModalOpened(false);
      setUserToEditPermissions(null);
      await fetchUsers();
    } catch (error) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: error instanceof Error ? error.message : 'Failed to update permissions',
        color: 'red',
      });
    } finally {
      setSavingPermissions(false);
    }
  };

  const confirmDelete = async () => {
    if (!userToDelete) return;

    try {
      const response = await fetch(`/api/users/${userToDelete._id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(t('errors.delete'));
      }

      notifications.show({
        title: tCommon('success'),
        message: t('messages.deleteSuccess'),
        color: 'green',
      });

      fetchUsers();
      setDeleteModalOpened(false);
      setUserToDelete(null);
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: t('errors.delete'),
        color: 'red',
      });
    }
  };

  const getRoleBadgeColor = (role: string) => {
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
  };

  const columns: DataGridColumn<User>[] = [
    {
      key: 'name',
      label: t('table.name'),
      render: (user) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{user.name}</span>
          <span className="ds-faint" style={{ fontSize: 11 }}>{user.email}</span>
        </div>
      ),
    },
    {
      key: 'role',
      label: t('table.role'),
      width: 140,
      render: (user) => (
        <Badge color={getRoleBadgeColor(user.role)} variant="light">
          {t(`roles.${user.role}`)}
        </Badge>
      ),
    },
    {
      key: 'createdAt',
      label: t('table.joined'),
      width: 140,
      render: (user) => (
        <span className="ds-faint" style={{ fontSize: 12 }}>
          {new Date(user.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'status',
      label: t('table.status'),
      width: 140,
      render: (user) =>
        user.invitedBy && !user.inviteAcceptedAt ? (
          <Tooltip
            label={t('status.invitedAt', { date: new Date(user.invitedAt!).toLocaleDateString() })}
          >
            <Badge color="orange" variant="light" leftSection={<IconMail size={12} />}>
              {t('status.invited')}
            </Badge>
          </Tooltip>
        ) : (
          <Badge color="green" variant="light">
            {t('status.active')}
          </Badge>
        ),
    },
  ];

  return (
    <>
      <DataGrid<User>
        records={filtered}
        loading={loading}
        rowKey={(u) => String(u._id)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search users',
        }}
        onRefresh={() => void fetchUsers()}
        refreshing={loading}
        toolbarRight={
          <Button
            color="teal"
            size="xs"
            leftSection={<IconUserPlus size={13} stroke={1.7} />}
            onClick={() => setInviteModalOpened(true)}
          >
            {t('actions.invite')}
          </Button>
        }
        empty={{
          title: t('table.empty'),
          primaryAction: {
            label: t('actions.invite'),
            icon: <IconUserPlus size={14} stroke={1.7} />,
            onClick: () => setInviteModalOpened(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${users.length} users`}
        rowActions={(user) =>
          user.role === 'owner'
            ? []
            : [
                {
                  id: 'permissions',
                  label: 'Service permissions',
                  icon: <IconShieldCheck size={14} />,
                  onClick: () => handleEditPermissions(user),
                },
                {
                  id: 'delete',
                  label: 'Delete',
                  icon: <IconTrash size={14} />,
                  color: 'red',
                  onClick: () => handleDeleteUser(user),
                },
              ]
        }
      />

      <InviteUserModal
        opened={inviteModalOpened}
        onClose={() => setInviteModalOpened(false)}
        onSuccess={fetchUsers}
      />

      <Modal
        opened={permissionsModalOpened}
        onClose={() => {
          setPermissionsModalOpened(false);
          setUserToEditPermissions(null);
        }}
        title={userToEditPermissions ? `Service permissions: ${userToEditPermissions.name}` : 'Service permissions'}
        size="xl"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Select the highest permission level this user can use for each service.
          </Text>
          <div className="ds-tbl-wrap" style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8 }}>
            <table className="ds-tbl">
              <thead>
                <tr>
                  <th>Service</th>
                  <th style={{ width: 140 }}>Category</th>
                  <th style={{ width: 200 }}>Permission</th>
                </tr>
              </thead>
              <tbody>
                {permissionServices.length === 0 ? (
                  <tr>
                    <td colSpan={3}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No permission services
                      </Text>
                    </td>
                  </tr>
                ) : (
                  permissionServices.map((service) => (
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
                          data={[
                            { value: 'none', label: 'None' },
                            { value: 'read', label: 'Read' },
                            { value: 'write', label: 'Write' },
                            { value: 'admin', label: 'Admin' },
                          ]}
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
                setPermissionsModalOpened(false);
                setUserToEditPermissions(null);
              }}
            >
              Cancel
            </Button>
            <Button loading={savingPermissions} onClick={savePermissions}>
              Save permissions
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={deleteModalOpened}
        onClose={() => {
          setDeleteModalOpened(false);
          setUserToDelete(null);
        }}
        title={t('deleteModal.title')}
        size="md"
      >
        <Text size="sm" mb="md">
          {t('deleteModal.description', {
            name: userToDelete?.name ?? '',
            email: userToDelete?.email ?? '',
          })}
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button
            variant="default"
            onClick={() => {
              setDeleteModalOpened(false);
              setUserToDelete(null);
            }}
          >
            {t('deleteModal.cancel')}
          </Button>
          <Button color="red" onClick={confirmDelete}>
            {t('deleteModal.confirm')}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
