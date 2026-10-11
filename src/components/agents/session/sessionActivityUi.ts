/**
 * What a session is doing and what happened in it, as the session view and the
 * Sessions drawer show it: one status for the header, the side panel and the
 * drawer (so they cannot disagree), the badge for why the last turn stopped, and
 * how one entry of the session event log (`GET …/sessions/:id/events`) reads.
 *
 * Pure — the labels are translation keys under `agents.activity` (and the
 * values to fill in), resolved by the component.
 */

import { formatCost } from './sessionUsage';

export type SessionStatusKind = 'running' | 'waiting' | 'budget_paused' | 'idle';

/**
 * The one status of a session. A turn this page is running (or following) wins;
 * then an open approval / question; then the session's stored status — so a
 * session that stopped on its budget reads that way, not "idle".
 */
export function sessionStatusKind(input: {
    /** A turn is running here, or being followed. */
    live: boolean;
    /** Approvals / questions still waiting for a person. */
    openActions: number;
    /** The stored `runtimeStatus`; absent = idle. */
    runtimeStatus?: string;
}): SessionStatusKind {
    if (input.live) return 'running';
    if (input.openActions > 0 || input.runtimeStatus === 'requires_action') return 'waiting';
    if (input.runtimeStatus === 'budget_paused') return 'budget_paused';
    if (input.runtimeStatus === 'running') return 'running';
    return 'idle';
}

/**
 * Who a waiting session waits for, from the viewer's side: `you` (they may answer what it waits on, or the server did
 * not say they may not), `elsewhere` (the server says they may not - an approver, the session's owner), or `null`
 * (it waits on nobody). The Sessions list words its badge and its status filter by this, so a row never says "Waiting
 * for you" to somebody who cannot answer.
 */
export type WaitingFor = 'you' | 'elsewhere' | null;

export function waitingFor(row: { runtimeStatus?: string | null; canResolve?: boolean | null }): WaitingFor {
  if (row.runtimeStatus !== 'requires_action') return null;
  return row.canResolve === false ? 'elsewhere' : 'you';
}

export interface StopReasonBadge {
    /** Translation key under `agents.activity`. */
    key: string;
    color: 'orange' | 'red' | 'gray';
}

/**
 * The badge for why a session's last turn stopped. A normal finish and a pause
 * for a person need none (the status already says "waiting for you").
 */
export function stopReasonBadge(stopReason: string | null | undefined): StopReasonBadge | null {
    switch (stopReason) {
        case 'limit':
            return { key: 'stopLimit', color: 'orange' };
        case 'budget_reached':
            return { key: 'stopBudgetReached', color: 'orange' };
        case 'cancelled':
            return { key: 'stopCancelled', color: 'gray' };
        case 'error':
            return { key: 'stopError', color: 'red' };
        default:
            return null;
    }
}

// ── The event log ────────────────────────────────────────────────────────

/** Events fetched per page. */
export const ACTIVITY_PAGE_SIZE = 100;

/** One entry of `GET …/events`, as the dashboard route returns it. */
export interface SessionLogEvent {
    seq: number;
    type: string;
    data?: Record<string, unknown>;
    created_at?: string;
}

export interface SessionLogPage {
    events: SessionLogEvent[];
    has_more?: boolean;
    last_seq?: number;
}

export function sessionEventsUrl(agentId: string, sessionId: string, afterSeq: number, limit = ACTIVITY_PAGE_SIZE): string {
    const after = afterSeq > 0 ? `&after=${afterSeq}` : '';
    return `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}${after}`;
}

/** Appends a page to what is loaded, once per `seq` and in `seq` order. */
export function mergeEventPage(current: SessionLogEvent[], page: SessionLogEvent[]): SessionLogEvent[] {
    const seen = new Set(current.map((event) => event.seq));
    const fresh = page.filter((event) => !seen.has(event.seq));
    return fresh.length === 0 ? current : [...current, ...fresh].sort((a, b) => a.seq - b.seq);
}

export type EventTone = 'blue' | 'orange' | 'red' | 'green' | 'gray' | 'violet';

export interface EventView {
    /** Translation key under `agents.activity`. */
    key: string;
    values: Record<string, string | number>;
    tone: EventTone;
    /** A line of context under the label (an excerpt, an error). */
    detail?: string;
    /** For `values.reason`: the key of its wording, when it has one (else the raw value is shown). */
    reasonKey?: string;
}

const DETAIL_CHARS = 140;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function excerpt(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}

function money(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? formatCost(value) : '—';
}

const STOP_REASON_KEYS: Record<string, string> = {
    end_turn: 'stopEndTurn',
    requires_action: 'stopRequiresAction',
    limit: 'stopLimit',
    cancelled: 'stopCancelled',
    error: 'stopError',
    budget_reached: 'stopBudgetReached',
};

/** The key of the wording for a session stop reason, when it has one. */
export function stopReasonKey(stopReason: unknown): string | undefined {
    return typeof stopReason === 'string' ? STOP_REASON_KEYS[stopReason] : undefined;
}

/**
 * How one event reads in the log. `null` for an event that adds nothing a
 * person needs (the log has `session.work_done` right after the idle event).
 * An event type this build does not know is shown by its type, not dropped.
 */
export function describeSessionEvent(event: SessionLogEvent): EventView | null {
    const data = asRecord(event.data);
    const name = typeof data.name === 'string' ? data.name : '?';
    switch (event.type) {
        case 'user.message':
            return { key: 'evUserMessage', values: {}, tone: 'blue', detail: excerpt(data.content) };
        case 'session.status_running':
            return { key: 'evRunStarted', values: {}, tone: 'gray' };
        case 'agent.tool_use':
            return { key: 'evToolUse', values: { name }, tone: 'violet' };
        case 'agent.tool_result':
            return data.ok === false
                ? { key: 'evToolFailed', values: { name }, tone: 'red', detail: excerpt(data.error) }
                : { key: 'evToolResult', values: { name }, tone: 'violet' };
        case 'agent.compaction':
            return { key: 'evCompaction', values: {}, tone: 'gray' };
        case 'action.required':
            return data.kind === 'user_question'
                ? { key: 'evQuestionAsked', values: {}, tone: 'orange' }
                : {
                    key: 'evApprovalRequested',
                    values: { name: typeof data.toolName === 'string' ? data.toolName : '?' },
                    tone: 'orange',
                };
        case 'action.resolved': {
            if (data.expired) return { key: 'evActionExpired', values: {}, tone: 'gray' };
            if (data.cancelled) return { key: 'evActionCancelled', values: {}, tone: 'gray' };
            if (data.kind === 'user_question') return { key: 'evQuestionAnswered', values: {}, tone: 'green' };
            return data.decision === 'deny'
                ? { key: 'evApprovalDenied', values: {}, tone: 'red' }
                : { key: 'evApprovalApproved', values: {}, tone: 'green' };
        }
        case 'agent.message':
            return { key: 'evAgentMessage', values: {}, tone: 'blue', detail: excerpt(data.content) };
        case 'session.usage': {
            const budget = asRecord(data.budget);
            return typeof budget.maxCostUsd === 'number'
                ? { key: 'evSpendOfBudget', values: { spent: money(data.spentUsd), max: money(budget.maxCostUsd) }, tone: 'gray' }
                : { key: 'evSpend', values: { spent: money(data.spentUsd) }, tone: 'gray' };
        }
        case 'budget.reached':
            return {
                key: 'evBudgetReached',
                values: { spent: money(data.spentUsd), max: money(data.maxCostUsd) },
                tone: 'orange',
            };
        case 'session.status_idle': {
            const reason = typeof data.stopReason === 'string' ? data.stopReason : '';
            return {
                key: 'evRunEnded',
                values: { reason },
                reasonKey: stopReasonKey(reason),
                tone: reason === 'error' ? 'red' : 'gray',
                detail: reason === 'error' ? excerpt(data.detail) : undefined,
            };
        }
        case 'session.error':
            return { key: 'evRunFailed', values: {}, tone: 'red', detail: excerpt(data.message) };
        case 'session.work_done':
            return null;
        default:
            return { key: 'evOther', values: { type: event.type }, tone: 'gray' };
    }
}
