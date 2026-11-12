'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@mantine/core';
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
import { useDeleteResource } from '@/components/common/confirm';
import { errorMessage } from '@/lib/api/client';
import {
  useDeletePiiPolicy,
  usePiiPolicyList,
  useTogglePiiPolicy,
  type PiiPolicyView,
} from '@/lib/api/queries/pii';

const ACTION_BADGE: Record<string, string> = {
  detect: 'ds-badge-info',
  redact: 'ds-badge-warn',
  mask: 'ds-badge-teal',
  tokenize: 'ds-badge-grape',
  block: 'ds-badge-err',
};

export default function PiiPoliciesPage() {
  const router = useRouter();
  const t = useTranslations('pii');
  const tSafe = useTranslations('common.confirm.dataSafety');
  const deleteResource = useDeleteResource();
  const tAct = useTranslations('pii.actions');
  const tLang = useTranslations('pii.languages');

  const policiesQuery = usePiiPolicyList({ loadErrorTitle: t('notifications.loadError') });
  const toggleMutation = useTogglePiiPolicy();
  const deleteMutation = useDeletePiiPolicy();
  const policies = useMemo<PiiPolicyView[]>(() => policiesQuery.data ?? [], [policiesQuery.data]);
  // Only the first load shows the table's loading state; a refresh keeps the rows.
  const loading = policiesQuery.isPending;
  const refreshing = policiesQuery.isFetching;
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState('all');

  const loadPolicies = async () => {
    await policiesQuery.refetch();
  };

  const handleToggleEnabled = async (p: PiiPolicyView) => {
    try {
      await toggleMutation.mutateAsync({ id: p.id, enabled: !p.enabled });
      notifications.show({
        title: t('notifications.updated'),
        message: p.name,
        color: p.enabled ? 'orange' : 'teal',
      });
    } catch (err) {
      notifications.show({
        title: t('notifications.saveError'),
        message: errorMessage(err, ''),
        color: 'red',
      });
    }
  };

  const confirmDelete = (target: PiiPolicyView) =>
    deleteResource({
      noun: tSafe('nouns.piiPolicy'),
      name: target.name,
      type: 'pii-policy',
      id: target.id,
      action: async () => {
        await deleteMutation.mutateAsync(target.id);
        notifications.show({
          title: t('notifications.deleted'),
          message: target.name,
          color: 'red',
        });
      },
    });

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
            onClick: () => void confirmDelete(p),
          },
        ]}
      />

      <CreatePiiPolicyModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(p) => {
          router.push(`/dashboard/pii/${p.id}`);
        }}
      />
    </PageContainer>
  );
}
