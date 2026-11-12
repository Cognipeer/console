'use client';

import { useSessionRemindersQuery } from '@/lib/api/queries/agents';
import { isPendingWake, type AgentReminderView } from './reminderUi';

/**
 * One session's reminders (`status`: the scheduled ones, or all of them with
 * the finished ones). Does not call the server while `enabled` is false, so
 * an agent that does not use reminders pays nothing; polls while a wake is
 * still to come (scheduled, or fired and not finished), so a fired one moves on to how it ended.
 */
export function useSessionReminders(agentId: string, sessionId: string | null | undefined, enabled: boolean, status: 'active' | 'all') {
    return useSessionRemindersQuery<AgentReminderView>(agentId, sessionId, enabled, status, (reminders) => reminders.some(isPendingWake));
}
