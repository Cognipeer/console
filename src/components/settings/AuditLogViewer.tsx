'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Group, Select, Stack, Text } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconRefresh } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { PermissionService } from '@/lib/security/rbac';
import { TABLE_PAGE_SIZE_OPTIONS } from '@/hooks/useClientTable';

interface AuditLogRecord {
  id: string;
  action: string;
  actorEmail?: string;
  actorRole?: string;
  actorType: 'user' | 'api_token' | 'system';
  createdAt?: string;
  event: string;
  method?: string;
  outcome: 'success' | 'failure' | 'denied';
  path?: string;
  service: PermissionService | string;
  statusCode?: number;
}

interface PermissionServiceOption {
  id: PermissionService;
  label: string;
}

function outcomeColor(outcome: AuditLogRecord['outcome']) {
  if (outcome === 'success') return 'green';
  if (outcome === 'denied') return 'orange';
  return 'red';
}

export default function AuditLogViewer() {
  const [logs, setLogs] = useState<AuditLogRecord[]>([]);
  const [services, setServices] = useState<PermissionServiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [serviceFilter, setServiceFilter] = useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [hasNextPage, setHasNextPage] = useState(false);

  const serviceLabels = useMemo(
    () => new Map(services.map((service) => [service.id, service.label])),
    [services],
  );

  const fetchLogs = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (serviceFilter) params.set('service', serviceFilter);
      if (outcomeFilter) params.set('outcome', outcomeFilter);
      params.set('limit', String(pageSize + 1));
      params.set('skip', String((page - 1) * pageSize));

      const response = await fetch(`/api/audit/logs?${params.toString()}`, { signal });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load audit logs');
      }
      const nextLogs = (data.logs ?? []) as AuditLogRecord[];
      setHasNextPage(nextLogs.length > pageSize);
      setLogs(nextLogs.slice(0, pageSize));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      notifications.show({
        title: 'Audit log',
        message: error instanceof Error ? error.message : 'Failed to load audit logs',
        color: 'red',
      });
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [outcomeFilter, page, pageSize, serviceFilter]);

  useEffect(() => {
    async function fetchServices() {
      try {
        const response = await fetch('/api/audit/services');
        if (!response.ok) return;
        const data = await response.json() as { services?: PermissionServiceOption[] };
        setServices(data.services ?? []);
      } catch {
        setServices([]);
      }
    }
    void fetchServices();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchLogs(controller.signal);
    return () => controller.abort();
  }, [fetchLogs]);

  useEffect(() => {
    setPage(1);
  }, [outcomeFilter, pageSize, serviceFilter]);

  return (
    <Box p="md">
      <Stack gap="md">
        <Group justify="space-between" align="flex-end">
          <Group gap="sm" align="flex-end">
            <Select
              label="Service"
              placeholder="All services"
              clearable
              searchable
              value={serviceFilter}
              data={services.map((service) => ({ value: service.id, label: service.label }))}
              onChange={setServiceFilter}
              w={220}
            />
            <Select
              label="Outcome"
              placeholder="All outcomes"
              clearable
              value={outcomeFilter}
              data={[
                { value: 'success', label: 'Success' },
                { value: 'failure', label: 'Failure' },
                { value: 'denied', label: 'Denied' },
              ]}
              onChange={setOutcomeFilter}
              w={180}
            />
            <Select
              label="Page size"
              value={String(pageSize)}
              data={TABLE_PAGE_SIZE_OPTIONS.map((value) => ({
                value: String(value),
                label: `${value} rows`,
              }))}
              onChange={(value) => setPageSize(value ? Number(value) : 25)}
              w={140}
            />
          </Group>
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            onClick={() => void fetchLogs()}
          >
            Refresh
          </Button>
        </Group>

        <DataTable
          withTableBorder
          borderRadius="sm"
          striped
          highlightOnHover
          fetching={loading}
          records={logs}
          totalRecords={(page - 1) * pageSize + logs.length + (hasNextPage ? 1 : 0)}
          recordsPerPage={pageSize}
          page={page}
          onPageChange={setPage}
          minHeight={360}
          noRecordsText="No audit events"
          columns={[
            {
              accessor: 'createdAt',
              title: 'Time',
              width: 180,
              render: (record) =>
                record.createdAt ? new Date(record.createdAt).toLocaleString() : '-',
            },
            {
              accessor: 'service',
              title: 'Service',
              width: 170,
              render: (record) => (
                <Badge variant="light" color="gray">
                  {serviceLabels.get(record.service as PermissionService) ?? record.service}
                </Badge>
              ),
            },
            {
              accessor: 'event',
              title: 'Event',
              render: (record) => (
                <div>
                  <Text size="sm" fw={500}>{record.event}</Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>{record.path}</Text>
                </div>
              ),
            },
            {
              accessor: 'actor',
              title: 'Actor',
              width: 220,
              render: (record) => (
                <div>
                  <Text size="sm">{record.actorEmail || record.actorType}</Text>
                  <Text size="xs" c="dimmed">{record.actorRole || record.actorType}</Text>
                </div>
              ),
            },
            {
              accessor: 'outcome',
              title: 'Outcome',
              width: 120,
              render: (record) => (
                <Badge color={outcomeColor(record.outcome)} variant="light">
                  {record.outcome}
                </Badge>
              ),
            },
            {
              accessor: 'statusCode',
              title: 'Status',
              width: 90,
              render: (record) => record.statusCode ?? '-',
            },
          ]}
        />
      </Stack>
    </Box>
  );
}
