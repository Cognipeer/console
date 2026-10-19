'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Center, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useParams, useRouter } from 'next/navigation';
import {
  IconCopy,
  IconEdit,
  IconFolder,
  IconLock,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useDeleteResource, ResourceUsageSection } from '@/components/common/confirm';
import DetailShell from '@/components/common/ui/DetailShell';
import PageContainer from '@/components/common/ui/PageContainer';
import StatusBadge from '@/components/common/ui/StatusBadge';
import PropertiesPanel from '@/components/common/ui/PropertiesPanel';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import CreateConfigItemModal from '@/components/config/CreateConfigItemModal';
import EditConfigItemModal from '@/components/config/EditConfigItemModal';
import EditConfigGroupModal from '@/components/config/EditConfigGroupModal';

interface ConfigItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  value: string;
  valueType: string;
  isSecret: boolean;
  tags?: string[];
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ConfigGroup {
  _id: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  items: ConfigItem[];
  createdAt?: string;
  updatedAt?: string;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function ConfigGroupDetailPage() {
  const t = useTranslations('config');
  const tSafe = useTranslations('common.confirm.dataSafety');
  const deleteResource = useDeleteResource();
  const router = useRouter();
  const params = useParams<{ groupId: string }>()!;
  const groupId = params.groupId;

  const [group, setGroup] = useState<ConfigGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [createItemOpen, setCreateItemOpen] = useState(false);
  const [editGroupOpen, setEditGroupOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ConfigItem | null>(null);

  const items = useMemo(() => group?.items ?? [], [group?.items]);
  const totalSecrets = useMemo(() => items.filter((item) => item.isSecret).length, [items]);

  const ctl = useTableControls(items, {
    searchText: (i) => `${i.name} ${i.key} ${i.description ?? ''}`,
    searchPlaceholder: t('itemsSearchPlaceholder'),
  });

  const loadGroup = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await fetch(`/api/config/groups/${groupId}`, { cache: 'no-store' });

      if (!res.ok) {
        if (res.status === 404) {
          notifications.show({ title: t('error'), message: t('groupNotFound'), color: 'red' });
          router.push('/dashboard/config');
          return;
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('groupLoadFailed'));
      }

      const data = await res.json();
      setGroup(data.group as ConfigGroup);
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: error instanceof Error ? error.message : t('groupLoadFailed'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [groupId, router, t]);

  useEffect(() => {
    void loadGroup();
  }, [loadGroup]);

  const handleDeleteGroup = async () => {
    if (!group) return;
    await deleteResource({
      noun: tSafe('nouns.configGroup'),
      name: group.name,
      type: 'config-group',
      id: group._id,
      extraWarning: tSafe('configGroupExtra'),
      action: async () => {
        const res = await fetch(`/api/config/groups/${group._id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || t('deleteError'));
        }
        notifications.show({
          title: t('groupDeleted'),
          message: t('groupDeletedMessage'),
          color: 'teal',
        });
        router.push('/dashboard/config');
      },
    });
  };

  const handleDeleteItem = async (item: ConfigItem) => {
    await deleteResource({
      noun: tSafe('nouns.configItem'),
      name: item.name || item.key,
      type: 'config-item',
      id: item._id,
      action: async () => {
        const res = await fetch(`/api/config/items/${item._id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || t('deleteError'));
        }
        notifications.show({
          title: t('itemDeleted'),
          message: t('itemDeletedMessage'),
          color: 'teal',
        });
        await loadGroup();
      },
    });
  };

  const handleCopyKey = async (item: ConfigItem) => {
    try {
      await navigator.clipboard.writeText(item.key);
      notifications.show({ title: t('keyCopied'), message: item.key, color: 'teal' });
    } catch {
      notifications.show({ title: t('error'), message: item.key, color: 'red' });
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <Center mih={240}>
          <Loader />
        </Center>
      </PageContainer>
    );
  }

  if (!group) {
    return (
      <PageContainer>
        <Center mih={240}>
          <div className="ds-empty">
            <div className="ds-empty-title">{t('groupNotFound')}</div>
            <Button variant="default" onClick={() => router.push('/dashboard/config')}>
              {t('backToGroups')}
            </Button>
          </div>
        </Center>
      </PageContainer>
    );
  }

  const columns: DataGridColumn<ConfigItem>[] = [
    {
      key: 'name',
      label: t('itemName'),
      render: (item) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>{item.name}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{item.key}</span>
          {item.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {item.description.length > 60 ? `${item.description.slice(0, 60)}…` : item.description}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'type',
      label: t('valueType'),
      render: (item) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <span className="ds-badge">{item.valueType}</span>
          {item.isSecret ? (
            <StatusBadge status="err" label={t('secretBadge')} withDot={false} />
          ) : null}
        </div>
      ),
    },
    {
      key: 'value',
      label: t('value'),
      render: (item) =>
        item.isSecret ? (
          <span className="ds-badge">{t('masked')}</span>
        ) : (
          <span
            className="ds-mono"
            style={{
              fontSize: 12,
              display: 'inline-block',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'bottom',
            }}
            title={item.value}
          >
            {item.value}
          </span>
        ),
    },
    {
      key: 'version',
      label: t('version'),
      align: 'right',
      render: (item) => (
        <span className="ds-mono" style={{ fontSize: 12.5 }}>v{item.version}</span>
      ),
    },
    {
      key: 'updated',
      label: t('updatedAt'),
      render: (item) => (
        <span className="ds-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {formatDate(item.updatedAt || item.createdAt)}
        </span>
      ),
    },
  ];

  const actions = (
    <>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconEdit size={14} stroke={1.7} />}
        onClick={() => setEditGroupOpen(true)}
      >
        {t('editGroup')}
      </Button>
      <Button
        size="sm"
        leftSection={<IconPlus size={14} stroke={1.7} />}
        onClick={() => setCreateItemOpen(true)}
      >
        {t('createItem')}
      </Button>
      <Button
        color="red"
        variant="light"
        size="sm"
        leftSection={<IconTrash size={14} stroke={1.7} />}
        onClick={() => void handleDeleteGroup()}
      >
        {t('deleteGroup')}
      </Button>
    </>
  );

  return (
    <DetailShell
      backHref="/dashboard/config"
      backLabel={t('backToConfig')}
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
          <IconFolder size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
            {group.name}
          </h1>
          <StatusBadge
            status="info"
            label={`${items.length} ${t('items')}`}
            withDot={false}
          />
          {totalSecrets > 0 ? (
            <StatusBadge
              status="err"
              label={`${totalSecrets} ${t('secrets')}`}
              withDot={false}
            />
          ) : null}
        </>
      }
      meta={
        <>
          <span className="ds-mono">{group.key}</span>
          {group.description ? (
            <>
              <span className="ds-faint">·</span>
              <span>{group.description}</span>
            </>
          ) : null}
        </>
      }
      actions={actions}
    >
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 480px', minWidth: 0 }}>
          <DataGrid<ConfigItem>
            records={ctl.records}
            rowKey={(item) => item._id}
            columns={columns}
            search={ctl.search}
            pagination={ctl.pagination}
            onRefresh={() => void loadGroup()}
            toolbarRight={
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlus size={13} stroke={1.7} />}
                onClick={() => setCreateItemOpen(true)}
              >
                {t('createItem')}
              </Button>
            }
            empty={{
              icon: <IconLock size={26} stroke={1.7} />,
              title: t('noItems'),
              description: t('noItemsDescription'),
              primaryAction: {
                label: t('createFirstItem'),
                icon: <IconPlus size={14} stroke={1.7} />,
                onClick: () => setCreateItemOpen(true),
              },
            }}
            footerLeft={ctl.footerLeft(t('itemsNoun'))}
            rowActions={(item) => [
              {
                id: 'edit',
                label: t('editItem'),
                icon: <IconEdit size={14} />,
                onClick: () => setEditingItem(item),
              },
              {
                id: 'copy',
                label: t('copyKey'),
                icon: <IconCopy size={14} />,
                onClick: () => void handleCopyKey(item),
              },
              { divider: true },
              {
                id: 'delete',
                label: t('deleteItem'),
                icon: <IconTrash size={14} />,
                color: 'red',
                onClick: () => void handleDeleteItem(item),
              },
            ]}
          />
          <div style={{ marginTop: 16 }}>
            <ResourceUsageSection type="config-group" id={group._id} />
          </div>
        </div>

        <PropertiesPanel
          title={t('properties')}
          rows={[
            { key: 'key', label: t('groupKey'), value: <span className="ds-mono">{group.key}</span> },
            { key: 'description', label: t('description'), value: group.description || '—' },
            {
              key: 'tags',
              label: t('tags'),
              value: (group.tags ?? []).length ? (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {(group.tags ?? []).map((tag) => (
                    <span key={tag} className="ds-badge">{tag}</span>
                  ))}
                </div>
              ) : (
                '—'
              ),
            },
            { key: 'created', label: t('createdAt'), value: formatDate(group.createdAt) },
            { key: 'updated', label: t('updatedAt'), value: formatDate(group.updatedAt) },
          ]}
        />
      </div>

      <CreateConfigItemModal
        opened={createItemOpen}
        groupId={group._id}
        onClose={() => setCreateItemOpen(false)}
        onCreated={() => {
          setCreateItemOpen(false);
          void loadGroup();
        }}
      />

      <EditConfigGroupModal
        opened={editGroupOpen}
        group={group}
        onClose={() => setEditGroupOpen(false)}
        onUpdated={() => {
          setEditGroupOpen(false);
          void loadGroup();
        }}
      />

      <EditConfigItemModal
        opened={editingItem !== null}
        item={editingItem}
        onClose={() => setEditingItem(null)}
        onUpdated={() => {
          setEditingItem(null);
          void loadGroup();
        }}
      />
    </DetailShell>
  );
}
