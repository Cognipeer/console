'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionIcon, Box, Button, Group, Modal, Select, Stack, Text, Tooltip } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';

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

  return (
    <Box p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Text size="lg" fw={600}>Providers</Text>
          <Text size="sm" c="dimmed">
            {tenantScope
              ? 'Manage which tenant providers are available to this project.'
              : 'Showing providers assigned to this project.'}
          </Text>
        </div>
        {tenantScope && (
          <Button
            onClick={() => {
              setSelectedProviderId(null);
              setAddOpen(true);
            }}
            disabled={submitting || unassignedProviders.length === 0}
          >
            Add provider
          </Button>
        )}
      </Group>

      <DataTable
        withTableBorder
        borderRadius="sm"
        striped
        highlightOnHover
        idAccessor="_id"
        records={tenantScope ? assignedProviders : rows}
        fetching={loading}
        minHeight={200}
        noRecordsText={tenantScope ? 'No assigned providers' : 'No providers'}
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
          ...(tenantScope
            ? [
                {
                  accessor: 'actions',
                  title: 'Actions',
                  textAlign: 'right' as const,
                  render: (p: Provider) => (
                    <Group justify="flex-end">
                      <Tooltip label="Remove">
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          loading={submitting}
                          onClick={() => setAssignment(p, false)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  ),
                },
              ]
            : []),
        ]}
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
          <Group justify="flex-end" gap="sm">
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
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
