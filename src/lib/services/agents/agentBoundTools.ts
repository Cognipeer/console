/**
 * The Tool Bridge of an agent run: tool bindings (unified tools, MCP servers, system tools)
 * turned into agent-sdk tools, and the cleanup of what they open.
 */

import { type AgentToolGuard, agentToolPolicyName, protectBuiltTool } from './agentToolGuard';
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
import { resolveMcpGuardrailBinding, getToolAnnotationOverrides, resolveSourceType } from '@/lib/services/mcp/mcpService';
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
 * ── WHERE `tool.pre` / `tool.post` FIRE, AND WHERE THEY MUST NOT ───────────
 * `guard` wraps the 'tool' and 'system' branches. It deliberately does NOT
 * wrap the 'mcp' branch: `executeMcpTool` routes to `executeMcpToolLocal`,
 * which fires both hooks itself around the dispatch
 * (`mcpService.ts` — `guardrail.beforeToolCall` / `guardrail.afterToolCall`,
 * bound to the SERVER's own guardrail via `resolveMcpGuardrailBinding`).
 * Wrapping here as well would evaluate every MCP call twice, write two
 * evaluation-log rows per hook, and bill the model-backed families twice — and
 * the second evaluation would carry a DIFFERENT tool name, since the MCP layer
 * names the call `<serverKey>/<toolName>` after resolving any rename override.
 * One call, one name, one evaluation.
 *
 * THE EXCEPTION is a server with NO binding at all (`resolveMcpGuardrailBinding`
 * answers `mode: 'off'`, the default for a server nobody configured): the MCP
 * layer then evaluates nothing, so the agent's own `tool.pre`/`tool.post`
 * bindings would be bypassed by the simple act of attaching such a server. For
 * that case — and only that case — the 'mcp' branch wraps the tool with `guard`
 * under the SAME canonical name the MCP layer would have used, so it is still
 * one call, one name, one evaluation. Which layer evaluates is decided per
 * server, never both.
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

            // WHO GUARDS THIS SERVER'S TOOLS. A server with its own binding is
            // guarded one layer down by `executeMcpToolLocal` (see the note on
            // this function), and wrapping it here too would double-evaluate.
            // A server with NO binding (`mode: 'off'` — the default for a server
            // an operator never configured) evaluates NOTHING down there, so the
            // agent's own `tool.pre`/`tool.post` bindings would be walked around
            // simply by attaching an MCP server: the model calls
            // `<server>/delete_records`, no hook fires, the allow-list is
            // bypassed and the log shows nothing. For that case the agent's
            // guard wraps the tool under the MCP CANONICAL spelling
            // `<serverKey>/<toolName>` — the name `mcpHook` would have used —
            // so a stored `tool_access` policy matches it the same way on
            // either layer. `guard` is the no-op when the agent binds nothing.
            const mcpBinding = resolveMcpGuardrailBinding(server);
            const guardAtAgent = mcpBinding.mode === 'off';
            const annotationOverrides = getToolAnnotationOverrides(server);
            const sourceAnnotations = defaultAnnotationsForSource(resolveSourceType(server));

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
                    const { result, logSummary } = await executeMcpTool(server, toolName, args, mcpRuntimeHeaders, mcpIdentity);
                    // A knowledge base tool that ran on another node marked only its own work: mark the run's here.
                    await noteRestrictedKnowledge(restrictedKnowledgeTagsOf(logSummary?.restrictedKnowledge));
                    if (isToolOutput(result)) return result;
                    return typeof result === 'string' ? result : JSON.stringify(result);
                };
                const description = mcpToolDef.description || `Call ${mcpToolDef.name} on ${server.name}`;
                const tool = createToolFn({
                    name: mcpToolDef.name,
                    description,
                    schema: toolInputSchemaToZod(mcpToolDef.inputSchema),
                    // Wrapped in `guard` ONLY when the server has no binding of
                    // its own; otherwise `executeMcpTool` -> `executeMcpToolLocal`
                    // already fires `tool.pre` and `tool.post` around the dispatch
                    // and a second wrap would double-evaluate. See `guardAtAgent`.
                    func: guardAtAgent
                        ? guard.protect(
                            { name: `${server.key}/${toolName}`, requestedName: mcpToolDef.name },
                            dispatch,
                        )
                        : dispatch,
                });
                const markings = mcpToolMarkings(
                    mcpToolDef,
                    Object.hasOwn(annotationOverrides, toolName) ? annotationOverrides[toolName] : undefined,
                    sourceAnnotations,
                );
                tools.push(Object.assign(tool, { hitlKind: classifyTool(mcpToolDef.name, markings) }));
                definitions.push({ name: mcpToolDef.name, description, parameters: mcpToolDef.inputSchema });
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
