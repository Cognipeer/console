'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

export default function TokenManagement({ projectId }: { projectId?: string }) {
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpened, setCreateModalOpened] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [query, setQuery] = useState('');
  const t = useTranslations('settings.tokenManagement');
  const tIam = useTranslations('iamTokens');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { confirmAction } = useConfirm();

  const listUrl = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/tokens`
    : '/api/tokens';
  const itemUrl = (id: string) =>
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
        const response = await fetch(itemUrl(token._id), { method: 'DELETE' });
        if (!response.ok) throw new Error(t('errors.delete'));
      },
    });
    if (!done) return;
    notifications.show({
      title: tCommon('success'),
      message: t('messages.deleteSuccess'),
      color: 'green',
    });
    fetchTokens();
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
        onSuccess={fetchTokens}
        createUrl={listUrl}
      />

      <TokenDetailModal
        token={selected}
        onClose={() => setSelectedId(null)}
        onSaved={(saved) =>
          setTokens((current) =>
            current.map((token) => (String(token._id) === String(saved._id) ? { ...token, ...saved } : token)),
          )
        }
        updateUrl={itemUrl}
      />
    </>
  );
}
