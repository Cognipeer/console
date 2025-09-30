'use client';

import { Table, Badge, Text, Tooltip, Box } from '@mantine/core';
import { formatDuration, formatRelativeTime, formatNumber, resolveStatusColor } from '@/lib/utils/tracingUtils';

interface Session {
  sessionId: string;
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
  loading?: boolean;
}

export default function SessionTable({ sessions, onRowClick, loading }: SessionTableProps) {
  if (loading) {
    return (
      <Box p="xl" style={{ textAlign: 'center' }}>
        <Text c="dimmed">Loading sessions...</Text>
      </Box>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <Box p="xl" style={{ textAlign: 'center' }}>
        <Text c="dimmed">No sessions found.</Text>
      </Box>
    );
  }

  return (
    <Table striped highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Agent</Table.Th>
          <Table.Th>Session ID</Table.Th>
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
                  style={{ fontFamily: 'monospace' }}
                  lineClamp={1}
                >
                  {session.sessionId.substring(0, 8)}...
                </Text>
              </Tooltip>
            </Table.Td>
            <Table.Td>
              <Badge size="xs" color={resolveStatusColor(session.status)}>
                {session.status || 'unknown'}
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
