import { notifications } from '@mantine/notifications';

/** POSTs to a run's `cancel` / `fire` route; true when it went through (the failure is shown). */
async function postRunAction(agentId: string, runId: string, action: 'cancel' | 'fire', failed: string): Promise<boolean> {
    try {
        const res = await fetch(`/api/agents/${agentId}/runs/${runId}/${action}`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
        return true;
    } catch (error) {
        notifications.show({ color: 'red', message: `${failed}: ${error instanceof Error ? error.message : String(error)}` });
        return false;
    }
}

export const cancelReminder = (agentId: string, runId: string, failed: string) => postRunAction(agentId, runId, 'cancel', failed);
export const fireReminderNow = (agentId: string, runId: string, failed: string) => postRunAction(agentId, runId, 'fire', failed);
