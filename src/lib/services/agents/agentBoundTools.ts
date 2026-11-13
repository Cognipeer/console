/**
 * The Tool Bridge of an agent run: tool bindings (unified tools, MCP servers, system tools)
 * turned into agent-sdk tools, and the cleanup of what they open.
 */

import { type AgentToolGuard, type AgentToolLogView, agentToolPolicyName, protectBuiltTool } from './agentToolGuard';
import { type AgentRuntimeContext, resolveRuntimeHeaders, runtimeHeaderPolicyFromMetadata, describeRuntimeAuth } from '@/lib/services/runtimeContext';
import { type ConsoleIdentityCaller, consoleIdentityCallerOf } from '@/lib/iam/consoleIdentity';
import type { ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { resolveAgentBindingTool, resolveAgentBindingMcpServer } from './bindingResolution';
import { toolRequestSecretValues, logToolRequest, executeToolAction, addSecretValues } from '@/lib/services/tools';
import { toolInputSchemaToZod } from './agentRuntimeConfig';
import { isToolOutput } from '@/lib/services/tools/toolOutput';
import { classifyTool } from './agentHumanInTheLoop';
import { effectiveActionAnnotations, mcpToolMarkings } from '@/lib/services/tools/actionAnnotations';
import { mayUseSharedResource } from './sharedResourceAccess';
import {
    getToolAnnotationOverrides,
    logMcpRequest,
    mcpRequestSecretValues,
    mcpServerGuardrailKey,
    resolveSourceType,
} from '@/lib/services/mcp/mcpService';
import { isMcpPiiProtected, openMcpPiiRoundTrip, piiLogOf } from '@/lib/services/mcp/mcpPii';
import type { IMcpServer, McpSourceType } from '@/lib/database';
import { exposedMcpToolNames } from './boundToolNames';
import { defaultAnnotationsForSource } from '@/lib/services/mcp/toolAnnotations';
import { isMcpToolEnabled, executeMcpTool } from '@/lib/services/mcp';
import { noteRestrictedKnowledge, restrictedKnowledgeTagsOf } from '@/lib/services/rag/access';
import { resolveBrowser, createBrowserSession, buildBrowserAgentTools, closeBrowserSession } from '@/lib/services/browser';
import { buildWebSearchAgentTools } from '@/lib/services/webSearch';
import { buildWebFetchAgentTools } from '@/lib/services/crawler';
import { getChannelToolsHost, isChannelToolName } from '@/enterprise/channel-tools';
import { getFlowsHost } from '@/enterprise/flows';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

/**
 * What the agent's guard logs for a tool of an MCP server with PII protection:
 * the arguments tokenized with the server's round trip (the same tokens the
 * upstream gets), and the result as the upstream returned it, which
 * `executeMcpTool` leaves on the call's arguments, in the form the model gets.
 */
function mcpPiiGuardLogView(server: IMcpServer, sourceType: McpSourceType, toolName: string) {
    return {
        open: async (args: Record<string, unknown>): Promise<AgentToolLogView> => {
            const roundTrip = await openMcpPiiRoundTrip(server, sourceType, toolName);
            // No round trip (the policy is turned off): the values go to the upstream as they are.
            if (!roundTrip) return { args, mask: async (text) => text };
            return { args: await roundTrip.protect(args), mask: (text) => roundTrip.protectText(text) };
        },
        result: (args: Record<string, unknown>) => {
            const logged = piiLogOf(args);
            if (!logged) return undefined;
            const value = logged.result;
            return isToolOutput(value) || typeof value === 'string' ? value : JSON.stringify(value);
        },
    };
}

// ── Tool Bridge ─────────────────────────────────────────────────────

/**
 * Converts IAgentToolBinding entries into agent-sdk ToolInterface instances.
 * Supports two source types:
 *   - 'tool'  – unified tool system (OpenAPI / MCP sources)
 *   - 'mcp'   – legacy direct MCP server bindings (backward compat)
 *
 * Also returns trace `definitions` for the bound tools — the menu recorded on
 * each model-call event's `tool_definitions` section. `parameters` carries the
 * source JSON schema (action/MCP inputSchema), and the SDK binding is built
 * from that same schema (`toolInputSchemaToZod`), so the trace and the model
 * see one contract.
 *
 * ── WHERE `tool.pre` / `tool.post` FIRE ────────────────────────────────────
 * `guard` wraps every branch, the 'mcp' one included. An MCP tool has two
 * layers: the agent's guardrails (`guard`, outside) and the server's own
 * guardrail (`executeMcpToolLocal`, inside, via `resolveMcpGuardrailBinding`).
 * Both run, in order: `tool.pre` agent then server, `tool.post` server then
 * agent. The agent layer names the call as the MCP layer does,
 * `<serverKey>/<toolName>`, so one policy matches on either layer, and it skips
 * the guardrail the server itself evaluates (`mcpServerGuardrailKey`), so a
 * guardrail bound on both layers runs once per call. For a server with PII
 * protection the agent layer's evaluation log keeps the tokenized values, as
 * the server's does.
 *
 * EXPORTED FOR TESTS — see `createAgentToolGuard`.
 */
export async function buildBoundTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bindings: { source: string; sourceKey: string; toolNames: string[]; config?: Record<string, unknown> }[] | undefined,
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool,
    zod: typeof import('zod').z,
    guard: AgentToolGuard,
    runtimeContext?: AgentRuntimeContext,
    /** Who the run is for, as MCP servers set up for Console identity are told (default: from `runtimeContext`). */
    identity?: ConsoleIdentityCaller,
    /** What a Flow tool (`source: 'flow'`) copies onto its run: the Session it belongs to, and whether anyone is there to answer. */
    flowCaller?: { conversationId?: string; unattended?: boolean; accountableUserId?: string },
    /** The agent the bindings belong to: its own MCP servers resolve, another agent's do not (`IAgentResourceOwner`). */
    agentId?: string,
): Promise<{
    cleanupTasks: Array<() => Promise<void>>;
    tools: AgentSdkToolInterface[];
    definitions: TraceToolDefinition[];
}> {
    if (!bindings || bindings.length === 0) return { cleanupTasks: [], tools: [], definitions: [] };
    const mcpIdentity = identity ?? consoleIdentityCallerOf(runtimeContext, { projectId });

    const tools: AgentSdkToolInterface[] = [];
    const definitions: TraceToolDefinition[] = [];
    const cleanupTasks: Array<() => Promise<void>> = [];
    // MCP tools are built once every bound tool is known: a name two of them
    // share (or that another tool uses) is exposed with its server's key.
    const pendingMcpTools: Array<{
        serverKey: string;
        name: string;
        build: (exposedName: string) => { tool: AgentSdkToolInterface; definition: TraceToolDefinition };
    }> = [];

    for (const binding of bindings) {
        if (binding.source === 'tool') {
            // ── Unified tool system ──────────────────────────────
            const toolRecord = await resolveAgentBindingTool(tenantDbName, binding.sourceKey, projectId);
            if (!toolRecord || toolRecord.status !== 'active') {
                logger.warn('Skipping inactive/missing tool', { key: binding.sourceKey });
                continue;
            }

            const toolRuntimeHeaders = resolveRuntimeHeaders(
                runtimeContext,
                'tool',
                toolRecord.key,
                runtimeHeaderPolicyFromMetadata(toolRecord.metadata),
            );
            const toolRuntimeAuth = describeRuntimeAuth(runtimeContext, toolRuntimeHeaders);
            const toolSecretValues = toolRequestSecretValues(toolRecord, toolRuntimeHeaders);

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

                const description = action.description || `Call ${action.name} on ${toolRecord.name}`;
                const log = (
                    status: 'success' | 'error',
                    latencyMs: number,
                    args: Record<string, unknown>,
                    response?: Record<string, unknown>,
                    error?: string,
                ) => logToolRequest(
                    tenantDbName, tenantId, toolRecord.projectId,
                    toolRecord.key, action.key, action.name,
                    status, latencyMs, args, response, error,
                    'agent', runtimeContext?.tokenId, toolRuntimeAuth, toolSecretValues,
                );
                const tool = createToolFn({
                    name: action.name,
                    description,
                    // The action's real input schema, not an empty passthrough —
                    // see toolInputSchemaToZod.
                    schema: toolInputSchemaToZod(action.inputSchema),
                    // The guard wraps the WHOLE executor, tool-request logging
                    // included, so a `tool.pre` redaction reaches the upstream
                    // call and the request log identically, and `tool.post`
                    // sees the exact string that will reach the model rather
                    // than the object graph behind it.
                    //
                    // A blocked call therefore writes NO tool-request log. That
                    // is deliberate: the log's status vocabulary is
                    // success | error, and recording a policy decision as an
                    // 'error' would corrupt this tool's failure rate. The
                    // guardrail evaluation log is where a block is recorded.
                    func: guard.protect(
                        {
                            name: agentToolPolicyName('tool', toolRecord.key, action.key),
                            requestedName: action.name,
                        },
                        async (args: Record<string, unknown>) => {
                            try {
                                const { result, latencyMs, isError } = await executeToolAction(
                                    toolRecord, action.key, args, toolRuntimeHeaders,
                                    { onSecrets: (values) => addSecretValues(toolSecretValues, values) },
                                );
                                // An MCP `isError` result is a failed call: logged as one, the text still reaches the model.
                                log(
                                    isError ? 'error' : 'success', latencyMs, args,
                                    typeof result === 'object' ? (result as Record<string, unknown>) : { value: result },
                                    isError ? (typeof result === 'string' ? result : 'Tool reported an error') : undefined,
                                );
                                // A result with media stays an object: `withToolMedia` shows its images to the model.
                                if (isToolOutput(result)) return result;
                                return typeof result === 'string' ? result : JSON.stringify(result);
                            } catch (execError) {
                                const errorMessage = execError instanceof Error ? execError.message : 'Failed to execute tool action';
                                log('error', 0, args, undefined, errorMessage);
                                throw execError;
                            }
                        },
                    ),
                });
                // Whether the call asks for approval is decided from the action's markings (`classifyTool`).
                tools.push(Object.assign(tool, { hitlKind: classifyTool(action.name, effectiveActionAnnotations(action)) }));
                definitions.push({ name: action.name, description, parameters: action.inputSchema });
            }
        } else if (binding.source === 'mcp') {
            // ── Legacy MCP server bindings ───────────────────────
            const server = await resolveAgentBindingMcpServer(tenantDbName, binding.sourceKey, projectId, agentId);
            if (!server || server.status !== 'active') {
                logger.warn('Skipping inactive/missing MCP server', { key: binding.sourceKey });
                continue;
            }
            // The server's access list decides for the person this run is made for (managed:access:*); a server they
            // may not use is left out, so the model never sees its tools.
            const mayUse = await mayUseSharedResource(
                { tenantDbName, tenantId, caller: mcpIdentity, source: runtimeContext?.source },
                { type: 'mcp-server', id: String(server._id ?? ''), key: server.key, projectId: server.projectId, access: server.access },
            );
            if (!mayUse) {
                logger.info('MCP server is not open to the person this run is made for; its tools are left out', { key: binding.sourceKey });
                continue;
            }

            const mcpRuntimeHeaders = resolveRuntimeHeaders(
                runtimeContext,
                'mcp',
                server.key,
                runtimeHeaderPolicyFromMetadata(server.metadata),
            );

            // WHO GUARDS THIS SERVER'S TOOLS: the agent's guardrails here, and
            // the server's own one layer down (see the note on this function).
            // The agent layer skips the guardrail the server evaluates. Only when
            // both resolve keys in the same project: a key names a guardrail per
            // project, so in another project the same key may be another record.
            const serverGuardrailKey = (server.projectId ?? undefined) === (projectId || undefined)
                ? mcpServerGuardrailKey(server)
                : undefined;
            const skipGuardrailKeys = serverGuardrailKey ? [serverGuardrailKey] : [];
            const serverSourceType = resolveSourceType(server);
            const annotationOverrides = getToolAnnotationOverrides(server);
            const sourceAnnotations = defaultAnnotationsForSource(serverSourceType);

            for (const toolName of binding.toolNames) {
                const mcpToolDef = server.tools.find((t) => t.name === toolName);
                if (!mcpToolDef) {
                    logger.warn('MCP tool not found, skipping', {
                        server: binding.sourceKey,
                        tool: toolName,
                    });
                    continue;
                }
                if (!isMcpToolEnabled(server, toolName)) {
                    logger.warn('MCP tool disabled on server, skipping', {
                        server: binding.sourceKey,
                        tool: toolName,
                    });
                    continue;
                }

                const dispatch = async (args: Record<string, unknown>) => {
                    const startedAt = Date.now();
                    try {
                        const outcome = await executeMcpTool(server, toolName, args, mcpRuntimeHeaders, mcpIdentity);
                        const { result, logSummary } = outcome;
                        logAgentMcpCall({ status: 'success', args, result, latencyMs: outcome.latencyMs });
                        // A knowledge base tool that ran on another node marked only its own work: mark the run's here.
                        await noteRestrictedKnowledge(restrictedKnowledgeTagsOf(logSummary?.restrictedKnowledge));
                        if (isToolOutput(result)) return result;
                        return typeof result === 'string' ? result : JSON.stringify(result);
                    } catch (error) {
                        logAgentMcpCall({ status: 'error', args, error, latencyMs: Date.now() - startedAt });
                        throw error;
                    }
                };
                // The server's request log has the agent's calls too, next to the API and dashboard ones. Usage is
                // not counted again here: the run accounts for it.
                const logAgentMcpCall = (call: {
                    status: 'success' | 'error';
                    args: Record<string, unknown>;
                    result?: unknown;
                    error?: unknown;
                    latencyMs: number;
                }) => {
                    // Logging never fails the call it records.
                    try {
                        void logMcpRequest(tenantDbName, {
                            tenantId,
                            projectId: server.projectId ?? projectId,
                            serverId: server._id !== undefined && server._id !== null ? String(server._id) : undefined,
                            serverKey: server.key,
                            toolName,
                            status: call.status,
                            latencyMs: call.latencyMs,
                            requestPayload: {
                                tool: toolName,
                                arguments: call.args,
                                _agent: {
                                    ...(agentId ? { agentId } : {}),
                                    ...(flowCaller?.conversationId ? { conversationId: flowCaller.conversationId } : {}),
                                },
                            },
                            ...(call.status === 'success'
                                ? {
                                    responsePayload: typeof call.result === 'object' && call.result !== null
                                        ? call.result as Record<string, unknown>
                                        : { value: call.result },
                                }
                                : { errorMessage: call.error instanceof Error ? call.error.message : 'Tool execution failed' }),
                            callerType: 'agent',
                            callerUserId: mcpIdentity?.userId,
                            callerTokenId: mcpIdentity?.tokenId,
                            transport: 'internal',
                            sourceType: resolveSourceType(server),
                        }, mcpRequestSecretValues(server, mcpRuntimeHeaders), { skipUsageEvent: true })
                            .catch(() => undefined);
                    } catch {
                        // Nothing to do: the call already has its outcome.
                    }
                };
                const description = mcpToolDef.description || `Call ${mcpToolDef.name} on ${server.name}`;
                const markings = mcpToolMarkings(
                    mcpToolDef,
                    Object.hasOwn(annotationOverrides, toolName) ? annotationOverrides[toolName] : undefined,
                    sourceAnnotations,
                );
                pendingMcpTools.push({
                    serverKey: server.key,
                    name: mcpToolDef.name,
                    build: (exposedName) => {
                        const renamed = exposedName !== mcpToolDef.name;
                        // A renamed tool says whose it is, so the model can tell same-named tools apart.
                        const exposedDescription = renamed ? `[${server.name}] ${description}` : description;
                        const tool = createToolFn({
                            name: exposedName,
                            description: exposedDescription,
                            schema: toolInputSchemaToZod(mcpToolDef.inputSchema),
                            // The agent's guardrails around the call; the server's own
                            // run inside `executeMcpTool`. See `skipGuardrailKeys`.
                            func: guard.protect(
                                {
                                    name: `${server.key}/${toolName}`,
                                    requestedName: exposedName,
                                    skipGuardrailKeys,
                                    ...(isMcpPiiProtected(server, serverSourceType, toolName)
                                        ? { logView: mcpPiiGuardLogView(server, serverSourceType, toolName) }
                                        : {}),
                                },
                                dispatch,
                            ),
                        });
                        return {
                            tool: Object.assign(tool, {
                                hitlKind: classifyTool(mcpToolDef.name, markings),
                                // Approval settings are saved under the tool's own name; a renamed tool keeps them.
                                ...(renamed ? { hitlPolicyName: mcpToolDef.name } : {}),
                            }),
                            definition: { name: exposedName, description: exposedDescription, parameters: mcpToolDef.inputSchema },
                        };
                    },
                });
            }
        } else if (binding.source === 'system' && binding.sourceKey === 'browser_use') {
            // ── System tool: Browser Use ───────────────────────
            const browserId = typeof binding.config?.browserId === 'string'
                ? (binding.config.browserId as string)
                : undefined;
            if (!browserId) {
                logger.warn('browser_use binding missing browserId, skipping');
                continue;
            }
            try {
                const browser = await resolveBrowser(
                    { tenantDbName, tenantId, projectId },
                    browserId,
                );
                if (!browser || browser.status !== 'active') {
                    logger.warn('browser_use binding refers to inactive/missing browser', { browserId });
                    continue;
                }
                const session = await createBrowserSession(
                    { tenantDbName, tenantId, projectId },
                    {
                        browserId: String(browser._id ?? ''),
                        createdBy: 'agent-runtime',
                        metadata: { source: 'agent-system-tool', binding: 'browser_use' },
                    },
                );
                const browserTools = adoptBuiltTools(guard, 'browser', buildBrowserAgentTools({
                    tenantDbName,
                    tenantId,
                    projectId,
                    sessionKey: session.sessionKey,
                    createdBy: 'agent-runtime',
                }));
                tools.push(...browserTools.tools);
                definitions.push(...browserTools.definitions);
                cleanupTasks.push(async () => {
                    await closeBrowserSession(
                        { tenantDbName, tenantId, projectId },
                        session.sessionKey,
                    ).catch(() => undefined);
                });
            } catch (err) {
                logger.error('Failed to bind browser_use system tool', {
                    browserId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        } else if (binding.source === 'system' && binding.sourceKey === 'web_search') {
            // ── System tool: Web Search ─────────────────────────
            // No session to open ahead of time — `runWebSearch` resolves the
            // instance (pinned or the project's single active one) per call.
            const providerKey = typeof binding.config?.providerKey === 'string'
                ? (binding.config.providerKey as string)
                : undefined;
            const webSearchTools = adoptBuiltTools(guard, 'websearch', buildWebSearchAgentTools({
                tenantDbName,
                tenantId,
                projectId,
                providerKey,
            }));
            tools.push(...webSearchTools.tools);
            definitions.push(...webSearchTools.definitions);
        } else if (binding.source === 'system' && binding.sourceKey === 'crawler') {
            // ── System tool: Web Fetch (single page through a crawler) ──
            // Stateless like web_search; the crawler is loaded per call so an
            // edit or deactivation takes effect without rebinding.
            const crawlerKey = typeof binding.config?.crawlerKey === 'string'
                ? (binding.config.crawlerKey as string)
                : undefined;
            if (!crawlerKey) {
                logger.warn('crawler binding missing crawlerKey, skipping');
                continue;
            }
            const webFetchTools = adoptBuiltTools(guard, 'crawler', buildWebFetchAgentTools({
                tenantDbName,
                tenantId,
                projectId,
                crawlerKey,
            }));
            tools.push(...webFetchTools.tools);
            definitions.push(...webFetchTools.definitions);
        } else if (binding.source === 'system' && binding.sourceKey === 'channel') {
            // ── System tool: Channels (write to Slack / Teams as the agent's own bot) ──
            // The Channels module builds them for the agent's deployments that allow it, and decides
            // who and where they may write to; an edition without it binds nothing.
            const channelHost = getChannelToolsHost();
            if (!channelHost) {
                logger.warn('channel tool binding skipped: Channels are not part of this edition');
                continue;
            }
            const toolNames = binding.toolNames.filter(isChannelToolName);
            if (toolNames.length === 0) continue;
            try {
                const built = await channelHost.buildTools({
                    tenantDbName,
                    tenantId,
                    projectId,
                    ...(mcpIdentity.agentKey ? { agentKey: mcpIdentity.agentKey } : {}),
                    toolNames,
                    ...((flowCaller?.accountableUserId ?? mcpIdentity.userId) ? { userId: flowCaller?.accountableUserId ?? mcpIdentity.userId } : {}),
                    ...(flowCaller?.conversationId ? { conversationId: flowCaller.conversationId } : {}),
                    ...(runtimeContext ? { runtimeContext } : {}),
                    createToolFn: createToolFn as unknown as Parameters<typeof channelHost.buildTools>[0]['createToolFn'],
                    zod,
                });
                const channelTools = adoptBuiltTools(guard, 'channel', built);
                tools.push(...channelTools.tools);
                definitions.push(...channelTools.definitions);
            } catch (err) {
                logger.error('Failed to bind channel system tools', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        } else if (binding.source === 'flow') {
            // ── Flow as a tool ──────────────────────────────────
            // The tool name is what the HITL policy is keyed by, and the call is guarded under
            // `agent.flow.<flowKey>` like any other tool. A binding whose flow is gone is skipped.
            const flowsHost = getFlowsHost();
            if (!flowsHost) {
                logger.warn('flow tool binding skipped: Flows are not part of this edition', { flow: binding.sourceKey });
                continue;
            }
            const flowTools = await flowsHost.buildToolBindings({
                tenantDbName,
                tenantId,
                projectId,
                binding: { sourceKey: binding.sourceKey, toolNames: binding.toolNames, config: binding.config },
                buildTool: (definition) => createToolFn(definition as Parameters<typeof createToolFn>[0]),
                guard,
                caller: {
                    ...(mcpIdentity.agentKey ? { agentKey: mcpIdentity.agentKey } : {}),
                    ...(mcpIdentity.userId ? { userId: mcpIdentity.userId } : {}),
                    ...(mcpIdentity.tokenId ? { tokenId: mcpIdentity.tokenId } : {}),
                    ...(flowCaller?.accountableUserId ? { accountableUserId: flowCaller.accountableUserId } : {}),
                    ...(flowCaller?.conversationId ? { conversationId: flowCaller.conversationId, sessionId: flowCaller.conversationId } : {}),
                    ...(flowCaller?.unattended !== undefined ? { unattended: flowCaller.unattended } : {}),
                },
            });
            tools.push(...(flowTools.tools as AgentSdkToolInterface[]));
            definitions.push(...(flowTools.definitions as TraceToolDefinition[]));
        }
    }

    if (pendingMcpTools.length) {
        const exposed = exposedMcpToolNames(
            pendingMcpTools.map(({ serverKey, name }) => ({ serverKey, name })),
            tools.map((tool) => tool.name),
        );
        pendingMcpTools.forEach((pending, index) => {
            const { tool, definition } = pending.build(exposed[index]);
            tools.push(tool);
            definitions.push(definition);
        });
    }

    return { cleanupTasks, tools, definitions };
}

/**
 * Guards system tools built elsewhere (browser, web search, web fetch, channels) after the fact,
 * under `agent.<surface>.<toolName>`. The browser tools are the agent's only
 * tools that navigate and type into a live browser, i.e. the surface
 * `tool_access.sideEffects` most wants to name.
 *
 * These tools carry zod schemas only, so their trace entries record name +
 * description and no parameters.
 */
function adoptBuiltTools(
    guard: AgentToolGuard,
    surface: 'browser' | 'websearch' | 'crawler' | 'channel',
    built: readonly unknown[],
): { tools: AgentSdkToolInterface[]; definitions: TraceToolDefinition[] } {
    const tools = (built as AgentSdkToolInterface[]).map((tool) => protectBuiltTool(
        guard,
        { name: agentToolPolicyName(surface, tool.name), requestedName: tool.name },
        tool,
    ));
    const definitions = tools.map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description ? { description: tool.description } : {}),
    }));
    return { tools, definitions };
}

export async function runBoundToolCleanup(
    cleanupTasks: Array<() => Promise<void>>,
    context: { agentKey: string; mode: 'chat' | 'playground' },
): Promise<void> {
    if (cleanupTasks.length === 0) return;

    const results = await Promise.allSettled(cleanupTasks.map((task) => task()));
    const failures = results.filter((result) => result.status === 'rejected').length;
    if (failures > 0) {
        logger.warn('Bound tool cleanup completed with failures', {
            agentKey: context.agentKey,
            failures,
            mode: context.mode,
        });
    }
}
