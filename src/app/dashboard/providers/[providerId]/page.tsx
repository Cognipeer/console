'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Button,
  Center,
  CopyButton,
  Loader,
  Menu,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCheck,
  IconClipboard,
  IconDots,
  IconEdit,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import ProviderConfigModal from '@/components/providers/ProviderConfigModal';
import {
  resolveServiceCatalogEntry,
  serviceGlyph,
  DOMAIN_LABELS,
} from '@/lib/services/serviceCatalog';
import type {
  ProviderDescriptor,
  ProviderFormSchema,
} from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import type { ProviderDomain } from '@/lib/database';

type ProviderRecord = Omit<ProviderConfigView, 'createdAt' | 'updatedAt'> & {
  createdAt?: string | Date;
  updatedAt?: string | Date;
  projectIds?: string[];
  projectId?: string;
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

function formatDate(input?: string | Date | null) {
  if (!input) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export default function ProviderDetailPage() {
  const params = useParams<{ providerId: string }>();
  const router = useRouter();
  const providerId = params?.providerId;

  const [provider, setProvider] = useState<ProviderRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [schema, setSchema] = useState<ProviderFormSchema | null>(null);

  const loadProvider = useCallback(
    async (silent = false) => {
      if (!providerId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetch(
          `/api/providers/${encodeURIComponent(providerId)}?scope=tenant`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || 'Failed to load provider');
        }
        const data = (await res.json()) as { provider?: ProviderRecord };
        if (!data.provider) {
          throw new Error('Provider not found');
        }
        setProvider(data.provider);
      } catch (error) {
        notifications.show({
          color: 'red',
          title: 'Provider',
          message: error instanceof Error ? error.message : 'Failed to load',
        });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [providerId],
  );

  const loadDrivers = useCallback(async (type: ProviderDomain) => {
    setDriversLoading(true);
    try {
      const res = await fetch(
        `/api/providers/drivers?domain=${encodeURIComponent(type)}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = (await res.json()) as { drivers?: ProviderDescriptor[] };
        setDrivers(data.drivers ?? []);
      }
    } catch (error) {
      console.error('Failed to load drivers', error);
    } finally {
      setDriversLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProvider();
  }, [loadProvider]);

  useEffect(() => {
    if (!provider || !editOpen) return;
    void loadDrivers(provider.type as ProviderDomain);
  }, [provider, editOpen, loadDrivers]);

  const handleDelete = async () => {
    if (!provider) return;
    const ok = window.confirm(
      `Delete provider "${provider.label}"? This cannot be undone.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/providers/${encodeURIComponent(String(provider._id))}?scope=tenant`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to delete provider');
      }
      notifications.show({
        color: 'teal',
        title: 'Provider deleted',
        message: `${provider.label} was removed`,
      });
      router.push('/dashboard/providers');
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Provider',
        message:
          error instanceof Error ? error.message : 'Failed to delete provider',
      });
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (!provider) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">Provider not found.</Text>
          <Button
            leftSection={<IconArrowLeft size={16} />}
            onClick={() => router.push('/dashboard/providers')}
          >
            Back to providers
          </Button>
        </Stack>
      </Center>
    );
  }

  const service = resolveServiceCatalogEntry({
    serviceId:
      provider.metadata && typeof provider.metadata.serviceCatalogId === 'string'
        ? provider.metadata.serviceCatalogId
        : undefined,
    driver: provider.driver,
    domain: provider.type as ProviderDomain,
    key: provider.key,
    label: provider.label,
  });

  const projectCount =
    (provider.projectIds?.length ?? 0) + (provider.projectId ? 1 : 0);

  const actions = (
    <>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconRefresh size={14} stroke={1.7} />}
        loading={refreshing}
        onClick={() => void loadProvider(true)}
      >
        Refresh
      </Button>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconEdit size={14} stroke={1.7} />}
        onClick={() => setEditOpen(true)}
      >
        Edit
      </Button>
      <Menu withinPortal position="bottom-end" withArrow>
        <Menu.Target>
          <ActionIcon variant="default" radius="md" size="lg" aria-label="More">
            <IconDots size={15} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            Delete provider
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );

  return (
    <DetailShell
      backHref="/dashboard/providers"
      backLabel="Back to providers"
      icon={
        service ? (
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              background: service.color,
              color: '#fff',
              fontWeight: 700,
              fontSize: 20,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            {serviceGlyph(service)}
          </div>
        ) : null
      }
      title={
        <>
          <h1
            className="ds-h2"
            style={{ margin: 0, whiteSpace: 'nowrap' }}
          >
            {provider.label}
          </h1>
          <StatusBadge status={statusVariant(provider.status)} label={provider.status} />
          <span className="ds-badge ds-badge-info">
            {DOMAIN_LABELS[provider.type as ProviderDomain] ?? provider.type}
          </span>
        </>
      }
      meta={
        <>
          <span className="ds-mono">{provider.key}</span>
          <span className="ds-faint">·</span>
          <span>driver: <span className="ds-mono">{provider.driver}</span></span>
          {service ? (
            <>
              <span className="ds-faint">·</span>
              <span>{service.name}</span>
            </>
          ) : null}
          {provider.updatedAt ? (
            <>
              <span className="ds-faint">·</span>
              <span>Updated {formatDate(provider.updatedAt)}</span>
            </>
          ) : null}
        </>
      }
      actions={actions}
    >
      <DetailTwoCol narrowAside>
        <Stack gap="md">
          <DetailCard
            title="Overview"
            description={
              service?.description ??
              provider.description ??
              'No description for this provider.'
            }
          >
            <div className="ds-tbl-wrap">
              <table className="ds-tbl">
                <tbody>
                  <DetailRow label="Key" value={provider.key} mono />
                  <DetailRow label="Label" value={provider.label} />
                  <DetailRow
                    label="Type"
                    value={
                      <span className="ds-badge ds-badge-info">
                        {DOMAIN_LABELS[provider.type as ProviderDomain] ?? provider.type}
                      </span>
                    }
                  />
                  <DetailRow label="Driver" value={provider.driver} mono />
                  <DetailRow
                    label="Status"
                    value={
                      <StatusBadge
                        status={statusVariant(provider.status)}
                        label={provider.status}
                      />
                    }
                  />
                  {provider.description ? (
                    <DetailRow label="Description" value={provider.description} />
                  ) : null}
                  <DetailRow
                    label="Created"
                    value={formatDate(provider.createdAt)}
                  />
                  <DetailRow
                    label="Updated"
                    value={formatDate(provider.updatedAt)}
                  />
                </tbody>
              </table>
            </div>
          </DetailCard>

          {provider.settings && Object.keys(provider.settings).length > 0 ? (
            <DetailCard
              title="Settings"
              description="Non-sensitive configuration values."
            >
              <div className="ds-tbl-wrap">
                <table className="ds-tbl">
                  <tbody>
                    {Object.entries(provider.settings).map(([k, v]) => (
                      <DetailRow
                        key={k}
                        label={k}
                        value={typeof v === 'string' ? v : JSON.stringify(v)}
                        mono
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </DetailCard>
          ) : null}

          {provider.metadata && Object.keys(provider.metadata).length > 0 ? (
            <DetailCard
              title="Metadata"
              description="Tenant-defined annotations."
            >
              <div className="ds-tbl-wrap">
                <table className="ds-tbl">
                  <tbody>
                    {Object.entries(provider.metadata).map(([k, v]) => (
                      <DetailRow
                        key={k}
                        label={k}
                        value={typeof v === 'string' ? v : JSON.stringify(v)}
                        mono
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </DetailCard>
          ) : null}

          <DetailCard
            title="Credentials"
            description="Credential values are never returned by the API. Edit the provider to update them."
          >
            <div className="ds-empty" style={{ padding: 24 }}>
              <Text size="sm" c="dimmed">
                Credentials are stored encrypted and hidden from this view.
              </Text>
            </div>
          </DetailCard>
        </Stack>

        <Stack gap="md">
          {service ? (
            <DetailCard title="Service">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 9,
                    background: service.color,
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 16,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {serviceGlyph(service)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{service.name}</div>
                  <div
                    className="ds-muted"
                    style={{ fontSize: 12, lineHeight: 1.3 }}
                  >
                    {service.tagline}
                  </div>
                </div>
              </div>
              <div className="ds-row ds-gap-xs" style={{ flexWrap: 'wrap' }}>
                {service.domains.map((d) => (
                  <span key={d} className="ds-badge ds-badge-info">
                    {DOMAIN_LABELS[d] ?? d}
                  </span>
                ))}
                {service.tags.includes('popular') ? (
                  <span className="ds-badge ds-badge-warn">★ popular</span>
                ) : null}
              </div>
            </DetailCard>
          ) : null}

          <DetailCard title="Usage">
            <div className="ds-row-between" style={{ padding: '6px 0', fontSize: 12.5 }}>
              <span className="ds-muted">Assigned to projects</span>
              <span className="ds-mono">{projectCount}</span>
            </div>
            {projectCount > 0 ? (
              <Button
                component={Link}
                href="/dashboard/projects"
                variant="subtle"
                size="xs"
                mt="sm"
                style={{ paddingLeft: 0 }}
              >
                View assignments
              </Button>
            ) : null}
          </DetailCard>

          <DetailCard title="Identifiers">
            <div className="ds-row-between" style={{ padding: '6px 0', fontSize: 12.5 }}>
              <span className="ds-muted">ID</span>
              <CopyButton value={String(provider._id)}>
                {({ copied, copy }) => (
                  <button
                    type="button"
                    onClick={copy}
                    className="ds-mono"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--ds-text)',
                      cursor: 'pointer',
                      fontSize: 12,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    title="Click to copy"
                  >
                    {copied ? <IconCheck size={11} /> : <IconClipboard size={11} />}
                    {String(provider._id).slice(0, 12)}…
                  </button>
                )}
              </CopyButton>
            </div>
            <div className="ds-row-between" style={{ padding: '6px 0', fontSize: 12.5 }}>
              <span className="ds-muted">Key</span>
              <span className="ds-mono">{provider.key}</span>
            </div>
          </DetailCard>
        </Stack>
      </DetailTwoCol>

      <ProviderConfigModal
        opened={editOpen}
        onClose={() => {
          setEditOpen(false);
          setSchema(null);
        }}
        mode="edit"
        provider={provider as ProviderConfigView}
        drivers={drivers}
        driversLoading={driversLoading}
        onSubmit={async (options) => {
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
            `/api/providers/${encodeURIComponent(String(provider._id))}?scope=tenant`,
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
            color: 'green',
            title: 'Providers',
            message: 'Provider updated',
          });
          setEditOpen(false);
          setSchema(null);
          await loadProvider(true);
        }}
      />
      {/* schema state kept here to satisfy a future "JSON inspector" tab; for now unused */}
      <span hidden aria-hidden="true">
        {schema ? '1' : '0'}
      </span>
    </DetailShell>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <tr>
      <td style={{ width: '40%', verticalAlign: 'top' }}>
        <span className="ds-muted" style={{ fontSize: 12.5 }}>
          {label}
        </span>
      </td>
      <td style={{ verticalAlign: 'top' }}>
        <span
          className={mono ? 'ds-mono' : undefined}
          style={{ fontSize: 12.5, wordBreak: 'break-word' }}
        >
          {value}
        </span>
      </td>
    </tr>
  );
}
