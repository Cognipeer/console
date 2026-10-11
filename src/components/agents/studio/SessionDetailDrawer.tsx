'use client';

/**
 * A session, read — not resumed.
 *
 * Clicking a session used to drop you straight into the chat, which is the
 * wrong default for most of what the list holds: API, A2A and scheduled runs
 * are real traffic you want to inspect, not continue. So a click opens the
 * same request inspector Model Hub uses for a log (`LlmRequestDetailModal`):
 * the conversation as one ordered stream — each tool call grouped with its
 * result — beside a Properties rail. Only a session a person started from the
 * console to try the agent offers Continue.
 *
 * A session that is waiting for a person shows its approval / question cards
 * here too, answerable like on the session page, and every session offers its
 * event log (what was asked, answered and why each run ended).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Box, Button, Code, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconChevronRight, IconHandStop, IconPlayerPlay } from '@tabler/icons-react';
import LlmRequestDetailModal, {
    type LlmRequestDetailData,
    type LlmRequestItem,
} from '@/components/common/llm/LlmRequestDetail';
import FunctionsList from '@/components/common/ui/FunctionsList';
import TokenStats from '@/components/common/ui/TokenStats';
import { type PropertyRow } from '@/components/common/ui/PropertiesPanel';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { useTranslations } from '@/lib/i18n';
import PendingActionList from '../session/PendingActionCards';
import SessionActivity from '../session/SessionActivity';
import SessionStatusBadge from '../session/SessionStatusBadge';
import { answerBlockedReason, isStaleActionRefusal, openActionsOf, type ResolveBody, type ServerPendingAction } from '../session/pendingActions';
import { sessionStatusKind, stopReasonBadge } from '../session/sessionActivityUi';
import { formatCost } from '../session/sessionUsage';
import { stepFailed, type ChatMessage, type SessionRecord } from '../session/sessionTypes';
import { sessionFilesUrl, toAttachmentViews, type SessionFileItem } from '../session/sessionFilesUi';
import { isContinuableSession, SessionSourceBadge, sessionSourceLabel, type SessionListItem } from './SessionList';

export interface SessionDetailDrawerProps {
    agentId: string;
    /** The row that was clicked; null closes the inspector. */
    session: SessionListItem | null;
    onClose: () => void;
    onContinue: (sessionId: string) => void;
    /** A request was answered here, so the session list behind the drawer is out of date. */
    onResolved?: () => void;
}

/** What links a message's files to the session's content route, and which of them are gone. */
export interface TranscriptFiles {
    agentId: string;
    sessionId: string;
    /** The files the server lists for the session; null = not listed (yet), so none is called expired. */
    files: ReadonlyArray<Pick<SessionFileItem, 'id' | 'expiresAt'>> | null;
}

/**
 * The stored transcript as the inspector's ordered stream: a divider per turn,
 * the user message with the files it carried, the turn's tool calls (call +
 * result grouped by step id), then the answer.
 */
export function toItems(messages: ChatMessage[], transcriptFiles?: TranscriptFiles): LlmRequestItem[] {
    const items: LlmRequestItem[] = [];
    let turn = 0;
    messages.forEach((message, index) => {
        if (message.role === 'user') {
            turn += 1;
            const at = message.timestamp;
            items.push({
                itemType: 'divider',
                label: `Turn ${turn}${at ? ` · ${new Date(at).toLocaleTimeString()}` : ''}`,
            });
            const attachments = transcriptFiles && message.attachments?.length
                ? toAttachmentViews(message.attachments, transcriptFiles)
                : undefined;
            items.push({ itemType: 'message', role: 'user', content: message.content, ...(attachments ? { attachments } : {}) });
            return;
        }
        (message.steps ?? []).forEach((step, stepIndex) => {
            const turnId = step.id ?? `${index}-${stepIndex}`;
            items.push({ itemType: 'call', turnId, name: step.name, args: step.args });
            items.push({
                itemType: 'result',
                turnId,
                name: step.name,
                content: step.error ? { error: step.error } : (step.rawOutput ?? step.output),
            });
        });
        items.push({ itemType: 'message', role: message.role, content: message.content });
    });
    return items;
}

export default function SessionDetailDrawer({ agentId, session, onClose, onContinue, onResolved }: SessionDetailDrawerProps) {
    const th = useTranslations('agents.hitl');
    const ta = useTranslations('agents.activity');
    const [record, setRecord] = useState<SessionRecord | null>(null);
    // What the server says the viewer may do with the open requests (its own rule, not guessed from the agent's setting).
    const [serverActions, setServerActions] = useState<ServerPendingAction[]>([]);
    // The session's files as the server lists them: a file a message names that is not in it has expired or been deleted.
    const [files, setFiles] = useState<SessionFileItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Bumped to re-read the session after a request was answered.
    const [reloadKey, setReloadKey] = useState(0);
    const [resolvingId, setResolvingId] = useState<string | null>(null);
    const [activityOpen, setActivityOpen] = useState(false);
    const loadedFor = useRef<string | undefined>(undefined);
    const sessionId = session?._id;

    useEffect(() => {
        if (!sessionId) {
            loadedFor.current = undefined;
            return;
        }
        let cancelled = false;
        // A reload for the same session keeps the transcript on screen.
        if (loadedFor.current !== sessionId) {
            loadedFor.current = sessionId;
            setRecord(null);
            setFiles(null);
            setActivityOpen(false);
        }
        setError(null);
        fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { cache: 'no-store' })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (cancelled) return;
                const loaded = data.session as SessionRecord;
                setRecord(loaded);
                setServerActions(Array.isArray(data.pendingActions) ? (data.pendingActions as ServerPendingAction[]) : []);
                // Which of the files its messages name still exist. Asked only when a message carries any, and
                // beside the transcript, never part of it: a list that cannot be read only means no file is
                // marked expired.
                if (!loaded.messages?.some((message) => message.attachments?.length)) {
                    setFiles(null);
                    return;
                }
                try {
                    const filesRes = await fetch(sessionFilesUrl(agentId, sessionId), { cache: 'no-store' });
                    if (!filesRes.ok) throw new Error(`HTTP ${filesRes.status}`);
                    const filesData = await filesRes.json();
                    if (!cancelled) setFiles(Array.isArray(filesData.files) ? (filesData.files as SessionFileItem[]) : []);
                } catch {
                    if (!cancelled) setFiles(null);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            });
        return () => { cancelled = true; };
    }, [agentId, sessionId, reloadKey]);

    /**
     * Answers an approval or a question. The call runs the continuation and
     * answers in JSON (the live stream belongs to the session page); the session
     * is then read again so what it did next shows here.
     */
    const resolveAction = useCallback(async (actionId: string, body: ResolveBody) => {
        if (!sessionId || resolvingId) return;
        setResolvingId(actionId);
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/actions/${actionId}/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                // Answered elsewhere, or timed out while the drawer was open: show how it ended.
                if (isStaleActionRefusal(res.status, err)) {
                    notifications.show({ title: th('resolveFailed'), message: th('resolveStateChanged'), color: 'orange' });
                    setReloadKey((key) => key + 1);
                    onResolved?.();
                    return;
                }
                throw new Error(err.error || `${th('resolveFailed')} (HTTP ${res.status})`);
            }
            setReloadKey((key) => key + 1);
            onResolved?.();
        } catch (err) {
            notifications.show({
                title: th('resolveFailed'),
                message: err instanceof Error ? err.message : String(err),
                color: 'red',
            });
        } finally {
            setResolvingId(null);
        }
    }, [agentId, sessionId, resolvingId, th, onResolved]);

    const data = useMemo<LlmRequestDetailData | null>(() => {
        if (!session) return null;
        const messages = record?.messages ?? [];
        const continuable = isContinuableSession(session.source);
        const steps = messages.flatMap((m) => m.steps ?? []);
        const toolNames = [...new Set(steps.map((step) => step.name))];
        const failedSteps = steps.filter(stepFailed).length;
        const openActions = openActionsOf(messages);
        const status = sessionStatusKind({
            live: false,
            openActions: openActions.length,
            runtimeStatus: record?.runtimeStatus ?? session.runtimeStatus,
        });
        // A settled session says how its last run ended; a waiting or paused one is already saying more.
        const stopBadge = status === 'idle' ? stopReasonBadge(record?.stopReason) : null;
        const blocked = answerBlockedReason(serverActions.filter((action) => openActions.some((open) => open.id === action.id)));

        const properties: PropertyRow[] = [
            { key: 'created', label: 'Created', value: <Text size="sm">{session.createdAt ? new Date(session.createdAt).toLocaleString() : '—'}</Text> },
            { key: 'updated', label: 'Last activity', value: <Text size="sm">{formatRelativeTime(session.updatedAt ?? session.createdAt)}</Text> },
            { key: 'id', label: 'Session ID', value: <Code style={{ fontSize: 11, wordBreak: 'break-all' }}>{session._id}</Code> },
            { key: 'source', label: 'Source', value: <Text size="sm">{sessionSourceLabel(session.source)}</Text> },
            { key: 'turns', label: 'Turns', value: <Text size="sm">{session.turns ?? 0} · {session.messageCount ?? 0} messages</Text> },
            {
                key: 'tokens',
                label: 'Tokens',
                value: <TokenStats total={session.totalTokens} input={session.inputTokens} output={session.outputTokens} />,
            },
            {
                key: 'cost',
                label: 'Cost',
                value: <Text size="sm">{session.costUsd ? formatCost(session.costUsd) : '—'}{session.costUsd && session.costComplete === false ? ' +' : ''}</Text>,
            },
            {
                key: 'active',
                label: 'Active time',
                value: <Text size="sm">{session.activeMs ? formatDuration(session.activeMs) : '—'}</Text>,
            },
            { key: 'functions', label: 'Tools used', value: <FunctionsList names={toolNames} emptyLabel="No tool calls" /> },
            {
                key: 'context',
                label: 'Session context',
                value: session.hasContext ? <Badge size="xs" variant="light">set</Badge> : <Text size="sm" c="dimmed">none</Text>,
            },
        ];

        const badges = (
            <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="wrap">
                    <SessionStatusBadge status={status} size="xs" />
                    {stopBadge ? <Badge size="xs" variant="light" color={stopBadge.color}>{ta(stopBadge.key)}</Badge> : null}
                    <SessionSourceBadge source={session.source} />
                    <span className="ds-badge ds-badge-info">{session.turns ?? 0} turn{session.turns === 1 ? '' : 's'}</span>
                    {session.activeMs ? <span className="ds-badge">{formatDuration(session.activeMs)}</span> : null}
                    {toolNames.length > 0 ? <span className="ds-badge">{toolNames.length} tools</span> : null}
                    {failedSteps > 0 ? <span className="ds-badge ds-badge-err">{failedSteps} failed calls</span> : null}
                </Group>
                {continuable ? (
                    <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={() => onContinue(session._id)}>
                        Continue
                    </Button>
                ) : null}
            </Group>
        );

        const notices = error ? (
            <Alert color="red" variant="light">Could not load the transcript: {error}</Alert>
        ) : !continuable ? (
            <Alert color="gray" variant="light" p="xs">
                <Text size="xs">
                    Read-only — this session came in via {sessionSourceLabel(session.source)}. Only sessions started
                    from the console can be continued here.
                </Text>
            </Alert>
        ) : null;

        const banner = (
            <Stack gap="xs">
                {notices}
                {openActions.length > 0 ? (
                    <Alert color="orange" variant="light" icon={<IconHandStop size={16} />} title={th('waitingBadge')}>
                        <Text size="xs">{th('waitingTooltip')}</Text>
                        <PendingActionList
                            actions={openActions}
                            busy={Boolean(resolvingId)}
                            resolvingId={resolvingId}
                            onResolve={(actionId, body) => void resolveAction(actionId, body)}
                            blocked={blocked}
                        />
                    </Alert>
                ) : null}
                <Box>
                    <UnstyledButton onClick={() => setActivityOpen((open) => !open)} aria-expanded={activityOpen}>
                        <Group gap={4}>
                            {activityOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                            <Text size="xs" fw={600}>{ta('title')}</Text>
                        </Group>
                    </UnstyledButton>
                    <Collapse in={activityOpen}>
                        <Box mt="xs" maw={760}>
                            <SessionActivity
                                key={session._id}
                                agentId={agentId}
                                sessionId={session._id}
                                active={activityOpen}
                                refreshKey={`${record?.lastEventSeq ?? 0}:${record?.runtimeStatus ?? ''}:${reloadKey}`}
                            />
                        </Box>
                    </Collapse>
                </Box>
            </Stack>
        );

        return {
            badges,
            banner,
            items: record ? toItems(messages, { agentId, sessionId: session._id, files }) : [],
            properties,
            ...(record ? { raw: { request: record.metadata ?? {}, response: messages } } : {}),
        };
    }, [session, record, files, error, onContinue, agentId, serverActions, th, ta, resolvingId, resolveAction, activityOpen, reloadKey]);

    return (
        <LlmRequestDetailModal
            opened={Boolean(session)}
            onClose={onClose}
            title={session?.title || 'New session'}
            data={data}
            labels={{
                request: 'Session metadata',
                response: 'Transcript',
                noItems: record ? 'No messages in this session yet.' : 'Loading…',
            }}
        />
    );
}
