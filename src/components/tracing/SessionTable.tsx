'use client';

import { Anchor, Badge, Table, Text, Tooltip } from '@mantine/core';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { formatDuration, formatRelativeTime, formatNumber, resolveStatusColor } from '@/lib/utils/tracingUtils';

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

export default function SessionTable({ sessions, onRowClick, onThreadClick, loading }: SessionTableProps) {
  if (loading) {
    return <LoadingState label="Loading sessions..." minHeight={180} />;
  }

  if (!sessions || sessions.length === 0) {
    return <EmptyState title="No sessions found" description="Tracing sessions will appear here once agents start running." minHeight={180} />;
  }

  return (
    <Table striped highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Agent</Table.Th>
          <Table.Th>Session ID</Table.Th>
          <Table.Th>Thread</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Started</Table.Th>
          <Table.Th>Duration</Table.Th>
          <Table.Th>Events</Table.Th>
          <Table.Th>Tokens</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {sessions.map((session) => (
          <Table.Tr
            key={session.sessionId}
            onClick={() => onRowClick?.(session.sessionId)}
            style={{ cursor: onRowClick ? 'pointer' : 'default' }}
          >
            <Table.Td>
              <Tooltip label={session.agentName || session.sessionId}>
                <Text size="sm" lineClamp={1}>
                  {session.agentName || '—'}
                </Text>
              </Tooltip>
            </Table.Td>
            <Table.Td>
              <Tooltip label={session.sessionId}>
                <Text
                  size="xs"
                  c="dimmed"
                  ff="monospace"
                  lineClamp={1}
                >
                  {session.sessionId.substring(0, 8)}...
                </Text>
              </Tooltip>
            </Table.Td>
            <Table.Td>
              {session.threadId ? (
                <Tooltip label={session.threadId}>
                  <Anchor
                    component="button"
                    type="button"
                    size="xs"
                    c="blue"
                    ff="monospace"
                    lineClamp={1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onThreadClick?.(session.threadId!);
                    }}
                  >
                    {session.threadId.substring(0, 8)}...
                  </Anchor>
                </Tooltip>
              ) : (
                <Text size="xs" c="dimmed">—</Text>
              )}
            </Table.Td>
            <Table.Td>
              <Badge size="xs" variant="light" radius="xl" color={resolveStatusColor(session.status)}>
                {(session.status || 'unknown').toUpperCase()}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{formatRelativeTime(session.startedAt)}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{formatDuration(session.durationMs)}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{formatNumber(session.totalEvents)}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{formatNumber(session.totalTokens)}</Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
