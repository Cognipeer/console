'use client';

/**
 * Sessions of every agent in the project — the Active and All entries of the
 * Agents menu. A row opens the inspector (the read-only session drawer), never
 * the chat page: most of these sessions are real traffic, not tests, and even a
 * test session is continued from its agent's own page.
 *
 * The page keeps itself current: Active always polls, All only while some
 * session in it is running, and neither while the tab is hidden.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconRefresh } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { useTranslations } from '@/lib/i18n';
import { isSessionOngoing } from '@/lib/services/agents/sessionActivityState';
import SessionDetailDrawer from '../studio/SessionDetailDrawer';
import SessionList, { type SessionListItem } from '../studio/SessionList';

type View = 'active' | 'all';
/** initial: first read with a skeleton; refresh: the list's own button; silent: polling and "something changed" callbacks. */
type LoadMode = 'initial' | 'refresh' | 'silent';

const PAGE_SIZE = 100;
const REFRESH_MS = 5000;

interface SessionsResponse {
    sessions?: SessionListItem[];
    hasMore?: boolean;
    nextCursor?: string;
    scope?: { viewOthers?: boolean; partial?: boolean };
}

const stamp = (row: SessionListItem) => Date.parse(row.updatedAt ?? row.createdAt ?? '') || 0;

function byRecentActivity(a: SessionListItem, b: SessionListItem): number {
    return stamp(b) - stamp(a) || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0);
}

/**
 * Fold a fresh first page into what is shown. Fresh rows win; a shown row the
 * page lacks has left the window (deleted, or moved) when it is not older than
 * the page's oldest row — older ones come from "Load more" pages and stay.
 */
function mergeFirstPage(shown: SessionListItem[], fresh: SessionListItem[], complete: boolean): SessionListItem[] {
    // A page that holds everything leaves nothing "older" to keep.
    if (complete || fresh.length === 0) return [...fresh].sort(byRecentActivity);
    const freshIds = new Set(fresh.map((row) => row._id));
    const oldest = Math.min(...fresh.map(stamp));
    const kept = shown.filter((row) => !freshIds.has(row._id) && stamp(row) < oldest);
    return [...fresh, ...kept].sort(byRecentActivity);
}

export default function AgentSessionsPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const view: View = searchParams?.get('view') === 'active' ? 'active' : 'all';
    const t = useTranslations('agents.allSessions');
    const ts = useTranslations('agents.sessionAccess');

    const [rows, setRows] = useState<SessionListItem[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | undefined>();
    const [scope, setScope] = useState<SessionsResponse['scope']>();
    const [initialLoading, setInitialLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [viewedId, setViewedId] = useState<string | null>(null);
    // The clicked row, so a session that leaves the Active list stays open.
    const [snapshot, setSnapshot] = useState<SessionListItem | null>(null);

    // Answers of an earlier view must not land in the current one.
    const generation = useRef(0);
    const silentInFlight = useRef(false);
    // Once "Load more" ran, a silent refresh must not rewind the cursor.
    const pagedFurther = useRef(false);

    const load = useCallback(async (mode: LoadMode) => {
        const gen = generation.current;
        if (mode === 'silent') {
            if (silentInFlight.current) return;
            silentInFlight.current = true;
        }
        if (mode === 'initial') setInitialLoading(true);
        if (mode === 'refresh') setRefreshing(true);
        try {
            const res = await fetch(`/api/agents/sessions?view=${view}&limit=${PAGE_SIZE}`, { cache: 'no-store' });
            const data = (await res.json().catch(() => ({}))) as SessionsResponse & { error?: string };
            if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
            if (gen !== generation.current) return;
            const fresh = data.sessions ?? [];
            if (mode === 'silent' && view === 'all') {
                setRows((shown) => mergeFirstPage(shown, fresh, !data.hasMore));
                if (!pagedFurther.current) {
                    setHasMore(Boolean(data.hasMore));
                    setNextCursor(data.nextCursor);
                }
            } else {
                pagedFurther.current = false;
                setRows(fresh);
                setHasMore(Boolean(data.hasMore));
                setNextCursor(data.nextCursor);
            }
            setScope(data.scope);
            setError(null);
        } catch (e) {
            if (gen !== generation.current) return;
            // A failed silent read keeps the rows on screen; the alert says why they may be stale.
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (gen === generation.current) {
                if (mode === 'silent') silentInFlight.current = false;
                if (mode === 'initial') setInitialLoading(false);
                if (mode === 'refresh') setRefreshing(false);
            }
        }
    }, [view]);

    useEffect(() => {
        generation.current += 1;
        silentInFlight.current = false;
        pagedFurther.current = false;
        setRows([]);
        setHasMore(false);
        setNextCursor(undefined);
        setError(null);
        void load('initial');
    }, [load]);

    const polling = view === 'active' || rows.some(isSessionOngoing);
    useEffect(() => {
        if (!polling) return undefined;
        const tick = () => {
            if (document.visibilityState === 'hidden') return;
            void load('silent');
        };
        const timer = setInterval(tick, REFRESH_MS);
        // A hidden tab skipped its ticks, so come back to current data.
        document.addEventListener('visibilitychange', tick);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', tick);
        };
    }, [polling, load]);

    const loadMore = async () => {
        if (!nextCursor || loadingMore) return;
        const gen = generation.current;
        setLoadingMore(true);
        try {
            const res = await fetch(
                `/api/agents/sessions?view=${view}&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`,
                { cache: 'no-store' },
            );
            const data = (await res.json().catch(() => ({}))) as SessionsResponse & { error?: string };
            if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
            if (gen !== generation.current) return;
            pagedFurther.current = true;
            setRows((shown) => {
                const known = new Set(shown.map((row) => row._id));
                return [...shown, ...(data.sessions ?? []).filter((row) => !known.has(row._id))];
            });
            setHasMore(Boolean(data.hasMore));
            setNextCursor(data.nextCursor);
            setError(null);
        } catch (e) {
            if (gen === generation.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoadingMore(false);
        }
    };

    const reloadSilently = useCallback(() => void load('silent'), [load]);

    const openRow = (sessionId: string) => {
        setSnapshot(rows.find((row) => row._id === sessionId) ?? null);
        setViewedId(sessionId);
    };
    const closeInspector = () => {
        setViewedId(null);
        setSnapshot(null);
    };
    // While the list holds the row it keeps the snapshot current; once the row is gone (a finished run leaves
    // Active) the snapshot's run is stale, so the drawer is given the row without it and only the record decides.
    const inList = viewedId ? rows.find((row) => row._id === viewedId) : undefined;
    useEffect(() => {
        if (inList) setSnapshot(inList);
    }, [inList]);
    const viewed = useMemo<SessionListItem | null>(() => {
        if (!viewedId) return null;
        if (inList) return inList;
        if (!snapshot) return null;
        return { ...snapshot, activeRun: undefined };
    }, [viewedId, inList, snapshot]);

    const scopeNotice = scope?.viewOthers === false
        ? (scope.partial ? t('partialScopeNotice') : ts('ownOnlyNotice'))
        : null;

    return (
        <PageContainer>
            <PageHeader
                eyebrow="Build · Agents · Sessions"
                title={view === 'active' ? t('titleActive') : t('titleAll')}
                subtitle={view === 'active' ? t('descriptionActive') : t('descriptionAll')}
                actions={view === 'active' ? (
                    <Group gap={4} wrap="nowrap" c="dimmed">
                        <IconRefresh size={12} />
                        <Text size="xs" c="dimmed">{t('autoRefresh')}</Text>
                    </Group>
                ) : undefined}
            />
            <Stack gap="sm">
                {error ? (
                    <Alert
                        variant="light"
                        color="red"
                        icon={<IconAlertTriangle size={16} />}
                        title={t('loadFailed')}
                        data-testid="sessions-load-error"
                    >
                        <Group justify="space-between" gap="xs" wrap="nowrap">
                            <Text size="sm">{error}</Text>
                            <Button size="xs" variant="default" onClick={() => void load('refresh')}>{t('retry')}</Button>
                        </Group>
                    </Alert>
                ) : null}
                {scopeNotice ? (
                    <Alert variant="light" color="gray" p="xs" icon={<IconInfoCircle size={14} />} data-testid="sessions-scope-notice">
                        <Text size="xs">{scopeNotice}</Text>
                    </Alert>
                ) : null}
                <SessionList
                    showAgent
                    ownOnly={false}
                    sessions={rows}
                    loading={initialLoading}
                    onOpen={openRow}
                    onRefresh={() => void load('refresh')}
                    refreshing={refreshing}
                    onRunStopped={reloadSilently}
                    emptyTitle={view === 'active' ? t('emptyActiveTitle') : t('emptyAllTitle')}
                    emptyDescription={view === 'active' ? t('emptyActiveBody') : t('emptyAllBody')}
                />
                {view === 'active' && hasMore ? (
                    <Text size="xs" c="dimmed" data-testid="sessions-active-truncated">{t('activeTruncated')}</Text>
                ) : null}
                {view === 'all' && hasMore ? (
                    <Group justify="center">
                        <Button variant="default" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                            {t('loadMore')}
                        </Button>
                    </Group>
                ) : null}
            </Stack>
            <SessionDetailDrawer
                agentId={viewed?.agentId ?? ''}
                session={viewed}
                onClose={closeInspector}
                onContinue={(sessionId) => {
                    if (viewed?.agentId) router.push(`/dashboard/agents/${encodeURIComponent(viewed.agentId)}/sessions/${encodeURIComponent(sessionId)}`);
                }}
                onResolved={reloadSilently}
                onSessionChanged={reloadSilently}
            />
        </PageContainer>
    );
}
