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
    IToolAction,
    IToolActionAnnotations,
} from '@/lib/database/provider/types.domain';
import type { McpSourceType } from '@/lib/database/provider/types.extended';
import { classifyTool, clientApprovalConfig, resolveHitlConfig, toolApprovalPolicy, toolApprovalPolicySource } from '@/lib/services/agents/agentHumanInTheLoop';
import { effectiveActionAnnotations, mcpToolMarkings, type ToolKind } from '@/lib/services/tools/actionAnnotations';
import { defaultAnnotationsForSource } from '@/lib/services/mcp/toolAnnotations';
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
    /** What the tool does, as far as approval is concerned: reads, writes, destructive or no hints (a bound tool whose source says nothing). */
    kind: ToolKind;
    /** Reads only: not asked about unless a per-tool setting says so. */
    readOnly: boolean;
    /** Set for a bound tool: the class the runtime decides its approval by (`toolApprovalPolicy`'s third argument). */
    boundKind?: ToolKind;
    /** What is stored for this tool: `default` = no per-tool entry. */
    choice: ToolPolicyChoice;
    /** What the runtime will do with a call to it, given the default policy and the read-only exemption. */
    effective: AgentToolApprovalPolicy;
    /** What choosing "Ask" stores: no entry when asking is already this tool's default, else an explicit `always`. */
    askChoice: ToolPolicyChoice;
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
/**
 * The kind of every bound tool the agent has, by tool name (what `buildBoundTools` classifies at run time).
 * A bound tool missing from it (its record is not loaded, or is gone) counts as `nohints`: it asks.
 */
export type HitlToolKinds = Readonly<Record<string, ToolKind | undefined>>;

/** Bound tools (Tools service, MCP servers) are classified from their markings; everything else by name. */
function rowKind(origin: ToolOrigin | 'client' | 'unknown', name: string, kinds: HitlToolKinds | undefined): { kind: ToolKind; bound: ToolKind | undefined } {
    if (origin === 'tool' || origin === 'mcp') {
        const kind = kinds?.[name] ?? 'nohints';
        return { kind, bound: kind };
    }
    return { kind: classifyTool(name), bound: undefined };
}

export function hitlToolRows(
    toolConfig: AgentToolConfig | undefined,
    hitl: IAgentHumanInTheLoopConfig | undefined,
    clientTools?: ReadonlyArray<{ name: string }>,
    toolKinds?: HitlToolKinds,
): HitlToolRow[] {
    const resolved = resolveHitlConfig(hitl);
    // Client tools ask by default only once approval was switched on explicitly (see `clientApprovalConfig`).
    const clientResolved = clientApprovalConfig(resolved);
    const askChoiceOf = (defaultPolicy: AgentToolApprovalPolicy): ToolPolicyChoice => (defaultPolicy === 'never' ? 'always' : 'default');
    const stored = hitl?.toolApproval?.tools ?? {};
    const storedExceptions = hitl?.toolApproval?.exceptions ?? {};
    const exceptionsOf = (name: string) => (Array.isArray(storedExceptions[name]) ? storedExceptions[name] : []);
    const rows: HitlToolRow[] = [];
    const seen = new Set<string>();

    for (const tool of collectConfiguredTools(toolConfig)) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        const entry = stored[tool.name];
        const { kind, bound } = rowKind(tool.origin, tool.name, toolKinds);
        rows.push({
            name: tool.name,
            origin: tool.origin,
            sourceKey: tool.sourceKey,
            kind,
            readOnly: kind === 'reads',
            ...(bound ? { boundKind: bound } : {}),
            choice: entry === 'always' || entry === 'never' ? entry : 'default',
            effective: toolApprovalPolicy(resolved, tool.name, bound),
            askChoice: askChoiceOf(resolved.defaultPolicy),
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
            kind: 'writes',
            readOnly: false,
            choice: entry === 'always' || entry === 'never' ? entry : 'default',
            // A page's tool is never exempt as read-only (`clientToolNeedsApproval`).
            effective: toolApprovalPolicy(clientResolved, name, 'writes'),
            askChoice: askChoiceOf(clientResolved.defaultPolicy),
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
            kind: classifyTool(name),
            readOnly: classifyTool(name) === 'reads',
            choice: entry === 'always' || entry === 'never' ? entry : 'default',
            effective: toolApprovalPolicy(resolved, name),
            askChoice: askChoiceOf(resolved.defaultPolicy),
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
    // A new block leaves `enabled` unset: on for bound tools, and client tools are not switched on by it.
    const approval = hitl?.toolApproval ?? {};
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
    kind?: ToolKind,
): { decision: HitlCallDecision; index: number | null } {
    const resolved = resolveHitlConfig(hitl);
    const usable = normalizeToolExceptions({ [tool]: exceptions.map(cleanException) })[tool] ?? [];
    const decision = decideToolCall(
        { policy: toolApprovalPolicy(resolved, tool, kind), source: toolApprovalPolicySource(resolved, tool, kind) },
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
    // A new block leaves `enabled` unset: on for bound tools, and client tools are not switched on by it.
    const approval = hitl?.toolApproval ?? {};
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

/** The part of a tool record (`/api/tools`) or MCP server (`/api/mcp`) the kinds are read from. */
export interface KindSourceRecord {
    key: string;
    actions?: ReadonlyArray<Pick<IToolAction, 'key' | 'name' | 'executionType' | 'httpMethod' | 'annotations'>>;
    tools?: ReadonlyArray<{ name: string; annotations?: IToolActionAnnotations; httpMethod?: string }>;
    /** MCP server: the operator's annotation overrides by tool name, and the server's source type. */
    toolAnnotations?: Record<string, unknown>;
    sourceType?: string;
}

/**
 * The kind of each tool the agent binds from the Tools service or an MCP server, by the name the table lists
 * it under (the same classification the runtime makes in `buildBoundTools`). A binding whose record is not in
 * `tools` / `mcpServers` gets no entry, which the table reads as "no hints".
 */
export function boundToolKinds(
    bindings: ReadonlyArray<{ source?: string; sourceKey?: string; toolNames?: string[] }> | undefined,
    tools: ReadonlyArray<KindSourceRecord> | undefined,
    mcpServers: ReadonlyArray<KindSourceRecord> | undefined,
): Record<string, ToolKind> {
    const kinds: Record<string, ToolKind> = {};
    for (const binding of bindings ?? []) {
        if (binding.source === 'mcp') {
            const server = mcpServers?.find((candidate) => candidate.key === binding.sourceKey);
            for (const name of binding.toolNames ?? []) {
                const def = server?.tools?.find((candidate) => candidate.name === name);
                if (def && server) {
                    const overrides = server.toolAnnotations ?? {};
                    kinds[name] = classifyTool(def.name, mcpToolMarkings(
                        def,
                        Object.hasOwn(overrides, name) ? overrides[name] : undefined,
                        defaultAnnotationsForSource(server.sourceType as McpSourceType | undefined),
                    ));
                }
            }
        } else if (binding.source === 'tool' || binding.source === undefined) {
            const record = tools?.find((candidate) => candidate.key === binding.sourceKey);
            for (const name of binding.toolNames ?? []) {
                const action = record?.actions?.find((candidate) => candidate.key === name || candidate.name === name);
                if (action) kinds[name] = classifyTool(action.name, effectiveActionAnnotations(action));
            }
        }
    }
    return kinds;
}
