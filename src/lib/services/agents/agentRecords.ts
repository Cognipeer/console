/**
 * Agent records: create, update, delete, read, publish and versions, plus the chat model an
 * agent run talks to and the model connection check.
 */

import { getDatabase, type IAgent, runWithTenantScope, type IAgentVersion } from '@/lib/database';
import { sealAgentConfigSecrets } from './agentSandboxSecrets';
import { migrateAgentReasoning } from './agentReasoning';
import { stripLegacyExecutionConfig } from './agentCallbackConfig';
import { detachConnectorTriggers } from './agentTriggerConnectorHost';
import { deleteAgentOwnedResources } from './agentOwnedResources';
import { type NativeAgentReasoning, buildGatewayChatModel } from './gatewayChatModel';
import { getModelByKey } from '@/lib/services/models/modelService';
import type { AgentModelCaller } from './agentSubagents';
import { describeTurnOutcome, type AgentTurnOutcome } from './agentTurnState';
import { type OutputLimitTap, markOutputLimitNotice } from './outputLimitNotice';
import { annotateAgentRunError, classifyAgentRunError } from './agentErrors';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

/**
 * A new message dropped the session's pause (`cancel_pending`): the run that
 * waited on it ends `canceled`, with its notifications, instead of staying
 * `requires_action` for good. Never fails the turn.
 */
export async function endRunsOfDroppedPause(
    db: Awaited<ReturnType<typeof getDatabase>>,
    scope: { tenantId: string; projectId: string; conversationId: string },
): Promise<void> {
    try {
        // Loaded here: agentRunService imports this module.
        const { cancelPausedAgentRuns } = await import('./agentRunService');
        await cancelPausedAgentRuns(db, scope);
    } catch (error) {
        logger.warn('Could not end the paused run of a dropped pause', {
            conversationId: scope.conversationId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** How many replaced answers a regenerated message remembers. */
export const MAX_PREVIOUS_VERSIONS = 5;

// ── Utility ──────────────────────────────────────────────────────────

function generateAgentKey(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const suffix = Math.random().toString(36).substring(2, 8);
    return `${slug}-${suffix}`;
}

// ── Agent CRUD ───────────────────────────────────────────────────────

export async function createAgentRecord(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    data: {
        name: string;
        description?: string;
        config: IAgent['config'];
        status?: IAgent['status'];
        /** A key chosen by the caller (checked for uniqueness below). Default: the name as a slug plus a random suffix. */
        key?: string;
        /** Where the agent came from (`metadata.template` for an agent made from a template). */
        metadata?: IAgent['metadata'];
        /** Makes it a hidden agent owned by a flow node (never listed; see `flows/ownedAgents.ts`). */
        owner?: IAgent['owner'];
    },
): Promise<IAgent> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const key = data.key ?? generateAgentKey(data.name);

    // Verify uniqueness
    const existing = await db.findAgentByKey(key, projectId);
    if (existing) {
        throw new Error(`Agent key "${key}" already exists`);
    }

    const agent = await db.createAgent({
        tenantId,
        projectId,
        key,
        name: data.name,
        description: data.description,
        // Sandbox secrets are sealed here, the one write path every creator
        // (dashboard, client API) goes through.
        config: sealAgentConfigSecrets(migrateAgentReasoning(data.config), undefined),
        status: data.status || 'active',
        ...(data.metadata ? { metadata: data.metadata } : {}),
        ...(data.owner ? { owner: data.owner } : {}),
        createdBy: userId,
    });

    logger.info('Agent created', { key, projectId });
    return agent;
}

export async function updateAgentRecord(
    tenantDbName: string,
    agentId: string,
    data: Partial<Omit<IAgent, 'tenantId' | 'key' | 'createdBy'>>,
    userId: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // Old Advanced-tab reasoning moves next to the model on every save.
    if (data.config) data = { ...data, config: migrateAgentReasoning(data.config) };
    if (data.config?.sandbox || data.config?.callback !== undefined) {
        // `config` replaces the stored one wholesale; masked secret values
        // must resolve against what is stored, not be saved as the mask —
        // and a plaintext secret (sandbox secrets, the callback secret) must
        // be sealed before it is written. A callback sent without a URL (or
        // as `null`) is the way to remove it: the field is dropped here.
        const current = await db.findAgentById(agentId);
        data = { ...data, config: sealAgentConfigSecrets(data.config, current?.config) };
    } else if (data.config) {
        // The removed Execution settings a stored config may still carry go on save.
        data = { ...data, config: stripLegacyExecutionConfig(data.config) };
    }
    return db.updateAgent(agentId, { ...data, updatedBy: userId });
}

export async function deleteAgentRecord(
    tenantDbName: string,
    agentId: string,
): Promise<boolean> {
    return runWithTenantScope(tenantDbName, async (db) => {
        const agent = await db.findAgentById(agentId);
        const deleted = await db.deleteAgent(agentId);
        // Its triggers (and their webhook delivery logs) go with it: nothing could fire them any more.
        if (deleted && agent) {
            const triggers = await db.listAgentTriggers({ tenantId: agent.tenantId, projectId: agent.projectId, agentKey: agent.key });
            // A connector trigger gives up its subscription while its row still exists.
            await detachConnectorTriggers({ tenantId: agent.tenantId, tenantDbName }, triggers);
            for (const trigger of triggers) await db.deleteAgentTriggerDeliveries(String(trigger._id));
            await db.deleteAgentTriggersForAgent(agent.tenantId, agent.projectId, agent.key);
        }
        return deleted;
    }).then(async (deleted) => {
        // The MCP servers and skills created inside the agent were part of it, so they go too.
        if (deleted) await deleteAgentOwnedResources(tenantDbName, agentId);
        return deleted;
    });
}

export async function getAgentById(
    tenantDbName: string,
    agentId: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return withMigratedReasoning(await db.findAgentById(agentId));
}

/**
 * An agent by key, for the API surfaces that look agents up by name (the client API, A2A, the OpenAI
 * bridge, triggers, analysis...). A hidden agent owned by a flow node is NOT found here - it is not
 * addressable from outside its flow - unless the caller is the machinery behind the owning flow
 * (`includeOwned`: trace sessions, approval and session access checks).
 */
export async function getAgentByKey(
    tenantDbName: string,
    key: string,
    projectId?: string,
    options: { includeOwned?: boolean } = {},
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const agent = await db.findAgentByKey(key, projectId);
    if (agent?.owner && !options.includeOwned) return null;
    return withMigratedReasoning(agent);
}

/** Read-side half of the `runtime.reasoning` migration (the save side is in create/update). */
function withMigratedReasoning(agent: IAgent | null): IAgent | null {
    if (!agent?.config) return agent;
    const config = migrateAgentReasoning(agent.config);
    return config === agent.config ? agent : { ...agent, config };
}

export async function listAgents(
    tenantDbName: string,
    // Hidden agents owned by a flow node are left out unless `owned` asks for them (see the provider's `listAgents`).
    filters?: { projectId?: string; status?: IAgent['status']; search?: string; owned?: 'include' | 'only'; ownerFlowId?: string },
): Promise<IAgent[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgents(filters);
}

// ── Agent Publish & Versioning ───────────────────────────────────────

/**
 * Publishes the current agent config as a new immutable version.
 * After publishing, API/SDK calls will use this version by default.
 */
export async function publishAgent(
    tenantDbName: string,
    agentId: string,
    userId: string,
    changelog?: string,
): Promise<IAgentVersion> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const agent = await db.findAgentById(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);

    // Keep versioning monotonic even if agent.latestVersion was not persisted
    // correctly in older SQLite writes.
    const latestPublishedSnapshot = await db.findLatestAgentVersion(String(agent._id));
    const latestKnownVersion = Math.max(
      agent.latestVersion ?? 0,
      agent.publishedVersion ?? 0,
      latestPublishedSnapshot?.version ?? 0,
    );
    const nextVersion = latestKnownVersion + 1;

    // An imported agent waits as a draft until someone reviews and publishes it, so
    // publishing turns it on. An agent someone switched off stays inactive.
    const status = agent.status === 'draft' ? 'active' : agent.status;

    const version = await db.createAgentVersion({
        tenantId: agent.tenantId,
        projectId: agent.projectId,
        agentId: String(agent._id),
        agentKey: agent.key,
        version: nextVersion,
        snapshot: {
            name: agent.name,
            description: agent.description,
            config: agent.config,
            status,
        },
        changelog,
        publishedBy: userId,
    });

    // Update agent with latest published version
    await db.updateAgent(agentId, {
        publishedVersion: nextVersion,
        latestVersion: nextVersion,
        ...(status !== agent.status ? { status } : {}),
        updatedBy: userId,
    });

    logger.info('Agent published', {
        agentId,
        agentKey: agent.key,
        version: nextVersion,
    });

    return version;
}

export async function getAgentVersion(
    tenantDbName: string,
    agentId: string,
    version: number,
): Promise<IAgentVersion | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentVersion(agentId, version);
}

export async function listAgentVersions(
    tenantDbName: string,
    agentId: string,
    options?: { limit?: number; skip?: number },
): Promise<{ versions: IAgentVersion[]; total: number }> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgentVersions(agentId, options);
}

/**
 * Which version of an agent a realtime (voice) session should run, as the
 * `version` to hand `executePlaygroundChat` — undefined means the draft.
 *
 * Realtime presets default to `'published'`: a phone line is production
 * traffic and must not change under it each time someone edits the draft.
 * With nothing published (or the snapshot missing) it falls back to the draft,
 * the same rule `resolveAgentConfig` applies to API calls. An unknown agent
 * resolves to undefined rather than throwing: the run that follows fails with
 * the proper "not found" error on the path that already reports it.
 */
export async function resolveAgentVoiceVersion(params: {
    tenantDbName: string;
    projectId?: string;
    agentKey: string;
    prefer: 'published' | 'draft';
}): Promise<number | undefined> {
    if (params.prefer === 'draft') return undefined;
    const db = await getDatabase();
    await db.switchToTenant(params.tenantDbName);
    const agent = await db.findAgentByKey(params.agentKey, params.projectId);
    if (!agent) {
        logger.warn('Voice version lookup: agent not found', { agentKey: params.agentKey });
        return undefined;
    }
    if (!agent.publishedVersion) return undefined;
    const snapshot = await db.findAgentVersion(String(agent._id), agent.publishedVersion);
    return snapshot ? snapshot.version : undefined;
}

// ── Model connection check ───────────────────────────────────────────

export interface AgentModelCheckResult {
    ok: boolean;
    latencyMs: number;
    /** Set when the check failed — see `classifyAgentRunError`. */
    error?: { message: string; type: string; code?: string | null };
}

/**
 * The chat model an agent run (or the model check, or a title) talks to: an
 * agent-sdk chat model whose every call is a call into the gateway
 * (gatewayChatModel.ts) - so whatever is configured on the Model Hub record applies
 * to the agent too. A Dynamic LLM is no different: the gateway routes it per call.
 */
export async function buildAgentChatModel(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    modelKey: string,
    overrides: Record<string, unknown> = {},
    /** What the agent selected for this model (wins over everything). */
    reasoning?: NativeAgentReasoning,
    /** What the API request asked for (lowest rung; see agentReasoning.ts). */
    requestReasoning?: NativeAgentReasoning,
    /** What this call is for and who it is made for: the usage row's route and attribution, spend, routing. */
    call: AgentModelCall = {},
) {
    const model = await getModelByKey(tenantDbName, modelKey, projectId);
    if (!model) throw new Error(`Model "${modelKey}" not found`);
    if (model.category !== 'llm') throw new Error('Configured model is not compatible with chat');

    // Top P, Max Tokens, `unsupportedParams` and `requestDefaults` take effect inside
    // the gateway, exactly as for any other caller of the model.
    const passthrough: Record<string, unknown> = {};
    for (const key of ['temperature', 'top_p', 'max_tokens'] as const) {
        if (overrides[key] !== undefined) passthrough[key] = overrides[key];
    }
    const chatModel = await buildGatewayChatModel({
        tenantDbName,
        tenantId,
        projectId,
        model,
        overrides: passthrough,
        ...(reasoning ? { reasoning } : {}),
        ...(requestReasoning ? { requestReasoning } : {}),
        ...call,
    });
    return { model, chatModel };
}

/** The usage-row side of `buildAgentChatModel`. */
export type AgentModelCall = AgentModelCaller & Pick<Parameters<typeof buildGatewayChatModel>[0], 'route' | 'purpose' | 'showReasoning' | 'onReasoning' | 'onCost' | 'onRouted' | 'maxTotalOutputTokens' | 'outputLimitTap'>;

/**
 * `describeTurnOutcome` for a run of the agent's own model: it is told how the model's last call
 * ended at its output limit, and a limit notice is flagged in the run's state so the next turn
 * does not replay it to the model (outputLimitNotice.ts).
 */
export function describeRunOutcome(
    result: Parameters<typeof describeTurnOutcome>[0],
    inputMessageCount: number,
    outputLimit: OutputLimitTap,
): AgentTurnOutcome {
    const report = outputLimit.latest();
    markOutputLimitNotice(result.state, report);
    return describeTurnOutcome(result, inputMessageCount, report);
}

/**
 * One tiny completion through exactly the path an agent run uses (the model's
 * provider runtime and invocation settings), so a wrong API key or a deleted
 * deployment shows up on the Configure page — not as an agent that "doesn't
 * answer" in its first session.
 */
export async function checkAgentModel(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    modelKey: string,
): Promise<AgentModelCheckResult> {
    const startedAt = Date.now();
    try {
        const { model, chatModel } = await buildAgentChatModel(
            tenantDbName, tenantId, projectId, modelKey, {}, undefined, undefined,
            { route: 'agent.check', purpose: 'model-check' },
        );
        await chatModel
            .invoke([{ role: 'user', content: 'Reply with the single word OK.' }])
            .catch((error: unknown) => {
                throw annotateAgentRunError(error, { modelKey: model.key, providerKey: model.providerKey });
            });
        return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
        logger.info('Agent model check failed', {
            modelKey,
            error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, latencyMs: Date.now() - startedAt, error: classifyAgentRunError(error, { exposeInternal: true }).error };
    }
}
