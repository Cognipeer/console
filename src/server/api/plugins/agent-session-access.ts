/**
 * Loading an agent session for the caller - the one place that answers "may THIS
 * principal see / act on THIS session?".
 *
 * A session belongs to the person who started it (`conversation.createdBy`; for API
 * traffic, the owner of the token). The route's own service check (`agents` read /
 * write) is all the owner needs. Somebody else needs one of two actions of the
 * agent, decided by the policy engine:
 *
 *   need 'view'     `agent.session_view_others`    (Read level)
 *   need 'manage'   `agent.session_manage_others`  (Write level)
 *
 * By default every `agents` reader / writer holds them (they sit in the level
 * groups, so today's behaviour is reproduced); restricting them is an ordinary deny
 * policy. Sessions that no person started (`a2a-public`, `system:*`, `evaluation`,
 * `redteam`) belong to nobody in particular: they are always someone else's.
 *
 * Before this helper every route carried its own copy of the project / agent check
 * (about seventeen of them) and none looked at the owner. The helper does both, once:
 * a session of another project or agent answers `not_found`, so an id does not
 * confirm that something exists; one the caller may not touch answers `forbidden`,
 * with the engine's decision id (the audit row and the Access check replay it).
 * When the engine cannot decide it THROWS the 503 the gate would have sent
 * (`authorizeResourceForRequest`), so an outage is never read as an answer.
 *
 * A LIST cannot ask per row: `canViewOthersSessions` decides once per request
 * whether the caller sees every session of an agent or only their own.
 */

import type { FastifyRequest } from 'fastify';
import type { IAgent, IAgentConversation } from '@/lib/database';
import { agentSessionResource } from '@/lib/iam/agentEntities';
import { getAgentByKey, getConversationById } from '@/lib/services/agents';
import { authorizeResourceForRequest, requireProjectContextForRequest } from '../fastify-utils';

export type SessionNeed = 'view' | 'manage';

const ACTION_OF_NEED = {
  view: 'agent.session_view_others',
  manage: 'agent.session_manage_others',
} as const;

export interface LoadSessionOptions {
  /** `view`: read it. `manage`: change it (continue, budget, files, delete, ...). */
  need: SessionNeed;
  /** The session must belong to this agent (the dashboard routes name one). */
  agentKey?: string;
  /** The agent, when the caller has it: saves the lookup of its registry id. */
  agent?: Pick<IAgent, '_id' | 'key'> | null;
  /** The project the session must belong to. Default: the one the request runs in. */
  projectId?: string;
}

export type LoadedSession =
  | {
    ok: true;
    conversation: IAgentConversation;
    /** The person the request acts for: the session user, or the token's owner. */
    userId: string;
    /** The caller started this session (no engine question was needed). */
    owner: boolean;
  }
  | { ok: false; status: 404; reason: 'not_found' }
  | { ok: false; status: 403; reason: 'forbidden'; decisionId?: string };

interface RequestActor {
  tenantDbName: string;
  projectId: string;
  userId: string;
}

/** Who the request acts for and in which project: a token (its owner, its project) or the signed-in session. */
async function actorOf(request: FastifyRequest): Promise<RequestActor> {
  const token = request.apiTokenContext;
  if (token) {
    return { tenantDbName: token.tenantDbName, projectId: String(token.projectId ?? ''), userId: String(token.tokenRecord.userId ?? '') };
  }
  const context = await requireProjectContextForRequest(request);
  return { tenantDbName: context.session.tenantDbName, projectId: context.projectId, userId: context.session.userId };
}

/** The registry id of an agent: what a rule that names one agent is about (its key stands in for a deleted agent). */
async function agentIdOf(
  tenantDbName: string,
  conversation: Pick<IAgentConversation, 'agentKey' | 'projectId'>,
  known: LoadSessionOptions['agent'],
): Promise<string> {
  const agent = known !== undefined ? known : await getAgentByKey(tenantDbName, conversation.agentKey, conversation.projectId);
  return agent?._id ? String(agent._id) : conversation.agentKey;
}

/**
 * Loads the session `conversationId` for the caller, or says why not. See the module comment.
 * `owner: true` results never reached the engine.
 */
export async function loadSessionForPrincipal(
  request: FastifyRequest,
  conversationId: string,
  options: LoadSessionOptions,
): Promise<LoadedSession> {
  const actor = await actorOf(request);
  const projectId = options.projectId ?? actor.projectId;

  let conversation: IAgentConversation | null = null;
  try {
    conversation = typeof conversationId === 'string' && conversationId ? await getConversationById(actor.tenantDbName, conversationId) : null;
  } catch {
    conversation = null;
  }
  if (!conversation
    || conversation.projectId !== projectId
    || (options.agentKey !== undefined && conversation.agentKey !== options.agentKey)) {
    return { ok: false, status: 404, reason: 'not_found' };
  }

  // The person who started it needs nothing beyond the route's own service check.
  if (actor.userId && String(conversation.createdBy) === actor.userId) {
    return { ok: true, conversation, userId: actor.userId, owner: true };
  }

  const result = await authorizeResourceForRequest(request, {
    action: ACTION_OF_NEED[options.need],
    resource: agentSessionResource({
      id: await agentIdOf(actor.tenantDbName, conversation, options.agent),
      key: conversation.agentKey,
      projectId: conversation.projectId,
      ownerIds: [String(conversation.createdBy ?? '')],
    }),
    subject: { resourceName: conversation.agentKey },
    // The session is in the request's project (checked above): decide in exactly that one.
    projectId: conversation.projectId,
  });
  if (!result.allowed) {
    return { ok: false, status: 403, reason: 'forbidden', ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
  }
  return { ok: true, conversation, userId: actor.userId, owner: false };
}

/**
 * For a LIST of an agent's sessions: does the caller see everybody's (`true`), or only the sessions they
 * started (`false`)? Asked of the engine once per request, about the agent with no owner in particular - the
 * answer for "a session somebody else started". Throws the 503 when the engine cannot decide.
 */
export async function canViewOthersSessions(
  request: FastifyRequest,
  input: { agent: Pick<IAgent, '_id' | 'key'>; projectId?: string },
): Promise<boolean> {
  const actor = await actorOf(request);
  const projectId = input.projectId ?? actor.projectId;
  const result = await authorizeResourceForRequest(request, {
    action: ACTION_OF_NEED.view,
    resource: agentSessionResource({ id: String(input.agent._id ?? input.agent.key), key: input.agent.key, projectId, ownerIds: [] }),
    subject: { resourceName: input.agent.key },
    projectId,
    // Showing a person only their own sessions is not a refusal: nothing to audit.
    quiet: true,
  });
  return result.allowed;
}
