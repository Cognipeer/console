import { notifications } from '@mantine/notifications';
import { apiPost } from '@/lib/api/client';
import { httpErrorOr } from '@/lib/api/queries/agents';

/** POSTs to a run's `cancel` / `fire` route; true when it went through (the failure is shown). */
async function postRunAction(agentId: string, runId: string, action: 'cancel' | 'fire', failed: string): Promise<boolean> {
    try {
        await apiPost(`/api/agents/${agentId}/runs/${runId}/${action}`);
        return true;
    } catch (error) {
        notifications.show({ color: 'red', message: `${failed}: ${httpErrorOr(error)}` });
        return false;
    }
}

export const cancelReminder = (agentId: string, runId: string, failed: string) => postRunAction(agentId, runId, 'cancel', failed);
export const fireReminderNow = (agentId: string, runId: string, failed: string) => postRunAction(agentId, runId, 'fire', failed);
