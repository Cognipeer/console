'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconEdit,
  IconEye,
  IconLock,
  IconPlayerPlay,
  IconPlus,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreatePiiPolicyModal from '@/components/pii/CreatePiiPolicyModal';
import { useTranslations } from '@/lib/i18n';

interface PiiPolicyView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  defaultAction: 'detect' | 'redact' | 'mask' | 'block';
  categories: Record<string, boolean>;
  languages?: string[];
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const ACTION_BADGE: Record<string, string> = {
  detect: 'ds-badge-info',
  redact: 'ds-badge-warn',
  mask: 'ds-badge-teal',
  block: 'ds-badge-err',
};

export default function PiiPoliciesPage() {
  const router = useRouter();
  const t = useTranslations('pii');
  const tAct = useTranslations('pii.actions');
  const tLang = useTranslations('pii.languages');

  const [policies, setPolicies] = useState<PiiPolicyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PiiPolicyView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState('all');

  const loadPolicies = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/pii/policies', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setPolicies(data.policies ?? []);
      } else {
        notifications.show({ title: t('notifications.loadError'), message: '', color: 'red' });
      }
    } catch (err) {
      console.error('Failed to load PII policies', err);
      notifications.show({
        title: t('notifications.loadError'),
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { void loadPolicies(); }, []);

  const handleToggleEnabled = async (p: PiiPolicyView) => {
    try {
      const res = await fetch(`/api/pii/policies/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !p.enabled }),
      });
      if (!res.ok) throw new Error('Failed to update');
      notifications.show({
        title: t('notifications.updated'),
        message: p.name,
        color: p.enabled ? 'orange' : 'teal',
      });
      await loadPolicies();
    } catch (err) {
      notifications.show({
        title: t('notifications.saveError'),
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/pii/policies/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: t('notifications.deleted'),
        message: deleteTarget.name,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadPolicies();
    } catch (err) {
      notifications.show({
        title: t('notifications.saveError'),
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  const filtered = useMemo(() => policies.filter((p) => {
    if (enabledFilter === 'enabled' && !p.enabled) return false;
    if (enabledFilter === 'disabled' && p.enabled) return false;
    if (query) {
      const q = query.toLowerCase();
      if (
        !p.name.toLowerCase().includes(q)
        && !p.key.toLowerCase().includes(q)
        && !(p.description ?? '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  }), [policies, query, enabledFilter]);

  const total = policies.length;
  const enabled = policies.filter((p) => p.enabled).length;
  const allLanguages = useMemo(() => {
    const set = new Set<string>();
    for (const p of policies) {
      for (const l of p.languages ?? []) set.add(l);
    }
    return set.size;
  }, [policies]);

  const columns: DataGridColumn<PiiPolicyView>[] = [
    {
      key: 'name',
      label: t('page.columns.name'),
      render: (p) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)', opacity: p.enabled ? 1 : 0.6 }}>
            {p.name}
          </span>
          {p.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {p.description.length > 60 ? `${p.description.slice(0, 60)}…` : p.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{p.key}</span>
          )}
        </div>
      ),
    },
    {
      key: 'defaultAction',
      label: t('page.columns.defaultAction'),
      render: (p) => (
        <span className={`ds-badge ${ACTION_BADGE[p.defaultAction] ?? ''}`}>
          {tAct(p.defaultAction)}
        </span>
      ),
    },
    {
      key: 'categories',
      label: t('page.columns.categories'),
      render: (p) => {
        const on = Object.values(p.categories || {}).filter(Boolean).length;
        const totalCats = Object.keys(p.categories || {}).length;
        return (
          <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
            {on}/{totalCats}
          </span>
        );
      },
    },
    {
      key: 'languages',
      label: t('page.columns.languages'),
      render: (p) => {
        if (!p.languages?.length) return <span className="ds-faint">{tLang('global')}</span>;
        return (
          <span style={{ fontSize: 12 }}>
            {p.languages.slice(0, 3).map((l) => tLang(l)).join(', ')}
            {p.languages.length > 3 ? ` +${p.languages.length - 3}` : ''}
          </span>
        );
      },
    },
    {
      key: 'status',
      label: t('page.columns.status'),
      render: (p) => <StatusBadge status={p.enabled ? 'active' : 'paused'} />,
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('page.eyebrow')}
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateOpen(true)}
          >
            {t('page.newPolicy')}
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label={t('page.stats.total')} icon={<IconLock size={14} stroke={1.7} />} value={total} />
        <StatTile label={t('page.stats.enabled')} value={enabled} />
        <StatTile label={t('page.stats.disabled')} value={total - enabled} />
        <StatTile label={t('page.stats.languages')} value={allLanguages} />
      </div>

      <DataGrid<PiiPolicyView>
        records={filtered}
        loading={loading}
        rowKey={(p) => p.id}
        onRowClick={(p) => router.push(`/dashboard/pii/${p.id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t('page.filters.searchPlaceholder'),
        }}
        filters={[
          {
            value: enabledFilter,
            onChange: setEnabledFilter,
            ariaLabel: 'Filter by enabled state',
            width: 140,
            options: [
              { value: 'all', label: t('page.filters.all') },
              { value: 'enabled', label: t('page.filters.enabled') },
              { value: 'disabled', label: t('page.filters.disabled') },
            ],
          },
        ]}
        onRefresh={loadPolicies}
        refreshing={refreshing}
        empty={{
          icon: <IconLock size={26} stroke={1.7} />,
          title: t('page.empty.title'),
          description: t('page.empty.description'),
          primaryAction: {
            label: t('page.empty.action'),
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateOpen(true),
          },
        }}
        footerLeft={`${filtered.length} / ${total}`}
        rowActions={(p) => [
          {
            id: 'view',
            label: t('detail.tabs.config'),
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/pii/${p.id}`),
          },
          {
            id: 'edit',
            label: t('detail.tabs.config'),
            icon: <IconEdit size={14} />,
            onClick: () => router.push(`/dashboard/pii/${p.id}`),
          },
          {
            id: 'toggle',
            label: p.enabled ? t('detail.actions.toggleDisable') : t('detail.actions.toggleEnable'),
            icon: p.enabled ? <IconShieldOff size={14} /> : <IconPlayerPlay size={14} />,
            onClick: () => void handleToggleEnabled(p),
          },
          { divider: true },
          {
            id: 'delete',
            label: t('detail.actions.delete'),
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(p),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('deleteModal.title')}
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          {t('deleteModal.body', { name: deleteTarget?.name ?? '' })}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            {t('deleteModal.cancel')}
          </Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>
            {t('deleteModal.confirm')}
          </Button>
        </Group>
      </Modal>

      <CreatePiiPolicyModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(p) => {
          void loadPolicies();
          router.push(`/dashboard/pii/${p.id}`);
        }}
      />
    </PageContainer>
  );
}
