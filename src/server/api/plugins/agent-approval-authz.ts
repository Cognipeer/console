/**
 * Who may answer a pending request of an agent session - asked of the policy
 * engine (`agent.approve`), by the route that has the principal.
 *
 * The service layer (agentActionResolution.ts) has no principal: it takes ids and a
 * user id. A route therefore hands it an `ApprovalAuthorizer`, built here, that asks
 * the engine with the very principal the route gate used (the person or the token's
 * owner, the project narrowing, the token's scope as a cap). The engine's rule
 * (`managed:agent:approve*`) reads the session's owners and the agent's own
 * "who can approve" setting; custom policies restrict on top.
 *
 * The same question guards the places where a request is ENDED as a side effect: the
 * cancel of a run that is paused on an approval, and a new message under
 * `onUserMessageWhilePending: 'cancel_pending'`. Ending somebody's open request is
 * answering it with "no", so it takes the same permission.
 *
 * A refusal resolves `{ allowed: false, decisionId }` (the route's 403 names the
 * decision); when the engine cannot decide it THROWS the 503 the gate would have
 * sent, so an outage is never read as an answer (fastify-utils.ts
 * `authorizeResourceForRequest`).
 */

import type { FastifyRequest } from 'fastify';
import type { IAgent, IAgentConfig, IAgentConversation, IAgentPendingAction } from '@/lib/database';
import { agentSessionResource } from '@/lib/iam/agentEntities';
import { getAgentByKey } from '@/lib/services/agents';
import type { ApprovalAuthorizer, ApprovalVerdict } from '@/lib/services/agents/agentActionResolution';
import { resolveHitlConfig, type ResolvedHitlConfig } from '@/lib/services/agents/agentHumanInTheLoop';
import { runWithTenantDb } from '@/lib/services/agents/agentRunService';
import { authorizeResourceForRequest } from '../fastify-utils';

interface ApprovalQuestion {
  tenantDbName: string;
  conversation: Pick<IAgentConversation, 'agentKey' | 'projectId' | 'createdBy'>;
  /** The people whose turn raised the open requests (`action.createdBy`), besides the session's own creator. */
  raisedBy?: ReadonlyArray<string | null | undefined>;
  approvers: ResolvedHitlConfig['approvers'];
  /** The agent, when the caller has it; read by key otherwise (a deleted agent is asked about by its key). */
  agent?: Pick<IAgent, '_id' | 'key'> | null;
}

/** The registry id of the agent: what `agent.get` and a rule that names one agent are about. */
async function agentResourceId(question: ApprovalQuestion): Promise<string> {
  const { conversation } = question;
  const agent = question.agent !== undefined
    ? question.agent
    : await getAgentByKey(question.tenantDbName, conversation.agentKey, conversation.projectId);
  return agent?._id ? String(agent._id) : conversation.agentKey;
}

async function askToApprove(request: FastifyRequest, question: ApprovalQuestion): Promise<ApprovalVerdict> {
  const { conversation } = question;
  const result = await authorizeResourceForRequest(request, {
    action: 'agent.approve',
    resource: agentSessionResource({
      id: await agentResourceId(question),
      key: conversation.agentKey,
      projectId: conversation.projectId,
      ownerIds: [String(conversation.createdBy ?? ''), ...(question.raisedBy ?? [])],
      approvers: question.approvers,
    }),
    subject: { resourceName: conversation.agentKey },
    // The session is in the request's project (the route checked): decide in exactly that one.
    projectId: conversation.projectId,
  });
  return result.allowed ? { allowed: true } : { allowed: false, ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
}

/** The authorizer a route hands to `resolveAgentPendingAction` / `checkAgentPendingActionResolution`. */
export function approvalAuthorizerFor(request: FastifyRequest, tenantDbName: string): ApprovalAuthorizer {
  return ({ conversation, action, approvers }) => askToApprove(request, {
    tenantDbName,
    conversation,
    raisedBy: [action.createdBy],
    approvers,
  });
}

/** The still-open requests of a session, with the people whose turn raised them. */
async function openRequests(tenantDbName: string, conversationId: string): Promise<Array<Pick<IAgentPendingAction, '_id' | 'createdBy'>>> {
  return runWithTenantDb(tenantDbName, (db) => db.listAgentPendingActions(conversationId, { status: 'pending' }));
}

/**
 * May the caller end the open requests of this session? Used where a request is cancelled as a side effect
 * (the cancel of a paused run, a new message under `cancel_pending`). Allowed, without asking, when the session
 * waits on nothing. `agent` is the agent whose "who can approve" setting applies (its live config).
 */
export async function authorizeEndingOpenRequests(
  request: FastifyRequest,
  input: {
    tenantDbName: string;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy' | 'runtimeStatus'>;
    agent?: (Pick<IAgent, '_id' | 'key'> & { config?: IAgentConfig }) | null;
  },
): Promise<ApprovalVerdict> {
  const { tenantDbName, conversation } = input;
  if (conversation.runtimeStatus !== 'requires_action') return { allowed: true };
  const open = await openRequests(tenantDbName, String(conversation._id));
  if (open.length === 0) return { allowed: true };
  const agent = input.agent !== undefined
    ? input.agent
    : await getAgentByKey(tenantDbName, conversation.agentKey, conversation.projectId);
  return askToApprove(request, {
    tenantDbName,
    conversation,
    raisedBy: open.map((action) => action.createdBy),
    approvers: resolveHitlConfig(agent?.config?.humanInTheLoop).approvers,
    agent: agent ?? null,
  });
}

/**
 * A new message to a session that waits on a request, under `onUserMessageWhilePending: 'cancel_pending'`,
 * cancels that request: it takes `agent.approve`. Null when the message may go ahead (the agent rejects instead
 * of cancelling - the 409 is the route's - or nothing is open, or the caller may answer).
 */
export async function refuseCancelPending(
  request: FastifyRequest,
  input: {
    tenantDbName: string;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy' | 'runtimeStatus'> | null | undefined;
    agent: Pick<IAgent, '_id' | 'key'> & { config?: IAgentConfig };
  },
): Promise<{ decisionId?: string } | null> {
  const { conversation, agent } = input;
  if (!conversation || conversation.runtimeStatus !== 'requires_action') return null;
  if (resolveHitlConfig(agent.config?.humanInTheLoop).onUserMessageWhilePending !== 'cancel_pending') return null;
  const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: input.tenantDbName, conversation, agent });
  return verdict.allowed ? null : { ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}) };
}

/** The message of the 403 for a caller who may not end somebody's open request. */
export const CANCEL_PENDING_FORBIDDEN_MESSAGE =
  'This session is waiting for an approval or an answer, and sending a message would cancel it. You are not allowed to answer it.';
