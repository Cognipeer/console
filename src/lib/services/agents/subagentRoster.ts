/**
 * The sub-agents a run can actually delegate to.
 *
 * `config.subagents` is what an author declared; what runs is less: a policy of
 * `off` switches delegation off for the whole roster (the SDK ignores it), an entry
 * can be switched off on its own, and a `ref` entry only runs when the agent it
 * points at can be loaded. Everything that prepares or accounts for children starts
 * from the answer here — building them, checking the spend limits of their models,
 * pricing their calls — so a roster that cannot run costs nothing and checks nothing,
 * and the pre-flight and the build never disagree about which children exist.
 *
 * A leaf module: it needs only the database, so the spend pre-flight can use it
 * without importing the run engine.
 */

import type { IAgent, IAgentConfig } from '@/lib/database';
import type { IAgentSubagent } from '@/lib/database/provider/types.domain';
import { resolveAgentConfig } from './agentConfigResolution';

/**
 * The entries a run may delegate to: none when the policy is `off`, otherwise
 * every entry that is not switched off.
 */
export function activeSubagentEntries(config: Pick<IAgentConfig, 'subagents' | 'subagentPolicy'>): IAgentSubagent[] {
    if (config.subagentPolicy?.mode === 'off') return [];
    return (config.subagents ?? []).filter((entry) => entry.enabled !== false);
}

/** Why a `ref` entry cannot run, or the agent it points at. */
export type SubagentTarget =
    | { ok: true; agent: IAgent; config: IAgent['config']; resolvedVersion: number | null }
    | { ok: false; reason: 'no_agent_key' | 'unresolved' | 'external' | 'flow' | 'inactive' | 'owned'; message: string };

/**
 * Loads the agent a `ref` entry points at, the way a run of that agent would
 * (the pinned version, else the PUBLISHED one: editing a draft never changes
 * what a parent delegates to mid-flight), or says why the entry cannot run: an
 * agent that is not active is not run by anything else on the platform either
 * (a request, a trigger, a schedule), and delegation is no way around that.
 * The message is written for the person who owns the parent agent.
 */
export async function resolveSubagentTarget(
    tenantDbName: string,
    projectId: string,
    entry: Pick<IAgentSubagent, 'name' | 'agentKey' | 'agentVersion'>,
): Promise<SubagentTarget> {
    if (!entry.agentKey) {
        return { ok: false, reason: 'no_agent_key', message: `Sub-agent "${entry.name}" was skipped: it points at no agent.` };
    }
    let resolved: Awaited<ReturnType<typeof resolveAgentConfig>>;
    try {
        resolved = await resolveAgentConfig(tenantDbName, entry.agentKey, projectId, entry.agentVersion);
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: 'unresolved', message: `Sub-agent "${entry.name}" was skipped: ${why}.` };
    }
    if (resolved.agent.owner) {
        // A hidden agent a flow node owns is reachable only through that flow, never as someone's sub-agent.
        return { ok: false, reason: 'owned', message: `Sub-agent "${entry.name}" was skipped: agent "${entry.agentKey}" does not exist.` };
    }
    if (resolved.config.kind === 'external') {
        // An external agent is an HTTP endpoint, not a set of tools: it cannot be flattened into a child of this process.
        return {
            ok: false,
            reason: 'external',
            message: `Sub-agent "${entry.name}" was skipped: "${entry.agentKey}" is a connected agent, and only agents that run on this platform can be delegated to.`,
        };
    }
    if (resolved.config.kind === 'flow') {
        // A FlowBase agent answers through a flow, not a model loop: there are no tools or prompt to flatten into a child.
        return {
            ok: false,
            reason: 'flow',
            message: `Sub-agent "${entry.name}" was skipped: "${entry.agentKey}" is a FlowBase agent, and only agents with a model loop can be delegated to.`,
        };
    }
    if (resolved.agent.status && resolved.agent.status !== 'active') {
        return {
            ok: false,
            reason: 'inactive',
            message: `Sub-agent "${entry.name}" was skipped: agent "${entry.agentKey}" is not active (${resolved.agent.status}).`,
        };
    }
    return { ok: true, ...resolved };
}

/**
 * The model keys the roster's children would call, for the tenant spend
 * pre-flight (the counters are per model key). An entry's own `modelKey` wins;
 * a `ref` entry otherwise takes its target's. A child with no model of its own
 * runs on the parent's, which the caller checks anyway, and a `ref` that cannot
 * be loaded is skipped at run time and so checks nothing.
 */
export async function subagentModelKeys(
    tenantDbName: string,
    projectId: string,
    config: Pick<IAgentConfig, 'subagents' | 'subagentPolicy'>,
): Promise<string[]> {
    const keys = new Set<string>();
    for (const entry of activeSubagentEntries(config)) {
        let modelKey = entry.modelKey;
        if (entry.kind === 'ref') {
            const target = await resolveSubagentTarget(tenantDbName, projectId, entry);
            if (!target.ok) continue;
            modelKey = entry.modelKey ?? target.config.modelKey;
        }
        if (modelKey) keys.add(modelKey);
    }
    return [...keys];
}
