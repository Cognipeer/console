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
 * History and debug detail (tool steps, token usage, structured output,
 * which config version answered) persist server-side — see
 * `agentService.ts#persistSessionTurn` — so reopening a session shows what
 * actually happened, not just the last answer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    ActionIcon,
    Alert,
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
    TextInput,
    ThemeIcon,
    UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconArrowLeft,
    IconBrain,
    IconChevronDown,
    IconChevronRight,
    IconRobot,
    IconSend,
    IconTimeline,
    IconTrash,
} from '@tabler/icons-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import LoadingState from '@/components/common/LoadingState';
import EmptyState from '@/components/common/EmptyState';
import RuntimeContextEditor, { parseRuntimeContextJson } from '@/components/common/RuntimeContextEditor';
import classes from './AgentSessionView.module.css';

interface PlaygroundStep {
    id?: string;
    name: string;
    args?: unknown;
    output?: unknown;
    error?: string;
    subagent?: string;
}

interface ChatMessage {
    role: string;
    content: string;
    reasoning?: string;
    steps?: PlaygroundStep[];
    output?: unknown;
    outputError?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    version?: number | null;
    latencyMs?: number;
    timestamp?: string;
}

interface AgentSummary {
    key: string;
    name: string;
    description?: string;
    publishedVersion?: number | null;
    config?: { kind?: 'native' | 'external' };
}

interface VersionOption {
    version: number;
}

export interface AgentSessionViewProps {
    agentId: string;
    sessionId: string;
}

export default function AgentSessionView({ agentId, sessionId }: AgentSessionViewProps) {
    const router = useRouter();
    const [agent, setAgent] = useState<AgentSummary | null>(null);
    const [sessionTitle, setSessionTitle] = useState<string>('');
    const [versions, setVersions] = useState<VersionOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [runtimeContextJson, setRuntimeContextJson] = useState('');
    const [pinnedVersion, setPinnedVersion] = useState('');
    const [deleting, setDeleting] = useState(false);
    const viewportRef = useRef<HTMLDivElement>(null);

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
            setMessages(
                (sessionData.session.messages ?? []).map((m: ChatMessage) => ({
                    ...m,
                    // A resumed turn's version badge should read "which config
                    // answered", which the record already carries — nothing to
                    // recompute here.
                })),
            );

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
                    latencyMs: Date.now() - startedAt,
                },
            ]);
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
            <PageHeader
                eyebrow={
                    <Button
                        component="a"
                        href={`/dashboard/agents/${agentId}?tab=sessions`}
                        variant="subtle"
                        size="compact-xs"
                        leftSection={<IconArrowLeft size={12} />}
                        px={0}
                    >
                        {agent.name}
                    </Button>
                }
                title={sessionTitle || 'Session'}
                subtitle={agent.description}
                actions={
                    <Button
                        size="xs"
                        variant="light"
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        loading={deleting}
                        onClick={() => void deleteSession()}
                    >
                        Delete session
                    </Button>
                }
            />

            <Paper withBorder radius="md" className={classes.chatPanel}>
                <Group p="sm" justify="space-between" className={classes.panelHeader}>
                    <Group gap="xs">
                        <Text size="sm" fw={600}>Conversation</Text>
                        {messages.length > 0 ? (
                            <Badge size="xs" variant="light" color="gray">{messages.length} messages</Badge>
                        ) : null}
                    </Group>
                    {!isConnected ? (
                        <Select
                            size="xs"
                            w={190}
                            data={[
                                { value: '', label: 'Draft (unsaved config)' },
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
                </Group>

                <div className={classes.panelBody}>
                    {messages.length === 0 && !sending ? (
                        <Center className={classes.chatEmpty}>
                            <Stack align="center" gap="sm">
                                <ThemeIcon size={48} radius="xl" variant="light" color="gray">
                                    <IconRobot size={24} />
                                </ThemeIcon>
                                <Text fw={600}>{agent.name}</Text>
                                <Text size="sm" c="dimmed" ta="center" maw={300}>
                                    {agent.description || 'Send a message to start this session.'}
                                </Text>
                            </Stack>
                        </Center>
                    ) : (
                        <ScrollArea className={classes.chatScroll} viewportRef={viewportRef} p="md">
                            <Stack gap="md">
                                {messages.map((msg, i) => (
                                    <Group key={i} justify={msg.role === 'user' ? 'flex-end' : 'flex-start'} align="flex-start">
                                        <Paper
                                            p="sm"
                                            radius="md"
                                            withBorder={msg.role === 'assistant'}
                                            className={`${classes.chatBubble} ${msg.role === 'user' ? classes.chatBubbleUser : ''}`}
                                        >
                                            {msg.role === 'assistant' ? (
                                                <Box className={classes.chatMarkdown}>
                                                    {msg.reasoning ? <ReasoningDisclosure reasoning={msg.reasoning} /> : null}
                                                    {msg.steps?.length ? <StepTimeline steps={msg.steps} /> : null}
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                                    {msg.output !== undefined ? <StructuredOutputBlock output={msg.output} /> : null}
                                                    {msg.outputError ? (
                                                        <Alert variant="light" color="red" icon={<IconAlertTriangle size={14} />} mt="xs" p="xs">
                                                            <Text size="xs">The answer did not match the output schema: {msg.outputError}</Text>
                                                        </Alert>
                                                    ) : null}
                                                    <TurnFooter message={msg} />
                                                </Box>
                                            ) : (
                                                <Text size="sm" className={classes.preWrap}>{msg.content}</Text>
                                            )}
                                        </Paper>
                                    </Group>
                                ))}
                                {sending && (
                                    <Group justify="flex-start">
                                        <Paper p="sm" radius="md" withBorder><Loader size="xs" /></Paper>
                                    </Group>
                                )}
                            </Stack>
                        </ScrollArea>
                    )}

                    <Group p="sm" gap="sm" className={classes.chatInputRow}>
                        <TextInput
                            placeholder="Type a message…"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    void sendMessage();
                                }
                            }}
                            className={classes.flexGrow}
                            disabled={sending}
                            rightSection={
                                <ActionIcon size="sm" variant="filled" onClick={() => void sendMessage()} disabled={!input.trim() || sending}>
                                    <IconSend size={14} />
                                </ActionIcon>
                            }
                        />
                    </Group>

                    <Box px="sm" pb="sm">
                        <RuntimeContextEditor value={runtimeContextJson} onChange={setRuntimeContextJson} />
                    </Box>
                </div>
            </Paper>
        </PageContainer>
    );
}

function ReasoningDisclosure({ reasoning }: { reasoning: string }) {
    const [open, setOpen] = useState(false);
    return (
        <Box mb="xs">
            <UnstyledButton onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <IconBrain size={13} color="var(--mantine-color-violet-6)" />
                <Text size="xs" fw={500} c="violet.6">Reasoning</Text>
                {open ? <IconChevronDown size={12} color="var(--mantine-color-violet-6)" /> : <IconChevronRight size={12} color="var(--mantine-color-violet-6)" />}
            </UnstyledButton>
            <Collapse in={open}>
                <Text
                    size="xs"
                    c="dimmed"
                    mt={4}
                    pl="xs"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderLeft: '2px solid var(--mantine-color-violet-2)' }}
                >
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
 * 50KB tool result inside a chat bubble makes the whole transcript unusable,
 * and the full value is in the trace.
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
            <Code block style={{ fontSize: 11, maxHeight: 220, overflow: 'auto' }}>
                {clipped ? `${text.slice(0, 1200)}\n… ${text.length - 1200} more characters` : text}
            </Code>
        </Box>
    );
}

function StructuredOutputBlock({ output }: { output: unknown }) {
    return (
        <Box mt="xs">
            <Text size="10px" c="dimmed" tt="uppercase" fw={600}>structured output</Text>
            <Code block style={{ fontSize: 11, maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(output, null, 2)}</Code>
        </Box>
    );
}

/** Tokens, latency and which config produced the turn. */
function TurnFooter({ message }: { message: ChatMessage }) {
    const parts: string[] = [];
    if (message.usage?.totalTokens !== undefined) {
        const { inputTokens, outputTokens, totalTokens } = message.usage;
        parts.push(
            inputTokens !== undefined && outputTokens !== undefined
                ? `${totalTokens} tokens (${inputTokens} in / ${outputTokens} out)`
                : `${totalTokens} tokens`,
        );
    }
    if (message.latencyMs !== undefined) parts.push(`${(message.latencyMs / 1000).toFixed(1)}s`);
    if (parts.length === 0 && message.version === undefined) return null;

    return (
        <Group gap="xs" mt={6}>
            <Badge size="xs" variant="light" color={message.version ? 'teal' : 'gray'}>
                {message.version ? `v${message.version}` : 'draft'}
            </Badge>
            {parts.length > 0 ? <Text size="10px" c="dimmed">{parts.join(' · ')}</Text> : null}
        </Group>
    );
}
