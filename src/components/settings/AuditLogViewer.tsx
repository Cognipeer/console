'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { PermissionService } from '@/lib/security/rbac';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

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
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
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
  }, [outcomeFilter, serviceFilter]);

  const serviceOptions = useMemo(
    () => [
      { value: '', label: 'All services' },
      ...services.map((service) => ({ value: service.id, label: service.label })),
    ],
    [services],
  );

  const outcomeOptions = [
    { value: '', label: 'All outcomes' },
    { value: 'success', label: 'Success' },
    { value: 'failure', label: 'Failure' },
    { value: 'denied', label: 'Denied' },
  ];

  const columns: DataGridColumn<AuditLogRecord>[] = [
    {
      key: 'createdAt',
      label: 'Time',
      width: 180,
      render: (record) => (
        <span className="ds-faint" style={{ fontSize: 12 }}>
          {record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'}
        </span>
      ),
    },
    {
      key: 'service',
      label: 'Service',
      width: 170,
      render: (record) => (
        <Badge variant="light" color="gray">
          {serviceLabels.get(record.service as PermissionService) ?? record.service}
        </Badge>
      ),
    },
    {
      key: 'event',
      label: 'Event',
      render: (record) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{record.event}</span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{record.path}</span>
        </div>
      ),
    },
    {
      key: 'actor',
      label: 'Actor',
      width: 220,
      render: (record) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13 }}>{record.actorEmail || record.actorType}</span>
          <span className="ds-faint" style={{ fontSize: 11 }}>{record.actorRole || record.actorType}</span>
        </div>
      ),
    },
    {
      key: 'outcome',
      label: 'Outcome',
      width: 120,
      render: (record) => (
        <Badge color={outcomeColor(record.outcome)} variant="light">
          {record.outcome}
        </Badge>
      ),
    },
    {
      key: 'statusCode',
      label: 'Status',
      width: 90,
      render: (record) => (
        <Text size="sm" ff="monospace">
          {record.statusCode ?? '—'}
        </Text>
      ),
    },
  ];

  return (
    <DataGrid<AuditLogRecord>
      records={logs}
      loading={loading}
      rowKey={(r) => r.id}
      columns={columns}
      filters={[
        {
          value: serviceFilter,
          onChange: setServiceFilter,
          ariaLabel: 'Service',
          width: 200,
          options: serviceOptions,
        },
        {
          value: outcomeFilter,
          onChange: setOutcomeFilter,
          ariaLabel: 'Outcome',
          width: 160,
          options: outcomeOptions,
        },
      ]}
      onRefresh={() => void fetchLogs()}
      refreshing={loading}
      empty={{
        title: 'No audit events',
        description: 'No audit events match the current filters.',
      }}
      pagination={{
        page,
        onPageChange: setPage,
        pageSize,
        hasMore: hasNextPage,
      }}
      footerLeft={`Page ${page}`}
    />
  );
}
