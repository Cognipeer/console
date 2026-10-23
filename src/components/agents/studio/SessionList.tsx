'use client';

/**
 * The sessions table.
 *
 * Cards were fine when a session was "a chat someone had", but a session now
 * carries what it cost and how long the agent worked, and those are numbers
 * you compare BETWEEN rows — which is a table, in aligned columns, not a
 * stack of cards each phrasing its own summary. Clicking a row opens it in
 * the session drawer (SessionDetailDrawer), which holds the detail that does
 * not deserve a column of its own.
 *
 * Every total is computed server-side from the turns themselves
 * (`summariseConversation`), so no transcript is shipped just to draw a row.
 */

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
    ActionIcon,
    Alert,
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
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconArrowDown,
    IconArrowUp,
    IconCheck,
    IconCalendar,
    IconClock,
    IconCopy,
    IconExternalLink,
    IconCoin,
    IconHandStop,
    IconInfoCircle,
    IconMessageCircle,
    IconPlayerPlay,
    IconPlayerStop,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconTimeline,
    IconX,
} from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import { formatDuration, formatNumber, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { formatCost } from '../session/sessionUsage';
import type { AnswerBlockedReason } from '../session/pendingActions';
import { waitingFor } from '../session/sessionActivityUi';
import type { SessionOwnerView } from '../session/sessionTypes';
import { reminderRowHint } from './reminderUi';
import classes from './SessionList.module.css';


type WindowFilter = 'all' | '24h' | '7d' | '30d' | 'custom';
type ActivityFilter = 'all' | 'used' | 'empty' | 'unpriced';
type StatusFilter = 'all' | 'success' | 'error' | 'stopped' | 'waiting' | 'waiting_elsewhere';
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
    /** Set by the project-wide list, where rows of different agents sit together. */
    agentId?: string;
    agentKey?: string;
    agentName?: string;
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
    /** `requires_action`: the agent is waiting for an approval or an answer; `budget_paused`: it stopped on the session's spend budget. */
    runtimeStatus?: 'idle' | 'running' | 'requires_action' | 'budget_paused';
    hasContext?: boolean;
    /** Who started it: the id, and the person's name or the kind of traffic that did (a trigger, a public A2A call...). */
    createdBy?: string;
    owner?: SessionOwnerView;
    /** The viewer started it. */
    ownSession?: boolean;
    /**
     * A waiting session: could THIS viewer answer what it waits on? The server's verdict (the policy engine's own
     * rule); absent when the session waits on nobody or the server did not say.
     */
    canResolve?: boolean;
    resolveBlockedReason?: AnswerBlockedReason;
    /** The newest run that is waiting for its time, queued or running on this session. */
    activeRun?: {
        id: string;
        status: 'scheduled' | 'queued' | 'running' | 'requires_action';
        /** Epoch seconds. */
        scheduledFor?: number;
        cancelRequested?: boolean;
    };
    /** Present only while the session holds scheduled reminders. */
    reminders?: { active: number; nextAt: string };
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
    console: { label: 'Test', color: 'teal' },
    api: { label: 'API', color: 'indigo' },
    a2a: { label: 'A2A', color: 'violet' },
    trigger: { label: 'Trigger', color: 'orange' },
    // Sessions of the agent schedules that triggers replaced.
    schedule: { label: 'Schedule', color: 'orange' },
    evaluation: { label: 'Evaluation', color: 'blue' },
    redteam: { label: 'Red team', color: 'red' },
    portal: { label: 'Portal', color: 'pink' },
    slack: { label: 'Slack', color: 'grape' },
    teams: { label: 'Teams', color: 'cyan' },
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

/** The source a stored session carries (`metadata.source`); undefined for one recorded before sources existed. */
export function sessionSourceOf(metadata: Record<string, unknown> | undefined): string | undefined {
    const source = metadata?.source;
    return typeof source === 'string' ? source : undefined;
}

export function SessionSourceBadge({ source }: { source: string | undefined }) {
    if (!source) return null;
    const meta = SOURCE_LABELS[source] ?? { label: source, color: 'gray' };
    return <Badge size="xs" variant="light" color={meta.color}>{meta.label}</Badge>;
}

/** Who a row belongs to, in words: the person's name, or the kind of traffic. */
export function sessionOwnerText(session: Pick<SessionListItem, 'owner' | 'createdBy' | 'ownSession'>, say: (key: string) => string): string {
    if (session.ownSession) return say('ownerYou');
    const owner = session.owner;
    if (!owner) return session.createdBy ?? '—';
    switch (owner.kind) {
        case 'user': return owner.name || owner.email || owner.id;
        case 'trigger': return say('ownerTrigger');
        case 'public_a2a': return say('ownerPublicA2a');
        case 'evaluation': return say('ownerEvaluation');
        case 'redteam': return say('ownerRedteam');
        case 'system': return say('ownerSystem');
        default: return owner.id;
    }
}

export interface SessionListProps {
    /** Needed to stop a run from the list (a row's own `agentId` wins). */
    agentId?: string;
    sessions: SessionListItem[];
    /** The caller sees only the sessions they started (the permission to view others' is not theirs). */
    ownOnly?: boolean;
    loading?: boolean;
    /** Row click — shows the session (read-only). */
    onOpen: (sessionId: string) => void;
    /** Resume a console session in the chat view. */
    onContinue?: (sessionId: string) => void;
    /** Offered in the empty state; a list that cannot start sessions (the project-wide one) leaves it out. */
    onStart?: () => void;
    /** Adds the Agent column and filter, for rows of several agents. */
    showAgent?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    /** Reload the list (Sessions tab). */
    onRefresh?: () => void;
    refreshing?: boolean;
    /** A run was stopped from the list, so the rows are out of date. */
    onRunStopped?: () => void;
    /** The same runs as traces — span-level detail lives in Tracing. */
    tracesHref?: string;
}

/** Column widths (px). The cross-agent table has one column more, so its fixed ones are narrower and the name keeps room at 1440 px. */
const COLUMN_WIDTHS = {
    single: { agent: 0, source: 100, owner: 130, id: 130, turns: 70, tokens: 90, cost: 90, active: 90, updated: 110 },
    wide: { agent: 130, source: 90, owner: 110, id: 110, turns: 70, tokens: 80, cost: 80, active: 80, updated: 100 },
} as const;
/** The least the name of a cross-agent row is given. */
const WIDE_NAME_MIN_WIDTH = 170;
/** The cross-agent table's fixed columns plus that name; narrower screens scroll the table, not the page. */
const WIDE_TABLE_MIN_WIDTH = 1080;

function TableScroller({ on, children }: { on: boolean; children: ReactNode }) {
    return on ? <Table.ScrollContainer minWidth={WIDE_TABLE_MIN_WIDTH} type="native">{children}</Table.ScrollContainer> : <>{children}</>;
}

export default function SessionList({
    agentId,
    sessions,
    ownOnly,
    loading,
    onOpen,
    onContinue,
    onStart,
    showAgent,
    emptyTitle,
    emptyDescription,
    onRefresh,
    refreshing,
    onRunStopped,
    tracesHref,
}: SessionListProps) {
    const t = useTranslations('agents.hitl');
    const tb = useTranslations('agents.budget');
    const ts = useTranslations('agents.sessionAccess');
    const tr = useTranslations('agents.reminders');
    const tall = useTranslations('agents.allSessions');
    const columns = showAgent ? COLUMN_WIDTHS.wide : COLUMN_WIDTHS.single;
    const [stopping, setStopping] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    // Not named `window`: that shadows the global inside this component,
    // which is a trap waiting for the first line that needs the real one.
    const [timeWindow, setTimeWindow] = useState<WindowFilter>('all');
    const [activity, setActivity] = useState<ActivityFilter>('all');
    const [status, setStatus] = useState<StatusFilter>('all');
    const [source, setSource] = useState<string>('all');
    const [agentFilter, setAgentFilter] = useState<string>('all');
    const [range, setRange] = useState<DateRange>([null, null]);
    const [sort, setSort] = useState<SortState>({ column: 'updatedAt', direction: 'desc' });

    const stopRun = async (ownerAgentId: string, runId: string) => {
        setStopping(runId);
        try {
            const res = await fetch(`/api/agents/${ownerAgentId}/runs/${runId}/cancel`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
            notifications.show({ color: 'teal', message: tr('runStopRequested') });
            onRunStopped?.();
        } catch (error) {
            notifications.show({ color: 'red', message: `${tr('runStopFailed')}: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            setStopping(null);
        }
    };

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
            if (status === 'waiting' || status === 'waiting_elsewhere') {
                // "Waiting for you" lists what the viewer could answer; what only somebody else can is its own filter.
                if (waitingFor(session) !== (status === 'waiting' ? 'you' : 'elsewhere')) return false;
            } else if (status !== 'all' && session.status !== status) return false;
            if (source !== 'all' && (session.source ?? 'unknown') !== source) return false;
            if (agentFilter !== 'all' && session.agentId !== agentFilter) return false;
            if (activity === 'used' && (session.turns ?? 0) === 0) return false;
            if (activity === 'empty' && (session.turns ?? 0) > 0) return false;
            if (activity === 'unpriced' && session.costComplete !== false) return false;
            return true;
        });

        return sortSessions(matching, sort);
    }, [sessions, query, timeWindow, range, activity, status, source, agentFilter, sort]);

    // Only the sources that actually occur — a filter offering "Red team" on
    // an agent nobody red-teamed is a filter that always returns nothing.
    const sourceOptions = useMemo(() => {
        const seen = [...new Set(sessions.map((session) => session.source ?? 'unknown'))];
        return [
            { value: 'all', label: 'All sources' },
            ...seen.map((value) => ({ value, label: value === 'unknown' ? 'Unknown' : sessionSourceLabel(value) })),
        ];
    }, [sessions]);

    // Likewise only the agents that occur among the rows.
    const agentOptions = useMemo(() => {
        const seen = new Map<string, string>();
        for (const session of sessions) {
            if (session.agentId && !seen.has(session.agentId)) seen.set(session.agentId, session.agentName ?? session.agentKey ?? session.agentId);
        }
        return [
            { value: 'all', label: tall('allAgents') },
            ...[...seen].map(([value, label]) => ({ value, label })),
        ];
    }, [sessions, tall]);

    const filtersActive = Boolean(query.trim()) || timeWindow !== 'all' || activity !== 'all'
        || status !== 'all' || source !== 'all' || agentFilter !== 'all';
    const clearFilters = () => {
        setQuery(''); setTimeWindow('all'); setRange([null, null]); setActivity('all'); setStatus('all'); setSource('all'); setAgentFilter('all');
    };

    // The whole row opens the inspector; the controls inside it (copy, stop, links, the filters' portals) keep their own click.
    const openFromRow = (event: React.MouseEvent<HTMLElement>, sessionId: string) => {
        if ((event.target as HTMLElement).closest('a,button,input,textarea,select,label,[role="button"],[role="option"],[data-no-row-click]')) return;
        onOpen(sessionId);
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
                title={emptyTitle ?? 'No sessions yet'}
                description={emptyDescription ?? 'Start a session to try this agent — every message, tool call and answer is saved so you can come back to it.'}
                minHeight={200}
                action={onStart ? (
                    <Button size="sm" leftSection={<IconPlus size={14} />} onClick={onStart}>
                        Start new session
                    </Button>
                ) : undefined}
            />
        );
    }

    return (
        <Stack gap="sm">
            {ownOnly ? (
                <Alert variant="light" color="gray" p="xs" icon={<IconInfoCircle size={14} />} data-testid="sessions-own-only">
                    <Text size="xs">{ts('ownOnlyNotice')}</Text>
                </Alert>
            ) : null}
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
                            { value: 'waiting', label: t('waitingFilter') },
                            // only where such a row exists (a viewer who may answer everything never sees it)
                            ...(sessions.some((session) => waitingFor(session) === 'elsewhere')
                                ? [{ value: 'waiting_elsewhere', label: ts('waitingElsewhereBadge') }]
                                : []),
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
                    {showAgent && agentOptions.length > 2 ? (
                        <Select
                            size="xs"
                            w={160}
                            data={agentOptions}
                            value={agentFilter}
                            onChange={(next) => setAgentFilter(next ?? 'all')}
                            allowDeselect={false}
                            aria-label={tall('agentColumn')}
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
                    {filtersActive ? (
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

            {filtered.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center" py="xl">
                    No session matches these filters.
                </Text>
            ) : (
            <TableScroller on={Boolean(showAgent)}>
            <Table highlightOnHover verticalSpacing={6} className={classes.table}>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>
                            <SortHeader column="title" sort={sort} onSort={toggleSort}>Name</SortHeader>
                        </Table.Th>
                        {showAgent ? <Table.Th w={columns.agent}>{tall('agentColumn')}</Table.Th> : null}
                        <Table.Th w={columns.source}>Source</Table.Th>
                        <Table.Th w={columns.owner}>{ts('ownerColumn')}</Table.Th>
                        <Table.Th w={columns.id}>Session ID</Table.Th>
                        <Table.Th w={columns.turns} ta="right">
                            <SortHeader column="turns" sort={sort} onSort={toggleSort} align="right">Turns</SortHeader>
                        </Table.Th>
                        <Table.Th w={columns.tokens} ta="right">
                            <SortHeader column="totalTokens" sort={sort} onSort={toggleSort} align="right">Tokens</SortHeader>
                        </Table.Th>
                        <Table.Th w={columns.cost} ta="right">
                            <SortHeader column="costUsd" sort={sort} onSort={toggleSort} align="right">Cost</SortHeader>
                        </Table.Th>
                        <Table.Th w={columns.active} ta="right">
                            <Tooltip label="Time the agent spent working, summed over turns" withArrow>
                                <span>
                                    <SortHeader column="activeMs" sort={sort} onSort={toggleSort} align="right">Active</SortHeader>
                                </span>
                            </Tooltip>
                        </Table.Th>
                        <Table.Th w={columns.updated}>
                            <SortHeader column="updatedAt" sort={sort} onSort={toggleSort}>Last activity</SortHeader>
                        </Table.Th>
                        <Table.Th w={40} />
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {filtered.map((session) => (
                                <Table.Tr key={session._id} className={classes.row} onClick={(event) => openFromRow(event, session._id)}>
                                    <Table.Td>
                                        <Group gap={6} wrap="nowrap" miw={showAgent ? WIDE_NAME_MIN_WIDTH : undefined}>
                                            <UnstyledButton onClick={() => onOpen(session._id)} className={classes.nameButton}>
                                                <Text size="sm" fw={500} lineClamp={1}>
                                                    {session.title || 'New session'}
                                                </Text>
                                            </UnstyledButton>
                                            {session.runtimeStatus === 'requires_action' ? (
                                                session.canResolve === false ? (
                                                    // Waiting, but not for this viewer: the server says they could not answer it.
                                                    <Tooltip label={ts('waitingElsewhereTooltip')} withArrow>
                                                        <Badge size="xs" variant="light" color="gray" leftSection={<IconHandStop size={10} />}>
                                                            {ts('waitingElsewhereBadge')}
                                                        </Badge>
                                                    </Tooltip>
                                                ) : (
                                                    <Tooltip label={t('waitingTooltip')} withArrow>
                                                        <Badge size="xs" variant="light" color="orange" leftSection={<IconHandStop size={10} />}>
                                                            {t('waitingBadge')}
                                                        </Badge>
                                                    </Tooltip>
                                                )
                                            ) : null}
                                            {session.runtimeStatus === 'budget_paused' ? (
                                                <Tooltip label={tb('pausedTooltip')} withArrow>
                                                    <Badge size="xs" variant="light" color="orange" leftSection={<IconCoin size={10} />}>
                                                        {tb('pausedBadge')}
                                                    </Badge>
                                                </Tooltip>
                                            ) : null}
                                            {session.activeRun && session.activeRun.status !== 'requires_action' ? (
                                                <Group gap={2} wrap="nowrap">
                                                    <Tooltip
                                                        label={session.activeRun.status === 'scheduled' && session.activeRun.scheduledFor
                                                            ? tr('runScheduledFor', { time: new Date(session.activeRun.scheduledFor * 1000).toLocaleString() })
                                                            : session.activeRun.id}
                                                        withArrow
                                                    >
                                                        <span>
                                                            <StatusBadge status={session.activeRun.cancelRequested ? 'canceling' : session.activeRun.status} label={session.activeRun.cancelRequested ? tr('runCanceling') : undefined} />
                                                        </span>
                                                    </Tooltip>
                                                    {(session.agentId ?? agentId) && !session.activeRun.cancelRequested ? (
                                                        <Tooltip label={tr('stopRun')} withArrow>
                                                            <ActionIcon
                                                                size="xs"
                                                                variant="subtle"
                                                                color="gray"
                                                                loading={stopping === session.activeRun.id}
                                                                onClick={() => void stopRun((session.agentId ?? agentId)!, session.activeRun!.id)}
                                                                aria-label={tr('stopRun')}
                                                            >
                                                                <IconPlayerStop size={12} />
                                                            </ActionIcon>
                                                        </Tooltip>
                                                    ) : null}
                                                </Group>
                                            ) : null}
                                            {session.reminders && session.reminders.active > 0 ? (
                                                <Tooltip label={reminderRowHint(session.reminders, tr)} withArrow>
                                                    <IconClock size={13} color="var(--mantine-color-dimmed)" aria-label={tr('rowHintLabel')} />
                                                </Tooltip>
                                            ) : null}
                                            {session.status === 'error' ? (
                                                <Tooltip
                                                    label={session.failedCalls
                                                        ? `${session.failedCalls} failed tool call${session.failedCalls === 1 ? '' : 's'}`
                                                        : 'An output failed validation'}
                                                    withArrow
                                                >
                                                    <IconAlertTriangle size={14} color="var(--ds-err)" aria-label="Has errors" />
                                                </Tooltip>
                                            ) : session.status === 'stopped' && session.runtimeStatus !== 'requires_action' ? (
                                                <Tooltip label="A turn stopped early (limit, cancel or pause)" withArrow>
                                                    <IconHandStop size={14} color="var(--ds-warn)" aria-label="Stopped early" />
                                                </Tooltip>
                                            ) : null}
                                        </Group>
                                    </Table.Td>
                                    {showAgent ? (
                                        <Table.Td>
                                            {session.agentId ? (
                                                <Tooltip label={tall('openAgent')} withArrow>
                                                    <Text
                                                        component={Link}
                                                        href={`/dashboard/agents/${session.agentId}?tab=sessions`}
                                                        size="xs"
                                                        lineClamp={1}
                                                        className={classes.agentLink}
                                                    >
                                                        {session.agentName ?? session.agentKey ?? session.agentId}
                                                    </Text>
                                                </Tooltip>
                                            ) : null}
                                        </Table.Td>
                                    ) : null}
                                    <Table.Td>
                                        <SessionSourceBadge source={session.source} />
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="xs" c={session.ownSession ? undefined : 'dimmed'} lineClamp={1} data-testid="session-owner">
                                            {sessionOwnerText(session, ts)}
                                        </Text>
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
            </TableScroller>
            )}
        </Stack>
    );
}

