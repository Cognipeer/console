'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowRight,
  IconDatabaseExport,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import type { IVectorMigration, VectorMigrationStatus } from '@/lib/database/provider/types.base';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';
import CreateVectorMigrationModal from '@/components/vector/CreateVectorMigrationModal';

const POLL_INTERVAL_MS = 3000;

function statusColor(status: VectorMigrationStatus): string {
  switch (status) {
    case 'pending': return 'yellow';
    case 'running': return 'teal';
    case 'completed': return 'green';
    case 'failed': return 'red';
    case 'cancelled': return 'gray';
    default: return 'gray';
  }
}

function formatDate(value?: string | Date | null): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function migrationProgressLabel(m: IVectorMigration): string {
  if (m.totalVectors === 0) return '—';
  return `${m.migratedVectors} / ${m.totalVectors}`;
}

function migrationProgressValue(m: IVectorMigration): number {
  if (m.totalVectors === 0) return 0;
  return Math.min(100, Math.round((m.migratedVectors / m.totalVectors) * 100));
}

export default function VectorMigrationsPage() {
  const router = useRouter();
  const [migrations, setMigrations] = useState<IVectorMigration[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [providers, setProviders] = useState<VectorProviderView[]>([]);
  const [indexesByProvider, setIndexesByProvider] = useState<Record<string, VectorIndexRecord[]>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasRunning = useMemo(
    () => migrations.some((m) => m.status === 'running'),
    [migrations],
  );

  const loadMigrations = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch('/api/vector/migrations', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load migrations');
      const data = await res.json();
      setMigrations((data.migrations ?? []) as IVectorMigration[]);
    } catch (err) {
      if (!silent) {
        notifications.show({
          color: 'red',
          title: 'Unable to load migrations',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, []);

  const loadProvidersAndIndexes = useCallback(async () => {
    try {
      const res = await fetch('/api/vector/providers', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const fetchedProviders: VectorProviderView[] = data.providers ?? [];
      setProviders(fetchedProviders);

      const entries = await Promise.all(
        fetchedProviders.map(async (p) => {
          try {
            const r = await fetch(`/api/vector/indexes?providerKey=${encodeURIComponent(p.key)}`, { cache: 'no-store' });
            if (!r.ok) return [p.key, [] as VectorIndexRecord[]] as const;
            const d = await r.json();
            return [p.key, (d.indexes ?? []) as VectorIndexRecord[]] as const;
          } catch {
            return [p.key, [] as VectorIndexRecord[]] as const;
          }
        }),
      );

      const map: Record<string, VectorIndexRecord[]> = {};
      entries.forEach(([k, v]) => { map[k] = v; });
      setIndexesByProvider(map);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    void loadMigrations();
    void loadProvidersAndIndexes();
  }, [loadMigrations, loadProvidersAndIndexes]);

  // Poll while any migration is running
  useEffect(() => {
    if (hasRunning) {
      pollRef.current = setInterval(() => void loadMigrations(true), POLL_INTERVAL_MS);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [hasRunning, loadMigrations]);

  const handleStart = async (m: IVectorMigration) => {
    try {
      const res = await fetch(`/api/vector/migrations/${encodeURIComponent(m.key)}/start`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to start');
      }
      notifications.show({ color: 'teal', title: 'Migration started', message: m.name });
      await loadMigrations();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to start migration', message: err instanceof Error ? err.message : 'Unexpected error' });
    }
  };

  const handleCancel = async (m: IVectorMigration) => {
    try {
      const res = await fetch(`/api/vector/migrations/${encodeURIComponent(m.key)}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to cancel');
      }
      notifications.show({ color: 'yellow', title: 'Migration cancelled', message: m.name });
      await loadMigrations();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to cancel migration', message: err instanceof Error ? err.message : 'Unexpected error' });
    }
  };

  const handleDelete = async (m: IVectorMigration) => {
    if (!window.confirm(`Delete migration "${m.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/vector/migrations/${encodeURIComponent(m.key)}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to delete');
      }
      notifications.show({ color: 'green', title: 'Migration deleted', message: m.name });
      setMigrations((prev) => prev.filter((item) => item.key !== m.key));
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to delete migration', message: err instanceof Error ? err.message : 'Unexpected error' });
    }
  };

  const counts = useMemo(() => ({
    total: migrations.length,
    running: migrations.filter((m) => m.status === 'running').length,
    completed: migrations.filter((m) => m.status === 'completed').length,
    failed: migrations.filter((m) => m.status === 'failed').length,
  }), [migrations]);

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconDatabaseExport size={18} />}
        title="Knowledge Index Migrator"
        subtitle="Migrate vectors between indexes as background jobs. Track batch-level progress and history."
        actions={
          <Group gap="xs">
            <Button
              variant="light"
              size="xs"
              leftSection={refreshing ? <Loader size={12} /> : <IconRefresh size={14} />}
              onClick={() => void loadMigrations()}
              disabled={refreshing}
            >
              Refresh
            </Button>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => setCreateModalOpen(true)}
            >
              New Migration
            </Button>
          </Group>
        }
      />

      {/* Stats */}
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Paper withBorder radius="lg" p="md">
          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Total</Text>
              <Text fw={700} size="xl">{counts.total}</Text>
            </Stack>
            <ThemeIcon size={40} radius="xl" variant="light" color="teal">
              <IconDatabaseExport size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="md">
          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Running</Text>
              <Text fw={700} size="xl" c="teal">{counts.running}</Text>
            </Stack>
            <ThemeIcon size={40} radius="xl" variant="light" color="teal">
              <IconPlayerPlay size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="md">
          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Completed</Text>
              <Text fw={700} size="xl" c="green">{counts.completed}</Text>
            </Stack>
            <ThemeIcon size={40} radius="xl" variant="light" color="green">
              <IconDatabaseExport size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="md">
          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Failed</Text>
              <Text fw={700} size="xl" c={counts.failed > 0 ? 'red' : undefined}>{counts.failed}</Text>
            </Stack>
            <ThemeIcon size={40} radius="xl" variant="light" color={counts.failed > 0 ? 'red' : 'gray'}>
              <IconDatabaseExport size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Migrations table */}
      <Paper withBorder radius="lg" p="lg">
        <Group justify="space-between" mb="md">
          <Text fw={600} size="lg">All Migrations</Text>
        </Group>

        {loading ? (
          <Center py="xl"><Loader size="sm" color="teal" /></Center>
        ) : migrations.length === 0 ? (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <ThemeIcon size={48} radius="xl" variant="light" color="gray">
                <IconDatabaseExport size={24} />
              </ThemeIcon>
              <Text c="dimmed" size="sm">No migrations yet. Create one to get started.</Text>
            </Stack>
          </Center>
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Source → Destination</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Progress</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {migrations.map((m) => (
                <Table.Tr
                  key={m.key}
                  style={{ cursor: 'pointer' }}
                  onClick={() => router.push(`/dashboard/vector/migrations/${m.key}`)}
                >
                  <Table.Td>
                    <Stack gap={2}>
                      <Text size="sm" fw={500}>{m.name}</Text>
                      {m.description && <Text size="xs" c="dimmed" lineClamp={1}>{m.description}</Text>}
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Text size="xs" c="dimmed" style={{ maxWidth: 120 }} lineClamp={1}>{m.sourceIndexName || m.sourceIndexKey}</Text>
                      <IconArrowRight size={12} />
                      <Text size="xs" c="dimmed" style={{ maxWidth: 120 }} lineClamp={1}>{m.destinationIndexName || m.destinationIndexKey}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" radius="xl" color={statusColor(m.status)}>
                      {m.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {m.totalVectors > 0 ? (
                      <Stack gap={4} style={{ minWidth: 140 }}>
                        <Progress value={migrationProgressValue(m)} size="xs" color={statusColor(m.status)} radius="xl" />
                        <Text size="xs" c="dimmed">{migrationProgressLabel(m)}</Text>
                      </Stack>
                    ) : (
                      <Text size="xs" c="dimmed">—</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">{formatDate(m.createdAt)}</Text>
                  </Table.Td>
                  <Table.Td onClick={(e) => e.stopPropagation()}>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      {m.status === 'pending' || m.status === 'failed' || m.status === 'cancelled' ? (
                        <Tooltip label="Start migration">
                          <ActionIcon
                            size="sm"
                            variant="light"
                            color="teal"
                            onClick={() => void handleStart(m)}
                          >
                            <IconPlayerPlay size={14} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                      {m.status === 'running' ? (
                        <Tooltip label="Cancel migration">
                          <ActionIcon
                            size="sm"
                            variant="light"
                            color="yellow"
                            onClick={() => void handleCancel(m)}
                          >
                            <IconPlayerStop size={14} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                      <Tooltip label="View details">
                        <ActionIcon
                          size="sm"
                          variant="light"
                          color="gray"
                          onClick={() => router.push(`/dashboard/vector/migrations/${m.key}`)}
                        >
                          <IconArrowRight size={14} />
                        </ActionIcon>
                      </Tooltip>
                      {m.status !== 'running' ? (
                        <Tooltip label="Delete migration">
                          <ActionIcon
                            size="sm"
                            variant="light"
                            color="red"
                            onClick={() => void handleDelete(m)}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      <CreateVectorMigrationModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        indexesByProvider={indexesByProvider}
        onCreated={(migration) => {
          setMigrations((prev) => [migration, ...prev]);
          setCreateModalOpen(false);
          router.push(`/dashboard/vector/migrations/${migration.key}`);
        }}
      />
    </Stack>
  );
}
