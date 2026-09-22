'use client';

/**
 * The sessions table.
 *
 * Cards were fine when a session was "a chat someone had", but a session now
 * carries what it cost and how long the agent worked, and those are numbers
 * you compare BETWEEN rows — which is a table, in aligned columns, not a
 * stack of cards each phrasing its own summary. Expanding a row shows the
 * detail that does not deserve a column of its own.
 *
 * Every total is computed server-side from the turns themselves
 * (`summariseConversation`), so no transcript is shipped just to draw a row.
 */

import { Fragment, useMemo, useState } from 'react';
import {
    ActionIcon,
    Badge,
    Box,
    Button,
    CopyButton,
    Group,
    Skeleton,
    Stack,
    Table,
    Text,
    TextInput,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import {
    IconCheck,
    IconChevronDown,
    IconChevronRight,
    IconCopy,
    IconExternalLink,
    IconMessageCircle,
    IconPlus,
    IconSearch,
} from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import { formatDuration, formatNumber, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { formatCost } from '../session/sessionUsage';
import classes from './SessionList.module.css';

/** A row as the summarising list route sends it — see `summariseConversation`. */
export interface SessionListItem {
    _id: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    messageCount?: number;
    turns?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    /** False when a turn reported usage but no price — the total is a lower bound. */
    costComplete?: boolean;
    activeMs?: number;
    hasContext?: boolean;
    /**
     * Only the older, unsummarised shape carries this. Kept so a cached page
     * rendered against a previous server build still counts its messages
     * instead of showing a dash.
     */
    messages?: Array<{ role: string }>;
}

export interface SessionListProps {
    sessions: SessionListItem[];
    loading?: boolean;
    onOpen: (sessionId: string) => void;
    onStart: () => void;
    starting?: boolean;
    /** Cap how many rows render — Overview shows a handful, the Sessions tab shows all. */
    limit?: number;
    /** Overview wants the bare table; the Sessions tab wants to search it. */
    searchable?: boolean;
}

function messageCountOf(session: SessionListItem): number {
    return session.messageCount ?? session.messages?.length ?? 0;
}

export default function SessionList({
    sessions,
    loading,
    onOpen,
    onStart,
    starting,
    limit,
    searchable,
}: SessionListProps) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return sessions;
        // Id included on purpose: pasting an id from a log or a trace is how
        // you get to the session that produced it.
        return sessions.filter((session) =>
            (session.title ?? '').toLowerCase().includes(needle)
            || session._id.toLowerCase().includes(needle));
    }, [sessions, query]);

    if (loading) {
        return (
            <Stack gap="xs">
                {[0, 1, 2].map((i) => <Skeleton key={i} height={44} radius="sm" />)}
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

    const rows = limit ? filtered.slice(0, limit) : filtered;

    return (
        <Stack gap="sm">
            {searchable ? (
                <Group justify="space-between">
                    <TextInput
                        size="xs"
                        placeholder="Search by name or session id"
                        leftSection={<IconSearch size={13} />}
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        w={280}
                    />
                    <Text size="xs" c="dimmed">
                        {filtered.length === sessions.length
                            ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
                            : `${filtered.length} of ${sessions.length}`}
                    </Text>
                </Group>
            ) : null}

            <Table highlightOnHover verticalSpacing={6} className={classes.table}>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th w={28} />
                        <Table.Th>Name</Table.Th>
                        <Table.Th w={190}>Session ID</Table.Th>
                        <Table.Th w={70} ta="right">Turns</Table.Th>
                        <Table.Th w={90} ta="right">Tokens</Table.Th>
                        <Table.Th w={90} ta="right">Cost</Table.Th>
                        <Table.Th w={90} ta="right">
                            <Tooltip label="Time the agent spent working, summed over turns" withArrow>
                                <span>Active</span>
                            </Tooltip>
                        </Table.Th>
                        <Table.Th w={110}>Last activity</Table.Th>
                        <Table.Th w={40} />
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {rows.map((session) => {
                        const open = expanded === session._id;
                        return (
                            <Fragment key={session._id}>
                                <Table.Tr className={classes.row}>
                                    <Table.Td>
                                        <UnstyledButton
                                            onClick={() => setExpanded(open ? null : session._id)}
                                            aria-label={open ? 'Collapse' : 'Expand'}
                                        >
                                            {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                                        </UnstyledButton>
                                    </Table.Td>
                                    <Table.Td>
                                        <UnstyledButton onClick={() => onOpen(session._id)} className={classes.nameButton}>
                                            <Text size="sm" fw={500} lineClamp={1}>
                                                {session.title || 'New session'}
                                            </Text>
                                        </UnstyledButton>
                                    </Table.Td>
                                    <Table.Td>
                                        <Group gap={4} wrap="nowrap">
                                            <Text size="xs" ff="monospace" c="dimmed" truncate>{session._id}</Text>
                                            <CopyButton value={session._id}>
                                                {({ copied, copy }) => (
                                                    <Tooltip label={copied ? 'Copied' : 'Copy id'} withArrow>
                                                        <ActionIcon size={16} variant="subtle" color="gray" onClick={copy}>
                                                            {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
                                                        </ActionIcon>
                                                    </Tooltip>
                                                )}
                                            </CopyButton>
                                        </Group>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="xs" className={classes.num}>{session.turns ?? 0}</Text>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="xs" className={classes.num}>
                                            {session.totalTokens ? formatNumber(session.totalTokens) : '—'}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="xs" className={classes.num}>
                                            {session.costUsd ? formatCost(session.costUsd) : '—'}
                                            {session.costUsd && session.costComplete === false ? (
                                                <Tooltip label="Some turns are unpriced — their model has no pricing configured" withArrow>
                                                    <Text component="span" c="dimmed"> +</Text>
                                                </Tooltip>
                                            ) : null}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="xs" className={classes.num}>
                                            {session.activeMs ? formatDuration(session.activeMs) : '—'}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Tooltip
                                            label={new Date(session.updatedAt ?? session.createdAt ?? '').toLocaleString()}
                                            withArrow
                                        >
                                            <Text size="xs" c="dimmed">
                                                {formatRelativeTime(session.updatedAt ?? session.createdAt)}
                                            </Text>
                                        </Tooltip>
                                    </Table.Td>
                                    <Table.Td>
                                        <Tooltip label="Open session" withArrow>
                                            <ActionIcon size="sm" variant="subtle" onClick={() => onOpen(session._id)}>
                                                <IconExternalLink size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Table.Td>
                                </Table.Tr>

                                {open ? (
                                    <Table.Tr>
                                        <Table.Td colSpan={9} className={classes.detailCell}>
                                            <Group gap="xl" align="flex-start" wrap="wrap">
                                                <Detail label="Messages" value={String(messageCountOf(session))} />
                                                <Detail
                                                    label="Input tokens"
                                                    value={session.inputTokens ? formatNumber(session.inputTokens) : '—'}
                                                />
                                                <Detail
                                                    label="Output tokens"
                                                    value={session.outputTokens ? formatNumber(session.outputTokens) : '—'}
                                                />
                                                <Detail
                                                    label="Average turn"
                                                    value={session.activeMs && session.turns
                                                        ? formatDuration(Math.round(session.activeMs / session.turns))
                                                        : '—'}
                                                />
                                                <Detail
                                                    label="Created"
                                                    value={session.createdAt
                                                        ? new Date(session.createdAt).toLocaleString()
                                                        : '—'}
                                                />
                                                <Detail
                                                    label="Session context"
                                                    value={session.hasContext
                                                        ? <Badge size="xs" variant="light">set</Badge>
                                                        : <Text size="xs" c="dimmed">none</Text>}
                                                />
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                ) : null}
                            </Fragment>
                        );
                    })}
                </Table.Tbody>
            </Table>
        </Stack>
    );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <Box>
            <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
            {typeof value === 'string' ? <Text size="xs">{value}</Text> : value}
        </Box>
    );
}
