'use client';

import { useEffect, useState } from 'react';
import { Button, Group, Text, ActionIcon, Box, Code, Modal, CopyButton, Tooltip } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconKey, IconTrash, IconCopy, IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import CreateTokenModal from './CreateTokenModal';
import { useTranslations } from '@/lib/i18n';

interface ApiToken {
  _id: string;
  label: string;
  token?: string;
  userId?: string;
  canDelete?: boolean;
  lastUsed?: string;
  createdAt: string;
}

export default function TokenManagement({ projectId }: { projectId?: string }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpened, setCreateModalOpened] = useState(false);
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [tokenToDelete, setTokenToDelete] = useState<ApiToken | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const t = useTranslations('settings.tokenManagement');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');

  const listUrl = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/tokens`
    : '/api/tokens';
  const deleteUrl = (id: string) =>
    projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/tokens/${encodeURIComponent(id)}`
      : `/api/tokens/${encodeURIComponent(id)}`;

  const fetchTokens = async () => {
    setLoading(true);
    try {
      const response = await fetch(listUrl);
      if (response.status === 403) {
        setForbidden(true);
        setTokens([]);
        return;
      }
      if (!response.ok) {
        throw new Error(t('errors.fetch'));
      }
      setForbidden(false);
      const data = await response.json();
      setTokens(data.tokens || []);
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
    fetchTokens();
  }, [listUrl]);

  const handleDeleteToken = (token: ApiToken) => {
    setTokenToDelete(token);
    setDeleteModalOpened(true);
  };

  const confirmDelete = async () => {
    if (!tokenToDelete) return;

    try {
      const response = await fetch(deleteUrl(tokenToDelete._id), { method: 'DELETE' });

      if (!response.ok) {
        throw new Error(t('errors.delete'));
      }

      notifications.show({
        title: tCommon('success'),
        message: t('messages.deleteSuccess'),
        color: 'green',
      });

      fetchTokens();
      setDeleteModalOpened(false);
      setTokenToDelete(null);
    } catch (error) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: t('errors.delete'),
        color: 'red',
      });
    }
  };

  const maskToken = (token: string) => {
    if (token.length <= 12) return token;
    return `${token.substring(0, 8)}...${token.substring(token.length - 4)}`;
  };

  return (
    <Box p="md">
      {forbidden ? (
        <Text size="sm" c="dimmed">
          {tCommon('forbidden')}
        </Text>
      ) : (
        <>
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
          leftSection={<IconKey size={16} />}
          onClick={() => setCreateModalOpened(true)}
        >
          {t('actions.create')}
        </Button>
      </Group>

      <DataTable
        withTableBorder
        borderRadius="sm"
        striped
        highlightOnHover
        records={tokens}
        columns={[
          {
            accessor: 'label',
            title: t('table.label'),
            render: (token) => (
              <div>
                <Text size="sm" fw={500}>
                  {token.label}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace">
                  {token.token ? maskToken(token.token) : t('table.hidden')}
                </Text>
              </div>
            ),
          },
          {
            accessor: 'createdAt',
            title: t('table.created'),
            render: (token) => new Date(token.createdAt).toLocaleDateString(),
          },
          {
            accessor: 'lastUsed',
            title: t('table.lastUsed'),
            render: (token) =>
              token.lastUsed ? new Date(token.lastUsed).toLocaleDateString() : t('table.never'),
          },
          {
            accessor: 'actions',
            title: t('table.actions'),
            textAlign: 'right',
            render: (token) => (
              <Group gap="xs" justify="flex-end">
                {token.token ? (
                  <CopyButton value={token.token}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? t('copy.copied') : t('copy.copyToken')}>
                        <ActionIcon
                          color={copied ? 'teal' : 'gray'}
                          variant="subtle"
                          onClick={copy}
                        >
                          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                ) : null}
                {token.canDelete === false ? null : (
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={() => handleDeleteToken(token)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                )}
              </Group>
            ),
          },
        ]}
        fetching={loading}
        minHeight={200}
        noRecordsText={t('table.empty')}
      />

      <CreateTokenModal
        opened={createModalOpened}
        onClose={() => setCreateModalOpened(false)}
        onSuccess={fetchTokens}
        createUrl={listUrl}
      />

      <Modal
        opened={deleteModalOpened}
        onClose={() => {
          setDeleteModalOpened(false);
          setTokenToDelete(null);
        }}
        title={t('deleteModal.title')}
        size="md"
      >
        <Text size="sm" mb="md">
          {t('deleteModal.description', {
            label: tokenToDelete?.label ?? '',
          })}
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button
            variant="default"
            onClick={() => {
              setDeleteModalOpened(false);
              setTokenToDelete(null);
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
      )}
    </Box>
  );
}
