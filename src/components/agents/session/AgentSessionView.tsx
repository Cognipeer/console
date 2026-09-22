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
    Anchor,
    Badge,
    Box,
    Button,
    Center,
    Code,
    Collapse,
    Group,
    Loader,
    Paper,
    ScrollArea,
    Select,
    Stack,
    Text,
    Textarea,
    TextInput,
    ThemeIcon,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconBrain,
    IconChevronDown,
    IconChevronRight,
    IconClock,
    IconCoin,
    IconRobot,
    IconSearch,
    IconSend,
    IconTimeline,
    IconTrash,
    IconUser,
    IconZoomIn,
    IconZoomOut,
} from '@tabler/icons-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import PageContainer from '@/components/common/ui/PageContainer';
import LoadingState from '@/components/common/LoadingState';
import EmptyState from '@/components/common/EmptyState';
import RuntimeContextEditor, { parseRuntimeContextJson } from '@/components/common/RuntimeContextEditor';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import SessionSidePanel from './SessionSidePanel';
import type { ChatMessage, PlaygroundStep } from './sessionTypes';
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
    };
}

interface VersionOption {
    version: number;
}

export interface AgentSessionViewProps {
    agentId: string;
    sessionId: string;
}

/** Timeline zoom steps, in pixels-per-second of turn latency. */
const ZOOM_LEVELS = [2, 6, 18, 54];
const DEFAULT_ZOOM = 1;

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
    const [search, setSearch] = useState('');
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [overrideOpen, setOverrideOpen] = useState(false);
    const [runtimeContextJson, setRuntimeContextJson] = useState('');
    const [pinnedVersion, setPinnedVersion] = useState(searchParams.get('version') ?? '');
    const [deleting, setDeleting] = useState(false);

    const viewportRef = useRef<HTMLDivElement>(null);
    const turnRefs = useRef<Array<HTMLDivElement | null>>([]);

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
                .filter(({ message }) => message.role === 'assistant'),
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

    const sendMessage = async () => {
        if (!input.trim() || sending) return;
        const message = input.trim();
        const startedAt = Date.now();
        setSending(true);
        setInput('');

        const optimistic: ChatMessage[] = [...messages, { role: 'user', content: message }];
        setMessages(optimistic);

        try {
            const res = await fetch(`/api/agents/${agentId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    conversationId: sessionId,
                    runtime_context: parseRuntimeContextJson(runtimeContextJson),
                    ...(pinnedVersion ? { version: Number(pinnedVersion) } : {}),
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Chat failed');
            }
            const data = await res.json();
            setMessages([
                ...optimistic,
                {
                    role: 'assistant',
                    content: data.content,
                    ...(typeof data.reasoning === 'string' && data.reasoning ? { reasoning: data.reasoning } : {}),
                    ...(Array.isArray(data.steps) && data.steps.length > 0 ? { steps: data.steps } : {}),
                    ...(data.output !== undefined ? { output: data.output } : {}),
                    ...(data.outputError ? { outputError: String(data.outputError) } : {}),
                    ...(data.usage ? { usage: data.usage } : {}),
                    version: data.version ?? null,
                    // The server times the invoke itself; the round trip is the
                    // fallback for an older response that carries no latency.
                    latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : Date.now() - startedAt,
                },
            ]);
            setSessionUpdatedAt(new Date().toISOString());
        } catch (err) {
            notifications.show({
                title: 'Message failed',
                message: err instanceof Error ? err.message : 'Unknown error',
                color: 'red',
            });
            setMessages(messages);
        } finally {
            setSending(false);
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
        <PageContainer>
            {/* ── Breadcrumb ─────────────────────────────────────────── */}
            <Group gap={6} mb={4}>
                <Anchor href={`/dashboard/agents/${agentId}`} size="xs" c="dimmed">{agent.name}</Anchor>
                <Text size="xs" c="dimmed">/</Text>
                <Anchor href={`/dashboard/agents/${agentId}?tab=sessions`} size="xs" c="dimmed">Sessions</Anchor>
                <Text size="xs" c="dimmed">/</Text>
                <Text size="xs" c="dimmed" ff="monospace">{sessionId}</Text>
            </Group>

            {/* ── Title + at-a-glance pills ──────────────────────────── */}
            <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
                <Box className={classes.titleBlock}>
                    <Group gap="sm" align="center" wrap="wrap">
                        <Text fw={700} fz="xl">{sessionTitle || 'Session'}</Text>
                        <Badge size="sm" variant="light" color={sending ? 'blue' : 'gray'}>
                            {sending ? 'Running' : 'Idle'}
                        </Badge>
                        <Badge size="sm" variant="outline" color="gray" leftSection={<IconRobot size={11} />}>
                            {agent.name}
                        </Badge>
                        <Badge size="sm" variant="light" color={pinnedVersion ? 'teal' : 'gray'}>
                            {pinnedVersion ? `v${pinnedVersion}` : 'draft'}
                        </Badge>
                        {totals.activeMs > 0 ? (
                            <Tooltip label="Time the agent spent working, summed over turns" withArrow>
                                <Badge size="sm" variant="transparent" c="dimmed" leftSection={<IconClock size={11} />}>
                                    {formatDuration(totals.activeMs)}
                                </Badge>
                            </Tooltip>
                        ) : null}
                        {totals.totalTokens > 0 ? (
                            <Tooltip
                                label={`${totals.inputTokens} input · ${totals.outputTokens} output`}
                                withArrow
                            >
                                <Badge size="sm" variant="transparent" c="dimmed">
                                    {formatCompactTokens(totals.inputTokens)}/{formatCompactTokens(totals.outputTokens)} tokens
                                </Badge>
                            </Tooltip>
                        ) : null}
                        {totals.costUsd > 0 ? (
                            <Badge size="sm" variant="transparent" c="dimmed" leftSection={<IconCoin size={11} />}>
                                {formatCost(totals.costUsd)}
                            </Badge>
                        ) : null}
                        {sessionUpdatedAt ? (
                            <Text size="xs" c="dimmed">{formatRelativeTime(sessionUpdatedAt)}</Text>
                        ) : null}
                    </Group>
                    {agent.description ? (
                        <Text size="xs" c="dimmed" mt={2}>{agent.description}</Text>
                    ) : null}
                </Box>
                <Group gap="xs" wrap="nowrap">
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
                </Group>
            </Group>

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
                                    const failed = message.steps?.some((step) => step.error);
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
                                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                                        {msg.output !== undefined ? <StructuredOutputBlock output={msg.output} /> : null}
                                                        {msg.outputError ? (
                                                            <Alert variant="light" color="red" icon={<IconAlertTriangle size={14} />} mt="xs" p="xs">
                                                                <Text size="xs">The answer did not match the output schema: {msg.outputError}</Text>
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
                                        <Group gap="xs">
                                            <Loader size="xs" />
                                            <Text size="xs" c="dimmed">The agent is working…</Text>
                                        </Group>
                                    ) : null}
                                </Stack>
                            </ScrollArea>
                        )}

                        <Box p="sm" className={classes.composer}>
                            <Textarea
                                placeholder="Send a message to the agent"
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
                                disabled={sending}
                                rightSection={
                                    <ActionIcon
                                        size="sm"
                                        variant="filled"
                                        onClick={() => void sendMessage()}
                                        disabled={!input.trim() || sending}
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
        </PageContainer>
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
 * The tool calls a turn made, in order. Collapsed by default and expanded per
 * step: a run with twelve tool calls is common, and twelve open JSON payloads
 * would bury the answer they produced.
 */
function StepTimeline({ steps }: { steps: PlaygroundStep[] }) {
    const [open, setOpen] = useState(false);
    const failed = steps.filter((step) => step.error).length;

    return (
        <Box mb="xs">
            <Button
                size="compact-xs"
                variant="subtle"
                color={failed > 0 ? 'red' : 'gray'}
                leftSection={<IconTimeline size={12} />}
                onClick={() => setOpen((value) => !value)}
            >
                {steps.length} tool call{steps.length === 1 ? '' : 's'}
                {failed > 0 ? ` · ${failed} failed` : ''}
            </Button>
            <Collapse in={open}>
                <Stack gap={6} mt="xs">
                    {steps.map((step, index) => (
                        <Paper key={step.id ?? index} withBorder p="xs" radius="sm">
                            <Group gap="xs" mb={4}>
                                <Badge size="xs" variant="light" color={step.error ? 'red' : 'blue'}>{index + 1}</Badge>
                                <Text size="xs" fw={600} ff="monospace">{step.name}</Text>
                                {step.subagent ? <Badge size="xs" variant="outline" color="violet">via {step.subagent}</Badge> : null}
                            </Group>
                            {step.args !== undefined ? <StepPayload label="args" value={step.args} /> : null}
                            {step.error ? (
                                <Text size="xs" c="red" className={classes.preWrap}>{step.error}</Text>
                            ) : step.output !== undefined ? (
                                <StepPayload label="result" value={step.output} />
                            ) : null}
                        </Paper>
                    ))}
                </Stack>
            </Collapse>
        </Box>
    );
}

/**
 * One payload inside a step. Long values are clipped rather than scrolled: a
 * 50KB tool result inside a transcript makes the whole session unusable, and
 * the full value is in the trace.
 */
function StepPayload({ label, value }: { label: string; value: unknown }) {
    const text = useMemo(() => {
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }, [value]);
    const clipped = text.length > 1200;

    return (
        <Box mb={4}>
            <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
            <Code block className={classes.payloadCode}>
                {clipped ? `${text.slice(0, 1200)}\n… ${text.length - 1200} more characters` : text}
            </Code>
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
