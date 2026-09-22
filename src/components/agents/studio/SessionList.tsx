'use client';

import { Badge, Button, Card, Group, Skeleton, Stack, Text } from '@mantine/core';
import { IconMessageCircle, IconPlus } from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';

/** A session row's shape as the list needs it — see `SessionSummary` in AgentDetailPage. */
export interface SessionListItem {
    _id: string;
    title?: string;
    messages: Array<{ role: string }>;
    updatedAt?: string;
    createdAt?: string;
}

function formatWhen(value: string | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.round(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString();
}

export interface SessionListProps {
    sessions: SessionListItem[];
    loading?: boolean;
    onOpen: (sessionId: string) => void;
    onStart: () => void;
    starting?: boolean;
    /** Cap how many rows render — Overview shows a handful, the Sessions tab shows all. */
    limit?: number;
}

export default function SessionList({ sessions, loading, onOpen, onStart, starting, limit }: SessionListProps) {
    if (loading) {
        return (
            <Stack gap="xs">
                {[0, 1, 2].map((i) => <Skeleton key={i} height={64} radius="md" />)}
            </Stack>
        );
    }

    if (sessions.length === 0) {
        return (
            <EmptyState
                icon={<IconMessageCircle size={28} />}
                title="No sessions yet"
                description="Start a session to try this agent — every message, tool call and answer is saved so you can come back to it."
                minHeight={200}
                action={
                    <Button size="sm" leftSection={<IconPlus size={14} />} loading={starting} onClick={onStart}>
                        Start new session
                    </Button>
                }
            />
        );
    }

    const rows = limit ? sessions.slice(0, limit) : sessions;

    return (
        <Stack gap="xs">
            {rows.map((session) => {
                const userTurns = session.messages.filter((m) => m.role === 'user').length;
                return (
                    <Card
                        key={session._id}
                        withBorder
                        padding="sm"
                        radius="md"
                        onClick={() => onOpen(session._id)}
                        style={{ cursor: 'pointer' }}
                    >
                        <Group justify="space-between" wrap="nowrap">
                            <Stack gap={2} style={{ minWidth: 0 }}>
                                <Text size="sm" fw={600} lineClamp={1}>
                                    {session.title || 'New session'}
                                </Text>
                                <Text size="xs" c="dimmed">
                                    {userTurns} message{userTurns === 1 ? '' : 's'} · {formatWhen(session.updatedAt ?? session.createdAt)}
                                </Text>
                            </Stack>
                            <Badge size="xs" variant="light" color="gray">
                                {session.messages.length}
                            </Badge>
                        </Group>
                    </Card>
                );
            })}
        </Stack>
    );
}
