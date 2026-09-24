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
    Select,
    Skeleton,
    Stack,
    Table,
    Text,
    TextInput,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import {
    IconArrowDown,
    IconArrowUp,
    IconCheck,
    IconChevronDown,
    IconChevronRight,
    IconCopy,
    IconExternalLink,
    IconMessageCircle,
    IconPlayerPlay,
    IconPlus,
    IconSearch,
    IconX,
} from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import { formatDuration, formatNumber, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { formatCost } from '../session/sessionUsage';
import classes from './SessionList.module.css';


type WindowFilter = 'all' | '24h' | '7d' | '30d';
type ActivityFilter = 'all' | 'used' | 'empty' | 'unpriced';
type SortColumn = 'title' | 'turns' | 'totalTokens' | 'costUsd' | 'activeMs' | 'updatedAt';
interface SortState {
    column: SortColumn;
    direction: 'asc' | 'desc';
}

const WINDOW_MS: Record<Exclude<WindowFilter, 'all'>, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
};

function windowCutoff(filter: WindowFilter): number | undefined {
    return filter === 'all' ? undefined : Date.now() - WINDOW_MS[filter];
}

function filtersApplied(query: string, filter: WindowFilter, activity: ActivityFilter): boolean {
    return Boolean(query.trim()) || filter !== 'all' || activity !== 'all';
}

function sortSessions(sessions: SessionListItem[], sort: SortState): SessionListItem[] {
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...sessions].sort((a, b) => {
        if (sort.column === 'title') {
            return factor * (a.title ?? 'New session').localeCompare(b.title ?? 'New session');
        }
        if (sort.column === 'updatedAt') {
            const left = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
            const right = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
            return factor * (left - right);
        }
        return factor * ((a[sort.column] ?? 0) - (b[sort.column] ?? 0));
    });
}

function SortHeader({
    column,
    sort,
    onSort,
    align,
    children,
}: {
    column: SortColumn;
    sort: SortState;
    onSort: (column: SortColumn) => void;
    align?: 'right';
    children: React.ReactNode;
}) {
    const active = sort.column === column;
    return (
        <UnstyledButton onClick={() => onSort(column)} className={classes.sortHeader}>
            <Group gap={2} wrap="nowrap" justify={align === 'right' ? 'flex-end' : 'flex-start'}>
                <Text size="xs" fw={600} c={active ? undefined : 'dimmed'}>{children}</Text>
                {active ? (
                    sort.direction === 'asc'
                        ? <IconArrowUp size={11} />
                        : <IconArrowDown size={11} />
                ) : null}
            </Group>
        </UnstyledButton>
    );
}

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
    /** Where the session came from (`metadata.source`) — see AgentConversationSource. */
    source?: string;
    hasContext?: boolean;
    /**
     * Only the older, unsummarised shape carries this. Kept so a cached page
     * rendered against a previous server build still counts its messages
     * instead of showing a dash.
     */
    messages?: Array<{ role: string }>;
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
    console: { label: 'Test', color: 'teal' },
    api: { label: 'API', color: 'gray' },
    a2a: { label: 'A2A', color: 'violet' },
    schedule: { label: 'Schedule', color: 'orange' },
    evaluation: { label: 'Evaluation', color: 'blue' },
    redteam: { label: 'Red team', color: 'red' },
};

export function sessionSourceLabel(source: string | undefined): string {
    return source ? SOURCE_LABELS[source]?.label ?? source : 'unknown source';
}

/**
 * Only a console session can be continued from the UI — the rest are real
 * traffic. Sessions recorded before sources existed have none; they keep the
 * old behaviour (continuable) rather than suddenly locking.
 */
export function isContinuableSession(source: string | undefined): boolean {
    return source === undefined || source === 'console';
}

export function SessionSourceBadge({ source }: { source: string | undefined }) {
    if (!source) return null;
    const meta = SOURCE_LABELS[source] ?? { label: source, color: 'gray' };
    return <Badge size="xs" variant="light" color={meta.color}>{meta.label}</Badge>;
}

export interface SessionListProps {
    sessions: SessionListItem[];
    loading?: boolean;
    /** Row click — shows the session (read-only). */
    onOpen: (sessionId: string) => void;
    /** Resume a console session in the chat view. */
    onContinue?: (sessionId: string) => void;
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
    onContinue,
    onStart,
    starting,
    limit,
    searchable,
}: SessionListProps) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    // Not named `window`: that shadows the global inside this component,
    // which is a trap waiting for the first line that needs the real one.
    const [timeWindow, setTimeWindow] = useState<WindowFilter>('all');
    const [activity, setActivity] = useState<ActivityFilter>('all');
    const [sort, setSort] = useState<SortState>({ column: 'updatedAt', direction: 'desc' });

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const cutoff = windowCutoff(timeWindow);

        const matching = sessions.filter((session) => {
            if (needle) {
                // Id included on purpose: pasting an id from a log or a trace
                // is how you get to the session that produced it.
                const hit = (session.title ?? '').toLowerCase().includes(needle)
                    || session._id.toLowerCase().includes(needle);
                if (!hit) return false;
            }
            if (cutoff !== undefined) {
                const when = Date.parse(session.updatedAt ?? session.createdAt ?? '');
                // A row with no timestamp cannot be shown to be inside a
                // window, so a time filter excludes it rather than quietly
                // treating "unknown" as "recent".
                if (!Number.isFinite(when) || when < cutoff) return false;
            }
            if (activity === 'used' && (session.turns ?? 0) === 0) return false;
            if (activity === 'empty' && (session.turns ?? 0) > 0) return false;
            if (activity === 'unpriced' && session.costComplete !== false) return false;
            return true;
        });

        return sortSessions(matching, sort);
    }, [sessions, query, timeWindow, activity, sort]);

    const toggleSort = (column: SortColumn) => {
        setSort((current) => current.column === column
            ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
            // A newly-picked numeric column starts on its interesting end —
            // nobody opens a cost column to find the cheapest session.
            : { column, direction: 'desc' });
    };

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
                <Group justify="space-between" gap="xs" wrap="wrap">
                    <Group gap="xs" wrap="wrap">
                        <TextInput
                            size="xs"
                            placeholder="Search by name or session id"
                            leftSection={<IconSearch size={13} />}
                            value={query}
                            onChange={(event) => setQuery(event.currentTarget.value)}
                            w={260}
                        />
                        <Select
                            size="xs"
                            w={140}
                            data={[
                                { value: 'all', label: 'Any time' },
                                { value: '24h', label: 'Last 24 hours' },
                                { value: '7d', label: 'Last 7 days' },
                                { value: '30d', label: 'Last 30 days' },
                            ]}
                            value={timeWindow}
                            onChange={(next) => setTimeWindow((next as WindowFilter) ?? 'all')}
                            allowDeselect={false}
                            aria-label="Filter by last activity"
                        />
                        <Select
                            size="xs"
                            w={170}
                            data={[
                                { value: 'all', label: 'All sessions' },
                                { value: 'used', label: 'Has turns' },
                                // Started and abandoned: these are the rows
                                // that make a session count look busier than
                                // the agent actually was.
                                { value: 'empty', label: 'Never used' },
                                { value: 'unpriced', label: 'Unpriced turns' },
                            ]}
                            value={activity}
                            onChange={(next) => setActivity((next as ActivityFilter) ?? 'all')}
                            allowDeselect={false}
                            aria-label="Filter by activity"
                        />
                        {filtersApplied(query, timeWindow, activity) ? (
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                color="gray"
                                leftSection={<IconX size={12} />}
                                onClick={() => { setQuery(''); setTimeWindow('all'); setActivity('all'); }}
                            >
                                Clear
                            </Button>
                        ) : null}
                    </Group>
                    <Text size="xs" c="dimmed">
                        {filtered.length === sessions.length
                            ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
                            : `${filtered.length} of ${sessions.length}`}
                    </Text>
                </Group>
            ) : null}

            {filtered.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center" py="xl">
                    No session matches these filters.
                </Text>
            ) : (
            <Table highlightOnHover verticalSpacing={6} className={classes.table}>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th w={28} />
                        <Table.Th>
                            <SortHeader column="title" sort={sort} onSort={toggleSort}>Name</SortHeader>
                        </Table.Th>
                        <Table.Th w={100}>Source</Table.Th>
                        <Table.Th w={190}>Session ID</Table.Th>
                        <Table.Th w={70} ta="right">
                            <SortHeader column="turns" sort={sort} onSort={toggleSort} align="right">Turns</SortHeader>
                        </Table.Th>
                        <Table.Th w={90} ta="right">
                            <SortHeader column="totalTokens" sort={sort} onSort={toggleSort} align="right">Tokens</SortHeader>
                        </Table.Th>
                        <Table.Th w={90} ta="right">
                            <SortHeader column="costUsd" sort={sort} onSort={toggleSort} align="right">Cost</SortHeader>
                        </Table.Th>
                        <Table.Th w={90} ta="right">
                            <Tooltip label="Time the agent spent working, summed over turns" withArrow>
                                <span>
                                    <SortHeader column="activeMs" sort={sort} onSort={toggleSort} align="right">Active</SortHeader>
                                </span>
                            </Tooltip>
                        </Table.Th>
                        <Table.Th w={110}>
                            <SortHeader column="updatedAt" sort={sort} onSort={toggleSort}>Last activity</SortHeader>
                        </Table.Th>
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
                                        <SessionSourceBadge source={session.source} />
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
                                        {onContinue && isContinuableSession(session.source) ? (
                                            <Tooltip label="Continue session" withArrow>
                                                <ActionIcon size="sm" variant="subtle" onClick={() => onContinue(session._id)}>
                                                    <IconPlayerPlay size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        ) : (
                                            <Tooltip label="View session" withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => onOpen(session._id)}>
                                                    <IconExternalLink size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        )}
                                    </Table.Td>
                                </Table.Tr>

                                {open ? (
                                    <Table.Tr>
                                        <Table.Td colSpan={10} className={classes.detailCell}>
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
            )}
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
