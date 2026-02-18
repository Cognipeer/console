'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  Stack,
  Group,
  Text,
  TextInput,
  Select,
  Button,
  Paper,
  Badge,
  Pagination,
  Table,
  Tooltip,
  Box,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconRefresh,
  IconSearch,
  IconCalendar,
  IconAdjustments,
  IconBook,
  IconTimeline,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import PageHeader from '@/components/layout/PageHeader';
import { formatDuration, formatNumber, formatRelativeTime, resolveStatusColor } from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

dayjs.extend(relativeTime);

interface ThreadRecord {
  threadId: string;
  sessionsCount: number;
  agents: string[];
  statuses: string[];
  latestStatus: string;
  startedAt: string;
  endedAt?: string;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  modelsUsed: string[];
}

interface ThreadsResponse {
  threads: ThreadRecord[];
  total: number;
}

const DEFAULT_PAGE_SIZE = 25;

export default function TracingThreadsPage() {
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [totalThreads, setTotalThreads] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [threadIdFilter, setThreadIdFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([null, null]);

  const pagination = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(totalThreads / pageSize));
    return { totalPages };
  }, [totalThreads, pageSize]);

  const buildQueryParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set('limit', pageSize.toString());
    params.set('skip', ((page - 1) * pageSize).toString());

    if (threadIdFilter) params.set('threadId', threadIdFilter.trim());
    if (agentFilter) params.set('agent', agentFilter.trim());
    if (statusFilter) params.set('status', statusFilter);

    const [from, to] = dateRange;
    if (from) params.set('from', dayjs(from).startOf('day').toISOString());
    if (to) params.set('to', dayjs(to).endOf('day').toISOString());

    return params;
  }, [threadIdFilter, agentFilter, dateRange, page, pageSize, statusFilter]);

  const fetchThreads = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const params = buildQueryParams();
      const response = await fetch(`/api/tracing/threads?${params.toString()}`);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch threads');
      }

      const data: ThreadsResponse = await response.json();
      setThreads(data.threads || []);
      setTotalThreads(data.total || 0);
    } catch (error) {
      console.error('Failed to load threads:', error);
      setThreads([]);
      setTotalThreads(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [buildQueryParams]);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  const handleRefresh = () => {
    fetchThreads(true);
  };

  const handleThreadClick = (threadId: string) => {
    router.push(`/dashboard/tracing/threads/${threadId}`);
  };

  const appliedFilters = useMemo(() => {
    const filters: { label: string; value: string }[] = [];
    if (threadIdFilter) filters.push({ label: 'Thread ID', value: threadIdFilter });
    if (agentFilter) filters.push({ label: 'Agent', value: agentFilter });
    if (statusFilter) filters.push({ label: 'Status', value: statusFilter });
    if (dateRange[0] || dateRange[1]) {
      const start = dateRange[0] ? dayjs(dateRange[0]).format('MMM D, YYYY') : '—';
      const end = dateRange[1] ? dayjs(dateRange[1]).format('MMM D, YYYY') : '—';
      filters.push({ label: 'Date Range', value: `${start} → ${end}` });
    }
    return filters;
  }, [threadIdFilter, agentFilter, dateRange, statusFilter]);

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconTimeline size={18} />}
        title="Thread Explorer"
        subtitle="View threads that group multiple agent sessions together. Each thread represents a single end-to-end workflow."
        actions={
          <>
            <Button
              onClick={() => openDocs('api-tracing')}
              variant="light"
              size="xs"
              leftSection={<IconBook size={14} />}
            >
              Docs
            </Button>
            <Button
              leftSection={<IconRefresh size={14} />}
              variant="light"
              size="xs"
              onClick={handleRefresh}
              loading={refreshing || loading}
            >
              Refresh
            </Button>
          </>
        }
      />

      <Card withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group gap="md" wrap="wrap">
            <TextInput
              label="Thread ID"
              placeholder="Search by thread ID"
              leftSection={<IconSearch size={16} />}
              value={threadIdFilter}
              onChange={(event) => {
                setThreadIdFilter(event.currentTarget.value);
                setPage(1);
              }}
              style={{ minWidth: 260 }}
            />
            <TextInput
              label="Agent"
              placeholder="Filter by agent name"
              leftSection={<IconSearch size={16} />}
              value={agentFilter}
              onChange={(event) => {
                setAgentFilter(event.currentTarget.value);
                setPage(1);
              }}
              style={{ minWidth: 220 }}
            />
            <Select
              label="Status"
              placeholder="All statuses"
              data={[
                { value: 'success', label: 'Success' },
                { value: 'error', label: 'Error' },
                { value: 'in_progress', label: 'In Progress' },
              ]}
              value={statusFilter}
              onChange={(value) => {
                setStatusFilter(value);
                setPage(1);
              }}
              clearable
              style={{ minWidth: 180 }}
            />
            <DatePickerInput
              type="range"
              label="Date Range"
              placeholder="Select range"
              value={dateRange}
              onChange={(value) => {
                setDateRange(value as [Date | null, Date | null]);
                setPage(1);
              }}
              leftSection={<IconCalendar size={16} />}
              clearable
              style={{ minWidth: 260 }}
            />
            <Select
              label="Page size"
              data={['25', '50', '100'].map((value) => ({ value, label: `${value} rows` }))}
              value={pageSize.toString()}
              onChange={(value) => {
                setPageSize(value ? parseInt(value, 10) : DEFAULT_PAGE_SIZE);
                setPage(1);
              }}
              leftSection={<IconAdjustments size={16} />}
              style={{ minWidth: 140 }}
            />
          </Group>

          {appliedFilters.length > 0 && (
            <Group gap="xs">
              {appliedFilters.map((filter) => (
                <Badge key={`${filter.label}-${filter.value}`} variant="light" color="blue">
                  {filter.label}: {filter.value}
                </Badge>
              ))}
            </Group>
          )}
        </Stack>
      </Card>

      <Paper withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Text fw={600}>Threads</Text>
            <Badge size="sm" variant="light">
              {formatNumber(totalThreads)} total
            </Badge>
          </Group>

          {loading ? (
            <Box p="xl" style={{ textAlign: 'center' }}>
              <Text c="dimmed">Loading threads...</Text>
            </Box>
          ) : threads.length === 0 ? (
            <Box p="xl" style={{ textAlign: 'center' }}>
              <Text c="dimmed">No threads found. Threads are created when sessions include a threadId.</Text>
            </Box>
          ) : (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Thread ID</Table.Th>
                  <Table.Th>Agents</Table.Th>
                  <Table.Th>Sessions</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Started</Table.Th>
                  <Table.Th>Duration</Table.Th>
                  <Table.Th>Events</Table.Th>
                  <Table.Th>Tokens</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {threads.map((thread) => (
                  <Table.Tr
                    key={thread.threadId}
                    onClick={() => handleThreadClick(thread.threadId)}
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>
                      <Tooltip label={thread.threadId}>
                        <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }} lineClamp={1}>
                          {thread.threadId.length > 16
                            ? `${thread.threadId.substring(0, 16)}...`
                            : thread.threadId}
                        </Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {thread.agents.slice(0, 3).map((agent) => (
                          <Badge key={agent} size="xs" variant="light" color="gray">
                            {agent}
                          </Badge>
                        ))}
                        {thread.agents.length > 3 && (
                          <Text size="xs" c="dimmed">+{thread.agents.length - 3}</Text>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{thread.sessionsCount}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" radius="xl" color={resolveStatusColor(thread.latestStatus)}>
                        {(thread.latestStatus || 'unknown').toUpperCase()}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatRelativeTime(thread.startedAt)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatDuration(thread.totalDurationMs)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatNumber(thread.totalEvents)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatNumber(thread.totalInputTokens + thread.totalOutputTokens)}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}

          {pagination.totalPages > 1 && (
            <Group justify="space-between" align="center">
              <Text size="sm" c="dimmed">
                Page {page} of {pagination.totalPages}
              </Text>
              <Pagination total={pagination.totalPages} value={page} onChange={setPage} />
            </Group>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
