/**
 * The pure half of the approval / question cards: what a pending action looks
 * like in the transcript, how an answer is built from what the person typed,
 * how a resolution is reflected on the message while the server catches up,
 * and what the composer does while the session is waiting.
 *
 * Kept free of React so the rules that decide what is sent to the resolve
 * endpoint (and what is refused before it is sent) can be tested without a DOM.
 */

import type {
    IAgentHumanInTheLoopConfig,
    IAgentMessagePendingAction,
    IAgentPendingActionResolution,
    IAgentUserQuestion,
} from '@/lib/database/provider/types.domain';
import type { ChatMessage } from './sessionTypes';

export type PendingActionView = IAgentMessagePendingAction;

/** Body of `POST …/actions/:actionId/resolve` for a tool approval. */
export interface ApprovalResolveBody {
    decision: 'allow' | 'deny';
    comment?: string;
    approvedArgs?: Record<string, unknown>;
    rememberForSession?: boolean;
}

/** Body of `POST …/actions/:actionId/resolve` for a question. */
export interface QuestionResolveBody {
    answers: Record<string, string | string[]>;
    cancelled?: boolean;
}

/** Body of `POST …/actions/:actionId/resolve` for a client tool call: the page's result, or why it has none. */
export interface ClientToolResolveBody {
    output?: unknown;
    error?: string;
}

export type ResolveBody = ApprovalResolveBody | QuestionResolveBody | ClientToolResolveBody;

// ── Which actions are open ───────────────────────────────────────────────

/** Every action in the transcript that still waits for a person. */
export function openActionsOf(messages: ChatMessage[]): PendingActionView[] {
    return messages.flatMap((message) => (message.pendingActions ?? []).filter((action) => action.status === 'pending'));
}

/** Replaces one action's state on whichever message carries it; other messages are returned as they were. */
export function patchAction(
    messages: ChatMessage[],
    actionId: string,
    patch: { status: PendingActionView['status']; resolution?: IAgentPendingActionResolution },
): ChatMessage[] {
    return messages.map((message) => {
        if (!message.pendingActions?.some((action) => action.id === actionId)) return message;
        return {
            ...message,
            pendingActions: message.pendingActions.map((action) => (action.id === actionId
                ? { ...action, status: patch.status, ...(patch.resolution ? { resolution: patch.resolution } : {}) }
                : action)),
        };
    });
}

/** What the server will have recorded for this answer — shown at once, before the continuation streams in. */
export function resolutionFromBody(body: ResolveBody): IAgentPendingActionResolution {
    if (!('decision' in body) && !('answers' in body)) {
        return body.error !== undefined ? { error: body.error } : { output: body.output };
    }
    if ('answers' in body) {
        return { answers: body.answers, ...(body.cancelled ? { cancelled: true } : {}) };
    }
    return {
        decision: body.decision,
        ...(body.comment ? { comment: body.comment } : {}),
        ...(body.approvedArgs ? { approvedArgs: body.approvedArgs } : {}),
        ...(body.rememberForSession ? { rememberForSession: true } : {}),
    };
}

/** Marks an action answered, locally. */
export function applyLocalResolution(messages: ChatMessage[], actionId: string, body: ResolveBody): ChatMessage[] {
    return patchAction(messages, actionId, { status: 'resolved', resolution: resolutionFromBody(body) });
}

/** Marks every open action cancelled — what a new message does when the agent is set to `cancel_pending`. */
export function cancelOpenActions(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => (message.pendingActions?.some((action) => action.status === 'pending')
        ? {
            ...message,
            pendingActions: message.pendingActions.map((action) => (action.status === 'pending'
                ? { ...action, status: 'cancelled' as const }
                : action)),
        }
        : message));
}

/**
 * The resolve route says the request is not open any more: answered somewhere
 * else (409 `action_not_pending`), cancelled — by a new message, a run cancel or
 * the timeout policy — (409 `action_cancelled`), or timed out (410). A page that
 * gets one reloads the session to show how it really ended, instead of failing.
 */
export function isStaleActionRefusal(
    status: number,
    body: { type?: unknown; code?: unknown } | null | undefined,
): boolean {
    if (status === 410) return true;
    if (status !== 409) return false;
    return [body?.type, body?.code].some((value) => value === 'action_not_pending' || value === 'action_cancelled');
}

export type ResolvedKind =
    | 'approved'
    | 'approved_edited'
    | 'denied'
    | 'answered'
    | 'skipped'
    | 'expired'
    | 'cancelled'
    | 'tool_ran'
    | 'tool_failed';

/** How a settled action reads in the transcript. `null` while it is still pending. */
export function resolvedKind(action: PendingActionView): ResolvedKind | null {
    if (action.status === 'pending') return null;
    if (action.status === 'expired') return 'expired';
    if (action.status === 'cancelled') return 'cancelled';
    const resolution = action.resolution;
    if (action.kind === 'client_tool') return resolution?.error !== undefined ? 'tool_failed' : 'tool_ran';
    if (action.kind === 'user_question') return resolution?.cancelled ? 'skipped' : 'answered';
    if (resolution?.decision === 'deny') return 'denied';
    return resolution?.approvedArgs ? 'approved_edited' : 'approved';
}

// ── Tool approval ────────────────────────────────────────────────────────

export type ArgsParse =
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; error: 'invalid_json' | 'not_object' };

/** The edited-arguments textarea → the object the tool will be called with. */
export function parseEditedArgs(text: string): ArgsParse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, error: 'invalid_json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'not_object' };
    return { ok: true, value: parsed as Record<string, unknown> };
}

function canonicalJson(value: unknown): string {
    const sort = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(sort);
        if (input && typeof input === 'object') {
            return Object.fromEntries(
                Object.keys(input as Record<string, unknown>).sort().map((key) => [key, sort((input as Record<string, unknown>)[key])]),
            );
        }
        return input;
    };
    return JSON.stringify(sort(value));
}

/** True when the reviewer changed the arguments — key order does not count. */
export function argsDiffer(original: unknown, edited: Record<string, unknown>): boolean {
    return canonicalJson(original ?? {}) !== canonicalJson(edited);
}

/** The pretty-printed arguments a card opens its editor with. */
export function formatArgs(args: unknown): string {
    if (args === undefined) return '{}';
    try {
        return JSON.stringify(args, null, 2);
    } catch {
        return String(args);
    }
}

export function buildApprovalBody(input: {
    decision: 'allow' | 'deny';
    comment?: string;
    /** The edited arguments, already parsed; undefined when the editor is closed or untouched. */
    edited?: Record<string, unknown>;
    original: unknown;
    remember?: boolean;
}): ApprovalResolveBody {
    const comment = input.comment?.trim();
    const allow = input.decision === 'allow';
    return {
        decision: input.decision,
        ...(comment ? { comment } : {}),
        // Only an allow carries arguments or a standing permission.
        ...(allow && input.edited && argsDiffer(input.original, input.edited) ? { approvedArgs: input.edited } : {}),
        ...(allow && input.remember ? { rememberForSession: true } : {}),
    };
}

// ── Questions ────────────────────────────────────────────────────────────

/** What is selected / typed, per question index. */
export interface QuestionDraft {
    picked: string[][];
    typed: string[];
}

/** The value sent for an option: its `value`, else its label. */
export function optionValue(option: { label: string; value?: string }): string {
    return option.value ?? option.label;
}

export function emptyDraft(questions: IAgentUserQuestion[]): QuestionDraft {
    return { picked: questions.map(() => []), typed: questions.map(() => '') };
}

/** Picks (or, for multi-select, toggles) an option. Choosing an option in a single-select clears typed text. */
export function pickOption(draft: QuestionDraft, index: number, question: IAgentUserQuestion, value: string): QuestionDraft {
    const current = draft.picked[index] ?? [];
    const next = question.multiSelect
        ? (current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value])
        : [value];
    return {
        picked: draft.picked.map((entry, i) => (i === index ? next : entry)),
        typed: question.multiSelect ? draft.typed : draft.typed.map((entry, i) => (i === index ? '' : entry)),
    };
}

/** Typing an answer. In a single-select it replaces the picked option, as the two are alternatives. */
export function typeAnswer(draft: QuestionDraft, index: number, question: IAgentUserQuestion, text: string): QuestionDraft {
    return {
        typed: draft.typed.map((entry, i) => (i === index ? text : entry)),
        picked: !question.multiSelect && text.trim()
            ? draft.picked.map((entry, i) => (i === index ? [] : entry))
            : draft.picked,
    };
}

/** The SDK treats a question as required unless it says otherwise. */
export function isRequired(question: IAgentUserQuestion): boolean {
    return question.required !== false;
}

export type AnswersBuild =
    | { ok: true; answers: Record<string, string | string[]> }
    | { ok: false; missing: number[] };

/**
 * The `answers` object for the resolve call, keyed by question text. A
 * single-select answer is a string, a multi-select one an array (picked
 * options, then anything typed). Required questions with nothing in them are
 * reported by index instead of sent.
 */
export function buildAnswers(questions: IAgentUserQuestion[], draft: QuestionDraft): AnswersBuild {
    const answers: Record<string, string | string[]> = {};
    const missing: number[] = [];
    questions.forEach((question, index) => {
        const picked = draft.picked[index] ?? [];
        const typed = (draft.typed[index] ?? '').trim();
        const values = [...picked, ...(typed ? [typed] : [])];
        if (values.length === 0) {
            if (isRequired(question)) missing.push(index);
            return;
        }
        answers[question.question] = question.multiSelect ? values : values[0];
    });
    return missing.length > 0 ? { ok: false, missing } : { ok: true, answers };
}

/** An answer as one line of text, for the settled card. */
export function answerText(value: string | string[] | undefined): string {
    if (value === undefined) return '';
    return Array.isArray(value) ? value.join(', ') : value;
}

// ── Composer while waiting ───────────────────────────────────────────────

/**
 * `open`: nothing is waiting. `blocked`: the agent refuses new messages while a
 * request is open. `cancel`: a message is allowed and cancels the request.
 */
export type ComposerGate = 'open' | 'blocked' | 'cancel';

export function composerGate(
    openCount: number,
    policy: 'reject' | 'cancel_pending' | undefined,
): ComposerGate {
    if (openCount === 0) return 'open';
    return policy === 'cancel_pending' ? 'cancel' : 'blocked';
}

// ── Who may answer ───────────────────────────────────────────────────────

/** Which `approvers` setting limits who may answer — what the notice above an open request names. */
export type AnswerRestriction = 'owner' | 'owner_or_admin';

/** Tenant roles that administer every project (the server also counts a project-level admin). */
const ADMIN_ROLES = new Set(['owner', 'admin', 'project_admin']);

/**
 * The restriction to tell the viewer about, or `null` when there is nothing to
 * say: the agent lets any member answer, the viewer started the session, or the
 * viewer is an admin — and also whenever the page cannot tell (no viewer, no
 * session owner).
 *
 * A notice, not a lock: the server decides at resolve time (and also counts
 * project admins, which the page does not know), so the buttons stay usable and
 * a refusal is still reported.
 */
export function answerRestriction(input: {
    approvers?: IAgentHumanInTheLoopConfig['approvers'];
    viewerId?: string;
    viewerRole?: string;
    ownerId?: string;
}): AnswerRestriction | null {
    const policy = input.approvers ?? 'owner_or_admin';
    if (policy === 'project_members') return null;
    if (!input.viewerId || !input.ownerId) return null;
    if (input.viewerId === input.ownerId) return null;
    if (policy === 'owner') return 'owner';
    return input.viewerRole && ADMIN_ROLES.has(input.viewerRole) ? null : 'owner_or_admin';
}
