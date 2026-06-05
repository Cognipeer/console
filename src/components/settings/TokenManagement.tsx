'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Group, Text, Modal, CopyButton } from '@mantine/core';
import { IconKey, IconTrash, IconCopy, IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import CreateTokenModal from './CreateTokenModal';
import { useTranslations } from '@/lib/i18n';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

interface ApiToken {
  _id: string;
  label: string;
  token?: string;
  tokenPrefix?: string;
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
  const [query, setQuery] = useState('');
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

  const fetchTokens = useCallback(async () => {
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
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: t('errors.load'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [listUrl, t, tNotifications]);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((token) =>
      [token.label, token.tokenPrefix, token.userId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [tokens, query]);

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
    } catch {
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

  if (forbidden) {
    return (
      <div className="ds-empty" style={{ padding: 48 }}>
        <Text size="sm" c="dimmed">
          {tCommon('forbidden')}
        </Text>
      </div>
    );
  }

  const columns: DataGridColumn<ApiToken>[] = [
    {
      key: 'label',
      label: t('table.label'),
      render: (token) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{token.label}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {token.token
              ? maskToken(token.token)
              : token.tokenPrefix
                ? `${token.tokenPrefix}...`
                : t('table.hidden')}
          </span>
        </div>
      ),
    },
    {
      key: 'createdAt',
      label: t('table.created'),
      width: 140,
      render: (token) => (
        <span className="ds-faint" style={{ fontSize: 12 }}>
          {new Date(token.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'lastUsed',
      label: t('table.lastUsed'),
      width: 160,
      render: (token) => (
        <span className="ds-faint" style={{ fontSize: 12 }}>
          {token.lastUsed ? new Date(token.lastUsed).toLocaleDateString() : t('table.never')}
        </span>
      ),
    },
    {
      key: 'copy',
      label: '',
      width: 60,
      align: 'right',
      render: (token) =>
        token.token ? (
          <CopyButton value={token.token}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                variant="subtle"
                color={copied ? 'teal' : 'gray'}
                onClick={(e) => {
                  e.stopPropagation();
                  copy();
                }}
                leftSection={copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              >
                {copied ? t('copy.copied') : t('copy.copyToken')}
              </Button>
            )}
          </CopyButton>
        ) : null,
    },
  ];

  return (
    <>
      <DataGrid<ApiToken>
        records={filtered}
        loading={loading}
        rowKey={(t) => String(t._id)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search tokens',
        }}
        onRefresh={() => void fetchTokens()}
        refreshing={loading}
        toolbarRight={
          <Button
            color="teal"
            size="xs"
            leftSection={<IconKey size={13} stroke={1.7} />}
            onClick={() => setCreateModalOpened(true)}
          >
            {t('actions.create')}
          </Button>
        }
        empty={{
          title: t('table.empty'),
          primaryAction: {
            label: t('actions.create'),
            icon: <IconKey size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpened(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${tokens.length} tokens`}
        rowActions={(token) =>
          token.canDelete === false
            ? []
            : [
                {
                  id: 'delete',
                  label: t('actions.delete'),
                  icon: <IconTrash size={14} />,
                  color: 'red',
                  onClick: () => handleDeleteToken(token),
                },
              ]
        }
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
  );
}
