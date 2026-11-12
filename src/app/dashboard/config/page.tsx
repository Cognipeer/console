'use client';

import { useMemo, useState } from 'react';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { IconEye, IconFolder, IconKey, IconLock, IconPlus, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import { useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import { useConfigGroups, useConfigItems, useDeleteConfigGroup, type ConfigGroupRow } from '@/lib/api/queries/config';
import CreateConfigGroupModal from '@/components/config/CreateConfigGroupModal';

interface GroupView extends ConfigGroupRow {
  itemCount: number;
  secretCount: number;
}

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export default function ConfigPage() {
  const t = useTranslations('config');
  const tSafe = useTranslations('common.confirm.dataSafety');
  const deleteResource = useDeleteResource();
  const router = useRouter();
  const groupsQuery = useConfigGroups();
  const itemsQuery = useConfigItems();
  const deleteGroup = useDeleteConfigGroup();
  const [createOpen, setCreateOpen] = useState(false);

  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  // First load, and a retry after a failure (a query without data starts over as pending).
  const loading = groupsQuery.isPending || itemsQuery.isPending;
  const loadFailed = groupsQuery.isError || itemsQuery.isError;
  const load = async () => {
    await Promise.all([groupsQuery.refetch(), itemsQuery.refetch()]);
  };

  const rows: GroupView[] = useMemo(() => {
    const counts = new Map<string, { items: number; secrets: number }>();
    for (const item of items) {
      const c = counts.get(item.groupId) ?? { items: 0, secrets: 0 };
      c.items += 1;
      if (item.isSecret) c.secrets += 1;
      counts.set(item.groupId, c);
    }
    return groups.map((g) => ({
      ...g,
      itemCount: counts.get(g._id)?.items ?? 0,
      secretCount: counts.get(g._id)?.secrets ?? 0,
    }));
  }, [groups, items]);

  const ctl = useTableControls(rows, {
    searchText: (g) => `${g.name} ${g.key} ${g.description ?? ''} ${(g.tags ?? []).join(' ')}`,
    searchPlaceholder: t('searchPlaceholder'),
  });

  const confirmDelete = async (group: GroupView) => {
    await deleteResource({
      noun: tSafe('nouns.configGroup'),
      name: group.name,
      type: 'config-group',
      id: group._id,
      extraWarning: tSafe('configGroupExtra'),
      action: async () => {
        try {
          await deleteGroup.mutateAsync(group._id);
        } catch (error) {
          throw new Error(errorMessage(error, t('deleteError')));
        }
        notifications.show({
          title: t('groupDeleted'),
          message: t('groupDeletedMessage'),
          color: 'teal',
        });
      },
    });
  };

  const columns: DataGridColumn<GroupView>[] = [
    {
      key: 'name',
      label: t('colGroup'),
      render: (g) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>{g.name}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{g.key}</span>
          {g.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {g.description.length > 60 ? `${g.description.slice(0, 60)}…` : g.description}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'items',
      label: t('colItems'),
      align: 'right',
      render: (g) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {g.itemCount}
        </span>
      ),
    },
    {
      key: 'secrets',
      label: t('colSecrets'),
      align: 'right',
      render: (g) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {g.secretCount}
        </span>
      ),
    },
    {
      key: 'tags',
      label: t('tags'),
      render: (g) =>
        (g.tags ?? []).length ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(g.tags ?? []).slice(0, 3).map((tag) => (
              <span key={tag} className="ds-badge">{tag}</span>
            ))}
          </div>
        ) : (
          <span className="ds-faint">—</span>
        ),
    },
    {
      key: 'updated',
      label: t('updatedAt'),
      render: (g) => (
        <span className="ds-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {formatDate(g.updatedAt || g.createdAt)}
        </span>
      ),
    },
  ];

  const totalSecrets = items.filter((i) => i.isSecret).length;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Configure · System"
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateOpen(true)}
          >
            {t('createGroup')}
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label={t('totalGroups')} value={groups.length} icon={<IconFolder size={14} />} />
        <StatTile label={t('totalItems')} value={items.length} icon={<IconKey size={14} />} />
        <StatTile label={t('secrets')} value={totalSecrets} icon={<IconLock size={14} />} />
      </div>

      <DataGrid<GroupView>
        records={ctl.records}
        loading={loading}
        rowKey={(g) => g._id}
        onRowClick={(g) => router.push(`/dashboard/config/${g._id}`)}
        columns={columns}
        search={ctl.search}
        pagination={ctl.pagination}
        onRefresh={() => void load()}
        empty={
          loadFailed
            ? {
                icon: <IconFolder size={26} stroke={1.7} />,
                title: t('loadFailed'),
                description: t('loadFailedDescription'),
                primaryAction: { label: t('retry'), onClick: () => void load() },
              }
            : ctl.query.trim()
              ? {
                  icon: <IconFolder size={26} stroke={1.7} />,
                  title: t('noResults'),
                  description: t('noResultsDescription'),
                  primaryAction: { label: t('clearSearch'), onClick: () => ctl.search?.onChange('') },
                }
              : {
                icon: <IconFolder size={26} stroke={1.7} />,
                title: t('noGroups'),
                description: t('noGroupsDescription'),
                primaryAction: {
                  label: t('createFirstGroup'),
                  icon: <IconPlus size={14} stroke={1.7} />,
                  onClick: () => setCreateOpen(true),
                },
              }
        }
        footerLeft={ctl.footerLeft(t('groupsNoun'))}
        rowActions={(g) => [
          {
            id: 'open',
            label: t('open'),
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/config/${g._id}`),
          },
          { divider: true },
          {
            id: 'delete',
            label: t('deleteGroup'),
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => void confirmDelete(g),
          },
        ]}
      />

      <CreateConfigGroupModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void load();
        }}
      />
    </PageContainer>
  );
}
