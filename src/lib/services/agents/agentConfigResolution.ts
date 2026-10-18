/**
 * Which stored config of an agent a run executes. A leaf module (it needs only
 * the database) so the services that prepare a run — the spend pre-flight, the
 * sub-agent roster — can ask it without importing the run engine.
 * `agentService` re-exports `resolveAgentConfig`, the name every caller knows.
 */

import { getDatabase, type IAgent } from '@/lib/database';

/**
 * Resolves the agent config to use for execution.
 * - If a specific version is requested, returns that version's config.
 * - For API/SDK calls (not playground), uses the published version.
 * - Falls back to current agent config if no version is published (backward compat).
 */
export async function resolveAgentConfig(
    tenantDbName: string,
    agentKey: string,
    projectId?: string,
    requestedVersion?: number,
): Promise<{ agent: IAgent; config: IAgent['config']; resolvedVersion: number | null }> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const agent = await db.findAgentByKey(agentKey, projectId);
    if (!agent) throw new Error(`Agent "${agentKey}" not found`);

    // If a specific version is requested
    if (requestedVersion !== undefined && requestedVersion !== null) {
        const version = await db.findAgentVersion(String(agent._id), requestedVersion);
        if (!version) {
            throw new Error(`Version ${requestedVersion} not found for agent "${agentKey}"`);
        }
        return { agent, config: version.snapshot.config, resolvedVersion: version.version };
    }

    // Use published version if available
    if (agent.publishedVersion) {
        const version = await db.findAgentVersion(String(agent._id), agent.publishedVersion);
        if (version) return { agent, config: version.snapshot.config, resolvedVersion: version.version };
    }

    // Fallback to current config (never published or version data missing)
    return { agent, config: agent.config, resolvedVersion: null };
}
