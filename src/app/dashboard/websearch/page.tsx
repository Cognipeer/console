'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconEdit,
  IconEye,
  IconLock,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconWorldSearch,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import { isApiError } from '@/lib/api/client';
import { failureText } from '@/lib/api/queries/models';
import { useDeleteWebSearchInstance, useWebSearchProviders } from '@/lib/api/queries/websearch';
import { useDeleteResource } from '@/components/common/confirm';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import WebSearchInstanceCreate from '@/components/websearch/WebSearchInstanceCreate';
import WebSearchInstanceFormModal from '@/components/websearch/WebSearchInstanceFormModal';
import {
  canManageWebSearch,
  hasAiAnswer,
  hasCache,
  instanceOfRow,
  isUnavailable,
  listRows,
  rowAbilities,
  type WebSearchListRow,
} from '@/components/websearch/webSearchModel';
import type { WebSearchInstanceView } from '@/lib/services/webSearch/webSearchInstanceView';

const detailHref = (row: WebSearchListRow) => `/dashboard/websearch/${encodeURIComponent(row.key)}`;

export default function WebSearchListPage() {
  const router = useRouter();
  const t = useTranslations('webSearch.list');
  const tScope = useTranslations('webSearch.scope');
  const tNoInstance = useTranslations('webSearch.noInstance');
  const tPlatform = useTranslations('webSearch.platform');
  const tConfirm = useTranslations('common.confirm');
  const deleteResource = useDeleteResource();
  const canManage = canManageWebSearch(useDashboardUser()?.role);

  const listQuery = useWebSearchProviders();
  const rows = useMemo(() => listRows(listQuery.data ?? []), [listQuery.data]);
  const loading = listQuery.isPending;
  const refreshing = listQuery.isFetching && !listQuery.isPending;
  // A role without web search access: say so instead of a load error and an empty list that offers to create.
  const forbidden = isApiError(listQuery.error) && listQuery.error.status === 403;
  const deleteInstance = useDeleteWebSearchInstance();
  const [query, setQuery] = useState('');
  // Creating: open, and the provider picked to start with (a row that has no instance yet).
  const [creating, setCreating] = useState<{ providerKey: string | null } | null>(null);
  const [editing, setEditing] = useState<WebSearchInstanceView | null>(null);

  const { refetch: refetchList, isError: listFailed } = listQuery;
  useEffect(() => {
    if (!listFailed || forbidden) return;
    notifications.show({ color: 'red', title: t('title'), message: t('loadFailed') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFailed, forbidden]);

  const summary = useMemo(() => {
    const instances = rows.filter((row) => row.kind === 'instance');
    return {
      total: instances.length,
      active: instances.filter((row) => row.status === 'active').length,
      aiEnabled: instances.filter((row) => hasAiAnswer(row.settings)).length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    if (!query) return rows;
    const q = query.toLowerCase();
    return rows.filter((row) =>
      [row.label, row.key, row.driver, row.provider?.label ?? '', row.providerKey ?? '']
        .some((value) => value.toLowerCase().includes(q)));
  }, [rows, query]);

  const openCreate = (providerKey: string | null = null) => setCreating({ providerKey });

  async function confirmDelete(row: WebSearchListRow) {
    const deleted = await deleteResource({
      noun: tConfirm('nouns.websearchInstance'),
      name: row.label,
      type: 'websearch-instance',
      id: String(row._id),
      extraWarning: tConfirm('extras.websearchKeyFails'),
      action: async () => {
        try {
          await deleteInstance.mutateAsync(row.key);
        } catch (error) {
          throw new Error(failureText(error, t('deleteFailed')));
        }
      },
    });
    if (!deleted) return;
    notifications.show({ color: 'teal', title: t('deleted'), message: row.label });
  }

  const platformBadge = <span className="ds-badge ds-badge-info">{tPlatform('badge')}</span>;

  const columns: DataGridColumn<WebSearchListRow>[] = [
    {
      key: 'label',
      label: t('colInstance'),
      render: (row) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>{row.label}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{row.key}</span>
          {row.kind === 'provider' ? (
            <span className="ds-badge ds-badge-warn" title={tNoInstance('hint')} style={{ alignSelf: 'flex-start' }}>
              {tNoInstance('badge')}
            </span>
          ) : null}
          {row.kind === 'instance' && row.platform ? <span style={{ alignSelf: 'flex-start' }}>{platformBadge}</span> : null}
        </div>
      ),
    },
    {
      key: 'provider',
      label: t('colProvider'),
      render: (row) => {
        // A provider row is the provider itself.
        const provider = row.kind === 'provider'
          ? { label: row.label, key: row.key, platform: row.platform === true }
          : row.provider ? { label: row.provider.label, key: row.provider.key, platform: row.provider.platform } : null;
        if (!provider) return <span className="ds-faint ds-mono" style={{ fontSize: 12 }}>{row.providerKey ?? '—'}</span>;
        return (
          <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: 12.5 }}>{provider.label}</span>
            {provider.platform ? <span style={{ alignSelf: 'flex-start' }}>{platformBadge}</span> : (
              <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{provider.key}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'driver',
      label: t('colEngine'),
      render: (row) => <span className="ds-badge">{row.driver || '—'}</span>,
    },
    {
      key: 'ai',
      label: t('colAi'),
      render: (row) =>
        hasAiAnswer(row.settings) ? (
          <span className="ds-badge ds-badge-ok">
            <IconSparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
            {t('on')}
          </span>
        ) : (
          <span className="ds-faint">{t('off')}</span>
        ),
    },
    {
      key: 'cache',
      label: t('colCache'),
      render: (row) =>
        hasCache(row.settings)
          ? <span className="ds-badge ds-badge-ok">{t('on')}</span>
          : <span className="ds-faint">{t('off')}</span>,
    },
    {
      key: 'scope',
      label: t('colScope'),
      render: (row) =>
        row.kind === 'instance'
          ? <span style={{ fontSize: 12.5 }}>{row.tenantWide ? tScope('tenant') : tScope('project')}</span>
          : <span className="ds-faint">—</span>,
    },
    {
      key: 'status',
      label: t('colStatus'),
      render: (row) => (
        <span className="ds-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <StatusBadge status={row.status === 'active' ? 'active' : 'paused'} />
          {isUnavailable(row) ? (
            <span className="ds-badge ds-badge-warn" title={tPlatform('unavailableHint')}>
              {tPlatform('unavailable')}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  if (forbidden) {
    return (
      <PageContainer>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />
        <Alert color="blue" variant="light" icon={<IconLock size={16} />} title={t('noAccessTitle')}>
          {t('noAccessDescription')}
        </Alert>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={canManage ? (
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => openCreate()}
          >
            {t('create')}
          </Button>
        ) : undefined}
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label={t('statInstances')}
          icon={<IconWorldSearch size={14} stroke={1.7} />}
          value={summary.total}
        />
        <StatTile label={t('statActive')} value={summary.active} />
        <StatTile label={t('statAi')} value={summary.aiEnabled} />
      </div>

      <DataGrid<WebSearchListRow>
        records={filtered}
        loading={loading}
        rowKey={(row) => `${row.kind}:${row.key}`}
        onRowClick={(row) => router.push(detailHref(row))}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t('searchPlaceholder'),
        }}
        onRefresh={() => void refetchList()}
        refreshing={refreshing}
        empty={{
          icon: <IconWorldSearch size={26} stroke={1.7} />,
          title: t('emptyTitle'),
          description: t('emptyDescription'),
          primaryAction: canManage
            ? {
              label: t('emptyAction'),
              icon: <IconPlus size={14} stroke={1.7} />,
              onClick: () => openCreate(),
            }
            : undefined,
        }}
        footerLeft={t('footer', { shown: filtered.length, total: rows.length })}
        rowActions={(row) => {
          const can = rowAbilities(row, canManage);
          return [
            {
              id: 'open',
              label: t('open'),
              icon: <IconEye size={14} />,
              onClick: () => router.push(detailHref(row)),
            },
            {
              id: 'create-instance',
              label: tNoInstance('action'),
              icon: <IconPlus size={14} />,
              hidden: !can.createInstance,
              onClick: () => openCreate(row.key),
            },
            {
              id: 'edit',
              label: t('edit'),
              icon: <IconEdit size={14} />,
              hidden: !can.edit,
              onClick: () => setEditing(instanceOfRow(row)),
            },
            {
              id: 'delete',
              label: t('delete'),
              icon: <IconTrash size={14} />,
              color: 'red',
              divider: true,
              hidden: !can.remove,
              onClick: () => void confirmDelete(row),
            },
          ];
        }}
      />

      <WebSearchInstanceCreate
        opened={creating !== null}
        onClose={() => setCreating(null)}
        initialProviderKey={creating?.providerKey ?? null}
        onCreated={(instance) => {
          setCreating(null);
          router.push(`/dashboard/websearch/${encodeURIComponent(instance.key)}`);
        }}
      />

      <WebSearchInstanceFormModal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        mode="edit"
        instance={editing}
        resetKey={editing?.key ?? ''}
        onSaved={() => {
          setEditing(null);
        }}
      />
    </PageContainer>
  );
}
