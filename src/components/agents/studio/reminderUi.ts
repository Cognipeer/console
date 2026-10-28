/**
 * Reminders in the studio — the row shape the API sends and the small pure
 * rules the views share (when to show the Reminders view, how far ahead a
 * time is, which statuses count as "still to come").
 */

import type { IAgentRemindersConfig } from '@/lib/database/provider/types.domain';

/** A reminder as `GET /api/agents/:id/reminders` sends it. */
export interface AgentReminderView {
    id: string;
    object: 'agent.reminder';
    agent: string;
    session_id: string;
    status: 'scheduled' | 'queued' | 'running' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
    /** Epoch seconds. */
    fire_at: number;
    /** Null when `restricted`. */
    message: string | null;
    reason: string | null;
    set_by_run: string | null;
    chain: number;
    created_at: number;
    completed_at: number | null;
    error: { type?: string; message?: string | null } | null;
    owner?: { id: string; name?: string; email?: string };
    session_title?: string;
    /** Its session used knowledge base documents this viewer may not read: listed without its message or session title. */
    restricted?: boolean;
}

export interface AgentRemindersResponse {
    reminders: AgentReminderView[];
    summary?: { active?: number };
    scope?: { viewOthers?: boolean };
}

/** The runs that have not finished: a `scheduled` reminder can still be fired now or canceled. */
export function isUpcomingReminder(reminder: Pick<AgentReminderView, 'status'>): boolean {
    return reminder.status === 'scheduled';
}

/** A reminder whose wake turn is still to come: waiting, or fired and queued or running now. */
export function isPendingWake(reminder: Pick<AgentReminderView, 'status'>): boolean {
    return reminder.status === 'scheduled' || reminder.status === 'queued' || reminder.status === 'running';
}

/**
 * The Reminders view sits next to the sessions list only for an agent that
 * uses reminders: switched on (draft or published), or one that has ever set
 * one. Everyone else sees the plain list and no control at all.
 */
export function showRemindersView(input: {
    draft?: IAgentRemindersConfig | null;
    published?: IAgentRemindersConfig | null;
    hasAny: boolean;
}): boolean {
    return input.draft?.enabled === true || input.published?.enabled === true || input.hasAny;
}

/** "in 12m" / "in 3h" / "in 2d" for a time ahead, "due" once it has passed. `say` is `useTranslations('agents.reminders')`. */
export function formatUntil(epochSeconds: number, say: (key: string, params?: Record<string, string | number>) => string, nowMs = Date.now()): string {
    const seconds = Math.round(epochSeconds - nowMs / 1000);
    if (seconds <= 0) return say('due');
    if (seconds < 60) return say('inSeconds', { count: seconds });
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return say('inMinutes', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return say('inHours', { count: hours });
    return say('inDays', { count: Math.round(hours / 24) });
}

/** The tooltip on a session row's clock icon. */
export function reminderRowHint(
    reminders: { active: number; nextAt: string },
    say: (key: string, params?: Record<string, string | number>) => string,
    nowMs = Date.now(),
): string {
    const next = Date.parse(reminders.nextAt);
    const when = Number.isFinite(next) ? formatUntil(next / 1000, say, nowMs) : '';
    return say('rowHint', { count: reminders.active, when });
}

export type ReminderStatusFilter = 'active' | 'all' | 'succeeded' | 'failed' | 'canceled';

/** `active` / `all` are server filters; the finished statuses are picked from the full list. */
export function reminderQueryStatus(filter: ReminderStatusFilter): 'active' | 'all' {
    return filter === 'active' ? 'active' : 'all';
}

export function filterReminders(
    reminders: AgentReminderView[],
    filter: ReminderStatusFilter,
    ownerId: string | null,
): AgentReminderView[] {
    return reminders.filter((reminder) => {
        if (ownerId && reminder.owner?.id !== ownerId) return false;
        if (filter === 'succeeded' || filter === 'failed' || filter === 'canceled') return reminder.status === filter;
        return true;
    });
}

/** Who a reminder belongs to, in words. */
export function reminderOwnerText(reminder: Pick<AgentReminderView, 'owner'>): string {
    return reminder.owner?.name || reminder.owner?.email || reminder.owner?.id || '';
}

/** The framed note's own text for a transcript message, or null for an ordinary message. */
export function reminderOfMessage(message: { metadata?: { origin?: string; reminder?: { runId: string; message: string; setAt?: string } } }): { runId: string; message: string; setAt?: string } | null {
    return message.metadata?.origin === 'reminder' && message.metadata.reminder ? message.metadata.reminder : null;
}

/** Merges a change into the stored reminders config; a cleared field is dropped, not stored as undefined. */
export function patchReminders(value: IAgentRemindersConfig | undefined, patch: Partial<IAgentRemindersConfig>): IAgentRemindersConfig | undefined {
    const next: Record<string, unknown> = { ...(value ?? {}), ...patch };
    for (const key of Object.keys(next)) {
        if (next[key] === undefined || next[key] === '') delete next[key];
    }
    return Object.keys(next).length > 0 ? next as IAgentRemindersConfig : undefined;
}
