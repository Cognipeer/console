'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import {
  useCancelVectorMigration,
  useDeleteVectorMigration,
  useStartVectorMigration,
  useVectorIndexesOfProviders,
  useVectorMigrations,
  useVectorProviders,
} from '@/lib/api/queries/vector';
import {
  IconArrowRight,
  IconDatabaseExport,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type { IVectorMigration, VectorMigrationStatus } from '@/lib/database/provider/types.base';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';
import CreateVectorMigrationModal from '@/components/vector/CreateVectorMigrationModal';

const POLL_INTERVAL_MS = 3000;

function statusColor(status: VectorMigrationStatus): string {
  switch (status) {
    case 'pending': return 'yellow';
    case 'queued': return 'blue';
    case 'running': return 'teal';
    case 'completed': return 'green';
    case 'failed': return 'red';
    case 'cancelled': return 'gray';
    default: return 'gray';
  }
}

/** Queued or running — the background job owns the record. */
function isActive(status: VectorMigrationStatus): boolean {
  return status === 'queued' || status === 'running';
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
  const deleteResource = useDeleteResource();
  const tSafe = useTranslations('common.confirm.dataSafety');
  const router = useRouter();
  const migrationsQuery = useVectorMigrations(POLL_INTERVAL_MS);
  const migrations = useMemo<IVectorMigration[]>(() => migrationsQuery.data ?? [], [migrationsQuery.data]);
  const loading = migrationsQuery.isPending;
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const providersQuery = useVectorProviders();
  const providers = useMemo<VectorProviderView[]>(() => providersQuery.data ?? [], [providersQuery.data]);
  const providerKeys = useMemo(() => providers.map((p) => p.key), [providers]);
  const indexesQuery = useVectorIndexesOfProviders(providerKeys);
  const indexesByProvider = useMemo<Record<string, VectorIndexRecord[]>>(
    () => indexesQuery.data ?? {},
    [indexesQuery.data],
  );
  const startMigration = useStartVectorMigration();
  const cancelMigration = useCancelVectorMigration();
  const deleteMigration = useDeleteVectorMigration();

  // The first load that fails is told; later poll failures stay quiet.
  const loadError = migrationsQuery.isError && migrationsQuery.data === undefined ? migrationsQuery.error : null;
  useEffect(() => {
    if (!loadError) return;
    notifications.show({
      color: 'red',
      title: 'Unable to load migrations',
      message: errorMessage(loadError, 'Unexpected error'),
    });
  }, [loadError]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await migrationsQuery.refetch();
      if (result.isError) {
        notifications.show({
          color: 'red',
          title: 'Unable to load migrations',
          message: errorMessage(result.error, 'Unexpected error'),
        });
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleStart = async (m: IVectorMigration) => {
    try {
      await startMigration.mutateAsync(m.key);
      notifications.show({ color: 'teal', title: 'Migration started', message: m.name });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to start migration', message: errorMessage(err, 'Unexpected error') });
    }
  };

  const handleCancel = async (m: IVectorMigration) => {
    try {
      await cancelMigration.mutateAsync(m.key);
      notifications.show({ color: 'yellow', title: 'Migration cancelled', message: m.name });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to cancel migration', message: errorMessage(err, 'Unexpected error') });
    }
  };

  const handleDelete = (m: IVectorMigration) =>
    deleteResource({
      noun: tSafe('nouns.vectorMigration'),
      name: m.name,
      action: async () => {
        try {
          await deleteMigration.mutateAsync(m.key);
        } catch (err) {
          throw new Error(errorMessage(err, 'Failed to delete'));
        }
        notifications.show({ color: 'green', title: 'Migration deleted', message: m.name });
      },
    });

  const counts = useMemo(() => ({
    total: migrations.length,
    running: migrations.filter((m) => isActive(m.status)).length,
    completed: migrations.filter((m) => m.status === 'completed').length,
    failed: migrations.filter((m) => m.status === 'failed').length,
  }), [migrations]);

  const migrationColumns: DataGridColumn<IVectorMigration>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (m) => (
        <Stack gap={2}>
          <Text size="sm" fw={500}>{m.name}</Text>
          {m.description && <Text size="xs" c="dimmed" lineClamp={1}>{m.description}</Text>}
        </Stack>
      ),
    },
    {
      key: 'route',
      label: 'Source → Destination',
      render: (m) => (
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed" style={{ maxWidth: 120 }} lineClamp={1}>{m.sourceIndexName || m.sourceIndexKey}</Text>
          <IconArrowRight size={12} />
          <Text size="xs" c="dimmed" style={{ maxWidth: 120 }} lineClamp={1}>{m.destinationIndexName || m.destinationIndexKey}</Text>
        </Group>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (m) => (
        <Badge size="sm" variant="light" radius="xl" color={statusColor(m.status)}>
          {m.status}
        </Badge>
      ),
    },
    {
      key: 'progress',
      label: 'Progress',
      render: (m) =>
        m.totalVectors > 0 ? (
          <Stack gap={4} style={{ minWidth: 140 }}>
            <Progress value={migrationProgressValue(m)} size="xs" color={statusColor(m.status)} radius="xl" />
            <Text size="xs" c="dimmed">{migrationProgressLabel(m)}</Text>
          </Stack>
        ) : (
          <Text size="xs" c="dimmed">—</Text>
        ),
    },
    {
      key: 'created',
      label: 'Created',
      render: (m) => <Text size="xs" c="dimmed">{formatDate(m.createdAt)}</Text>,
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      render: (m) => (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {m.status === 'pending' || m.status === 'failed' || m.status === 'cancelled' ? (
            <Tooltip label="Start migration">
              <ActionIcon
                size="sm"
                variant="light"
                color="teal"
                onClick={(e) => { e.stopPropagation(); void handleStart(m); }}
              >
                <IconPlayerPlay size={14} />
              </ActionIcon>
            </Tooltip>
          ) : null}
          {isActive(m.status) ? (
            <Tooltip label="Cancel migration">
              <ActionIcon
                size="sm"
                variant="light"
                color="yellow"
                onClick={(e) => { e.stopPropagation(); void handleCancel(m); }}
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
              onClick={(e) => { e.stopPropagation(); router.push(`/dashboard/vector/migrations/${m.key}`); }}
            >
              <IconArrowRight size={14} />
            </ActionIcon>
          </Tooltip>
          {!isActive(m.status) ? (
            <Tooltip label="Delete migration">
              <ActionIcon
                size="sm"
                variant="light"
                color="red"
                onClick={(e) => { e.stopPropagation(); void handleDelete(m); }}
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </Group>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Vector migrations"
        title="Knowledge Index Migrator"
        subtitle="Migrate vectors between indexes as background jobs. Track batch-level progress and history."
        actions={
          <Group gap="xs">
            <Button
              variant="light"
              size="xs"
              leftSection={refreshing ? <Loader size={12} /> : <IconRefresh size={14} />}
              onClick={() => void handleRefresh()}
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

        <DataGrid<IVectorMigration>
          records={migrations}
          rowKey={(m) => m.key}
          columns={migrationColumns}
          loading={loading}
          rowHref={(m) => `/dashboard/vector/migrations/${m.key}`}
          empty={{
            icon: <IconDatabaseExport size={24} />,
            title: 'No migrations yet. Create one to get started.',
          }}
        />
      </Paper>

      <CreateVectorMigrationModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        indexesByProvider={indexesByProvider}
        onCreated={(migration) => {
          setCreateModalOpen(false);
          router.push(`/dashboard/vector/migrations/${migration.key}`);
        }}
      />
    </PageContainer>
  );
}
