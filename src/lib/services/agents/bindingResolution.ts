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
 */

import { getMcpServerByKey } from '@/lib/services/mcp';
import { getRagModule } from '@/lib/services/rag/ragService';
import { getToolByKey } from '@/lib/services/tools';

export async function resolveAgentBindingTool(tenantDbName: string, key: string, projectId: string | undefined) {
    const scoped = projectId ? await getToolByKey(tenantDbName, key, projectId) : null;
    return scoped ?? getToolByKey(tenantDbName, key, null);
}

export async function resolveAgentBindingMcpServer(tenantDbName: string, key: string, projectId: string | undefined) {
    const scoped = projectId ? await getMcpServerByKey(tenantDbName, key, projectId) : null;
    return scoped ?? getMcpServerByKey(tenantDbName, key, null);
}

export async function resolveAgentKnowledgeModule(tenantDbName: string, key: string, projectId: string | undefined) {
    const scoped = projectId ? await getRagModule(tenantDbName, key, projectId) : null;
    // '' asks the module lookup for the tenant-wide row only.
    return scoped ?? getRagModule(tenantDbName, key, '');
}
