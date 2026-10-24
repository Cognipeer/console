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

import { useTranslations } from '@/lib/i18n';
import { isPendingWake, reminderOfMessage } from '../studio/reminderUi';
import { useSessionReminders } from '../studio/useSessionReminders';
import { useDeleteResource } from '@/components/common/confirm';
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
    IconChevronDown,
    IconChevronRight,
    IconClock,
    IconCoin,
    IconHandStop,
    IconInfoCircle,
    IconMessageCircle,
    IconRefresh,
    IconPlayerPlay,
    IconRobot,
    IconSearch,
    IconPlayerStopFilled,
    IconSend,
    IconTrash,
    IconUser,
    IconZoomIn,
    IconZoomOut,
    IconArrowsLeftRight,
} from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import ConfirmModal from '@/components/common/ui/ConfirmModal';
import Markdown from './AgentMarkdown';
import LoadingState from '@/components/common/LoadingState';
import EmptyState from '@/components/common/EmptyState';
import RuntimeContextEditor, { parseRuntimeContextJson } from '@/components/common/RuntimeContextEditor';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import type { IAgentAttachmentsConfig, IAgentConfig, IAgentHumanInTheLoopConfig, IAgentSessionBudget } from '@/lib/database/provider/types.domain';
import { agentTakesAttachments, resolveAttachmentsConfig } from '@/lib/services/agents/sessionFilesConfig';
import { isContinuableSession, sessionSourceLabel, sessionSourceOf } from '../studio/SessionList';
import { sessionInspectorHref } from './sessionLinks';
import CompareVersionsDrawer from '../studio/CompareVersionsDrawer';
import { versionSelectData } from '../studio/StartSessionModal';
import SessionSidePanel from './SessionSidePanel';
import SessionStatusBadge from './SessionStatusBadge';
import StopNotice from './StopNotice';
import TurnTimeline, { DEFAULT_TIMELINE_ZOOM, TIMELINE_ZOOM_LEVELS } from './TurnTimeline';
import {
    appendLiveReasoning,
    appendLiveText,
    applyLiveCompaction,
    applyLivePlan,
    applyLiveSubagent,
    applyLiveToolEvent,
    type LiveSegment,
    type LiveToolEvent,
} from './liveFlow';
import LiveTurnFlow from './LiveTurnFlow';
import StoredTurnFlow from './StoredTurnFlow';
import { PlanDock } from './PlanCard';
import { currentPlanOf, type SessionPlanRecord } from './planUi';
import { buildTurnFlow, delegationAnchorId, previousPlansOf, showInGroupExpansion } from './turnFlowUi';
import type { AgentCompactionEvent, AgentPlanEvent, AgentSubagentEvent } from '@/lib/shared/agentTurnFlow';
import type { IAgentTurnPlanSnapshot } from '@/lib/database/provider/types.domain';
import ReasoningBlock from './ReasoningBlock';
import { consumeSse } from './consumeSse';
import PendingActionList from './PendingActionCards';
import {
    answerBlockedById,
    answerBlockedReason,
    applyLocalResolution,
    approvalSettingsHref,
    cancelOpenActions,
    composerGateFor,
    isStaleActionRefusal,
    openActionsOf,
    type AnswerBlockedReason,
    type ResolveBody,
    type ServerPendingAction,
} from './pendingActions';
import { assistantFromResult } from './assistantFromResult';
import { sessionStatusKind } from './sessionActivityUi';
import { interpretSessionEvent } from './sessionFollow';
import { BudgetBanner, BudgetMeter } from './SessionBudgetControls';
import { budgetPatchBody, sessionBudgetView, shouldContinueAfterBudgetChange } from './sessionBudgetUi';
import { AttachButton, AttachmentChips, MessageAttachments } from './SessionAttachments';
import MessageFeedbackRow from './MessageFeedbackRow';
import { feedbackForMessage, persistedIndexOf, screenIndexOf, type SessionMessageFeedback } from '../studio/feedbackUi';
import {
    attachmentIds,
    checkAttachmentCandidate,
    heldFileCount,
    removeSessionFile,
    sessionFileUploadUrl,
    uploadContentType,
    type PendingAttachment,
} from './sessionAttachmentsUi';
import { sessionLoadFailure, type SessionLoadFailure } from './sessionLoadFailure';
import { sessionFileLinks, sessionFilesUrl, sessionFileUrl, toAttachmentViews, type SessionFileItem } from './sessionFilesUi';
import { useAgentModelVision } from './agentModelVision';
import type { AgentToolConfig } from './sessionTools';
import { type ChatMessage, type SessionRecord } from './sessionTypes';
import { formatCompactTokens, formatCost, summariseSession } from './sessionUsage';
import classes from './AgentSessionView.module.css';

interface AgentSummary {
    key: string;
    name: string;
    description?: string;
    publishedVersion?: number | null;
    config?: AgentToolConfig & { kind?: 'native' | 'external'; modelKey?: string; humanInTheLoop?: IAgentHumanInTheLoopConfig; attachments?: IAgentAttachmentsConfig; reminders?: { enabled?: boolean } };
}

interface VersionOption {
    version: number;
}

export interface AgentSessionViewProps {
    agentId: string;
    sessionId: string;
}

/** How close to the bottom the transcript must be for a growing live turn to keep it there. */
const AUTOSCROLL_WITHIN_PX = 120;

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

/** Pause again after a continuation? Then the session is still waiting. */
function runtimeStatusAfter(message: ChatMessage): 'idle' | 'requires_action' {
    return openActionsOf([message]).length > 0 ? 'requires_action' : 'idle';
}

export default function AgentSessionView({ agentId, sessionId }: AgentSessionViewProps) {
    const t = useTranslations('agents.hitl');
    const tb = useTranslations('agents.budget');
    const ta = useTranslations('agents.attachments');
    const tp = useTranslations('agents.sessionPage');
    const tsa = useTranslations('agents.sessionAccess');
    const tall = useTranslations('agents.allSessions');
    const router = useRouter();
    const tConfirm = useTranslations('common.confirm');
    const deleteResource = useDeleteResource();
    const searchParams = useSearchParams()!;

    const [agent, setAgent] = useState<AgentSummary | null>(null);
    const [session, setSession] = useState<SessionRecord | null>(null);
    const [versions, setVersions] = useState<VersionOption[]>([]);
    // The agent's models a turn can run on (main + additional); `''` = the agent's default / the session's last pick.
    const [agentModels, setAgentModels] = useState<Array<{ key: string; label: string; default: boolean }>>([]);
    const [pickedModel, setPickedModel] = useState('');
    const [loading, setLoading] = useState(true);
    // The session is not one this page shows: the inspector is being opened instead.
    const [redirecting, setRedirecting] = useState(false);
    // Why the page could not be shown: the session is not there, or the person may not open it.
    const [loadFailure, setLoadFailure] = useState<SessionLoadFailure | null>(null);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [compareOpen, setCompareOpen] = useState(false);
    // API / A2A / scheduled sessions are real traffic: shown, never extended
    // from here. Only console sessions (or legacy ones without a source) take
    // new messages — the same rule the Sessions panel applies to Continue.
    const sessionSource = sessionSourceOf(session?.metadata);
    const readOnly = !isContinuableSession(sessionSource);
    const sessionContext = session?.metadata?.runtimeContext as Record<string, unknown> | undefined;
    const [search, setSearch] = useState('');
    const [zoom, setZoom] = useState(DEFAULT_TIMELINE_ZOOM);
    const [overrideOpen, setOverrideOpen] = useState(false);
    const [runtimeContextJson, setRuntimeContextJson] = useState('');
    const [pinnedVersion, setPinnedVersion] = useState(searchParams.get('version') ?? '');
    const [deleting, setDeleting] = useState(false);
    const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
    // The plan the carried state holds (`GET …/sessions/:id` → `plan`): the dock and the Plan tab read it when no turn of this page has written one.
    const [sessionPlan, setSessionPlan] = useState<SessionPlanRecord | null>(null);
    // A request (tool approval / question) is being sent, and which one.
    const [resolvingId, setResolvingId] = useState<string | null>(null);
    // Following a turn this page did not start: it shows the same live view as
    // one it ran itself, fed from the session event log instead.
    const [following, setFollowing] = useState(false);
    const [followedUser, setFollowedUser] = useState<{ content: string; reminder?: { message: string; setAt?: string } } | null>(null);
    const [followDismissed, setFollowDismissed] = useState(false);
    const liveActive = sending || following;
    const openActions = useMemo(() => openActionsOf(messages), [messages]);
    const status = sessionStatusKind({ live: liveActive, openActions: openActions.length, runtimeStatus: session?.runtimeStatus });
    // What the SERVER says the viewer may do with the open requests (its own rule, decided by the policy engine):
    // said above them when the viewer cannot answer, instead of guessing from the agent's setting and their role.
    const [serverActions, setServerActions] = useState<ServerPendingAction[]>([]);
    // (only the ones still open: an answered request has nothing left to be refused)
    const openServerActions = serverActions.filter((action) => openActions.some((open) => open.id === action.id));
    const blockedReason = answerBlockedReason(openServerActions);
    // ...and per request, so a question the viewer may answer is not locked by an approval they may not.
    const blockedById = answerBlockedById(openServerActions);
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
    // The file the person asked to delete, until they confirm in the app's own dialog.
    const [fileToDelete, setFileToDelete] = useState<SessionFileItem | null>(null);
    /** Chips whose delete is still on its way: Send waits for them, or the file would go with the message. */
    const [removingFiles, setRemovingFiles] = useState<string[]>([]);
    const budgetBlocked = Boolean(budgetView?.exhausted);
    // What people rated in this session's answers (empty until the first list arrives, and for a connected agent).
    const [messageFeedback, setMessageFeedback] = useState<SessionMessageFeedback[]>([]);
    // The banner under the transcript that raises the budget or removes it.
    const budgetBannerShown = Boolean(budgetView && (budgetBlocked || session?.runtimeStatus === 'budget_paused') && !readOnly);
    // A budget that stops (rather than pauses) does not carry the turn on once raised: a new message does.
    const budgetStops = budgetView?.budget.onReach === 'stop';
    // What the composer does while the agent waits for an approval or an answer.
    // A viewer the server says may not answer the open request cannot send the message that would cancel it either (the
    // server refuses it), so the composer waits for an approver, in the badge's words, instead of "your response".
    const { gate, waitingElsewhere } = composerGateFor(openActions.length, agent?.config?.humanInTheLoop?.onUserMessageWhilePending, blockedReason);

    const viewportRef = useRef<HTMLDivElement>(null);
    const turnRefs = useRef<Array<HTMLDivElement | null>>([]);
    const composerRef = useRef<HTMLTextAreaElement>(null);

    const loadMessageFeedback = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/feedback`, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json() as { feedback?: SessionMessageFeedback[] };
            setMessageFeedback(data.feedback ?? []);
        } catch {
            // Ratings are an extra; the transcript stands without them.
        }
    }, [agentId, sessionId]);

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
        const file = attached.find((entry) => entry.fileId === fileId);
        setRemovingFiles((ids) => [...ids, fileId]);
        try {
            const outcome = await removeSessionFile(sessionFileUrl(agentId, sessionId, fileId));
            if (outcome.removed) {
                setAttached((current) => current.filter((entry) => entry.fileId !== fileId));
            } else {
                // Still on the session: the chip stays, so what goes with the message is what the person sees.
                notifications.show({ title: ta('filesDeleteFailed', { name: file?.name ?? fileId }), message: outcome.message, color: 'red' });
            }
        } finally {
            setRemovingFiles((ids) => ids.filter((id) => id !== fileId));
            void loadSessionFiles();
        }
    };

    /** Deletes a file from the Files tab: the object, its text and the record go, and a chip waiting for it too. */
    const deleteSessionFile = async (file: SessionFileItem) => {
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
        setRedirecting(false);
        // Leaving for the inspector: `loading` stays true so every effect waiting for it stays idle until the route changes.
        let leaving = false;
        try {
            const [agentRes, sessionRes] = await Promise.all([
                fetch(`/api/agents/${agentId}`, { cache: 'no-store' }),
                fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { cache: 'no-store' }),
            ]);
            const failure = sessionLoadFailure(agentRes, sessionRes);
            if (failure) {
                setLoadFailure(failure);
                return;
            }
            setLoadFailure(null);
            const agentData = await agentRes.json();
            const sessionData = await sessionRes.json();
            // This page is the chat for sessions started from the console. Any other is real traffic: the
            // inspector shows it, and nothing below (follow, stream, composer) may start for it.
            if (!isContinuableSession(sessionSourceOf(sessionData.session?.metadata))) {
                leaving = true;
                setRedirecting(true);
                router.replace(sessionInspectorHref(agentId, sessionId));
                return;
            }
            setAgent(agentData.agent);
            setAgentModels(Array.isArray(agentData.models) ? agentData.models : []);
            // The session remembers the model its last turn ran on: the picker starts there.
            const rememberedModel = sessionData.session?.metadata?.activeModel?.modelKey;
            setPickedModel(typeof rememberedModel === 'string' ? rememberedModel : '');
            setSession(sessionData.session);
            setServerActions(Array.isArray(sessionData.pendingActions) ? sessionData.pendingActions : []);
            setSessionPlan(sessionData.plan ?? null);
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
            setLoadFailure('notFound');
        } finally {
            if (!leaving) setLoading(false);
        }
    }, [agentId, sessionId, router]);

    useEffect(() => {
        void load();
    }, [load]);

    // Ratings are read once the session is there, and again whenever a turn has settled it.
    const sessionUpdatedAt = session?.updatedAt;
    useEffect(() => {
        if (!session || session.messages === undefined) return;
        void loadMessageFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadMessageFeedback, sessionUpdatedAt, Boolean(session)]);

    // `?message=N` (from the Feedback tab) opens on that message of the stored transcript.
    const deepLinkedMessage = searchParams.get('message');
    const scrolledToMessage = useRef<string | null>(null);
    useEffect(() => {
        if (deepLinkedMessage === null || scrolledToMessage.current === deepLinkedMessage || messages.length === 0) return;
        const target = screenIndexOf(messages, Number(deepLinkedMessage));
        if (target < 0) return;
        scrolledToMessage.current = deepLinkedMessage;
        const frame = requestAnimationFrame(() => turnRefs.current[target]?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        return () => cancelAnimationFrame(frame);
    }, [deepLinkedMessage, messages]);

    useEffect(() => {
        if (viewportRef.current) {
            viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
        }
    }, [messages]);

    // A running turn grows below the fold: follow it, unless the person scrolled up to read. "Near the bottom" is
    // judged when they scroll (before the new content makes the page taller), not after it has grown.
    const nearBottom = useRef(true);
    const trackScroll = useCallback(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        nearBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AUTOSCROLL_WITHIN_PX;
    }, []);
    useEffect(() => {
        const viewport = viewportRef.current;
        if (viewport && liveSegments.length > 0 && nearBottom.current) viewport.scrollTop = viewport.scrollHeight;
    }, [liveSegments]);

    const totals = useMemo(() => summariseSession(messages), [messages]);

    // The plan the dock and the Plan tab show: the running turn's newest version, else the newest a stored turn
    // recorded, else the one the session carries. None = the agent does not plan here, and neither is drawn.
    const currentPlan = useMemo(() => currentPlanOf({ live: liveSegments, messages, sessionPlan }), [liveSegments, messages, sessionPlan]);
    // The plan as it stood before the running turn: what the turn's first plan version is compared against.
    const basePlanRef = useRef<IAgentTurnPlanSnapshot | null>(null);
    const planBeforeTurn = useMemo(() => currentPlanOf({ messages, sessionPlan })?.plan ?? null, [messages, sessionPlan]);
    useEffect(() => {
        basePlanRef.current = planBeforeTurn;
    }, [planBeforeTurn]);
    // Each stored turn compares its first plan version with the latest one an earlier turn recorded.
    const previousPlans = useMemo(() => previousPlansOf(messages), [messages]);

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

    /** Scrolls to a place inside a turn (a plan version, a summarization divider, a sub-agent group); the turn itself when it is not drawn. */
    const goToAnchor = (turnIndex: number, anchorId: string) => {
        const node = document.getElementById(anchorId);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else goToTurn(turnIndex);
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
     * `plan`, `subagent` and `summary` (a pass starting, being skipped or done, the
     * agent's own or a sub-agent's) go to the live reducers, which place each where
     * it happened. `action` and `status` events are not handled here: the `result`
     * that closes the stream already carries the pending actions it raised.
     */
    const handleTurnEvent = (onResult: (data: Record<string, unknown>) => void) => (event: string, data: unknown) => {
        if (event === 'tool') {
            setLiveSegments((current) => applyLiveToolEvent(current, data as LiveToolEvent));
        } else if (event === 'text') {
            setLiveSegments((current) => appendLiveText(current, String((data as { text?: string }).text ?? '')));
        } else if (event === 'reasoning') {
            setLiveSegments((current) => appendLiveReasoning(current, String((data as { text?: string }).text ?? '')));
        } else if (event === 'summary') {
            setLiveSegments((current) => applyLiveCompaction(current, data as AgentCompactionEvent));
        } else if (event === 'plan') {
            setLiveSegments((current) => applyLivePlan(current, data as AgentPlanEvent, basePlanRef.current));
        } else if (event === 'subagent') {
            setLiveSegments((current) => applyLiveSubagent(current, data as AgentSubagentEvent));
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
            if ('plan' in data) setSessionPlan(data.plan ?? null);
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
            setSessionPlan(data.plan ?? null);
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
    /**
     * Stops the turn that is running on this session — one this tab started, one it follows, or one
     * started elsewhere. The server ends it with what it had streamed as the answer; the stream the
     * tab is reading then closes with that result, so nothing is torn down here.
     */
    const stopTurn = async () => {
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/cancel`, { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
            notifications.show({ title: t('stopTurnFailed'), message: '', color: 'orange' });
        }
    };

    const sendMessage = async () => {
        if ((!input.trim() && attached.length === 0) || uploadingNames.length > 0 || removingFiles.length > 0 || liveActive || readOnly || gate === 'blocked' || budgetBlocked) return;
        const message = input.trim();
        const sentFiles = attached;
        const startedAt = Date.now();
        const previous = messages;
        setSending(true);
        setInput('');
        setAttached([]);
        setLiveSegments([]);

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
            ...(pickedModel ? { model: pickedModel } : {}),
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
                if (isStaleActionRefusal(res.status, err)) {
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
            setLiveSegments([]);
        }
    };

    /** Adds, changes or removes the session's budget. The session as the server stored it, or null when it was refused. */
    const patchBudget = async (budget: IAgentSessionBudget | null): Promise<{ session: SessionRecord; continuable?: boolean } | null> => {
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
            return { session: data.session as SessionRecord, ...(typeof data.continuable === 'boolean' ? { continuable: data.continuable } : {}) };
        } catch (err) {
            notifications.show({
                title: tb('saveFailed'),
                message: err instanceof Error ? err.message : String(err),
                color: 'red',
            });
            return null;
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
            setLiveSegments([]);
        }
    };

    /**
     * Banner / meter action: change the budget, then carry on if the session was stopped on it. What the
     * server answers decides: a session whose turn had finished when it crossed the budget is idle again
     * after the raise, and asking it to continue would only be refused.
     */
    const changeBudget = async (budget: IAgentSessionBudget | null) => {
        const wasContinuable = Boolean(budgetView?.continuable);
        const stored = await patchBudget(budget);
        if (shouldContinueAfterBudgetChange(wasContinuable, stored?.session, stored?.continuable)) await continueBudgetSession();
    };

    // A session opened while a turn is still running (started elsewhere, or
    // before this page was reloaded) is followed from the event log, so the
    // operator sees it live instead of an idle page that suddenly changes.
    const followedStatus = session?.runtimeStatus;
    const followedSeq = session?.lastEventSeq ?? 0;
    /** Where the next follow starts when the wake watcher below saw the turn begin (so its first events are not missed). */
    const followFromSeq = useRef<number | null>(null);
    useEffect(() => {
        if (loading || sending || followDismissed || followedStatus !== 'running') return undefined;
        const after = followFromSeq.current ?? followedSeq;
        followFromSeq.current = null;
        const controller = new AbortController();
        let active = true;
        setFollowing(true);
        setFollowedUser(null);
        setLiveSegments([]);

        const stopped = { current: false };
        void (async () => {
            try {
                const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/events/stream?after=${after}`, {
                    headers: { Accept: 'text/event-stream' },
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (!res.ok || !res.body) return;
                await consumeSse(res.body, (event, frame) => {
                    if (!active) return;
                    const step = interpretSessionEvent(event, frame);
                    if (step.kind === 'user') setFollowedUser({ content: step.content, ...(step.reminder ? { reminder: step.reminder } : {}) });
                    else if (step.kind === 'tool') setLiveSegments((current) => applyLiveToolEvent(current, step.event));
                    else if (step.kind === 'text') setLiveSegments((current) => appendLiveText(current, step.text));
                    else if (step.kind === 'reasoning') setLiveSegments((current) => appendLiveReasoning(current, step.text));
                    else if (step.kind === 'compaction') setLiveSegments((current) => applyLiveCompaction(current, step.compaction));
                    else if (step.kind === 'plan') setLiveSegments((current) => applyLivePlan(current, step.plan, basePlanRef.current));
                    else if (step.kind === 'subagent') setLiveSegments((current) => applyLiveSubagent(current, step.event));
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
        };
    }, [loading, sending, followDismissed, followedStatus, followedSeq, agentId, sessionId, refreshSession]);

    // The session's reminders: the inspector lists them, and while a wake is still to come the page
    // watches the event log, so the turn a reminder starts shows up live instead of after a reload.
    const { reminders: sessionReminders, reload: reloadSessionReminders } = useSessionReminders(agentId, sessionId, true, 'all');
    const wakePending = (sessionReminders ?? []).some(isPendingWake);
    const remindersKey = `${followedStatus ?? ''}:${messages.length}`;
    const lastRemindersKey = useRef<string | null>(null);
    useEffect(() => {
        // A turn ended (or the transcript changed): a reminder may have been set, fired or used up.
        if (lastRemindersKey.current !== null && lastRemindersKey.current !== remindersKey) void reloadSessionReminders();
        lastRemindersKey.current = remindersKey;
    }, [remindersKey, reloadSessionReminders]);

    useEffect(() => {
        if (!wakePending || loading || sending || followedStatus === 'running') return undefined;
        let active = true;
        let controller = new AbortController();
        void (async () => {
            let after = followedSeq;
            while (active) {
                controller = new AbortController();
                let firstSeq: number | null = null;
                try {
                    const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}/events/stream?after=${after}`, {
                        headers: { Accept: 'text/event-stream' },
                        signal: controller.signal,
                        cache: 'no-store',
                    });
                    if (!res.ok || !res.body) return;
                    await consumeSse(res.body, (_event, frame) => {
                        const seq = Number((frame as { seq?: unknown } | null)?.seq);
                        if (firstSeq !== null || !Number.isFinite(seq)) return;
                        firstSeq = seq;
                        controller.abort();
                    });
                } catch {
                    // Aborted on the first event (or by the cleanup), or the connection dropped.
                }
                if (!active) return;
                if (firstSeq !== null) {
                    // Something happened on the idle session: if a turn runs now, follow it from its first event.
                    followFromSeq.current = firstSeq - 1;
                    const fresh = await refreshSession();
                    if (fresh?.runtimeStatus === 'running') return;
                    followFromSeq.current = null;
                    after = Math.max(firstSeq, fresh?.lastEventSeq ?? 0);
                    continue;
                }
                // The stream ended on its own (its time cap): open it again shortly.
                await new Promise((resolve) => { setTimeout(resolve, 3000); });
            }
        })();
        return () => {
            active = false;
            controller.abort();
        };
    }, [wakePending, loading, sending, followedStatus, followedSeq, agentId, sessionId, refreshSession]);

    const deleteSession = async () => {
        setDeleting(true);
        try {
            const deleted = await deleteResource({
                noun: tConfirm('nouns.agentSession'),
                extraWarning: tConfirm('extras.agentSessionData'),
                action: async () => {
                    const res = await fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error('Failed to delete session');
                },
            });
            if (!deleted) {
                setDeleting(false);
                return;
            }
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

    if (loading || redirecting) return <LoadingState label={redirecting ? tall('openingInspector') : 'Loading session...'} minHeight={400} />;
    if (loadFailure || !agent) {
        const refused = loadFailure === 'forbidden';
        return (
            <EmptyState
                title={refused ? tp('accessDeniedTitle') : tp('notFoundTitle')}
                description={refused ? tp('accessDeniedBody') : tp('notFoundBody')}
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
                        <h1 className="ds-h2" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{session?.title || 'Session'}</h1>
                        <SessionStatusBadge status={status} waitingElsewhere={Boolean(blockedReason)} />
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
                        {!isConnected && agentModels.length > 1 ? (
                            <Select
                                size="xs"
                                w={180}
                                data={agentModels.map((m) => ({ value: m.key, label: m.default ? `${m.label} *` : m.label }))}
                                value={pickedModel || agentModels.find((m) => m.default)?.key || null}
                                onChange={(next) => setPickedModel(next ?? '')}
                                allowDeselect={false}
                                disabled={liveActive}
                            />
                        ) : null}
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
                                {tp('compare')}
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
                            {tp('continue')}
                        </Button>
                        <Button
                            size="xs"
                            variant="light"
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            loading={deleting}
                            onClick={() => void deleteSession()}
                        >
                            {tp('delete')}
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
                                <ScrollArea className={classes.chatScroll} viewportRef={viewportRef} onScrollPositionChange={trackScroll} px="md" py="sm">
                                    <Stack gap="lg">
                                        {messages.map((msg, i) => {
                                            if (matchedIndexes && !matchedIndexes.has(i)) return null;
                                            const previous = messages[i - 1];
                                            const reminder = msg.role === 'user' ? reminderOfMessage(msg) : null;
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
                                                    ) : reminder ? (
                                                        <ReminderNote message={reminder.message} at={reminder.setAt ?? msg.timestamp} />
                                                    ) : (
                                                        <>
                                                            <Group gap={6} mb={4} align="center">
                                                                <RoleBadge user={msg.role === 'user'} agentName={agent.name} />
                                                                {msg.role === 'assistant' ? <TurnPills message={msg} /> : null}
                                                            </Group>
                                                            {msg.role === 'assistant' ? (
                                                                <AssistantTurn
                                                                    message={msg}
                                                                    messageIndex={i}
                                                                    previousPlan={previousPlans[i]}
                                                                    busy={liveActive || Boolean(resolvingId)}
                                                                    resolvingId={resolvingId}
                                                                    onResolve={(actionId, body) => void resolveAction(actionId, body)}
                                                                    blocked={blockedReason}
                                                                    blockedById={blockedById}
                                                                    budgetBannerShown={budgetBannerShown}
                                                                    budgetStops={budgetStops}
                                                                    ruleHref={approvalSettingsHref(agentId)}
                                                                />
                                                            ) : (
                                                                <>
                                                                    <Text size="sm" className={classes.preWrap}>{msg.content}</Text>
                                                                    <MessageAttachments attachments={toAttachmentViews(msg.attachments, { agentId, sessionId, files: sessionFiles })} />
                                                                </>
                                                            )}
                                                            {msg.role === 'assistant' && msg.attachments?.some((file) => file.origin === 'agent_output') ? (
                                                                // Files the agent wrote to its sandbox /outputs/: chips that save through the session's content route.
                                                                <MessageAttachments attachments={toAttachmentViews(msg.attachments.filter((file) => file.origin === 'agent_output'), { agentId, sessionId, files: sessionFiles })} />
                                                            ) : null}
                                                            {msg.role === 'assistant' ? (
                                                                <MessageFeedbackRow rows={feedbackForMessage(messageFeedback, persistedIndexOf(messages, i))} />
                                                            ) : null}
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
                                            followedUser.reminder ? (
                                                <ReminderNote message={followedUser.reminder.message} at={followedUser.reminder.setAt} />
                                            ) : (
                                                <Box>
                                                    <Group gap={6} mb={4}>
                                                        <RoleBadge user agentName={agent.name} />
                                                    </Group>
                                                    <Text size="sm" className={classes.preWrap}>{followedUser.content}</Text>
                                                </Box>
                                            )
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
                                                {liveSegments.length === 0 ? (
                                                    <Group gap="xs">
                                                        <Loader size="xs" />
                                                        <Text size="xs" c="dimmed">The agent is working…</Text>
                                                    </Group>
                                                ) : (
                                                    <LiveTurnFlow segments={liveSegments} />
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
                                {currentPlan ? (
                                    <Box mb="xs">
                                        <PlanDock plan={currentPlan.plan} />
                                    </Box>
                                ) : null}
                                <AttachmentChips
                                    files={attached}
                                    uploading={uploadingNames}
                                    disabled={liveActive}
                                    onRemove={(fileId) => void removeAttachment(fileId)}
                                    textOnlyModel={textOnlyModel}
                                    linksFor={(file) => sessionFileLinks(agentId, sessionId, file.fileId)}
                                />
                                <Textarea
                                    ref={composerRef}
                                    placeholder={readOnly
                                        ? `Read-only — this session came in via ${sessionSourceLabel(sessionSource)}`
                                        : budgetBlocked
                                            ? tb('composerPlaceholder')
                                            : gate === 'blocked'
                                                ? (waitingElsewhere ? tsa('composerWaitingElsewhere') : t('composerBlockedPlaceholder'))
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
                                    rightSectionPointerEvents="all"
                                    rightSection={liveActive && !readOnly ? (
                                        <ActionIcon
                                            size="sm"
                                            variant="filled"
                                            color="red"
                                            aria-label={t('stopTurn')}
                                            title={t('stopTurn')}
                                            onClick={() => void stopTurn()}
                                        >
                                            <IconPlayerStopFilled size={12} />
                                        </ActionIcon>
                                    ) : (
                                        <ActionIcon
                                            size="sm"
                                            variant="filled"
                                            onClick={() => void sendMessage()}
                                            disabled={(!input.trim() && attached.length === 0) || uploadingNames.length > 0 || removingFiles.length > 0 || liveActive || readOnly || gate === 'blocked' || budgetBlocked}
                                        >
                                            <IconSend size={14} />
                                        </ActionIcon>
                                    )}
                                />
                                {gate !== 'open' && !readOnly ? (
                                    <Alert
                                        variant="light"
                                        color={gate === 'blocked' ? 'gray' : 'orange'}
                                        icon={<IconHandStop size={14} />}
                                        mt={6}
                                        p="xs"
                                    >
                                        <Text size="xs">
                                            {gate === 'blocked'
                                                ? (waitingElsewhere ? tsa('composerWaitingElsewhereNote') : t('composerBlocked'))
                                                : t('composerCancelWarning')}
                                        </Text>
                                    </Alert>
                                ) : null}
                                <Group justify="space-between" mt={6}>
                                    <Text size="10px" c="dimmed">{tp('enterToSend')}</Text>
                                    <UnstyledButton onClick={() => setOverrideOpen((value) => !value)}>
                                        <Group gap={3}>
                                            <Text size="10px" c="dimmed">{tp('contextOverride')}</Text>
                                            {overrideOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                                        </Group>
                                    </UnstyledButton>
                                </Group>
                                <Collapse in={overrideOpen}>
                                    <Box mt="xs">
                                        <Text size="10px" c="dimmed" mb={4}>
                                            {tp('contextOverrideHint')}
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
                            waitingElsewhere={Boolean(blockedReason)}
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
                            remindersEnabled={!isConnected && agent.config?.reminders?.enabled === true}
                            reminders={sessionReminders}
                            onRemindersChanged={() => void reloadSessionReminders()}
                            readOnly={readOnly}
                            messages={messages}
                            onGoToTurn={goToTurn}
                            onGoToAnchor={goToAnchor}
                            plan={currentPlan}
                            // The tab is for agents with files, and for any session that holds some (an API upload, or files from before the setting was turned off).
                            files={isConnected || !(filesConfigured || (sessionFiles?.length ?? 0) > 0) ? undefined : {
                                items: sessionFiles,
                                failed: sessionFilesFailed,
                                maxFiles: filesConfigured ? attachmentsConfig.maxFiles : undefined,
                                readOnly,
                                deleting: deletingFiles,
                                onDelete: (file) => setFileToDelete(file),
                                onRetry: () => void loadSessionFiles(),
                            }}
                        />
                    </Paper>
                </Group>
                <ConfirmModal
                    opened={fileToDelete !== null}
                    title={ta('filesDelete')}
                    message={fileToDelete ? ta('filesDeleteConfirm', { name: fileToDelete.name }) : ''}
                    confirmLabel={ta('filesDeleteAction')}
                    cancelLabel={ta('cancel')}
                    loading={fileToDelete ? deletingFiles.includes(fileToDelete.id) : false}
                    onClose={() => setFileToDelete(null)}
                    onConfirm={() => {
                        const file = fileToDelete;
                        if (!file) return;
                        void deleteSessionFile(file).finally(() => setFileToDelete(null));
                    }}
                />
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

/** A reminder's wake-up turn: the agent's own earlier note, so it is a muted card, not a user bubble. */
function ReminderNote({ message, at }: { message: string; at?: string }) {
    const tRem = useTranslations('agents.reminders');
    return (
        <Box p="sm" style={{ background: 'var(--mantine-color-gray-light)', borderRadius: 'var(--mantine-radius-sm)' }}>
            <Group gap={6} mb={4}>
                <IconClock size={12} color="var(--mantine-color-dimmed)" />
                <Text size="xs" c="dimmed">
                    {tRem('transcriptHeader', { time: at ? new Date(at).toLocaleString() : '—' })}
                </Text>
            </Group>
            <Text size="sm" className={classes.preWrap}>{message}</Text>
        </Box>
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
    messageIndex,
    previousPlan,
    busy,
    resolvingId,
    onResolve,
    blocked,
    blockedById,
    budgetBannerShown,
    budgetStops,
    ruleHref,
}: {
    message: ChatMessage;
    /** The message's place in the session: it keeps the "go to" ids of its summarization dividers apart from other turns'. */
    messageIndex: number;
    /** The plan as an earlier turn left it, for what this turn's first plan version changed. */
    previousPlan?: IAgentTurnPlanSnapshot;
    busy: boolean;
    resolvingId: string | null;
    onResolve: (actionId: string, body: ResolveBody) => void;
    blocked: AnswerBlockedReason | null;
    blockedById: Readonly<Record<string, AnswerBlockedReason>>;
    budgetBannerShown: boolean;
    /** The session budget stops the session instead of pausing it. */
    budgetStops: boolean;
    /** Where the agent's approval settings are edited. */
    ruleHref?: string;
}) {
    // What the turn did, in the order it happened: narration, tool calls, plan versions, sub-agent groups, summaries.
    const flow = useMemo(() => buildTurnFlow(message, { previousPlan, messageIndex }), [message, previousPlan, messageIndex]);
    // Which sub-agent groups are open is held here, so "Show in group" on a request card below can open one.
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
    const expansion = useMemo(
        () => ({
            state: openGroups,
            set: (key: string, open: boolean) => setOpenGroups((current) => ({ ...current, [key]: open })),
        }),
        [openGroups],
    );
    const showInGroup = (delegationToolCallId: string, subagent?: string) => {
        setOpenGroups((current) => ({ ...current, ...showInGroupExpansion(flow, delegationToolCallId, subagent) }));
        // The group is still folded when this runs; scroll once it has had a frame to open.
        requestAnimationFrame(() => {
            document.getElementById(delegationAnchorId(delegationToolCallId))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    };

    return (
        <Box className={classes.chatMarkdown}>
            {message.reasoning ? (
                <ReasoningBlock reasoning={message.reasoning} />
            ) : null}
            {flow.length > 0 ? <StoredTurnFlow blocks={flow} message={message} expansion={expansion} /> : null}
            {/* A pause with cards says what it waits for on the cards themselves. */}
            {message.stopReason && !(message.stopReason === 'paused' && message.pendingActions?.length)
                ? <StopNotice message={message} budgetBannerShown={budgetBannerShown} budgetStops={budgetStops} />
                : null}
            <Markdown text={message.content} />
            {message.pendingActions?.length ? (
                <PendingActionList
                    actions={message.pendingActions}
                    busy={busy}
                    resolvingId={resolvingId}
                    onResolve={onResolve}
                    blocked={blocked}
                    blockedById={blockedById}
                    onShowInGroup={showInGroup}
                    ruleHref={ruleHref}
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

function StructuredOutputBlock({ output }: { output: unknown }) {
    return (
        <Box mt="xs">
            <Text size="10px" c="dimmed" tt="uppercase" fw={600}>structured output</Text>
            <Code block className={classes.outputCode}>{JSON.stringify(output, null, 2)}</Code>
        </Box>
    );
}
