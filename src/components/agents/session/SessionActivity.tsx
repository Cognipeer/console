'use client';

/**
 * The session event log, read: what the session recorded — the user's messages,
 * tool calls, approvals asked and answered, spend, and why each run ended.
 *
 * Read from `GET …/sessions/:id/events`, a page at a time (oldest first, the
 * order the log is kept in) with "Load more", and only once the view is on
 * screen. A session that logs something new while this is open appends it
 * instead of reloading what is already shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Box, Button, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import {
    ACTIVITY_PAGE_SIZE,
    describeSessionEvent,
    mergeEventPage,
    sessionEventsUrl,
    type EventView,
    type SessionLogEvent,
    type SessionLogPage,
} from './sessionActivityUi';
import classes from './AgentSessionView.module.css';

export interface SessionActivityProps {
    agentId: string;
    sessionId: string;
    /** Load (and keep current) only while the view is on screen. */
    active: boolean;
    /** Changes whenever the session may have logged something new. */
    refreshKey: string;
    pageSize?: number;
}

interface LogState {
    events: SessionLogEvent[];
    hasMore: boolean;
    lastSeq: number;
    loaded: boolean;
}

const EMPTY: LogState = { events: [], hasMore: false, lastSeq: 0, loaded: false };

/** The entries as the log shows them: the ones with something to say, each with its wording. */
function visibleEntries(events: SessionLogEvent[]): Array<{ event: SessionLogEvent; view: EventView }> {
    return events.flatMap((event) => {
        const view = describeSessionEvent(event);
        return view ? [{ event, view }] : [];
    });
}

function timeOf(event: SessionLogEvent): string {
    if (!event.created_at) return '';
    const at = new Date(event.created_at);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString();
}

export default function SessionActivity({ agentId, sessionId, active, refreshKey, pageSize = ACTIVITY_PAGE_SIZE }: SessionActivityProps) {
    const ta = useTranslations('agents.activity');
    const [state, setState] = useState<LogState>(EMPTY);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // What the effect below needs to know without re-running when it changes.
    const stateRef = useRef(state);
    stateRef.current = state;
    const inFlight = useRef(false);

    /** The page after `afterSeq`, appended to what is shown. */
    const fetchPage = useCallback(async (afterSeq: number) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(sessionEventsUrl(agentId, sessionId, afterSeq, pageSize), { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const page = (await res.json()) as SessionLogPage;
            setState((current) => ({
                events: mergeEventPage(current.events, page.events ?? []),
                hasMore: Boolean(page.has_more),
                lastSeq: page.last_seq ?? current.lastSeq,
                loaded: true,
            }));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }, [agentId, sessionId, pageSize]);

    // First time on screen: the first page. After that, whatever the log gained —
    // unless there is already more to load than is shown (then "Load more" goes on).
    useEffect(() => {
        if (!active) return;
        const { loaded, hasMore, lastSeq } = stateRef.current;
        if (!loaded) void fetchPage(0);
        else if (!hasMore) void fetchPage(lastSeq);
    }, [active, refreshKey, fetchPage]);

    const entries = useMemo(() => visibleEntries(state.events), [state.events]);

    return (
        <Stack gap="xs">
            <Group justify="space-between" gap="xs">
                <Text size="xs" fw={700} tt="uppercase" c="dimmed">{ta('title')}</Text>
                <Tooltip label={ta('refresh')} withArrow>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        loading={loading}
                        aria-label={ta('refresh')}
                        onClick={() => void fetchPage(stateRef.current.lastSeq)}
                    >
                        <IconRefresh size={13} />
                    </ActionIcon>
                </Tooltip>
            </Group>

            {error ? <Text size="xs" c="red">{ta('loadFailed')} ({error})</Text> : null}

            {!state.loaded && loading ? (
                <Group gap="xs"><Loader size="xs" /><Text size="xs" c="dimmed">{ta('loading')}</Text></Group>
            ) : null}
            {state.loaded && entries.length === 0 ? <Text size="xs" c="dimmed">{ta('empty')}</Text> : null}

            <Stack gap={0}>
                {entries.map(({ event, view }) => {
                    const reason = view.reasonKey ? ta(view.reasonKey) : view.values.reason;
                    const label = ta(view.key, { ...view.values, ...(reason !== undefined ? { reason } : {}) });
                    return (
                        <Group key={event.seq} gap="xs" wrap="nowrap" align="flex-start" className={classes.activityRow}>
                            <Text size="10px" c="dimmed" ff="monospace" className={classes.activityTime}>{timeOf(event)}</Text>
                            <span
                                className={classes.activityDot}
                                style={{ background: `var(--mantine-color-${view.tone}-6)` }}
                                aria-hidden="true"
                            />
                            <Box className={classes.eventName} style={{ flex: 1 }}>
                                <Text size="xs">{label}</Text>
                                {view.detail ? <Text size="10px" c="dimmed" lineClamp={2}>{view.detail}</Text> : null}
                            </Box>
                        </Group>
                    );
                })}
            </Stack>

            {state.hasMore ? (
                <Button size="compact-xs" variant="default" loading={loading} onClick={() => void fetchPage(state.lastSeq)}>
                    {ta('loadMore')}
                </Button>
            ) : null}
        </Stack>
    );
}
