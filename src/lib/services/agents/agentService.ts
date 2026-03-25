/**
 * Agent Service
 *
 * Business logic for agent CRUD and chat orchestration.
 * Uses agent-sdk for runtime execution with automatic tracing.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type IAgent, type IAgentConfig, type IAgentConversation, type IAgentVersion } from '@/lib/database';
import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { queryRag } from '@/lib/services/rag/ragService';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import { getMcpServerByKey, executeMcpTool } from '@/lib/services/mcp';
import { getToolByKey, executeToolAction, logToolRequest } from '@/lib/services/tools';

const logger = createLogger('agents');

// ── Tool Bridge ─────────────────────────────────────────────────────

/**
 * Converts IAgentToolBinding entries into agent-sdk ToolInterface instances.
 * Supports two source types:
 *   - 'tool'  – unified tool system (OpenAPI / MCP sources)
 *   - 'mcp'   – legacy direct MCP server bindings (backward compat)
 */
async function buildBoundTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bindings: { source: string; sourceKey: string; toolNames: string[] }[] | undefined,
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool,
    zod: typeof import('zod').z,
): Promise<any[]> {
    if (!bindings || bindings.length === 0) return [];

    const tools: any[] = [];

    for (const binding of bindings) {
        if (binding.source === 'tool') {
            // ── Unified tool system ──────────────────────────────
            const toolRecord = await getToolByKey(tenantDbName, binding.sourceKey);
            if (!toolRecord || toolRecord.status !== 'active') {
                logger.warn('Skipping inactive/missing tool', { key: binding.sourceKey });
                continue;
            }

            for (const actionName of binding.toolNames) {
                const action = toolRecord.actions.find(
                    (a) => a.key === actionName || a.name === actionName,
                );
                if (!action) {
                    logger.warn('Tool action not found, skipping', {
                        tool: binding.sourceKey,
                        action: actionName,
                    });
                    continue;
                }

                const tool = createToolFn({
                    name: action.name,
                    description: action.description || `Call ${action.name} on ${toolRecord.name}`,
                    schema: zod.object({}).passthrough(),
                    func: async (args: Record<string, unknown>) => {
                        try {
                            const { result, latencyMs } = await executeToolAction(toolRecord, action.key, args);
                            logToolRequest(
                                tenantDbName, tenantId, toolRecord.projectId,
                                toolRecord.key, action.key, action.name,
                                'success', latencyMs,
                                args,
                                typeof result === 'object' ? (result as Record<string, unknown>) : { value: result },
                                undefined,
                                'agent',
                            );
                            return typeof result === 'string' ? result : JSON.stringify(result);
                        } catch (execError) {
                            const errorMessage = execError instanceof Error ? execError.message : 'Failed to execute tool action';
                            logToolRequest(
                                tenantDbName, tenantId, toolRecord.projectId,
                                toolRecord.key, action.key, action.name,
                                'error', 0,
                                args,
                                undefined,
                                errorMessage,
                                'agent',
                            );
                            throw execError;
                        }
                    },
                });
                tools.push(tool);
            }
        } else if (binding.source === 'mcp') {
            // ── Legacy MCP server bindings ───────────────────────
            const server = await getMcpServerByKey(tenantDbName, binding.sourceKey);
            if (!server || server.status !== 'active') {
                logger.warn('Skipping inactive/missing MCP server', { key: binding.sourceKey });
                continue;
            }

            for (const toolName of binding.toolNames) {
                const mcpToolDef = server.tools.find((t) => t.name === toolName);
                if (!mcpToolDef) {
                    logger.warn('MCP tool not found, skipping', {
                        server: binding.sourceKey,
                        tool: toolName,
                    });
                    continue;
                }

                const tool = createToolFn({
                    name: mcpToolDef.name,
                    description: mcpToolDef.description || `Call ${mcpToolDef.name} on ${server.name}`,
                    schema: zod.object({}).passthrough(),
                    func: async (args: Record<string, unknown>) => {
                        const { result } = await executeMcpTool(server, toolName, args);
                        return typeof result === 'string' ? result : JSON.stringify(result);
                    },
                });
                tools.push(tool);
            }
        }
    }

    return tools;
}

// ── Internal Tracing Sink ────────────────────────────────────────────

/**
 * Creates a customSink that saves trace sessions directly to the database,
 * bypassing the HTTP tracing endpoint and its API-token authentication.
 * This is used for internal agent executions (dashboard playground & client API chat).
 */
async function createInternalTracingSink(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
) {
    const { customSink } = await import('@cognipeer/agent-sdk');

    return customSink({
        onSession: async (session: any) => {
            try {
                const db = await getDatabase();
                await db.switchToTenant(tenantDbName);

                const events = Array.isArray(session.events) ? session.events : [];

                // Extract models and tools used
                const modelsUsed = new Set<string>();
                const toolsUsed = new Set<string>();
                for (const event of events) {
                    if (event?.model) modelsUsed.add(event.model);
                    if (event?.toolName) toolsUsed.add(event.toolName);
                    if (event?.actor?.scope === 'tool' && event?.actor?.name) {
                        toolsUsed.add(event.actor.name);
                    }
                }
                if (session?.agent?.model) modelsUsed.add(session.agent.model);

                const sessionDoc = {
                    sessionId: session.sessionId,
                    threadId: session.threadId,
                    tenantId,
                    projectId,
                    agent: session.agent || {},
                    agentName: session.agent?.name || null,
                    agentVersion: session.agent?.version || null,
                    agentModel: session.agent?.model || null,
                    config: session.config || {},
                    summary: session.summary || {},
                    status: session.status || 'unknown',
                    startedAt: session.startedAt ? new Date(session.startedAt) : new Date(),
                    endedAt: session.endedAt ? new Date(session.endedAt) : undefined,
                    durationMs: session.durationMs || null,
                    errors: session.errors || [],
                    modelsUsed: Array.from(modelsUsed),
                    toolsUsed: Array.from(toolsUsed),
                    eventCounts: session.summary?.eventCounts || {},
                    totalEvents: events.length,
                    totalInputTokens: session.summary?.totalInputTokens || 0,
                    totalOutputTokens: session.summary?.totalOutputTokens || 0,
                    totalCachedInputTokens: session.summary?.totalCachedInputTokens || 0,
                    totalBytesIn: session.summary?.totalBytesIn || null,
                    totalBytesOut: session.summary?.totalBytesOut || null,
                };

                // Upsert session
                const existing = await db.findAgentTracingSessionById(session.sessionId, projectId);
                if (existing) {
                    await db.updateAgentTracingSession(session.sessionId, sessionDoc, projectId);
                } else {
                    await db.createAgentTracingSession(sessionDoc);
                }

                // Replace events
                await db.deleteAgentTracingEvents(session.sessionId, projectId);
                for (const event of events) {
                    const sections = Array.isArray(event?.sections)
                        ? event.sections
                        : Array.isArray(event?.data?.sections)
                            ? event.data.sections
                            : [];

                    const usage = event?.usage || event?.metadata?.usage || {};
                    const inputTokens =
                        event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens ?? null;
                    const outputTokens =
                        event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens ?? null;
                    const cachedInputTokens =
                        event?.cachedInputTokens ??
                        usage?.cachedInputTokens ??
                        usage?.cached_input_tokens ??
                        usage?.cacheReadInputTokens ??
                        usage?.cache_read_input_tokens ??
                        null;

                    await db.createAgentTracingEvent({
                        sessionId: session.sessionId,
                        tenantId,
                        projectId,
                        id: event.id || null,
                        type: event.type || null,
                        label: event.label || null,
                        sequence: event.sequence || 0,
                        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
                        status: event.status || null,
                        actor: event.actor || {},
                        metadata: event.metadata || {},
                        sections,
                        modelNames: event.modelNames || [],
                        model: event.model || null,
                        error: event.error || null,
                        durationMs: event.durationMs || null,
                        actorName: event.actor?.name || null,
                        actorRole: event.actor?.role || event.actor?.scope || null,
                        toolName:
                            event.toolName ||
                            (event.actor?.scope === 'tool' ? event.actor?.name : null),
                        toolExecutionId: event.toolExecutionId || null,
                        inputTokens,
                        outputTokens,
                        cachedInputTokens,
                        totalTokens: event.totalTokens || null,
                        bytesIn: event.bytesIn || null,
                        bytesOut: event.bytesOut || null,
                        requestBytes: event.requestBytes || null,
                        responseBytes: event.responseBytes || null,
                    });
                }

                logger.info('Internal tracing session saved', {
                    sessionId: session.sessionId,
                    agentName: session.agent?.name,
                    eventsCount: events.length,
                });
            } catch (err) {
                logger.error('Failed to save internal tracing session', { error: err });
            }
        },
    });
}

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
    },
): Promise<IAgent> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const key = generateAgentKey(data.name);

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
        config: data.config,
        status: data.status || 'active',
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
    return db.updateAgent(agentId, { ...data, updatedBy: userId });
}

export async function deleteAgentRecord(
    tenantDbName: string,
    agentId: string,
): Promise<boolean> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.deleteAgent(agentId);
}

export async function getAgentById(
    tenantDbName: string,
    agentId: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentById(agentId);
}

export async function getAgentByKey(
    tenantDbName: string,
    key: string,
    projectId?: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentByKey(key, projectId);
}

export async function listAgents(
    tenantDbName: string,
    filters?: { projectId?: string; status?: IAgent['status']; search?: string },
): Promise<IAgent[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgents(filters);
}

export async function countAgents(
    tenantDbName: string,
    projectId?: string,
): Promise<number> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.countAgents(projectId);
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
            status: agent.status,
        },
        changelog,
        publishedBy: userId,
    });

    // Update agent with latest published version
    await db.updateAgent(agentId, {
        publishedVersion: nextVersion,
        latestVersion: nextVersion,
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
 * Resolves the agent config to use for execution.
 * - If a specific version is requested, returns that version's config.
 * - For API/SDK calls (not playground), uses the published version.
 * - Falls back to current agent config if no version is published (backward compat).
 */
export async function resolveAgentConfig(
    tenantDbName: string,
    agentKey: string,
    projectId?: string,
    requestedVersion?: number,
): Promise<{
    agent: IAgent;
    config: IAgent['config'];
    resolvedVersion: number | null;
    agentName: string;
    agentDescription?: string;
}> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const agent = await db.findAgentByKey(agentKey, projectId);
    if (!agent) throw new Error(`Agent "${agentKey}" not found`);

    // If a specific version is requested
    if (requestedVersion !== undefined && requestedVersion !== null) {
        const version = await db.findAgentVersion(String(agent._id), requestedVersion);
        if (!version) {
            throw new Error(`Version ${requestedVersion} not found for agent "${agentKey}"`);
        }
        return {
            agent,
            config: version.snapshot.config,
            resolvedVersion: version.version,
            agentName: version.snapshot.name,
            agentDescription: version.snapshot.description,
        };
    }

    // Use published version if available
    if (agent.publishedVersion) {
        const version = await db.findAgentVersion(
            String(agent._id),
            agent.publishedVersion,
        );
        if (version) {
            return {
                agent,
                config: version.snapshot.config,
                resolvedVersion: version.version,
                agentName: version.snapshot.name,
                agentDescription: version.snapshot.description,
            };
        }
    }

    // Fallback to current config (never published or version data missing)
    return {
        agent,
        config: agent.config,
        resolvedVersion: null,
        agentName: agent.name,
        agentDescription: agent.description,
    };
}

// ── Conversation CRUD ────────────────────────────────────────────────

export async function createConversation(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    agentKey: string,
    title?: string,
): Promise<IAgentConversation> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    return db.createAgentConversation({
        tenantId,
        projectId,
        agentKey,
        title: title || 'New conversation',
        messages: [],
        createdBy: userId,
    });
}

export async function getConversationById(
    tenantDbName: string,
    conversationId: string,
): Promise<IAgentConversation | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentConversationById(conversationId);
}

export async function listConversations(
    tenantDbName: string,
    agentKey: string,
    filters?: { projectId?: string; limit?: number; skip?: number },
): Promise<IAgentConversation[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgentConversations(agentKey, filters);
}

export async function deleteConversation(
    tenantDbName: string,
    conversationId: string,
): Promise<boolean> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.deleteAgentConversation(conversationId);
}

// ── Agent Chat Execution ─────────────────────────────────────────────

export interface AgentChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    conversationId: string;
    userMessage: string;
    userId: string;
    /** Request a specific published version (API/SDK) */
    version?: number;
    /** When true, use the published version (default for API/SDK calls) */
    usePublished?: boolean;
}

/** Ephemeral (playground) chat — no DB conversation required */
export interface AgentPlaygroundChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    userMessage: string;
    /** Previous messages for context (in-memory only) */
    history?: Array<{ role: string; content: string }>;
}

/** OpenAI Responses API–compatible output content item */
export interface ResponseOutputText {
    type: 'output_text';
    text: string;
}

/** OpenAI Responses API–compatible output message */
export interface ResponseOutputMessage {
    id: string;
    type: 'message';
    role: 'assistant';
    content: ResponseOutputText[];
}

/** OpenAI Responses API–compatible usage */
export interface ResponseUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}

/** OpenAI Responses API–compatible response shape */
export interface AgentChatResponse {
    id: string;
    object: 'response';
    model: string;
    output: ResponseOutputMessage[];
    status: 'completed' | 'failed';
    usage: ResponseUsage;
    created_at: number;
    previous_response_id: string | null;
    /** Version used for this response (null if not versioned) */
    version: number | null;
    /** Conversation messages for dashboard playgrounds */
    _conversation_messages?: Array<{ role: string; content: string; timestamp: Date }>;
}

export async function executeAgentChat(
    request: AgentChatRequest,
): Promise<AgentChatResponse> {
    const {
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversationId,
        userMessage,
    } = request;

    // 1. Load agent config (use published version for API/SDK calls)
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    let resolvedVersion: number | null = null;
    let agent: IAgent;
    let config: IAgentConfig;

    if (request.usePublished || request.version !== undefined) {
        // Resolve from published version
        const resolved = await resolveAgentConfig(
            tenantDbName,
            agentKey,
            projectId,
            request.version,
        );
        agent = resolved.agent;
        config = resolved.config;
        resolvedVersion = resolved.resolvedVersion;
    } else {
        // Playground-style: use current draft config
        const foundAgent = await db.findAgentByKey(agentKey, projectId);
        if (!foundAgent) throw new Error(`Agent "${agentKey}" not found`);
        agent = foundAgent;
        config = foundAgent.config;
    }

    // 2. Load conversation
    const conversation = await db.findAgentConversationById(conversationId);
    if (!conversation) throw new Error(`Conversation "${conversationId}" not found`);

    // 3. Resolve model
    const model = await getModelByKey(tenantDbName, config.modelKey, projectId);
    if (!model) throw new Error(`Model "${config.modelKey}" not found`);
    if (model.category !== 'llm') throw new Error('Configured model is not compatible with chat');

    // 4. Build LangChain model runtime
    const { runtime } = await buildModelRuntime(
        tenantDbName,
        tenantId,
        model.providerKey,
        projectId,
    );

    if (!runtime.createChatModel) {
        throw new Error('Provider runtime does not support chat model creation');
    }

    const lcModel = runtime.createChatModel({
        modelId: model.modelId,
        category: model.category,
        modelSettings: {
            temperature: config.temperature ?? 0.7,
            top_p: config.topP,
            max_tokens: config.maxTokens,
        },
    });

    // 5. Resolve system prompt
    let systemPrompt = config.systemPrompt;
    if (!systemPrompt && config.promptKey) {
        const prompt = await db.findPromptByKey(config.promptKey, projectId);
        if (prompt) systemPrompt = prompt.template;
    }

    // 5a. Input guardrail check
    if (config.inputGuardrailKey) {
        const inputResult = await evaluateGuardrail({
            tenantDbName,
            tenantId,
            projectId,
            guardrailKey: config.inputGuardrailKey,
            text: userMessage,
        });
        if (!inputResult.passed && inputResult.action === 'block') {
            const reasons = inputResult.findings.map((f) => f.category || f.type).join(', ');
            throw new Error(`Input blocked by guardrail: ${reasons}`);
        }
    }

    // 5b. Build RAG retrieval tool if knowledge engine is configured
    const { createAgent, fromLangchainModel, createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');

    const tools: any[] = [];
    if (config.knowledgeEngineKey) {
        const ragModuleKey = config.knowledgeEngineKey;
        const ragTool = createTool({
            name: 'knowledge_search',
            description: 'PRIMARY retrieval tool. For factual, product, policy, API, docs, or troubleshooting questions, call this tool BEFORE drafting the final answer. Use the user question (or a focused rewrite) as query. If results are empty/insufficient, then answer briefly with uncertainty.',
            schema: z.object({ query: z.string().describe('The search query') }),
            func: async (args: { query: string }) => {
                // Use undefined projectId for tenant-wide lookup;
                // the user explicitly configured this RAG module on the agent.
                const result = await queryRag(tenantDbName, tenantId, undefined, {
                    ragModuleKey,
                    query: args.query,
                    topK: 5,
                });
                return result.matches
                    .map((m) => m.content)
                    .filter(Boolean)
                    .join('\n\n---\n\n');
            },
        });
        tools.push(ragTool);
    }

    if (config.knowledgeEngineKey) {
        const knowledgeSearchInstruction = [
            'Knowledge-base-first policy:',
            '- For user questions that are factual, documentation, API, setup, troubleshooting, or product-behavior related, call `knowledge_search` first.',
            '- Do not provide a final answer before at least one `knowledge_search` attempt unless the request is purely conversational.',
            '- After retrieval, answer using the retrieved content; if retrieval is empty, say you are not fully certain and provide the best concise answer.',
        ].join('\n');
        systemPrompt = systemPrompt
            ? `${knowledgeSearchInstruction}\n\n${systemPrompt}`
            : knowledgeSearchInstruction;
    }

    // 5c. Build bound tools from toolBindings (MCP, future sources)
    const boundTools = await buildBoundTools(tenantDbName, tenantId, projectId, config.toolBindings, createTool, z);
    tools.push(...boundTools);

    // 6. Build message history
    const now = new Date();
    type SdkMessage = { role: string; content: string };
    const existingMessages: SdkMessage[] = (conversation.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
    }));

    // 7. Create agent-sdk instance and invoke
    const sdkModel = fromLangchainModel(lcModel);
    const tracingSink = await createInternalTracingSink(tenantDbName, tenantId, projectId);

    const sdkAgent = createAgent({
        name: agent.name,
        model: sdkModel,
        ...(tools.length > 0 ? { tools } : {}),
        tracing: {
            enabled: true,
            mode: 'batched',
            sink: tracingSink,
            threadId: conversationId,
        },
    });

    const inputMessages: SdkMessage[] = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...existingMessages,
        { role: 'user', content: userMessage },
    ];

    const result = await sdkAgent.invoke({
        messages: inputMessages as any,
    });

    const assistantContent = (result as any).content || '';

    // 7b. Output guardrail check
    if (config.outputGuardrailKey && assistantContent) {
        const outputResult = await evaluateGuardrail({
            tenantDbName,
            tenantId,
            projectId,
            guardrailKey: config.outputGuardrailKey,
            text: assistantContent,
        });
        if (!outputResult.passed && outputResult.action === 'block') {
            const reasons = outputResult.findings.map((f) => f.category || f.type).join(', ');
            throw new Error(`Output blocked by guardrail: ${reasons}`);
        }
    }

    // 8. Update conversation with new messages
    const updatedMessages = [
        ...(conversation.messages || []),
        { role: 'user', content: userMessage, timestamp: now },
        { role: 'assistant', content: assistantContent, timestamp: new Date() },
    ];

    await db.updateAgentConversation(conversationId, {
        messages: updatedMessages,
        title: conversation.title === 'New conversation' && updatedMessages.length <= 2
            ? userMessage.substring(0, 80)
            : conversation.title,
    });

    logger.info('Agent chat completed', {
        agentKey,
        conversationId,
        messageCount: updatedMessages.length,
    });

    const responseId = `resp_${conversationId}`;
    const msgId = `msg_${Date.now().toString(36)}`;

    return {
        id: responseId,
        object: 'response' as const,
        model: agent.name,
        output: [
            {
                id: msgId,
                type: 'message' as const,
                role: 'assistant' as const,
                content: [
                    {
                        type: 'output_text' as const,
                        text: assistantContent,
                    },
                ],
            },
        ],
        status: 'completed' as const,
        usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
        },
        created_at: Math.floor(Date.now() / 1000),
        previous_response_id: (conversation.messages?.length ?? 0) > 0 ? responseId : null,
        version: resolvedVersion,
        _conversation_messages: updatedMessages,
    };
}

/**
 * Ephemeral playground chat — runs agent without DB conversation storage.
 * History is passed in-memory from the client. Tracing still fires.
 */
export async function executePlaygroundChat(
    request: AgentPlaygroundChatRequest,
): Promise<{ content: string }> {
    const { tenantDbName, tenantId, projectId, agentKey, userMessage, history } = request;

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const agent = await db.findAgentByKey(agentKey, projectId);
    if (!agent) throw new Error(`Agent "${agentKey}" not found`);

    const { config } = agent;

    // Resolve model
    const model = await getModelByKey(tenantDbName, config.modelKey, projectId);
    if (!model) throw new Error(`Model "${config.modelKey}" not found`);
    if (model.category !== 'llm') throw new Error('Configured model is not compatible with chat');

    const { runtime } = await buildModelRuntime(tenantDbName, tenantId, model.providerKey, projectId);
    if (!runtime.createChatModel) {
        throw new Error('Provider runtime does not support chat model creation');
    }

    const lcModel = runtime.createChatModel({
        modelId: model.modelId,
        category: model.category,
        modelSettings: {
            temperature: config.temperature ?? 0.7,
            top_p: config.topP,
            max_tokens: config.maxTokens,
        },
    });

    // Resolve system prompt
    let systemPrompt = config.systemPrompt;
    if (!systemPrompt && config.promptKey) {
        const prompt = await db.findPromptByKey(config.promptKey, projectId);
        if (prompt) systemPrompt = prompt.template;
    }

    // Input guardrail check
    if (config.inputGuardrailKey) {
        const inputResult = await evaluateGuardrail({
            tenantDbName,
            tenantId,
            projectId,
            guardrailKey: config.inputGuardrailKey,
            text: userMessage,
        });
        if (!inputResult.passed && inputResult.action === 'block') {
            const reasons = inputResult.findings.map((f) => f.category || f.type).join(', ');
            throw new Error(`Input blocked by guardrail: ${reasons}`);
        }
    }

    // Build RAG retrieval tool if knowledge engine is configured
    const { createAgent, fromLangchainModel, createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');

    const playgroundTools: any[] = [];
    if (config.knowledgeEngineKey) {
        const ragModuleKey = config.knowledgeEngineKey;
        const ragTool = createTool({
            name: 'knowledge_search',
            description: 'PRIMARY retrieval tool. For factual, product, policy, API, docs, or troubleshooting questions, call this tool BEFORE drafting the final answer. Use the user question (or a focused rewrite) as query. If results are empty/insufficient, then answer briefly with uncertainty.',
            schema: z.object({ query: z.string().describe('The search query') }),
            func: async (args: { query: string }) => {
                // Use undefined projectId for tenant-wide lookup;
                // the user explicitly configured this RAG module on the agent.
                const result = await queryRag(tenantDbName, tenantId, undefined, {
                    ragModuleKey,
                    query: args.query,
                    topK: 5,
                });
                return result.matches
                    .map((m) => m.content)
                    .filter(Boolean)
                    .join('\n\n---\n\n');
            },
        });
        playgroundTools.push(ragTool);
    }

    if (config.knowledgeEngineKey) {
        const knowledgeSearchInstruction = [
            'Knowledge-base-first policy:',
            '- For user questions that are factual, documentation, API, setup, troubleshooting, or product-behavior related, call `knowledge_search` first.',
            '- Do not provide a final answer before at least one `knowledge_search` attempt unless the request is purely conversational.',
            '- After retrieval, answer using the retrieved content; if retrieval is empty, say you are not fully certain and provide the best concise answer.',
        ].join('\n');
        systemPrompt = systemPrompt
            ? `${knowledgeSearchInstruction}\n\n${systemPrompt}`
            : knowledgeSearchInstruction;
    }

    // Build bound tools from toolBindings (MCP, future sources)
    const boundPlaygroundTools = await buildBoundTools(tenantDbName, tenantId, projectId, config.toolBindings, createTool, z);
    playgroundTools.push(...boundPlaygroundTools);

    // Build messages (in-memory history only)
    type SdkMessage = { role: string; content: string };
    const inputMessages: SdkMessage[] = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...(history || []),
        { role: 'user', content: userMessage },
    ];

    // Create agent-sdk instance and invoke (tracing enabled)
    const sdkModel = fromLangchainModel(lcModel);
    const tracingSink = await createInternalTracingSink(tenantDbName, tenantId, projectId);

    const sdkAgent = createAgent({
        name: agent.name,
        model: sdkModel,
        ...(playgroundTools.length > 0 ? { tools: playgroundTools } : {}),
        tracing: {
            enabled: true,
            mode: 'batched',
            sink: tracingSink,
        },
    });

    const result = await sdkAgent.invoke({ messages: inputMessages as any });
    const assistantContent = (result as any).content || '';

    // Output guardrail check
    if (config.outputGuardrailKey && assistantContent) {
        const outputResult = await evaluateGuardrail({
            tenantDbName,
            tenantId,
            projectId,
            guardrailKey: config.outputGuardrailKey,
            text: assistantContent,
        });
        if (!outputResult.passed && outputResult.action === 'block') {
            const reasons = outputResult.findings.map((f) => f.category || f.type).join(', ');
            throw new Error(`Output blocked by guardrail: ${reasons}`);
        }
    }

    logger.info('Playground chat completed', { agentKey });

    return { content: assistantContent };
}
