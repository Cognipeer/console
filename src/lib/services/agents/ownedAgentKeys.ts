/**
 * The keys of the hidden agents flows own. Session and run lists leave their
 * sessions and runs out: those belong to the flow run that started them and are
 * reached through the flow (and through tracing), not through the agent lists.
 */
import { runWithTenantScope } from '@/lib/database';

export async function listOwnedAgentKeys(tenantDbName: string, projectId: string): Promise<string[]> {
    return runWithTenantScope(tenantDbName, async (db) => {
        return db.listOwnedAgentKeys(projectId);
    });
}
