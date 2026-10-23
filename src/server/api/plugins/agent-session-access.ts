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
 *   need 'continue' a new turn in the session: `agent.session_manage_others` AND
 *                   `agent.session_view_others`. The turn is answered by a model that has
 *                   read everything the session holds, and the answer goes to the sender,
 *                   so a rule that stops somebody viewing a session also stops them
 *                   talking into it. The other changes (budget, files, delete) hand nothing
 *                   of the transcript back and stay a matter of `manage` alone.
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
 * that before it cuts the page (`ownOnly`). The scope is an ALLOW list - the agents whose
 * other people's sessions the caller may view - so a session whose agent no longer exists
 * (a deleted agent keeps its sessions) is somebody else's like any other as soon as a
 * restriction is in force.
 *
 * A lookup that FAILS (the store is down, as opposed to the id naming no session) is never
 * read as "not a session, so allowed": the single-session paths answer 503, a list fails
 * its request with the same 503.
 */

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAgent, IAgentConversation } from '@/lib/database';
import { agentSessionResource } from '@/lib/iam/agentEntities';
import { describeTenantPolicySet } from '@/lib/iam/engine';
import { getAgentByKey, getConversationById, listAgents } from '@/lib/services/agents';
import { apiErrorBody } from '@/lib/services/agents/agentRunService';
import {
  authorizationRefusalOf,
  authorizeResourceForRequest,
  refreshRequestPrincipal,
  requireProjectContextForRequest,
  resourceRefusalError,
  sendProjectContextError,
  serviceLevelForRequest,
} from '../fastify-utils';

const logger = createLogger('api:agent-session-access');

/** What the engine is asked about a session somebody else started (one action each). */
export type SessionAction = 'view' | 'manage';
/** What a request needs: one action, or (`continue`, a new turn) both of them - see the module comment. */
export type SessionNeed = SessionAction | 'continue';

const ACTION_OF_NEED = {
  view: 'agent.session_view_others',
  manage: 'agent.session_manage_others',
} as const;

const LEVEL_OF_NEED = { view: 'read', manage: 'write' } as const;

/** The 403 sentence for a session somebody else started. */
export const SESSION_FORBIDDEN_MESSAGE: Readonly<Record<SessionAction, string>> = Object.freeze({
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
  | { ok: false; status: 403; reason: 'forbidden'; need: SessionAction; decisionId?: string }
  | { ok: false; status: 503; reason: 'unavailable'; need: SessionAction; decisionId?: string };

export type SessionGrant = {
  ok: true;
  /** The person the request acts for: the session user, or the token's owner. */
  userId: string;
  /** The caller started this session (no engine question was needed). */
  owner: boolean;
};

export type LoadedSession = (SessionGrant & { conversation: IAgentConversation }) | SessionRefusal;
export type SessionDecision = SessionGrant | Exclude<SessionRefusal, { status: 404 }>;

/** The answer when the store could not be asked who a session belongs to: unavailable (503), never an allow. */
function lookupFailed(need: SessionNeed, conversationId: string | null | undefined, error: unknown): Extract<SessionRefusal, { status: 503 }> {
  logger.warn('Could not read a session to decide access', {
    conversationId,
    error: error instanceof Error ? error.message : String(error),
  });
  return { ok: false, status: 503, reason: 'unavailable', need: need === 'view' ? 'view' : 'manage' };
}

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
async function ask<T>(need: SessionAction, run: () => Promise<T>): Promise<T | { unavailable: true; decisionId?: string; need: SessionAction }> {
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

  const agentId = await agentIdOf(actor.tenantDbName, conversation, options.agent);
  /** One engine question; null when the answer is yes. */
  const decide = async (action: SessionAction): Promise<Exclude<SessionDecision, { ok: true }> | null> => {
    const answer = await ask(action, async () => authorizeResourceForRequest(request, {
      action: ACTION_OF_NEED[action],
      resource: agentSessionResource({
        id: agentId,
        key: conversation.agentKey,
        projectId: conversation.projectId,
        ownerIds: owners,
      }),
      subject: { resourceName: conversation.agentKey },
      // The session is in the request's project (the caller checked): decide in exactly that one.
      projectId: conversation.projectId,
      ...(options.quiet ? { quiet: true } : {}),
    }));
    if ('unavailable' in answer) return { ok: false, status: 503, reason: 'unavailable', need: action, ...(answer.decisionId ? { decisionId: answer.decisionId } : {}) };
    if (!answer.allowed) {
      return { ok: false, status: 403, reason: 'forbidden', need: action, ...(answer.decisionId ? { decisionId: answer.decisionId } : {}) };
    }
    return null;
  };

  const refused = await decide(options.need === 'view' ? 'view' : 'manage');
  if (refused) return refused;
  // A new turn is also read back to the sender: somebody a rule stops from viewing the session is stopped here, as such.
  if (options.need === 'continue') {
    const mayNotView = await decide('view');
    if (mayNotView) return mayNotView;
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
  } catch (error) {
    // An id that names no conversation is a clean "not found" from the store; this is the store failing. Not a 404
    // (the session may well exist) and never an allow.
    return lookupFailed(options.need, conversationId, error);
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

/**
 * Is the viewer of an open event stream still allowed to watch it? The route's checks ran once, when the stream
 * opened; this asks them again - the caller's standing in the project and on `agents` (a removed membership, a
 * lowered role, a revoked token), then the session itself (`loadSessionForPrincipal`, so a rule written since is
 * seen) - against what is stored NOW. Anything that goes wrong is a "no": not knowing is not an allow.
 */
export async function sessionStreamStillAllowed(
  request: FastifyRequest,
  conversationId: string,
  options: Omit<LoadSessionOptions, 'need' | 'quiet'> = {},
): Promise<boolean> {
  try {
    await refreshRequestPrincipal(request);
    const actor = options.actor ?? await sessionActorOf(request);
    const projectId = options.projectId ?? actor.projectId;
    if ((await serviceLevelForRequest(request, 'agents', { projectId })) === 'none') return false;
    const loaded = await loadSessionForPrincipal(request, conversationId, { ...options, actor, projectId, need: 'view' });
    return loaded.ok;
  } catch {
    return false;
  }
}

// ── what the caller may view, per agent ──────────────────────────────────

/** What the caller may view of other people's sessions, agent by agent. */
interface AgentViewScope {
  /** Some agent's other-people's sessions are off limits to the caller; false = they see every session. */
  restricted: boolean;
  /** The agents (keys) whose other-people's sessions the caller may view. Meaningful only when `restricted`. */
  viewable: string[];
}

/** The scope is decided once per request... */
const viewScopeByRequest = new WeakMap<FastifyRequest, Promise<AgentViewScope>>();
/**
 * ...and, when custom rules make that a question per agent, kept for a few seconds across requests (the same person, the
 * same rules, the same policy version). A change of the person's role or groups is seen after those seconds, and an agent
 * created in them is treated, for that long, like one whose sessions the caller may not view.
 */
const viewScopeCache = new Map<string, { expiresAt: number; scope: AgentViewScope }>();
export const VIEW_SCOPE_CACHE_TTL_MS = 5_000;
const VIEW_SCOPE_CACHE_MAX = 500;

/** The key an agent that no longer exists is asked about: only a rule that covers every agent (not one that names an id) can match it. */
const DELETED_AGENT_KEY = '(deleted agent)';

/** Test seam. */
export function resetSessionAccessCachesForTests(): void {
  viewScopeCache.clear();
}

/** An engine (or a store) that could not answer a list's question: the 503 the gates use, never "nothing is restricted". */
function listUnavailable(request: FastifyRequest, projectId: string | null, why: string, error: unknown): Error {
  logger.warn(why, { error: error instanceof Error ? error.message : String(error) });
  return resourceRefusalError(request, { action: ACTION_OF_NEED.view, level: 'read', unavailable: true, projectId });
}

function scopeCacheKey(request: FastifyRequest, actor: SessionActor, projectId: string, policy: { setId: string; version: number }): string {
  const token = request.apiTokenContext;
  const who = token
    ? `token:${String(token.tokenRecord._id ?? '')}:${createHash('sha1').update(JSON.stringify(token.tokenRecord.servicePermissions ?? null)).digest('hex')}`
    : 'session';
  return [actor.tenantDbName, policy.setId, policy.version, actor.userId, who, projectId].join('|');
}

async function computeViewScope(request: FastifyRequest, projectId: string, actor: SessionActor): Promise<AgentViewScope> {
  let policy: Awaited<ReturnType<typeof describeTenantPolicySet>>;
  try {
    policy = await describeTenantPolicySet(actor.tenantDbName);
  } catch (error) {
    throw listUnavailable(request, projectId, 'Could not load the policy set to scope a list of sessions', error);
  }

  // No custom rule in force: the managed rules alone decide, and `agent.session_view_others` sits in the Read
  // group - the caller holds it for every agent exactly when they hold `agents` at Read or above (the token's
  // scope and the project's limits included, as the engine builds them). No question per agent.
  if (policy.custom === 0) {
    const level = await serviceLevelForRequest(request, 'agents', { projectId });
    return level === 'none' ? { restricted: true, viewable: [] } : { restricted: false, viewable: [] };
  }

  const key = scopeCacheKey(request, actor, projectId, policy);
  const hit = viewScopeCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.scope;

  const agents = await listAgents(actor.tenantDbName, { projectId });
  const viewable: string[] = [];
  let denied = 0;
  for (const agent of agents) {
    if (await canViewOthersSessions(request, { agent, projectId, actor })) viewable.push(agent.key);
    else denied += 1;
  }
  // A session whose agent was deleted stays in the store: one question stands for all of them.
  const ghostsViewable = await canViewOthersSessions(request, { agent: { _id: DELETED_AGENT_KEY, key: DELETED_AGENT_KEY }, projectId, actor });
  const scope: AgentViewScope = { restricted: denied > 0 || !ghostsViewable, viewable };

  if (viewScopeCache.size >= VIEW_SCOPE_CACHE_MAX) {
    const oldest = viewScopeCache.keys().next().value as string | undefined;
    if (oldest !== undefined) viewScopeCache.delete(oldest);
  }
  viewScopeCache.set(key, { expiresAt: Date.now() + VIEW_SCOPE_CACHE_TTL_MS, scope });
  return scope;
}

/** The caller's view scope for this request (asked once per request). Throws the 503 when the engine cannot decide. */
function agentViewScope(request: FastifyRequest, projectId: string, actor: SessionActor): Promise<AgentViewScope> {
  const cached = viewScopeByRequest.get(request);
  if (cached) return cached;
  const loading = computeViewScope(request, projectId, actor);
  viewScopeByRequest.set(request, loading);
  return loading;
}

export interface SessionListScope {
  /** The caller; the rows they started are always theirs. */
  userId: string;
  /** What the database must apply before it cuts a page; absent = the caller sees everything. */
  ownOnly?: { userId: string; viewableAgentKeys?: string[] };
}

/**
 * What the caller may see in a LIST of sessions: everything (the default), or - when they may not view other
 * people's sessions of some agent - only the ones they started plus every session of the agents they may view
 * (`viewableAgentKeys`; a session of an agent that no longer exists is never in it). `agent` names the list's
 * agent (one decision); without it the project's agents are asked (cached for the request).
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
  const scope = await agentViewScope(request, projectId, actor);
  return scope.restricted
    ? { userId: actor.userId, ownOnly: { userId: actor.userId, viewableAgentKeys: scope.viewable } }
    : { userId: actor.userId };
}

// ── paths to the same transcript outside the session routes ───────────────

/**
 * Something that carries a session's content but is not a session route - a tracing thread (an agent's thread
 * IS its conversation: `threadId` = the conversation id), a file the session holds in a bucket (`purpose:
 * 'conversation'`) - names the session by id. Before it is read (`need: 'view'`) or changed (`'manage'`), ask
 * whether it is a session of this project the caller may touch; an id that is no session (any other producer's
 * thread id, an ordinary file) is not the session permission's business. Null when the caller may. A store that
 * cannot say whether the id is a session answers `unavailable` (503), not "no session".
 */
export async function refuseSessionLinked(
  request: FastifyRequest,
  conversationId: string | null | undefined,
  need: SessionNeed,
  options: { actor?: SessionActor; alsoOwnedBy?: ReadonlyArray<string | null | undefined> } = {},
): Promise<Exclude<SessionRefusal, { status: 404 }> | null> {
  if (!conversationId) return null;
  const actor = options.actor ?? await sessionActorOf(request);
  let conversation: IAgentConversation | null = null;
  try {
    conversation = await getConversationById(actor.tenantDbName, conversationId);
  } catch (error) {
    return lookupFailed(need, conversationId, error);
  }
  if (!conversation || conversation.projectId !== actor.projectId) return null;
  const decision = await decideSessionAccess(request, conversation, {
    need,
    actor,
    ...(options.alsoOwnedBy ? { alsoOwnedBy: options.alsoOwnedBy } : {}),
  });
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

/** The conversations the rows of this request name, each read once. */
const conversationsByRequest = new WeakMap<FastifyRequest, Map<string, Promise<IAgentConversation | null>>>();

function conversationOnce(request: FastifyRequest, tenantDbName: string, conversationId: string): Promise<IAgentConversation | null> {
  let reads = conversationsByRequest.get(request);
  if (!reads) {
    reads = new Map();
    conversationsByRequest.set(request, reads);
  }
  let read = reads.get(conversationId);
  if (!read) {
    read = getConversationById(tenantDbName, conversationId);
    reads.set(conversationId, read);
  }
  return read;
}

/** For each row: may a restricted caller see it? (A row that names no session of this project is not the permission's business.) */
async function visibleFlags<T>(
  request: FastifyRequest,
  scope: AgentViewScope,
  actor: SessionActor,
  rows: readonly T[],
  threadIdOf: (row: T) => string | null | undefined,
): Promise<boolean[]> {
  const viewable = new Set(scope.viewable);
  return Promise.all(rows.map(async (row) => {
    const threadId = threadIdOf(row);
    if (!threadId) return true;
    let conversation: IAgentConversation | null;
    try {
      conversation = await conversationOnce(request, actor.tenantDbName, threadId);
    } catch (error) {
      // Not knowing whose a row is does not make it the caller's: the request fails.
      throw listUnavailable(request, actor.projectId, 'Could not read a session to filter a list', error);
    }
    if (!conversation || conversation.projectId !== actor.projectId) return true;
    if (viewable.has(conversation.agentKey)) return true;
    return !!actor.userId && String(conversation.createdBy) === actor.userId;
  }));
}

/**
 * Keeps the rows of a list (tracing threads and sessions, the files of a bucket) that are not somebody else's
 * agent sessions the caller may not view. `threadIdOf` reads the id of the session a row belongs to (null: none).
 * A caller who may view every agent's sessions (the default) costs no lookup at all. A page filtered this way
 * can come out short: a list that pages should use `pageOfVisibleRows`.
 */
export async function filterSessionLinkedRows<T>(
  request: FastifyRequest,
  rows: readonly T[],
  threadIdOf: (row: T) => string | null | undefined,
  options: { actor?: SessionActor } = {},
): Promise<T[]> {
  const actor = options.actor ?? await sessionActorOf(request);
  const scope = await agentViewScope(request, actor.projectId, actor);
  if (!scope.restricted) return [...rows];
  const flags = await visibleFlags(request, scope, actor, rows, threadIdOf);
  return rows.filter((_, index) => flags[index]);
}

/** `?skip=&limit=` of an offset-paged list as whole numbers (`defaultLimit` and 0 when absent or not a number). */
export function offsetPageOf(query: { skip?: string; limit?: string }, defaultLimit = 50): { skip: number; limit: number } {
  const limit = Number.parseInt(query.limit ?? '', 10);
  const skip = Number.parseInt(query.skip ?? '', 10);
  return {
    limit: Number.isInteger(limit) && limit >= 0 ? limit : defaultLimit,
    skip: Number.isInteger(skip) && skip > 0 ? skip : 0,
  };
}

/** The most pages one restricted request reads to fill a page; past it the page is returned short, with where to go on from. */
export const VISIBLE_PAGE_MAX_ROUNDS = 20;

/** One read of the unfiltered list: its rows, and the position after the first `consumed` of them (null = the list ends there). */
export interface UnfilteredPage<T, P> {
  rows: T[];
  after: (consumed: number) => P | null;
}

/**
 * One page of a list whose rows may be somebody else's agent sessions, filled to `limit` visible rows.
 *
 * The default caller (who may view every session) gets exactly one read, unfiltered, and the caller keeps its
 * own total. A restricted caller's rows are filtered AFTER the read, so a single read can come back short or
 * empty while the list goes on: this reads on - at most `VISIBLE_PAGE_MAX_ROUNDS` times - from where the
 * previous read ended until the page is full or the list ends, and says where the next page starts (`next`,
 * null = nothing more). Their count is not knowable without reading everything, so none is reported.
 *
 * `fetchPage(position, size)` reads the unfiltered list from `position` (the list's own idea of one: an offset, a
 * cursor); `minBatch` is the least it is asked for (a cursor can only continue after a whole read, so it asks for
 * exactly what is missing; an offset can be cut anywhere and reads more to need fewer rounds).
 */
export async function pageOfVisibleRows<T, P>(
  request: FastifyRequest,
  input: {
    start: P;
    limit: number;
    minBatch?: number;
    threadIdOf: (row: T) => string | null | undefined;
    fetchPage: (position: P, size: number) => Promise<UnfilteredPage<T, P>>;
    actor?: SessionActor;
  },
): Promise<{ restricted: false; rows: T[]; next: P | null } | { restricted: true; rows: T[]; next: P | null }> {
  const actor = input.actor ?? await sessionActorOf(request);
  const scope = await agentViewScope(request, actor.projectId, actor);
  if (!scope.restricted) {
    const page = await input.fetchPage(input.start, input.limit);
    return { restricted: false, rows: page.rows, next: page.after(page.rows.length) };
  }

  const out: T[] = [];
  let position: P | null = input.start;
  for (let round = 0; round < VISIBLE_PAGE_MAX_ROUNDS && position !== null && out.length < input.limit; round += 1) {
    const page: UnfilteredPage<T, P> = await input.fetchPage(position, Math.max(input.limit - out.length, input.minBatch ?? 1));
    const flags = await visibleFlags(request, scope, actor, page.rows, input.threadIdOf);
    let consumed = page.rows.length;
    for (let index = 0; index < page.rows.length; index += 1) {
      if (!flags[index]) continue;
      out.push(page.rows[index]);
      if (out.length >= input.limit) {
        consumed = index + 1;
        break;
      }
    }
    // A read that returned nothing ends the list, whatever the source says (no endless loop on a source that never does).
    position = page.rows.length === 0 ? null : page.after(consumed);
  }
  return { restricted: true, rows: out, next: position };
}

// ── refusals ─────────────────────────────────────────────────────────────

/**
 * The error a route built on thrown errors throws for a refusal (the gates' own shape: 403 with the decision id, or
 * 503). `message` replaces the sentence of a 403 for a route whose request touches several sessions at once.
 */
export function sessionRefusalError(request: FastifyRequest, refusal: SessionRefusal, options: { message?: string } = {}): Error {
  if (refusal.status === 404) return Object.assign(new Error('Session not found'), { status: 404, code: 'session_not_found' });
  return resourceRefusalError(request, {
    action: ACTION_OF_NEED[refusal.need],
    level: LEVEL_OF_NEED[refusal.need],
    ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}),
    ...(refusal.status === 503 ? { unavailable: true } : { message: options.message ?? SESSION_FORBIDDEN_MESSAGE[refusal.need] }),
  });
}

/** The dashboard's reply to a refusal. */
export function sendSessionRefusal(
  reply: FastifyReply,
  request: FastifyRequest,
  refusal: SessionRefusal,
  options: { message?: string } = {},
): FastifyReply {
  if (refusal.status === 404) return reply.code(404).send({ error: 'Session not found' });
  const answered = sendProjectContextError(reply, sessionRefusalError(request, refusal, options));
  return answered ?? reply.code(refusal.status).send({ error: options.message ?? SESSION_FORBIDDEN_MESSAGE[refusal.need] });
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

/**
 * A client LIST route that catches broadly: the engine (or the store behind a scope question) that could not
 * decide is a 503 with `Retry-After` and the decision id - the answer a retrying client expects - not the
 * route's own 500. Null for any other error, which stays the route's to answer.
 */
export function sendClientListUnavailable(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply | null {
  const refusal = authorizationRefusalOf(error);
  if (refusal?.status !== 503) return null;
  return sendAuthorizationUnavailable(reply, request, 'client', {
    action: ACTION_OF_NEED.view,
    level: LEVEL_OF_NEED.view,
    ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}),
  });
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
