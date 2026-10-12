/**
 * The pure half of Configure → Approvals & questions: which tools the table
 * lists, what each row currently resolves to, and how an edit lands in the
 * stored `humanInTheLoop` object.
 *
 * Nothing here decides policy — `resolveHitlConfig` / `toolApprovalPolicy` in
 * the service (`agentHumanInTheLoop.ts`) do, and the table asks them, so what
 * the editor shows is what the runtime will do.
 */

import type { AgentToolApprovalPolicy, IAgentHumanInTheLoopConfig } from '@/lib/database/provider/types.domain';
import { isReadOnlyTool, resolveHitlConfig, toolApprovalPolicy } from '@/lib/services/agents/agentHumanInTheLoop';
import { collectConfiguredTools, type AgentToolConfig, type ToolOrigin } from '../session/sessionTools';

export type ToolPolicyChoice = 'default' | AgentToolApprovalPolicy;

export interface HitlToolRow {
    name: string;
    origin: ToolOrigin | 'client' | 'unknown';
    sourceKey?: string;
    /** Read-only built-in: not asked about unless a per-tool setting says so. */
    readOnly: boolean;
    /** What is stored for this tool: `default` = no per-tool entry. */
    choice: ToolPolicyChoice;
    /** What the runtime will do with a call to it, given the default policy and the read-only exemption. */
    effective: AgentToolApprovalPolicy;
    /** A per-tool entry for a tool this agent no longer has. */
    stale?: boolean;
}

/**
 * One row per tool this agent can call (deduplicated by name), then any
 * per-tool entries that no longer match a tool, so a leftover setting stays
 * visible and removable.
 */
export function hitlToolRows(
    toolConfig: AgentToolConfig | undefined,
    hitl: IAgentHumanInTheLoopConfig | undefined,
    clientTools?: ReadonlyArray<{ name: string }>,
): HitlToolRow[] {
    const resolved = resolveHitlConfig(hitl);
    const stored = hitl?.toolApproval?.tools ?? {};
    const rows: HitlToolRow[] = [];
    const seen = new Set<string>();

    for (const tool of collectConfiguredTools(toolConfig)) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        const entry = stored[tool.name];
        rows.push({
            name: tool.name,
            origin: tool.origin,
            sourceKey: tool.sourceKey,
            readOnly: isReadOnlyTool(tool.name),
            choice: entry === 'always' || entry === 'never' ? entry : 'default',
            effective: toolApprovalPolicy(resolved, tool.name),
        });
    }

    // Tools the caller runs (Configure → Client tools): approval is decided here, with the rest.
    for (const tool of clientTools ?? []) {
        const name = tool.name.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const entry = stored[name];
        rows.push({
            name,
            origin: 'client',
            readOnly: false,
            choice: entry === 'always' || entry === 'never' ? entry : 'default',
            effective: toolApprovalPolicy(resolved, name),
        });
    }

    for (const [name, entry] of Object.entries(stored)) {
        if (seen.has(name)) continue;
        rows.push({
            name,
            origin: 'unknown',
            readOnly: isReadOnlyTool(name),
            choice: entry === 'always' || entry === 'never' ? entry : 'default',
            effective: toolApprovalPolicy(resolved, name),
            stale: true,
        });
    }
    return rows;
}

/** Sets one tool's policy; `default` removes its entry (and the `tools` map once it is empty). */
export function setToolChoice(
    hitl: IAgentHumanInTheLoopConfig | undefined,
    tool: string,
    choice: ToolPolicyChoice,
): IAgentHumanInTheLoopConfig {
    const approval = hitl?.toolApproval ?? { enabled: false };
    const tools = { ...(approval.tools ?? {}) };
    if (choice === 'default') delete tools[tool];
    else tools[tool] = choice;
    const rest = { ...approval };
    delete rest.tools;
    return {
        ...(hitl ?? {}),
        toolApproval: { ...rest, ...(Object.keys(tools).length > 0 ? { tools } : {}) },
    };
}

/** Merges a change into the stored object; a key set to `undefined` is dropped so the runtime default applies again. */
export function patchHitl(
    hitl: IAgentHumanInTheLoopConfig | undefined,
    patch: Partial<IAgentHumanInTheLoopConfig>,
): IAgentHumanInTheLoopConfig {
    const next: Record<string, unknown> = { ...(hitl ?? {}), ...patch };
    for (const key of Object.keys(next)) {
        if (next[key] === undefined) delete next[key];
    }
    return next as IAgentHumanInTheLoopConfig;
}
