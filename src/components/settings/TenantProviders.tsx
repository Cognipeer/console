'use client';

import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';
import type { ProviderDomain } from '@/lib/database';
import type { ProviderDescriptor } from '@/lib/providers';
import ProviderConfigModal from '@/components/providers/ProviderConfigModal';

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

export default function TenantProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<ProviderDomain | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);

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
      const message = error instanceof Error ? error.message : 'Failed to load providers';
      notifications.show({ title: 'Providers', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
  }, []);

  const loadDrivers = async (domain: ProviderDomain) => {
    setDriversLoading(true);
    try {
      const res = await fetch(`/api/providers/drivers?domain=${encodeURIComponent(domain)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load drivers');
      }
      const data = (await res.json()) as { drivers?: ProviderDescriptor[] };
      setDrivers(data.drivers ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load drivers';
      notifications.show({ title: 'Providers', message, color: 'red' });
      setDrivers([]);
    } finally {
      setDriversLoading(false);
    }
  };

  const rows = useMemo(() => providers ?? [], [providers]);

  if (forbidden) {
    return (
      <Box p="md">
        <Text size="sm" c="dimmed">Forbidden</Text>
      </Box>
    );
  }

  return (
    <Box p="md">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Text size="lg" fw={600} mb={4}>
            Providers
          </Text>
          <Text size="sm" c="dimmed">
            Tenant-wide provider configurations and their project assignments.
          </Text>
        </div>
        <Button onClick={() => setWizardOpen(true)}>Add Provider</Button>
      </Group>

      <DataTable
        withTableBorder
        borderRadius="sm"
        striped
        highlightOnHover
        records={rows}
        fetching={loading}
        minHeight={200}
        noRecordsText="No providers"
        columns={[
          {
            accessor: 'label',
            title: 'Provider',
            render: (p) => (
              <div>
                <Text size="sm" fw={500}>{p.label}</Text>
                <Text size="xs" c="dimmed" ff="monospace">{p.key}</Text>
              </div>
            ),
          },
          { accessor: 'type', title: 'Type' },
          { accessor: 'driver', title: 'Driver' },
          { accessor: 'status', title: 'Status' },
          {
            accessor: 'projects',
            title: 'Projects',
            textAlign: 'right',
            render: (p) => {
              const legacy = p.projectId ? 1 : 0;
              const count = (p.projectIds?.length ?? 0) + legacy;
              return <Text size="sm">{count}</Text>;
            },
          },
        ]}
      />

      <Modal
        opened={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          setSelectedDomain(null);
        }}
        title="Create provider"
        centered
      >
        <Stack gap="md">
          <Select
            label="Provider domain"
            placeholder="Select a domain"
            value={selectedDomain}
            onChange={(value) => setSelectedDomain((value as ProviderDomain) ?? null)}
            data={[
              { value: 'model', label: 'Model (LLM)' },
              { value: 'embedding', label: 'Embedding' },
              { value: 'vector', label: 'Vector' },
              { value: 'file', label: 'File' },
              { value: 'datasource', label: 'Datasource' },
            ]}
          />

          <Group justify="flex-end">
            <Button
              disabled={!selectedDomain}
              onClick={async () => {
                if (!selectedDomain) return;
                await loadDrivers(selectedDomain);
                setWizardOpen(false);
                setConfigOpen(true);
              }}
            >
              Continue
            </Button>
          </Group>
        </Stack>
      </Modal>

      <ProviderConfigModal
        opened={configOpen}
        onClose={() => {
          setConfigOpen(false);
          setSelectedDomain(null);
          setDrivers([]);
        }}
        mode="create"
        drivers={drivers}
        driversLoading={driversLoading}
        onSubmit={async (options) => {
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
          setConfigOpen(false);
          setSelectedDomain(null);
          setDrivers([]);
          await fetchProviders();
        }}
      />
    </Box>
  );
}
