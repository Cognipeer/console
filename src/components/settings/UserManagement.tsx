'use client';

import { useCallback, useEffect, useState } from 'react';
import { ActionIcon, Badge, Box, Button, Group, Modal, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconMail, IconSearch, IconShieldCheck, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import InviteUserModal from './InviteUserModal';
import { useTranslations } from '@/lib/i18n';
import type { PermissionService, ServicePermissionLevel, UserServicePermissions } from '@/lib/security/rbac';
import { TABLE_PAGE_SIZE_OPTIONS, useClientTable } from '@/hooks/useClientTable';

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
  const t = useTranslations('settings.userManagement');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const userTable = useClientTable({
    records: users,
    initialPageSize: 10,
    search: (user, query) =>
      [user.name, user.email, user.role]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
  });

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

  return (
    <Box p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Text size="lg" fw={600}>
            {t('header.title')}
          </Text>
          <Text size="sm" c="dimmed">
            {t('header.subtitle')}
          </Text>
        </div>
        <Button
          leftSection={<IconUserPlus size={16} />}
          onClick={() => setInviteModalOpened(true)}
        >
          {t('actions.invite')}
        </Button>
      </Group>

      <Group mb="sm" justify="space-between">
        <TextInput
          value={userTable.query}
          onChange={(event) => userTable.setQuery(event.currentTarget.value)}
          placeholder="Search users"
          leftSection={<IconSearch size={14} />}
          w={{ base: '100%', sm: 280 }}
        />
        <Text size="sm" c="dimmed">
          {userTable.totalRecords} records
        </Text>
      </Group>

      <DataTable
        withTableBorder
        borderRadius="sm"
        striped
        highlightOnHover
        records={userTable.records}
        totalRecords={userTable.totalRecords}
        recordsPerPage={userTable.pageSize}
        recordsPerPageOptions={TABLE_PAGE_SIZE_OPTIONS}
        onRecordsPerPageChange={userTable.setPageSize}
        page={userTable.page}
        onPageChange={userTable.setPage}
        columns={[
          {
            accessor: 'name',
            title: t('table.name'),
            render: (user) => (
              <div>
                <Text size="sm" fw={500}>
                  {user.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {user.email}
                </Text>
              </div>
            ),
          },
          {
            accessor: 'role',
            title: t('table.role'),
            render: (user) => (
              <Badge color={getRoleBadgeColor(user.role)} variant="light">
                {t(`roles.${user.role}`)}
              </Badge>
            ),
          },
          {
            accessor: 'createdAt',
            title: t('table.joined'),
            render: (user) => new Date(user.createdAt).toLocaleDateString(),
          },
          {
            accessor: 'invitedBy',
            title: t('table.status'),
            render: (user) =>
              user.invitedBy && !user.inviteAcceptedAt ? (
                <Tooltip label={t('status.invitedAt', { date: new Date(user.invitedAt!).toLocaleDateString() })}>
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
          {
            accessor: 'actions',
            title: t('table.actions'),
            textAlign: 'right',
            render: (user) =>
              user.role !== 'owner' ? (
                <Group gap="xs" justify="flex-end" wrap="nowrap">
                  <Tooltip label="Service permissions" withArrow>
                    <ActionIcon
                      color="blue"
                      variant="subtle"
                      onClick={() => handleEditPermissions(user)}
                    >
                      <IconShieldCheck size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={() => handleDeleteUser(user)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              ) : null,
          },
        ]}
        fetching={loading}
        minHeight={200}
        noRecordsText={t('table.empty')}
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
          <DataTable
            withTableBorder
            borderRadius="sm"
            records={permissionServices}
            minHeight={260}
            columns={[
              {
                accessor: 'label',
                title: 'Service',
                render: (service) => (
                  <div>
                    <Text size="sm" fw={500}>{service.label}</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>{service.description}</Text>
                  </div>
                ),
              },
              {
                accessor: 'category',
                title: 'Category',
                width: 120,
                render: (service) => (
                  <Badge variant="light" color={service.adminService ? 'grape' : 'gray'}>
                    {service.category}
                  </Badge>
                ),
              },
              {
                accessor: 'permission',
                title: 'Permission',
                width: 180,
                render: (service) => (
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
                ),
              },
            ]}
            noRecordsText="No permission services"
          />
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
    </Box>
  );
}
