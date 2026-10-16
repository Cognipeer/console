'use client';

import type { CSSProperties } from 'react';
import { Tooltip } from '@mantine/core';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { useTranslations } from '@/lib/i18n';
import SessionStatusBadge from './SessionStatusBadge';
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

const NUM_CELL: CSSProperties = { textAlign: 'right', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' };

export default function SessionTable({
  sessions,
  onRowClick,
  onThreadClick,
  loading,
}: SessionTableProps) {
  const t = useTranslations('tracingHealth');
  if (loading) {
    return <LoadingState label={t('sessionTable.loading')} minHeight={180} />;
  }

  if (!sessions || sessions.length === 0) {
    return (
      <EmptyState
        title={t('sessionTable.emptyTitle')}
        description={t('sessionTable.emptyDescription')}
        minHeight={180}
      />
    );
  }

  return (
    <div className="ds-tbl-wrap">
      <table className="ds-tbl">
        <thead>
          <tr>
            <th>{t('sessionTable.agent')}</th>
            <th>{t('sessionTable.sessionId')}</th>
            <th>{t('sessionTable.thread')}</th>
            <th>{t('sessionTable.status')}</th>
            <th>{t('sessionTable.started')}</th>
            <th style={{ textAlign: 'right' }}>{t('sessionTable.duration')}</th>
            <th style={{ textAlign: 'right' }}>{t('sessionTable.events')}</th>
            <th style={{ textAlign: 'right' }}>{t('sessionTable.tokens')}</th>
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
                <SessionStatusBadge status={session.status} />
              </td>
              <td className="ds-faint" style={{ fontSize: 12.5 }}>
                {formatRelativeTime(session.startedAt)}
              </td>
              <td className="ds-mono" style={NUM_CELL}>
                {formatDuration(session.durationMs)}
              </td>
              <td className="ds-mono" style={NUM_CELL}>
                {formatNumber(session.totalEvents)}
              </td>
              <td className="ds-mono" style={NUM_CELL}>
                {formatNumber(session.totalTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
