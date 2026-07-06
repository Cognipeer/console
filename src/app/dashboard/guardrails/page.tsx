'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconEdit,
  IconEye,
  IconListDetails,
  IconPlayerPlay,
  IconPlus,
  IconShield,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateGuardrailModal from '@/components/guardrails/CreateGuardrailModal';
import WordListsManager from '@/components/guardrails/WordListsManager';
import type { GuardrailView } from '@/lib/services/guardrail/constants';

interface ModelOption {
  value: string;
  label: string;
}

const ACTION_LABELS: Record<string, string> = {
  block: 'Block',
  warn: 'Warn',
  flag: 'Flag',
  redact: 'Redact',
};

const ACTION_BADGE: Record<string, string> = {
  block: 'ds-badge-err',
  warn: 'ds-badge-warn',
  flag: 'ds-badge-info',
  redact: 'ds-badge-info',
};

export default function GuardrailsPage() {
  const router = useRouter();
  const [guardrails, setGuardrails] = useState<GuardrailView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [wordListsOpen, setWordListsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GuardrailView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [enabledFilter, setEnabledFilter] = useState('all');

  const loadGuardrails = async () => {
    setRefreshing(true);
    try {
      const [grRes, modelsRes] = await Promise.all([
        fetch('/api/guardrails', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);
      if (grRes.ok) {
        const data = await grRes.json();
        setGuardrails(data.guardrails ?? []);
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setModels(
          (data.models ?? []).map((m: { key: string; name: string }) => ({
            value: m.key,
            label: m.name,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load guardrails', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadGuardrails();
  }, []);

  const handleToggleEnabled = async (g: GuardrailView) => {
    try {
      const res = await fetch(`/api/guardrails/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !g.enabled }),
      });
      if (!res.ok) throw new Error('Failed to update guardrail');
      notifications.show({
        title: g.enabled ? 'Guardrail disabled' : 'Guardrail enabled',
        message: `"${g.name}" has been ${g.enabled ? 'disabled' : 'enabled'}`,
        color: g.enabled ? 'orange' : 'teal',
      });
      await loadGuardrails();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/guardrails/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Guardrail deleted',
        message: `"${deleteTarget.name}" was deleted`,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadGuardrails();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  const filtered = useMemo(() => {
    return guardrails.filter((g) => {
      if (typeFilter !== 'all' && g.type !== typeFilter) return false;
      if (actionFilter !== 'all' && g.action !== actionFilter) return false;
      if (enabledFilter === 'enabled' && !g.enabled) return false;
      if (enabledFilter === 'disabled' && g.enabled) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !g.name.toLowerCase().includes(q) &&
          !g.key.toLowerCase().includes(q) &&
          !(g.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [guardrails, query, typeFilter, actionFilter, enabledFilter]);

  const grCtl = useTableControls(filtered, {
    filterKey: `${query}|${typeFilter}|${actionFilter}|${enabledFilter}`,
  });

  const total = guardrails.length;
  const enabled = guardrails.filter((g) => g.enabled).length;
  const blockCount = guardrails.filter((g) => g.action === 'block').length;

  const modelLabel = (key?: string) => {
    if (!key) return '—';
    return models.find((m) => m.value === key)?.label ?? key;
  };

  const columns: DataGridColumn<GuardrailView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (g) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--ds-text)',
              opacity: g.enabled ? 1 : 0.6,
            }}
          >
            {g.name}
          </span>
          {g.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {g.description.length > 60
                ? `${g.description.slice(0, 60)}…`
                : g.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {g.key}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (g) => (
        <span className={`ds-badge ${g.type === 'preset' ? 'ds-badge-info' : 'ds-badge-teal'}`}>
          {g.type === 'preset' ? 'Preset' : 'Custom'}
        </span>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      render: (g) => (
        <span className={`ds-badge ${ACTION_BADGE[g.action] ?? ''}`}>
          {ACTION_LABELS[g.action] ?? g.action}
        </span>
      ),
    },
    {
      key: 'model',
      label: 'Model',
      render: (g) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {modelLabel(g.modelKey)}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (g) => (
        <StatusBadge status={g.enabled ? 'active' : 'paused'} />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Guardrails"
        title="Guardrails"
        subtitle="Safety policies applied to model inputs and outputs. Block, warn, or flag traffic that matches a policy."
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              leftSection={<IconListDetails size={14} stroke={1.7} />}
              onClick={() => setWordListsOpen(true)}
            >
              Word lists
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlus size={14} stroke={1.7} />}
              onClick={() => setCreateModalOpen(true)}
            >
              New guardrail
            </Button>
          </Group>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total guardrails"
          icon={<IconShield size={14} stroke={1.7} />}
          value={total}
        />
        <StatTile label="Enabled" value={enabled} />
        <StatTile label="Disabled" value={total - enabled} />
        <StatTile label="Blocking" value={blockCount} />
      </div>

      <DataGrid<GuardrailView>
        records={grCtl.records}
        loading={loading}
        rowKey={(g) => g.id}
        onRowClick={(g) => router.push(`/dashboard/guardrails/${g.id}`)}
        columns={columns}
        pagination={grCtl.pagination}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by name, key, or description…',
        }}
        filters={[
          {
            value: typeFilter,
            onChange: setTypeFilter,
            ariaLabel: 'Filter by type',
            width: 140,
            options: [
              { value: 'all', label: 'All types' },
              { value: 'preset', label: 'Preset' },
              { value: 'custom', label: 'Custom' },
            ],
          },
          {
            value: actionFilter,
            onChange: setActionFilter,
            ariaLabel: 'Filter by action',
            width: 140,
            options: [
              { value: 'all', label: 'All actions' },
              { value: 'block', label: 'Block' },
              { value: 'warn', label: 'Warn' },
              { value: 'flag', label: 'Flag' },
            ],
          },
          {
            value: enabledFilter,
            onChange: setEnabledFilter,
            ariaLabel: 'Filter by enabled state',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ]}
        onRefresh={loadGuardrails}
        refreshing={refreshing}
        empty={{
          icon: <IconShield size={26} stroke={1.7} />,
          title: 'No guardrails yet',
          description:
            'Create your first guardrail to scan model inputs and outputs for PII, prompt injection, or custom policies.',
          primaryAction: {
            label: 'Create guardrail',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${grCtl.records.length} of ${filtered.length} guardrails`}
        rowActions={(g) => [
          {
            id: 'view',
            label: 'View',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/guardrails/${g.id}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => router.push(`/dashboard/guardrails/${g.id}`),
          },
          {
            id: 'toggle',
            label: g.enabled ? 'Disable' : 'Enable',
            icon: g.enabled ? <IconShieldOff size={14} /> : <IconPlayerPlay size={14} />,
            onClick: () => void handleToggleEnabled(g),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(g),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete guardrail"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Delete guardrail <strong>{deleteTarget?.name}</strong>? Models that
          reference this guardrail will no longer apply it. This action cannot be
          undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>
            Delete
          </Button>
        </Group>
      </Modal>

      <WordListsManager opened={wordListsOpen} onClose={() => setWordListsOpen(false)} />

      <CreateGuardrailModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        models={models}
        onCreated={(g) => {
          void loadGuardrails();
          router.push(`/dashboard/guardrails/${g.id}`);
        }}
      />
    </PageContainer>
  );
}
