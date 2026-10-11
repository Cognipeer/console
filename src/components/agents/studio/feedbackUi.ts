/**
 * The pure half of Studio's feedback views (the agent's Feedback tab and the
 * rating shown on a session message): the reasons in their order, the query a
 * filter makes, and the bars of the reasons chart.
 */

import type { AgentFeedbackReason } from '@/lib/database/provider/types.domain';

export const FEEDBACK_REASON_ORDER: readonly AgentFeedbackReason[] = ['inaccurate', 'incomplete', 'off_topic', 'too_long', 'unsafe', 'other'];

export type FeedbackWindowDays = 7 | 30 | 90;
export const FEEDBACK_WINDOWS: readonly FeedbackWindowDays[] = [7, 30, 90];

export interface FeedbackFilterState {
    days: FeedbackWindowDays;
    rating: 'all' | 'up' | 'down';
    reason: 'all' | AgentFeedbackReason;
    onlyWithComment: boolean;
}

export const DEFAULT_FEEDBACK_FILTER: FeedbackFilterState = { days: 30, rating: 'all', reason: 'all', onlyWithComment: false };

/** The query string of `GET /api/agents/:id/feedback` (and `/summary`, which ignores paging) for a filter. */
export function feedbackQuery(filter: FeedbackFilterState, paging?: { limit: number; skip: number }): string {
    const params = new URLSearchParams({ days: String(filter.days) });
    if (filter.rating !== 'all') params.set('rating', filter.rating);
    if (filter.reason !== 'all') params.set('reason', filter.reason);
    if (filter.onlyWithComment) params.set('hasComment', 'true');
    if (paging) {
        params.set('limit', String(paging.limit));
        params.set('skip', String(paging.skip));
    }
    return params.toString();
}

export interface ReasonBar {
    reason: AgentFeedbackReason;
    count: number;
    /** 0–100, relative to the most named reason. */
    percent: number;
}

/** The reasons chart: every known reason that was named, most named first, ties in the canonical order. */
export function reasonBars(reasons: Partial<Record<AgentFeedbackReason, number>> | undefined): ReasonBar[] {
    const named = FEEDBACK_REASON_ORDER
        .map((reason, order) => ({ reason, order, count: reasons?.[reason] ?? 0 }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count || a.order - b.order);
    const max = named[0]?.count ?? 0;
    return named.map(({ reason, count }) => ({ reason, count, percent: max > 0 ? Math.round((count / max) * 100) : 0 }));
}

/** "83%" for a 0–1 share; an em dash when there is nothing to divide. */
export function formatPositiveRate(rate: number | null | undefined): string {
    return typeof rate === 'number' && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';
}

/** A rating of one message as the session API sends it. */
export interface SessionMessageFeedback {
    messageId: string;
    messageIndex: number;
    rating: 'up' | 'down';
    reasons: AgentFeedbackReason[];
    comment?: string;
    userId?: string;
    channel: string;
    portalId?: string;
    removed: boolean;
    createdAt: string;
    updatedAt: string;
}

/** The ratings of the message at `index` of the stored transcript (newest first when several people rated it). */
export function feedbackForMessage(rows: readonly SessionMessageFeedback[], index: number): SessionMessageFeedback[] {
    return rows
        .filter((row) => row.messageIndex === index && !row.removed)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The index a turn of the on-screen list has in the STORED transcript: the page
 * also holds client-only `error` turns (a failed send, until reload), which the
 * server never stored.
 */
export function persistedIndexOf(messages: ReadonlyArray<{ role: string }>, index: number): number {
    let stored = 0;
    for (let i = 0; i < index; i += 1) if (messages[i]?.role !== 'error') stored += 1;
    return stored;
}

/** The on-screen position of the stored message `storedIndex` (for a `?message=` deep link); -1 when it is not on screen. */
export function screenIndexOf(messages: ReadonlyArray<{ role: string }>, storedIndex: number): number {
    let stored = 0;
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].role === 'error') continue;
        if (stored === storedIndex) return i;
        stored += 1;
    }
    return -1;
}
