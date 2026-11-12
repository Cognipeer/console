'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Select, Stack, Text } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useConfirm } from '@/components/common/confirm';
import { errorMessage } from '@/lib/api/client';
import { useProjectProviders, useUpdateTenantProvider } from '@/lib/api/queries/tenantProviders';
import { useTranslations } from '@/lib/i18n';

type Provider = {
  _id: string;
  key: string;
  label: string;
  type: string;
  driver: string;
  status: string;
  projectId?: string;
  projectIds?: string[];
};

function isAssigned(provider: Provider, projectId: string) {
  if (Array.isArray(provider.projectIds)) {
    return provider.projectIds.map(String).includes(String(projectId));
  }
  if (provider.projectId && String(provider.projectId) === String(projectId)) return true;
  return false;
}

function statusVariant(status: string) {
  switch (status) {
    case 'active':
    case 'connected':
    case 'ready':
      return 'ok' as const;
    case 'disabled':
    case 'paused':
      return 'paused' as const;
    case 'error':
    case 'failed':
      return 'err' as const;
    default:
      return 'info' as const;
  }
}

export default function ProjectProvidersManager({ projectId }: { projectId: string }) {
  const { confirmAction } = useConfirm();
  const tq = useTranslations('common.confirm.qos');
  const tCommon = useTranslations('common');
  const providersQuery = useProjectProviders<Provider>(projectId);
  const updateProvider = useUpdateTenantProvider();
  const providers = useMemo(() => providersQuery.data?.providers ?? [], [providersQuery.data]);
  const loading = providersQuery.isFetching;
  // The person may not read providers at all (a project admin without the providers permission).
  const forbidden = providersQuery.data?.forbidden ?? false;
  const tenantScope = providersQuery.data?.tenantScope ?? false;
  const [submitting, setSubmitting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const refetchProviders = providersQuery.refetch;

  // A failed read keeps what was shown and says so once per failure.
  const failedAt = providersQuery.errorUpdatedAt;
  const loadError = providersQuery.error;
  useEffect(() => {
    if (loadError) {
      notifications.show({ title: 'Project providers', message: errorMessage(loadError, 'Failed to load providers'), color: 'red' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedAt]);

  const rows = useMemo(() => providers ?? [], [providers]);

  const assignedProviders = useMemo(
    () => rows.filter((p) => isAssigned(p, projectId)),
    [rows, projectId],
  );

  const unassignedProviders = useMemo(
    () => rows.filter((p) => !isAssigned(p, projectId)),
    [rows, projectId],
  );

  /** PATCHes the provider's project list; throws on failure. */
  const patchAssignment = async (provider: Provider, assign: boolean) => {
    const next = new Set((provider.projectIds ?? []).map(String));
    if (provider.projectId) {
      next.add(String(provider.projectId));
    }
    if (assign) {
      next.add(String(projectId));
    } else {
      next.delete(String(projectId));
    }

    await updateProvider
      .mutateAsync({ id: provider._id, body: { projectIds: Array.from(next) } })
      .catch((error: unknown) => {
        throw new Error(errorMessage(error, 'Failed to update assignment'));
      });
  };

  const setAssignment = async (provider: Provider, assign: boolean) => {
    if (!tenantScope) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      await patchAssignment(provider, assign);
      notifications.show({ title: 'Project providers', message: 'Provider added', color: 'green' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update assignment';
      notifications.show({ title: 'Project providers', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
  };

  // Providers are strictly project-scoped: models and agents of this project
  // stop resolving a provider that is removed from it, so ask first.
  const removeAssignment = async (provider: Provider) => {
    if (!tenantScope || submitting) return;
    const removed = await confirmAction({
      title: tq('removeTitle', { noun: tq('nouns.provider') }),
      message: tq('removeProjectProvider', { name: provider.label || provider.key }),
      tone: 'warning',
      confirmLabel: tq('remove'),
      action: () => patchAssignment(provider, false),
    });
    if (!removed) return;
    notifications.show({ title: 'Project providers', message: 'Provider removed', color: 'green' });
  };

  const columns: DataGridColumn<Provider>[] = [
    {
      key: 'label',
      label: 'Provider',
      render: (p) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{p.label}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{p.key}</span>
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      width: 110,
      render: (p) => (
        <span className="ds-badge ds-badge-info">{p.type}</span>
      ),
    },
    {
      key: 'driver',
      label: 'Driver',
      width: 140,
      render: (p) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>{p.driver}</span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      width: 120,
      render: (p) => <StatusBadge status={statusVariant(p.status)} label={p.status} />,
    },
  ];

  const records = tenantScope ? assignedProviders : rows;

  if (forbidden) {
    return (
      <div className="ds-empty" style={{ padding: 48 }}>
        <Text size="sm" c="dimmed">
          {tCommon('forbidden')}
        </Text>
      </div>
    );
  }

  return (
    <>
      <DataGrid<Provider>
        records={records}
        loading={loading}
        rowKey={(p) => String(p._id)}
        columns={columns}
        onRefresh={() => void refetchProviders()}
        refreshing={loading}
        toolbarRight={
          tenantScope ? (
            <Button
              color="teal"
              size="xs"
              leftSection={<IconPlus size={13} stroke={1.7} />}
              onClick={() => {
                setSelectedProviderId(null);
                setAddOpen(true);
              }}
              disabled={submitting || unassignedProviders.length === 0}
            >
              Add provider
            </Button>
          ) : undefined
        }
        empty={{
          title: tenantScope ? 'No assigned providers' : 'No providers',
          description: tenantScope
            ? 'Assign tenant providers to make them available to this project.'
            : 'No providers are available for this project yet.',
          primaryAction: tenantScope && unassignedProviders.length > 0
            ? {
                label: 'Add provider',
                icon: <IconPlus size={14} stroke={1.7} />,
                onClick: () => {
                  setSelectedProviderId(null);
                  setAddOpen(true);
                },
              }
            : undefined,
        }}
        rowActions={
          tenantScope
            ? (p) => [
                {
                  id: 'remove',
                  label: 'Remove',
                  icon: <IconTrash size={14} />,
                  color: 'red',
                  onClick: () => void removeAssignment(p),
                  disabled: submitting,
                },
              ]
            : undefined
        }
      />

      <Modal
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add provider"
        centered
      >
        <Stack gap="md">
          <Select
            label="Provider"
            placeholder={unassignedProviders.length ? 'Select a provider' : 'No available providers'}
            data={unassignedProviders.map((p) => ({
              value: p._id,
              label: `${p.label} (${p.key})`,
            }))}
            value={selectedProviderId}
            onChange={setSelectedProviderId}
            searchable
            disabled={unassignedProviders.length === 0}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="default" onClick={() => setAddOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              loading={submitting}
              disabled={!selectedProviderId}
              onClick={async () => {
                const provider = unassignedProviders.find((p) => p._id === selectedProviderId);
                if (!provider) return;
                await setAssignment(provider, true);
                setAddOpen(false);
              }}
            >
              Add
            </Button>
          </div>
        </Stack>
      </Modal>
    </>
  );
}
