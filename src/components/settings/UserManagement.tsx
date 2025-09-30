'use client';

import { useEffect, useState } from 'react';
import { Button, Group, Text, Badge, ActionIcon, Tooltip, Box, Modal } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconUserPlus, IconTrash, IconMail } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import InviteUserModal from './InviteUserModal';
import { useTranslations } from '@/lib/i18n';

interface User {
  _id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'user';
  createdAt: string;
  invitedBy?: string;
  invitedAt?: string;
}

export default function UserManagement() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteModalOpened, setInviteModalOpened] = useState(false);
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const t = useTranslations('settings.userManagement');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/users');
      if (!response.ok) {
        throw new Error(t('errors.fetch')); 
      }
      const data = await response.json();
      setUsers(data.users || []);
    } catch (error) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: t('errors.load'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleDeleteUser = (user: User) => {
    setUserToDelete(user);
    setDeleteModalOpened(true);
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
    } catch (error) {
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

      <DataTable
        withTableBorder
        borderRadius="sm"
        striped
        highlightOnHover
        records={users}
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
              user.invitedBy ? (
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
                <ActionIcon
                  color="red"
                  variant="subtle"
                  onClick={() => handleDeleteUser(user)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
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
