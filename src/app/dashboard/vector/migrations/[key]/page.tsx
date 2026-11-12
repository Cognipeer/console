'use client';

import { useEffect, useState } from 'react';
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
import { useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { errorMessage, isApiError } from '@/lib/api/client';
import {
  useCancelVectorMigration,
  useDeleteVectorMigration,
  useStartVectorMigration,
  useVectorMigration,
  useVectorMigrationRunLogs,
} from '@/lib/api/queries/vector';
import {
  IconArrowLeft,
  IconArrowRight,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type { VectorMigrationStatus } from '@/lib/database/provider/types.base';

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

export default function VectorMigrationDetailPage() {
  const deleteResource = useDeleteResource();
  const tSafe = useTranslations('common.confirm.dataSafety');
  const { key } = useParams<{ key: string }>()!;
  const router = useRouter();
  const detailQuery = useVectorMigration(key, POLL_INTERVAL_MS);
  const detail = detailQuery.data ?? null;
  /** The run whose logs are open in the modal, and the page of them. */
  const [openRun, setOpenRun] = useState<{ attempt: number; offset: number } | null>(null);
  // The open run is refreshed while it is the running one.
  const runIsLive = Boolean(
    detail
    && openRun
    && isActive(detail.migration.status)
    && openRun.attempt === detail.migration.attempt,
  );
  const runLogsQuery = useVectorMigrationRunLogs(key, openRun, LOGS_LIMIT, runIsLive, POLL_INTERVAL_MS);
  const runLogs = openRun
    ? {
        attempt: openRun.attempt,
        offset: openRun.offset,
        logs: runLogsQuery.data?.logs ?? [],
        total: runLogsQuery.data?.totalLogs ?? 0,
        loading: runLogsQuery.isPending || runLogsQuery.isPlaceholderData,
      }
    : null;
  const startMigration = useStartVectorMigration();
  const cancelMigration = useCancelVectorMigration();
  const deleteMigration = useDeleteVectorMigration();

  // A missing migration sends the user back to the list; the first load that fails otherwise is told (poll failures are not).
  const loadError = detailQuery.isError && detailQuery.data === undefined ? detailQuery.error : null;
  useEffect(() => {
    if (!loadError) return;
    if (isApiError(loadError) && loadError.status === 404) {
      router.replace('/dashboard/vector/migrations');
      return;
    }
    notifications.show({
      color: 'red',
      title: 'Unable to load migration',
      message: errorMessage(loadError, 'Unexpected error'),
    });
  }, [loadError, router]);

  const runLogsError = openRun && runLogsQuery.isError && runLogsQuery.data === undefined ? runLogsQuery.error : null;
  useEffect(() => {
    if (!runLogsError) return;
    notifications.show({
      color: 'red',
      title: 'Unable to load run logs',
      message: errorMessage(runLogsError, 'Unexpected error'),
    });
  }, [runLogsError]);

  const handleStart = async () => {
    try {
      await startMigration.mutateAsync(key);
      notifications.show({ color: 'teal', title: 'Migration started', message: detail?.migration.name });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to start', message: errorMessage(err, 'Unexpected error') });
    }
  };

  const handleCancel = async () => {
    try {
      await cancelMigration.mutateAsync(key);
      notifications.show({ color: 'yellow', title: 'Migration cancelled', message: detail?.migration.name });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Unable to cancel', message: errorMessage(err, 'Unexpected error') });
    }
  };

  const handleDelete = () =>
    deleteResource({
      noun: tSafe('nouns.vectorMigration'),
      name: detail?.migration.name ?? key,
      action: async () => {
        try {
          await deleteMigration.mutateAsync(key);
        } catch (err) {
          throw new Error(errorMessage(err, 'Failed to delete'));
        }
        notifications.show({ color: 'green', title: 'Migration deleted', message: key });
        router.push('/dashboard/vector/migrations');
      },
    });

  const handleOpenRun = (attempt: number) => {
    setOpenRun({ attempt, offset: 0 });
  };

  const handleCloseRunLogs = () => setOpenRun(null);

  const handleRunLogsPageChange = (offset: number) => {
    setOpenRun((current) => (current ? { ...current, offset } : current));
  };

  if (detailQuery.isPending) {
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

  const runColumns: DataGridColumn<(typeof runs)[number]>[] = [
    {
      key: 'run',
      label: 'Run',
      render: (run) => <Badge size="sm" variant="filled" color="dark" radius="sm">#{run.attempt}</Badge>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (run) => {
        const isCurrentRun = run.attempt === migration.attempt;
        return (
          <Badge
            size="xs"
            variant="light"
            radius="xl"
            color={isCurrentRun ? statusColor(migration.status) : 'gray'}
          >
            {isCurrentRun ? migration.status : (run.failedBatches > 0 ? 'had failures' : 'replaced')}
          </Badge>
        );
      },
    },
    { key: 'batches', label: 'Batches', render: (run) => <Text size="xs">{run.batchCount}</Text> },
    { key: 'migrated', label: 'Migrated', render: (run) => <Text size="xs">{run.migratedCount}</Text> },
    {
      key: 'failed',
      label: 'Failed',
      render: (run) => <Text size="xs" c={run.failedCount > 0 ? 'red' : undefined}>{run.failedCount}</Text>,
    },
    {
      key: 'started',
      label: 'Started',
      render: (run) => <Text size="xs" c="dimmed">{formatDate(run.startedAt)}</Text>,
    },
    {
      key: 'ended',
      label: 'Ended',
      render: (run) => <Text size="xs" c="dimmed">{formatDate(run.endedAt)}</Text>,
    },
  ];

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

        <DataGrid<(typeof runs)[number]>
          records={runs}
          rowKey={(run) => String(run.attempt)}
          columns={runColumns}
          onRowClick={(run) => handleOpenRun(run.attempt)}
          empty={{ title: 'No runs yet. Logs appear once the migration starts.' }}
        />
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
