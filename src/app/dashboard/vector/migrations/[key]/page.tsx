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
  Modal,
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
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type {
  IVectorMigration,
  IVectorMigrationLog,
  IVectorMigrationRunSummary,
  VectorMigrationStatus,
} from '@/lib/database/provider/types.base';

const POLL_INTERVAL_MS = 2500;
const LOGS_LIMIT = 50;

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

interface MigrationDetailResponse {
  migration: IVectorMigration;
  logs: IVectorMigrationLog[];
  totalLogs: number;
  runs: IVectorMigrationRunSummary[];
}

interface RunLogsState {
  attempt: number;
  logs: IVectorMigrationLog[];
  total: number;
  offset: number;
  loading: boolean;
}

export default function VectorMigrationDetailPage() {
  const { key } = useParams<{ key: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<MigrationDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runLogs, setRunLogs] = useState<RunLogsState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runLogsRef = useRef<RunLogsState | null>(null);

  useEffect(() => {
    runLogsRef.current = runLogs;
  }, [runLogs]);

  const loadDetail = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(
        `/api/vector/migrations/${encodeURIComponent(key)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        if (res.status === 404) {
          router.replace('/dashboard/vector/migrations');
          return;
        }
        throw new Error('Failed to load migration');
      }
      const data = await res.json() as MigrationDetailResponse;
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

  const loadRunLogs = useCallback(async (attempt: number, offset: number, silent = false) => {
    setRunLogs((prev) => (
      prev && prev.attempt === attempt
        ? { ...prev, offset, loading: !silent || prev.logs.length === 0 }
        : { attempt, logs: [], total: 0, offset, loading: true }
    ));
    try {
      const res = await fetch(
        `/api/vector/migrations/${encodeURIComponent(key)}?attempt=${attempt}&logsLimit=${LOGS_LIMIT}&logsOffset=${offset}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error('Failed to load run logs');
      const data = await res.json() as MigrationDetailResponse;
      setRunLogs({ attempt, logs: data.logs, total: data.totalLogs, offset, loading: false });
    } catch (err) {
      if (!silent) {
        notifications.show({
          color: 'red',
          title: 'Unable to load run logs',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
      setRunLogs((prev) => (prev && prev.attempt === attempt ? { ...prev, loading: false } : prev));
    }
  }, [key]);

  useEffect(() => {
    void loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Poll while running — also refreshes the open run's log modal, if any.
  useEffect(() => {
    const status = detail?.migration.status;
    const currentAttempt = detail?.migration.attempt;
    if (status && isActive(status)) {
      pollRef.current = setInterval(() => {
        void loadDetail(true);
        const open = runLogsRef.current;
        if (open && open.attempt === currentAttempt) {
          void loadRunLogs(open.attempt, open.offset, true);
        }
      }, POLL_INTERVAL_MS);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [detail?.migration.status, detail?.migration.attempt, loadDetail, loadRunLogs]);

  const handleStart = async () => {
    try {
      const res = await fetch(`/api/vector/migrations/${encodeURIComponent(key)}/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to start');
      notifications.show({ color: 'teal', title: 'Migration started', message: detail?.migration.name });
      await loadDetail();
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
      await loadDetail();
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

  const handleOpenRun = (attempt: number) => {
    void loadRunLogs(attempt, 0);
  };

  const handleCloseRunLogs = () => setRunLogs(null);

  const handleRunLogsPageChange = (offset: number) => {
    if (!runLogs) return;
    void loadRunLogs(runLogs.attempt, offset);
  };

  if (loading && !detail) {
    return (
      <Center py="xl">
        <Loader size="sm" color="teal" />
      </Center>
    );
  }

  if (!detail) return null;

  const { migration, runs } = detail;
  const progressValue =
    migration.totalVectors > 0
      ? Math.min(100, Math.round((migration.migratedVectors / migration.totalVectors) * 100))
      : 0;

  const runLogsPageCount = runLogs ? Math.ceil(runLogs.total / LOGS_LIMIT) : 0;
  const runLogsCurrentPage = runLogs ? Math.floor(runLogs.offset / LOGS_LIMIT) : 0;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Migration"
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
            {isActive(migration.status) && (
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
            {!isActive(migration.status) && (
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
              {isActive(migration.status) && <Loader size={14} color="teal" />}
            </Group>
            <Text size="xs" c="dimmed">
              Key: {migration.key}
              {migration.attempt > 0 && ` · Run #${migration.attempt}`}
            </Text>
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
              <Progress value={progressValue} size="md" color={statusColor(migration.status)} radius="xl" animated={isActive(migration.status)} />
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

      {/* Runs */}
      <Paper withBorder radius="lg" p="lg">
        <Stack gap={2} mb="md">
          <Text fw={600} size="lg">Runs</Text>
          <Text size="xs" c="dimmed">
            {runs.length} run{runs.length === 1 ? '' : 's'} · click a run to see its batch logs
          </Text>
        </Stack>

        {runs.length === 0 ? (
          <Center py="xl">
            <Text size="sm" c="dimmed">No runs yet. Logs appear once the migration starts.</Text>
          </Center>
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Run</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Batches</Table.Th>
                <Table.Th>Migrated</Table.Th>
                <Table.Th>Failed</Table.Th>
                <Table.Th>Started</Table.Th>
                <Table.Th>Ended</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {runs.map((run) => {
                const isCurrentRun = run.attempt === migration.attempt;
                return (
                  <Table.Tr
                    key={run.attempt}
                    onClick={() => handleOpenRun(run.attempt)}
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>
                      <Badge size="sm" variant="filled" color="dark" radius="sm">#{run.attempt}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="xs"
                        variant="light"
                        radius="xl"
                        color={isCurrentRun ? statusColor(migration.status) : 'gray'}
                      >
                        {isCurrentRun ? migration.status : (run.failedBatches > 0 ? 'had failures' : 'replaced')}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{run.batchCount}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{run.migratedCount}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c={run.failedCount > 0 ? 'red' : undefined}>{run.failedCount}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{formatDate(run.startedAt)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{formatDate(run.endedAt)}</Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      {/* Run detail modal */}
      <Modal
        opened={runLogs !== null}
        onClose={handleCloseRunLogs}
        title={runLogs ? `Run #${runLogs.attempt} · Batch Logs` : ''}
        size="xl"
      >
        {runLogs && (
          <Stack gap="md">
            {runLogs.loading && runLogs.logs.length === 0 ? (
              <Center py="xl">
                <Loader size="sm" color="teal" />
              </Center>
            ) : runLogs.logs.length === 0 ? (
              <Center py="xl">
                <Text size="sm" c="dimmed">No batch logs for this run.</Text>
              </Center>
            ) : (
              <>
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
                    {runLogs.logs.map((log, i) => (
                      <Table.Tr key={`${log.migrationKey}-${log.attempt}-${log.batchIndex}-${i}`}>
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

                {runLogsPageCount > 1 && (
                  <Group justify="center" gap="xs">
                    <Button
                      size="xs"
                      variant="subtle"
                      disabled={runLogsCurrentPage === 0}
                      onClick={() => handleRunLogsPageChange(Math.max(0, runLogs.offset - LOGS_LIMIT))}
                    >
                      Previous
                    </Button>
                    <Text size="xs" c="dimmed">
                      Page {runLogsCurrentPage + 1} of {runLogsPageCount}
                    </Text>
                    <Button
                      size="xs"
                      variant="subtle"
                      disabled={runLogsCurrentPage >= runLogsPageCount - 1}
                      onClick={() => handleRunLogsPageChange(runLogs.offset + LOGS_LIMIT)}
                    >
                      Next
                    </Button>
                  </Group>
                )}
              </>
            )}
          </Stack>
        )}
      </Modal>
    </PageContainer>
  );
}
