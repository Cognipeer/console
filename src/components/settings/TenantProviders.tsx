'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Text } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { notifications } from '@mantine/notifications';
import type { ProviderDomain } from '@/lib/database';
import type { ProviderDescriptor } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import ProviderConfigModal from '@/components/providers/ProviderConfigModal';
import {
  IconEdit,
  IconEye,
  IconPlug,
  IconPlus,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatTile from '@/components/common/ui/StatTile';
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

const DOMAIN_LABEL: Record<string, string> = {
  model: 'Model',
  embedding: 'Embedding',
  vector: 'Vector',
  file: 'File',
  datasource: 'Datasource',
};

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

export default function TenantProviders() {
  const router = useRouter();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const [selectedDomain, setSelectedDomain] = useState<ProviderDomain | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfigView | null>(null);

  const [query, setQuery] = useState('');
  const [domainFilter, setDomainFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/providers?scope=tenant', { cache: 'no-store' });
      if (res.status === 403) {
        setForbidden(true);
        setProviders([]);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load providers');
      }
      const data = (await res.json()) as { providers?: Provider[] };
      setProviders(data.providers ?? []);
      setForbidden(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load providers';
      notifications.show({ title: 'Providers', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchProviders();
  }, []);

  const loadDrivers = async (domain: ProviderDomain) => {
    setDriversLoading(true);
    try {
      const res = await fetch(
        `/api/providers/drivers?domain=${encodeURIComponent(domain)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load drivers');
      }
      const data = (await res.json()) as { drivers?: ProviderDescriptor[] };
      setDrivers(data.drivers ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load drivers';
      notifications.show({ title: 'Providers', message, color: 'red' });
      setDrivers([]);
    } finally {
      setDriversLoading(false);
    }
  };

  const openEditModal = async (providerId: string) => {
    try {
      const detailRes = await fetch(
        `/api/providers/${encodeURIComponent(providerId)}?scope=tenant`,
        { cache: 'no-store' },
      );
      if (!detailRes.ok) {
        const body = await detailRes.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load provider details');
      }

      const detailData = (await detailRes.json()) as {
        provider?: ProviderConfigView;
      };
      const provider = detailData.provider;
      if (!provider) throw new Error('Provider not found');

      await loadDrivers(provider.type as ProviderDomain);
      setSelectedDomain(provider.type as ProviderDomain);
      setEditingProvider(provider);
      setConfigOpen(true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to open provider editor';
      notifications.show({ title: 'Providers', message, color: 'red' });
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter((p) => {
      if (domainFilter !== 'all' && p.type !== domainFilter) return false;
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!q) return true;
      return [p.label, p.key, p.type, p.driver, p.status]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [providers, query, domainFilter, statusFilter]);

  const stats = useMemo(() => {
    const total = providers.length;
    const active = providers.filter(
      (p) => p.status === 'active' || p.status === 'connected' || p.status === 'ready',
    ).length;
    const errored = providers.filter(
      (p) => p.status === 'error' || p.status === 'failed',
    ).length;
    const domains = new Set(providers.map((p) => p.type)).size;
    return { total, active, errored, domains };
  }, [providers]);

  const columns: DataGridColumn<Provider>[] = [
    {
      key: 'provider',
      label: 'Provider',
      render: (p) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{p.label}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {p.key}
          </span>
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (p) => (
        <span className="ds-badge ds-badge-info">
          {DOMAIN_LABEL[p.type] ?? p.type}
        </span>
      ),
    },
    {
      key: 'driver',
      label: 'Driver',
      render: (p) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>
          {p.driver}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (p) => <StatusBadge status={statusVariant(p.status)} label={p.status} />,
    },
    {
      key: 'projects',
      label: 'Projects',
      align: 'right',
      render: (p) => {
        const legacy = p.projectId ? 1 : 0;
        const count = (p.projectIds?.length ?? 0) + legacy;
        return (
          <span
            className="ds-mono"
            style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
          >
            {count}
          </span>
        );
      },
    },
  ];

  const domainOptions = useMemo(() => {
    const unique = Array.from(new Set(providers.map((p) => p.type))).filter(Boolean);
    return [
      { value: 'all', label: 'All domains' },
      ...unique.map((d) => ({ value: d, label: DOMAIN_LABEL[d] ?? d })),
    ];
  }, [providers]);

  const statusOptions = useMemo(() => {
    const unique = Array.from(new Set(providers.map((p) => p.status))).filter(Boolean);
    return [
      { value: 'all', label: 'All statuses' },
      ...unique.map((s) => ({ value: s, label: s })),
    ];
  }, [providers]);

  if (forbidden) {
    return (
      <div className="ds-empty" style={{ padding: 48 }}>
        <Text size="sm" c="dimmed">
          You do not have permission to view tenant providers.
        </Text>
      </div>
    );
  }

  return (
    <>
      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Configured"
          value={stats.total}
          icon={<IconPlug size={14} stroke={1.7} />}
        />
        <StatTile label="Active" value={stats.active} />
        <StatTile label="Errored" value={stats.errored} />
        <StatTile label="Domains" value={stats.domains} />
      </div>

      <DataGrid<Provider>
        records={filtered}
        loading={loading}
        rowKey={(p) => p._id}
        onRowClick={(p) => router.push(`/dashboard/providers/${p._id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search providers by name, key, driver…',
        }}
        filters={[
          {
            value: domainFilter,
            onChange: setDomainFilter,
            ariaLabel: 'Domain',
            width: 150,
            options: domainOptions,
          },
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Status',
            width: 140,
            options: statusOptions,
          },
        ]}
        onRefresh={() => void fetchProviders()}
        refreshing={loading}
        toolbarRight={
          <Button
            color="teal"
            size="xs"
            leftSection={<IconPlus size={13} stroke={1.7} />}
            onClick={() => {
              setEditingProvider(null);
              setSelectedDomain(null);
              setDrivers([]);
              setConfigOpen(true);
            }}
          >
            Add provider
          </Button>
        }
        empty={{
          icon: <IconPlug size={26} stroke={1.7} />,
          title: 'No providers configured',
          description:
            'Connect an LLM, embedding, vector, file, or datasource provider to power your projects.',
          primaryAction: {
            label: 'Add provider',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => {
              setEditingProvider(null);
              setSelectedDomain(null);
              setDrivers([]);
              setConfigOpen(true);
            },
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${providers.length} providers`}
        rowActions={(p) => [
          {
            id: 'view',
            label: 'View details',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/providers/${p._id}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => void openEditModal(p._id),
          },
        ]}
      />

      <ProviderConfigModal
        opened={configOpen}
        onClose={() => {
          setConfigOpen(false);
          setSelectedDomain(null);
          setDrivers([]);
          setEditingProvider(null);
        }}
        mode={editingProvider ? 'edit' : 'create'}
        provider={editingProvider ?? undefined}
        drivers={drivers}
        driversLoading={driversLoading}
        domain={selectedDomain}
        onDomainChange={(d) => {
          setSelectedDomain(d);
          setDrivers([]);
          void loadDrivers(d);
        }}
        onSubmit={async (options) => {
          if (editingProvider) {
            const updatePayload: Record<string, unknown> = {
              label: options.values.base.label,
              description: options.values.base.description,
              status: options.values.base.status,
              settings: options.values.settings,
              metadata: options.values.metadata,
            };

            if (Object.keys(options.values.credentials).length > 0) {
              updatePayload.credentials = options.values.credentials;
            }

            const res = await fetch(
              `/api/providers/${encodeURIComponent(String(editingProvider._id))}?scope=tenant`,
              {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(updatePayload),
              },
            );

            const body = await res.json().catch(() => null);
            if (!res.ok) {
              throw new Error(body?.error || 'Failed to update provider');
            }

            notifications.show({
              title: 'Providers',
              message: 'Provider updated',
              color: 'green',
            });
          } else {
            if (!selectedDomain) {
              notifications.show({
                title: 'Providers',
                message: 'Provider domain is missing.',
                color: 'red',
              });
              return;
            }

            const payload: Record<string, unknown> = {
              key: options.values.base.key,
              label: options.values.base.label,
              description: options.values.base.description,
              driver: options.driver,
              type: selectedDomain,
              status: options.values.base.status,
              credentials: options.values.credentials,
              settings: options.values.settings,
              metadata: options.values.metadata,
            };

            const res = await fetch('/api/providers?scope=tenant', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });

            const body = await res.json().catch(() => null);
            if (!res.ok) {
              throw new Error(body?.error || 'Failed to create provider');
            }

            notifications.show({
              title: 'Providers',
              message: 'Provider created',
              color: 'green',
            });
          }

          setConfigOpen(false);
          setSelectedDomain(null);
          setDrivers([]);
          setEditingProvider(null);
          await fetchProviders();
        }}
      />
    </>
  );
}
