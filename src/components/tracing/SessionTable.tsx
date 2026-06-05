'use client';

import { Tooltip } from '@mantine/core';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import StatusBadge from '@/components/common/ui/StatusBadge';
import {
  formatDuration,
  formatRelativeTime,
  formatNumber,
} from '@/lib/utils/tracingUtils';

interface Session {
  sessionId: string;
  threadId?: string;
  agentName?: string;
  status?: string;
  startedAt?: Date | string;
  durationMs?: number;
  totalEvents?: number;
  totalTokens?: number;
}

interface SessionTableProps {
  sessions: Session[];
  onRowClick?: (sessionId: string) => void;
  onThreadClick?: (threadId: string) => void;
  loading?: boolean;
}

function statusVariant(status?: string) {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
    case 'completed':
    case 'ok':
      return 'ok' as const;
    case 'error':
    case 'failed':
      return 'err' as const;
    case 'running':
    case 'in_progress':
      return 'info' as const;
    case 'paused':
    case 'cancelled':
      return 'paused' as const;
    default:
      return 'info' as const;
  }
}

export default function SessionTable({
  sessions,
  onRowClick,
  onThreadClick,
  loading,
}: SessionTableProps) {
  if (loading) {
    return <LoadingState label="Loading sessions..." minHeight={180} />;
  }

  if (!sessions || sessions.length === 0) {
    return (
      <EmptyState
        title="No sessions found"
        description="Tracing sessions will appear here once agents start running."
        minHeight={180}
      />
    );
  }

  return (
    <div className="ds-tbl-wrap">
      <table className="ds-tbl">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Session ID</th>
            <th>Thread</th>
            <th>Status</th>
            <th>Started</th>
            <th style={{ textAlign: 'right' }}>Duration</th>
            <th style={{ textAlign: 'right' }}>Events</th>
            <th style={{ textAlign: 'right' }}>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr
              key={session.sessionId}
              className={onRowClick ? 'clickable' : ''}
              onClick={onRowClick ? () => onRowClick(session.sessionId) : undefined}
            >
              <td>
                <Tooltip label={session.agentName || session.sessionId} withArrow>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      maxWidth: 180,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                    }}
                  >
                    {session.agentName || '—'}
                  </span>
                </Tooltip>
              </td>
              <td>
                <Tooltip label={session.sessionId} withArrow>
                  <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
                    {session.sessionId.substring(0, 8)}…
                  </span>
                </Tooltip>
              </td>
              <td>
                {session.threadId ? (
                  <Tooltip label={session.threadId} withArrow>
                    <button
                      type="button"
                      className="ds-mono"
                      style={{
                        fontSize: 12,
                        color: 'var(--ds-accent)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onThreadClick?.(session.threadId!);
                      }}
                    >
                      {session.threadId.substring(0, 8)}…
                    </button>
                  </Tooltip>
                ) : (
                  <span className="ds-faint" style={{ fontSize: 12 }}>
                    —
                  </span>
                )}
              </td>
              <td>
                <StatusBadge
                  status={statusVariant(session.status)}
                  label={(session.status || 'unknown').toUpperCase()}
                />
              </td>
              <td className="ds-faint" style={{ fontSize: 12.5 }}>
                {formatRelativeTime(session.startedAt)}
              </td>
              <td
                className="ds-mono"
                style={{
                  textAlign: 'right',
                  fontSize: 12.5,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatDuration(session.durationMs)}
              </td>
              <td
                className="ds-mono"
                style={{
                  textAlign: 'right',
                  fontSize: 12.5,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatNumber(session.totalEvents)}
              </td>
              <td
                className="ds-mono"
                style={{
                  textAlign: 'right',
                  fontSize: 12.5,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatNumber(session.totalTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
