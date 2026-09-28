/**
 * Translates the persisted `IAgentConfig.runtime` / `structuredOutput` blocks
 * into the agent-sdk option fragment the runtime passes to `createSmartAgent`.
 *
 * Two callers share this module on purpose:
 *   - `agentService` — builds the live agent
 *   - `agentCodegen` — emits the same options as source code
 *
 * so an exported project behaves like the agent that produced it. Anything the
 * console decides implicitly (tracing sink, plugins, bound tools) is NOT here;
 * this module only covers knobs an operator can set.
 *
 * Every default below is the value the module hard-coded before these knobs
 * existed, so an agent with no `runtime` block produces a byte-identical
 * option object.
 */

import { z, type ZodTypeAny } from 'zod';
import type { SmartAgentOptions } from '@cognipeer/agent-sdk';

import type {
    IAgentConfig,
    IAgentLimits,
    IAgentRuntimeConfig,
    IAgentStructuredOutput,
} from '@/lib/database/provider/types.domain';

export const CONSOLE_AGENT_DEFAULTS = {
    runtimeProfile: 'balanced' as const,
    maxToolCalls: 12,
    maxContextTokens: 48_000,
    summaryTriggerTokens: 32_000,
    summaryMaxTokens: 48_000,
    summaryPromptMaxTokens: 8_000,
    lastTurnsToKeep: 10,
    toolResponsePolicy: 'summarize_archive' as const,
    maxToolResponseChars: 80_000,
    maxToolResponseTokens: 20_000,
    /** knowledge_search results are the answer's evidence — never compacted. */
    toolResponseRetentionByTool: { knowledge_search: 'keep_full' } as Record<
        string,
        'keep_full' | 'keep_structured' | 'summarize_archive' | 'drop'
    >,
} as const;

/**
 * Shape handed to `createSmartAgent`, minus everything the console injects
 * (model, tools, plugins, tracing sink). Derived from the SDK's own option type
 * so a knob that changes shape upstream fails the build here instead of at run
 * time.
 */
export type ResolvedAgentRuntimeOptions = Pick<
    SmartAgentOptions,
    | 'runtimeProfile'
    | 'planning'
    | 'limits'
    | 'summarization'
    | 'context'
    | 'toolResponses'
    | 'contextPilot'
    | 'reasoning'
    | 'subagentPolicy'
>;

function positive(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Drops keys whose value is undefined so an absent knob stays absent on the wire. */
function compact<T extends Record<string, unknown>>(input: T): T {
    const out = {} as T;
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
    return out;
}

function resolveLimits(runtime: IAgentRuntimeConfig | undefined): IAgentLimits {
    const limits = runtime?.limits ?? {};
    return compact({
        maxToolCalls: positive(limits.maxToolCalls, CONSOLE_AGENT_DEFAULTS.maxToolCalls),
        maxContextTokens: positive(limits.maxContextTokens, CONSOLE_AGENT_DEFAULTS.maxContextTokens),
        maxParallelTools: limits.maxParallelTools,
        maxTotalOutputTokens: limits.maxTotalOutputTokens,
        maxCostUsd: limits.maxCostUsd,
        maxWallClockMs: limits.maxWallClockMs,
    });
}

/**
 * `reasoning.reflection` is tri-state on the SDK: absent keeps the profile
 * default, `false` disables it. `true` is expressed by leaving it absent, which
 * is why only the `false` case is emitted here.
 */
function resolveReasoning(runtime: IAgentRuntimeConfig | undefined) {
    const reasoning = runtime?.reasoning;
    if (!reasoning || reasoning.enabled === false) return undefined;
    const native = compact({
        effort: reasoning.effort,
        budgetTokens: reasoning.budgetTokens,
        includeThoughts: reasoning.includeThoughts,
    });
    return compact({
        enabled: true,
        level: reasoning.level,
        native: Object.keys(native).length > 0 ? native : undefined,
        reflection: reasoning.reflection === false ? (false as const) : undefined,
    });
}

// Memory is resolved separately, in `agentMemoryAdapter.ts` — it needs a real
// `MemoryStore` instance (backed by console's own Memory module) that this
// pure, config-only function has no way to construct, and it moved to its
// own tab (`IAgentConfig.memory`) rather than living under `runtime`.

export function resolveAgentRuntimeOptions(config: IAgentConfig): ResolvedAgentRuntimeOptions {
    const runtime = config.runtime;
    const planning = runtime?.planning;
    const summarization = runtime?.summarization;
    const context = runtime?.context;
    const toolResponses = runtime?.toolResponses;
    const contextPilot = runtime?.contextPilot;
    const policy = config.subagentPolicy;

    const resolved: ResolvedAgentRuntimeOptions = {
        runtimeProfile: runtime?.profile ?? CONSOLE_AGENT_DEFAULTS.runtimeProfile,
        planning: compact({
            mode: planning?.mode ?? 'off',
            replanPolicy: planning?.replanPolicy ?? 'on_failure',
            everyNSteps: planning?.replanPolicy === 'every_n_steps' ? planning?.everyNSteps : undefined,
        }) as ResolvedAgentRuntimeOptions['planning'],
        limits: resolveLimits(runtime),
        summarization: {
            enable: summarization?.enable ?? true,
            maxTokens: positive(summarization?.maxTokens, CONSOLE_AGENT_DEFAULTS.summaryMaxTokens),
            summaryTriggerTokens: positive(
                summarization?.summaryTriggerTokens,
                CONSOLE_AGENT_DEFAULTS.summaryTriggerTokens,
            ),
            summaryPromptMaxTokens: positive(
                summarization?.summaryPromptMaxTokens,
                CONSOLE_AGENT_DEFAULTS.summaryPromptMaxTokens,
            ),
            integrityCheck: summarization?.integrityCheck ?? true,
            ...(summarization?.summaryMode ? { summaryMode: summarization.summaryMode } : {}),
        },
        context: {
            policy: context?.policy ?? 'hybrid',
            lastTurnsToKeep: positive(context?.lastTurnsToKeep, CONSOLE_AGENT_DEFAULTS.lastTurnsToKeep),
            toolResponsePolicy: context?.toolResponsePolicy ?? CONSOLE_AGENT_DEFAULTS.toolResponsePolicy,
        },
        toolResponses: {
            defaultPolicy: toolResponses?.defaultPolicy ?? CONSOLE_AGENT_DEFAULTS.toolResponsePolicy,
            toolResponseRetentionByTool: {
                ...CONSOLE_AGENT_DEFAULTS.toolResponseRetentionByTool,
                ...(toolResponses?.retentionByTool ?? {}),
            },
            maxToolResponseChars: positive(
                toolResponses?.maxToolResponseChars,
                CONSOLE_AGENT_DEFAULTS.maxToolResponseChars,
            ),
            maxToolResponseTokens: positive(
                toolResponses?.maxToolResponseTokens,
                CONSOLE_AGENT_DEFAULTS.maxToolResponseTokens,
            ),
        },
    };

    if (contextPilot?.enabled) {
        resolved.contextPilot = compact({
            enabled: true,
            excludeTools: contextPilot.excludeTools?.length ? contextPilot.excludeTools : undefined,
        }) as ResolvedAgentRuntimeOptions['contextPilot'];
    }

    const reasoning = resolveReasoning(runtime);
    if (reasoning) resolved.reasoning = reasoning;

    // `runtime.askUser` is deliberately NOT mapped to `humanInTheLoop`. The SDK
    // would add an `ask_user_question` tool and PAUSE the run on it — but no
    // console channel (sessions, the client API, A2A, schedules) can show the
    // question or resume with an answer, so the conversation stopped with an
    // empty reply and stayed stuck. Until a channel can answer, the agent is
    // never offered a question it cannot get answered.

    // Only meaningful when the agent actually has sub-agents; the caller decides
    // whether to pass it, but the resolved values live here so codegen matches.
    if (policy || (config.subagents?.length ?? 0) > 0) {
        resolved.subagentPolicy = {
            mode: policy?.mode ?? 'registry_only',
            maxDepth: positive(policy?.maxDepth, 2),
            maxChildCalls: positive(policy?.maxChildCalls, 8),
            maxParallel: positive(policy?.maxParallel, 3),
            childContextPolicy: policy?.childContextPolicy ?? 'scoped',
            allowAdhocTools: policy?.allowAdhocTools ?? false,
        };
    }

    return resolved;
}

// ── JSON Schema → zod ────────────────────────────────────────────────────

/**
 * Converts the draft-07 subset the structured-output editor can produce into a
 * zod schema. Anything unrecognised degrades to `z.any()` rather than throwing:
 * a half-written schema in the editor must not break the playground.
 */
export function jsonSchemaToZod(schema: unknown, strict = false, permissive = false): ZodTypeAny {
    if (!schema || typeof schema !== 'object') return z.any();
    const node = schema as Record<string, any>;

    if (Array.isArray(node.enum) && node.enum.length > 0) {
        const values = node.enum.filter((v: unknown) => typeof v === 'string') as string[];
        if (values.length === node.enum.length && values.length > 0) {
            return withDescription(z.enum(values as [string, ...string[]]), node);
        }
    }
    if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
        const variants = (node.anyOf ?? node.oneOf).map((v: unknown) => jsonSchemaToZod(v, strict, permissive));
        if (variants.length >= 2) {
            return withDescription(z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]), node);
        }
        if (variants.length === 1) return variants[0];
    }

    const type = Array.isArray(node.type) ? node.type.find((t: string) => t !== 'null') : node.type;

    switch (type) {
        case 'string': {
            let out = z.string();
            if (typeof node.minLength === 'number') out = out.min(node.minLength);
            if (typeof node.maxLength === 'number') out = out.max(node.maxLength);
            if (node.format === 'email') out = out.email();
            if (node.format === 'uri' || node.format === 'url') out = out.url();
            return withDescription(out, node);
        }
        case 'number':
        case 'integer': {
            let out = type === 'integer' ? z.number().int() : z.number();
            if (typeof node.minimum === 'number') out = out.min(node.minimum);
            if (typeof node.maximum === 'number') out = out.max(node.maximum);
            return withDescription(out, node);
        }
        case 'boolean':
            return withDescription(z.boolean(), node);
        case 'array':
            return withDescription(z.array(jsonSchemaToZod(node.items, strict, permissive)), node);
        case 'object': {
            const properties: Record<string, any> = node.properties ?? {};
            const required: string[] = Array.isArray(node.required) ? node.required : [];
            const shape: Record<string, ZodTypeAny> = {};
            for (const [key, value] of Object.entries(properties)) {
                const child = jsonSchemaToZod(value, strict, permissive);
                // `strict` promotes every declared property to required, which is
                // what providers with strict JSON mode expect.
                shape[key] = strict || required.includes(key) ? child : child.optional();
            }
            const object = z.object(shape);
            if (strict || node.additionalProperties === false) return withDescription(object.strict(), node);
            // `permissive` keeps keys the schema did not declare instead of
            // stripping them — for TOOL arguments, where the upstream API is
            // the judge and a property-less `body: { type: object }` would
            // otherwise arrive empty.
            return withDescription(permissive ? object.passthrough() : object, node);
        }
        default:
            return z.any();
    }
}

function withDescription<T extends ZodTypeAny>(schema: T, node: Record<string, any>): T {
    return typeof node.description === 'string' && node.description.length > 0
        ? (schema.describe(node.description) as T)
        : schema;
}

/**
 * The argument schema a bound tool shows the model.
 *
 * OpenAPI and MCP tools used to be bound with `z.object({}).passthrough()`,
 * which reaches the model as an object with NO properties: it saw a tool's
 * name and description and had to guess every argument. The real schema only
 * went to the trace. This hands the model the action's own input schema —
 * names, types, enums, descriptions, required fields — permissively, so an
 * argument the schema did not declare still reaches the upstream API.
 */
export function toolInputSchemaToZod(inputSchema: unknown): ZodTypeAny {
    const fallback = z.object({}).passthrough();
    if (!inputSchema || typeof inputSchema !== 'object') return fallback;
    // A schema that DECLARES an object with no properties is a tool that takes
    // no arguments (an OpenAPI operation with no parameters, an MCP tool with
    // an empty input) — a closed empty object, not "anything goes". The open
    // form has no strict-mode encoding at the top level, and providers in
    // strict mode rejected the whole request over it.
    const declared = inputSchema as { type?: unknown; properties?: unknown; additionalProperties?: unknown };
    if (declared.type === 'object'
        && (!declared.properties || Object.keys(declared.properties as object).length === 0)
        && declared.additionalProperties !== true
        && typeof declared.additionalProperties !== 'object') {
        return z.object({}).strict();
    }
    try {
        const converted = jsonSchemaToZod(inputSchema, false, true);
        // A tool call's arguments are always an object; a schema that did
        // not convert to one carries no usable contract.
        return converted instanceof z.ZodObject ? converted : fallback;
    } catch {
        return fallback;
    }
}

/** Returns the zod contract for the agent's final answer, or undefined. */
export function resolveStructuredOutputSchema(
    structuredOutput: IAgentStructuredOutput | undefined,
): ZodTypeAny | undefined {
    if (!structuredOutput?.enabled || !structuredOutput.schema) return undefined;
    const schema = jsonSchemaToZod(structuredOutput.schema, structuredOutput.strict === true);
    // A bare `z.any()` is not a contract — treat it as "not configured" so the
    // agent keeps its normal free-text behaviour instead of silently no-opping.
    return schema._def?.typeName === 'ZodAny' ? undefined : schema;
}

/**
 * Skill policy — only meaningful when the agent actually has skills, mirroring
 * how `subagentPolicy` is only emitted once there are sub-agents.
 */
export function resolveAgentSkillPolicy(config: IAgentConfig): SmartAgentOptions['skillPolicy'] {
    if (!config.skills || config.skills.length === 0) return undefined;
    const policy = config.skillPolicy;
    return compact({
        maxOpenSkills: positive(policy?.maxOpenSkills, 3),
        maxBoundToolsPerSkill: positive(policy?.maxBoundToolsPerSkill, 10),
        maxBoundToolsTotal: positive(policy?.maxBoundToolsTotal, 20),
        disclosure: policy?.disclosure,
    }) as SmartAgentOptions['skillPolicy'];
}
