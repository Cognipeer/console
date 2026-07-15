'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, SegmentedControl, Tooltip } from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconClock,
  IconRefresh,
  IconServer,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import type { McpServerView } from '@/lib/services/mcp';

interface MonitorEntry {
  server: McpServerView;
  aggregate: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    avgLatencyMs: number | null;
  };
  runtime: {
    kind: 'openapi' | 'remote' | 'stdio-subprocess' | 'stdio-sandbox';
    state: 'ready' | 'disabled' | 'degraded' | 'unavailable';
    detail?: string;
  };
}

interface RequestLogRow {
  _id?: string;
  serverKey: string;
  toolName: string;
  status: string;
  latencyMs?: number;
  errorMessage?: string;
  callerType?: string;
  transport?: string;
  createdAt?: string;
}

interface AuditRow {
  _id?: string;
  serverKey: string;
  action: string;
  performedBy: string;
  ipAddress?: string;
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  createdAt?: string;
}

const RUNTIME_LABELS: Record<string, string> = {
  'openapi': 'OpenAPI proxy',
  'remote': 'Remote proxy',
  'stdio-subprocess': 'Subprocess',
  'stdio-sandbox': 'Sandbox',
};

const STATE_BADGE: Record<string, 'active' | 'paused' | 'error' | 'pending'> = {
  ready: 'active',
  disabled: 'paused',
  degraded: 'error',
  unavailable: 'pending',
};

function formatTime(value?: string): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function McpMonitorPage() {
  const [entries, setEntries] = useState<MonitorEntry[]>([]);
  const [recentLogs, setRecentLogs] = useState<RequestLogRow[]>([]);
  const [recentAudit, setRecentAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activityView, setActivityView] = useState<'requests' | 'audit'>('requests');
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mcp/monitor', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setEntries(data.servers ?? []);
        setRecentLogs(data.recentLogs ?? []);
        setRecentAudit(data.recentAudit ?? []);
      }
    } catch (err) {
      console.error('Failed to load MCP monitor snapshot', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const totals = useMemo(() => {
    const requests = entries.reduce((s, e) => s + e.aggregate.totalRequests, 0);
    const errors = entries.reduce((s, e) => s + e.aggregate.errorCount, 0);
    const latencies = entries
      .map((e) => e.aggregate.avgLatencyMs)
      .filter((l): l is number => typeof l === 'number' && l > 0);
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length)
      : null;
    const degraded = entries.filter(
      (e) => e.runtime.state === 'degraded' || e.runtime.state === 'unavailable',
    ).length;
    return { requests, errors, avgLatency, degraded };
  }, [entries]);

  const serverColumns: DataGridColumn<MonitorEntry>[] = [
    {
      key: 'name',
      label: 'Server',
      render: (e) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {e.server.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {e.server.key}
          </span>
        </div>
      ),
    },
    {
      key: 'runtime',
      label: 'Runtime',
      render: (e) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span className="ds-badge">{RUNTIME_LABELS[e.runtime.kind]}</span>
          {e.runtime.detail ? (
            <Tooltip label={e.runtime.detail} multiline maw={360}>
              <span className="ds-faint" style={{ fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.runtime.detail}
              </span>
            </Tooltip>
          ) : null}
        </div>
      ),
    },
    {
      key: 'state',
      label: 'State',
      render: (e) => <StatusBadge status={STATE_BADGE[e.runtime.state] ?? 'pending'} />,
    },
    {
      key: 'requests24h',
      label: 'Requests (24h)',
      align: 'right',
      render: (e) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {e.aggregate.totalRequests.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'errors24h',
      label: 'Errors (24h)',
      align: 'right',
      render: (e) => (
        <span
          className="ds-mono"
          style={{
            fontSize: 12.5,
            fontVariantNumeric: 'tabular-nums',
            color: e.aggregate.errorCount > 0 ? 'var(--mantine-color-red-6)' : undefined,
          }}
        >
          {e.aggregate.errorCount.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'latency',
      label: 'Avg latency',
      align: 'right',
      render: (e) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {e.aggregate.avgLatencyMs != null ? `${Math.round(e.aggregate.avgLatencyMs)} ms` : '—'}
        </span>
      ),
    },
    {
      key: 'access',
      label: 'Access',
      render: (e) => (
        <span className="ds-badge">
          {e.server.exposure?.accessMode === 'public' ? 'Public' : 'Token'}
        </span>
      ),
    },
  ];

  const logColumns: DataGridColumn<RequestLogRow>[] = [
    {
      key: 'time',
      label: 'Time',
      render: (l) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
          {formatTime(l.createdAt)}
        </span>
      ),
    },
    {
      key: 'server',
      label: 'Server',
      render: (l) => <span className="ds-mono" style={{ fontSize: 12 }}>{l.serverKey}</span>,
    },
    {
      key: 'tool',
      label: 'Tool',
      render: (l) => <span className="ds-mono" style={{ fontSize: 12 }}>{l.toolName}</span>,
    },
    {
      key: 'caller',
      label: 'Caller',
      render: (l) => (
        <span className="ds-badge">
          {l.callerType ?? 'api'}{l.transport ? ` · ${l.transport}` : ''}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (l) => (
        <StatusBadge status={l.status === 'success' ? 'active' : 'error'} />
      ),
    },
    {
      key: 'latency',
      label: 'Latency',
      align: 'right',
      render: (l) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>
          {l.latencyMs != null ? `${l.latencyMs} ms` : '—'}
        </span>
      ),
    },
  ];

  const auditColumns: DataGridColumn<AuditRow>[] = [
    {
      key: 'time',
      label: 'Time',
      render: (a) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
          {formatTime(a.createdAt)}
        </span>
      ),
    },
    {
      key: 'server',
      label: 'Server',
      render: (a) => <span className="ds-mono" style={{ fontSize: 12 }}>{a.serverKey}</span>,
    },
    {
      key: 'action',
      label: 'Action',
      render: (a) => <span className="ds-badge">{a.action.replace(/_/g, ' ')}</span>,
    },
    {
      key: 'actor',
      label: 'By',
      render: (a) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 11.5 }}>
          {a.performedBy}{a.ipAddress ? ` · ${a.ipAddress}` : ''}
        </span>
      ),
    },
    {
      key: 'changes',
      label: 'Changes',
      render: (a) => {
        const keys = Object.keys(a.changes ?? {});
        return (
          <span className="ds-faint" style={{ fontSize: 11.5 }}>
            {keys.length ? keys.join(', ') : '—'}
          </span>
        );
      },
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · MCP · Monitor"
        title="MCP Monitor"
        subtitle="Runtime health, traffic and audit trail for every MCP server in this project."
        actions={
          <Button
            variant="default"
            size="sm"
            leftSection={<IconRefresh size={14} stroke={1.7} />}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Servers" value={entries.length} icon={<IconServer size={14} />} />
        <StatTile label="Requests (24h)" value={totals.requests.toLocaleString()} icon={<IconActivity size={14} />} />
        <StatTile
          label="Errors (24h)"
          value={totals.errors.toLocaleString()}
          icon={<IconAlertTriangle size={14} />}
        />
        <StatTile
          label="Avg latency"
          value={totals.avgLatency != null ? `${totals.avgLatency} ms` : '—'}
          icon={<IconClock size={14} />}
        />
        <StatTile label="Degraded" value={totals.degraded} />
      </div>

      <div style={{ marginBottom: 20 }}>
        <DataGrid<MonitorEntry>
          records={entries}
          loading={loading}
          rowKey={(e) => e.server.id}
          onRowClick={(e) => router.push(`/dashboard/mcp/${e.server.id}`)}
          columns={serverColumns}
          empty={{
            icon: <IconServer size={26} stroke={1.7} />,
            title: 'No MCP servers',
            description: 'Create an MCP server to see runtime health and traffic here.',
          }}
          footerLeft={`${entries.length} servers`}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-text)' }}>
          Recent activity
        </span>
        <SegmentedControl
          size="xs"
          value={activityView}
          onChange={(val) => setActivityView(val as 'requests' | 'audit')}
          data={[
            { value: 'requests', label: 'Tool calls' },
            { value: 'audit', label: 'Audit trail' },
          ]}
        />
      </div>

      {activityView === 'requests' ? (
        <DataGrid<RequestLogRow>
          records={recentLogs}
          loading={loading}
          rowKey={(l) => l._id ?? `${l.serverKey}-${l.toolName}-${l.createdAt ?? ''}`}
          columns={logColumns}
          empty={{
            icon: <IconActivity size={26} stroke={1.7} />,
            title: 'No recent tool calls',
            description: 'Tool calls across all servers in this project appear here.',
          }}
          footerLeft={`${recentLogs.length} recent calls`}
        />
      ) : (
        <DataGrid<AuditRow>
          records={recentAudit}
          loading={loading}
          rowKey={(a) => a._id ?? `${a.serverKey}-${a.action}-${a.createdAt ?? ''}`}
          columns={auditColumns}
          empty={{
            icon: <IconActivity size={26} stroke={1.7} />,
            title: 'No audit entries',
            description: 'Configuration changes (create, update, delete, exposure, secrets) are recorded here.',
          }}
          footerLeft={`${recentAudit.length} audit entries`}
        />
      )}
    </PageContainer>
  );
}
