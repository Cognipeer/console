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
  ThemeIcon,
  Title,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconBook, IconRefresh, IconSearch, IconCalendar, IconAdjustments } from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import SessionTable from '@/components/tracing/SessionTable';
import PageHeader from '@/components/layout/PageHeader';
import { formatNumber } from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

interface SessionRecord {
  sessionId: string;
  agentName?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalEvents?: number;
  totalTokens?: number;
}

interface SessionsResponse {
  sessions: SessionRecord[];
  total: number;
}

dayjs.extend(relativeTime);

const DEFAULT_PAGE_SIZE = 25;

export default function TracingSessionsPage() {
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([null, null]);

  const pagination = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(totalSessions / pageSize));
    return { totalPages };
  }, [totalSessions, pageSize]);

  const buildQueryParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set('limit', pageSize.toString());
    params.set('skip', ((page - 1) * pageSize).toString());

    if (query) params.set('query', query.trim());
    if (agentFilter) params.set('agent', agentFilter.trim());
    if (statusFilter) params.set('status', statusFilter);

    const [from, to] = dateRange;
    if (from) params.set('from', dayjs(from).startOf('day').toISOString());
    if (to) params.set('to', dayjs(to).endOf('day').toISOString());

    return params;
  }, [agentFilter, dateRange, page, pageSize, query, statusFilter]);

  const fetchSessions = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const params = buildQueryParams();
      const response = await fetch(`/api/tracing/sessions?${params.toString()}`);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch sessions');
      }

  const data: SessionsResponse = await response.json();
      setSessions(data.sessions || []);
      setTotalSessions(data.total || 0);
    } catch (error) {
      console.error('Failed to load sessions:', error);
      setSessions([]);
      setTotalSessions(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [buildQueryParams]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRefresh = () => {
    fetchSessions(true);
  };

  const handlePageChange = (nextPage: number) => {
    setPage(nextPage);
  };

  const handlePageSizeChange = (value: string | null) => {
    const size = value ? parseInt(value, 10) : DEFAULT_PAGE_SIZE;
    setPageSize(size);
    setPage(1);
  };

  const handleSessionClick = (sessionId: string) => {
    router.push(`/dashboard/tracing/sessions/${sessionId}`);
  };

  const appliedFilters = useMemo(() => {
    const filters: { label: string; value: string }[] = [];
    if (query) filters.push({ label: 'Search', value: query });
    if (agentFilter) filters.push({ label: 'Agent', value: agentFilter });
    if (statusFilter) filters.push({ label: 'Status', value: statusFilter });
    if (dateRange[0] || dateRange[1]) {
      const start = dateRange[0] ? dayjs(dateRange[0]).format('MMM D, YYYY') : '—';
      const end = dateRange[1] ? dayjs(dateRange[1]).format('MMM D, YYYY') : '—';
      filters.push({ label: 'Date Range', value: `${start} → ${end}` });
    }
    return filters;
  }, [agentFilter, dateRange, query, statusFilter]);

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconAdjustments size={18} />}
        title="Session Explorer"
        subtitle="Inspect recent agent sessions, filter by agent or status, and drill into the execution timeline."
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
              label="Search"
              placeholder="Search session ID or agent"
              leftSection={<IconSearch size={16} />}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setPage(1);
              }}
              style={{ minWidth: 220 }}
            />
            <TextInput
              label="Agent"
              placeholder="Agent name"
              value={agentFilter}
              onChange={(event) => {
                setAgentFilter(event.currentTarget.value);
                setPage(1);
              }}
              style={{ minWidth: 200 }}
            />
            <Select
              label="Status"
              placeholder="All statuses"
              data={[
                { value: 'success', label: 'Success' },
                { value: 'error', label: 'Error' },
                { value: 'running', label: 'Running' },
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
              onChange={handlePageSizeChange}
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
            <Text fw={600}>Sessions</Text>
            <Badge size="sm" variant="light">
              {formatNumber(totalSessions)} total
            </Badge>
          </Group>
          <SessionTable sessions={sessions} loading={loading} onRowClick={handleSessionClick} />
          {pagination.totalPages > 1 && (
            <Group justify="space-between" align="center">
              <Text size="sm" c="dimmed">
                Page {page} of {pagination.totalPages}
              </Text>
              <Pagination total={pagination.totalPages} value={page} onChange={handlePageChange} />
            </Group>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
