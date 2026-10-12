/**
 * `agent.use_model`, asked of the policy engine by the routes that start an agent run on one of its
 * ADDITIONAL models (see lib/services/agents/agentModelSelection.ts for the rules around it). The
 * asker is the request's own principal - the person, or the token's owner with the token's cap - in
 * the project the agent belongs to, exactly like `agent.approve` (agent-approval-authz.ts).
 *
 * The main model is never asked about; the route only builds an authorizer and hands it to
 * `resolveAgentRunModel` / `advertisedAgentModels`, which call it for additional models alone.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAgent, IAgentConversation } from '@/lib/database';
import { resolveAgentConfig } from '@/lib/services/agents/agentService';
import { agentSessionResource } from '@/lib/iam/agentEntities';
import {
  AgentModelError,
  advertisedAgentModels,
  resolveAgentRunModel,
  type AdvertisedAgentModel,
  type AgentModelAuthorizer,
  type AgentModelChoice,
} from '@/lib/services/agents/agentModelSelection';
import { getDatabase } from '@/lib/database';
import { apiErrorBody, invalidRequestErrorBody } from '@/lib/services/agents/agentRunService';
import { authorizationRefusalOf, authorizeResourceForRequest } from '../fastify-utils';
import { sendAuthorizationUnavailable } from './agent-session-access';

type AgentRef = Pick<IAgent, '_id' | 'key'> & { config: IAgent['config'] };

/** The engine's answer to "may this caller run this agent on that model?", as a verdict - an outage is `unavailable`. */
export function agentModelAuthorizer(request: FastifyRequest, agent: AgentRef, projectId: string): AgentModelAuthorizer {
  return async (modelKey, options) => {
    try {
      const result = await authorizeResourceForRequest(request, {
        action: 'agent.use_model',
        resource: agentSessionResource({ id: String(agent._id), key: agent.key, projectId, ownerIds: [] }),
        subject: { resourceName: agent.key },
        projectId,
        model: modelKey,
        ...(options.quiet ? { quiet: true } : {}),
      });
      return result.allowed
        ? { allowed: true }
        : { allowed: false, ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
    } catch (error) {
      const refusal = authorizationRefusalOf(error);
      if (refusal?.status !== 503) throw error;
      return { allowed: false, unavailable: true, ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}) };
    }
  };
}

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
  request: FastifyRequest,
  input: { agent: AgentRef; config: IAgent['config']; projectId: string; requested?: string; conversation?: Pick<IAgentConversation, 'metadata'> | null },
): Promise<AgentModelChoice> {
  return resolveAgentRunModel({
    config: input.config,
    requested: input.requested,
    sessionMetadata: input.conversation?.metadata,
    authorize: agentModelAuthorizer(request, input.agent, input.projectId),
  });
}

/** The `models` of an agent's info for THIS caller (undefined when the agent offers a single model for them). */
export async function advertisedModelsForRequest(
  request: FastifyRequest,
  input: { agent: AgentRef; tenantDbName: string; projectId: string },
): Promise<AdvertisedAgentModel[] | undefined> {
  const config = input.agent.config;
  if (!config?.additionalModels?.length) return undefined;
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  return advertisedAgentModels({
    config,
    authorize: agentModelAuthorizer(request, input.agent, input.projectId),
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
  const type = error.code === 'model_not_allowed' ? 'invalid_request_error' : error.code === 'model_forbidden' ? 'permission_error' : 'server_error';
  return reply.code(error.status).send({
    error: { message: error.message, type, code: error.code, ...(error.decisionId ? { decision_id: error.decisionId } : {}) },
  });
}

/** The client-API answer for a refused model choice: 400 `model_not_allowed`, 403 `model_forbidden` (decision id), 503 when the engine cannot decide. */
export function sendAgentModelError(reply: FastifyReply, request: FastifyRequest, error: AgentModelError): FastifyReply {
  if (error.code === 'model_not_allowed') return reply.code(400).send(invalidRequestErrorBody(error.message, 'model_not_allowed'));
  if (error.code === 'authorization_unavailable') {
    return sendAuthorizationUnavailable(reply, request, 'client', { action: 'agent.use_model', level: 'read', decisionId: error.decisionId });
  }
  return reply.code(403).send(apiErrorBody('permission_error', error.message, 'model_forbidden', error.decisionId ? { decision_id: error.decisionId } : undefined));
}

export { AgentModelError };
