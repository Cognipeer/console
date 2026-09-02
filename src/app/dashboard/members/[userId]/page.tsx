'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Badge, Button, Center, CopyButton, Group, Loader, Modal, Paper, SimpleGrid, Text } from '@mantine/core';
import { IconCheck, IconCopy, IconKey, IconMail, IconTrash, IconUser } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import DetailShell from '@/components/common/ui/DetailShell';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import CreateTokenModal from '@/components/settings/CreateTokenModal';
import { useTranslations } from '@/lib/i18n';
import type { UserServicePermissions } from '@/lib/security/rbac';

interface MemberDetail {
  _id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'project_admin' | 'user';
  canLogin?: boolean;
  servicePermissions?: UserServicePermissions;
  createdAt: string;
  invitedBy?: string;
  invitedAt?: string;
  inviteAcceptedAt?: string;
}

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

const ROLE_BADGE_COLOR: Record<string, string> = {
  owner: 'blue',
  admin: 'grape',
  project_admin: 'cyan',
  user: 'gray',
};

export default function MemberDetailPage() {
  const params = useParams<{ userId: string }>();
  const userId = params.userId;

  const t = useTranslations('settings.userManagement');
  const tTokens = useTranslations('settings.tokenManagement');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');

  const [user, setUser] = useState<MemberDetail | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [userNotFound, setUserNotFound] = useState(false);

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensForbidden, setTokensForbidden] = useState(false);
  const [query, setQuery] = useState('');

  const [createModalOpened, setCreateModalOpened] = useState(false);
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [tokenToDelete, setTokenToDelete] = useState<ApiToken | null>(null);

  const fetchUser = useCallback(async () => {
    setUserLoading(true);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(userId)}`);
      if (response.status === 404) {
        setUserNotFound(true);
        setUser(null);
        return;
      }
      if (!response.ok) {
        throw new Error('Failed to fetch user');
      }
      setUserNotFound(false);
      const data = await response.json();
      setUser(data.user);
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: 'Failed to load user',
        color: 'red',
      });
    } finally {
      setUserLoading(false);
    }
  }, [userId, tNotifications]);

  const fetchTokens = useCallback(async () => {
    setTokensLoading(true);
    try {
      const response = await fetch(`/api/tokens?userId=${encodeURIComponent(userId)}`);
      if (response.status === 403) {
        setTokensForbidden(true);
        setTokens([]);
        return;
      }
      if (!response.ok) {
        throw new Error(tTokens('errors.fetch'));
      }
      setTokensForbidden(false);
      const data = await response.json();
      setTokens(data.tokens || []);
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tTokens('errors.load'),
        color: 'red',
      });
    } finally {
      setTokensLoading(false);
    }
  }, [userId, tTokens, tNotifications]);

  useEffect(() => {
    void fetchUser();
    void fetchTokens();
  }, [fetchUser, fetchTokens]);

  const filteredTokens = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((token) =>
      [token.label, token.tokenPrefix]
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
      const response = await fetch(`/api/tokens/${encodeURIComponent(tokenToDelete._id)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(tTokens('errors.delete'));
      }

      notifications.show({
        title: tCommon('success'),
        message: tTokens('messages.deleteSuccess'),
        color: 'green',
      });

      fetchTokens();
      setDeleteModalOpened(false);
      setTokenToDelete(null);
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tTokens('errors.delete'),
        color: 'red',
      });
    }
  };

  const maskToken = (token: string) => {
    if (token.length <= 12) return token;
    return `${token.substring(0, 8)}...${token.substring(token.length - 4)}`;
  };

  const columns: DataGridColumn<ApiToken>[] = [
    {
      key: 'label',
      label: tTokens('table.label'),
      render: (token) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{token.label}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {token.token
              ? maskToken(token.token)
              : token.tokenPrefix
                ? `${token.tokenPrefix}...`
                : tTokens('table.hidden')}
          </span>
        </div>
      ),
    },
    {
      key: 'createdAt',
      label: tTokens('table.created'),
      width: 140,
      render: (token) => (
        <span className="ds-faint" style={{ fontSize: 12 }}>
          {new Date(token.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'lastUsed',
      label: tTokens('table.lastUsed'),
      width: 160,
      render: (token) => (
        <span className="ds-faint" style={{ fontSize: 12 }}>
          {token.lastUsed ? new Date(token.lastUsed).toLocaleDateString() : tTokens('table.never')}
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
                {copied ? tTokens('copy.copied') : tTokens('copy.copyToken')}
              </Button>
            )}
          </CopyButton>
        ) : null,
    },
  ];

  if (userLoading) {
    return (
      <Center p="xl" mt="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (userNotFound || !user) {
    return (
      <Center p="xl" mt="xl">
        <Text c="dimmed">User not found</Text>
      </Center>
    );
  }

  const servicePermissionEntries = Object.entries(user.servicePermissions ?? {}).filter(
    ([, level]) => level && level !== 'none',
  );

  return (
    <>
      <DetailShell
        backHref="/dashboard/members"
        backLabel="Back to Members"
        icon={
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              background: 'var(--ds-accent-soft)',
              color: 'var(--ds-accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <IconUser size={22} stroke={1.7} />
          </div>
        }
        title={
          <>
            <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
              {user.name}
            </h1>
            <Badge color={ROLE_BADGE_COLOR[user.role] ?? 'gray'} variant="light">
              {t(`roles.${user.role}`)}
            </Badge>
            {user.canLogin === false ? (
              <span className="ds-badge">{t('table.programmatic')}</span>
            ) : null}
          </>
        }
        meta={
          <span>
            {user.email || `— (${t('table.programmatic').toLowerCase()})`}
          </span>
        }
      >
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md" mb="md">
          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Email</Text>
            <Group gap={6} mt="xs" wrap="nowrap">
              <IconMail size={14} />
              <Text size="sm" fw={500} style={{ wordBreak: 'break-all' }}>
                {user.email || `— (${t('table.programmatic').toLowerCase()})`}
              </Text>
            </Group>
          </Paper>
          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Role</Text>
            <Badge size="lg" variant="light" color={ROLE_BADGE_COLOR[user.role] ?? 'gray'} mt="xs">
              {t(`roles.${user.role}`)}
            </Badge>
          </Paper>
          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Login status</Text>
            <Badge size="lg" variant="light" color={user.canLogin === false ? 'gray' : 'green'} mt="xs">
              {user.canLogin === false ? t('status.noLogin') : t('status.active')}
            </Badge>
          </Paper>
          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{t('table.joined')}</Text>
            <Text fw={500} size="sm" mt="xs">
              {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
            </Text>
          </Paper>
        </SimpleGrid>

        <Paper withBorder p="md" radius="md" mb="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Service permissions</Text>
          {servicePermissionEntries.length === 0 ? (
            <Text size="sm" c="dimmed">No per-service overrides — role defaults apply.</Text>
          ) : (
            <Group gap="xs">
              {servicePermissionEntries.map(([service, level]) => (
                <Badge key={service} size="sm" variant="light" color="blue">
                  {service}: {level}
                </Badge>
              ))}
            </Group>
          )}
        </Paper>

        <Group justify="space-between" align="center" mb="sm" mt="lg">
          <Text fw={600} size="lg">API Tokens</Text>
        </Group>

        {tokensForbidden ? (
          <div className="ds-empty" style={{ padding: 48 }}>
            <Text size="sm" c="dimmed">
              {tCommon('forbidden')}
            </Text>
          </div>
        ) : (
          <DataGrid<ApiToken>
            records={filteredTokens}
            loading={tokensLoading}
            rowKey={(tok) => String(tok._id)}
            columns={columns}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: 'Search tokens',
            }}
            onRefresh={() => void fetchTokens()}
            refreshing={tokensLoading}
            toolbarRight={
              <Button
                color="teal"
                size="xs"
                leftSection={<IconKey size={13} stroke={1.7} />}
                onClick={() => setCreateModalOpened(true)}
              >
                {tTokens('actions.create')}
              </Button>
            }
            empty={{
              title: tTokens('table.empty'),
              primaryAction: {
                label: tTokens('actions.create'),
                icon: <IconKey size={14} stroke={1.7} />,
                onClick: () => setCreateModalOpened(true),
              },
            }}
            footerLeft={`Showing ${filteredTokens.length} of ${tokens.length} tokens`}
            rowActions={(token) =>
              token.canDelete === false
                ? []
                : [
                    {
                      id: 'delete',
                      label: tTokens('actions.delete'),
                      icon: <IconTrash size={14} />,
                      color: 'red',
                      onClick: () => handleDeleteToken(token),
                    },
                  ]
            }
          />
        )}
      </DetailShell>

      <CreateTokenModal
        opened={createModalOpened}
        onClose={() => setCreateModalOpened(false)}
        onSuccess={fetchTokens}
        createUrl="/api/tokens"
        extraBody={{ userId: user._id }}
      />

      <Modal
        opened={deleteModalOpened}
        onClose={() => {
          setDeleteModalOpened(false);
          setTokenToDelete(null);
        }}
        title={tTokens('deleteModal.title')}
        size="md"
      >
        <Text size="sm" mb="md">
          {tTokens('deleteModal.description', {
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
            {tTokens('deleteModal.cancel')}
          </Button>
          <Button color="red" onClick={confirmDelete}>
            {tTokens('deleteModal.confirm')}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
