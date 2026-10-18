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
import { hasKnowledgeConfigured } from './agentKnowledgeBindings';
import { getCrawler, crawlerHasCredentials, crawlerHasHostScope } from '@/lib/services/crawler';
import { getDatabase, type IAgentConfig, type IAgentToolBinding } from '@/lib/database';
import { getDisabledToolNames } from '@/lib/services/mcp/mcpService';
import { AGENT_SANDBOX_SECRET_MASK } from './agentSandboxSecrets';
import {
    resolveAgentBindingMcpServer,
    resolveAgentBindingTool,
    resolveAgentKnowledgeModule,
} from './bindingResolution';
import { validateSeedFiles } from './agentSandboxSeedFiles';
import { unsuppliableRequiredVariables, validateVariableDeclaration } from './agentVariables';
import { resolveSubagentTarget } from './subagentRoster';
import { SANDBOX_MODES } from './agentSandboxMode';
import { resolveSandboxAvailability } from './agentSandboxTools';
import { validateHitlConfig } from './agentHumanInTheLoop';
import { checkEmbeddedClientTools } from './agentClientTools';
import { normalizeAttachmentsFolder, SESSION_FILE_OUTPUTS_LIMITS } from './sessionFilesConfig';
import { inspectFileBucket } from './sessionFilesBucket';
import { reasoningConfigIssues } from './agentReasoning';
import { MAX_MEMORY_MOUNTS } from './agentMemoryMounts';

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
const SYSTEM_TOOLS = new Set(['browser_use', 'web_search', 'crawler']);

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
    checkAdditionalModelsShape(issues, config);
    issues.errors.push(...reasoningConfigIssues(config));
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

    // Declared variables: names, types, enums, defaults.
    for (const issue of validateVariableDeclaration(config.variables)) issues.errors.push({ field: issue.field, message: issue.message });

    const budget = config.budget as { maxCostUsd?: unknown; onReach?: unknown; allowClientOverride?: unknown } | undefined;
    if (budget !== undefined && budget !== null) {
        if (typeof budget !== 'object' || Array.isArray(budget)) {
            issues.errors.push({ field: 'budget', message: 'must be an object: { maxCostUsd, onReach }' });
        } else {
            if (!isNumber(budget.maxCostUsd)) {
                issues.errors.push({ field: 'budget.maxCostUsd', message: 'is required and must be a number' });
            } else {
                checkNumber(issues, 'budget.maxCostUsd', budget.maxCostUsd, { min: 0, exclusiveMin: true });
            }
            if (budget.onReach !== 'pause' && budget.onReach !== 'stop') {
                issues.errors.push({ field: 'budget.onReach', message: 'must be one of: pause, stop' });
            }
            if (budget.allowClientOverride !== undefined && typeof budget.allowClientOverride !== 'boolean') {
                issues.errors.push({ field: 'budget.allowClientOverride', message: 'must be a boolean' });
            }
        }
    }

    const callback = config.callback;
    if (callback) {
        if (callback.url !== undefined && callback.url !== '') {
            const parsed = URL.canParse(callback.url) ? new URL(callback.url) : null;
            if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || callback.url.length > 2048) {
                issues.errors.push({ field: 'callback.url', message: 'must be an http(s) URL of at most 2048 characters' });
            } else if (parsed.protocol === 'http:') {
                issues.warnings.push({ field: 'callback.url', message: 'Callbacks over plain http can be read in transit; prefer https.' });
            }
        }
        if (typeof callback.secret === 'string' && callback.secret !== '' && callback.secret !== AGENT_SANDBOX_SECRET_MASK
            && (callback.secret.length < 16 || callback.secret.length > 256)) {
            issues.errors.push({ field: 'callback.secret', message: 'must be 16–256 characters' });
        }
        if (callback.secret && callback.secret !== AGENT_SANDBOX_SECRET_MASK && !callback.url) {
            issues.errors.push({ field: 'callback.secret', message: 'needs a callback URL' });
        }
    }

    if (config.clientTools !== undefined) {
        const checked = checkEmbeddedClientTools(config.clientTools);
        if (!checked.ok) {
            for (const problem of checked.errors) issues.errors.push({ field: problem.field, message: problem.message });
        }
    }

    if (config.clientToolSurfaces !== undefined) {
        const surfaces = config.clientToolSurfaces as unknown;
        if (!surfaces || typeof surfaces !== 'object' || Array.isArray(surfaces)) {
            issues.errors.push({ field: 'clientToolSurfaces', message: 'must be an object' });
        } else {
            for (const [key, value] of Object.entries(surfaces)) {
                if (!['api', 'playground', 'portal'].includes(key)) issues.errors.push({ field: `clientToolSurfaces.${key}`, message: 'unknown surface (api, playground, portal)' });
                else if (typeof value !== 'boolean') issues.errors.push({ field: `clientToolSurfaces.${key}`, message: 'must be true or false' });
            }
        }
    }

    const attachments = config.attachments;
    if (attachments) {
        checkNumber(issues, 'attachments.maxFiles', attachments.maxFiles, { min: 1, max: 100, integer: true });
        checkNumber(issues, 'attachments.maxFileSizeMb', attachments.maxFileSizeMb, { min: 0, exclusiveMin: true, max: getConfig().limits.fileUploadMaxMb });
        checkNumber(issues, 'attachments.inlineMaxTokens', attachments.inlineMaxTokens, { min: 100, integer: true });
        checkNumber(issues, 'attachments.readPageChars', attachments.readPageChars, { min: 500, max: 200_000, integer: true });
        checkNumber(issues, 'attachments.retentionDays', attachments.retentionDays, { min: 1, max: 3650 });
        checkNumber(issues, 'attachments.maxImages', attachments.maxImages, { min: 1, max: 50, integer: true });
        checkNumber(issues, 'attachments.maxBytes', attachments.maxBytes, { min: 100_000, max: 200_000_000, integer: true });
        checkNumber(issues, 'attachments.carryRecentImages', attachments.carryRecentImages, { min: 0, max: 20, integer: true });
        if (attachments.allowedMimeTypes !== undefined
            && (!Array.isArray(attachments.allowedMimeTypes) || attachments.allowedMimeTypes.some((entry) => typeof entry !== 'string'))) {
            issues.errors.push({ field: 'attachments.allowedMimeTypes', message: 'must be a list of MIME types (image/* is allowed)' });
        }
        for (const flag of ['enabled', 'attachNewUploads'] as const) {
            if (attachments[flag] !== undefined && typeof attachments[flag] !== 'boolean') {
                issues.errors.push({ field: `attachments.${flag}`, message: 'must be true or false' });
            }
        }
        const outputs = attachments.outputs;
        if (outputs !== undefined && outputs !== null) {
            if (typeof outputs !== 'object' || Array.isArray(outputs)) {
                issues.errors.push({ field: 'attachments.outputs', message: 'must be an object' });
            } else {
                if (outputs.enabled !== undefined && typeof outputs.enabled !== 'boolean') {
                    issues.errors.push({ field: 'attachments.outputs.enabled', message: 'must be true or false' });
                }
                checkNumber(issues, 'attachments.outputs.maxFilesPerTurn', outputs.maxFilesPerTurn, { min: 1, max: SESSION_FILE_OUTPUTS_LIMITS.maxFilesPerTurn, integer: true });
                checkNumber(issues, 'attachments.outputs.maxFileSizeMb', outputs.maxFileSizeMb, { min: 0, exclusiveMin: true, max: Math.min(SESSION_FILE_OUTPUTS_LIMITS.maxFileSizeMb, getConfig().limits.fileUploadMaxMb) });
            }
        }
        const folder = normalizeAttachmentsFolder(attachments.folder);
        if (folder.error) issues.errors.push({ field: 'attachments.folder', message: folder.error });
        if (attachments.bucketKey !== undefined && typeof attachments.bucketKey !== 'string') {
            issues.errors.push({ field: 'attachments.bucketKey', message: 'must be a bucket key' });
        } else if ((attachments.enabled === true || attachments.outputs?.enabled === true) && !attachments.bucketKey?.trim()) {
            // Files (uploads or the agent's own outputs) are kept in a bucket of the project; there is no built-in storage to fall back to.
            issues.errors.push({ field: 'attachments.bucketKey', message: 'Choose a bucket to keep the files in' });
        }
    }

    const sandbox = config.sandbox;
    if (sandbox?.enabled) {
        if (sandbox.mode !== undefined && !SANDBOX_MODES.includes(sandbox.mode)) {
            issues.errors.push({ field: 'sandbox.mode', message: 'must be one of: session, ephemeral' });
        }
        for (const issue of validateSeedFiles(sandbox.seedFiles)) issues.errors.push(issue);
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

    const hitl = validateHitlConfig(config);
    issues.errors.push(...hitl.errors);
    issues.warnings.push(...hitl.warnings);

    const memory = config.memory;
    if (memory?.enabled && !memory.memoryStoreKey && !memory.mounts?.length) {
        issues.errors.push({ field: 'memory.memoryStoreKey', message: 'Pick a memory store, or turn memory off' });
    }
    if (memory?.enabled && memory.mounts?.length) {
        if (memory.mounts.length > MAX_MEMORY_MOUNTS) {
            issues.errors.push({ field: 'memory.mounts', message: `At most ${MAX_MEMORY_MOUNTS} memory stores can be mounted` });
        }
        const seen = new Set<string>();
        memory.mounts.forEach((m, i) => {
            if (!m?.storeKey) issues.errors.push({ field: `memory.mounts[${i}].storeKey`, message: 'Pick a memory store' });
            else if (seen.has(m.storeKey)) issues.errors.push({ field: `memory.mounts[${i}].storeKey`, message: `Memory store "${m.storeKey}" is mounted twice` });
            seen.add(m.storeKey);
        });
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

export const MAX_ADDITIONAL_MODELS = 10;

/** `additionalModels`: a list of at most 10 distinct models, none of them the main one. */
function checkAdditionalModelsShape(issues: Issues, config: IAgentConfig): void {
    const list = config.additionalModels;
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) {
        issues.errors.push({ field: 'additionalModels', message: 'must be a list' });
        return;
    }
    if (list.length > MAX_ADDITIONAL_MODELS) {
        issues.errors.push({ field: 'additionalModels', message: `An agent can offer at most ${MAX_ADDITIONAL_MODELS} additional models` });
    }
    const seen = new Set<string>();
    list.forEach((entry, index) => {
        const field = `additionalModels[${index}]`;
        const key = entry && typeof entry === 'object' && typeof entry.modelKey === 'string' ? entry.modelKey.trim() : '';
        if (!key) {
            issues.errors.push({ field: `${field}.modelKey`, message: 'Pick a model' });
            return;
        }
        if (key === config.modelKey) {
            issues.errors.push({ field: `${field}.modelKey`, message: `"${key}" is already the main model` });
        } else if (seen.has(key)) {
            issues.errors.push({ field: `${field}.modelKey`, message: `Model "${key}" is listed twice` });
        }
        seen.add(key);
        if (entry.label !== undefined && typeof entry.label !== 'string') issues.errors.push({ field: `${field}.label`, message: 'must be text' });
        if (entry.description !== undefined && typeof entry.description !== 'string') issues.errors.push({ field: `${field}.description`, message: 'must be text' });
    });
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
        } else if (binding.sourceKey === 'crawler' && typeof binding.config?.crawlerKey !== 'string') {
            issues.errors.push({ field: `${field}.config.crawlerKey`, message: 'Pick the crawler the agent should fetch pages with' });
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
        if (!(await resolveAgentKnowledgeModule(input.tenantDbName, key, projectId).catch(() => null))) {
            issues.errors.push({ field, message: `Knowledge engine "${key}" does not exist in this project` });
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

    // Session files need a bucket that can take a file: it exists in this project, is
    // active, and its provider exists, is assigned here and is active.
    const filesBucketKey = (config.attachments?.enabled === true || config.attachments?.outputs?.enabled === true) && typeof config.attachments.bucketKey === 'string'
        ? config.attachments.bucketKey.trim()
        : '';
    if (filesBucketKey && input.tenantId) {
        const inspection = await inspectFileBucket(db, input.tenantId, projectId, filesBucketKey).catch(() => null);
        if (inspection && !inspection.usable) {
            issues.errors.push({
                field: 'attachments.bucketKey',
                message: `${inspection.message.charAt(0).toUpperCase()}${inspection.message.slice(1)}`,
            });
        }
    }

    const wantsCost = isNumber(config.runtime?.limits?.maxCostUsd) && config.runtime!.limits!.maxCostUsd! > 0;
    if (config.modelKey) await checkModel('modelKey', config.modelKey, wantsCost);
    for (const [index, entry] of (config.additionalModels ?? []).entries()) {
        const key = typeof entry?.modelKey === 'string' ? entry.modelKey.trim() : '';
        if (!key || key === config.modelKey) continue; // the shape pass reported it
        const field = `additionalModels[${index}].modelKey`;
        await checkModel(field, key, wantsCost);
        const model = await db.findModelByKey(key, projectId).catch(() => null);
        if (!model || model.category !== 'llm') continue;
        // A Dynamic LLM routes on its own rules; only a plain model can be known to lack a capability.
        if (model.supportsToolCalls === false && ((config.toolBindings?.length ?? 0) > 0 || hasKnowledgeConfigured(config))) {
            issues.warnings.push({ field, message: `Model "${key}" does not support tool calls, but this agent uses tools` });
        }
        if (model.isMultimodal === false && config.attachments?.enabled === true) {
            issues.warnings.push({ field, message: `Model "${key}" does not accept images, but this agent takes attachments` });
        }
    }

    if (!config.systemPrompt && config.promptKey) {
        const prompt = await db.findPromptByKey(config.promptKey, projectId).catch(() => null);
        if (!prompt) issues.errors.push({ field: 'promptKey', message: `Prompt "${config.promptKey}" does not exist` });
    }
    if (config.knowledgeEngineKey) await checkKnowledge('knowledgeEngineKey', config.knowledgeEngineKey);
    if (config.knowledgeToolMode !== undefined && config.knowledgeToolMode !== 'combined' && config.knowledgeToolMode !== 'separate') {
        issues.errors.push({ field: 'knowledgeToolMode', message: 'knowledgeToolMode must be "combined" or "separate"' });
    }
    if (config.knowledgeBindings !== undefined && !Array.isArray(config.knowledgeBindings)) {
        issues.errors.push({ field: 'knowledgeBindings', message: 'knowledgeBindings must be an array' });
    }
    const seenKb = new Set<string>();
    for (const [index, binding] of (Array.isArray(config.knowledgeBindings) ? config.knowledgeBindings : []).entries()) {
        const field = `knowledgeBindings[${index}]`;
        const key = typeof binding?.key === 'string' ? binding.key.trim() : '';
        if (!key) { issues.errors.push({ field: `${field}.key`, message: 'Knowledge binding needs a key' }); continue; }
        if (seenKb.has(key)) { issues.errors.push({ field: `${field}.key`, message: `Knowledge engine "${key}" is bound twice` }); continue; }
        seenKb.add(key);
        if (binding.topK !== undefined && !(Number.isInteger(binding.topK) && binding.topK >= 1 && binding.topK <= 50)) {
            issues.errors.push({ field: `${field}.topK`, message: 'topK must be an integer between 1 and 50' });
        }
        if (binding.minScore !== undefined && !(typeof binding.minScore === 'number' && binding.minScore >= 0 && binding.minScore <= 1)) {
            issues.errors.push({ field: `${field}.minScore`, message: 'minScore must be a number between 0 and 1' });
        }
        await checkKnowledge(`${field}.key`, key);
    }
    if (config.memory?.enabled) {
        const mounts = config.memory.mounts?.length
            ? config.memory.mounts.map((m, i) => ({ key: m?.storeKey, field: `memory.mounts[${i}].storeKey` }))
            : config.memory.memoryStoreKey ? [{ key: config.memory.memoryStoreKey, field: 'memory.memoryStoreKey' }] : [];
        for (const { key, field } of mounts) {
            if (!key) continue;
            const store = await db.findMemoryStoreByKey(key, projectId).catch(() => null);
            if (!store) issues.errors.push({ field, message: `Memory store "${key}" does not exist` });
        }
    }
    for (const key of config.skills ?? []) {
        const skill = await db.findSkillByKey(key, projectId).catch(() => null);
        if (!skill) issues.errors.push({ field: 'skills', message: `Skill "${key}" does not exist` });
        else if (skill.status !== 'active') issues.warnings.push({ field: 'skills', message: `Skill "${key}" is not active and is skipped` });
    }

    await checkBindingReferences(issues, input.tenantDbName, input.tenantId, projectId, 'toolBindings', config.toolBindings);

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
            } else {
                // A sub-agent is handed free text, never a set of values: a variable the referenced agent
                // requires can only come from a variable of the same name here. Read from the version a run
                // loads (the published one), not the draft being edited.
                const loaded = await resolveSubagentTarget(input.tenantDbName, projectId, entry);
                const missing = loaded.ok ? unsuppliableRequiredVariables(loaded.config.variables, config.variables) : [];
                if (missing.length > 0) {
                    const names = missing.map((name) => `"${name}"`).join(', ');
                    issues.warnings.push({
                        field: `${field}.agentKey`,
                        message: `Agent "${entry.agentKey}" requires the variable${missing.length > 1 ? 's' : ''} ${names}, which this agent does not declare: ${missing.length > 1 ? 'they stay' : 'it stays'} empty when it runs as a sub-agent`,
                    });
                }
            }
        }
        if (entry.knowledgeEngineKey) await checkKnowledge(`${field}.knowledgeEngineKey`, entry.knowledgeEngineKey);
        await checkBindingReferences(issues, input.tenantDbName, input.tenantId, projectId, `${field}.toolBindings`, entry.toolBindings);
    }

    return issues;
}


async function checkBindingReferences(
    issues: Issues,
    tenantDbName: string,
    tenantId: string | undefined,
    projectId: string,
    prefix: string,
    bindings: IAgentToolBinding[] | undefined,
): Promise<void> {
    for (const [index, binding] of (bindings ?? []).entries()) {
        const field = `${prefix}[${index}]`;
        if (!binding?.sourceKey) continue;
        if (binding.source === 'system' && binding.sourceKey === 'crawler') {
            const crawlerKey = binding.config?.crawlerKey;
            if (typeof crawlerKey !== 'string' || !tenantId) continue;
            const crawler = await getCrawler({ tenantDbName, tenantId, projectId }, crawlerKey).catch(() => null);
            if (!crawler) {
                issues.errors.push({ field: `${field}.config.crawlerKey`, message: `Crawler "${crawlerKey}" does not exist in this project` });
            } else if (crawler.status !== 'active') {
                issues.errors.push({ field: `${field}.config.crawlerKey`, message: `Crawler "${crawlerKey}" is not active` });
            } else if (crawlerHasCredentials(crawler.http) && !crawlerHasHostScope(crawler)) {
                // The model picks the URL: credentials may only ride along to hosts the crawler is pinned to.
                issues.errors.push({ field: `${field}.config.crawlerKey`, message: `Crawler "${crawlerKey}" has credentials but no seed URLs or allow list, so an agent cannot use it to fetch pages` });
            }
        } else if (binding.source === 'tool') {
            // Resolved exactly as the runtime resolves it (`buildBoundTools`):
            // this project's row, else the tenant-wide one — never another project's.
            const tool = await resolveAgentBindingTool(tenantDbName, binding.sourceKey, projectId).catch(() => null);
            if (!tool) {
                issues.errors.push({ field, message: `Tool "${binding.sourceKey}" does not exist in this project` });
                continue;
            }
            if (tool.status !== 'active') issues.errors.push({ field, message: `Tool "${binding.sourceKey}" is not active` });
            for (const name of binding.toolNames ?? []) {
                if (!tool.actions.some((action) => action.key === name || action.name === name)) {
                    issues.errors.push({ field: `${field}.toolNames`, message: `Tool "${binding.sourceKey}" has no action "${name}"` });
                }
            }
        } else if (binding.source === 'mcp') {
            const server = await resolveAgentBindingMcpServer(tenantDbName, binding.sourceKey, projectId).catch(() => null);
            if (!server) {
                issues.errors.push({ field, message: `MCP server "${binding.sourceKey}" does not exist in this project` });
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
