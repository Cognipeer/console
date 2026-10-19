'use client';

import { useCallback, useEffect, useState } from 'react';
import { isUpcomingReminder, type AgentReminderView, type AgentRemindersResponse } from './reminderUi';

const POLL_MS = 15_000;

/**
 * One session's reminders (`status`: the scheduled ones, or all of them with
 * the finished ones). Does not call the server while `enabled` is false, so
 * an agent that does not use reminders pays nothing; polls while any is scheduled.
 */
export function useSessionReminders(agentId: string, sessionId: string | null | undefined, enabled: boolean, status: 'active' | 'all') {
    const [reminders, setReminders] = useState<AgentReminderView[] | null>(null);

    const reload = useCallback(async () => {
        if (!enabled || !sessionId) return;
        try {
            const res = await fetch(`/api/agents/${agentId}/reminders?sessionId=${encodeURIComponent(sessionId)}&status=${status}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as AgentRemindersResponse;
            setReminders(data.reminders ?? []);
        } catch {
            setReminders((prev) => prev ?? []);
        }
    }, [agentId, sessionId, enabled, status]);

    useEffect(() => {
        setReminders(null);
        void reload();
    }, [reload]);

    const scheduled = (reminders ?? []).some(isUpcomingReminder);
    useEffect(() => {
        if (!scheduled) return;
        const timer = setInterval(() => { void reload(); }, POLL_MS);
        return () => clearInterval(timer);
    }, [scheduled, reload]);

    return { reminders, reload };
}
