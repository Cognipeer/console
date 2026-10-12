/**
 * Model selection for the routes that start an agent run: which of the agent's models (main or
 * `additionalModels`) the request asks for. No permission of its own: see
 * lib/services/agents/agentModelSelection.ts.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAgent, IAgentConversation } from '@/lib/database';
import { resolveAgentConfig } from '@/lib/services/agents/agentService';
import {
  AgentModelError,
  advertisedAgentModels,
  resolveAgentRunModel,
  type AdvertisedAgentModel,
  type AgentModelChoice,
} from '@/lib/services/agents/agentModelSelection';
import { getDatabase } from '@/lib/database';
import { invalidRequestErrorBody } from '@/lib/services/agents/agentRunService';

type AgentRef = Pick<IAgent, '_id' | 'key'> & { config: IAgent['config'] };

/**
 * What the caller asked for, from the body (`agent_model`) or the `x-cognipeer-agent-model` header; the
 * body wins. `model` itself names the AGENT on the OpenAI-shaped surfaces, so it is never read here.
 */
export function requestedAgentModel(request: FastifyRequest, body: Record<string, unknown> | undefined | null): string | undefined {
  const fromBody = body?.agent_model;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();
  const header = request.headers['x-cognipeer-agent-model'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The config that will run: the published one (or the pinned `version`), the way the API surfaces run an agent. */
export async function resolveAgentConfigForModels(tenantDbName: string, agent: AgentRef, projectId: string, version?: number): Promise<IAgent['config']> {
  return (await resolveAgentConfig(tenantDbName, agent.key, projectId, version).catch(() => null))?.config ?? agent.config;
}

/** The route-level entry: which model this request's run uses (throws `AgentModelError`). */
export function resolveRunModelForRequest(
  _request: FastifyRequest,
  input: { agent: AgentRef; config: IAgent['config']; projectId: string; requested?: string; conversation?: Pick<IAgentConversation, 'metadata'> | null },
): Promise<AgentModelChoice> {
  return resolveAgentRunModel({
    config: input.config,
    requested: input.requested,
    sessionMetadata: input.conversation?.metadata,
  });
}

/** The `models` of an agent's info (undefined when the agent offers a single model). */
export async function advertisedModelsForRequest(
  _request: FastifyRequest,
  input: { agent: AgentRef; tenantDbName: string; projectId: string },
): Promise<AdvertisedAgentModel[] | undefined> {
  const config = input.agent.config;
  if (!config?.additionalModels?.length) return undefined;
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  return advertisedAgentModels({
    config,
    nameOf: async (key) => (await db.findModelByKey(key, input.projectId).catch(() => null))?.name,
  });
}

/** Records the session's choice (`conversation.metadata.activeModel`) when it changed; best effort. */
export async function rememberSessionModel(
  tenantDbName: string,
  conversation: { _id?: unknown; metadata?: Record<string, unknown> } | string,
  choice: AgentModelChoice,
): Promise<void> {
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // A bare id: read the session's current metadata first (the write replaces the column).
    const current = typeof conversation === 'string' ? await db.findAgentConversationById(conversation) : conversation;
    const id = typeof conversation === 'string' ? conversation : String(conversation._id);
    const stored = current?.metadata?.activeModel as { modelKey?: unknown; reason?: unknown } | undefined;
    if (stored?.modelKey === choice.modelKey && stored?.reason === choice.reason) return;
    await db.updateAgentConversation(id, { metadata: { ...(current?.metadata ?? {}), activeModel: choice } });
  } catch {
    // The run itself carries the choice; the session record is a convenience for the next message.
  }
}

/** The OpenAI-shaped answer (`{ error: { message, type, code } }`) for a refused model choice. */
export function sendOpenAiAgentModelError(reply: FastifyReply, error: AgentModelError): FastifyReply {
  return reply.code(error.status).send({ error: { message: error.message, type: 'invalid_request_error', code: error.code } });
}

/** The client-API answer for a refused model choice: 400 `model_not_allowed`. */
export function sendAgentModelError(reply: FastifyReply, _request: FastifyRequest, error: AgentModelError): FastifyReply {
  return reply.code(error.status).send(invalidRequestErrorBody(error.message, error.code));
}

export { AgentModelError };
