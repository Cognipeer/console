'use client';

/**
 * A Session: one persisted conversation with an agent, as its own page.
 *
 * Moved out of the agent detail tabs on purpose — a session that can be
 * bookmarked, reopened days later and found again from the Sessions list is a
 * genuinely different thing from an ephemeral "try it" panel squeezed next to
 * a settings sidebar, and deserves the room a full page gives it (see the
 * Sessions tab in AgentDetailPage, which lists these and starts new ones).
 *
 * The layout is a transcript on the left and an inspector on the right,
 * because the two questions asked of a session are different: "what was
 * said" reads top-to-bottom, while "what did it cost / which tools ran /
 * which config answered" is reference data that should stay put while you
 * scroll. History and debug detail (tool steps, token usage, structured
 * output, cost, which config version answered) persist server-side — see
 * `agentService.ts#persistSessionTurn` — so reopening a session shows what
 * actually happened, not just the last answer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    ActionIcon,
    Alert,
    Badge,
    Box,
    Button,
    Center,
    Code,
    Collapse,
    CopyButton,
    Group,
    Loader,
    Paper,
    ScrollArea,
    Select,
    Stack,
    Text,
    Textarea,
    TextInput,
    TypographyStylesProvider,
    ThemeIcon,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconBrain,
    IconCheck,
    IconChevronDown,
    IconChevronRight,
    IconClock,
    IconCopy,
    IconCoin,
    IconHandStop,
    IconInfoCircle,
    IconMessageCircle,
    IconRefresh,
    IconPlayerPlay,
    IconRobot,
    IconSearch,
    IconSend,
    IconTimeline,
    IconTrash,
    IconUser,
    IconZoomIn,
    IconZoomOut,
    IconArrowsLeftRight,
} from '@tabler/icons-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DetailShell from '@/components/common/ui/DetailShell';
import LoadingState from '@/components/common/LoadingState';
import EmptyState from '@/components/common/EmptyState';
import RuntimeContextEditor, { parseRuntimeContextJson } from '@/components/common/RuntimeContextEditor';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { isContinuableSession, sessionSourceLabel } from '../studio/SessionList';
import CompareVersionsDrawer from '../studio/CompareVersionsDrawer';
import SessionSidePanel from './SessionSidePanel';
import LiveToolCalls, { summariseArgs, type LiveToolCall } from './LiveToolCalls';
import { consumeSse } from './consumeSse';
import ContextCompactionCard from './ContextCompactionCard';
import type { ChatMessage, PlaygroundStep, TurnCompaction } from './sessionTypes';
import { formatCompactTokens, formatCost, summariseSession } from './sessionUsage';
import classes from './AgentSessionView.module.css';

interface AgentSummary {
    key: string;
    name: string;
    description?: string;
    publishedVersion?: number | null;
    config?: {
        kind?: 'native' | 'external';
        // What the agent can call, for the inspector's Tools tab — a tool that
        // was never bound reads very differently from one that was bound and
        // never chosen.
        toolBindings?: Array<{ source?: string; sourceKey?: string; toolNames?: string[] }>;
        knowledgeEngineKey?: string;
        subagents?: unknown[];
        skills?: unknown[];
        memory?: { enabled?: boolean; memoryStoreKey?: string; tools?: 'off' | 'read' | 'readwrite' };
        sandbox?: {
            enabled?: boolean;
            templateKey?: string;
            tools?: { exec?: boolean; code?: boolean; files?: boolean };
            preview?: { enabled?: boolean };
        };
    };
}

interface VersionOption {
    version: number;
}

export interface AgentSessionViewProps {
    agentId: string;
    sessionId: string;
}

/** How much of a payload is shown before "Show the whole payload". */
const PAYLOAD_CLIP_CHARS = 1200;

/** Timeline zoom steps, in pixels-per-second of turn latency. */
const ZOOM_LEVELS = [2, 6, 18, 54];
const DEFAULT_ZOOM = 1;

/** A failed run, with the server's classification of what failed. */
class TurnFailure extends Error {
    constructor(message: string, readonly type?: string) {
        super(message);
    }
}

/** What an operator can do about each kind of failure. */
function failureHint(type: string | undefined): string | undefined {
    switch (type) {
        case 'provider_authentication_error':
            return 'Fix the API key on the model’s provider (Model Hub → Providers), then retry.';
        case 'provider_permission_error':
            return 'The provider account cannot use this model or deployment. Check its access, then retry.';
        case 'agent_config_error':
            return 'The agent’s configuration is broken — open Configure and fix the highlighted field.';
        case 'rate_limit_error':
            return 'The provider is rate limiting. Wait a moment and retry.';
        case 'guardrail_block':
            return 'A guardrail blocked this message.';
        default:
            return undefined;
    }
}

const STOP_LABELS: Record<NonNullable<ChatMessage['stopReason']>, string> = {
    limit: 'Stopped by a run limit',
    cancelled: 'Run cancelled',
    paused: 'Run paused',
};

export default function AgentSessionView({ agentId, sessionId }: AgentSessionViewProps) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const [agent, setAgent] = useState<AgentSummary | null>(null);
    const [sessionTitle, setSessionTitle] = useState<string>('');
    const [sessionCreatedAt, setSessionCreatedAt] = useState<string | undefined>();
    const [sessionUpdatedAt, setSessionUpdatedAt] = useState<string | undefined>();
    const [sessionContext, setSessionContext] = useState<Record<string, unknown> | undefined>();
    const [versions, setVersions] = useState<VersionOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [compareOpen, setCompareOpen] = useState(false);
    // API / A2A / scheduled sessions are real traffic: shown, never extended
    // from here. Only console sessions (or legacy ones without a source) take
    // new messages — the same rule the Sessions panel applies to Continue.
    const [sessionSource, setSessionSource] = useState<string | undefined>(undefined);
    const readOnly = !isContinuableSession(sessionSource);
    const [search, setSearch] = useState('');
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [overrideOpen, setOverrideOpen] = useState(false);
    const [runtimeContextJson, setRuntimeContextJson] = useState('');
    const [pinnedVersion, setPinnedVersion] = useState(searchParams.get('version') ?? '');
    const [deleting, setDeleting] = useState(false);
    const [liveCalls, setLiveCalls] = useState<LiveToolCall[]>([]);
    const [generating, setGenerating] = useState(false);
    const [streamText, setStreamText] = useState('');
    const [liveCompactions, setLiveCompactions] = useState<TurnCompaction[]>([]);

    const viewportRef = useRef<HTMLDivElement>(null);
    const turnRefs = useRef<Array<HTMLDivElement | null>>([]);
    const composerRef = useRef<HTMLTextAreaElement>(null);

    /** Jump to the end of the transcript with the cursor already in the box. */
    const continueSession = () => {
        if (viewportRef.current) {
            viewportRef.current.scrollTo({
                top: viewportRef.current.scrollHeight,
                behavior: 'smooth',
            });
        }
        composerRef.current?.focus();
    };

    const isConnected = agent?.config?.kind === 'external';

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [agentRes, sessionRes] = await Promise.all([
                fetch(`/api/agents/${agentId}`, { cache: 'no-store' }),
                fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { cache: 'no-store' }),
            ]);
            if (!agentRes.ok || !sessionRes.ok) {
                setNotFound(true);
                return;
            }
            const agentData = await agentRes.json();
            const sessionData = await sessionRes.json();
            setAgent(agentData.agent);
            setSessionTitle(sessionData.session.title ?? '');
            setSessionSource(
                typeof sessionData.session.metadata?.source === 'string' ? sessionData.session.metadata.source : undefined,
            );
            setSessionCreatedAt(sessionData.session.createdAt ?? undefined);
            setSessionUpdatedAt(sessionData.session.updatedAt ?? undefined);
            setSessionContext(
                (sessionData.session.metadata?.runtimeContext as Record<string, unknown> | undefined) ?? undefined,
            );
            // A resumed turn's version badge, tokens and cost should read "what
            // this turn actually did", which the stored record already carries
            // — nothing to recompute here.
            setMessages(sessionData.session.messages ?? []);

            const versionsRes = await fetch(`/api/agents/${agentId}/versions?limit=100`, { cache: 'no-store' });
            if (versionsRes.ok) {
                const versionsData = await versionsRes.json();
                setVersions(versionsData.versions ?? []);
            }
        } catch (err) {
            console.error('Failed to load session', err);
            setNotFound(true);
        } finally {
            setLoading(false);
        }
    }, [agentId, sessionId]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (viewportRef.current) {
            viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
        }
    }, [messages]);

    const totals = useMemo(() => summariseSession(messages), [messages]);

    /**
     * Only assistant turns have a duration, so the strip is one segment per
     * answer — a user message takes no time the agent spent.
     */
    const timeline = useMemo(
        () =>
            messages
                .map((message, index) => ({ index, message }))
                .filter(({ message }) => message.role === 'assistant' || message.role === 'error'),
        [messages],
    );

    const query = search.trim().toLowerCase();
    const matchedIndexes = useMemo(() => {
        if (!query) return null;
        const matched = new Set<number>();
        messages.forEach((message, index) => {
            if (message.content?.toLowerCase().includes(query)) matched.add(index);
        });
        return matched;
    }, [messages, query]);

    const goToTurn = (index: number) => {
        const node = turnRefs.current[index];
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    /**
     * Runs a turn over SSE so the tool calls show up as they happen.
     *
     * Falls back to the plain POST when the stream cannot be opened at all
     * (an old server without the route, a proxy that rejects the content
     * type). Losing live progress is a downgrade; losing the ability to send
     * a message is a breakage, and the two should not be the same failure.
     */
    const sendMessage = async () => {
        if (!input.trim() || sending || readOnly) return;
        const message = input.trim();
        const startedAt = Date.now();
        setSending(true);
        setInput('');
        setLiveCalls([]);
        setGenerating(false);
        setStreamText('');
        setLiveCompactions([]);

        const optimistic: ChatMessage[] = [...messages, { role: 'user', content: message }];
        setMessages(optimistic);

        const body = JSON.stringify({
            message,
            conversationId: sessionId,
            runtime_context: parseRuntimeContextJson(runtimeContextJson),
            ...(pinnedVersion ? { version: Number(pinnedVersion) } : {}),
        });

        const applyResult = (data: Record<string, unknown>) => {
            setMessages([
                ...optimistic,
                {
                    role: 'assistant',
                    content: String(data.content ?? ''),
                    ...(typeof data.reasoning === 'string' && data.reasoning ? { reasoning: data.reasoning } : {}),
                    ...(Array.isArray(data.steps) && data.steps.length > 0
                        ? { steps: data.steps as PlaygroundStep[] }
                        : {}),
                    ...(data.output !== undefined ? { output: data.output } : {}),
                    ...(data.outputError ? { outputError: String(data.outputError) } : {}),
                    ...(data.usage ? { usage: data.usage as ChatMessage['usage'] } : {}),
                    ...(typeof data.stopReason === 'string' ? { stopReason: data.stopReason as ChatMessage['stopReason'] } : {}),
                    ...(typeof data.stopDetail === 'string' ? { stopDetail: data.stopDetail } : {}),
                    ...(Array.isArray(data.compactions) && data.compactions.length > 0
                        ? { compactions: data.compactions as TurnCompaction[] }
                        : {}),
                    ...(Array.isArray(data.compactedTools) && data.compactedTools.length > 0
                        ? { compactedTools: data.compactedTools as ChatMessage['compactedTools'] }
                        : {}),
                    ...(Array.isArray(data.warnings) && data.warnings.length > 0
                        ? { warnings: data.warnings as string[] }
                        : {}),
                    version: (data.version as number | null) ?? null,
                    // The server times the invoke itself; the round trip is the
                    // fallback for an older response that carries no latency.
                    latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : Date.now() - startedAt,
                },
            ]);
            setSessionUpdatedAt(new Date().toISOString());
        };

        // The failure stays in the transcript, under the message that caused
        // it — a toast that vanishes after a few seconds, with the question
        // itself rolled back, read as "nothing happened". Not persisted: the
        // server stored neither the question nor an answer, so a reload shows
        // the session as it really is.
        const fail = (error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            const type = error instanceof TurnFailure ? error.type : undefined;
            setMessages([
                ...optimistic,
                { role: 'error', content: text, ...(type ? { errorType: type } : {}) },
            ]);
        };

        try {
            const res = await fetch(`/api/agents/${agentId}/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                body,
            });

            if (!res.ok || !res.body) {
                // A 4xx here is a real rejection (bad request, no access) and
                // retrying it unstreamed would only produce the same error
                // twice; only a missing route is worth falling back for.
                if (res.status !== 404) {
                    const err = await res.json().catch(() => ({}));
                    throw new TurnFailure(err.error || `Chat failed (HTTP ${res.status})`, err.type);
                }
                const plain = await fetch(`/api/agents/${agentId}/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (!plain.ok) {
                    const err = await plain.json().catch(() => ({}));
                    throw new TurnFailure(err.error || 'Chat failed', err.type);
                }
                applyResult(await plain.json());
                return;
            }

            await consumeSse(res.body, (event, data) => {
                if (event === 'tool') {
                    const payload = data as {
                        phase: string; name: string; id?: string; args?: unknown;
                        durationMs?: number; error?: string;
                    };
                    setLiveCalls((current) => {
                        // Terminal phases carry the same id as their start, so
                        // the row updates in place; without an id (some
                        // providers omit it) the newest running row of that
                        // name is the one that just finished.
                        const key = payload.id ?? `${payload.name}:${current.length}`;
                        if (payload.phase === 'start') {
                            setGenerating(false);
                            return [...current, {
                                key,
                                name: payload.name,
                                detail: summariseArgs(payload.args),
                                running: true,
                            }];
                        }
                        const index = payload.id
                            ? current.findIndex((call) => call.key === payload.id)
                            : current.map((call) => call.name === payload.name && call.running)
                                .lastIndexOf(true);
                        if (index < 0) return current;
                        const next = [...current];
                        next[index] = {
                            ...next[index],
                            running: false,
                            durationMs: payload.durationMs,
                            ...(payload.error ? { error: payload.error } : {}),
                        };
                        // Every call settled: whatever happens next is the model
                        // writing, which is what the operator is now waiting on.
                        if (next.every((call) => !call.running)) setGenerating(true);
                        return next;
                    });
                } else if (event === 'text') {
                    // First delta means the model is writing: the tool rows
                    // stop being the thing to watch.
                    setGenerating(false);
                    setStreamText((current) => current + String((data as { text?: string }).text ?? ''));
                } else if (event === 'summary') {
                    setLiveCompactions((current) => [...current, data as TurnCompaction]);
                } else if (event === 'result') {
                    applyResult(data as Record<string, unknown>);
                } else if (event === 'error') {
                    const payload = data as { error?: string; type?: string };
                    throw new TurnFailure(String(payload.error || 'Chat failed'), payload.type);
                }
            });
        } catch (err) {
            fail(err);
        } finally {
            setSending(false);
            setLiveCalls([]);
            setLiveCompactions([]);
            setGenerating(false);
            // Cleared only now: dropping it the moment `result` lands would
            // blank the answer for the frame between the two state updates.
            setStreamText('');
        }
    };

    const deleteSession = async () => {
        setDeleting(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete session');
            router.push(`/dashboard/agents/${agentId}?tab=sessions`);
        } catch (err) {
            notifications.show({
                title: 'Delete failed',
                message: err instanceof Error ? err.message : 'Unknown error',
                color: 'red',
            });
            setDeleting(false);
        }
    };

    if (loading) return <LoadingState label="Loading session..." minHeight={400} />;
    if (notFound || !agent) {
        return (
            <EmptyState
                title="Session not found"
                description="This session may have been deleted, or belongs to a different agent."
                minHeight={400}
            />
        );
    }

    return (
        <DetailShell
            backHref={`/dashboard/agents/${agentId}?tab=sessions`}
            backLabel="Back to sessions"
            icon={<IconMessageCircle size={16} />}
            title={
                <>
                    <span className="detail-title">{sessionTitle || 'Session'}</span>
                    <Badge size="sm" variant="light" color={sending ? 'blue' : 'gray'}>
                        {sending ? 'Running' : 'Idle'}
                    </Badge>
                    <Badge size="sm" variant="outline" color="gray" leftSection={<IconRobot size={11} />}>
                        {agent.name}
                    </Badge>
                    <Badge size="sm" variant="light" color={pinnedVersion ? 'teal' : 'gray'}>
                        {pinnedVersion ? `v${pinnedVersion}` : 'draft'}
                    </Badge>
                </>
            }
            meta={
                <Group gap="sm" wrap="wrap">
                    <Text size="xs" c="dimmed" ff="monospace">{sessionId}</Text>
                    {totals.activeMs > 0 ? (
                        <Tooltip label="Time the agent spent working, summed over turns" withArrow>
                            <Group gap={3}>
                                <IconClock size={11} />
                                <Text size="xs" c="dimmed">{formatDuration(totals.activeMs)}</Text>
                            </Group>
                        </Tooltip>
                    ) : null}
                    {totals.totalTokens > 0 ? (
                        <Tooltip label={`${totals.inputTokens} input · ${totals.outputTokens} output`} withArrow>
                            <Text size="xs" c="dimmed">
                                {formatCompactTokens(totals.inputTokens)}/{formatCompactTokens(totals.outputTokens)} tokens
                            </Text>
                        </Tooltip>
                    ) : null}
                    {totals.costUsd > 0 ? (
                        <Group gap={3}>
                            <IconCoin size={11} />
                            <Text size="xs" c="dimmed">{formatCost(totals.costUsd)}</Text>
                        </Group>
                    ) : null}
                    {sessionUpdatedAt ? (
                        <Text size="xs" c="dimmed">{formatRelativeTime(sessionUpdatedAt)}</Text>
                    ) : null}
                </Group>
            }
            actions={
                <>
                    {!isConnected ? (
                        <Select
                            size="xs"
                            w={180}
                            data={[
                                { value: '', label: 'Draft (current config)' },
                                ...versions.map((v) => ({
                                    value: String(v.version),
                                    label: `v${v.version}${v.version === agent.publishedVersion ? ' · published' : ''}`,
                                })),
                            ]}
                            value={pinnedVersion}
                            onChange={(next) => setPinnedVersion(next ?? '')}
                            allowDeselect={false}
                            disabled={sending}
                        />
                    ) : null}
                    {/*
                      A reopened session lands wherever you left the scroll, and
                      the composer is a page-height away at the bottom. This is
                      the "pick this back up" affordance the sessions table
                      links straight to.
                    */}
                    {!isConnected && versions.length > 0 ? (
                        <Button
                            size="xs"
                            variant="default"
                            leftSection={<IconArrowsLeftRight size={14} />}
                            onClick={() => setCompareOpen(true)}
                        >
                            Compare
                        </Button>
                    ) : null}
                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlayerPlay size={14} />}
                        onClick={continueSession}
                        disabled={sending}
                    >
                        Continue
                    </Button>
                    <Button
                        size="xs"
                        variant="light"
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        loading={deleting}
                        onClick={() => void deleteSession()}
                    >
                        Delete
                    </Button>
                </>
            }
        >
            <Group align="stretch" gap="md" wrap="nowrap" className={classes.workspace}>
                {/* ── Transcript ─────────────────────────────────────── */}
                <Paper withBorder radius="md" className={classes.transcriptPanel}>
                    <Group p="xs" gap="xs" wrap="nowrap" className={classes.transcriptToolbar}>
                        <TextInput
                            size="xs"
                            placeholder="Find in transcript"
                            leftSection={<IconSearch size={13} />}
                            value={search}
                            onChange={(event) => setSearch(event.currentTarget.value)}
                            className={classes.flexGrow}
                        />
                        {matchedIndexes ? (
                            <Text size="xs" c="dimmed" className={classes.noWrap}>
                                {matchedIndexes.size} of {messages.length}
                            </Text>
                        ) : (
                            <Text size="xs" c="dimmed" className={classes.noWrap}>
                                {messages.length} message{messages.length === 1 ? '' : 's'}
                            </Text>
                        )}
                        <Tooltip label="Zoom the timeline out" withArrow>
                            <ActionIcon
                                size="sm"
                                variant="subtle"
                                onClick={() => setZoom((value) => Math.max(0, value - 1))}
                                disabled={zoom === 0}
                            >
                                <IconZoomOut size={14} />
                            </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Zoom the timeline in" withArrow>
                            <ActionIcon
                                size="sm"
                                variant="subtle"
                                onClick={() => setZoom((value) => Math.min(ZOOM_LEVELS.length - 1, value + 1))}
                                disabled={zoom === ZOOM_LEVELS.length - 1}
                            >
                                <IconZoomIn size={14} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>

                    {timeline.length > 0 ? (
                        <ScrollArea type="hover" scrollbarSize={4} className={classes.timelineScroll}>
                            <Group gap={2} wrap="nowrap" px="xs" py={6}>
                                {timeline.map(({ index, message }) => {
                                    const seconds = (message.latencyMs ?? 0) / 1000;
                                    const failed = message.role === 'error'
                                        || Boolean(message.stopReason)
                                        || message.steps?.some((step) => step.error);
                                    return (
                                        <Tooltip
                                            key={index}
                                            withArrow
                                            label={`${formatDuration(message.latencyMs)}${message.steps?.length ? ` · ${message.steps.length} tool calls` : ''}`}
                                        >
                                            <UnstyledButton
                                                onClick={() => goToTurn(index)}
                                                className={`${classes.timelineSegment} ${failed ? classes.timelineSegmentFailed : ''}`}
                                                style={{ width: Math.max(10, seconds * ZOOM_LEVELS[zoom]) }}
                                            />
                                        </Tooltip>
                                    );
                                })}
                            </Group>
                        </ScrollArea>
                    ) : null}

                    <div className={classes.panelBody}>
                        {messages.length === 0 && !sending ? (
                            <Center className={classes.chatEmpty}>
                                <Stack align="center" gap="sm">
                                    <ThemeIcon size={48} radius="xl" variant="light" color="gray">
                                        <IconRobot size={24} />
                                    </ThemeIcon>
                                    <Text fw={600}>{agent.name}</Text>
                                    <Text size="sm" c="dimmed" ta="center" maw={320}>
                                        {agent.description || 'Send a message to start this session.'}
                                    </Text>
                                </Stack>
                            </Center>
                        ) : (
                            <ScrollArea className={classes.chatScroll} viewportRef={viewportRef} px="md" py="sm">
                                <Stack gap="lg">
                                    {messages.map((msg, i) => {
                                        if (matchedIndexes && !matchedIndexes.has(i)) return null;
                                        if (msg.role === 'error') {
                                            const previous = messages[i - 1];
                                            return (
                                                <Box
                                                    key={i}
                                                    ref={(node: HTMLDivElement | null) => { turnRefs.current[i] = node; }}
                                                    className={`${classes.turn} ${classes.errorTurn}`}
                                                >
                                                    <FailedTurn
                                                        message={msg}
                                                        onRetry={previous?.role === 'user'
                                                            ? () => {
                                                                setInput(previous.content);
                                                                setMessages(messages.slice(0, i - 1));
                                                                composerRef.current?.focus();
                                                            }
                                                            : undefined}
                                                    />
                                                </Box>
                                            );
                                        }
                                        return (
                                            <Box
                                                key={i}
                                                ref={(node: HTMLDivElement | null) => { turnRefs.current[i] = node; }}
                                                className={classes.turn}
                                            >
                                                <Group gap={6} mb={4} align="center">
                                                    <Badge
                                                        size="xs"
                                                        variant="light"
                                                        color={msg.role === 'user' ? 'blue' : 'grape'}
                                                        leftSection={msg.role === 'user'
                                                            ? <IconUser size={10} />
                                                            : <IconRobot size={10} />}
                                                    >
                                                        {msg.role === 'user' ? 'You' : agent.name}
                                                    </Badge>
                                                    {msg.role === 'assistant' ? <TurnPills message={msg} /> : null}
                                                </Group>
                                                {msg.role === 'assistant' ? (
                                                    <Box className={classes.chatMarkdown}>
                                                        {msg.reasoning ? (
                                                            <ReasoningDisclosure reasoning={msg.reasoning} latencyMs={msg.latencyMs} />
                                                        ) : null}
                                                        {msg.steps?.length ? <StepTimeline steps={msg.steps} /> : null}
                                                        {msg.compactions?.map((compaction, index) => (
                                                            <ContextCompactionCard
                                                                key={`${compaction.at}-${index}`}
                                                                compaction={compaction}
                                                                // The tool list is per turn; shown on the
                                                                // last pass so it is not repeated.
                                                                compactedTools={index === msg.compactions!.length - 1 ? msg.compactedTools : undefined}
                                                            />
                                                        ))}
                                                        {msg.stopReason ? <StopNotice message={msg} /> : null}
                                                        {/*
                                                      Wrapped so headings, lists and tables
                                                      in an answer actually look like
                                                      headings, lists and tables — a bare
                                                      ReactMarkdown emits real h2/ul/table
                                                      elements that nothing was styling, so
                                                      a structured report rendered as one
                                                      undifferentiated block of text.
                                                    */}
                                                    <TypographyStylesProvider className={classes.markdownBody}>
                                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                                    </TypographyStylesProvider>
                                                        {msg.output !== undefined ? <StructuredOutputBlock output={msg.output} /> : null}
                                                        {msg.outputError ? (
                                                            <Alert variant="light" color="red" icon={<IconAlertTriangle size={14} />} mt="xs" p="xs">
                                                                <Text size="xs">The answer did not match the output schema: {msg.outputError}</Text>
                                                            </Alert>
                                                        ) : null}
                                                        {msg.warnings?.length ? (
                                                            <Alert variant="light" color="yellow" icon={<IconInfoCircle size={14} />} mt="xs" p="xs">
                                                                <Stack gap={2}>
                                                                    <Text size="xs" fw={600}>This answer was produced without everything it should have had:</Text>
                                                                    {msg.warnings.map((warning) => (
                                                                        <Text key={warning} size="xs">{warning}</Text>
                                                                    ))}
                                                                </Stack>
                                                            </Alert>
                                                        ) : null}
                                                    </Box>
                                                ) : (
                                                    <Text size="sm" className={classes.preWrap}>{msg.content}</Text>
                                                )}
                                            </Box>
                                        );
                                    })}
                                    {matchedIndexes && matchedIndexes.size === 0 ? (
                                        <Text size="sm" c="dimmed" ta="center" py="xl">
                                            No message in this session contains “{search.trim()}”.
                                        </Text>
                                    ) : null}
                                    {sending ? (
                                        <Box>
                                            <Group gap={6} mb={4}>
                                                <Badge
                                                    size="xs"
                                                    variant="light"
                                                    color="grape"
                                                    leftSection={<IconRobot size={10} />}
                                                >
                                                    {agent.name}
                                                </Badge>
                                            </Group>
                                            {liveCompactions.map((compaction, index) => (
                                                <ContextCompactionCard key={`live-${index}`} compaction={compaction} live />
                                            ))}
                                            {liveCalls.length === 0 && !generating && !streamText ? (
                                                <Group gap="xs">
                                                    <Loader size="xs" />
                                                    <Text size="xs" c="dimmed">The agent is working…</Text>
                                                </Group>
                                            ) : (
                                                <LiveToolCalls calls={liveCalls} generating={generating} />
                                            )}
                                            {streamText ? (
                                                <Box className={classes.chatMarkdown} mt="xs">
                                                    <TypographyStylesProvider className={classes.markdownBody}>
                                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                            {streamText}
                                                        </ReactMarkdown>
                                                    </TypographyStylesProvider>
                                                </Box>
                                            ) : null}
                                        </Box>
                                    ) : null}
                                </Stack>
                            </ScrollArea>
                        )}

                        <Box p="sm" className={classes.composer}>
                            <Textarea
                                ref={composerRef}
                                placeholder={readOnly
                                    ? `Read-only — this session came in via ${sessionSourceLabel(sessionSource)}`
                                    : 'Send a message to the agent'}
                                value={input}
                                onChange={(event) => setInput(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.shiftKey) {
                                        event.preventDefault();
                                        void sendMessage();
                                    }
                                }}
                                autosize
                                minRows={1}
                                maxRows={8}
                                disabled={sending || readOnly}
                                rightSection={
                                    <ActionIcon
                                        size="sm"
                                        variant="filled"
                                        onClick={() => void sendMessage()}
                                        disabled={!input.trim() || sending || readOnly}
                                    >
                                        <IconSend size={14} />
                                    </ActionIcon>
                                }
                            />
                            <Group justify="space-between" mt={6}>
                                <Text size="10px" c="dimmed">Enter to send · Shift+Enter for a new line</Text>
                                <UnstyledButton onClick={() => setOverrideOpen((value) => !value)}>
                                    <Group gap={3}>
                                        <Text size="10px" c="dimmed">Context override</Text>
                                        {overrideOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                                    </Group>
                                </UnstyledButton>
                            </Group>
                            <Collapse in={overrideOpen}>
                                <Box mt="xs">
                                    <Text size="10px" c="dimmed" mb={4}>
                                        Applies to the next message only, merged over the session context.
                                    </Text>
                                    <RuntimeContextEditor value={runtimeContextJson} onChange={setRuntimeContextJson} />
                                </Box>
                            </Collapse>
                        </Box>
                    </div>
                </Paper>

                {/* ── Inspector ──────────────────────────────────────── */}
                <Paper withBorder radius="md" className={classes.inspectorPanel}>
                    <SessionSidePanel
                        sessionId={sessionId}
                        createdAt={sessionCreatedAt}
                        updatedAt={sessionUpdatedAt}
                        agentName={agent.name}
                        agentKey={agent.key}
                        pinnedVersion={pinnedVersion}
                        publishedVersion={agent.publishedVersion ?? null}
                        sessionContext={sessionContext}
                        agentConfig={agent.config}
                        messages={messages}
                        running={sending}
                        onGoToTurn={goToTurn}
                    />
                </Paper>
            </Group>
            <CompareVersionsDrawer
                opened={compareOpen}
                onClose={() => setCompareOpen(false)}
                agentId={agentId}
                publishedVersion={agent?.publishedVersion ?? null}
                versions={versions.map((v) => v.version)}
                initialMessage={[...messages].reverse().find((m) => m.role === 'user')?.content}
            />
        </DetailShell>
    );
}

/** Tokens, latency, cost and which config produced the turn. */
function TurnPills({ message }: { message: ChatMessage }) {
    const parts: string[] = [];
    if (message.latencyMs !== undefined) parts.push(formatDuration(message.latencyMs));
    if (message.usage?.totalTokens !== undefined) {
        const { inputTokens, outputTokens, totalTokens } = message.usage;
        parts.push(
            inputTokens !== undefined && outputTokens !== undefined
                ? `${inputTokens} in / ${outputTokens} out`
                : `${totalTokens} tokens`,
        );
    }
    if (message.usage?.costUsd !== undefined) parts.push(formatCost(message.usage.costUsd));

    return (
        <>
            {message.version !== undefined ? (
                <Badge size="xs" variant="outline" color={message.version ? 'teal' : 'gray'}>
                    {message.version ? `v${message.version}` : 'draft'}
                </Badge>
            ) : null}
            {parts.length > 0 ? <Text size="10px" c="dimmed">{parts.join(' · ')}</Text> : null}
        </>
    );
}

/**
 * A run that ended without a final answer. Says why, and what the text below
 * it is — the agent's progress up to the stop, not its answer.
 */
function StopNotice({ message }: { message: ChatMessage }) {
    if (!message.stopReason) return null;
    const hasText = Boolean(message.content?.trim());
    return (
        <Alert
            variant="light"
            color={message.stopReason === 'limit' ? 'orange' : 'gray'}
            icon={<IconHandStop size={14} />}
            mb="xs"
            p="xs"
        >
            <Text size="xs" fw={600}>
                {STOP_LABELS[message.stopReason]}
                {message.stopDetail ? ` — ${message.stopDetail}` : ''}
            </Text>
            <Text size="xs" c="dimmed">
                {hasText
                    ? 'The text below is how far the agent got before it stopped, not a final answer.'
                    : 'The agent stopped before writing an answer.'}
                {message.stopReason === 'limit' ? ' Raise the limit in Configure → Advanced if this run needs more.' : ''}
            </Text>
        </Alert>
    );
}

function FailedTurn({ message, onRetry }: { message: ChatMessage; onRetry?: () => void }) {
    const hint = failureHint(message.errorType);
    return (
        <Stack gap={6}>
            <Group gap={6}>
                <Badge size="xs" variant="light" color="red" leftSection={<IconAlertTriangle size={10} />}>
                    Run failed
                </Badge>
                {message.errorType ? (
                    <Text size="10px" c="dimmed" ff="monospace">{message.errorType}</Text>
                ) : null}
            </Group>
            <Text size="sm" className={classes.preWrap}>{message.content}</Text>
            {hint ? <Text size="xs" c="dimmed">{hint}</Text> : null}
            {onRetry ? (
                <Group>
                    <Button size="compact-xs" variant="light" leftSection={<IconRefresh size={12} />} onClick={onRetry}>
                        Edit and retry
                    </Button>
                </Group>
            ) : null}
        </Stack>
    );
}

function ReasoningDisclosure({ reasoning, latencyMs }: { reasoning: string; latencyMs?: number }) {
    const [open, setOpen] = useState(false);
    return (
        <Box mb="xs">
            <UnstyledButton onClick={() => setOpen((v) => !v)} className={classes.disclosureButton}>
                <IconBrain size={13} color="var(--mantine-color-violet-6)" />
                <Text size="xs" fw={500} c="violet.6">
                    {latencyMs !== undefined ? `Thought for ${formatDuration(latencyMs)}` : 'Reasoning'}
                </Text>
                {open
                    ? <IconChevronDown size={12} color="var(--mantine-color-violet-6)" />
                    : <IconChevronRight size={12} color="var(--mantine-color-violet-6)" />}
            </UnstyledButton>
            <Collapse in={open}>
                <Text size="xs" c="dimmed" mt={4} pl="xs" className={classes.reasoningBody}>
                    {reasoning}
                </Text>
            </Collapse>
        </Box>
    );
}

/**
 * The tool calls a turn made, in order.
 *
 * Collapsed, because by the time a turn is in the transcript the calls have
 * already been watched live (LiveToolCalls) and the answer is what the reader
 * came back for. The summary line keeps them one click away, and a failure
 * colours it red so a turn that went wrong still announces itself.
 */
function StepTimeline({ steps }: { steps: PlaygroundStep[] }) {
    const [open, setOpen] = useState(false);
    const failed = steps.filter((step) => step.error).length;

    return (
        <Box mb="sm">
            <Button
                size="compact-xs"
                variant="subtle"
                color={failed > 0 ? 'red' : 'gray'}
                leftSection={<IconTimeline size={12} />}
                rightSection={open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                onClick={() => setOpen((value) => !value)}
            >
                {steps.length} tool call{steps.length === 1 ? '' : 's'}
                {failed > 0 ? ` · ${failed} failed` : ''}
            </Button>
            <Collapse in={open}>
                <Stack gap={6} mt="xs">
                    {steps.map((step, index) => (
                        <StepCard key={step.id ?? index} step={step} index={index} />
                    ))}
                </Stack>
            </Collapse>
        </Box>
    );
}

/** One tool call: what was asked, what came back, and how the run treated it. */
function StepCard({ step, index }: { step: PlaygroundStep; index: number }) {
    const failed = Boolean(step.error) || step.status === 'error' || step.status === 'rejected';

    return (
        <Paper withBorder p="xs" radius="sm">
            <Group gap="xs" mb={6} wrap="wrap">
                <Badge size="xs" variant="light" color={failed ? 'red' : 'blue'}>{index + 1}</Badge>
                <Text size="xs" fw={600} ff="monospace">{step.name}</Text>
                {step.status && step.status !== 'success' ? (
                    <Badge size="xs" variant="light" color={failed ? 'red' : 'yellow'}>{step.status}</Badge>
                ) : null}
                {step.subagent ? (
                    <Badge size="xs" variant="outline" color="violet">via {step.subagent}</Badge>
                ) : null}
                {step.fromCache ? (
                    <Tooltip label="Served from the response cache — the tool was not actually called" withArrow>
                        <Badge size="xs" variant="outline" color="gray">cached</Badge>
                    </Tooltip>
                ) : null}
                {step.summarized ? (
                    <Tooltip
                        label={step.originalTokenCount
                            ? `The model saw a compaction of this result (originally ~${step.originalTokenCount} tokens)`
                            : 'The model saw a compaction of this result'}
                        withArrow
                    >
                        <Badge size="xs" variant="outline" color="orange">summarized</Badge>
                    </Tooltip>
                ) : null}
                {step.timestamp ? (
                    <Text size="10px" c="dimmed">{new Date(step.timestamp).toLocaleTimeString()}</Text>
                ) : null}
            </Group>

            {step.args !== undefined ? <StepPayload label="args" value={step.args} /> : null}
            {step.error ? (
                <Box mb={4}>
                    <Text size="10px" c="dimmed" tt="uppercase" fw={600}>error</Text>
                    <Text size="xs" c="red" className={classes.preWrap}>{step.error}</Text>
                </Box>
            ) : null}
            {step.output !== undefined ? (
                <StepPayload
                    // Naming matters once the two can differ: with the console's
                    // default retention the model may have read a compaction, and
                    // calling that "result" hid the substitution entirely.
                    label={step.rawOutput !== undefined ? 'what the model saw' : 'result'}
                    value={step.output}
                />
            ) : null}
            {step.rawOutput !== undefined ? (
                <StepPayload label="full tool result" value={step.rawOutput} defaultOpen={false} />
            ) : null}
        </Paper>
    );
}

/**
 * One payload inside a step.
 *
 * Long values open clipped with the rest one click away, rather than being
 * truncated outright: a 50KB tool result pasted into the transcript makes the
 * whole session unreadable, but "… 48000 more characters" with no way to see
 * them made the playground useless for the exact debugging it exists for.
 */
function StepPayload({
    label,
    value,
    defaultOpen = true,
}: {
    label: string;
    value: unknown;
    defaultOpen?: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const [open, setOpen] = useState(defaultOpen);

    const text = useMemo(() => {
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }, [value]);

    const clipped = text.length > PAYLOAD_CLIP_CHARS && !expanded;
    const shown = clipped ? text.slice(0, PAYLOAD_CLIP_CHARS) : text;

    return (
        <Box mb={6}>
            <Group gap={6} mb={2}>
                <UnstyledButton onClick={() => setOpen((value) => !value)}>
                    <Group gap={3}>
                        {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                        <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
                    </Group>
                </UnstyledButton>
                <Text size="10px" c="dimmed">{text.length.toLocaleString()} chars</Text>
                <CopyButton value={text}>
                    {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                            <ActionIcon size={14} variant="subtle" color="gray" onClick={copy}>
                                {copied ? <IconCheck size={10} /> : <IconCopy size={10} />}
                            </ActionIcon>
                        </Tooltip>
                    )}
                </CopyButton>
            </Group>
            <Collapse in={open}>
                <Code block className={classes.payloadCode}>
                    {shown}
                    {clipped ? `\n… ${(text.length - PAYLOAD_CLIP_CHARS).toLocaleString()} more characters` : ''}
                </Code>
                {text.length > PAYLOAD_CLIP_CHARS ? (
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        mt={2}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? 'Collapse' : 'Show the whole payload'}
                    </Button>
                ) : null}
            </Collapse>
        </Box>
    );
}

function StructuredOutputBlock({ output }: { output: unknown }) {
    return (
        <Box mt="xs">
            <Text size="10px" c="dimmed" tt="uppercase" fw={600}>structured output</Text>
            <Code block className={classes.outputCode}>{JSON.stringify(output, null, 2)}</Code>
        </Box>
    );
}
