/**
 * Inbound A2A (Agent2Agent) server — exposes Cognipeer agents to external
 * A2A clients over JSON-RPC 2.0 (spec v1.0).
 *
 * Token-authenticated surface (per agent, `cpeer_` API token):
 *   GET  /client/v1/a2a/:agentKey/.well-known/agent-card.json
 *   POST /client/v1/a2a/:agentKey          (message/send, tasks/get)
 *
 * Exposure is OPT-IN per agent via `agent.metadata.a2a` (see
 * `@/lib/services/agents/a2aExposure`); agents without it respond 404 on
 * every A2A route. Agents with accessMode 'public' are additionally served
 * unauthenticated by the public-a2a plugin, which reuses the shared
 * `handleA2aRpc` / `buildAgentCard` helpers exported here.
 *
 * State model: A2A `contextId` maps 1:1 onto the existing agent conversation
 * id (the same store the Responses API uses via `resp_<conversationId>`).
 * Tasks complete synchronously — `message/send` returns a terminal `completed`
 * task whose id encodes the conversation and assistant-message index, so
 * `tasks/get` can rebuild it without a separate task collection.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAgent } from '@/lib/database';
import {
  createConversation,
  executeAgentChat,
  getAgentByKey,
  getConversationById,
} from '@/lib/services/agents/agentService';
import { isA2aEnabled } from '@/lib/services/agents/a2aExposure';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-a2a');

const A2A_PROTOCOL_VERSION = '1.0';
const JSONRPC_VERSION = '2.0';

// A2A-specific JSON-RPC error codes (spec §8).
const ERR_TASK_NOT_FOUND = -32001;
const ERR_UNSUPPORTED_OPERATION = -32004;

export { isA2aEnabled };

interface A2aPart {
  kind?: string;
  text?: string;
}

interface A2aIncomingMessage {
  role?: string;
  parts?: A2aPart[];
  messageId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/** Tenant/caller identity an A2A call executes under (token or public). */
export interface A2aCallContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Attribution identity: the token's user, or a sentinel for public calls. */
  userId: string;
  tokenId?: string;
}

function jsonRpcOk(id: string | number | null, result: unknown) {
  return { id, jsonrpc: JSONRPC_VERSION, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { error: { code, message }, id, jsonrpc: JSONRPC_VERSION };
}

function extractText(parts: A2aPart[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && (p.kind === 'text' || p.kind === undefined) && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

function taskId(conversationId: string, messageIndex: number): string {
  return `task_${conversationId}_${messageIndex}`;
}

function parseTaskId(id: string): { conversationId: string; messageIndex: number } | null {
  const match = /^task_(.+)_(\d+)$/.exec(id);
  if (!match) return null;
  return { conversationId: match[1], messageIndex: Number(match[2]) };
}

function completedTask(
  id: string,
  contextId: string,
  assistantText: string,
): Record<string, unknown> {
  return {
    kind: 'task',
    id,
    contextId,
    status: {
      state: 'completed',
      timestamp: new Date().toISOString(),
    },
    artifacts: [
      {
        artifactId: `${id}_artifact`,
        name: 'response',
        parts: [{ kind: 'text', text: assistantText }],
      },
    ],
  };
}

export function externalBaseUrl(request: FastifyRequest): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProto === 'string' && forwardedProto.length > 0
    ? forwardedProto
    : 'http';
  const host = typeof request.headers.host === 'string' && request.headers.host.length > 0
    ? request.headers.host
    : 'localhost';
  return `${protocol}://${host}`;
}

export function buildAgentCard(
  agent: IAgent,
  endpoint: string,
  options: { publicAccess?: boolean } = {},
): Record<string, unknown> {
  const toolTags = (agent.config.toolBindings ?? []).flatMap((b) => b.toolNames).slice(0, 20);

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.name,
    description: agent.description || `Cognipeer agent "${agent.name}"`,
    url: endpoint,
    preferredTransport: 'JSONRPC',
    provider: { organization: 'Cognipeer', url: 'https://cognipeer.com' },
    version: agent.publishedVersion ? String(agent.publishedVersion) : '0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'chat',
        name: `Chat with ${agent.name}`,
        description: agent.description || `Conversational access to the "${agent.name}" agent.`,
        tags: ['chat', ...toolTags],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
    ...(options.publicAccess
      ? { securitySchemes: {}, security: [] }
      : {
          securitySchemes: {
            bearer: {
              type: 'http',
              scheme: 'bearer',
              description: 'Cognipeer API token (cpeer_…)',
            },
          },
          security: [{ bearer: [] }],
        }),
  };
}

/**
 * Shared JSON-RPC dispatcher for the token and public A2A surfaces. The
 * caller has already resolved + authorized the agent; this only executes
 * the protocol methods under the supplied call context.
 */
export async function handleA2aRpc(
  ctx: A2aCallContext,
  agent: IAgent,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  let rpcId: string | number | null = null;
  try {
    let body: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      body = readJsonBody(request);
    } catch {
      return reply.code(200).send(jsonRpcError(null, -32700, 'Parse error'));
    }
    rpcId = body.id ?? null;
    const method = body.method;

    if (method === 'message/send') {
      const message = (body.params?.message ?? {}) as A2aIncomingMessage;
      const userMessage = extractText(message.parts);
      if (!userMessage.trim()) {
        return reply.code(200).send(
          jsonRpcError(rpcId, -32602, 'Invalid params: message.parts must contain text'),
        );
      }

      // contextId ↔ conversationId: reuse the Responses API conversation store.
      let conversationId: string | undefined;
      if (typeof message.contextId === 'string' && message.contextId) {
        const conversation = await getConversationById(ctx.tenantDbName, message.contextId);
        if (!conversation || conversation.agentKey !== agent.key) {
          return reply.code(200).send(
            jsonRpcError(rpcId, -32602, 'Invalid params: unknown contextId'),
          );
        }
        conversationId = message.contextId;
      } else {
        const conversation = await createConversation(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
          ctx.userId,
          agent.key,
        );
        conversationId = String(conversation._id);
      }

      const runtimeContext = buildRuntimeContextFromRequest(
        message.metadata?.runtime_context,
        request.headers,
        {
          userId: ctx.userId,
          tokenId: ctx.tokenId,
          source: 'a2a',
        },
      );

      const result = await executeAgentChat({
        agentKey: agent.key,
        conversationId,
        projectId: ctx.projectId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        usePublished: true,
        userId: ctx.userId,
        userMessage,
        runtimeContext,
      });

      const assistantText = result.output
        .filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
        .flatMap((item) => item.content.map((c) => c.text))
        .join('');
      const messageIndex = (result._conversation_messages?.length ?? 1) - 1;

      return reply.code(200).send(jsonRpcOk(
        rpcId,
        completedTask(taskId(conversationId, messageIndex), conversationId, assistantText),
      ));
    }

    if (method === 'tasks/get') {
      const requestedId = typeof body.params?.id === 'string' ? body.params.id : '';
      const parsed = requestedId ? parseTaskId(requestedId) : null;
      if (!parsed) {
        return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
      }
      const conversation = await getConversationById(ctx.tenantDbName, parsed.conversationId);
      const message = conversation?.agentKey === agent.key
        ? conversation.messages?.[parsed.messageIndex]
        : undefined;
      if (!message || message.role !== 'assistant') {
        return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
      }
      return reply.code(200).send(jsonRpcOk(
        rpcId,
        completedTask(requestedId, parsed.conversationId, message.content),
      ));
    }

    if (method === 'tasks/cancel') {
      // Tasks complete synchronously — there is never anything to cancel.
      return reply.code(200).send(
        jsonRpcError(rpcId, ERR_UNSUPPORTED_OPERATION, 'Tasks complete synchronously and cannot be canceled'),
      );
    }

    return reply.code(200).send(jsonRpcError(rpcId, -32601, `Method not found: ${method}`));
  } catch (error) {
    logger.error('A2A request error', { error });
    return reply.code(200).send(jsonRpcError(rpcId, -32603, 'Internal error'));
  }
}

async function loadExposedAgent(
  ctx: ApiTokenContext,
  agentKey: string,
  reply: FastifyReply,
): Promise<IAgent | null> {
  const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
  if (!agent || !isA2aEnabled(agent)) {
    // Same response for missing and unexposed agents — don't leak existence.
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
  if (agent.status !== 'active') {
    void reply.code(400).send({ error: 'Agent is not active' });
    return null;
  }
  return agent;
}

export const clientA2aApiPlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/client/v1/a2a/:agentKey/.well-known/agent-card.json',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const { agentKey } = request.params as { agentKey: string };
        const agent = await loadExposedAgent(ctx, agentKey, reply);
        if (!agent) return reply;

        const endpoint = `${externalBaseUrl(request)}/api/client/v1/a2a/${agent.key}`;
        return reply.code(200).send(buildAgentCard(agent, endpoint));
      } catch (error) {
        logger.error('A2A agent card error', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  app.post('/client/v1/a2a/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };

      const agent = await loadExposedAgent(ctx, agentKey, reply);
      if (!agent) return reply;

      return await handleA2aRpc(
        {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          userId: ctx.tokenRecord.userId,
          tokenId: ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined,
        },
        agent,
        request,
        reply,
      );
    } catch (error) {
      logger.error('A2A request error', { error });
      return reply.code(200).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));
};
