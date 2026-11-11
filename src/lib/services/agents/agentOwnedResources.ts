/**
 * MCP servers and skills created inside an agent (`IAgentResourceOwner`).
 *
 * Such a record is part of its agent. Only that agent lists it, binds it, runs it and manages it: it is not in the
 * MCP hub or the skill library, another agent cannot bind or run it, the client API and the public MCP endpoint do
 * not serve it, and it is deleted together with the agent. The record still lives in the MCP server / skill store,
 * so everything a server or skill already has (credentials, tool discovery, guardrails, logs) works unchanged.
 */

import {
    getDatabase,
    runWithTenantScope,
    type IAgentResourceOwner,
    type OwnedResourceListFilter,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agent-owned-resources');

/** Longest agent id accepted from a request (ids are 24-hex ObjectIds or UUIDs). */
const MAX_AGENT_ID_LENGTH = 128;

/** Whether `agentId` may use a record: a shared record (no owner) is usable by any agent, an owned one by its agent only. */
export function isUsableByAgent(record: { owner?: IAgentResourceOwner | null } | null | undefined, agentId: string | undefined): boolean {
    if (!record) return false;
    return !record.owner || (Boolean(agentId) && record.owner.agentId === agentId);
}

/** The agent id a request names (`ownerAgentId` on a create, `agentId` on a list): absent, or a sane id, or an error. */
export function readAgentIdInput(value: unknown, field: string): { ok: true; agentId?: string } | { ok: false; error: string } {
    if (value === undefined || value === null || value === '') return { ok: true };
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_AGENT_ID_LENGTH) {
        return { ok: false, error: `${field} must be an agent id` };
    }
    return { ok: true, agentId: value.trim() };
}

/**
 * The list filter a request asks for: `agentId` alone lists the project's shared records plus that agent's own
 * (what the agent's pickers show); with `owned=only`, that agent's own records only (its "own servers / skills"
 * list). Without `agentId` a list has shared records only.
 */
export function ownedListFilterOf(query: { agentId?: unknown; owned?: unknown }): { ok: true; filter: OwnedResourceListFilter } | { ok: false; error: string } {
    const agent = readAgentIdInput(query.agentId, 'agentId');
    if (!agent.ok) return agent;
    if (query.owned !== undefined && query.owned !== 'only') return { ok: false, error: 'owned must be "only"' };
    if (!agent.agentId) {
        return query.owned === 'only' ? { ok: false, error: 'owned=only needs an agentId' } : { ok: true, filter: {} };
    }
    return {
        ok: true,
        filter: query.owned === 'only'
            ? { ownerAgentId: agent.agentId, owned: 'only' }
            : { ownerAgentId: agent.agentId, owned: 'include' },
    };
}

/**
 * The owner for a record created inside agent `agentId` of `projectId`, or null when there is no such agent in
 * that project (the request is then refused: a record can only belong to an agent of its own project).
 */
export async function resolveOwningAgent(
    tenantDbName: string,
    projectId: string,
    agentId: string,
): Promise<IAgentResourceOwner | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const agent = await db.findAgentById(agentId).catch(() => null);
    if (!agent || String(agent.projectId ?? '') !== String(projectId)) return null;
    return { kind: 'agent', agentId: String(agent._id) };
}

/**
 * Removes the MCP servers and skills agent `agentId` owns, after the agent itself was deleted. Each one goes through
 * its own delete (an MCP server releases its runtime and leaves the composites it was in); one failing does not stop
 * the rest, it is logged and stays behind as an orphan nobody can list.
 */
export async function deleteAgentOwnedResources(
    tenantDbName: string,
    agentId: string,
): Promise<{ mcpServers: number; skills: number }> {
    const { deleteMcpServer } = await import('@/lib/services/mcp/mcpService');
    const owned: OwnedResourceListFilter = { ownerAgentId: agentId, owned: 'only' };
    const { servers, skills } = await runWithTenantScope(tenantDbName, async (db) => ({
        servers: await db.listMcpServers(owned),
        skills: await db.listSkills(owned),
    }));

    let mcpServers = 0;
    for (const server of servers) {
        try {
            if (await deleteMcpServer(tenantDbName, String(server._id))) mcpServers += 1;
        } catch (error) {
            logger.warn('Could not delete an MCP server of a deleted agent', { agentId, serverKey: server.key, error });
        }
    }
    let removedSkills = 0;
    for (const skill of skills) {
        try {
            if (await runWithTenantScope(tenantDbName, (db) => db.deleteSkill(String(skill._id)))) removedSkills += 1;
        } catch (error) {
            logger.warn('Could not delete a skill of a deleted agent', { agentId, skillKey: skill.key, error });
        }
    }
    return { mcpServers, skills: removedSkills };
}
