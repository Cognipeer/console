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
import DetailShell from '@/components/common/ui/DetailShell';
import Markdown from './AgentMarkdown';
import LoadingState from '@/components/common/LoadingState';
import EmptyState from '@/components/common/EmptyState';
import RuntimeContextEditor, { parseRuntimeContextJson } from '@/components/common/RuntimeContextEditor';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { useTranslations } from '@/lib/i18n';
import type { IAgentAttachmentsConfig, IAgentConfig, IAgentHumanInTheLoopConfig, IAgentSessionBudget } from '@/lib/database/provider/types.domain';
import { agentTakesAttachments, resolveAttachmentsConfig } from '@/lib/services/agents/sessionFilesConfig';
import { isContinuableSession, sessionSourceLabel } from '../studio/SessionList';
import CompareVersionsDrawer from '../studio/CompareVersionsDrawer';
import { versionSelectData } from '../studio/StartSessionModal';
import SessionSidePanel from './SessionSidePanel';
import SessionStatusBadge from './SessionStatusBadge';
import StopNotice from './StopNotice';
import TurnTimeline, { DEFAULT_TIMELINE_ZOOM, TIMELINE_ZOOM_LEVELS } from './TurnTimeline';
import LiveToolCalls, {
    appendLiveText, applyLiveToolEvent, isGenerating, type LiveSegment, type LiveToolEvent,
} from './LiveToolCalls';
import { consumeSse } from './consumeSse';
import PendingActionList from './PendingActionCards';
import {
    answerRestriction,
    applyLocalResolution,
    cancelOpenActions,
    composerGate,
    openActionsOf,
    type AnswerRestriction,
    type ResolveBody,
} from './pendingActions';
import { sessionStatusKind } from './sessionActivityUi';
import { useViewer } from './useViewer';
import { interpretSessionEvent } from './sessionFollow';
import ContextCompactionCard from './ContextCompactionCard';
import { BudgetBanner, BudgetMeter } from './SessionBudgetControls';
import { budgetPatchBody, sessionBudgetView } from './sessionBudgetUi';
import { AttachButton, AttachmentChips, MessageAttachments } from './SessionAttachments';
import {
    attachmentIds,
    checkAttachmentCandidate,
    heldFileCount,
    sessionFileUploadUrl,
    uploadContentType,
    type PendingAttachment,
} from './sessionAttachmentsUi';
import { sessionFilesUrl, sessionFileUrl, type SessionFileItem } from './sessionFilesUi';
import { useAgentModelVision } from './agentModelVision';
import type { AgentToolConfig } from './sessionTools';
import {
    stepFailed, type ChatMessage, type PlaygroundStep, type SessionRecord, type TurnCompaction,
} from './sessionTypes';
import { formatCompactTokens, formatCost, summariseSession } from './sessionUsage';
import classes from './AgentSessionView.module.css';

interface AgentSummary {
    key: string;
    name: string;
    description?: string;
    publishedVersion?: number | null;
    config?: AgentToolConfig & { kind?: 'native' | 'external'; modelKey?: string; humanInTheLoop?: IAgentHumanInTheLoopConfig; attachments?: IAgentAttachmentsConfig };
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

/** A failed run, with the server's classification of what failed. */
class TurnFailure extends Error {
    constructor(message: string, readonly type?: string) {
        super(message);
    }
}

/** What an operator can do about each kind of failure. */
const FAILURE_HINTS: Record<string, string> = {
    provider_authentication_error: 'Fix the API key on the model’s provider (Model Hub → Providers), then retry.',
    provider_permission_error: 'The provider account cannot use this model or deployment. Check its access, then retry.',
    agent_config_error: 'The agent’s configuration is broken — open Configure and fix the highlighted field.',
    rate_limit_error: 'The provider is rate limiting. Wait a moment and retry.',
    guardrail_block: 'A guardrail blocked this message.',
};

/**
 * The assistant message a turn's `result` event describes — shared by a normal
 * turn and by the continuation of a paused one, which are the same shape.
 */
function assistantFromResult(data: Record<string, unknown>, startedAt: number): ChatMessage {
    return {
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
        ...(Array.isArray(data.pendingActions) && data.pendingActions.length > 0
            ? { pendingActions: data.pendingActions as ChatMessage['pendingActions'] }
            : {}),
        version: (data.version as number | null) ?? null,
        // The server times the invoke itself; the round trip is the
        // fallback for an older response that carries no latency.
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : Date.now() - startedAt,
    };
}

/** Pause again after a continuation? Then the session is still waiting. */
function runtimeStatusAfter(message: ChatMessage): 'idle' | 'requires_action' {
    return openActionsOf([message]).length > 0 ? 'requires_action' : 'idle';
}

export default function AgentSessionView({ agentId, sessionId }: AgentSessionViewProps) {
    const t = useTranslations('agents.hitl');
    const tb = useTranslations('agents.budget');
    const ta = useTranslations('agents.attachments');
    const router = useRouter();
    const searchParams = useSearchParams();

    const [agent, setAgent] = useState<AgentSummary | null>(null);
    const [session, setSession] = useState<SessionRecord | null>(null);
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
    const source = session?.metadata?.source;
    const sessionSource = typeof source === 'string' ? source : undefined;
    const readOnly = !isContinuableSession(sessionSource);
    const sessionContext = session?.metadata?.runtimeContext as Record<string, unknown> | undefined;
    const [search, setSearch] = useState('');
    const [zoom, setZoom] = useState(DEFAULT_TIMELINE_ZOOM);
    const [overrideOpen, setOverrideOpen] = useState(false);
    const [runtimeContextJson, setRuntimeContextJson] = useState('');
    const [pinnedVersion, setPinnedVersion] = useState(searchParams.get('version') ?? '');
    const [deleting, setDeleting] = useState(false);
    const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
    const generating = isGenerating(liveSegments);
    const [liveCompactions, setLiveCompactions] = useState<TurnCompaction[]>([]);
    // A request (tool approval / question) is being sent, and which one.
    const [resolvingId, setResolvingId] = useState<string | null>(null);
    // Following a turn this page did not start: it shows the same live view as
    // one it ran itself, fed from the session event log instead.
    const [following, setFollowing] = useState(false);
    const [followedUser, setFollowedUser] = useState<string | null>(null);
    const [followDismissed, setFollowDismissed] = useState(false);
    const liveActive = sending || following;
    const openActions = useMemo(() => openActionsOf(messages), [messages]);
    const status = sessionStatusKind({ live: liveActive, openActions: openActions.length, runtimeStatus: session?.runtimeStatus });
    // Said above the open requests when the agent limits who may answer and the viewer is not clearly one of them.
    const viewer = useViewer();
    const restriction = answerRestriction({
        approvers: agent?.config?.humanInTheLoop?.approvers,
        viewerId: viewer.userId,
        viewerRole: viewer.role,
        ownerId: session?.createdBy,
    });
    // The session's spend budget (absent for a session without one), and a change to it in flight.
    const budgetView = useMemo(() => sessionBudgetView(session, messages), [session, messages]);
    const [budgetBusy, setBudgetBusy] = useState(false);
    // Files uploaded to the session and waiting to go with the next message.
    const [attached, setAttached] = useState<PendingAttachment[]>([]);
    const [uploadingNames, setUploadingNames] = useState<string[]>([]);
    // The files the session holds, as the server lists them (null until the first list arrives).
    const [sessionFiles, setSessionFiles] = useState<SessionFileItem[] | null>(null);
    const [sessionFilesFailed, setSessionFilesFailed] = useState(false);
    const [deletingFiles, setDeletingFiles] = useState<string[]>([]);
    const budgetBlocked = Boolean(budgetView?.exhausted);
    // The banner under the transcript that raises the budget or removes it.
    const budgetBannerShown = Boolean(budgetView && (budgetBlocked || session?.runtimeStatus === 'budget_paused') && !readOnly);
    // What the composer does while the agent waits for an approval or an answer.
    const gate = composerGate(openActions.length, agent?.config?.humanInTheLoop?.onUserMessageWhilePending);

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
    const attachmentsConfig = useMemo(() => resolveAttachmentsConfig(agent?.config?.attachments), [agent?.config?.attachments]);
    // The agent has files set up (on, with a bucket); a read-only session cannot add to them.
    const filesConfigured = !isConnected && agentTakesAttachments({ attachments: agent?.config?.attachments } as IAgentConfig);
    const takesAttachments = !readOnly && filesConfigured;

    // A text-only model drops the images a person attaches; say so on the chip. A session pinned to a published
    // version runs that version's model, so the pinned snapshot is asked for it.
    const [pinnedModelKey, setPinnedModelKey] = useState<string | undefined>(undefined);
    useEffect(() => {
        if (!pinnedVersion || isConnected) {
            setPinnedModelKey(undefined);
            return;
        }
        let cancelled = false;
        fetch(`/api/agents/${agentId}/versions?version=${encodeURIComponent(pinnedVersion)}`, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { version?: { snapshot?: { config?: { modelKey?: string } } } } | null) => {
                if (!cancelled) setPinnedModelKey(data?.version?.snapshot?.config?.modelKey);
            })
            .catch(() => { if (!cancelled) setPinnedModelKey(undefined); });
        return () => { cancelled = true; };
    }, [agentId, pinnedVersion, isConnected]);
    const modelVision = useAgentModelVision(pinnedModelKey ?? agent?.config?.modelKey, takesAttachments);
    const textOnlyModel = modelVision && !modelVision.acceptsImages ? { name: modelVision.name, href: modelVision.href } : null;

    /** Re-reads the session's files. A failure keeps the list on screen and only flags it. */
    const loadSessionFiles = useCallback(async () => {
        try {
            const res = await fetch(sessionFilesUrl(agentId, sessionId), { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setSessionFiles(Array.isArray(data.files) ? (data.files as SessionFileItem[]) : []);
            setSessionFilesFailed(false);
        } catch {
            setSessionFilesFailed(true);
        }
    }, [agentId, sessionId]);

    useEffect(() => {
        if (!loading && agent && !isConnected) void loadSessionFiles();
    }, [loading, agent, isConnected, loadSessionFiles]);

    /** Uploads picked files to the session, one by one; each becomes a chip. */
    const uploadFiles = async (files: File[]) => {
        for (const file of files) {
            const refusal = checkAttachmentCandidate(file, attachmentsConfig, heldFileCount(messages, attached, sessionFiles));
            if (refusal) {
                const message = refusal.code === 'too_many_files'
                    ? ta('tooManyFiles', { max: refusal.max })
                    : refusal.code === 'file_too_large'
                        ? ta('fileTooLarge', { name: file.name, max: refusal.max })
                        : ta('typeNotAccepted', { name: file.name });
                notifications.show({ title: ta('uploadFailed', { name: file.name }), message, color: 'orange' });
                continue;
            }
            setUploadingNames((names) => [...names, file.name]);
            try {
                const res = await fetch(sessionFileUploadUrl(agentId, sessionId, file.name), {
                    method: 'POST',
                    headers: { 'Content-Type': uploadContentType(file) },
                    body: file,
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.file) throw new Error(data.error || `HTTP ${res.status}`);
                const stored = data.file as { id: string; name: string; mimeType: string; size: number; conversionStatus?: PendingAttachment['conversionStatus'] };
                setAttached((current) => [...current, {
                    fileId: stored.id,
                    name: stored.name,
                    mimeType: stored.mimeType,
                    size: stored.size,
                    conversionStatus: stored.conversionStatus,
                }]);
                void loadSessionFiles();
            } catch (err) {
                notifications.show({
                    title: ta('uploadFailed', { name: file.name }),
                    message: err instanceof Error ? err.message : String(err),
                    color: 'red',
                });
            } finally {
                setUploadingNames((names) => names.filter((name, index) => index !== names.indexOf(file.name)));
            }
        }
    };

    /** Drops a file waiting to be sent — from the chips and from the session. */
    const removeAttachment = async (fileId: string) => {
        setAttached((current) => current.filter((file) => file.fileId !== fileId));
        await fetch(sessionFileUrl(agentId, sessionId, fileId), { method: 'DELETE' }).catch(() => undefined);
        void loadSessionFiles();
    };

    /** Deletes a file from the Files tab: the object, its text and the record go, and a chip waiting for it too. */
    const deleteSessionFile = async (file: SessionFileItem) => {
        if (!window.confirm(ta('filesDeleteConfirm', { name: file.name }))) return;
        setDeletingFiles((ids) => [...ids, file.id]);
        try {
            const res = await fetch(sessionFileUrl(agentId, sessionId, file.id), { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            setAttached((current) => current.filter((item) => item.fileId !== file.id));
            setSessionFiles((current) => (current ? current.filter((item) => item.id !== file.id) : current));
            notifications.show({ title: ta('filesDeleted', { name: file.name }), message: '', color: 'teal' });
        } catch (err) {
            notifications.show({
                title: ta('filesDeleteFailed', { name: file.name }),
                message: err instanceof Error ? err.message : String(err),
                color: 'red',
            });
        } finally {
            setDeletingFiles((ids) => ids.filter((id) => id !== file.id));
        }
    };

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
            setSession(sessionData.session);
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

    /** Marks the session as no longer running / waiting once a turn's result lands. */
    const settleSession = (message: ChatMessage) => {
        setSession((current) => current && {
            ...current,
            updatedAt: new Date().toISOString(),
            runtimeStatus: runtimeStatusAfter(message),
        });
        // A session with a budget may have stopped on it (`budget_paused`): the
        // server knows, and its status is written before the result is sent.
        if (budgetView) void refreshSessionMeta();
        // The turn may have used, or an expiry removed, files the tab lists.
        if (!isConnected) void loadSessionFiles();
    };

    /**
     * One event of a turn's SSE stream. A normal turn and the continuation of a
     * paused one arrive in the same dialect (`/chat/stream`); `onResult` is the
     * only thing that differs — where the final answer is placed.
     *
     * `action` and `status` events are not handled here: the `result` that
     * closes the stream already carries the pending actions it raised.
     */
    const handleTurnEvent = (onResult: (data: Record<string, unknown>) => void) => (event: string, data: unknown) => {
        if (event === 'tool') {
            setLiveSegments((current) => applyLiveToolEvent(current, data as LiveToolEvent));
        } else if (event === 'text') {
            setLiveSegments((current) => appendLiveText(current, String((data as { text?: string }).text ?? '')));
        } else if (event === 'summary') {
            setLiveCompactions((current) => [...current, data as TurnCompaction]);
        } else if (event === 'result') {
            onResult(data as Record<string, unknown>);
        } else if (event === 'error') {
            const payload = data as { error?: string; type?: string };
            throw new TurnFailure(String(payload.error || 'Chat failed'), payload.type);
        }
    };

    /** Re-reads the session's own fields (status, budget, spend) and leaves the transcript on screen alone. */
    const refreshSessionMeta = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            setSession(data.session);
        } catch {
            // The next turn refreshes it again.
        }
    }, [agentId, sessionId]);

    /** Reloads the stored session without the page-level spinner — for a session that changed under us. */
    const refreshSession = useCallback(async (): Promise<SessionRecord | null> => {
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { cache: 'no-store' });
            if (!res.ok) return null;
            const data = await res.json();
            setSession(data.session);
            setMessages(data.session.messages ?? []);
            return data.session as SessionRecord;
        } catch {
            return null;
        }
    }, [agentId, sessionId]);

    /**
     * Runs a turn over SSE so the tool calls show up as they happen.
     *
     * Falls back to the plain POST when the stream cannot be opened at all
     * (an old server without the route, a proxy that rejects the content
     * type). Losing live progress is a downgrade; losing the ability to send
     * a message is a breakage, and the two should not be the same failure.
     */
    const sendMessage = async () => {
        if ((!input.trim() && attached.length === 0) || uploadingNames.length > 0 || liveActive || readOnly || gate === 'blocked' || budgetBlocked) return;
        const message = input.trim();
        const sentFiles = attached;
        const startedAt = Date.now();
        const previous = messages;
        setSending(true);
        setInput('');
        setAttached([]);
        setLiveSegments([]);
        setLiveCompactions([]);

        // Under `cancel_pending` this message cancels what the agent waits on;
        // the cards show that right away rather than after the round trip.
        const base = gate === 'cancel' ? cancelOpenActions(messages) : messages;
        const optimistic: ChatMessage[] = [
            ...base,
            { role: 'user', content: message, ...(sentFiles.length > 0 ? { attachments: sentFiles.map(({ fileId, name, mimeType, size }) => ({ fileId, name, mimeType, size })) } : {}) },
        ];
        setMessages(optimistic);

        const body = JSON.stringify({
            message,
            conversationId: sessionId,
            ...(sentFiles.length > 0 ? { attachments: attachmentIds(sentFiles) } : {}),
            runtime_context: parseRuntimeContextJson(runtimeContextJson),
            ...(pinnedVersion ? { version: Number(pinnedVersion) } : {}),
        });

        const applyResult = (data: Record<string, unknown>) => {
            const assistant = assistantFromResult(data, startedAt);
            setMessages([...optimistic, assistant]);
            settleSession(assistant);
        };

        // The failure stays in the transcript, under the message that caused
        // it — a toast that vanishes after a few seconds, with the question
        // itself rolled back, read as "nothing happened". Not persisted: the
        // server stored neither the question nor an answer, so a reload shows
        // the session as it really is.
        const fail = (error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            const type = error instanceof TurnFailure ? error.type : undefined;
            if (type === 'pending_action') {
                // Refused because a request is still open (the agent's policy is
                // to reject): nothing was started, so put the page back as it was.
                setMessages(previous);
                setInput(message);
                setAttached(sentFiles);
                notifications.show({ title: t('resolveFailed'), message: text, color: 'orange' });
                return;
            }
            setMessages([
                ...optimistic,
                { role: 'error', content: text, ...(type ? { errorType: type } : {}) },
            ]);
            // The budget ran out under us (another tab, an API call): pick up its state.
            if (type === 'budget_reached') void refreshSessionMeta();
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

            await consumeSse(res.body, handleTurnEvent(applyResult));
        } catch (err) {
            fail(err);
        } finally {
            setSending(false);
            setLiveCompactions([]);
            // Cleared only now: dropping it the moment `result` lands would
            // blank the answer for the frame between the two state updates.
            setLiveSegments([]);
        }
    };

    /**
     * Answers an approval or a question and renders the continuation like any
     * other turn: the resolve call streams the same events as `/chat/stream`
     * (`?stream=1`), and the paused turn picks up where it stopped.
     *
     * The call answers in plain JSON, not a stream, when there is nothing to
     * continue yet (other requests of the same pause are still open) or when it
     * is refused. The card is marked answered only once the server has accepted
     * the answer, so a refusal leaves it open with what was typed.
     */
    const resolveAction = async (actionId: string, body: ResolveBody) => {
        if (liveActive || resolvingId) return;
        const startedAt = Date.now();
        setResolvingId(actionId);
        setSending(true);
        setLiveSegments([]);
        setLiveCompactions([]);

        let accepted = messages;
        let recorded = false;
        const markAccepted = () => {
            recorded = true;
            accepted = applyLocalResolution(accepted, actionId, body);
            setMessages(accepted);
        };

        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/actions/${actionId}/resolve?stream=1`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                body: JSON.stringify(body),
            });
            const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');

            if (!res.ok || !res.body) {
                const err = await res.json().catch(() => ({}));
                // The request was answered elsewhere or timed out while this
                // page was open: show how it really ended instead of a stale card.
                if ((res.status === 409 && (err.type === 'action_not_pending' || err.code === 'action_not_pending'))
                    || res.status === 410) {
                    notifications.show({ title: t('resolveFailed'), message: t('resolveStateChanged'), color: 'orange' });
                    await refreshSession();
                    return;
                }
                throw new TurnFailure(err.error || `${t('resolveFailed')} (HTTP ${res.status})`, err.type);
            }

            if (!isStream) {
                // Answer recorded, nothing to run yet.
                const data = await res.json().catch(() => ({}));
                markAccepted();
                if (data.status === 'resumed' && data.result) {
                    const assistant = assistantFromResult(data.result as Record<string, unknown>, startedAt);
                    setMessages([...accepted, assistant]);
                    settleSession(assistant);
                }
                return;
            }

            markAccepted();
            await consumeSse(res.body, handleTurnEvent((data) => {
                const assistant = assistantFromResult(data, startedAt);
                setMessages([...accepted, assistant]);
                settleSession(assistant);
            }));
        } catch (err) {
            if (!recorded) {
                // Refused (or never reached the server) before anything was recorded:
                // say why and keep the card open.
                const text = err instanceof Error ? err.message : String(err);
                notifications.show({ title: t('resolveFailed'), message: text, color: 'red' });
            } else {
                // The answer was recorded and the continuation then failed: the
                // failure belongs in the transcript, after the answered card.
                const text = err instanceof Error ? err.message : String(err);
                const type = err instanceof TurnFailure ? err.type : undefined;
                setMessages([...accepted, { role: 'error', content: text, ...(type ? { errorType: type } : {}) }]);
            }
        } finally {
            setResolvingId(null);
            setSending(false);
            setLiveCompactions([]);
            setLiveSegments([]);
        }
    };

    /** Adds, changes or removes the session's budget. True once the server has stored it. */
    const patchBudget = async (budget: IAgentSessionBudget | null): Promise<boolean> => {
        setBudgetBusy(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(budget ? budgetPatchBody(budget.maxCostUsd, budget.onReach) : { budget: null }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `${tb('saveFailed')} (HTTP ${res.status})`);
            }
            const data = await res.json();
            // Keep the transcript on screen: only the session's own fields changed.
            setSession((current) => ({ ...(data.session as SessionRecord), messages: current?.messages }));
            return true;
        } catch (err) {
            notifications.show({
                title: tb('saveFailed'),
                message: err instanceof Error ? err.message : String(err),
                color: 'red',
            });
            return false;
        } finally {
            setBudgetBusy(false);
        }
    };

    /**
     * Carries a session that stopped on its budget on from where it stopped —
     * no new user message — and renders the continuation like any other turn
     * (the same SSE dialect as `/chat/stream`).
     */
    const continueBudgetSession = async () => {
        if (liveActive) return;
        const startedAt = Date.now();
        setSending(true);
        setLiveSegments([]);
        setLiveCompactions([]);
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/continue?stream=1`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                body: JSON.stringify({
                    runtime_context: parseRuntimeContextJson(runtimeContextJson),
                    ...(pinnedVersion ? { version: Number(pinnedVersion) } : {}),
                }),
            });
            if (!res.ok || !res.body) {
                const err = await res.json().catch(() => ({}));
                throw new TurnFailure(err.error || `${tb('continueFailed')} (HTTP ${res.status})`, err.type);
            }
            await consumeSse(res.body, handleTurnEvent((data) => {
                const assistant = assistantFromResult(data, startedAt);
                setMessages((current) => [...current, assistant]);
                settleSession(assistant);
            }));
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            const type = err instanceof TurnFailure ? err.type : undefined;
            setMessages((current) => [...current, { role: 'error', content: text, ...(type ? { errorType: type } : {}) }]);
            void refreshSessionMeta();
        } finally {
            setSending(false);
            setLiveCompactions([]);
            setLiveSegments([]);
        }
    };

    /** Banner / meter action: change the budget, then carry on if the session was stopped on it. */
    const changeBudget = async (budget: IAgentSessionBudget | null) => {
        const carryOn = Boolean(budgetView?.continuable);
        if (await patchBudget(budget) && carryOn) await continueBudgetSession();
    };

    // A session opened while a turn is still running (started elsewhere, or
    // before this page was reloaded) is followed from the event log, so the
    // operator sees it live instead of an idle page that suddenly changes.
    const followedStatus = session?.runtimeStatus;
    const followedSeq = session?.lastEventSeq ?? 0;
    useEffect(() => {
        if (loading || sending || followDismissed || followedStatus !== 'running') return undefined;
        const controller = new AbortController();
        let active = true;
        setFollowing(true);
        setFollowedUser(null);
        setLiveSegments([]);
        setLiveCompactions([]);

        const stopped = { current: false };
        void (async () => {
            try {
                const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/events/stream?after=${followedSeq}`, {
                    headers: { Accept: 'text/event-stream' },
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (!res.ok || !res.body) return;
                await consumeSse(res.body, (event, frame) => {
                    if (!active) return;
                    const step = interpretSessionEvent(event, frame);
                    if (step.kind === 'user') setFollowedUser(step.content);
                    else if (step.kind === 'tool') setLiveSegments((current) => applyLiveToolEvent(current, step.event));
                    else if (step.kind === 'text') setLiveSegments((current) => appendLiveText(current, step.text));
                    else if (step.kind === 'compaction') setLiveCompactions((current) => [...current, step.compaction as unknown as TurnCompaction]);
                    else if (step.kind === 'idle' || step.kind === 'error') {
                        stopped.current = true;
                        controller.abort();
                    }
                });
            } catch {
                // Aborted (done, or the page moved on) or the connection dropped:
                // either way the stored session is the source of truth below.
            } finally {
                if (active) {
                    // The turn's persisted result replaces the live view. One
                    // retry covers the gap between the idle event and the write.
                    const fresh = await refreshSession();
                    if (active && fresh?.runtimeStatus === 'running' && stopped.current) {
                        await new Promise((resolve) => { setTimeout(resolve, 1500); });
                        if (active) await refreshSession();
                    }
                    if (active) {
                        setFollowing(false);
                        setFollowedUser(null);
                        setLiveSegments([]);
                        setLiveCompactions([]);
                    }
                }
            }
        })();

        return () => {
            active = false;
            controller.abort();
            setFollowing(false);
            setFollowedUser(null);
            setLiveSegments([]);
            setLiveCompactions([]);
        };
    }, [loading, sending, followDismissed, followedStatus, followedSeq, agentId, sessionId, refreshSession]);

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
                    <span className="detail-title">{session?.title || 'Session'}</span>
                    <SessionStatusBadge status={status} />
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
                    <BudgetMeter
                        view={budgetView}
                        busy={liveActive || budgetBusy}
                        readOnly={readOnly}
                        onSave={(budget) => void changeBudget(budget)}
                        onRemove={() => void changeBudget(null)}
                    />
                    {session?.updatedAt ? (
                        <Text size="xs" c="dimmed">{formatRelativeTime(session.updatedAt)}</Text>
                    ) : null}
                </Group>
            }
            actions={
                <>
                    {!isConnected ? (
                        <Select
                            size="xs"
                            w={180}
                            data={versionSelectData(versions, agent.publishedVersion)}
                            value={pinnedVersion}
                            onChange={(next) => setPinnedVersion(next ?? '')}
                            allowDeselect={false}
                            disabled={liveActive}
                        />
                    ) : null}
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
                    {/*
                      A reopened session lands wherever you left the scroll, and
                      the composer is a page-height away at the bottom. This is
                      the "pick this back up" affordance the sessions table
                      links straight to.
                    */}
                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlayerPlay size={14} />}
                        onClick={continueSession}
                        disabled={liveActive}
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
                                onClick={() => setZoom((value) => Math.min(TIMELINE_ZOOM_LEVELS.length - 1, value + 1))}
                                disabled={zoom === TIMELINE_ZOOM_LEVELS.length - 1}
                            >
                                <IconZoomIn size={14} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>

                    {timeline.length > 0 ? (
                        <TurnTimeline entries={timeline} zoom={zoom} onSelect={goToTurn} />
                    ) : null}

                    <div className={classes.panelBody}>
                        {messages.length === 0 && !liveActive ? (
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
                                        const previous = messages[i - 1];
                                        return (
                                            <Box
                                                key={i}
                                                ref={(node: HTMLDivElement | null) => { turnRefs.current[i] = node; }}
                                                className={msg.role === 'error' ? `${classes.turn} ${classes.errorTurn}` : classes.turn}
                                            >
                                                {msg.role === 'error' ? (
                                                    <FailedTurn
                                                        message={msg}
                                                        onRetry={previous?.role === 'user'
                                                            ? () => {
                                                                setInput(previous.content);
                                                                setAttached((previous.attachments ?? []).map((file) => ({ ...file })));
                                                                setMessages(messages.slice(0, i - 1));
                                                                composerRef.current?.focus();
                                                            }
                                                            : undefined}
                                                    />
                                                ) : (
                                                    <>
                                                        <Group gap={6} mb={4} align="center">
                                                            <RoleBadge user={msg.role === 'user'} agentName={agent.name} />
                                                            {msg.role === 'assistant' ? <TurnPills message={msg} /> : null}
                                                        </Group>
                                                        {msg.role === 'assistant' ? (
                                                            <AssistantTurn
                                                                message={msg}
                                                                busy={liveActive || Boolean(resolvingId)}
                                                                resolvingId={resolvingId}
                                                                onResolve={(actionId, body) => void resolveAction(actionId, body)}
                                                                restriction={restriction}
                                                                budgetBannerShown={budgetBannerShown}
                                                            />
                                                        ) : (
                                                            <>
                                                                <Text size="sm" className={classes.preWrap}>{msg.content}</Text>
                                                                <MessageAttachments attachments={msg.attachments} />
                                                            </>
                                                        )}
                                                    </>
                                                )}
                                            </Box>
                                        );
                                    })}
                                    {matchedIndexes && matchedIndexes.size === 0 ? (
                                        <Text size="sm" c="dimmed" ta="center" py="xl">
                                            No message in this session contains “{search.trim()}”.
                                        </Text>
                                    ) : null}
                                    {following && followedUser ? (
                                        <Box>
                                            <Group gap={6} mb={4}>
                                                <RoleBadge user agentName={agent.name} />
                                            </Group>
                                            <Text size="sm" className={classes.preWrap}>{followedUser}</Text>
                                        </Box>
                                    ) : null}
                                    {liveActive ? (
                                        <Box>
                                            <Group gap={6} mb={4}>
                                                <RoleBadge agentName={agent.name} />
                                                {following ? (
                                                    <>
                                                        <Text size="10px" c="dimmed">{t('following')}</Text>
                                                        <Button
                                                            size="compact-xs"
                                                            variant="subtle"
                                                            color="gray"
                                                            onClick={() => setFollowDismissed(true)}
                                                        >
                                                            {t('stopFollowing')}
                                                        </Button>
                                                    </>
                                                ) : null}
                                            </Group>
                                            {liveCompactions.map((compaction, index) => (
                                                <ContextCompactionCard key={`live-${index}`} compaction={compaction} live />
                                            ))}
                                            {liveSegments.length === 0 ? (
                                                <Group gap="xs">
                                                    <Loader size="xs" />
                                                    <Text size="xs" c="dimmed">The agent is working…</Text>
                                                </Group>
                                            ) : (
                                                <Stack gap="xs">
                                                    {liveSegments.map((segment, index) => (segment.kind === 'tools' ? (
                                                        <LiveToolCalls
                                                            key={`tools-${index}`}
                                                            calls={segment.calls}
                                                            generating={generating && index === liveSegments.length - 1}
                                                        />
                                                    ) : (
                                                        <Box key={`text-${index}`} className={classes.chatMarkdown}>
                                                            <Markdown text={segment.text} />
                                                        </Box>
                                                    )))}
                                                </Stack>
                                            )}
                                        </Box>
                                    ) : null}
                                </Stack>
                            </ScrollArea>
                        )}

                        {budgetView && budgetBannerShown ? (
                            <Box px="sm" pt="sm">
                                <BudgetBanner
                                    view={budgetView}
                                    busy={liveActive || budgetBusy}
                                    onIncrease={(amount) => void changeBudget({ maxCostUsd: amount, onReach: budgetView.budget.onReach })}
                                    onRemove={() => void changeBudget(null)}
                                />
                            </Box>
                        ) : null}

                        <Box p="sm" className={classes.composer}>
                            <AttachmentChips
                                files={attached}
                                uploading={uploadingNames}
                                disabled={liveActive}
                                onRemove={(fileId) => void removeAttachment(fileId)}
                                textOnlyModel={textOnlyModel}
                            />
                            <Textarea
                                ref={composerRef}
                                placeholder={readOnly
                                    ? `Read-only — this session came in via ${sessionSourceLabel(sessionSource)}`
                                    : budgetBlocked
                                        ? tb('composerPlaceholder')
                                        : gate === 'blocked'
                                            ? t('composerBlockedPlaceholder')
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
                                disabled={liveActive || readOnly || gate === 'blocked' || budgetBlocked}
                                leftSection={takesAttachments ? (
                                    <AttachButton
                                        disabled={liveActive || gate === 'blocked' || budgetBlocked}
                                        accept={attachmentsConfig.allowedMimeTypes.join(',')}
                                        onFiles={(files) => void uploadFiles(files)}
                                    />
                                ) : undefined}
                                leftSectionPointerEvents="all"
                                rightSection={
                                    <ActionIcon
                                        size="sm"
                                        variant="filled"
                                        onClick={() => void sendMessage()}
                                        disabled={(!input.trim() && attached.length === 0) || uploadingNames.length > 0 || liveActive || readOnly || gate === 'blocked' || budgetBlocked}
                                    >
                                        <IconSend size={14} />
                                    </ActionIcon>
                                }
                            />
                            {gate !== 'open' && !readOnly ? (
                                <Alert
                                    variant="light"
                                    color={gate === 'blocked' ? 'gray' : 'orange'}
                                    icon={<IconHandStop size={14} />}
                                    mt={6}
                                    p="xs"
                                >
                                    <Text size="xs">{gate === 'blocked' ? t('composerBlocked') : t('composerCancelWarning')}</Text>
                                </Alert>
                            ) : null}
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
                        agentId={agentId}
                        sessionId={sessionId}
                        status={status}
                        stopReason={session?.stopReason}
                        activityKey={`${session?.lastEventSeq ?? 0}:${session?.runtimeStatus ?? ''}:${messages.length}`}
                        createdAt={session?.createdAt}
                        updatedAt={session?.updatedAt}
                        agentName={agent.name}
                        agentKey={agent.key}
                        pinnedVersion={pinnedVersion}
                        publishedVersion={agent.publishedVersion ?? null}
                        sessionContext={sessionContext}
                        agentConfig={agent.config}
                        messages={messages}
                        onGoToTurn={goToTurn}
                        // The tab is for agents with files, and for any session that holds some (an API upload, or files from before the setting was turned off).
                        files={isConnected || !(filesConfigured || (sessionFiles?.length ?? 0) > 0) ? undefined : {
                            items: sessionFiles,
                            failed: sessionFilesFailed,
                            maxFiles: filesConfigured ? attachmentsConfig.maxFiles : undefined,
                            readOnly,
                            deleting: deletingFiles,
                            onDelete: (file) => void deleteSessionFile(file),
                            onRetry: () => void loadSessionFiles(),
                        }}
                    />
                </Paper>
            </Group>
            <CompareVersionsDrawer
                opened={compareOpen}
                onClose={() => setCompareOpen(false)}
                agentId={agentId}
                publishedVersion={agent.publishedVersion ?? null}
                versions={versions.map((v) => v.version)}
                initialMessage={[...messages].reverse().find((m) => m.role === 'user')?.content}
            />
        </DetailShell>
    );
}

function RoleBadge({ user, agentName }: { user?: boolean; agentName: string }) {
    return (
        <Badge
            size="xs"
            variant="light"
            color={user ? 'blue' : 'grape'}
            leftSection={user ? <IconUser size={10} /> : <IconRobot size={10} />}
        >
            {user ? 'You' : agentName}
        </Badge>
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

function FailedTurn({ message, onRetry }: { message: ChatMessage; onRetry?: () => void }) {
    const tb = useTranslations('agents.budget');
    const hint = message.errorType === 'budget_reached'
        ? tb('failedHint')
        : message.errorType ? FAILURE_HINTS[message.errorType] : undefined;
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

function AssistantTurn({
    message,
    busy,
    resolvingId,
    onResolve,
    restriction,
    budgetBannerShown,
}: {
    message: ChatMessage;
    busy: boolean;
    resolvingId: string | null;
    onResolve: (actionId: string, body: ResolveBody) => void;
    restriction: AnswerRestriction | null;
    budgetBannerShown: boolean;
}) {
    return (
        <Box className={classes.chatMarkdown}>
            {message.reasoning ? (
                <ReasoningDisclosure reasoning={message.reasoning} latencyMs={message.latencyMs} />
            ) : null}
            {message.steps?.length ? <NarratedSteps steps={message.steps} /> : null}
            {message.compactions?.map((compaction, index) => (
                <ContextCompactionCard
                    key={`${compaction.at}-${index}`}
                    compaction={compaction}
                    // The tool list is per turn; shown on the last pass so it
                    // is not repeated.
                    compactedTools={index === message.compactions!.length - 1 ? message.compactedTools : undefined}
                />
            ))}
            {/* A pause with cards says what it waits for on the cards themselves. */}
            {message.stopReason && !(message.stopReason === 'paused' && message.pendingActions?.length)
                ? <StopNotice message={message} budgetBannerShown={budgetBannerShown} />
                : null}
            <Markdown text={message.content} />
            {message.pendingActions?.length ? (
                <PendingActionList
                    actions={message.pendingActions}
                    busy={busy}
                    resolvingId={resolvingId}
                    onResolve={onResolve}
                    restriction={restriction}
                />
            ) : null}
            {message.output !== undefined ? <StructuredOutputBlock output={message.output} /> : null}
            {message.outputError ? (
                <Alert variant="light" color="red" icon={<IconAlertTriangle size={14} />} mt="xs" p="xs">
                    <Text size="xs">The answer did not match the output schema: {message.outputError}</Text>
                </Alert>
            ) : null}
            {message.warnings?.length ? (
                <Alert variant="light" color="yellow" icon={<IconInfoCircle size={14} />} mt="xs" p="xs">
                    <Stack gap={2}>
                        <Text size="xs" fw={600}>This answer was produced without everything it should have had:</Text>
                        {message.warnings.map((warning) => (
                            <Text key={warning} size="xs">{warning}</Text>
                        ))}
                    </Stack>
                </Alert>
            ) : null}
        </Box>
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
 * A turn's tool calls with what the model wrote before each batch ("Let me
 * search…"), in the order it happened — the same order the live view showed.
 * A turn with no such text keeps the single collapsed timeline.
 */
function NarratedSteps({ steps }: { steps: PlaygroundStep[] }) {
    if (!steps.some((step) => step.narration)) return <StepTimeline steps={steps} />;
    const groups: Array<{ narration?: string; offset: number; steps: PlaygroundStep[] }> = [];
    steps.forEach((step, index) => {
        const current = groups[groups.length - 1];
        if (!current || step.narration) groups.push({ narration: step.narration, offset: index, steps: [step] });
        else current.steps.push(step);
    });
    return (
        <>
            {groups.map((group) => (
                <Box key={group.offset}>
                    {group.narration ? <Markdown text={group.narration} /> : null}
                    <StepTimeline steps={group.steps} offset={group.offset} />
                </Box>
            ))}
        </>
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
function StepTimeline({ steps, offset = 0 }: { steps: PlaygroundStep[]; offset?: number }) {
    const [open, setOpen] = useState(false);
    const failed = steps.filter(stepFailed).length;

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
                        <StepCard key={step.id ?? index} step={step} index={offset + index} />
                    ))}
                </Stack>
            </Collapse>
        </Box>
    );
}

/** One tool call: what was asked, what came back, and how the run treated it. */
function StepCard({ step, index }: { step: PlaygroundStep; index: number }) {
    const failed = stepFailed(step);

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
