/**
 * Assistants API dialect (OpenAI's legacy Assistants surface), wired onto the
 * SAME agent engine `client-agents.ts` and `/client/v1/responses` already run.
 *
 * This is a WIRE ADAPTER, not a second engine: an Assistant IS an `IAgent`, a
 * Thread IS an `IAgentConversation`, and a Run is one `executeAgentChat` call.
 * Nothing here talks to a model, a tool or a guardrail directly — it only
 * translates the Assistants nouns onto the calls `client-agents.ts` already
 * makes, so every enforcement path (guardrails, quota, tracing) is exercised
 * exactly once, in the same place, regardless of which dialect a caller used.
 *
 * Three deliberate departures from OpenAI's own semantics, forced by how the
 * underlying engine actually runs:
 *
 * 1. A THREAD IS BOUND TO ONE ASSISTANT FOR ITS LIFETIME, set at creation.
 *    OpenAI's threads are assistant-agnostic; a run supplies the assistant.
 *    Our `IAgentConversation.agentKey` is required and, by the database
 *    contract's own typing (`updateAgentConversation` omits it from its
 *    patchable fields), immutable — so this was already true of the storage
 *    this dialect sits on, not a new restriction invented for it.
 *
 * 2. EVERY RUN COMPLETES SYNCHRONOUSLY. `executeAgentChat` runs the whole tool
 *    loop itself (RAG, MCP, system tools) and returns final text; nothing
 *    pauses mid-run for the caller to act, so there is no `queued` /
 *    `in_progress` state and no `requires_action` /
 *    `submit_tool_outputs`. A run is created already `completed` or `failed`.
 *    `POST .../runs/:runId/cancel` therefore always 400s — there is nothing
 *    in flight to cancel by the time a caller could reach it.
 *
 * 3. CLIENT-EXECUTED FUNCTION TOOLS ARE NOT SUPPORTED, for the same reason:
 *    a `function` tool's contract is "the run pauses, the caller executes the
 *    tool locally, the caller submits the result" — which needs the async
 *    state machine departure (2) rules out. `code_interpreter` has no backing
 *    runtime wired to this path yet. `file_search` maps to the agent's own
 *    Knowledge Engine module; Console's own tool/MCP/system catalog is
 *    reachable through the `console_tool` extension below.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type {
  IAgent,
  IAgentConfig,
  IAgentConversation,
  IAgentToolBinding,
} from '@/lib/database';
import {
  createAgentRecord,
  createConversation,
  executeAgentChat,
  getAgentByKey,
  getConversationById,
  listAgents,
  updateAgentRecord,
} from '@/lib/services/agents';
import { AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import { resolveConfigGuardrailBindings } from './guardrail-bindings';

const logger = createLogger('api:client-assistants');

// ── id scheme ──────────────────────────────────────────────────────────────
// One prefix per resource, matching the `resp_`/`modr_` convention the other
// dialects already use, so a caller can tell what an id names on sight.

export const assistantId = (agentKey: string) => `asst_${agentKey}`;
export const agentKeyFromAssistantId = (id: string) => (id.startsWith('asst_') ? id.slice(5) : id);
export const threadId = (conversationId: string) => `thread_${conversationId}`;
export const conversationIdFromThreadId = (id: string) => (id.startsWith('thread_') ? id.slice(7) : id);
export const messageId = (conversationId: string, index: number) => `msg_${conversationId}_${index}`;
const runId = () => `run_${randomUUID()}`;

// ── shared shapes ────────────────────────────────────────────────────────

interface PendingMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

interface RunRecord {
  id: string;
  status: 'completed' | 'failed';
  created_at: number;
  completed_at?: number;
  failed_at?: number;
  assistant_id: string;
  last_error?: { code: string; message: string };
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface AssistantsMetadata {
  pendingMessages?: PendingMessage[];
  runs?: RunRecord[];
}

function readAssistantsMetadata(conversation: IAgentConversation): AssistantsMetadata {
  const raw = (conversation.metadata as Record<string, unknown> | undefined)?.assistantsApi;
  return raw && typeof raw === 'object' ? (raw as AssistantsMetadata) : {};
}

/** Full-column-replace persistence (both DB backends), so the write always
 * carries the caller's OTHER metadata keys forward untouched. */
async function writeAssistantsMetadata(
  conversationId: string,
  conversation: IAgentConversation,
  patch: AssistantsMetadata,
): Promise<void> {
  const db = await getDatabase();
  const metadata = { ...(conversation.metadata ?? {}) };
  metadata.assistantsApi = { ...readAssistantsMetadata(conversation), ...patch };
  await db.updateAgentConversation(conversationId, { metadata });
}

/**
 * Every message a thread has, in creation order: persisted turns first (each
 * one INDEX-STABLE forever, since the persisted array only ever grows by
 * appending), then whatever is still pending a run. A promoted pending message
 * lands at the SAME merged index it held while pending — the run appends
 * exactly the (user, assistant) pair the one pending message becomes — so an
 * id handed out before a run stays valid after it.
 */
/**
 * `IAgentConversation.messages[].timestamp` is typed `Date`, but the SQLite
 * backend's `mapConversation` reads it back with a plain `JSON.parse`
 * (`agent.mixin.ts`'s `parseJson`) — no reviver — so a persisted message's
 * timestamp actually arrives here as an ISO STRING at runtime, not a `Date`
 * instance. A raw `.getTime()` on it throws; this coerces either shape.
 */
export function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

export function mergedMessages(
  conversation: IAgentConversation,
): Array<{ role: string; content: string; timestamp: Date; pending: boolean }> {
  const persisted = (conversation.messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: toDate(m.timestamp),
    pending: false,
  }));
  const pending = readAssistantsMetadata(conversation).pendingMessages ?? [];
  return [
    ...persisted,
    ...pending.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(m.created_at * 1000),
      pending: true,
    })),
  ];
}

export function toMessageObject(
  conversationId: string,
  assistantIdValue: string,
  index: number,
  entry: { role: string; content: string; timestamp: Date },
) {
  return {
    id: messageId(conversationId, index),
    object: 'thread.message' as const,
    created_at: Math.floor(entry.timestamp.getTime() / 1000),
    thread_id: threadId(conversationId),
    role: entry.role,
    content: [{ type: 'text' as const, text: { value: entry.content, annotations: [] } }],
    assistant_id: entry.role === 'assistant' ? assistantIdValue : null,
    run_id: null,
    metadata: {},
  };
}

export function toRunObject(threadIdValue: string, run: RunRecord) {
  return {
    id: run.id,
    object: 'thread.run' as const,
    thread_id: threadIdValue,
    assistant_id: run.assistant_id,
    status: run.status,
    created_at: run.created_at,
    started_at: run.created_at,
    completed_at: run.completed_at ?? null,
    failed_at: run.failed_at ?? null,
    last_error: run.last_error ?? null,
    usage: run.usage ?? null,
    // Always null: every run this engine produces is already terminal by the
    // time it exists (see module doc, point 2), so nothing is ever mid-run.
    required_action: null,
  };
}

/** Config-shaping errors are the caller's mistake — 400, never 500. */
export class AssistantRequestError extends Error {}

/**
 * Builds `IAgentConfig` fields from an Assistants-shaped body.
 *
 * `tools` accepts three shapes: OpenAI's `file_search` (mapped to the agent's
 * Knowledge Engine module via `tool_resources.file_search.vector_store_ids[0]`
 * — the one attachment point a native agent has), the Console-specific
 * `console_tool` extension (reaches the SAME tool/MCP/system catalog the
 * dashboard's tool picker does, via a raw `IAgentToolBinding`), and everything
 * else (`function`, `code_interpreter`) is refused with a message that says
 * why, per the module doc's point 3 — never silently dropped, which would
 * leave a caller believing a tool is armed when it is not.
 */
export async function toolBindingsFromAssistantBody(
  tenantDbName: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ toolBindings?: IAgentToolBinding[]; knowledgeEngineKey?: string }> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) return {};

  const toolBindings: IAgentToolBinding[] = [];
  let knowledgeEngineKey: string | undefined;

  for (const [index, entry] of tools.entries()) {
    const tool = entry as Record<string, unknown>;
    switch (tool.type) {
      case 'file_search': {
        const resources = (body.tool_resources as Record<string, unknown> | undefined)?.file_search as
          | Record<string, unknown>
          | undefined;
        const moduleKey = Array.isArray(resources?.vector_store_ids)
          ? resources.vector_store_ids[0]
          : undefined;
        if (typeof moduleKey !== 'string' || !moduleKey) {
          throw new AssistantRequestError(
            'tools[].type "file_search" requires tool_resources.file_search.vector_store_ids: '
              + 'a one-element array naming the Knowledge Engine module key to search.',
          );
        }
        const db = await getDatabase();
        await db.switchToTenant(tenantDbName);
        const ragModule = await db.findRagModuleByKey(moduleKey, projectId);
        if (!ragModule) {
          throw new AssistantRequestError(`No Knowledge Engine module with key "${moduleKey}"`);
        }
        knowledgeEngineKey = moduleKey;
        break;
      }
      case 'console_tool': {
        const binding = tool.tool as Record<string, unknown> | undefined;
        if (
          !binding
          || (binding.source !== 'tool' && binding.source !== 'mcp' && binding.source !== 'system')
          || typeof binding.sourceKey !== 'string'
          || !Array.isArray(binding.toolNames)
        ) {
          throw new AssistantRequestError(
            `tools[${index}].tool must be { source: "tool"|"mcp"|"system", sourceKey, toolNames: string[] }`,
          );
        }
        toolBindings.push({
          source: binding.source,
          sourceKey: binding.sourceKey,
          toolNames: binding.toolNames.filter((n): n is string => typeof n === 'string'),
          ...(binding.config && typeof binding.config === 'object'
            ? { config: binding.config as Record<string, unknown> }
            : {}),
        });
        break;
      }
      case 'function':
        throw new AssistantRequestError(
          `tools[${index}].type "function" is not supported: a client-executed tool needs the run to `
            + 'pause and wait for submitted output, and every run on this Assistants dialect completes '
            + 'synchronously (see the "console_tool" extension for a server-executed alternative).',
        );
      case 'code_interpreter':
        throw new AssistantRequestError(
          `tools[${index}].type "code_interpreter" is not backed by a runtime on this Assistants dialect yet.`,
        );
      default:
        throw new AssistantRequestError(`tools[${index}].type "${String(tool.type)}" is not recognized.`);
    }
  }

  return {
    ...(toolBindings.length ? { toolBindings } : {}),
    ...(knowledgeEngineKey ? { knowledgeEngineKey } : {}),
  };
}

export function agentToAssistant(agent: IAgent) {
  return {
    id: assistantId(agent.key),
    object: 'assistant' as const,
    created_at: agent.createdAt ? Math.floor(new Date(agent.createdAt).getTime() / 1000) : 0,
    name: agent.name,
    description: agent.description ?? null,
    model: agent.config.modelKey ?? null,
    instructions: agent.config.systemPrompt ?? null,
    tools: (agent.config.toolBindings ?? []).map((binding) => ({
      type: 'console_tool' as const,
      tool: binding,
    })),
    tool_resources: agent.config.knowledgeEngineKey
      ? { file_search: { vector_store_ids: [agent.config.knowledgeEngineKey] } }
      : {},
    temperature: agent.config.temperature ?? null,
    top_p: agent.config.topP ?? null,
    metadata: agent.metadata ?? {},
  };
}

export function extractMessageText(input: unknown): string | null {
  if (typeof input === 'string') return input.trim() || null;
  if (Array.isArray(input)) {
    const text = input.find((part) => (part as Record<string, unknown>)?.type === 'text');
    const value = (text as { text?: unknown } | undefined)?.text;
    if (typeof value === 'string') return value.trim() || null;
    if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
      return ((value as { value: string }).value.trim()) || null;
    }
  }
  return null;
}

async function loadThreadOr404(
  tenantDbName: string,
  rawThreadId: string,
): Promise<{ conversation: IAgentConversation; agent: IAgent } | { error: { code: number; message: string } }> {
  const conversationId = conversationIdFromThreadId(rawThreadId);
  const conversation = await getConversationById(tenantDbName, conversationId);
  if (!conversation) return { error: { code: 404, message: 'Thread not found' } };
  const agent = await getAgentByKey(tenantDbName, conversation.agentKey);
  if (!agent) return { error: { code: 404, message: 'Thread references an assistant that no longer exists' } };
  return { conversation, agent };
}

export const clientAssistantsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Assistants ─────────────────────────────────────────────────────────

  app.post('/client/v1/assistants', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.model !== 'string' || !body.model) {
        return reply.code(400).send({ error: '`model` is required and must name a registered model key' });
      }

      let toolFields: { toolBindings?: IAgentToolBinding[]; knowledgeEngineKey?: string };
      try {
        toolFields = await toolBindingsFromAssistantBody(ctx.tenantDbName, ctx.projectId, body);
      } catch (error) {
        if (error instanceof AssistantRequestError) return reply.code(400).send({ error: error.message });
        throw error;
      }

      const config: IAgentConfig = {
        modelKey: body.model,
        ...(typeof body.instructions === 'string' ? { systemPrompt: body.instructions } : {}),
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(typeof body.top_p === 'number' ? { topP: body.top_p } : {}),
        ...toolFields,
      };

      const bindings = await resolveConfigGuardrailBindings(
        ctx.tenantDbName,
        ctx.projectId,
        (body.metadata as Record<string, unknown> | undefined)?.guardrails,
      );
      if (bindings.error) return reply.code(400).send({ error: bindings.error });
      if (bindings.patch) Object.assign(config, bindings.patch);

      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `Assistant (${body.model})`;
      const agent = await createAgentRecord(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.tokenRecord.userId, {
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
        config,
      });

      if (body.metadata && typeof body.metadata === 'object') {
        await updateAgentRecord(ctx.tenantDbName, String(agent._id), { metadata: body.metadata as Record<string, unknown> }, ctx.tokenRecord.userId);
        agent.metadata = body.metadata as Record<string, unknown>;
      }

      return reply.code(200).send(agentToAssistant(agent));
    } catch (error) {
      logger.error('Create assistant error', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.get('/client/v1/assistants', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = request.query as { limit?: string; order?: string };
      const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
      const agents = await listAgents(ctx.tenantDbName, { projectId: ctx.projectId });
      const ordered = query.order === 'asc' ? agents : [...agents].reverse();
      const data = ordered.slice(0, limit).map(agentToAssistant);
      return reply.code(200).send({ object: 'list', data, has_more: ordered.length > limit });
    } catch (error) {
      logger.error('List assistants error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/assistants/:assistantId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { assistantId: rawId } = request.params as { assistantId: string };
      const agent = await getAgentByKey(ctx.tenantDbName, agentKeyFromAssistantId(rawId), ctx.projectId);
      if (!agent) return reply.code(404).send({ error: 'Assistant not found' });
      return reply.code(200).send(agentToAssistant(agent));
    } catch (error) {
      logger.error('Retrieve assistant error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/assistants/:assistantId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { assistantId: rawId } = request.params as { assistantId: string };
      const agent = await getAgentByKey(ctx.tenantDbName, agentKeyFromAssistantId(rawId), ctx.projectId);
      if (!agent) return reply.code(404).send({ error: 'Assistant not found' });

      const body = readJsonBody<Record<string, unknown>>(request);
      let toolFields: { toolBindings?: IAgentToolBinding[]; knowledgeEngineKey?: string } = {};
      if (body.tools !== undefined) {
        try {
          toolFields = await toolBindingsFromAssistantBody(ctx.tenantDbName, ctx.projectId, body);
        } catch (error) {
          if (error instanceof AssistantRequestError) return reply.code(400).send({ error: error.message });
          throw error;
        }
      }

      const config: Partial<IAgentConfig> = {
        ...(typeof body.model === 'string' ? { modelKey: body.model } : {}),
        ...(typeof body.instructions === 'string' ? { systemPrompt: body.instructions } : {}),
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(typeof body.top_p === 'number' ? { topP: body.top_p } : {}),
        ...(body.tools !== undefined ? toolFields : {}),
      };

      const updates: Partial<IAgent> = {
        config: { ...agent.config, ...config },
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata as Record<string, unknown> } : {}),
      };

      const updated = await updateAgentRecord(ctx.tenantDbName, String(agent._id), updates, ctx.tokenRecord.userId);
      if (!updated) return reply.code(404).send({ error: 'Assistant not found' });
      return reply.code(200).send(agentToAssistant(updated));
    } catch (error) {
      logger.error('Modify assistant error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/assistants/:assistantId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { assistantId: rawId } = request.params as { assistantId: string };
      const agent = await getAgentByKey(ctx.tenantDbName, agentKeyFromAssistantId(rawId), ctx.projectId);
      if (!agent) return reply.code(404).send({ error: 'Assistant not found' });
      const { deleteAgentRecord } = await import('@/lib/services/agents');
      const deleted = await deleteAgentRecord(ctx.tenantDbName, String(agent._id));
      return reply.code(200).send({ id: rawId, object: 'assistant.deleted', deleted });
    } catch (error) {
      logger.error('Delete assistant error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Threads ────────────────────────────────────────────────────────────

  /**
   * Creates a thread and appends any seed messages, without running one.
   * `assistant_id` is required — see the module doc's point 1 — so it accepts
   * a slightly wider body than OpenAI's (which allows a bare `{}`), and 400s
   * with the reason when it is missing rather than creating an unusable thread.
   */
  async function createThread(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{ conversation: IAgentConversation } | { error: string }> {
    if (typeof body.assistant_id !== 'string' || !body.assistant_id) {
      return {
        error: 'assistant_id is required: unlike OpenAI, a thread here is bound to one assistant for its '
          + 'lifetime (the underlying conversation record is written that way), set once at creation.',
      };
    }
    const agentKey = agentKeyFromAssistantId(body.assistant_id);
    const agent = await getAgentByKey(tenantDbName, agentKey, projectId);
    if (!agent) return { error: `No assistant with id "${body.assistant_id}"` };

    const conversation = await createConversation(tenantDbName, tenantId, projectId, userId, agentKey);

    const seedMessages = Array.isArray(body.messages) ? body.messages : [];
    if (seedMessages.length > 0) {
      const db = await getDatabase();
      await db.switchToTenant(tenantDbName);
      const now = new Date();
      const persisted = seedMessages.slice(0, -1).map((entry) => {
        const item = entry as Record<string, unknown>;
        return { role: typeof item.role === 'string' ? item.role : 'user', content: extractMessageText(item.content) ?? '', timestamp: now };
      });
      const last = seedMessages[seedMessages.length - 1] as Record<string, unknown>;
      const lastText = extractMessageText(last.content);
      const lastIsUser = last.role === 'user' && lastText;

      if (persisted.length > 0) {
        await db.updateAgentConversation(String(conversation._id), { messages: persisted });
      }
      if (lastIsUser) {
        await writeAssistantsMetadata(String(conversation._id), conversation, {
          pendingMessages: [{ id: randomUUID(), role: 'user', content: lastText, created_at: Math.floor(Date.now() / 1000) }],
        });
      } else if (lastText) {
        await db.updateAgentConversation(String(conversation._id), { messages: [...persisted, { role: typeof last.role === 'string' ? last.role : 'user', content: lastText, timestamp: now }] });
      }
    }

    const refreshed = await getConversationById(tenantDbName, String(conversation._id));
    return { conversation: refreshed ?? conversation };
  }

  function threadObject(conversation: IAgentConversation) {
    return {
      id: threadId(String(conversation._id)),
      object: 'thread' as const,
      created_at: conversation.createdAt ? Math.floor(new Date(conversation.createdAt).getTime() / 1000) : 0,
      metadata: conversation.metadata && typeof conversation.metadata === 'object'
        ? Object.fromEntries(Object.entries(conversation.metadata).filter(([key]) => key !== 'assistantsApi'))
        : {},
    };
  }

  app.post('/client/v1/threads', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const result = await createThread(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.tokenRecord.userId, body);
      if ('error' in result) return reply.code(400).send({ error: result.error });
      return reply.code(200).send(threadObject(result.conversation));
    } catch (error) {
      logger.error('Create thread error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/threads/:threadId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId } = request.params as { threadId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });
      return reply.code(200).send(threadObject(loaded.conversation));
    } catch (error) {
      logger.error('Retrieve thread error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/threads/:threadId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId } = request.params as { threadId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const body = readJsonBody<Record<string, unknown>>(request);
      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);
      const conversationId = conversationIdFromThreadId(rawId);
      if (body.metadata && typeof body.metadata === 'object') {
        const merged = { ...(loaded.conversation.metadata ?? {}), ...(body.metadata as Record<string, unknown>) };
        // The Assistants bookkeeping namespace is server-owned; a caller
        // patching `metadata` must not be able to erase pending messages or
        // run history it never knew existed.
        merged.assistantsApi = readAssistantsMetadata(loaded.conversation);
        await db.updateAgentConversation(conversationId, { metadata: merged });
      }
      const refreshed = await getConversationById(ctx.tenantDbName, conversationId);
      return reply.code(200).send(threadObject(refreshed ?? loaded.conversation));
    } catch (error) {
      logger.error('Modify thread error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/threads/:threadId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId } = request.params as { threadId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });
      const { deleteConversation } = await import('@/lib/services/agents');
      const deleted = await deleteConversation(ctx.tenantDbName, conversationIdFromThreadId(rawId));
      return reply.code(200).send({ id: rawId, object: 'thread.deleted', deleted });
    } catch (error) {
      logger.error('Delete thread error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Messages ───────────────────────────────────────────────────────────

  app.post('/client/v1/threads/:threadId/messages', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId } = request.params as { threadId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const body = readJsonBody<Record<string, unknown>>(request);
      const text = extractMessageText(body.content);
      if (!text) return reply.code(400).send({ error: '`content` is required (a string, or a `text` content part)' });
      if (body.role !== undefined && body.role !== 'user' && body.role !== 'assistant') {
        return reply.code(400).send({ error: '`role` must be "user" or "assistant"' });
      }

      const conversationId = conversationIdFromThreadId(rawId);
      const pending = readAssistantsMetadata(loaded.conversation).pendingMessages ?? [];
      const role = (body.role as 'user' | 'assistant' | undefined) ?? 'user';
      const entry: PendingMessage = { id: randomUUID(), role, content: text, created_at: Math.floor(Date.now() / 1000) };

      // Only ONE un-run message is supported at a time (see module doc): a run
      // consumes exactly one, and this engine has no way to fold several turns
      // into a single call without inventing a merge rule OpenAI itself doesn't
      // have to. Adding a second before running the first is refused rather
      // than silently queued.
      if (pending.length > 0 && role === 'user') {
        return reply.code(400).send({
          error: 'A message is already pending a run on this thread. Create a run to consume it before adding another.',
        });
      }
      await writeAssistantsMetadata(conversationId, loaded.conversation, { pendingMessages: [...pending, entry] });

      const merged = mergedMessages({ ...loaded.conversation, metadata: { ...(loaded.conversation.metadata ?? {}), assistantsApi: { ...readAssistantsMetadata(loaded.conversation), pendingMessages: [...pending, entry] } } });
      const index = merged.length - 1;
      return reply.code(200).send(toMessageObject(conversationId, assistantId(loaded.agent.key), index, merged[index]));
    } catch (error) {
      logger.error('Create message error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/threads/:threadId/messages', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId } = request.params as { threadId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const conversationId = conversationIdFromThreadId(rawId);
      const query = request.query as { limit?: string; order?: string };
      const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
      const merged = mergedMessages(loaded.conversation);
      const objects = merged.map((entry, index) => toMessageObject(conversationId, assistantId(loaded.agent.key), index, entry));
      const ordered = query.order === 'asc' ? objects : [...objects].reverse();
      return reply.code(200).send({ object: 'list', data: ordered.slice(0, limit), has_more: ordered.length > limit });
    } catch (error) {
      logger.error('List messages error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/threads/:threadId/messages/:messageId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId, messageId: rawMessageId } = request.params as { threadId: string; messageId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const conversationId = conversationIdFromThreadId(rawId);
      const merged = mergedMessages(loaded.conversation);
      const index = merged.findIndex((_, i) => messageId(conversationId, i) === rawMessageId);
      if (index === -1) return reply.code(404).send({ error: 'Message not found' });
      return reply.code(200).send(toMessageObject(conversationId, assistantId(loaded.agent.key), index, merged[index]));
    } catch (error) {
      logger.error('Retrieve message error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Runs ───────────────────────────────────────────────────────────────

  /** Runs the ONE pending message on a thread and records the outcome. Shared
   * by `POST .../threads/:id/runs` and the create-and-run convenience route. */
  async function runThread(
    ctx: Awaited<ReturnType<typeof getApiTokenContextForRequest>>,
    request: Parameters<Parameters<typeof withClientApiRequestContext>[0]>[0],
    conversationId: string,
    conversation: IAgentConversation,
    agent: IAgent,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    if (typeof body.assistant_id === 'string' && agentKeyFromAssistantId(body.assistant_id) !== agent.key) {
      return {
        status: 400,
        body: {
          error: `This thread is bound to assistant "${assistantId(agent.key)}"; `
            + `a run cannot switch it to "${body.assistant_id}" (see the module's thread-binding note).`,
        },
      };
    }

    const pending = readAssistantsMetadata(conversation).pendingMessages ?? [];
    const toRun = pending.find((m) => m.role === 'user');
    if (!toRun) {
      return {
        status: 400,
        body: { error: 'Nothing to run: add a user message with POST .../threads/:id/messages first.' },
      };
    }

    const record: RunRecord = {
      id: runId(),
      status: 'completed',
      created_at: Math.floor(Date.now() / 1000),
      assistant_id: assistantId(agent.key),
    };

    try {
      const runtimeContext = buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
        userId: ctx.tokenRecord.userId,
        tokenId: ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined,
        source: 'api',
      });

      const result = await executeAgentChat({
        agentKey: agent.key,
        conversationId,
        projectId: ctx.projectId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        usePublished: true,
        userId: ctx.tokenRecord.userId,
        userMessage: toRun.content,
        runtimeContext,
      });

      // `executeAgentChat` just persisted the (user, assistant) pair itself —
      // the pending entry is now redundant history, so it comes off the queue
      // rather than being replayed on the next run.
      record.completed_at = Math.floor(Date.now() / 1000);
      record.usage = {
        prompt_tokens: result.usage.input_tokens,
        completion_tokens: result.usage.output_tokens,
        total_tokens: result.usage.total_tokens,
      };
      const remaining = pending.filter((m) => m.id !== toRun.id);
      const existingRuns = readAssistantsMetadata(conversation).runs ?? [];
      await writeAssistantsMetadata(conversationId, conversation, {
        pendingMessages: remaining,
        runs: [...existingRuns, record].slice(-50),
      });

      return { status: 200, body: toRunObject(threadId(conversationId), record) };
    } catch (error) {
      // The pending message is DELIBERATELY left in place on failure — same as
      // OpenAI's own semantics (a failed run never consumes the thread state it
      // was given), so the caller can fix whatever was wrong and run again
      // without re-sending the message.
      if (error instanceof AgentGuardrailBlockedError) {
        record.status = 'failed';
        record.failed_at = Math.floor(Date.now() / 1000);
        record.last_error = { code: 'guardrail_block', message: error.message };
      } else {
        record.status = 'failed';
        record.failed_at = Math.floor(Date.now() / 1000);
        record.last_error = { code: 'server_error', message: error instanceof Error ? error.message : 'Run failed' };
      }
      const existingRuns = readAssistantsMetadata(conversation).runs ?? [];
      await writeAssistantsMetadata(conversationId, conversation, { runs: [...existingRuns, record].slice(-50) });
      return { status: 200, body: toRunObject(threadId(conversationId), record) };
    }
  }

  app.post('/client/v1/threads/:threadId/runs', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId } = request.params as { threadId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const body = readJsonBody<Record<string, unknown>>(request);
      const outcome = await runThread(ctx, request, conversationIdFromThreadId(rawId), loaded.conversation, loaded.agent, body);
      return reply.code(outcome.status).send(outcome.body);
    } catch (error) {
      logger.error('Create run error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /** OpenAI's `client.beta.threads.createAndRun` convenience: create a thread
   * and immediately run its final seed message, in one call. */
  app.post('/client/v1/threads/runs', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.assistant_id !== 'string' || !body.assistant_id) {
        return reply.code(400).send({ error: 'assistant_id is required' });
      }

      const threadBody = { ...(body.thread as Record<string, unknown> | undefined ?? {}), assistant_id: body.assistant_id };
      const created = await createThread(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.tokenRecord.userId, threadBody);
      if ('error' in created) return reply.code(400).send({ error: created.error });

      const agent = await getAgentByKey(ctx.tenantDbName, agentKeyFromAssistantId(body.assistant_id), ctx.projectId);
      if (!agent) return reply.code(404).send({ error: `No assistant with id "${body.assistant_id}"` });

      const outcome = await runThread(ctx, request, String(created.conversation._id), created.conversation, agent, body);
      return reply.code(outcome.status).send(outcome.body);
    } catch (error) {
      logger.error('Create-and-run error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/threads/:threadId/runs', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId } = request.params as { threadId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const runs = readAssistantsMetadata(loaded.conversation).runs ?? [];
      const query = request.query as { limit?: string; order?: string };
      const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
      const ordered = query.order === 'asc' ? runs : [...runs].reverse();
      const data = ordered.slice(0, limit).map((run) => toRunObject(rawId, run));
      return reply.code(200).send({ object: 'list', data, has_more: ordered.length > limit });
    } catch (error) {
      logger.error('List runs error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/threads/:threadId/runs/:runId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId, runId: rawRunId } = request.params as { threadId: string; runId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const runs = readAssistantsMetadata(loaded.conversation).runs ?? [];
      const run = runs.find((r) => r.id === rawRunId);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send(toRunObject(rawId, run));
    } catch (error) {
      logger.error('Retrieve run error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /** Always refuses: see the module doc's point 2 — a run is terminal the
   * instant it exists, so there is never anything in flight to cancel. */
  app.post('/client/v1/threads/:threadId/runs/:runId/cancel', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { threadId: rawId, runId: rawRunId } = request.params as { threadId: string; runId: string };
      const loaded = await loadThreadOr404(ctx.tenantDbName, rawId);
      if ('error' in loaded) return reply.code(loaded.error.code).send({ error: loaded.error.message });

      const runs = readAssistantsMetadata(loaded.conversation).runs ?? [];
      const run = runs.find((r) => r.id === rawRunId);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(400).send({
        error: `Run "${rawRunId}" is already "${run.status}": every run on this Assistants dialect completes `
          + 'synchronously, so by the time a client could reach this endpoint there is nothing left in flight.',
      });
    } catch (error) {
      logger.error('Cancel run error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
