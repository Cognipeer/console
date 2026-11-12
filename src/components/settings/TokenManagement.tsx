'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Text } from '@mantine/core';
import { IconKey, IconTrash, IconAdjustments } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import CreateTokenModal from './CreateTokenModal';
import { useTranslations, useLocale } from '@/lib/i18n';
import { useConfirm } from '@/components/common/confirm';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import TokenDetailModal from '@/components/iam/tokens/TokenDetailModal';
import TokenStatusBadges from '@/components/iam/tokens/TokenStatusBadges';
import { isTokenExpired, type ApiTokenRow } from '@/components/iam/tokens/tokenModel';
import { formatRelative } from '@/components/iam/timeFormat';
import { tokenRoutes, useDeleteToken, useTokens } from '@/lib/api/queries/tokens';

export default function TokenManagement({ projectId }: { projectId?: string }) {
  const [createModalOpened, setCreateModalOpened] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const t = useTranslations('settings.tokenManagement');
  const tIam = useTranslations('iamTokens');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { confirmAction } = useConfirm();

  const routes = tokenRoutes(projectId);
  const tokensQuery = useTokens(projectId);
  const deleteToken = useDeleteToken(projectId);
  const tokens = useMemo(() => tokensQuery.data?.tokens ?? [], [tokensQuery.data]);
  const forbidden = tokensQuery.data?.forbidden ?? false;
  const loading = tokensQuery.isPending;
  const refetchTokens = tokensQuery.refetch;

  // A failed read keeps what was shown and says so once per failure.
  const failedAt = tokensQuery.errorUpdatedAt;
  const failed = tokensQuery.isError;
  useEffect(() => {
    if (!failed) return;
    notifications.show({
      title: tNotifications('errorTitle'),
      message: t('errors.load'),
      color: 'red',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedAt]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((token) =>
      [token.label, token.tokenPrefix]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [tokens, query]);

  const selected = useMemo(
    () => tokens.find((token) => String(token._id) === selectedId) ?? null,
    [tokens, selectedId],
  );

  const confirmDelete = async (token: ApiTokenRow) => {
    const done = await confirmAction({
      title: t('deleteModal.title'),
      message: t('deleteModal.description', {
        label: token.label ?? '',
      }),
      tone: 'danger',
      confirmLabel: t('deleteModal.confirm'),
      cancelLabel: t('deleteModal.cancel'),
      action: async () => {
        try {
          await deleteToken.mutateAsync(token._id);
        } catch {
          throw new Error(t('errors.delete'));
        }
      },
    });
    if (!done) return;
    notifications.show({
      title: tCommon('success'),
      message: t('messages.deleteSuccess'),
      color: 'green',
    });
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

  const columns: DataGridColumn<ApiTokenRow>[] = [
    {
      key: 'label',
      label: t('table.label'),
      render: (token) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{token.label}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {token.tokenPrefix ? `${token.tokenPrefix}...` : t('table.hidden')}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      label: tIam('table.status'),
      render: (token) => <TokenStatusBadges token={token} />,
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
      render: (token) => {
        const used = token.lastUsedAt ?? token.lastUsed;
        return (
          <span className="ds-faint" style={{ fontSize: 12 }}>
            {used ? new Date(used).toLocaleDateString() : t('table.never')}
          </span>
        );
      },
    },
    {
      key: 'expiresAt',
      label: tIam('table.expires'),
      width: 160,
      render: (token) => (
        <span
          className="ds-faint"
          style={{ fontSize: 12, color: isTokenExpired(token) ? 'var(--ds-err)' : undefined }}
        >
          {token.expiresAt ? formatRelative(token.expiresAt, locale) : tIam('table.noExpiry')}
        </span>
      ),
    },
  ];

  return (
    <>
      <DataGrid<ApiTokenRow>
        records={filtered}
        loading={loading}
        rowKey={(t) => String(t._id)}
        columns={columns}
        onRowClick={(token) => setSelectedId(String(token._id))}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: tIam('table.searchPlaceholder'),
        }}
        onRefresh={() => void refetchTokens()}
        refreshing={tokensQuery.isFetching}
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
        footerLeft={tIam('table.showing', { shown: filtered.length, total: tokens.length })}
        rowActions={(token) => [
          {
            id: 'details',
            label: tIam('table.details'),
            icon: <IconAdjustments size={14} />,
            onClick: () => setSelectedId(String(token._id)),
          },
          ...(token.canDelete === false
            ? []
            : [
                {
                  id: 'delete',
                  label: t('actions.delete'),
                  icon: <IconTrash size={14} />,
                  color: 'red' as const,
                  onClick: () => void confirmDelete(token),
                },
              ]),
        ]}
      />

      <CreateTokenModal
        opened={createModalOpened}
        onClose={() => setCreateModalOpened(false)}
        // Minting a token reloads the list (see `useCreateToken`); nothing more to do when the form closes.
        onSuccess={() => undefined}
        createUrl={routes.list}
      />

      <TokenDetailModal
        token={selected}
        onClose={() => setSelectedId(null)}
        // The saved token is merged into the cached list by `useUpdateToken`.
        onSaved={() => undefined}
        updateUrl={routes.item}
      />
    </>
  );
}
