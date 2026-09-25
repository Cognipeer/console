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

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
    ActionIcon,
    Badge,
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
import { DatePickerInput } from '@mantine/dates';
import {
    IconAlertTriangle,
    IconArrowDown,
    IconArrowUp,
    IconCheck,
    IconCalendar,
    IconCopy,
    IconExternalLink,
    IconHandStop,
    IconMessageCircle,
    IconPlayerPlay,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconTimeline,
    IconX,
} from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import { formatDuration, formatNumber, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { formatCost } from '../session/sessionUsage';
import classes from './SessionList.module.css';


type WindowFilter = 'all' | '24h' | '7d' | '30d' | 'custom';
type ActivityFilter = 'all' | 'used' | 'empty' | 'unpriced';
type StatusFilter = 'all' | 'success' | 'error' | 'stopped';
type DateRange = [Date | null, Date | null];
type SortColumn = 'title' | 'turns' | 'totalTokens' | 'costUsd' | 'activeMs' | 'updatedAt';
interface SortState {
    column: SortColumn;
    direction: 'asc' | 'desc';
}

const WINDOW_MS: Record<Exclude<WindowFilter, 'all' | 'custom'>, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
};

/** The [from, to] bounds (ms) a time filter allows; `undefined` = open. */
function windowBounds(filter: WindowFilter, range: DateRange): [number | undefined, number | undefined] {
    if (filter === 'all') return [undefined, undefined];
    if (filter === 'custom') {
        const [from, to] = range;
        // The picker's `to` is a calendar day — include all of it.
        const end = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).getTime() : undefined;
        return [from ? from.getTime() : undefined, end];
    }
    return [Date.now() - WINDOW_MS[filter], undefined];
}

interface Filters {
    query: string;
    timeWindow: WindowFilter;
    activity: ActivityFilter;
    status: StatusFilter;
    source: string;
}

function filtersApplied(f: Filters): boolean {
    return Boolean(f.query.trim()) || f.timeWindow !== 'all' || f.activity !== 'all'
        || f.status !== 'all' || f.source !== 'all';
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
    /** Tool calls that failed across all turns. */
    failedCalls?: number;
    /**
     * Server verdict (see `summariseConversation`): `error` — a failed tool
     * call or output; `stopped` — cut short by a limit, cancel or pause.
     */
    status?: 'success' | 'error' | 'stopped' | 'empty';
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
    api: { label: 'API', color: 'indigo' },
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
    /** Reload the list (Sessions tab). */
    onRefresh?: () => void;
    refreshing?: boolean;
    /** The same runs as traces — span-level detail lives in Tracing. */
    tracesHref?: string;
}

export function messageCountOf(session: SessionListItem): number {
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
    onRefresh,
    refreshing,
    tracesHref,
}: SessionListProps) {
    const [query, setQuery] = useState('');
    // Not named `window`: that shadows the global inside this component,
    // which is a trap waiting for the first line that needs the real one.
    const [timeWindow, setTimeWindow] = useState<WindowFilter>('all');
    const [activity, setActivity] = useState<ActivityFilter>('all');
    const [status, setStatus] = useState<StatusFilter>('all');
    const [source, setSource] = useState<string>('all');
    const [range, setRange] = useState<DateRange>([null, null]);
    const [sort, setSort] = useState<SortState>({ column: 'updatedAt', direction: 'desc' });

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const [from, to] = windowBounds(timeWindow, range);

        const matching = sessions.filter((session) => {
            if (needle) {
                // Id included on purpose: pasting an id from a log or a trace
                // is how you get to the session that produced it.
                const hit = (session.title ?? '').toLowerCase().includes(needle)
                    || session._id.toLowerCase().includes(needle);
                if (!hit) return false;
            }
            if (from !== undefined || to !== undefined) {
                const when = Date.parse(session.updatedAt ?? session.createdAt ?? '');
                // A row with no timestamp cannot be shown to be inside a
                // window, so a time filter excludes it rather than quietly
                // treating "unknown" as "recent".
                if (!Number.isFinite(when)) return false;
                if (from !== undefined && when < from) return false;
                if (to !== undefined && when > to) return false;
            }
            if (status !== 'all' && session.status !== status) return false;
            if (source !== 'all' && (session.source ?? 'unknown') !== source) return false;
            if (activity === 'used' && (session.turns ?? 0) === 0) return false;
            if (activity === 'empty' && (session.turns ?? 0) > 0) return false;
            if (activity === 'unpriced' && session.costComplete !== false) return false;
            return true;
        });

        return sortSessions(matching, sort);
    }, [sessions, query, timeWindow, range, activity, status, source, sort]);

    // Only the sources that actually occur — a filter offering "Red team" on
    // an agent nobody red-teamed is a filter that always returns nothing.
    const sourceOptions = useMemo(() => {
        const seen = [...new Set(sessions.map((session) => session.source ?? 'unknown'))];
        return [
            { value: 'all', label: 'All sources' },
            ...seen.map((value) => ({ value, label: value === 'unknown' ? 'Unknown' : sessionSourceLabel(value) })),
        ];
    }, [sessions]);

    const current: Filters = { query, timeWindow, activity, status, source };
    const clearFilters = () => {
        setQuery(''); setTimeWindow('all'); setRange([null, null]); setActivity('all'); setStatus('all'); setSource('all');
    };

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
                                { value: 'custom', label: 'Custom range…' },
                            ]}
                            value={timeWindow}
                            onChange={(next) => setTimeWindow((next as WindowFilter) ?? 'all')}
                            allowDeselect={false}
                            aria-label="Filter by last activity"
                        />
                        {timeWindow === 'custom' ? (
                            <DatePickerInput
                                type="range"
                                size="xs"
                                w={220}
                                placeholder="Pick dates"
                                value={range}
                                onChange={(value) => setRange(value as DateRange)}
                                leftSection={<IconCalendar size={13} />}
                                clearable
                                aria-label="Last activity between"
                            />
                        ) : null}
                        <Select
                            size="xs"
                            w={150}
                            data={[
                                { value: 'all', label: 'Any status' },
                                { value: 'success', label: 'Completed' },
                                { value: 'error', label: 'Has errors' },
                                { value: 'stopped', label: 'Stopped early' },
                            ]}
                            value={status}
                            onChange={(next) => setStatus((next as StatusFilter) ?? 'all')}
                            allowDeselect={false}
                            aria-label="Filter by status"
                        />
                        {sourceOptions.length > 2 ? (
                            <Select
                                size="xs"
                                w={140}
                                data={sourceOptions}
                                value={source}
                                onChange={(next) => setSource(next ?? 'all')}
                                allowDeselect={false}
                                aria-label="Filter by source"
                            />
                        ) : null}
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
                        {filtersApplied(current) ? (
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                color="gray"
                                leftSection={<IconX size={12} />}
                                onClick={clearFilters}
                            >
                                Clear
                            </Button>
                        ) : null}
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                        <Text size="xs" c="dimmed">
                            {filtered.length === sessions.length
                                ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
                                : `${filtered.length} of ${sessions.length}`}
                        </Text>
                        {tracesHref ? (
                            <Button
                                component={Link}
                                href={tracesHref}
                                size="compact-xs"
                                variant="subtle"
                                color="gray"
                                leftSection={<IconTimeline size={12} />}
                            >
                                Traces
                            </Button>
                        ) : null}
                        {onRefresh ? (
                            <Tooltip label="Refresh" withArrow>
                                <ActionIcon size="sm" variant="subtle" color="gray" loading={refreshing} onClick={onRefresh} aria-label="Refresh sessions">
                                    <IconRefresh size={14} />
                                </ActionIcon>
                            </Tooltip>
                        ) : null}
                    </Group>
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
                        <Table.Th>
                            <SortHeader column="title" sort={sort} onSort={toggleSort}>Name</SortHeader>
                        </Table.Th>
                        <Table.Th w={100}>Source</Table.Th>
                        <Table.Th w={130}>Session ID</Table.Th>
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
                    {rows.map((session) => (
                                <Table.Tr key={session._id} className={classes.row}>
                                    <Table.Td>
                                        <Group gap={6} wrap="nowrap">
                                            <UnstyledButton onClick={() => onOpen(session._id)} className={classes.nameButton}>
                                                <Text size="sm" fw={500} lineClamp={1}>
                                                    {session.title || 'New session'}
                                                </Text>
                                            </UnstyledButton>
                                            {session.status === 'error' ? (
                                                <Tooltip
                                                    label={session.failedCalls
                                                        ? `${session.failedCalls} failed tool call${session.failedCalls === 1 ? '' : 's'}`
                                                        : 'An output failed validation'}
                                                    withArrow
                                                >
                                                    <IconAlertTriangle size={14} color="var(--ds-err)" aria-label="Has errors" />
                                                </Tooltip>
                                            ) : session.status === 'stopped' ? (
                                                <Tooltip label="A turn stopped early (limit, cancel or pause)" withArrow>
                                                    <IconHandStop size={14} color="var(--ds-warn)" aria-label="Stopped early" />
                                                </Tooltip>
                                            ) : null}
                                        </Group>
                                    </Table.Td>
                                    <Table.Td>
                                        <SessionSourceBadge source={session.source} />
                                    </Table.Td>
                                    <Table.Td>
                                        <Group gap={4} wrap="nowrap">
                                            <Tooltip label={session._id} withArrow>
                                                <Text size="xs" ff="monospace" c="dimmed">{session._id.slice(0, 8)}…</Text>
                                            </Tooltip>
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
                    ))}
                </Table.Tbody>
            </Table>
            )}
        </Stack>
    );
}

