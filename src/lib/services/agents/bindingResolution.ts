/**
 * How an agent's references — tool / MCP bindings and the Knowledge Engine
 * module — resolve to records. Shared by the runtime (`buildBoundTools`,
 * `buildKnowledgeTools`) and config validation so a save is checked exactly the
 * way a run resolves it.
 *
 * Keys are unique per PROJECT only (tool and MCP keys are plain name slugs), so
 * a key-only lookup can answer with ANOTHER project's row and run it with that
 * project's upstream credentials. Every reference is resolved in the agent's
 * own project first and may otherwise fall back only to the tenant-wide row
 * (stored without a projectId) — never to a different project's.
 *
 * An MCP server created inside an agent (`owner`) resolves for that agent only: for any other agent it does not
 * exist, so another agent can neither save a binding to it nor run it.
 */

import { getMcpServerByKey } from '@/lib/services/mcp';
import { getRagModule } from '@/lib/services/rag/ragService';
import { getToolByKey } from '@/lib/services/tools';
import { isUsableByAgent } from './agentOwnedResources';

export async function resolveAgentBindingTool(tenantDbName: string, key: string, projectId: string | undefined) {
    const scoped = projectId ? await getToolByKey(tenantDbName, key, projectId) : null;
    return scoped ?? getToolByKey(tenantDbName, key, null);
}

export async function resolveAgentBindingMcpServer(
    tenantDbName: string,
    key: string,
    projectId: string | undefined,
    /** The agent the binding belongs to; without it only shared servers resolve. */
    agentId?: string,
) {
    const scoped = projectId ? await getMcpServerByKey(tenantDbName, key, projectId) : null;
    if (isUsableByAgent(scoped, agentId)) return scoped;
    const tenantWide = await getMcpServerByKey(tenantDbName, key, null);
    return isUsableByAgent(tenantWide, agentId) ? tenantWide : null;
}

export async function resolveAgentKnowledgeModule(tenantDbName: string, key: string, projectId: string | undefined) {
    const scoped = projectId ? await getRagModule(tenantDbName, key, projectId) : null;
    // '' asks the module lookup for the tenant-wide row only.
    return scoped ?? getRagModule(tenantDbName, key, '');
}
