/**
 * Sub-agents of an agent run: the roster built into SDK sub-agent definitions, each with its
 * own prompt and model, and the reach rule for agents a flow owns.
 */

import { type IAgent, type IPiiProtectionConfig, getDatabase, type IAgentConfig } from '@/lib/database';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';
import { getFlowsHost } from '@/enterprise/flows';
import type { IAgentSubagent } from '@/lib/database/provider/types.domain';
import type { AgentToolGuard } from './agentToolGuard';
import type { ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';
import { type KbCaller, kbCallerFromRuntime } from '@/lib/services/rag/access';
import { type AgentSpendScope, agentSpendSettler } from './agentSpendLimits';
import { type SessionImagesOptions, withSessionImages } from './sessionImages';
import { type ToolMediaContext, withToolMedia } from './toolMedia';
import type { NormalizedReasoning } from '@/lib/services/models/reasoning';
import { type ResolvedPromptVariables, shouldRenderInlinePrompt, renderPromptTemplate, buildPromptVariables } from './promptVariables';
import {
    type ResolvedHitlConfig,
    type HitlRunMode,
    resolveHitlConfig,
    type ChildApprovalSide,
    resolveHitlRunMode,
    gateChildTools,
} from './agentHumanInTheLoop';
import type { HitlCallLog } from './agentHitlExceptions';
import type { SubagentDef as AgentSdkSubagentDef, ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import type { PricedModel } from './agentCost';
import { assertAgentsEnabled, filterChildSources } from './agentServiceAvailability';
import { getDisabledServices } from '@/lib/services/availability/serviceAvailability';
import { type KnowledgeBindingSource, hasKnowledgeConfigured } from './agentKnowledgeBindings';
import { resolveSubagentTarget } from './subagentRoster';
import { buildAgentKnowledgeTools } from './agentKnowledgeTools';
import { buildBoundTools } from './agentBoundTools';
import { jsonSchemaToZod } from './agentRuntimeConfig';
import { reportPromptVariables, resolveAgentPrompt } from './agentPrompt';
import { delegatedVariableValues } from './agentVariables';
import { getModelByKey } from '@/lib/services/models/modelService';
import { agentReasoningForModel, agentShowsReasoning } from './agentReasoning';
import { buildGatewayChatModel } from './gatewayChatModel';
import { resolveModelCapabilities } from '@/lib/services/models/modelCapabilities';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

/**
 * A hidden agent a flow owns runs only for the flow that owns it (`source: 'flow'`) and for the editor's playground
 * (`source: 'playground'`): the client API, A2A, portals, channels and every other surface see it as missing.
 * `source` is stamped by the server, never taken from a caller.
 */
export function assertOwnedAgentReachable(agent: Pick<IAgent, 'key' | 'owner'>, runtimeContext: AgentRuntimeContext | undefined): void {
    if (!agent.owner) return;
    if (runtimeContext?.source === 'flow' || runtimeContext?.source === 'playground') return;
    throw new Error(`Agent "${agent.key}" not found`);
}

/** The `flowId` / `flowKey` / `flowName` trace tags of an agent a flow owns (the flow row is read; missing = no tags). */
export async function ownedAgentFlowTags(tenantDbName: string, agent: Pick<IAgent, 'owner' | 'tenantId' | 'projectId'>): Promise<Record<string, string> | undefined> {
    if (!agent.owner) return undefined;
    const flow = await getFlowsHost()
        ?.describeFlow({ tenantDbName, tenantId: agent.tenantId, projectId: agent.projectId }, { id: agent.owner.flowId })
        .catch(() => null);
    return {
        flowId: agent.owner.flowId,
        ...(flow ? { flowKey: flow.key, flowName: flow.name } : {}),
    };
}

// ── Sub-agent registry ──────────────────────────────────────────────

/** Who a model call is made for: rides on its usage row and its Dynamic LLM caller conditions. */
export interface AgentModelCaller {
    agentKey?: string;
    /** The Session / API conversation. */
    sessionId?: string;
    userId?: string;
    /** The agent's reversible PII protection: every model call of the run carries it. */
    piiProtection?: IPiiProtectionConfig | null;
}

/** What a sub-agent's own model call is told about output tokens (see `buildSubagentModel`). */
export type SubagentOutputOptions = { maxTokens?: number; maxTotalOutputTokens?: number };

type BuildSubagentsInput = {
    db: Awaited<ReturnType<typeof getDatabase>>;
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    /** The parent agent: an inline child's bindings may use its own MCP servers (`IAgentResourceOwner`). */
    agentId?: string;
    /** The entries that can run (`activeSubagentEntries`): a roster switched off is never built. */
    subagents: IAgentSubagent[];
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool;
    zod: typeof import('zod').z;
    guard: AgentToolGuard;
    runtimeContext?: AgentRuntimeContext;
    /** Who the run is for (Console identity); a referenced child acts under its own agent key. */
    identity?: ConsoleIdentityCaller;
    /** Who a child's knowledge tools read for: the parent run's caller (default: from `runtimeContext`). */
    kbCaller?: KbCaller;
    /** Who a sub-agent model's spend is attributed to (tenant spend limits). */
    spend?: AgentSpendScope;
    /** The session's images, read at a sub-agent's own model call (see `sessionImages.ts`). */
    images?: SessionImagesOptions;
    /** The run's tool-image store: a child's tools show their images the same way (judged by the child's own model). */
    toolMedia?: ToolMediaContext;
    /** The parent's model takes images: what a child without a model of its own runs on. */
    modelTakesImages?: boolean;
    /** Whose run this is, for the usage rows of a sub-agent's model calls. */
    caller?: AgentModelCaller;
    /**
     * The parent's output settings, which a sub-agent's own model call carries as the parent's
     * does: the per-call `max_tokens` and the run's `maxTotalOutputTokens` (a raised retry's budget).
     */
    output?: SubagentOutputOptions;
    /**
     * Reasoning of a sub-agent's model: the parent's selection for the same
     * model (when it is one the parent picked), then Model Hub, then the request.
     */
    reasoning?: { config: IAgentConfig; request?: NormalizedReasoning };
    /** What a child's system prompt is rendered from. */
    prompt: {
        /** The parent's config and prompt variables: a prompt written in its config (an inline child's) renders as the parent's own does. */
        parent: { config: IAgentConfig; variables: ResolvedPromptVariables };
        /** The parent run's validated agent variables: a referenced agent's variables of the same name take their values. */
        variables?: Record<string, unknown>;
        variablesInPrompt?: boolean;
        userId?: string;
    };
    /** Reports, once, a child that was skipped or runs short of what its author set up. */
    onWarning?: (message: string) => void;
    /**
     * How the delegating run answers tool approvals, so a child's tools are gated like the parent's own:
     * the parent's settings and mode, and (for a `ref` child) its agent's settings under the same run.
     */
    approvals?: {
        hitl: ResolvedHitlConfig;
        mode: HitlRunMode;
        run: { unattended?: boolean; canPause?: boolean };
        allowedTools: ReadonlySet<string>;
        /** Where the gates record what they decided (why a call waits, what an exception let through or refused). */
        log?: HitlCallLog;
    };
};

/**
 * Turns `config.subagents` into the SDK's sub-agent registry.
 *
 * `inline` children are defined entirely in the parent's config. `ref` children
 * borrow another console agent's prompt, model and tools — resolved from that
 * agent's PUBLISHED config unless a version is pinned, so editing a draft can
 * never change what a parent delegates to mid-flight.
 *
 * A `ref` child's own sub-agents are deliberately dropped: the SDK already
 * enforces a depth budget, and expanding a reference tree here would let one
 * edit in a leaf agent silently multiply every parent's tool surface. Nesting
 * beyond one level is expressed with the SDK's own `maxDepth`, not by inlining.
 */
export async function buildAgentSubagents(
    input: BuildSubagentsInput,
): Promise<{ subagents: AgentSdkSubagentDef[]; cleanupTasks: Array<() => Promise<void>>; models: PricedModel[] }> {
    const entries = input.subagents;
    if (entries.length === 0) return { subagents: [], cleanupTasks: [], models: [] };
    // A child is an agent run of the same tenant: refused with the agents service,
    // and its own knowledge and tools lose what a switched-off service provided.
    await assertAgentsEnabled({ tenantId: input.tenantId, tenantDbName: input.tenantDbName });
    const disabledServices = await getDisabledServices(input.tenantId);

    const subagents: AgentSdkSubagentDef[] = [];
    const cleanupTasks: Array<() => Promise<void>> = [];
    // The models the children were given, as the turn's cost estimator needs them.
    const models: PricedModel[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        if (!entry.name || seen.has(entry.name)) {
            const message = entry.name
                ? `Sub-agent name "${entry.name}" is used more than once: only the first one is available.`
                : 'A sub-agent has no name, so it was skipped.';
            logger.warn(message, { name: entry.name });
            input.onWarning?.(message);
            continue;
        }

        let systemPrompt: string | undefined;
        let toolBindings = entry.toolBindings;
        let childAgentId: string | undefined;
        let knowledgeSource: KnowledgeBindingSource = { knowledgeEngineKey: entry.knowledgeEngineKey };
        let modelKey = entry.modelKey;
        let targetHitl: ResolvedHitlConfig | undefined;
        // The parent's output settings, unless the child states its own (its agent's `maxTokens`, its own limits).
        const output: SubagentOutputOptions = { ...input.output };
        if (Number(entry.limits?.maxTotalOutputTokens) > 0) output.maxTotalOutputTokens = Number(entry.limits?.maxTotalOutputTokens);

        if (entry.kind === 'ref') {
            const target = await resolveSubagentTarget(input.tenantDbName, input.projectId, entry);
            if (!target.ok) {
                logger.warn(target.message, { name: entry.name, agentKey: entry.agentKey, reason: target.reason });
                input.onWarning?.(target.message);
                continue;
            }
            systemPrompt = await resolveChildPrompt(input, entry, target);
            toolBindings = target.config.toolBindings;
            childAgentId = target.agent._id ? String(target.agent._id) : undefined;
            knowledgeSource = {
                knowledgeEngineKey: target.config.knowledgeEngineKey,
                knowledgeBindings: target.config.knowledgeBindings,
                knowledgeToolMode: target.config.knowledgeToolMode,
            };
            modelKey = entry.modelKey ?? target.config.modelKey;
            targetHitl = resolveHitlConfig(target.config.humanInTheLoop);
            if (target.config.maxTokens !== undefined) output.maxTokens = target.config.maxTokens;
        }

        if (entry.kind !== 'ref') systemPrompt = await resolveChildPrompt(input, entry);

        // A child nobody gave instructions runs as its name and header say, which is what the SDK
        // would make of it too (older SDKs left it the generic base prompt), and the owner is told.
        if (!systemPrompt?.trim()) {
            systemPrompt = `You are ${entry.title || entry.name}. ${entry.header || entry.title || entry.name}`;
            input.onWarning?.(`Sub-agent "${entry.name}" has no instructions of its own${
                entry.kind === 'ref' ? ` ("${entry.agentKey}" has no system prompt, or its prompt could not be found)` : ''
            }, so it runs on its name and header alone.`);
        }

        const childTools: AgentSdkToolInterface[] = [];
        ({ knowledge: knowledgeSource, toolBindings } = filterChildSources(knowledgeSource, toolBindings, disabledServices));
        if (hasKnowledgeConfigured(knowledgeSource)) {
            const knowledge = await buildAgentKnowledgeTools(
                input.tenantDbName,
                input.tenantId,
                input.projectId,
                knowledgeSource,
                input.guard,
                // A child reads for the same caller as the run that delegated to it.
                { caller: input.kbCaller ?? kbCallerFromRuntime(input.runtimeContext) },
            );
            childTools.push(...knowledge.tools);
        }
        if (toolBindings && toolBindings.length > 0) {
            const bound = await buildBoundTools(
                input.tenantDbName,
                input.tenantId,
                input.projectId,
                toolBindings,
                input.createToolFn,
                input.zod,
                input.guard,
                input.runtimeContext,
                input.identity && entry.kind === 'ref' && entry.agentKey
                    ? { ...input.identity, agentKey: entry.agentKey }
                    : input.identity,
                undefined,
                // Whose own MCP servers the child's bindings may use: the referenced agent's, or (inline) its parent's.
                entry.kind === 'ref' ? childAgentId : input.agentId,
            );
            childTools.push(...bound.tools);
            cleanupTasks.push(...bound.cleanupTasks);
        }

        if (input.approvals && childTools.length > 0) {
            const { hitl, mode, run, allowedTools, log } = input.approvals;
            const sides: ChildApprovalSide[] = [{ hitl, mode }];
            if (targetHitl) sides.push({ hitl: targetHitl, mode: resolveHitlRunMode(targetHitl, run) });
            childTools.splice(0, childTools.length, ...gateChildTools(childTools, sides, allowedTools, log));
        }

        let childModel: unknown;
        let childTakesImages = input.modelTakesImages === true;
        if (modelKey) {
            const built = await buildSubagentModel(input.tenantDbName, input.tenantId, input.projectId, modelKey, input.spend, input.images, input.reasoning, input.caller, output);
            if (built.ok) {
                childModel = built.chatModel;
                // Its model is only wrapped to resolve image references when the run has image options.
                childTakesImages = built.takesImages && Boolean(input.images);
                models.push(built.model);
            } else {
                input.onWarning?.(`Sub-agent "${entry.name}" runs on this agent's model: ${built.message}.`);
            }
        }

        // Taken only now that the entry will be built: a reference that could not run must not
        // make a later, working one of the same name look like the duplicate.
        seen.add(entry.name);
        subagents.push({
            name: entry.name,
            ...(entry.title ? { title: entry.title } : {}),
            header: entry.header || entry.title || entry.name,
            systemPrompt,
            ...(childTools.length > 0
                ? { tools: input.toolMedia ? childTools.map((tool) => withToolMedia(tool, { ...input.toolMedia!, modelTakesImages: childTakesImages })) : childTools }
                : {}),
            ...(childModel ? { model: childModel } : {}),
            ...(entry.limits ? { limits: entry.limits } : {}),
            ...(entry.childContextPolicy ? { childContextPolicy: entry.childContextPolicy } : {}),
            ...(entry.outputSchema
                ? { outputSchema: jsonSchemaToZod(entry.outputSchema) }
                : {}),
            metadata: { kind: entry.kind, ...(entry.agentKey ? { agentKey: entry.agentKey } : {}) },
        });
    }

    return { subagents, cleanupTasks, models };
}

/**
 * The system prompt a sub-agent runs with, resolved the way its own agent's run
 * would resolve it. A `ref` entry that sets no prompt of its own runs the prompt
 * of the agent it points at: that agent's `promptKey` template, or its inline
 * text, rendered with ITS prompt variables (identity, defaults, and the delegating
 * run's values for the variables it declares). A prompt written in the delegating
 * agent's own config — an inline child's, or a `ref` entry's override — renders the
 * way that agent's own prompt does. Undefined when there is none.
 */
async function resolveChildPrompt(
    input: BuildSubagentsInput,
    entry: IAgentSubagent,
    target?: Extract<Awaited<ReturnType<typeof resolveSubagentTarget>>, { ok: true }>,
): Promise<string | undefined> {
    const { parent } = input.prompt;
    const authored = entry.systemPrompt?.trim() ? entry.systemPrompt : undefined;
    if (authored || !target) {
        if (!authored) return undefined;
        if (!shouldRenderInlinePrompt(parent.config, authored)) return authored;
        const rendered = renderPromptTemplate(authored, parent.variables);
        reportPromptVariables(rendered, { agentKey: input.caller?.agentKey ?? '' });
        return rendered.text;
    }
    const agentKey = entry.agentKey ?? '';
    return resolveAgentPrompt({
        db: input.db,
        projectId: input.projectId,
        agentKey,
        config: target.config,
        systemPrompt: target.config.systemPrompt,
        variables: buildPromptVariables({
            config: target.config,
            agentKey,
            agentName: target.agent.name,
            version: target.resolvedVersion,
            runtimeContext: input.runtimeContext,
            userId: input.prompt.userId,
            variables: delegatedVariableValues(target.config.variables, input.prompt.variables),
            variablesInPrompt: input.prompt.variablesInPrompt,
        }),
    });
}

/**
 * Builds the gateway chat model for a sub-agent's model override. Answers why
 * when the key no longer resolves (or the model cannot be set up), which makes
 * the child fall back to the parent's model rather than failing the whole run;
 * the caller reports it.
 *
 * Like every agent model it is a call into the gateway (gatewayChatModel.ts), so the
 * model's own guardrails, cache, pool and routing apply to the child too, and its
 * usage row (`agent.subagent`) lands on ITS model.
 */
export async function buildSubagentModel(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    modelKey: string,
    spend?: AgentSpendScope,
    images?: SessionImagesOptions,
    reasoning?: BuildSubagentsInput['reasoning'],
    caller?: AgentModelCaller,
    output?: SubagentOutputOptions,
): Promise<{ ok: true; chatModel: unknown; model: PricedModel; takesImages: boolean } | { ok: false; message: string }> {
    try {
        const model = await getModelByKey(tenantDbName, modelKey, projectId);
        if (!model || model.category !== 'llm') {
            logger.warn('Sub-agent model override is not a chat model of this project; falling back to parent model', { modelKey });
            return { ok: false, message: `model "${modelKey}" does not exist in this project or is not a chat model` };
        }
        const agentPick = agentReasoningForModel(reasoning?.config, modelKey);
        const chatModel = await buildGatewayChatModel({
            tenantDbName,
            tenantId,
            projectId,
            model,
            route: 'agent.subagent',
            // Like the main agent's model: the per-call limit rides as the call's own setting, and the
            // run's output budget bounds a raised retry.
            ...(output?.maxTokens !== undefined ? { overrides: { max_tokens: output.maxTokens } } : {}),
            ...(output?.maxTotalOutputTokens !== undefined && output.maxTotalOutputTokens > 0 ? { maxTotalOutputTokens: output.maxTotalOutputTokens } : {}),
            ...(caller?.agentKey ? { agentKey: caller.agentKey } : {}),
            ...(caller?.sessionId ? { sessionId: caller.sessionId } : {}),
            ...(caller?.userId ? { userId: caller.userId } : {}),
            ...(caller?.piiProtection ? { piiProtection: caller.piiProtection } : {}),
            ...(agentPick ? { reasoning: agentPick } : {}),
            ...(reasoning?.request ? { requestReasoning: reasoning.request } : {}),
            ...(reasoning?.config && !agentShowsReasoning(reasoning.config) ? { showReasoning: false } : {}),
            ...(spend ? { onCost: agentSpendSettler(spend, model.key) } : {}),
        });
        // A sub-agent can be handed the parent's context, image references included.
        return {
            ok: true,
            chatModel: images ? withSessionImages(chatModel, images) : chatModel,
            model: { key: model.key, modelId: model.modelId, providerKey: model.providerKey, providerDriver: model.providerDriver, pricing: model.pricing },
            takesImages: resolveModelCapabilities(model).inputModalities.includes('image'),
        };
    } catch (error) {
        logger.warn('Sub-agent model override could not be built; falling back to parent model', {
            modelKey,
            error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: `model "${modelKey}" could not be set up` };
    }
}
