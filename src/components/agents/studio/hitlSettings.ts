/**
 * The pure half of Configure → Approvals & questions: which tools the table
 * lists, what each row currently resolves to, and how an edit lands in the
 * stored `humanInTheLoop` object.
 *
 * Nothing here decides policy — `resolveHitlConfig` / `toolApprovalPolicy` in
 * the service (`agentHumanInTheLoop.ts`) do, and the table asks them, so what
 * the editor shows is what the runtime will do.
 */

import type {
    AgentToolApprovalException,
    AgentToolApprovalPolicy,
    IAgentHumanInTheLoopConfig,
} from '@/lib/database/provider/types.domain';
import { isReadOnlyTool, resolveHitlConfig, toolApprovalPolicy, toolApprovalPolicySource } from '@/lib/services/agents/agentHumanInTheLoop';
import {
    decideToolCall,
    exceptionIssue,
    normalizeToolExceptions,
    type ExceptionIssue,
    type HitlCallDecision,
} from '@/lib/services/agents/agentHitlExceptions';
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
    /** Its approval exceptions, as stored. */
    exceptions: AgentToolApprovalException[];
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
    const storedExceptions = hitl?.toolApproval?.exceptions ?? {};
    const exceptionsOf = (name: string) => (Array.isArray(storedExceptions[name]) ? storedExceptions[name] : []);
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
            exceptions: exceptionsOf(tool.name),
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
            exceptions: exceptionsOf(name),
        });
    }

    // Settings left for tools the agent no longer has: kept visible so they can be removed.
    for (const name of new Set([...Object.keys(stored), ...Object.keys(storedExceptions)])) {
        if (seen.has(name)) continue;
        const entry = stored[name];
        rows.push({
            name,
            origin: 'unknown',
            readOnly: isReadOnlyTool(name),
            choice: entry === 'always' || entry === 'never' ? entry : 'default',
            effective: toolApprovalPolicy(resolved, name),
            exceptions: exceptionsOf(name),
            stale: true,
        });
    }
    return rows;
}

/** Replaces one tool's exceptions; an empty list removes its entry (and the `exceptions` map once it is empty). */
export function setToolExceptions(
    hitl: IAgentHumanInTheLoopConfig | undefined,
    tool: string,
    exceptions: AgentToolApprovalException[],
): IAgentHumanInTheLoopConfig {
    const approval = hitl?.toolApproval ?? { enabled: false };
    const all = { ...(approval.exceptions ?? {}) };
    if (exceptions.length === 0) delete all[tool];
    else all[tool] = exceptions;
    const rest = { ...approval };
    delete rest.exceptions;
    return {
        ...(hitl ?? {}),
        toolApproval: { ...rest, ...(Object.keys(all).length > 0 ? { exceptions: all } : {}) },
    };
}

/** An exception as it is saved: a blank field means "any argument" and is left out. */
export function cleanException(exception: AgentToolApprovalException): AgentToolApprovalException {
    const field = exception.field?.trim();
    return { ...(field ? { field } : {}), pattern: exception.pattern.trim(), action: exception.action };
}

/** What stops each exception from being saved as it is (null = nothing), in order. */
export function exceptionIssues(exceptions: readonly AgentToolApprovalException[]): Array<ExceptionIssue | null> {
    return exceptions.map((exception) => exceptionIssue(cleanException(exception)));
}

/**
 * What the runtime would do with a call that has these arguments, given the
 * exceptions being edited: the verdict, and which of them (by index) decided.
 */
export function previewToolCall(
    hitl: IAgentHumanInTheLoopConfig | undefined,
    tool: string,
    exceptions: readonly AgentToolApprovalException[],
    args: unknown,
): { decision: HitlCallDecision; index: number | null } {
    const resolved = resolveHitlConfig(hitl);
    const usable = normalizeToolExceptions({ [tool]: exceptions.map(cleanException) })[tool] ?? [];
    const decision = decideToolCall(
        { policy: toolApprovalPolicy(resolved, tool), source: toolApprovalPolicySource(resolved, tool) },
        usable,
        args,
    );
    const matched = decision.exception;
    const index = matched
        ? exceptions.findIndex((candidate) => {
            const clean = cleanException(candidate);
            return clean.action === matched.action && clean.pattern === matched.pattern && (clean.field ?? '') === (matched.field ?? '');
        })
        : -1;
    return { decision, index: index >= 0 ? index : null };
}

/**
 * The argument names a JSON schema declares, as dot paths: its properties and,
 * one level down, the properties of the ones that are objects themselves.
 */
export function schemaFieldPaths(schema: unknown, prefix = '', depth = 0): string[] {
    if (!schema || typeof schema !== 'object') return [];
    const properties = (schema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== 'object') return [];
    const paths: string[] = [];
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        paths.push(path);
        if (depth < 1) paths.push(...schemaFieldPaths(child, path, depth + 1));
    }
    return paths;
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
