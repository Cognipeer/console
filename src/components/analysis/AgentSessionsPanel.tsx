'use client';

/**
 * Agent sessions tab of the Conversations section. Lists the platform's own
 * agent sessions in place (nothing is copied) for one agent-session definition,
 * shows each session's latest analysis, and lets the user analyze a selection.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconClipboardText, IconPlayerPlay, IconPlus } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { decisionBadgeClass, formatAnswer, pct } from './decisionUi';
import type { AgentSessionRowView, AnalysisDefinitionView } from './types';

const PAGE_LIMIT = 50;
const MAX_CHIPS = 3;

const WINDOW_OPTIONS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

type SessionStatus = 'not_analyzed' | 'analyzed' | 'changed' | 'needs_review' | 'reviewed';

const STATUS_LABEL: Record<SessionStatus, string> = {
  not_analyzed: 'Not analyzed',
  analyzed: 'Analyzed',
  changed: 'Changed',
  needs_review: 'Needs review',
  reviewed: 'Reviewed',
};

const STATUS_BADGE: Record<SessionStatus, string> = {
  not_analyzed: 'ds-badge',
  analyzed: 'ds-badge-teal',
  changed: 'ds-badge-info',
  needs_review: 'ds-badge-warn',
  reviewed: 'ds-badge-ok',
};

function sessionStatus(row: AgentSessionRowView): SessionStatus {
  const result = row.result;
  if (!result) return 'not_analyzed';
  if (result.stale) return 'changed';
  if (result.needsReview) return 'needs_review';
  if (result.reviewed) return 'reviewed';
  return 'analyzed';
}

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

interface AgentSessionsPanelProps {
  definitions: AnalysisDefinitionView[];
  /** Opens the New definition screen (empty state). */
  onNewDefinition: () => void;
}

export default function AgentSessionsPanel({ definitions, onNewDefinition }: AgentSessionsPanelProps) {
  const router = useRouter();
  const sessionDefinitions = useMemo(
    () => definitions.filter((d) => d.source?.kind === 'agent_sessions'),
    [definitions],
  );

  const [definitionKey, setDefinitionKey] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [days, setDays] = useState('7');
  const [rows, setRows] = useState<AgentSessionRowView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Keep a valid definition selected as the list loads or changes.
  useEffect(() => {
    if (sessionDefinitions.length === 0) {
      if (definitionKey) setDefinitionKey('');
      return;
    }
    if (!sessionDefinitions.some((d) => d.key === definitionKey)) {
      const first = sessionDefinitions[0];
      setDefinitionKey(first.key);
      setAgentKey('');
      setDays(String(first.source?.kind === 'agent_sessions' ? first.source.days ?? 7 : 7));
    }
  }, [sessionDefinitions, definitionKey]);

  const definition = sessionDefinitions.find((d) => d.key === definitionKey) ?? null;
  const definitionAgents = definition?.source?.kind === 'agent_sessions' ? definition.source.agentKeys : [];

  const query = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({ definitionKey, days, limit: String(PAGE_LIMIT) });
      if (agentKey) params.set('agentKey', agentKey);
      if (cursor) params.set('cursor', cursor);
      return fetch(`/api/analysis/sources/agent-sessions?${params.toString()}`, { cache: 'no-store' });
    },
    [definitionKey, agentKey, days],
  );

  const loadFirstPage = useCallback(async () => {
    if (!definitionKey) {
      setRows([]);
      setNextCursor(undefined);
      return;
    }
    setLoading(true);
    try {
      const res = await query();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notifications.show({ title: 'Failed to load sessions', message: data.error || 'Failed to load sessions', color: 'red' });
        setRows([]);
        setNextCursor(undefined);
        return;
      }
      setRows(data.rows ?? []);
      setNextCursor(data.nextCursor || undefined);
      setSelected(new Set());
    } catch (err) {
      console.error('Failed to load agent sessions', err);
    } finally {
      setLoading(false);
    }
  }, [definitionKey, query]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await query(nextCursor);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notifications.show({ title: 'Failed to load sessions', message: data.error || 'Failed to load sessions', color: 'red' });
        return;
      }
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...((data.rows ?? []) as AgentSessionRowView[]).filter((r) => !seen.has(r.id))];
      });
      setNextCursor(data.nextCursor || undefined);
    } finally {
      setLoadingMore(false);
    }
  };

  const analyzeSelected = async (ids: string[]) => {
    if (!definitionKey || ids.length === 0) return;
    const res = await fetch(`/api/analysis/definitions/${encodeURIComponent(definitionKey)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'agent_sessions' },
        selection: { strategy: 'keys', conversationKeys: ids },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notifications.show({ title: 'Run failed', message: data.error || 'Run failed', color: 'red' });
      return;
    }
    const runId = data.run?.id as string | undefined;
    notifications.show({
      title: 'Run started',
      message: runId ? (
        <span>
          Analyzing {ids.length} session(s).{' '}
          <Link href={`/dashboard/analysis/runs/${runId}`} style={{ color: 'inherit', textDecoration: 'underline' }}>View run</Link>
        </span>
      ) : `Analyzing ${ids.length} session(s) in the background.`,
      color: 'teal',
    });
    setSelected(new Set());
  };

  const columns: DataGridColumn<AgentSessionRowView>[] = [
    { key: 'title', label: 'Conversation', render: (r) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{r.title || 'Untitled session'}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{r.id}</span>
      </div>
    ) },
    { key: 'agent', label: 'Agent', render: (r) => <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>{r.agentKey}</span> },
    { key: 'messages', label: 'Messages', render: (r) => <span>{r.messageCount}</span> },
    { key: 'decisions', label: 'Decisions', render: (r) => {
      const entries = Object.entries(r.result?.decisions ?? {});
      if (entries.length === 0) return <span className="ds-faint">—</span>;
      return (
        <Group gap={4}>
          {entries.slice(0, MAX_CHIPS).map(([key, d]) => (
            <span key={key} className={decisionBadgeClass(d)}>{key}: {formatAnswer(d)} · {pct(d.confidence)}</span>
          ))}
          {entries.length > MAX_CHIPS ? <span className="ds-badge">+{entries.length - MAX_CHIPS}</span> : null}
        </Group>
      );
    } },
    { key: 'status', label: 'Status', render: (r) => {
      const status = sessionStatus(r);
      return <span className={`ds-badge ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>;
    } },
    { key: 'updated', label: 'Updated', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.updatedAt)}</span> },
  ];

  if (sessionDefinitions.length === 0) {
    return (
      <div className="ds-card">
        <div className="ds-empty" style={{ padding: '40px 20px', textAlign: 'center' }}>
          <IconClipboardText size={26} stroke={1.7} color="var(--ds-text-muted)" />
          <div style={{ fontWeight: 500, color: 'var(--ds-text)', marginTop: 8 }}>No agent-session definitions</div>
          <div className="ds-muted" style={{ fontSize: 13, margin: '4px 0 14px' }}>
            No definition analyzes agent sessions yet. Create one with Agent sessions as its source.
          </div>
          <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={onNewDefinition}>
            New definition
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DataGrid<AgentSessionRowView>
      records={rows}
      loading={loading}
      rowKey={(r) => r.id}
      columns={columns}
      onRefresh={() => void loadFirstPage()}
      refreshing={loading}
      selectable
      selected={selected}
      onSelectionChange={setSelected}
      bulkActions={[
        {
          label: 'Analyze selected',
          icon: <IconPlayerPlay size={14} />,
          color: 'teal',
          onClick: (picked) => void analyzeSelected(picked.map((r) => r.id)),
        },
      ]}
      filters={[
        {
          value: definitionKey,
          ariaLabel: 'Definition',
          width: 200,
          options: sessionDefinitions.map((d) => ({ value: d.key, label: d.name })),
          onChange: (v) => {
            const next = sessionDefinitions.find((d) => d.key === v);
            setDefinitionKey(v);
            setAgentKey('');
            if (next?.source?.kind === 'agent_sessions' && next.source.days) setDays(String(next.source.days));
          },
        },
        {
          value: agentKey,
          ariaLabel: 'Agent',
          options: [{ value: '', label: 'All agents' }, ...definitionAgents.map((k) => ({ value: k, label: k }))],
          onChange: setAgentKey,
        },
        {
          value: days,
          ariaLabel: 'Window',
          options: WINDOW_OPTIONS.some((o) => o.value === days)
            ? WINDOW_OPTIONS
            : [...WINDOW_OPTIONS, { value: days, label: `Last ${days} days` }],
          onChange: setDays,
        },
      ]}
      onRowClick={(r) => {
        if (r.result) router.push(`/dashboard/analysis/results/${r.result.id}`);
      }}
      footerLeft={`${rows.length} session${rows.length === 1 ? '' : 's'}${nextCursor ? ' loaded' : ''}`}
      footerRight={nextCursor ? (
        <Button variant="default" size="xs" loading={loadingMore} onClick={() => void loadMore()}>
          Load more
        </Button>
      ) : undefined}
      empty={{
        icon: <IconClipboardText size={26} stroke={1.7} />,
        title: 'No sessions in this window',
        description: 'Sessions that are still active, too short, or from evaluations are left out.',
      }}
    />
  );
}
