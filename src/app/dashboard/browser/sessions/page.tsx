'use client';

/**
 * Every browser session in the project, across all browsers.
 *
 * The per-browser session list answers "what did THIS browser do". This one
 * answers the questions an operator actually arrives with: what ran last
 * night, which runs errored, what is still holding a Chromium open right now.
 * That is why the filters lead with a time range and a status — a session
 * list without them is only useful on a tenant that has ten sessions.
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Group, Select, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useConfirm, useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import {
  useBrowserSessions,
  useBrowsers,
  useCloseBrowserSession,
  useDeleteBrowserSession,
  useRecordBrowserFlow,
} from '@/lib/api/queries/browser';
import {
  IconArrowsSplit,
  IconCamera,
  IconHistory,
  IconPlayerPlay,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { BrowserSessionView } from '@/lib/services/browser';

/** A session that is still holding a real Chromium context open. */
const LIVE_STATUSES = new Set(['running', 'idle', 'pending']);

const RANGE_OPTIONS = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range…' },
];

const RANGE_MS: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

function statusVariant(status: string): 'active' | 'paused' | 'error' {
  if (status === 'running' || status === 'idle') return 'active';
  if (status === 'errored') return 'error';
  return 'paused';
}

function formatDate(value: unknown): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** Compact "how long did it run" — a duration is easier to scan than two timestamps. */
function formatDuration(session: BrowserSessionView): string {
  const start = session.startedAt ? new Date(session.startedAt).getTime() : undefined;
  if (!start) return '—';
  const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default function BrowserSessionsPage() {
  const deleteResource = useDeleteResource();
  const { confirmAction } = useConfirm();
  const tSafe = useTranslations('common.confirm.dataSafety');
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [browserFilter, setBrowserFilter] = useState('all');
  const [range, setRange] = useState('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customOpen, setCustomOpen] = useState(false);

  const [recordTarget, setRecordTarget] = useState<BrowserSessionView | null>(null);
  const [recordName, setRecordName] = useState('');

  /** The range as the API wants it — resolved once, used by the session query and the summary. */
  const bounds = useMemo(() => {
    if (range === 'all') return {};
    if (range === 'custom') {
      return {
        createdFrom: customFrom ? new Date(customFrom).toISOString() : undefined,
        createdTo: customTo ? new Date(customTo).toISOString() : undefined,
      };
    }
    const span = RANGE_MS[range];
    return span ? { createdFrom: new Date(Date.now() - span).toISOString() } : {};
  }, [range, customFrom, customTo]);

  const sessionsSearch = useMemo(() => {
    const params = new URLSearchParams({ limit: '500' });
    if (browserFilter !== 'all') params.set('browserId', browserFilter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (bounds.createdFrom) params.set('createdFrom', bounds.createdFrom);
    if (bounds.createdTo) params.set('createdTo', bounds.createdTo);
    return params.toString();
  }, [browserFilter, statusFilter, bounds]);

  // A failed session list is told in a notification; without the browser list the Browser column shows no names.
  const sessionsQuery = useBrowserSessions(sessionsSearch, { notifyOnError: 'Error' });
  const browsersQuery = useBrowsers();
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const browsers = useMemo(() => browsersQuery.data ?? [], [browsersQuery.data]);
  const loading = sessionsQuery.isPending || browsersQuery.isPending;
  const refreshing = sessionsQuery.isFetching || browsersQuery.isFetching;
  const closeSessionMutation = useCloseBrowserSession();
  const deleteSessionMutation = useDeleteBrowserSession();
  const recordFlow = useRecordBrowserFlow();
  const load = () => Promise.all([sessionsQuery.refetch(), browsersQuery.refetch()]);

  const browserName = useCallback(
    (id: string) => browsers.find((item) => item.id === id)?.name ?? '—',
    [browsers],
  );

  const summary = useMemo(() => {
    const live = sessions.filter((s) => LIVE_STATUSES.has(s.status)).length;
    const errored = sessions.filter((s) => s.status === 'errored').length;
    const actions = sessions.reduce((total, s) => total + (s.eventCount ?? 0), 0);
    return { total: sessions.length, live, errored, actions };
  }, [sessions]);

  // Search stays client-side: it is a narrowing pass over an already-bounded
  // result set, and round-tripping every keystroke would fight the range
  // filters above rather than help them.
  const filtered = useMemo(() => {
    if (!query) return sessions;
    const needle = query.toLowerCase();
    return sessions.filter((s) =>
      (s.name ?? '').toLowerCase().includes(needle)
      || s.sessionKey.toLowerCase().includes(needle)
      || (s.currentUrl ?? '').toLowerCase().includes(needle)
      || (s.agentKey ?? '').toLowerCase().includes(needle));
  }, [sessions, query]);

  function closeSession(session: BrowserSessionView) {
    return confirmAction({
      title: tSafe('closeSession.title'),
      message: tSafe('closeSession.message'),
      confirmLabel: tSafe('closeSession.confirm'),
      tone: 'warning',
      action: async () => {
        await closeSessionMutation.mutateAsync(session.sessionKey);
        notifications.show({ color: 'teal', title: 'Closed', message: session.sessionKey });
      },
    });
  }

  function deleteSession(session: BrowserSessionView) {
    return deleteResource({
      noun: tSafe('nouns.browserSession'),
      name: session.name || session.sessionKey,
      action: async () => {
        await deleteSessionMutation.mutateAsync(session.id);
        notifications.show({ color: 'teal', title: 'Deleted', message: session.sessionKey });
      },
    });
  }

  async function recordAsFlow() {
    if (!recordTarget) return;
    try {
      const data = await recordFlow.mutateAsync({
        sessionId: recordTarget.id,
        name: recordName.trim() || `Flow from ${recordTarget.name || recordTarget.sessionKey}`,
      });
      notifications.show({
        color: 'teal',
        title: 'Flow recorded',
        message: `${data.flow.steps.length} step(s) captured`,
      });
      setRecordTarget(null);
      setRecordName('');
      router.push(`/dashboard/browser/flows/${data.flow.id}`);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not record',
        message: errorMessage(err, 'Failed'),
      });
    }
  }

  const columns: DataGridColumn<BrowserSessionView>[] = [
    {
      key: 'session',
      label: 'Session',
      render: (s) => (
        <div className="ds-col" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {s.name || s.sessionKey}
          </span>
          <span className="ds-mono ds-faint" style={{ fontSize: 11 }}>{s.sessionKey}</span>
        </div>
      ),
    },
    {
      key: 'browser',
      label: 'Browser',
      render: (s) => (
        <span className="ds-muted" style={{ fontSize: 12 }}>{browserName(s.browserId)}</span>
      ),
    },
    {
      key: 'origin',
      label: 'Started by',
      render: (s) => {
        // Where a session came from is the first thing you want when one
        // misbehaves: an agent run, a recorded flow, or a person clicking.
        const source = (s.metadata as Record<string, unknown> | undefined)?.source;
        if (s.agentKey) return <Badge size="xs" variant="light" color="blue">agent · {s.agentKey}</Badge>;
        if (source === 'browser-flow') {
          const flowKey = (s.metadata as Record<string, unknown>)?.flowKey;
          return <Badge size="xs" variant="light" color="grape">flow · {String(flowKey ?? '')}</Badge>;
        }
        if (source === 'browser-mcp') return <Badge size="xs" variant="light" color="teal">mcp</Badge>;
        if (source === 'agent-system-tool') return <Badge size="xs" variant="light" color="blue">agent tool</Badge>;
        return <Badge size="xs" variant="light" color="gray">manual</Badge>;
      },
    },
    {
      key: 'url',
      label: 'Last URL',
      render: (s) => (
        <span className="ds-faint" style={{ fontSize: 11.5, display: 'block', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.currentUrl ?? '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (s) => <span className="ds-badge">{s.eventCount ?? 0}</span>,
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (s) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>{formatDuration(s)}</span>
      ),
    },
    {
      key: 'started',
      label: 'Started',
      render: (s) => (
        <span className="ds-faint" style={{ fontSize: 11.5 }}>{formatDate(s.startedAt ?? s.createdAt)}</span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (s) => <StatusBadge status={statusVariant(s.status)} label={s.status} />,
    },
  ];

  const rangeLabel = RANGE_OPTIONS.find((option) => option.value === range)?.label ?? '';

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Browsers"
        title="Sessions"
        subtitle="Every browser session in this project — what ran, what it touched, and what is still open."
        actions={(
          <Button
            variant="default"
            size="sm"
            leftSection={<IconPlayerPlay size={14} stroke={1.7} />}
            onClick={() => router.push('/dashboard/browser/playground')}
          >
            Open playground
          </Button>
        )}
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Sessions"
          icon={<IconHistory size={14} stroke={1.7} />}
          value={summary.total}
          delta={range === 'all' ? undefined : rangeLabel}
        />
        <StatTile label="Live now" value={summary.live} />
        <StatTile label="Errored" value={summary.errored} />
        <StatTile label="Actions" value={summary.actions} />
      </div>

      <DataGrid<BrowserSessionView>
        records={filtered}
        loading={loading}
        rowKey={(s) => s.id}
        onRowClick={(s) => router.push(`/dashboard/browser/${s.browserId}/sessions?session=${s.sessionKey}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search by name, key, URL or agent…',
        }}
        filters={[
          {
            value: browserFilter,
            onChange: setBrowserFilter,
            ariaLabel: 'Filter by browser',
            width: 190,
            options: [
              { value: 'all', label: 'All browsers' },
              ...browsers.map((b) => ({ value: b.id, label: b.name })),
            ],
          },
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by status',
            width: 150,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'running', label: 'Running' },
              { value: 'idle', label: 'Idle' },
              { value: 'pending', label: 'Pending' },
              { value: 'closed', label: 'Closed' },
              { value: 'expired', label: 'Expired' },
              { value: 'errored', label: 'Errored' },
            ],
          },
          {
            value: range,
            onChange: (value) => {
              setRange(value);
              if (value === 'custom') setCustomOpen(true);
            },
            ariaLabel: 'Filter by time range',
            width: 160,
            options: RANGE_OPTIONS,
          },
        ]}
        toolbarRight={
          range === 'custom' ? (
            <Button size="xs" variant="light" onClick={() => setCustomOpen(true)}>
              {customFrom || customTo
                ? `${customFrom || '…'} → ${customTo || 'now'}`
                : 'Set range'}
            </Button>
          ) : undefined
        }
        onRefresh={() => void load()}
        refreshing={refreshing}
        rowActions={(s) => [
          {
            icon: <IconCamera size={14} />,
            label: 'Open session',
            onClick: () => router.push(`/dashboard/browser/${s.browserId}/sessions?session=${s.sessionKey}`),
          },
          {
            icon: <IconArrowsSplit size={14} />,
            label: 'Record as flow',
            hidden: (row) => (row.eventCount ?? 0) < 2,
            onClick: (row) => setRecordTarget(row),
          },
          {
            icon: <IconX size={14} />,
            label: 'Close session',
            color: 'orange',
            hidden: (row) => !LIVE_STATUSES.has(row.status),
            onClick: (row) => closeSession(row),
          },
          {
            icon: <IconTrash size={14} />,
            label: 'Delete',
            color: 'red',
            onClick: (row) => deleteSession(row),
          },
        ]}
        empty={{
          icon: <IconHistory size={26} stroke={1.7} />,
          title: 'No sessions in this range',
          description:
            'Widen the time range, or open the playground to drive a browser and create one.',
          primaryAction: {
            label: 'Open playground',
            icon: <IconPlayerPlay size={14} stroke={1.7} />,
            onClick: () => router.push('/dashboard/browser/playground'),
          },
        }}
      />

      <FormShell
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title="Custom time range"
        subtitle="Filters on when the session was created."
        primaryAction={{
          label: 'Apply',
          color: 'teal',
          onClick: () => {
            setCustomOpen(false);
            void load();
          },
        }}
        secondaryAction={{
          label: 'Clear',
          onClick: () => {
            setCustomFrom('');
            setCustomTo('');
            setRange('7d');
            setCustomOpen(false);
          },
        }}
      >
        <FormSection title="Range">
          <FormRow cols={2}>
            <FormField label="From" optional>
              <input
                type="datetime-local"
                className="ds-input"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.currentTarget.value)}
              />
            </FormField>
            <FormField label="To" optional hint="Leave empty for “until now”.">
              <input
                type="datetime-local"
                className="ds-input"
                value={customTo}
                onChange={(event) => setCustomTo(event.currentTarget.value)}
              />
            </FormField>
          </FormRow>
        </FormSection>
      </FormShell>

      <FormShell
        open={Boolean(recordTarget)}
        onClose={() => setRecordTarget(null)}
        title="Record session as a flow"
        subtitle="The session's actions become ordered steps. Typed values become flow inputs, never literals."
        icon={<IconArrowsSplit size={18} stroke={1.7} />}
        primaryAction={{
          label: 'Record flow',
          color: 'teal',
          loading: recordFlow.isPending,
          onClick: recordAsFlow,
        }}
        secondaryAction={{ label: 'Cancel', onClick: () => setRecordTarget(null) }}
      >
        <FormSection title="Flow">
          <FormRow cols={1}>
            <FormField label="Name" hint={`${recordTarget?.eventCount ?? 0} action(s) will be considered.`}>
              <input
                className="ds-input"
                placeholder={`Flow from ${recordTarget?.name || recordTarget?.sessionKey || 'session'}`}
                value={recordName}
                onChange={(event) => setRecordName(event.currentTarget.value)}
              />
            </FormField>
          </FormRow>
          <Text size="xs" c="dimmed">
            Element references are replaced with durable ones (role + name, test ids), so the
            recorded steps keep working after the page changes.
          </Text>
        </FormSection>
      </FormShell>
    </PageContainer>
  );
}
