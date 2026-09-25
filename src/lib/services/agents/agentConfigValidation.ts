/**
 * Validates an agent config before it is saved or published.
 *
 * The runtime is deliberately forgiving: a missing tool, a deleted knowledge
 * base or a sub-agent whose reference no longer resolves is logged and
 * SKIPPED, so one stale reference does not take the whole agent down. The
 * cost of that was that a broken config saved with a 200, and the operator
 * found out from an agent that quietly had fewer tools than they gave it — or
 * from a limit that never fired. This is the check that turns those into an
 * error at save time, with the field that is wrong.
 *
 * Two kinds of result:
 *  - errors block the save: the agent would not run as configured;
 *  - warnings do not: it runs, but something is probably not what was meant.
 */

import { getConfig } from '@/lib/core/config';
import { getDatabase, type IAgentConfig, type IAgentToolBinding } from '@/lib/database';
import { getDisabledToolNames } from '@/lib/services/mcp/mcpService';
import { AGENT_SANDBOX_SECRET_MASK } from './agentSandboxSecrets';
import { resolveSandboxAvailability } from './agentSandboxTools';

export interface AgentConfigIssue {
    /** Dotted path into the config, e.g. `runtime.limits.maxCostUsd`. */
    field: string;
    message: string;
}

export interface AgentConfigValidation {
    errors: AgentConfigIssue[];
    warnings: AgentConfigIssue[];
}

const CONTEXT_POLICIES = new Set(['raw', 'summary_only', 'hybrid']);
const PLANNING_MODES = new Set(['off', 'todo', 'planner_executor', 'reasoning_then_tools']);
const REPLAN_POLICIES = new Set(['never', 'on_failure', 'on_conflict', 'every_n_steps']);
const PROFILES = new Set(['fast', 'balanced', 'deep', 'research']);
const TOOL_RESPONSE_POLICIES = new Set(['keep_full', 'keep_structured', 'summarize_archive', 'drop']);
const SYSTEM_TOOLS = new Set(['browser_use', 'web_search']);

type Issues = AgentConfigValidation;

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** A number knob: absent is fine, present must be finite and within range. */
function checkNumber(
    issues: Issues,
    field: string,
    value: unknown,
    rule: { min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean },
): void {
    if (value === undefined || value === null) return;
    if (!isNumber(value)) {
        issues.errors.push({ field, message: 'must be a number' });
        return;
    }
    if (rule.integer && !Number.isInteger(value)) {
        issues.errors.push({ field, message: 'must be a whole number' });
        return;
    }
    if (rule.min !== undefined && (rule.exclusiveMin ? value <= rule.min : value < rule.min)) {
        issues.errors.push({ field, message: `must be ${rule.exclusiveMin ? 'greater than' : 'at least'} ${rule.min}` });
    }
    if (rule.max !== undefined && value > rule.max) {
        issues.errors.push({ field, message: `must be at most ${rule.max}` });
    }
}

function checkEnum(issues: Issues, field: string, value: unknown, allowed: Set<string>): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !allowed.has(value)) {
        issues.errors.push({ field, message: `must be one of: ${[...allowed].join(', ')}` });
    }
}

/**
 * The checks that need nothing but the config itself — no database lookups.
 * validateAgentConfig runs these first.
 */
export function validateAgentConfigShape(config: IAgentConfig): AgentConfigValidation {
    const issues: Issues = { errors: [], warnings: [] };
    if (config.kind === 'external') return issues;

    if (!config.modelKey) issues.errors.push({ field: 'modelKey', message: 'A model is required' });
    if (config.systemPrompt && config.promptKey) {
        issues.warnings.push({
            field: 'promptKey',
            message: 'Both an inline system prompt and a prompt template are set; the inline prompt is used',
        });
    }
    checkNumber(issues, 'topP', config.topP, { min: 0, max: 1 });

    const runtime = config.runtime ?? {};
    checkEnum(issues, 'runtime.profile', runtime.profile, PROFILES);

    const limits = runtime.limits ?? {};
    checkNumber(issues, 'runtime.limits.maxToolCalls', limits.maxToolCalls, { min: 1, integer: true, max: 500 });
    checkNumber(issues, 'runtime.limits.maxParallelTools', limits.maxParallelTools, { min: 1, integer: true, max: 50 });
    checkNumber(issues, 'runtime.limits.maxContextTokens', limits.maxContextTokens, { min: 1_000, integer: true });
    checkNumber(issues, 'runtime.limits.maxTotalOutputTokens', limits.maxTotalOutputTokens, { min: 1, integer: true });
    checkNumber(issues, 'runtime.limits.maxCostUsd', limits.maxCostUsd, { min: 0, exclusiveMin: true });
    checkNumber(issues, 'runtime.limits.maxWallClockMs', limits.maxWallClockMs, { min: 1_000, integer: true });

    const planning = runtime.planning ?? {};
    checkEnum(issues, 'runtime.planning.mode', planning.mode, PLANNING_MODES);
    checkEnum(issues, 'runtime.planning.replanPolicy', planning.replanPolicy, REPLAN_POLICIES);
    if (planning.replanPolicy === 'every_n_steps') {
        if (!isNumber(planning.everyNSteps)) {
            issues.errors.push({ field: 'runtime.planning.everyNSteps', message: 'is required when replanning every N steps' });
        } else {
            checkNumber(issues, 'runtime.planning.everyNSteps', planning.everyNSteps, { min: 1, integer: true });
        }
    }

    const summarization = runtime.summarization ?? {};
    checkNumber(issues, 'runtime.summarization.maxTokens', summarization.maxTokens, { min: 1_000, integer: true });
    checkNumber(issues, 'runtime.summarization.summaryTriggerTokens', summarization.summaryTriggerTokens, { min: 1_000, integer: true });
    checkNumber(issues, 'runtime.summarization.summaryPromptMaxTokens', summarization.summaryPromptMaxTokens, { min: 1_000, integer: true });
    if (isNumber(summarization.summaryTriggerTokens) && isNumber(limits.maxContextTokens)
        && summarization.summaryTriggerTokens >= limits.maxContextTokens) {
        issues.warnings.push({
            field: 'runtime.summarization.summaryTriggerTokens',
            message: 'is not below maxContextTokens, so the context is clamped before it is ever summarized',
        });
    }

    const context = runtime.context ?? {};
    checkEnum(issues, 'runtime.context.policy', context.policy, CONTEXT_POLICIES);
    checkEnum(issues, 'runtime.context.toolResponsePolicy', context.toolResponsePolicy, TOOL_RESPONSE_POLICIES);
    checkNumber(issues, 'runtime.context.lastTurnsToKeep', context.lastTurnsToKeep, { min: 1, integer: true });
    if (context.policy === 'summary_only' && summarization.enable === false) {
        issues.errors.push({
            field: 'runtime.context.policy',
            message: '"summary_only" needs summarization enabled — without a summary the agent keeps only the current turn',
        });
    }

    const toolResponses = runtime.toolResponses ?? {};
    checkEnum(issues, 'runtime.toolResponses.defaultPolicy', toolResponses.defaultPolicy, TOOL_RESPONSE_POLICIES);
    for (const [tool, policy] of Object.entries(toolResponses.retentionByTool ?? {})) {
        checkEnum(issues, `runtime.toolResponses.retentionByTool.${tool}`, policy, TOOL_RESPONSE_POLICIES);
    }
    checkNumber(issues, 'runtime.toolResponses.maxToolResponseChars', toolResponses.maxToolResponseChars, { min: 100, integer: true });
    checkNumber(issues, 'runtime.toolResponses.maxToolResponseTokens', toolResponses.maxToolResponseTokens, { min: 50, integer: true });

    if (runtime.askUser) {
        issues.warnings.push({
            field: 'runtime.askUser',
            message: 'Asking the user mid-run is not supported by any console channel and is ignored',
        });
    }

    const structured = config.structuredOutput;
    if (structured?.enabled) {
        const schema = structured.schema as { type?: unknown; properties?: unknown } | undefined;
        if (!schema || typeof schema !== 'object') {
            issues.errors.push({ field: 'structuredOutput.schema', message: 'A JSON schema is required when structured output is on' });
        } else if (schema.type !== 'object') {
            issues.errors.push({ field: 'structuredOutput.schema', message: 'The schema\'s top level must be `type: "object"`' });
        } else if (!schema.properties || typeof schema.properties !== 'object'
            || Object.keys(schema.properties as object).length === 0) {
            issues.errors.push({ field: 'structuredOutput.schema', message: 'The schema declares no properties' });
        }
    }

    const execution = config.execution;
    if (execution) {
        const env = getConfig().agent;
        const syncMaxSeconds = Math.floor(env.syncTimeoutMs / 1000);
        const backgroundMaxMinutes = Math.max(1, Math.floor(env.backgroundMaxDurationMs / 60_000));
        checkNumber(issues, 'execution.syncTimeoutSeconds', execution.syncTimeoutSeconds, { min: 5, max: syncMaxSeconds, integer: true });
        checkNumber(issues, 'execution.backgroundMaxDurationMinutes', execution.backgroundMaxDurationMinutes, { min: 1, max: backgroundMaxMinutes, integer: true });
        if (execution.defaultMode !== undefined && execution.defaultMode !== 'sync' && execution.defaultMode !== 'background') {
            issues.errors.push({ field: 'execution.defaultMode', message: 'must be one of: sync, background' });
        }
        if (execution.defaultMode === 'background' && execution.backgroundEnabled === false) {
            issues.errors.push({ field: 'execution.defaultMode', message: 'cannot be background while background execution is disabled' });
        }
        if (execution.callbackUrl !== undefined && execution.callbackUrl !== '') {
            const parsed = URL.canParse(execution.callbackUrl) ? new URL(execution.callbackUrl) : null;
            if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || execution.callbackUrl.length > 2048) {
                issues.errors.push({ field: 'execution.callbackUrl', message: 'must be an http(s) URL of at most 2048 characters' });
            } else if (parsed.protocol === 'http:') {
                issues.warnings.push({ field: 'execution.callbackUrl', message: 'Callbacks over plain http can be read in transit; prefer https.' });
            }
        }
        if (typeof execution.callbackSecret === 'string' && execution.callbackSecret !== '' && execution.callbackSecret !== AGENT_SANDBOX_SECRET_MASK
            && (execution.callbackSecret.length < 16 || execution.callbackSecret.length > 256)) {
            issues.errors.push({ field: 'execution.callbackSecret', message: 'must be 16–256 characters' });
        }
        if (execution.callbackSecret && !execution.callbackUrl) {
            issues.errors.push({ field: 'execution.callbackSecret', message: 'needs a callback URL' });
        }
    }

    const sandbox = config.sandbox;
    if (sandbox?.enabled) {
        if (sandbox.mode !== undefined && sandbox.mode !== 'ephemeral' && sandbox.mode !== 'persist') {
            issues.errors.push({ field: 'sandbox.mode', message: 'must be one of: ephemeral, persist' });
        }
        checkNumber(issues, 'sandbox.commandTimeoutSec', sandbox.commandTimeoutSec, { min: 1, max: 600, integer: true });
        checkNumber(issues, 'sandbox.retentionHours', sandbox.retentionHours, { min: 1, max: 24 * 30, integer: true });
        checkNumber(issues, 'sandbox.resources.cpuCores', sandbox.resources?.cpuCores, { min: 0, exclusiveMin: true, max: 64 });
        checkNumber(issues, 'sandbox.resources.memoryMb', sandbox.resources?.memoryMb, { min: 128, max: 262_144, integer: true });
        const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
        for (const [group, map] of [['env', sandbox.env], ['secrets', sandbox.secrets]] as const) {
            for (const key of Object.keys(map ?? {})) {
                if (!envName.test(key)) {
                    issues.errors.push({ field: `sandbox.${group}.${key}`, message: 'must be a valid environment variable name (letters, digits, _)' });
                }
            }
        }
        const clash = Object.keys(sandbox.env ?? {}).filter((key) => key in (sandbox.secrets ?? {}));
        if (clash.length > 0) {
            issues.errors.push({ field: 'sandbox.secrets', message: `Defined both as a variable and a secret: ${clash.join(', ')}` });
        }
        if (sandbox.preview?.enabled) {
            checkNumber(issues, 'sandbox.preview.linkTtlHours', sandbox.preview.linkTtlHours, { min: 1, max: 168 });
            checkNumber(issues, 'sandbox.preview.keepAliveMinutes', sandbox.preview.keepAliveMinutes, { min: 5, max: 24 * 60, integer: true });
            if (sandbox.blockNetwork) {
                issues.warnings.push({
                    field: 'sandbox.preview',
                    message: 'Preview links do not work while the sandbox network is blocked',
                });
            }
            if (sandbox.tools?.exec === false && sandbox.tools?.code === false) {
                issues.warnings.push({
                    field: 'sandbox.preview',
                    message: 'Preview is on, but the agent has no tool to start a server (commands and code are both off)',
                });
            }
        }
        if (sandbox.tools && sandbox.tools.exec === false && sandbox.tools.code === false && sandbox.tools.files === false) {
            issues.warnings.push({ field: 'sandbox.tools', message: 'Sandbox access is on but every sandbox tool is off' });
        }
    }

    const memory = config.memory;
    if (memory?.enabled && !memory.memoryStoreKey) {
        issues.errors.push({ field: 'memory.memoryStoreKey', message: 'Pick a memory store, or turn memory off' });
    }

    (config.toolBindings ?? []).forEach((binding, index) => checkBindingShape(issues, `toolBindings[${index}]`, binding));

    const names = new Set<string>();
    (config.subagents ?? []).forEach((entry, index) => {
        const field = `subagents[${index}]`;
        if (!entry.name) {
            issues.errors.push({ field: `${field}.name`, message: 'A sub-agent needs a name' });
        } else if (names.has(entry.name)) {
            issues.errors.push({ field: `${field}.name`, message: `Duplicate sub-agent name "${entry.name}"` });
        } else {
            names.add(entry.name);
        }
        if (!entry.header?.trim()) {
            issues.errors.push({ field: `${field}.header`, message: 'Say what the sub-agent does — the orchestrator picks it by this line' });
        }
        if (entry.kind === 'ref' && !entry.agentKey) {
            issues.errors.push({ field: `${field}.agentKey`, message: 'Pick the agent this sub-agent refers to' });
        }
        if (entry.kind === 'inline' && !entry.systemPrompt?.trim()) {
            issues.warnings.push({ field: `${field}.systemPrompt`, message: 'An inline sub-agent with no instructions' });
        }
        (entry.toolBindings ?? []).forEach((binding, bindingIndex) =>
            checkBindingShape(issues, `${field}.toolBindings[${bindingIndex}]`, binding));
    });

    return issues;
}

function checkBindingShape(issues: Issues, field: string, binding: IAgentToolBinding): void {
    if (!binding || typeof binding !== 'object') {
        issues.errors.push({ field, message: 'Invalid tool binding' });
        return;
    }
    if (binding.source !== 'tool' && binding.source !== 'mcp' && binding.source !== 'system') {
        issues.errors.push({ field: `${field}.source`, message: 'must be one of: tool, mcp, system' });
        return;
    }
    if (!binding.sourceKey) issues.errors.push({ field: `${field}.sourceKey`, message: 'is required' });
    if (binding.source === 'system') {
        if (!SYSTEM_TOOLS.has(binding.sourceKey)) {
            issues.errors.push({ field: `${field}.sourceKey`, message: `Unknown system tool "${binding.sourceKey}"` });
        } else if (binding.sourceKey === 'browser_use' && typeof binding.config?.browserId !== 'string') {
            issues.errors.push({ field: `${field}.config.browserId`, message: 'Pick the browser the agent should use' });
        }
        return;
    }
    if (!Array.isArray(binding.toolNames) || binding.toolNames.length === 0) {
        issues.errors.push({ field: `${field}.toolNames`, message: 'Select at least one action' });
    }
}

function hasPrice(pricing: { inputTokenPer1M?: number; outputTokenPer1M?: number } | undefined | null): boolean {
    return (pricing?.inputTokenPer1M ?? 0) > 0 || (pricing?.outputTokenPer1M ?? 0) > 0;
}

/**
 * The shape checks plus everything that needs the database: every key the
 * config names must resolve, in this project, to something usable.
 */
export async function validateAgentConfig(input: {
    tenantDbName: string;
    projectId: string;
    config: IAgentConfig;
    /** The agent being saved, so a sub-agent that references it can be caught. */
    agentKey?: string;
    /** For the license-gated parts (sandbox access). */
    tenantId?: string;
}): Promise<AgentConfigValidation> {
    const { config, projectId } = input;
    const issues = validateAgentConfigShape(config);
    if (config.kind === 'external') return issues;

    const db = await getDatabase();
    await db.switchToTenant(input.tenantDbName);

    const checkModel = async (field: string, key: string, requirePrice: boolean) => {
        const model = await db.findModelByKey(key, projectId).catch(() => null);
        if (!model) {
            issues.errors.push({ field, message: `Model "${key}" does not exist in this project` });
            return;
        }
        if (model.category !== 'llm') {
            issues.errors.push({ field, message: `Model "${key}" is a ${model.category} model, not a chat model` });
        }
        if (requirePrice && !hasPrice(model.pricing)) {
            issues.errors.push({
                field: 'runtime.limits.maxCostUsd',
                message: `Model "${key}" has no pricing, so a cost limit cannot be measured — add prices in the Model Hub or remove the limit`,
            });
        }
    };
    const checkKnowledge = async (field: string, key: string) => {
        if (!(await db.findRagModuleByKey(key).catch(() => null))) {
            issues.errors.push({ field, message: `Knowledge engine "${key}" does not exist` });
        }
    };

    if (config.sandbox?.enabled && input.tenantId) {
        const availability = await resolveSandboxAvailability(input.tenantId);
        if (!availability.available) {
            issues.errors.push({
                field: 'sandbox.enabled',
                message: availability.reason === 'license'
                    ? 'Sandbox access requires an Enterprise license'
                    : 'This edition has no sandbox module',
            });
        } else if (!config.sandbox.templateKey?.trim()) {
            // No implicit default: built-in templates are only created by the
            // explicit "Seed defaults" action, so an unset key could resolve
            // to nothing (or to whatever template happens to be first).
            issues.errors.push({ field: 'sandbox.templateKey', message: 'Pick a sandbox template for this agent' });
        } else {
            const templates = await availability.runner.listTemplates(input.tenantDbName, input.tenantId).catch(() => null);
            if (templates && !templates.some((template) => template.key === config.sandbox!.templateKey)) {
                issues.errors.push({ field: 'sandbox.templateKey', message: `Sandbox template "${config.sandbox.templateKey}" does not exist` });
            }
        }
    }

    const wantsCost = isNumber(config.runtime?.limits?.maxCostUsd) && config.runtime!.limits!.maxCostUsd! > 0;
    if (config.modelKey) await checkModel('modelKey', config.modelKey, wantsCost);

    if (!config.systemPrompt && config.promptKey) {
        const prompt = await db.findPromptByKey(config.promptKey, projectId).catch(() => null);
        if (!prompt) issues.errors.push({ field: 'promptKey', message: `Prompt "${config.promptKey}" does not exist` });
    }
    if (config.knowledgeEngineKey) await checkKnowledge('knowledgeEngineKey', config.knowledgeEngineKey);
    if (config.memory?.enabled && config.memory.memoryStoreKey) {
        const store = await db.findMemoryStoreByKey(config.memory.memoryStoreKey, projectId).catch(() => null);
        if (!store) {
            issues.errors.push({ field: 'memory.memoryStoreKey', message: `Memory store "${config.memory.memoryStoreKey}" does not exist` });
        }
    }
    for (const key of config.skills ?? []) {
        const skill = await db.findSkillByKey(key, projectId).catch(() => null);
        if (!skill) issues.errors.push({ field: 'skills', message: `Skill "${key}" does not exist` });
        else if (skill.status !== 'active') issues.warnings.push({ field: 'skills', message: `Skill "${key}" is not active and is skipped` });
    }

    await checkBindingReferences(issues, db, 'toolBindings', config.toolBindings);

    for (const [index, entry] of (config.subagents ?? []).entries()) {
        const field = `subagents[${index}]`;
        if (entry.modelKey) await checkModel(`${field}.modelKey`, entry.modelKey, false);
        if (entry.kind === 'ref' && entry.agentKey) {
            if (input.agentKey && entry.agentKey === input.agentKey) {
                issues.errors.push({ field: `${field}.agentKey`, message: 'An agent cannot delegate to itself' });
                continue;
            }
            const target = await db.findAgentByKey(entry.agentKey, projectId).catch(() => null);
            if (!target) {
                issues.errors.push({ field: `${field}.agentKey`, message: `Agent "${entry.agentKey}" does not exist` });
            } else if (target.config?.kind === 'external') {
                issues.errors.push({ field: `${field}.agentKey`, message: `"${entry.agentKey}" is a connected agent and cannot run as a sub-agent` });
            } else if (entry.agentVersion === undefined && (target.publishedVersion ?? null) === null) {
                issues.errors.push({ field: `${field}.agentKey`, message: `Agent "${entry.agentKey}" has no published version to delegate to` });
            } else if (input.agentKey && (target.config?.subagents ?? []).some((child) => child.kind === 'ref' && child.agentKey === input.agentKey)) {
                issues.errors.push({ field: `${field}.agentKey`, message: `"${entry.agentKey}" already delegates back to this agent (a cycle)` });
            }
        }
        if (entry.knowledgeEngineKey) await checkKnowledge(`${field}.knowledgeEngineKey`, entry.knowledgeEngineKey);
        await checkBindingReferences(issues, db, `${field}.toolBindings`, entry.toolBindings);
    }

    return issues;
}

type Db = Awaited<ReturnType<typeof getDatabase>>;

async function checkBindingReferences(
    issues: Issues,
    db: Db,
    prefix: string,
    bindings: IAgentToolBinding[] | undefined,
): Promise<void> {
    for (const [index, binding] of (bindings ?? []).entries()) {
        const field = `${prefix}[${index}]`;
        if (!binding?.sourceKey) continue;
        if (binding.source === 'tool') {
            // Resolved exactly as the runtime resolves it (`buildBoundTools`):
            // tenant-wide, so a tool the agent can run is never rejected here.
            const tool = await db.findToolByKey(binding.sourceKey).catch(() => null);
            if (!tool) {
                issues.errors.push({ field, message: `Tool "${binding.sourceKey}" does not exist` });
                continue;
            }
            if (tool.status !== 'active') issues.errors.push({ field, message: `Tool "${binding.sourceKey}" is not active` });
            for (const name of binding.toolNames ?? []) {
                if (!tool.actions.some((action) => action.key === name || action.name === name)) {
                    issues.errors.push({ field: `${field}.toolNames`, message: `Tool "${binding.sourceKey}" has no action "${name}"` });
                }
            }
        } else if (binding.source === 'mcp') {
            const server = await db.findMcpServerByKey(binding.sourceKey).catch(() => null);
            if (!server) {
                issues.errors.push({ field, message: `MCP server "${binding.sourceKey}" does not exist` });
                continue;
            }
            if (server.status !== 'active') issues.errors.push({ field, message: `MCP server "${binding.sourceKey}" is not active` });
            const disabled = new Set(getDisabledToolNames(server));
            for (const name of binding.toolNames ?? []) {
                if (!server.tools.some((tool) => tool.name === name)) {
                    issues.errors.push({ field: `${field}.toolNames`, message: `MCP server "${binding.sourceKey}" has no tool "${name}"` });
                } else if (disabled.has(name)) {
                    issues.warnings.push({ field: `${field}.toolNames`, message: `Tool "${name}" is disabled on MCP server "${binding.sourceKey}" and is skipped` });
                }
            }
        }
    }
}

/** The 400 body for a config that failed validation: the first error, and how many more there are. */
export function invalidConfigBody(result: AgentConfigValidation) {
    const [first, ...rest] = result.errors;
    const summary = first ? `${first.field}: ${first.message}${rest.length > 0 ? ` (and ${rest.length} more)` : ''}` : '';
    return { error: `Invalid agent config — ${summary}`, validation: result };
}
