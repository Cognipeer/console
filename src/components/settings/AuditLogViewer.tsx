'use client';

import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Divider, Drawer, Menu, Text } from '@mantine/core';
import { DatePickerInput, type DatesRangeValue } from '@mantine/dates';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconCalendar, IconChevronDown, IconDownload } from '@tabler/icons-react';
import type { PermissionService } from '@/lib/security/rbac';
import { parseLocalDate } from '@/lib/utils/dashboardDateFilter';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

interface AuditLogRecord {
  id: string;
  action: string;
  actorEmail?: string;
  actorRole?: string;
  actorType: 'user' | 'api_token' | 'system';
  actorUserId?: string;
  apiTokenId?: string;
  createdAt?: string;
  event: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  method?: string;
  outcome: 'success' | 'failure' | 'denied';
  path?: string;
  projectId?: string;
  requestId?: string;
  resourceId?: string;
  resourceType?: string;
  service: PermissionService | string;
  statusCode?: number;
  userAgent?: string;
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

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
  { value: 'admin', label: 'Admin' },
  { value: 'auth', label: 'Auth' },
  { value: 'security', label: 'Security' },
];

const METHOD_OPTIONS = [
  { value: '', label: 'All methods' },
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'DELETE', label: 'DELETE' },
];

/** Inclusive end-of-day for the "to" bound so a single-day range matches that whole day. */
function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

function DetailItem({ label, value, mono }: { label: string; value?: ReactNode; mono?: boolean }) {
  return (
    <div className="ds-col" style={{ gap: 2, minWidth: 0 }}>
      <span className="ds-faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <span
        className={mono ? 'ds-mono' : undefined}
        style={{ fontSize: 13, wordBreak: 'break-all' }}
      >
        {value === undefined || value === null || value === '' ? '—' : value}
      </span>
    </div>
  );
}

export default function AuditLogViewer() {
  const [logs, setLogs] = useState<AuditLogRecord[]>([]);
  const [services, setServices] = useState<PermissionServiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchInput.trim(), 300);
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('');
  const [methodFilter, setMethodFilter] = useState<string>('');
  const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([null, null]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AuditLogRecord | null>(null);
  const [drawerOpened, drawerHandlers] = useDisclosure(false);

  const serviceLabels = useMemo(
    () => new Map(services.map((service) => [service.id, service.label])),
    [services],
  );

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (serviceFilter) params.set('service', serviceFilter);
    if (outcomeFilter) params.set('outcome', outcomeFilter);
    if (actionFilter) params.set('action', actionFilter);
    if (methodFilter) params.set('method', methodFilter);
    if (dateRange[0]) params.set('from', dateRange[0].toISOString());
    if (dateRange[1]) params.set('to', endOfDay(dateRange[1]).toISOString());
    return params;
  }, [actionFilter, dateRange, debouncedSearch, methodFilter, outcomeFilter, serviceFilter]);

  const fetchLogs = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = buildFilterParams();
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
  }, [buildFilterParams, page, pageSize]);

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
  }, [actionFilter, dateRange, debouncedSearch, methodFilter, outcomeFilter, serviceFilter]);

  const handleExport = useCallback(async (format: 'csv' | 'json') => {
    setExporting(true);
    try {
      const params = buildFilterParams();
      params.set('format', format);
      const response = await fetch(`/api/audit/logs/export?${params.toString()}`);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Failed to export audit logs');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `audit-logs.${format}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      notifications.show({
        title: 'Audit log export',
        message: error instanceof Error ? error.message : 'Failed to export audit logs',
        color: 'red',
      });
    } finally {
      setExporting(false);
    }
  }, [buildFilterParams]);

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

  const metadataJson = useMemo(() => {
    if (!selectedLog?.metadata || Object.keys(selectedLog.metadata).length === 0) {
      return null;
    }
    return JSON.stringify(selectedLog.metadata, null, 2);
  }, [selectedLog]);

  return (
    <>
      <DataGrid<AuditLogRecord>
        records={logs}
        loading={loading}
        rowKey={(r) => r.id}
        columns={columns}
        onRowClick={(record) => {
          setSelectedLog(record);
          drawerHandlers.open();
        }}
        search={{
          value: searchInput,
          onChange: setSearchInput,
          placeholder: 'Search event, path or actor…',
        }}
        filters={[
          {
            value: serviceFilter,
            onChange: setServiceFilter,
            ariaLabel: 'Service',
            width: 170,
            options: serviceOptions,
          },
          {
            value: outcomeFilter,
            onChange: setOutcomeFilter,
            ariaLabel: 'Outcome',
            width: 130,
            options: outcomeOptions,
          },
          {
            value: actionFilter,
            onChange: setActionFilter,
            ariaLabel: 'Action',
            width: 130,
            options: ACTION_OPTIONS,
          },
          {
            value: methodFilter,
            onChange: setMethodFilter,
            ariaLabel: 'Method',
            width: 130,
            options: METHOD_OPTIONS,
          },
        ]}
        toolbarRight={
          <>
            <DatePickerInput
              type="range"
              size="xs"
              w={230}
              clearable
              value={dateRange}
              placeholder="Date range"
              valueFormat="MMM D, YYYY"
              aria-label="Date range"
              leftSection={<IconCalendar size={14} stroke={1.5} />}
              onChange={(range: DatesRangeValue) => {
                // Mantine 8 emits 'YYYY-MM-DD' strings — normalize to local Dates.
                setDateRange([parseLocalDate(range[0]), parseLocalDate(range[1])]);
              }}
            />
            <Menu withinPortal position="bottom-end" withArrow>
              <Menu.Target>
                <Button
                  size="xs"
                  variant="default"
                  loading={exporting}
                  leftSection={<IconDownload size={14} stroke={1.7} />}
                  rightSection={<IconChevronDown size={12} stroke={1.7} />}
                >
                  Export
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => void handleExport('csv')}>Export as CSV</Menu.Item>
                <Menu.Item onClick={() => void handleExport('json')}>Export as JSON</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
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

      <Drawer
        opened={drawerOpened && !!selectedLog}
        onClose={() => {
          drawerHandlers.close();
          setSelectedLog(null);
        }}
        position="right"
        size="lg"
        title="Audit event"
      >
        {selectedLog ? (
          <div className="ds-col" style={{ gap: 16 }}>
            <div className="ds-row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge color={outcomeColor(selectedLog.outcome)} variant="light">
                {selectedLog.outcome}
              </Badge>
              <Badge variant="light" color="gray">
                {serviceLabels.get(selectedLog.service as PermissionService) ?? selectedLog.service}
              </Badge>
              <Badge variant="outline" color="gray">
                {selectedLog.action}
              </Badge>
              <span className="ds-faint" style={{ fontSize: 12, marginLeft: 'auto' }}>
                {selectedLog.createdAt ? new Date(selectedLog.createdAt).toLocaleString() : '—'}
              </span>
            </div>

            <Divider label="Request" labelPosition="left" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <DetailItem label="Event" value={selectedLog.event} />
              <DetailItem label="Status code" value={selectedLog.statusCode} mono />
              <DetailItem
                label="Method / Path"
                value={selectedLog.method || selectedLog.path
                  ? `${selectedLog.method ?? ''} ${selectedLog.path ?? ''}`.trim()
                  : undefined}
                mono
              />
              <DetailItem label="Request ID" value={selectedLog.requestId} mono />
            </div>

            <Divider label="Actor" labelPosition="left" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <DetailItem label="Type" value={selectedLog.actorType} />
              <DetailItem label="Email" value={selectedLog.actorEmail} />
              <DetailItem label="Role" value={selectedLog.actorRole} />
              <DetailItem label="User ID" value={selectedLog.actorUserId} mono />
              {selectedLog.apiTokenId ? (
                <DetailItem label="API token ID" value={selectedLog.apiTokenId} mono />
              ) : null}
              <DetailItem label="IP address" value={selectedLog.ipAddress} mono />
            </div>
            <DetailItem label="User agent" value={selectedLog.userAgent} mono />

            {selectedLog.projectId || selectedLog.resourceType || selectedLog.resourceId ? (
              <>
                <Divider label="Context" labelPosition="left" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <DetailItem label="Project ID" value={selectedLog.projectId} mono />
                  <DetailItem label="Resource type" value={selectedLog.resourceType} />
                  <DetailItem label="Resource ID" value={selectedLog.resourceId} mono />
                </div>
              </>
            ) : null}

            {metadataJson ? (
              <>
                <Divider label="Metadata" labelPosition="left" />
                <pre
                  className="ds-mono"
                  style={{
                    margin: 0,
                    padding: 12,
                    fontSize: 12,
                    borderRadius: 8,
                    border: '1px solid var(--ds-border-soft)',
                    background: 'var(--ds-bg-subtle, transparent)',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {metadataJson}
                </pre>
              </>
            ) : null}

            <Divider />
            <DetailItem label="Event ID" value={selectedLog.id} mono />
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
