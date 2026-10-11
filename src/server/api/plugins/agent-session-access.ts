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
 * Before this module every route carried its own copy of the project / agent check
 * (about seventeen of them) and none looked at the owner. The loader does both, once:
 * a session of another project or agent answers `not_found`, so an id does not
 * confirm that something exists; one the caller may not touch answers `forbidden`,
 * with the engine's decision id (the audit row and the Access check replay it).
 * When the engine cannot decide the answer is `unavailable` (503, never an allow).
 *
 * The loader does not throw for any of those three: a route (dashboard or client API,
 * each catching its own errors in its own dialect) turns a refusal into a reply with
 * `sendSessionRefusal`, and a route that is built on thrown errors (the OpenAI /
 * Anthropic shaped ones) throws `sessionRefusalError`.
 *
 * A LIST cannot ask per row: `sessionListScope` decides once per request which agents'
 * sessions the caller sees in full and which only their own, and the database applies
 * that before it cuts the page (`ownOnly`).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAgent, IAgentConversation } from '@/lib/database';
import { agentSessionResource } from '@/lib/iam/agentEntities';
import { getAgentByKey, getConversationById, listAgents } from '@/lib/services/agents';
import { apiErrorBody } from '@/lib/services/agents/agentRunService';
import {
  authorizationRefusalOf,
  authorizeResourceForRequest,
  requireProjectContextForRequest,
  resourceRefusalError,
  sendProjectContextError,
} from '../fastify-utils';

export type SessionNeed = 'view' | 'manage';

const ACTION_OF_NEED = {
  view: 'agent.session_view_others',
  manage: 'agent.session_manage_others',
} as const;

const LEVEL_OF_NEED = { view: 'read', manage: 'write' } as const;

/** The 403 sentence for a session somebody else started. */
export const SESSION_FORBIDDEN_MESSAGE: Readonly<Record<SessionNeed, string>> = Object.freeze({
  view: 'This session was started by someone else, and you are not allowed to view it.',
  manage: 'This session was started by someone else, and you are not allowed to change it.',
});

/** Who the request acts for and where; the loaders read it from the request unless the caller already has it. */
export interface SessionActor {
  tenantDbName: string;
  projectId: string;
  userId: string;
}

export interface LoadSessionOptions {
  /** The caller's identity and project, when the route already resolved them (saves resolving them again). */
  actor?: SessionActor;
  /** A "no" shapes a screen rather than refuses a request: nothing is logged or audited. */
  quiet?: boolean;
  /** `view`: read it. `manage`: change it (continue, budget, files, delete, ...). */
  need: SessionNeed;
  /** The session must belong to this agent (the dashboard routes name one). */
  agentKey?: string;
  /** The agent, when the caller has it: saves the lookup of its registry id. */
  agent?: Pick<IAgent, '_id' | 'key'> | null;
  /** The project the session must belong to. Default: the one the request runs in. */
  projectId?: string;
  /** People besides the session's creator who count as its owner (the person whose turn raised a request). */
  alsoOwnedBy?: ReadonlyArray<string | null | undefined>;
}

/** Why a session could not be handed to the caller. */
export type SessionRefusal =
  | { ok: false; status: 404; reason: 'not_found' }
  | { ok: false; status: 403; reason: 'forbidden'; need: SessionNeed; decisionId?: string }
  | { ok: false; status: 503; reason: 'unavailable'; need: SessionNeed; decisionId?: string };

export type SessionGrant = {
  ok: true;
  /** The person the request acts for: the session user, or the token's owner. */
  userId: string;
  /** The caller started this session (no engine question was needed). */
  owner: boolean;
};

export type LoadedSession = (SessionGrant & { conversation: IAgentConversation }) | SessionRefusal;
export type SessionDecision = SessionGrant | Exclude<SessionRefusal, { status: 404 }>;

/** Who the request acts for and in which project: a token (its owner, its project) or the signed-in session. */
export async function sessionActorOf(request: FastifyRequest): Promise<SessionActor> {
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

/** Runs one engine question; an outage (the handler-level 503) is an answer here, not an exception. */
async function ask<T>(need: SessionNeed, run: () => Promise<T>): Promise<T | { unavailable: true; decisionId?: string; need: SessionNeed }> {
  try {
    return await run();
  } catch (error) {
    const refusal = authorizationRefusalOf(error);
    if (refusal?.status === 503) return { unavailable: true, need, ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}) };
    throw error;
  }
}

/**
 * May the caller touch this (already loaded, already in scope) session? The owner always may; anybody else
 * asks the engine (`need`). Nothing is loaded and no scope is checked - that is `loadSessionForPrincipal`'s.
 */
export async function decideSessionAccess(
  request: FastifyRequest,
  conversation: Pick<IAgentConversation, 'agentKey' | 'projectId' | 'createdBy'>,
  options: Pick<LoadSessionOptions, 'need' | 'agent' | 'alsoOwnedBy' | 'quiet' | 'actor'>,
): Promise<SessionDecision> {
  const actor = options.actor ?? await sessionActorOf(request);
  const owners = [String(conversation.createdBy ?? ''), ...(options.alsoOwnedBy ?? [])];
  // The person who started it needs nothing beyond the route's own service check.
  if (actor.userId && owners.some((id) => id === actor.userId)) return { ok: true, userId: actor.userId, owner: true };

  const answer = await ask(options.need, async () => authorizeResourceForRequest(request, {
    action: ACTION_OF_NEED[options.need],
    resource: agentSessionResource({
      id: await agentIdOf(actor.tenantDbName, conversation, options.agent),
      key: conversation.agentKey,
      projectId: conversation.projectId,
      ownerIds: owners,
    }),
    subject: { resourceName: conversation.agentKey },
    // The session is in the request's project (the caller checked): decide in exactly that one.
    projectId: conversation.projectId,
    ...(options.quiet ? { quiet: true } : {}),
  }));
  if ('unavailable' in answer) return { ok: false, status: 503, reason: 'unavailable', need: options.need, ...(answer.decisionId ? { decisionId: answer.decisionId } : {}) };
  if (!answer.allowed) {
    return { ok: false, status: 403, reason: 'forbidden', need: options.need, ...(answer.decisionId ? { decisionId: answer.decisionId } : {}) };
  }
  return { ok: true, userId: actor.userId, owner: false };
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
  const actor = options.actor ?? await sessionActorOf(request);
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
  const decision = await decideSessionAccess(request, conversation, { ...options, actor });
  return decision.ok ? { ...decision, conversation } : decision;
}

// ── lists ────────────────────────────────────────────────────────────────

/**
 * Does the caller see every session of this agent (`true`), or only the ones they started (`false`)? Asked of
 * the engine once per request, about the agent with no owner in particular - the answer for "a session
 * somebody else started". A "no" is not a refusal: nothing is logged or audited. Throws the 503 when the engine
 * cannot decide (a list is not an answer to build on that).
 */
export async function canViewOthersSessions(
  request: FastifyRequest,
  input: { agent: Pick<IAgent, '_id' | 'key'>; projectId?: string; actor?: SessionActor },
): Promise<boolean> {
  const actor = input.actor ?? await sessionActorOf(request);
  const projectId = input.projectId ?? actor.projectId;
  const result = await authorizeResourceForRequest(request, {
    action: ACTION_OF_NEED.view,
    resource: agentSessionResource({ id: String(input.agent._id ?? input.agent.key), key: input.agent.key, projectId, ownerIds: [] }),
    subject: { resourceName: input.agent.key },
    projectId,
    quiet: true,
  });
  return result.allowed;
}

/** Per request: the agents whose other-people's sessions the caller may not view (asked once per request). */
const restrictedByRequest = new WeakMap<FastifyRequest, Promise<string[]>>();

/** The keys of the project's agents whose sessions started by others the caller may NOT view. */
async function restrictedAgentKeys(request: FastifyRequest, projectId: string, known?: SessionActor): Promise<string[]> {
  const cached = restrictedByRequest.get(request);
  if (cached) return cached;
  const actor = known ?? await sessionActorOf(request);
  const loading = (async () => {
    const agents = await listAgents(actor.tenantDbName, { projectId });
    const denied: string[] = [];
    for (const agent of agents) {
      if (!(await canViewOthersSessions(request, { agent, projectId, actor }))) denied.push(agent.key);
    }
    return denied;
  })();
  restrictedByRequest.set(request, loading);
  return loading;
}

export interface SessionListScope {
  /** The caller; the rows they started are always theirs. */
  userId: string;
  /** What the database must apply before it cuts a page; absent = the caller sees everything. */
  ownOnly?: { userId: string; agentKeys?: string[] };
}

/**
 * What the caller may see in a LIST of sessions: everything (the default), or - for the agents whose other
 * people's sessions they may not view - only the ones they started. `agent` names the list's agent (one
 * decision); without it the project's agents are asked (cached for the request).
 */
export async function sessionListScope(
  request: FastifyRequest,
  input: { agent?: Pick<IAgent, '_id' | 'key'> | null; projectId?: string; actor?: SessionActor },
): Promise<SessionListScope> {
  const actor = input.actor ?? await sessionActorOf(request);
  const projectId = input.projectId ?? actor.projectId;
  if (input.agent) {
    return await canViewOthersSessions(request, { agent: input.agent, projectId, actor })
      ? { userId: actor.userId }
      : { userId: actor.userId, ownOnly: { userId: actor.userId } };
  }
  const denied = await restrictedAgentKeys(request, projectId, actor);
  return denied.length === 0
    ? { userId: actor.userId }
    : { userId: actor.userId, ownOnly: { userId: actor.userId, agentKeys: denied } };
}

// ── paths to the same transcript outside the session routes ───────────────

/**
 * Something that carries a session's content but is not a session route - a tracing thread (an agent's thread
 * IS its conversation: `threadId` = the conversation id), a file the session holds in a bucket (`purpose:
 * 'conversation'`) - names the session by id. Before it is read (`need: 'view'`) or changed (`'manage'`), ask
 * whether it is a session of this project the caller may touch; an id that is no session (any other producer's
 * thread id, an ordinary file) is not the session permission's business. Null when the caller may.
 */
export async function refuseSessionLinked(
  request: FastifyRequest,
  conversationId: string | null | undefined,
  need: SessionNeed,
  options: { actor?: SessionActor } = {},
): Promise<Exclude<SessionRefusal, { status: 404 }> | null> {
  if (!conversationId) return null;
  const actor = options.actor ?? await sessionActorOf(request);
  let conversation: IAgentConversation | null = null;
  try {
    conversation = await getConversationById(actor.tenantDbName, conversationId);
  } catch {
    conversation = null;
  }
  if (!conversation || conversation.projectId !== actor.projectId) return null;
  const decision = await decideSessionAccess(request, conversation, { need, actor });
  return decision.ok ? null : decision;
}

/** A tracing thread is read like the session it is. */
export function refuseTracingThread(
  request: FastifyRequest,
  threadId: string | null | undefined,
  options: { actor?: SessionActor } = {},
) {
  return refuseSessionLinked(request, threadId, 'view', options);
}

/**
 * Keeps the rows of a list (tracing threads and sessions, the files of a bucket) that are not somebody else's
 * agent sessions the caller may not view. `threadIdOf` reads the id of the session a row belongs to (null: none).
 * A caller who may view every agent's sessions (the default) costs no lookup at all.
 */
export async function filterSessionLinkedRows<T>(
  request: FastifyRequest,
  rows: readonly T[],
  threadIdOf: (row: T) => string | null | undefined,
  options: { actor?: SessionActor } = {},
): Promise<T[]> {
  const actor = options.actor ?? await sessionActorOf(request);
  const denied = new Set(await restrictedAgentKeys(request, actor.projectId, actor));
  if (denied.size === 0) return [...rows];
  const checks = await Promise.all(rows.map(async (row) => {
    const threadId = threadIdOf(row);
    if (!threadId) return true;
    let conversation: IAgentConversation | null = null;
    try {
      conversation = await getConversationById(actor.tenantDbName, threadId);
    } catch {
      conversation = null;
    }
    if (!conversation || conversation.projectId !== actor.projectId) return true;
    if (!denied.has(conversation.agentKey)) return true;
    return !!actor.userId && String(conversation.createdBy) === actor.userId;
  }));
  return rows.filter((_, index) => checks[index]);
}

// ── refusals ─────────────────────────────────────────────────────────────

/** The error a route built on thrown errors throws for a refusal (the gates' own shape: 403 with the decision id, or 503). */
export function sessionRefusalError(request: FastifyRequest, refusal: SessionRefusal): Error {
  if (refusal.status === 404) return Object.assign(new Error('Session not found'), { status: 404, code: 'session_not_found' });
  return resourceRefusalError(request, {
    action: ACTION_OF_NEED[refusal.need],
    level: LEVEL_OF_NEED[refusal.need],
    ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}),
    ...(refusal.status === 503 ? { unavailable: true } : { message: SESSION_FORBIDDEN_MESSAGE[refusal.need] }),
  });
}

/** The dashboard's reply to a refusal. */
export function sendSessionRefusal(reply: FastifyReply, request: FastifyRequest, refusal: SessionRefusal): FastifyReply {
  if (refusal.status === 404) return reply.code(404).send({ error: 'Session not found' });
  const answered = sendProjectContextError(reply, sessionRefusalError(request, refusal));
  return answered ?? reply.code(refusal.status).send({ error: SESSION_FORBIDDEN_MESSAGE[refusal.need] });
}

const CLIENT_UNAVAILABLE_MESSAGE = 'Authorization is temporarily unavailable';

/**
 * The reply to a handler-level decision the engine could not take (a resolve outcome `unavailable`, a side-effect
 * cancel): 503 with `Retry-After` and the decision id, audited by the response hook. The dashboard answers in its
 * own error shape, the client API in its envelope.
 */
export function sendAuthorizationUnavailable(
  reply: FastifyReply,
  request: FastifyRequest,
  dialect: 'dashboard' | 'client',
  input: { action: string; level: 'read' | 'write'; decisionId?: string },
): FastifyReply {
  const error = resourceRefusalError(request, { ...input, unavailable: true }) as Error & { headers?: Record<string, string>; body?: Record<string, unknown> };
  for (const [name, value] of Object.entries(error.headers ?? {})) void reply.header(name, value);
  const decisionId = typeof error.body?.decisionId === 'string' ? error.body.decisionId : input.decisionId;
  if (dialect === 'client') {
    return reply.code(503).send(apiErrorBody('api_error', CLIENT_UNAVAILABLE_MESSAGE, 'authorization_unavailable', decisionId ? { decision_id: decisionId } : undefined));
  }
  return reply.code(503).send(error.body ?? { error: CLIENT_UNAVAILABLE_MESSAGE, code: 'authorization_unavailable' });
}

/** The OpenAI-shaped routes' reply to a refusal (`{ error: { message, type, code } }`). */
export function sendOpenAiSessionRefusal(reply: FastifyReply, request: FastifyRequest, refusal: SessionRefusal): FastifyReply {
  if (refusal.status === 404) {
    return reply.code(404).send({ error: { message: 'Session not found', type: 'invalid_request_error', code: 'session_not_found' } });
  }
  const error = sessionRefusalError(request, refusal) as Error & { headers?: Record<string, string> };
  for (const [name, value] of Object.entries(error.headers ?? {})) void reply.header(name, value);
  const decision = refusal.decisionId ? { decision_id: refusal.decisionId } : {};
  if (refusal.status === 503) {
    return reply.code(503).send({ error: { message: CLIENT_UNAVAILABLE_MESSAGE, type: 'server_error', code: 'authorization_unavailable', ...decision } });
  }
  return reply.code(403).send({ error: { message: SESSION_FORBIDDEN_MESSAGE[refusal.need], type: 'permission_error', code: 'session_forbidden', ...decision } });
}

/** The client API's reply to a refusal, in its error envelope. */
export function sendClientSessionRefusal(reply: FastifyReply, request: FastifyRequest, refusal: SessionRefusal): FastifyReply {
  if (refusal.status === 404) return reply.code(404).send(apiErrorBody('not_found_error', 'Session not found', 'session_not_found'));
  // The error carries the audit mark (request.iamDenial) and the decision header; the body is the client envelope.
  const error = sessionRefusalError(request, refusal) as Error & { headers?: Record<string, string> };
  for (const [name, value] of Object.entries(error.headers ?? {})) void reply.header(name, value);
  const decision = refusal.decisionId ? { decision_id: refusal.decisionId } : undefined;
  if (refusal.status === 503) {
    return reply.code(503).send(apiErrorBody('api_error', CLIENT_UNAVAILABLE_MESSAGE, 'authorization_unavailable', decision));
  }
  return reply.code(403).send(apiErrorBody('permission_error', SESSION_FORBIDDEN_MESSAGE[refusal.need], 'session_forbidden', decision));
}
