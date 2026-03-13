'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconArrowRight,
  IconDatabaseExport,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import type { IVectorMigration, IVectorMigrationLog, VectorMigrationStatus } from '@/lib/database/provider/types.base';

const POLL_INTERVAL_MS = 2500;

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

function logStatusColor(status: string): string {
  switch (status) {
    case 'success': return 'green';
    case 'failed': return 'red';
    case 'skipped': return 'yellow';
    default: return 'gray';
  }
}

function formatDate(value?: string | Date | null): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function formatMs(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

interface MigrationDetail {
  migration: IVectorMigration;
  logs: IVectorMigrationLog[];
  totalLogs: number;
}

const LOGS_LIMIT = 50;

export default function VectorMigrationDetailPage() {
  const { key } = useParams<{ key: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<MigrationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [logsOffset, setLogsOffset] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDetail = useCallback(async (offset = 0, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(
        `/api/vector/migrations/${encodeURIComponent(key)}?logsLimit=${LOGS_LIMIT}&logsOffset=${offset}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        if (res.status === 404) {
          router.replace('/dashboard/vector/migrations');
          return;
        }
        throw new Error('Failed to load migration');
      }
      const data = await res.json() as MigrationDetail;
      setDetail(data);
    } catch (err) {
      if (!silent) {
        notifications.show({
          color: 'red',
          title: 'Unable to load migration',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    } finally {
      setLoading(false);
    }
  }, [key, router]);

  useEffect(() => {
    void loadDetail(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Poll while running
  useEffect(() => {
    const isRunning = detail?.migration.status === 'running';
    if (isRunning) {
      pollRef.current = setInterval(() => void loadDetail(logsOffset, true), POLL_INTERVAL_MS);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [detail?.migration.status, logsOffset, loadDetail]);

  const handleStart = async () => {
    try {
      const res = await fetch(`/api/vector/migrations/${encodeURIComponent(key)}/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to start');
      notifications.show({ color: 'teal', title: 'Migration started', message: detail?.migration.name });
      await loadDetail(logsOffset);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to start', message: err instanceof Error ? err.message : 'Unexpected error' });
    }
  };

  const handleCancel = async () => {
    try {
      const res = await fetch(`/api/vector/migrations/${encodeURIComponent(key)}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to cancel');
      notifications.show({ color: 'yellow', title: 'Migration cancelled', message: detail?.migration.name });
      await loadDetail(logsOffset);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to cancel', message: err instanceof Error ? err.message : 'Unexpected error' });
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete migration "${detail?.migration.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/vector/migrations/${encodeURIComponent(key)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete');
      notifications.show({ color: 'green', title: 'Migration deleted', message: key });
      router.push('/dashboard/vector/migrations');
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to delete', message: err instanceof Error ? err.message : 'Unexpected error' });
    }
  };

  const handleLogsPageChange = (offset: number) => {
    setLogsOffset(offset);
    void loadDetail(offset);
  };

  if (loading && !detail) {
    return (
      <Center py="xl">
        <Loader size="sm" color="teal" />
      </Center>
    );
  }

  if (!detail) return null;

  const { migration, logs, totalLogs } = detail;
  const progressValue =
    migration.totalVectors > 0
      ? Math.min(100, Math.round((migration.migratedVectors / migration.totalVectors) * 100))
      : 0;

  const logsPageCount = Math.ceil(totalLogs / LOGS_LIMIT);
  const logsCurrentPage = Math.floor(logsOffset / LOGS_LIMIT);

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconDatabaseExport size={18} />}
        title={migration.name}
        subtitle={migration.description ?? `Migration ${migration.key}`}
        actions={
          <Group gap="xs">
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/vector/migrations')}
            >
              All Migrations
            </Button>
            {(migration.status === 'pending' || migration.status === 'failed' || migration.status === 'cancelled') && (
              <Button
                size="xs"
                color="teal"
                leftSection={<IconPlayerPlay size={14} />}
                onClick={() => void handleStart()}
              >
                Start
              </Button>
            )}
            {migration.status === 'running' && (
              <Button
                size="xs"
                color="yellow"
                variant="light"
                leftSection={<IconPlayerStop size={14} />}
                onClick={() => void handleCancel()}
              >
                Cancel
              </Button>
            )}
            {migration.status !== 'running' && (
              <Tooltip label="Delete migration">
                <ActionIcon
                  size="md"
                  variant="light"
                  color="red"
                  onClick={() => void handleDelete()}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        }
      />

      {/* Migration metadata card */}
      <Paper withBorder radius="lg" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <Group gap="sm">
              <Badge size="md" variant="light" radius="xl" color={statusColor(migration.status)}>
                {migration.status.toUpperCase()}
              </Badge>
              {migration.status === 'running' && <Loader size={14} color="teal" />}
            </Group>
            <Text size="xs" c="dimmed">Key: {migration.key}</Text>
          </Group>

          {/* Route */}
          <Group gap="xs" align="center">
            <Paper withBorder p="sm" radius="md" style={{ flex: 1 }}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={2}>Source</Text>
              <Text size="sm" fw={500}>{migration.sourceIndexName || migration.sourceIndexKey}</Text>
              <Text size="xs" c="dimmed">{migration.sourceProviderKey}</Text>
            </Paper>
            <ThemeIcon size={32} radius="xl" variant="light" color="teal">
              <IconArrowRight size={16} />
            </ThemeIcon>
            <Paper withBorder p="sm" radius="md" style={{ flex: 1 }}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={2}>Destination</Text>
              <Text size="sm" fw={500}>{migration.destinationIndexName || migration.destinationIndexKey}</Text>
              <Text size="xs" c="dimmed">{migration.destinationProviderKey}</Text>
            </Paper>
          </Group>

          {/* Progress */}
          {migration.totalVectors > 0 && (
            <Stack gap={6}>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">Progress</Text>
                <Text size="xs" c="dimmed">
                  {migration.migratedVectors} migrated · {migration.failedVectors} failed · {migration.totalVectors} total
                </Text>
              </Group>
              <Progress value={progressValue} size="md" color={statusColor(migration.status)} radius="xl" animated={migration.status === 'running'} />
              <Text size="xs" c="dimmed" ta="right">{progressValue}%</Text>
            </Stack>
          )}

          {/* Timestamps & error */}
          <Group gap="xl" wrap="wrap">
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Batch size</Text>
              <Text size="sm">{migration.batchSize}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Started at</Text>
              <Text size="sm">{formatDate(migration.startedAt)}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Completed at</Text>
              <Text size="sm">{formatDate(migration.completedAt)}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Created</Text>
              <Text size="sm">{formatDate(migration.createdAt)}</Text>
            </Stack>
          </Group>

          {migration.errorMessage && (
            <Paper withBorder p="sm" radius="md" bg="red.9">
              <Text size="xs" c="red.2">{migration.errorMessage}</Text>
            </Paper>
          )}
        </Stack>
      </Paper>

      {/* Batch logs */}
      <Paper withBorder radius="lg" p="lg">
        <Group justify="space-between" mb="md">
          <Stack gap={2}>
            <Text fw={600} size="lg">Batch Logs</Text>
            <Text size="xs" c="dimmed">{totalLogs} log entries</Text>
          </Stack>
        </Group>

        {logs.length === 0 ? (
          <Center py="xl">
            <Text size="sm" c="dimmed">No batch logs yet. Logs appear once the migration starts.</Text>
          </Center>
        ) : (
          <Stack gap="md">
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Batch</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Migrated</Table.Th>
                  <Table.Th>Failed</Table.Th>
                  <Table.Th>Duration</Table.Th>
                  <Table.Th>Vectors</Table.Th>
                  <Table.Th>Error</Table.Th>
                  <Table.Th>Time</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {logs.map((log, i) => (
                  <Table.Tr key={`${log.migrationKey}-${log.batchIndex}-${i}`}>
                    <Table.Td>
                      <Badge size="xs" variant="outline" radius="sm">#{log.batchIndex + 1}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" radius="xl" color={logStatusColor(log.status)}>
                        {log.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{log.migratedCount}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c={log.failedCount > 0 ? 'red' : undefined}>{log.failedCount}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{formatMs(log.durationMs)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{log.vectorIds?.length ?? 0} ids</Text>
                    </Table.Td>
                    <Table.Td>
                      {log.errorMessage ? (
                        <Tooltip label={log.errorMessage} position="bottom" withArrow multiline maw={300}>
                          <Text size="xs" c="red" style={{ cursor: 'help' }} lineClamp={1}>{log.errorMessage}</Text>
                        </Tooltip>
                      ) : (
                        <Text size="xs" c="dimmed">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{formatDate(log.createdAt)}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {/* Simple pagination */}
            {logsPageCount > 1 && (
              <Group justify="center" gap="xs">
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={logsCurrentPage === 0}
                  onClick={() => handleLogsPageChange(Math.max(0, logsOffset - LOGS_LIMIT))}
                >
                  Previous
                </Button>
                <Text size="xs" c="dimmed">
                  Page {logsCurrentPage + 1} of {logsPageCount}
                </Text>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={logsCurrentPage >= logsPageCount - 1}
                  onClick={() => handleLogsPageChange(logsOffset + LOGS_LIMIT)}
                >
                  Next
                </Button>
              </Group>
            )}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}
