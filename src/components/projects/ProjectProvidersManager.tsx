'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal, Select, Stack } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';

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
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [tenantScope, setTenantScope] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const resTenant = await fetch('/api/providers?scope=tenant', { cache: 'no-store' });
      if (resTenant.ok) {
        const data = (await resTenant.json()) as { providers?: Provider[] };
        setProviders(data.providers ?? []);
        setTenantScope(true);
        return;
      }

      const resProject = await fetch('/api/providers', { cache: 'no-store' });
      if (!resProject.ok) {
        const body = await resProject.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load providers');
      }
      const data = (await resProject.json()) as { providers?: Provider[] };
      setProviders(data.providers ?? []);
      setTenantScope(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load providers';
      notifications.show({ title: 'Project providers', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProviders();
  }, [fetchProviders, projectId]);

  const rows = useMemo(() => providers ?? [], [providers]);

  const assignedProviders = useMemo(
    () => rows.filter((p) => isAssigned(p, projectId)),
    [rows, projectId],
  );

  const unassignedProviders = useMemo(
    () => rows.filter((p) => !isAssigned(p, projectId)),
    [rows, projectId],
  );

  const setAssignment = async (provider: Provider, assign: boolean) => {
    if (!tenantScope) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      const next = new Set((provider.projectIds ?? []).map(String));
      if (provider.projectId) {
        next.add(String(provider.projectId));
      }
      if (assign) {
        next.add(String(projectId));
      } else {
        next.delete(String(projectId));
      }

      const res = await fetch(
        `/api/providers/${encodeURIComponent(provider._id)}?scope=tenant`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectIds: Array.from(next) }),
        },
      );

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || 'Failed to update assignment');
      }

      notifications.show({
        title: 'Project providers',
        message: assign ? 'Provider added' : 'Provider removed',
        color: 'green',
      });
      await fetchProviders();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update assignment';
      notifications.show({ title: 'Project providers', message, color: 'red' });
    } finally {
      setSubmitting(false);
    }
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

  return (
    <>
      <DataGrid<Provider>
        records={records}
        loading={loading}
        rowKey={(p) => String(p._id)}
        columns={columns}
        onRefresh={() => void fetchProviders()}
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
                  onClick: () => void setAssignment(p, false),
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
