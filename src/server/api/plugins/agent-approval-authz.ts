/**
 * Who may answer a pending request of an agent session - asked of the policy
 * engine, by the route that has the principal.
 *
 * A pending request is one of two things, and they are governed differently:
 *
 *   a TOOL APPROVAL     `agent.approve`: allow, deny, edit the arguments, remember the
 *                       approval for the session. APPOINTED: the managed rule names the
 *                       session's owner and whoever the agent's "who can approve" setting
 *                       accepts, and an allow rule of the workspace may appoint more people
 *                       (a compliance group); a deny rule narrows (managedPolicies.ts).
 *   a QUESTION          follows the ownership of the session, like any other action on it:
 *                       the person who started it may always answer; anybody else needs
 *                       `agent.session_manage_others` (agent-session-access.ts). An answer
 *                       is not an approval, so restricting approvals never stops an owner
 *                       from answering their own session's questions.
 *
 * The service layer (agentActionResolution.ts) has no principal: it takes ids and a
 * user id. A route therefore hands it an `ApprovalAuthorizer`, built here, that asks
 * the engine with the very principal the route gate used (the person or the token's
 * owner, the project narrowing, the token's scope as a cap).
 *
 * The same question guards the places where a request is ENDED as a side effect: the
 * cancel of a run that is paused on an approval, and a new message under
 * `onUserMessageWhilePending: 'cancel_pending'`. Ending somebody's open approval is
 * answering it with "no", so it takes `agent.approve`; an open QUESTION is the
 * session's, which the caller already holds the rights to by getting that far. The
 * timeout sweep and the continuation that follows it are the system's, outside the
 * engine, and audited as `system` (agentActionResolution.ts).
 *
 * A refusal resolves `{ allowed: false, decisionId }` (the route's 403 names the
 * decision); when the engine cannot decide the verdict says `unavailable` and the route
 * answers 503 - an outage is never read as an answer, and never as a "no" either.
 *
 * `describeAnswerAbility` is the other direction: for a session's open requests it says
 * whether THIS caller could answer each - quietly (no refusal is logged or audited, it
 * shapes a screen) - so the UI shows what the server will decide instead of guessing.
 */

import type { FastifyRequest } from 'fastify';
import type { IAgent, IAgentConfig, IAgentConversation, IAgentPendingAction } from '@/lib/database';
import { agentSessionResource } from '@/lib/iam/agentEntities';
import { getAgentByKey } from '@/lib/services/agents';
import {
  hitlSettingsFor,
  type ApprovalAuthorizer,
  type ApprovalVerdict,
} from '@/lib/services/agents/agentActionResolution';
import { resolveHitlConfig, type ResolvedHitlConfig } from '@/lib/services/agents/agentHumanInTheLoop';
import { runWithTenantDb } from '@/lib/services/agents/agentRunService';
import { restrictedKnowledgeTagsOf } from '@/lib/services/rag/access/exposure';
import { authorizationRefusalOf, authorizeResourceForRequest } from '../fastify-utils';
import { restrictedKnowledgeReaderFor } from '../restrictedKnowledgeRequest';
import { SESSION_RESTRICTED_MESSAGE, decideSessionAccess, sessionActorOf, type SessionActor } from './agent-session-access';

interface ApprovalQuestion {
  tenantDbName: string;
  conversation: Pick<IAgentConversation, 'agentKey' | 'projectId' | 'createdBy' | 'kbRestricted'>;
  /** The people whose turn raised the open requests (`action.createdBy`), besides the session's own creator. */
  raisedBy?: ReadonlyArray<string | null | undefined>;
  approvers: ResolvedHitlConfig['approvers'];
  /** The agent, when the caller has it; read by key otherwise (a deleted agent is asked about by its key). */
  agent?: Pick<IAgent, '_id' | 'key'> | null;
  /** A "no" shapes a screen rather than refuses a request (nothing is logged or audited). */
  quiet?: boolean;
  /** The caller's identity and project, when the route already resolved them. */
  actor?: SessionActor;
}

/** The registry id of the agent: what `agent.get` and a rule that names one agent are about. A deleted agent stands in as its key. */
async function agentResourceId(question: ApprovalQuestion): Promise<string> {
  const { conversation } = question;
  const agent = question.agent !== undefined
    ? question.agent
    : await getAgentByKey(question.tenantDbName, conversation.agentKey, conversation.projectId);
  return agent?._id ? String(agent._id) : conversation.agentKey;
}

/**
 * A session that holds passages not everyone may read: the run goes on and its reply comes back to whoever answers,
 * so only its owner (and the people whose turn raised the request) and the administrators of every knowledge base
 * the passages came from may answer. Null when that is not what stops the caller.
 */
async function restrictedRefusal(request: FastifyRequest, question: ApprovalQuestion): Promise<(ApprovalVerdict & { restricted?: true }) | null> {
  const { conversation } = question;
  if (restrictedKnowledgeTagsOf(conversation.kbRestricted).length === 0) return null;
  try {
    const actor = question.actor ?? await sessionActorOf(request);
    const mayRead = await restrictedKnowledgeReaderFor(request, { tenantDbName: question.tenantDbName, viewerUserId: actor.userId })
      .mayRead(conversation.kbRestricted, [conversation.createdBy, ...(question.raisedBy ?? [])]);
    return mayRead ? null : { allowed: false, restricted: true, message: SESSION_RESTRICTED_MESSAGE };
  } catch (error) {
    const refusal = authorizationRefusalOf(error);
    if (refusal?.status !== 503) throw error;
    return { allowed: false, unavailable: true, ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}) };
  }
}

/** The engine's answer to "may this caller approve?", as a verdict - an outage is `unavailable`, not an exception. */
async function askToApprove(request: FastifyRequest, question: ApprovalQuestion): Promise<ApprovalVerdict & { policyIds?: string[]; restricted?: true }> {
  const { conversation } = question;
  const restricted = await restrictedRefusal(request, question);
  if (restricted) return restricted;
  try {
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
      ...(question.quiet ? { quiet: true } : {}),
    });
    return result.allowed
      ? { allowed: true }
      : { allowed: false, ...(result.decisionId ? { decisionId: result.decisionId } : {}), policyIds: result.policyIds };
  } catch (error) {
    const refusal = authorizationRefusalOf(error);
    if (refusal?.status !== 503) throw error;
    return { allowed: false, unavailable: true, ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}) };
  }
}

/**
 * Answering a QUESTION is acting on the session: its owner always may, anybody else needs
 * `agent.session_manage_others` - and `agent.session_view_others`, since the run goes on and its reply comes back to the answerer.
 */
async function askToAnswer(request: FastifyRequest, question: ApprovalQuestion): Promise<ApprovalVerdict & { restricted?: true }> {
  const decision = await decideSessionAccess(request, question.conversation, {
    need: 'continue',
    agent: question.agent,
    alsoOwnedBy: question.raisedBy,
    ...(question.quiet ? { quiet: true } : {}),
    ...(question.actor ? { actor: question.actor } : {}),
  });
  if (decision.ok) return { allowed: true };
  if (decision.status === 503) return { allowed: false, unavailable: true, ...(decision.decisionId ? { decisionId: decision.decisionId } : {}) };
  if (decision.reason === 'restricted') return { allowed: false, restricted: true, message: SESSION_RESTRICTED_MESSAGE };
  return {
    allowed: false,
    message: 'This question was asked in a session somebody else started, and you are not allowed to answer it.',
    ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
  };
}

/** The authorizer a route hands to `resolveAgentPendingAction` / `checkAgentPendingActionResolution`. */
export function approvalAuthorizerFor(request: FastifyRequest, tenantDbName: string): ApprovalAuthorizer {
  return ({ conversation, action, approvers }) => {
    const question: ApprovalQuestion = { tenantDbName, conversation, raisedBy: [action.createdBy], approvers };
    return action.kind === 'user_question' ? askToAnswer(request, question) : askToApprove(request, question);
  };
}

// ── what the caller could do (shapes a screen) ───────────────────────────

/** Why a caller cannot answer an open request - the UI words each one (and may name the agent's setting). */
export type AnswerBlockedReason =
  /** Only the person who started the session may approve (the agent's setting). */
  | 'approvers_owner'
  /** The session's owner, workspace owners / admins and the project's admins may approve (the default setting). */
  | 'approvers_admin'
  /** Every member of the project may approve, and the caller is not one. */
  | 'approvers_member'
  /** A question: only the session's owner, and the people allowed to view and act on others' sessions, may answer it. */
  | 'session_owner'
  /** A rule of the workspace stops the caller. */
  | 'policy'
  /** The session holds passages not everyone may read: only its owner and those knowledge bases' administrators answer. */
  | 'restricted'
  /** The engine could not decide right now. */
  | 'unavailable';

export interface AnswerAbility {
  /** May this caller answer the request? */
  canResolve: boolean;
  /** Why not (absent when they can). */
  reason?: AnswerBlockedReason;
}

const REASON_OF_APPROVERS: Record<ResolvedHitlConfig['approvers'], AnswerBlockedReason> = {
  owner: 'approvers_owner',
  owner_or_admin: 'approvers_admin',
  project_members: 'approvers_member',
};

/**
 * Whether this caller could answer each of the session's open requests, decided by the same engine questions
 * the resolve route asks (one per distinct "who raised it" / setting pair, not per row) and asked quietly.
 * Resolved requests are not asked about: nothing is left to answer.
 */
export async function describeAnswerAbility(
  request: FastifyRequest,
  input: {
    tenantDbName: string;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy' | 'kbRestricted'>;
    actions: ReadonlyArray<Pick<IAgentPendingAction, '_id' | 'kind' | 'status' | 'createdBy' | 'agentKey' | 'projectId' | 'agentVersion'>>;
    agent?: Pick<IAgent, '_id' | 'key'> | null;
    /** The caller's identity and project, when the route already resolved them (saves resolving them per request). */
    actor?: SessionActor;
  },
): Promise<Map<string, AnswerAbility>> {
  const { tenantDbName, conversation } = input;
  const out = new Map<string, AnswerAbility>();
  const open = input.actions.filter((action) => action.status === 'pending');
  if (open.length === 0) return out;

  const actor = input.actor ?? await sessionActorOf(request);
  const cache = new Map<string, AnswerAbility>();
  for (const action of open) {
    const approvers = action.kind === 'tool_approval'
      ? (await runWithTenantDb(tenantDbName, (db) => hitlSettingsFor(db, action as IAgentPendingAction))).approvers
      : resolveHitlConfig(undefined).approvers;
    const key = `${action.kind}|${action.createdBy ?? ''}|${approvers}`;
    let ability = cache.get(key);
    if (!ability) {
      ability = await abilityOf(request, actor.userId, { tenantDbName, conversation, action, approvers, agent: input.agent, actor });
      cache.set(key, ability);
    }
    out.set(String(action._id), ability);
  }
  return out;
}

async function abilityOf(
  request: FastifyRequest,
  userId: string,
  input: {
    tenantDbName: string;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy' | 'kbRestricted'>;
    action: Pick<IAgentPendingAction, 'kind' | 'createdBy'>;
    approvers: ResolvedHitlConfig['approvers'];
    agent?: Pick<IAgent, '_id' | 'key'> | null;
    actor?: SessionActor;
  },
): Promise<AnswerAbility> {
  const { conversation, action, approvers } = input;
  const question: ApprovalQuestion = {
    tenantDbName: input.tenantDbName,
    conversation,
    raisedBy: [action.createdBy],
    approvers,
    agent: input.agent,
    quiet: true,
    ...(input.actor ? { actor: input.actor } : {}),
  };
  if (action.kind === 'user_question') {
    const owns = !!userId && [String(conversation.createdBy ?? ''), action.createdBy].some((id) => id === userId);
    if (owns) return { canResolve: true };
    const verdict = await askToAnswer(request, question);
    if (verdict.allowed) return { canResolve: true };
    return { canResolve: false, reason: verdict.unavailable ? 'unavailable' : verdict.restricted ? 'restricted' : 'session_owner' };
  }
  const verdict = await askToApprove(request, question);
  if (verdict.allowed) return { canResolve: true };
  if (verdict.unavailable) return { canResolve: false, reason: 'unavailable' };
  if (verdict.restricted) return { canResolve: false, reason: 'restricted' };
  // A rule of the workspace blocked them (a deny rule names itself); otherwise nothing appointed them.
  const policy = (verdict as { policyIds?: string[] }).policyIds ?? [];
  return { canResolve: false, reason: policy.length > 0 ? 'policy' : REASON_OF_APPROVERS[approvers] };
}

/** The public shape of a request plus what this caller may do with it (dashboard `GET …/actions`, session rows). */
export function withAnswerAbility<T extends { id: string }>(
  actions: readonly T[],
  ability: ReadonlyMap<string, AnswerAbility>,
): Array<T & { canResolve?: boolean; resolveBlockedReason?: AnswerBlockedReason }> {
  return actions.map((action) => {
    const found = ability.get(action.id);
    if (!found) return action;
    return { ...action, canResolve: found.canResolve, ...(found.reason ? { resolveBlockedReason: found.reason } : {}) };
  });
}

// ── ending a request as a side effect ────────────────────────────────────

/** The still-open requests of a session, with the people whose turn raised them. */
async function openRequests(
  tenantDbName: string,
  conversationId: string,
): Promise<Array<Pick<IAgentPendingAction, '_id' | 'createdBy' | 'kind'>>> {
  return runWithTenantDb(tenantDbName, (db) => db.listAgentPendingActions(conversationId, { status: 'pending' }));
}

/**
 * May the caller end the open requests of this session? Used where a request is cancelled as a side effect
 * (the cancel of a paused run, a new message under `cancel_pending`). Allowed, without asking, when the session
 * waits on nothing - or on questions only, which are the session's (the caller already holds the rights to act
 * on it). Open tool approvals take `agent.approve`. `agent` is the agent whose "who can approve" setting
 * applies (its live config).
 */
export async function authorizeEndingOpenRequests(
  request: FastifyRequest,
  input: {
    tenantDbName: string;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy' | 'runtimeStatus' | 'kbRestricted'>;
    agent?: (Pick<IAgent, '_id' | 'key'> & { config?: IAgentConfig }) | null;
  },
): Promise<ApprovalVerdict> {
  const { tenantDbName, conversation } = input;
  if (conversation.runtimeStatus !== 'requires_action') return { allowed: true };
  const open = (await openRequests(tenantDbName, String(conversation._id))).filter((action) => action.kind === 'tool_approval');
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
 * cancels that request: for an open tool approval it takes `agent.approve`. Null when the message may go ahead
 * (the agent rejects instead of cancelling - the 409 is the route's - or nothing is open, or the caller may
 * answer). `unavailable`: the engine could not decide (the route answers 503).
 */
export async function refuseCancelPending(
  request: FastifyRequest,
  input: {
    tenantDbName: string;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy' | 'runtimeStatus' | 'kbRestricted'> | null | undefined;
    agent: Pick<IAgent, '_id' | 'key'> & { config?: IAgentConfig };
  },
): Promise<{ decisionId?: string; unavailable?: boolean } | null> {
  const { conversation, agent } = input;
  if (!conversation || conversation.runtimeStatus !== 'requires_action') return null;
  if (resolveHitlConfig(agent.config?.humanInTheLoop).onUserMessageWhilePending !== 'cancel_pending') return null;
  const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: input.tenantDbName, conversation, agent });
  if (verdict.allowed) return null;
  return {
    ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}),
    ...(verdict.unavailable ? { unavailable: true } : {}),
  };
}

/** The message of the 403 for a caller who may not end somebody's open request. */
export const CANCEL_PENDING_FORBIDDEN_MESSAGE =
  'This session is waiting for an approval or an answer, and sending a message would cancel it. You are not allowed to answer it.';

