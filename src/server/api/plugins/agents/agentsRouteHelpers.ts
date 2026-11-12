import { parseAgentRequestReasoning } from '@/lib/services/agents/agentReasoning';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authz } from '@/lib/iam/routeAuthz';
import type { IAgent, IAgentConversation, IAgentConversationMessageTally, IAgentRun } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  getAgentById,
  getConversationById,
  listAgents,
} from '@/lib/services/agents';
import { watchTurnCancellation } from '@/lib/services/agents/turnWatch';
import { AgentBudgetReachedError } from '@/lib/services/agents/agentErrors';
import { assertSessionBudgetAvailable } from '@/lib/services/agents/sessionBudget';
import { getDatabase } from '@/lib/database';
import {
  listAgentRuns,
  reserveConversationForSyncTurn,
  runWithTenantDb,
} from '@/lib/services/agents/agentRunService';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import {
  pendingActionsBlockingMessage,
  type ResolveActor,
  type ResolveOutcome,
} from '@/lib/services/agents/agentActionResolution';
import {
  CANCEL_PENDING_FORBIDDEN_MESSAGE,
  describeAnswerAbility,
  refuseCancelPending,
  type AnswerAbility,
} from '../agent-approval-authz';
import {
  AgentModelError,
  rememberSessionModel,
  resolveAgentConfigForModels,
  resolveRunModelForRequest,
} from '../agent-model-authz';
import type { AgentModelChoice } from '@/lib/services/agents/agentModelSelection';
import {
  loadSessionForPrincipal,
  sendAuthorizationUnavailable,
  sendSessionRefusal,
  type SessionNeed,
} from '../agent-session-access';
import { type SessionOwner } from '@/lib/services/agents/sessionOwners';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
} from '../../fastify-utils';
import { openLazySseStream } from '../../sseWire';
import { guardAgentAccess, type AgentAccessOptions } from '../agent-owned-access';
import {
  FEEDBACK_REASONS,
} from '@/lib/services/agents/agentFeedback';

export const logger = createLogger('api:agents');

/**
 * Resolve an agent by id within the caller's project scope.
 *
 * getAgentById is scoped only by the tenant database, so without this an
 * ordinary member could address any agent in the tenant: read its prompt and
 * connection config, rewrite or delete it, or run it on the owning project's
 * credentials. Returns null for an out-of-scope id so it is indistinguishable
 * from a missing one. Owners and admins too: the active project decides, and
 * they reach another one by switching to it. Rows stored without a projectId
 * stay tenant-wide.
 */
export async function agentInProjectScope(
  tenantDbName: string,
  agentId: string,
  projectId: string,
): Promise<IAgent | null> {
  const agent = await getAgentById(tenantDbName, agentId);
  if (!agent) return null;
  if (!agent.projectId) return agent;
  return String(agent.projectId) === String(projectId) ? agent : null;
}

/**
 * The caller's project context plus the agent `:agentId` names, or null —
 * with the 404 already sent — when it is missing or out of scope.
 */
export async function requireScopedAgent(request: FastifyRequest, reply: FastifyReply, options: AgentAccessOptions = {}) {
  const context = await requireProjectContextForRequest(request);
  const { agentId } = request.params as { agentId: string };
  const agent = await agentInProjectScope(context.session.tenantDbName, agentId, context.projectId);
  if (!agent) {
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
  // A hidden agent owned by a flow is governed by the flow's service, not `agents` (agent-owned-access.ts).
  if (!await guardAgentAccess(request, reply, agent, {
    tenantDbName: context.session.tenantDbName, tenantId: context.session.tenantId, projectId: context.projectId,
  }, options)) return null;
  return { ...context, agentId, agent };
}

/** The routes under an agent: open to a holder of `agents`, or of `flows` for an agent a flow owns (agent-owned-access.ts). */
export const AGENT_SCOPED = { config: authz.serviceAnyOf(['agents', 'flows']) };

/**
 * `requireScopedAgent` plus the session `:sessionId` names - scoped to this
 * agent and project, so an id valid for a sibling agent or project 404s - and
 * the caller's right to it: the person who started the session needs nothing
 * beyond the route's own service check; anybody else needs
 * `agent.session_view_others` (`need: 'view'`, reading) or
 * `agent.session_manage_others` (`need: 'manage'`, changing) - agent-session-access.ts.
 * `need: 'none'` skips that question for a route that asks its own (answering a
 * pending request: `agent.approve`, or the session's ownership for a question).
 * Null, with the 404 / 403 / 503 already sent, when it is missing, out of
 * scope or not the caller's to touch.
 */
export async function requireScopedSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { need: SessionNeed | 'none' } & AgentAccessOptions,
) {
  const scoped = await requireScopedAgent(request, reply, { owned: options.owned });
  if (!scoped) return null;
  const { sessionId } = request.params as { sessionId: string };
  if (options.need === 'none') {
    let found: IAgentConversation | null = null;
    try {
      found = await getConversationById(scoped.session.tenantDbName, sessionId);
    } catch {
      found = null;
    }
    if (!found || found.agentKey !== scoped.agent.key || found.projectId !== scoped.projectId) {
      void reply.code(404).send({ error: 'Session not found' });
      return null;
    }
    return { ...scoped, conversation: found, owner: String(found.createdBy) === scoped.session.userId };
  }
  const loaded = await loadSessionForPrincipal(request, sessionId, {
    need: options.need,
    agentKey: scoped.agent.key,
    agent: scoped.agent,
    projectId: scoped.projectId,
    actor: { tenantDbName: scoped.session.tenantDbName, projectId: scoped.projectId, userId: scoped.session.userId },
  });
  if (!loaded.ok) {
    sendSessionRefusal(reply, request, loaded);
    return null;
  }
  return { ...scoped, conversation: loaded.conversation, owner: loaded.owner };
}

/** The window of a feedback query in days (default 30, at most 365). */
export function feedbackDays(rawQuery: unknown): number {
  const days = Number((rawQuery as { days?: string } | undefined)?.days);
  return Number.isFinite(days) && days >= 1 ? Math.min(Math.floor(days), 365) : 30;
}

/** The filter of the Feedback tab's queries, or the 400 message. */
export function parseFeedbackFilter(rawQuery: unknown, agentKey: string, projectId: string) {
  const query = (rawQuery ?? {}) as Record<string, string | undefined>;
  if (query.rating !== undefined && query.rating !== 'up' && query.rating !== 'down') {
    return { error: '`rating` must be "up" or "down"' };
  }
  if (query.reason !== undefined && !(FEEDBACK_REASONS as readonly string[]).includes(query.reason)) {
    return { error: `\`reason\` must be one of: ${FEEDBACK_REASONS.join(', ')}` };
  }
  return {
    projectId,
    agentKey,
    from: new Date(Date.now() - feedbackDays(query) * 86_400_000),
    ...(query.rating ? { rating: query.rating as 'up' | 'down' } : {}),
    ...(query.reason ? { reason: query.reason as (typeof FEEDBACK_REASONS)[number] } : {}),
    ...(query.portalId ? { portalId: query.portalId } : {}),
    ...(query.hasComment === 'true' || query.hasComment === '1' ? { hasComment: true } : {}),
  };
}

/**
 * Logs a failed route and answers it: the project-context status when that is
 * what failed, else a 500 with `message`.
 */
export function sendRouteError(reply: FastifyReply, error: unknown, logMessage: string, message: string) {
  logger.error(logMessage, { error });
  return sendProjectContextError(reply, error) ?? reply.code(500).send({ error: message });
}

/** The still-open requests of a session, as stored (who raised each, under which agent version). */
export function openActionsOf(tenantDbName: string, conversationId: string) {
  return runWithTenantDb(tenantDbName, (db) => db.listAgentPendingActions(conversationId, { status: 'pending' }));
}

/**
 * What the caller could do with the requests a waiting session holds, for its row in the table: `canResolve` is
 * true when every open request is theirs to answer; otherwise the first reason they cannot. Nothing for a
 * session that waits on nobody, or when the answer cannot be given (it is only a hint: the server decides again).
 */
export async function answerabilityOfRow(
  request: FastifyRequest,
  tenantDbName: string,
  agent: Pick<IAgent, '_id' | 'key'>,
  conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy' | 'runtimeStatus'>,
  actor: { tenantDbName: string; projectId: string; userId: string },
): Promise<{ canResolve: boolean; resolveBlockedReason?: AnswerAbility['reason'] } | null> {
  if (conversation.runtimeStatus !== 'requires_action') return null;
  const actions = await openActionsOf(tenantDbName, String(conversation._id));
  if (actions.length === 0) return null;
  const ability = await describeAnswerAbility(request, { tenantDbName, conversation, actions, agent, actor });
  const blocked = [...ability.values()].find((entry) => !entry.canResolve);
  return blocked ? { canResolve: false, ...(blocked.reason ? { resolveBlockedReason: blocked.reason } : {}) } : { canResolve: true };
}

/**
 * A dashboard turn on a session holds that conversation's run slot, the same
 * one API and background runs take — two turns writing one conversation at
 * once lose one turn's history. `undefined` = stateless (no session), `null`
 * = the slot is taken.
 */
export async function reserveDashboardSession(input: {
  session: { tenantId: string; tenantDbName: string; userId: string };
  projectId: string;
  agentKey: string;
  conversationId: unknown;
  userMessage: string;
}) {
  if (typeof input.conversationId !== 'string') return undefined;
  return reserveConversationForSyncTurn(await getDatabase(), {
    tenantId: input.session.tenantId,
    tenantDbName: input.session.tenantDbName,
    projectId: input.projectId,
    agentKey: input.agentKey,
    conversationId: input.conversationId,
    userMessage: input.userMessage,
    userId: input.session.userId,
  });
}

/** Makes a dashboard turn stoppable from `POST .../sessions/:sessionId/cancel` (any node). */
export function turnWatchFor(turn: { reservation?: { run: { _id?: unknown } } | null; run: { tenantDbName: string; tenantId: string; projectId: string; conversationId?: string } }) {
  const { reservation, run } = turn;
  if (!reservation || !run.conversationId) return undefined;
  return watchTurnCancellation({
    tenantDbName: run.tenantDbName,
    tenantId: run.tenantId,
    projectId: run.projectId,
    conversationId: run.conversationId,
    runId: String(reservation.run._id),
  });
}

/** Who is answering a pending action: the dashboard user. Whether they may is the policy engine's decision (agent-approval-authz.ts). */
export function dashboardActor(scoped: NonNullable<Awaited<ReturnType<typeof requireScopedAgent>>>): ResolveActor {
  const { user, session } = scoped;
  return {
    userId: session.userId,
    channel: 'dashboard',
    email: user.email,
    role: user.role,
  };
}

/** The refusal for a resolve that did not start a continuation, or null for the outcomes that did. */
export function resolveRefusal(outcome: ResolveOutcome): { status: number; body: Record<string, unknown> } | null {
  switch (outcome.kind) {
    case 'not_found':
      return { status: 404, body: { error: 'Request not found' } };
    case 'not_pending':
      // Told apart so a client can say what happened to it: answered elsewhere, cancelled (a new
      // message, a run cancel, the timeout policy), or timed out.
      if (outcome.status === 'cancelled') {
        return { status: 409, body: { error: 'This request was cancelled', type: 'action_cancelled', code: 'action_cancelled', actionStatus: outcome.status } };
      }
      if (outcome.status === 'expired') {
        return { status: 410, body: { error: 'This request has expired', type: 'action_expired', code: 'action_expired', actionStatus: outcome.status } };
      }
      return { status: 409, body: { error: 'This request is no longer open', type: 'action_not_pending', code: 'action_not_pending', actionStatus: outcome.status } };
    case 'expired':
      return { status: 410, body: { error: 'This request has expired', type: 'action_expired', code: 'action_expired' } };
    case 'forbidden':
      return { status: 403, body: { error: outcome.message, code: 'forbidden', ...(outcome.decisionId ? { decisionId: outcome.decisionId } : {}) } };
    case 'invalid':
      return { status: 400, body: { error: outcome.message } };
    case 'busy':
      return { status: 409, body: SESSION_BUSY_BODY };
    default:
      return null;
  }
}

/** The dashboard's 402 for a session whose spend budget is used up. */
function budgetReachedBody(error: AgentBudgetReachedError) {
  return {
    error: error.message,
    type: 'budget_reached',
    code: 'budget_reached',
    spentUsd: error.spentUsd,
    maxCostUsd: error.maxCostUsd,
  };
}

export const SESSION_BUSY_BODY = {
  error: 'This session already has a run in progress. Wait for it to finish or start a new session.',
  type: 'agent_run_conflict',
  code: 'agent_run_conflict',
};

/**
 * Dashboard chat may only extend a console session. API / A2A / trigger /
 * eval sessions are real traffic — the UI shows them read-only, and this keeps
 * a hand-crafted request from appending to them. Legacy sessions (no source)
 * stay writable, matching `isContinuableSession` on the client.
 */
async function readOnlySessionSource(tenantDbName: string, conversationId: unknown): Promise<string | null> {
  if (typeof conversationId !== 'string') return null;
  const conversation = await getConversationById(tenantDbName, conversationId);
  const source = conversation?.metadata?.source;
  return typeof source === 'string' && source !== 'console' ? source : null;
}

/** `attachments` from a chat body: an array of file ids (empty when absent); null when malformed. */
function parseAttachmentIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  return value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128) ? (value as string[]) : null;
}

/**
 * The earlier messages a stateless call (no `conversationId`) carries along. The server
 * ignores them for a Session, which loads its own history.
 */
export function readStatelessHistory(body: Record<string, unknown>): Array<{ role: string; content: string }> | undefined {
  if (!Array.isArray(body.history)) return undefined;
  return (body.history as Array<{ content?: unknown; role?: unknown } | null>).flatMap((item) => (
    typeof item?.content === 'string' && typeof item.role === 'string'
      ? [{ content: item.content, role: item.role }]
      : []
  ));
}

/**
 * What `/chat` and `/chat/stream` both check before a playground turn runs:
 * the message, the agent in scope, a writable session and its run slot. Null —
 * with the refusal already sent — when any of them is missing. Otherwise the
 * held reservation (release it when the turn ends) and the run input.
 */
export async function prepareDashboardTurn(request: FastifyRequest, reply: FastifyReply) {
  const { projectId, session } = await requireProjectContextForRequest(request);
  const { agentId } = request.params as { agentId: string };
  const body = readJsonBody<Record<string, unknown>>(request);

  if (typeof body.message !== 'string') {
    void reply.code(400).send({ error: 'Message is required' });
    return null;
  }
  // Files of this session the message attaches (uploaded to `…/sessions/:id/files` first).
  const attachments = parseAttachmentIds(body.attachments);
  if (attachments === null) {
    void reply.code(400).send({ error: 'attachments must be an array of file ids' });
    return null;
  }
  const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId);
  if (!agent) {
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
  if (!await guardAgentAccess(request, reply, agent, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId })) return null;
  // Continuing a session somebody else started is acting on it: the owner always may, anybody else needs
  // `agent.session_manage_others` and `agent.session_view_others` (the reply is built from what the session holds).
  // Asked first, so a refusal does not reveal whether the session is read-only.
  if (typeof body.conversationId === 'string') {
    const loaded = await loadSessionForPrincipal(request, body.conversationId, {
      need: 'continue',
      agentKey: agent.key,
      agent,
      projectId,
      actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
    });
    if (!loaded.ok) {
      sendSessionRefusal(reply, request, loaded);
      return null;
    }
  }
  const readOnlySource = await readOnlySessionSource(session.tenantDbName, body.conversationId);
  if (readOnlySource) {
    void reply.code(409).send({ error: `This session came in via ${readOnlySource} and is read-only. Start a new session to test the agent.` });
    return null;
  }
  // The session is waiting on an approval or an answer and the agent refuses
  // new messages meanwhile (`onUserMessageWhilePending: 'reject'`).
  if (typeof body.conversationId === 'string') {
    const conversation = await getConversationById(session.tenantDbName, body.conversationId);
    const blocking = await pendingActionsBlockingMessage(session.tenantDbName, conversation, agent.config);
    if (blocking) {
      void reply.code(409).send({
        error: 'This session is waiting for an approval or an answer. Resolve it before sending a new message.',
        type: 'pending_action',
        code: 'pending_action',
        pendingActionIds: blocking,
      });
      return null;
    }
    // The agent cancels an open request when a new message arrives (`cancel_pending`): that is answering it with
    // "no", so it takes the permission to answer.
    const cancelRefusal = await refuseCancelPending(request, { tenantDbName: session.tenantDbName, conversation, agent });
    if (cancelRefusal?.unavailable) {
      sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: cancelRefusal.decisionId });
      return null;
    }
    if (cancelRefusal) {
      void reply.code(403).send({
        error: CANCEL_PENDING_FORBIDDEN_MESSAGE,
        code: 'forbidden',
        ...(cancelRefusal.decisionId ? { decisionId: cancelRefusal.decisionId } : {}),
      });
      return null;
    }
    // The session has used up its own spend budget.
    try {
      assertSessionBudgetAvailable(conversation);
    } catch (error) {
      if (!(error instanceof AgentBudgetReachedError)) throw error;
      void reply.code(402).send(budgetReachedBody(error));
      return null;
    }
  }
  // `reasoning_effort` / `reasoning: { effort }` from the dashboard chat: same lowest rung as the client API.
  const reasoningRequest = parseAgentRequestReasoning(body);
  if (reasoningRequest.error) {
    void reply.code(400).send({ error: reasoningRequest.error, code: 'invalid_reasoning' });
    return null;
  }
  // Which of the agent's models this turn runs on: `model` in the body (the playground's picker), else the
  // session's last choice. The draft config unless a version is asked for - the playground runs the draft.
  let modelChoice: AgentModelChoice | undefined;
  const askedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const sessionConversation = typeof body.conversationId === 'string'
    ? await getConversationById(session.tenantDbName, body.conversationId)
    : null;
  if (askedModel || agent.config.additionalModels?.length || sessionConversation?.metadata?.activeModel) {
    const runConfig = typeof body.version === 'number'
      ? await resolveAgentConfigForModels(session.tenantDbName, agent, projectId, body.version)
      : agent.config;
    if (askedModel || runConfig.additionalModels?.length) {
      try {
        modelChoice = await resolveRunModelForRequest(request, {
          agent, config: runConfig, projectId, requested: askedModel, conversation: sessionConversation,
        });
      } catch (error) {
        if (!(error instanceof AgentModelError)) throw error;
        void reply.code(error.status).send({ error: error.message, code: error.code });
        return null;
      }
    }
  }
  if (modelChoice && sessionConversation) await rememberSessionModel(session.tenantDbName, sessionConversation, modelChoice);

  const reservation = await reserveDashboardSession({
    session, projectId, agentKey: agent.key, conversationId: body.conversationId, userMessage: body.message,
  });
  if (reservation === null) {
    void reply.code(409).send(SESSION_BUSY_BODY);
    return null;
  }

  return {
    body,
    reservation,
    run: {
      agentKey: agent.key,
      // Playground JSON editor: caller-supplied runtime context (downstream
      // headers/metadata), stamped with the dashboard user's identity.
      runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
        userId: session.userId,
        source: 'playground',
      }),
      projectId,
      tenantDbName: session.tenantDbName,
      tenantId: session.tenantId,
      userMessage: body.message,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(typeof body.version === 'number' ? { version: body.version } : {}),
      ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
      // Operator view (Compare versions): thought text whatever the agent publishes to its API.
      ...(body.showReasoning === true ? { revealReasoning: true } : {}),
      ...(modelChoice ? { modelKey: modelChoice.modelKey } : {}),
      ...(reasoningRequest.value ? { requestReasoning: reasoningRequest.value } : {}),
    },
  };
}

export const openLazyEventStream = openLazySseStream;

/**
 * One row of the sessions table: what it is, what it cost, how long it worked.
 *
 * Totals come from the turns themselves — each one recorded its own tokens,
 * price and server-measured latency when it ran (`persistSessionTurn`) — so a
 * session listed months later shows the same numbers it showed live, at the
 * prices that applied then rather than today's.
 */
/** How many waiting sessions of one list are checked for "could you answer it" (the rest simply do not say). */
export const WAITING_ROWS_ANSWERABILITY_LIMIT = 50;

export function summariseConversation(
  // A full conversation or a list row that carries only message tallies - all a summary reads.
  conversation: Pick<IAgentConversation, '_id' | 'title' | 'createdAt' | 'updatedAt' | 'metadata' | 'createdBy' | 'runtimeStatus' | 'budget' | 'spentUsd'>
    & { messages?: ReadonlyArray<IAgentConversationMessageTally> },
  owner?: SessionOwner,
  answerability?: { canResolve: boolean; resolveBlockedReason?: AnswerAbility['reason'] } | null,
  viewerId?: string,
  // The session drew on knowledge base documents this viewer may not read: the row says so, without its name.
  contentHidden = false,
) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let activeMs = 0;
  let turns = 0;
  // A turn that reported usage but no price leaves the total a lower bound,
  // which the UI marks rather than presenting as exact.
  let costComplete = true;
  // What the Sessions filters ask ("did anything go wrong?") — the same
  // verdicts the session drawer badges: a failed tool call or an output that
  // failed its schema is an error; a run cut short by a limit, a cancel or an
  // unresumable pause is "stopped".
  let failedCalls = 0;
  let hasError = false;
  let stopped = false;

  for (const message of conversation.messages ?? []) {
    if (message.role !== 'assistant') continue;
    turns += 1;
    for (const step of message.steps ?? []) {
      if (step.status === 'error' || step.error) failedCalls += 1;
    }
    if (message.outputError) hasError = true;
    if (message.stopReason) stopped = true;
    inputTokens += message.usage?.inputTokens ?? 0;
    outputTokens += message.usage?.outputTokens ?? 0;
    totalTokens += message.usage?.totalTokens ?? 0;
    activeMs += message.latencyMs ?? 0;
    if (message.usage?.costUsd === undefined) {
      if (message.usage) costComplete = false;
    } else {
      costUsd += message.usage.costUsd;
    }
  }

  return {
    _id: String(conversation._id),
    ...(contentHidden ? { restricted: true } : { title: conversation.title }),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages?.length ?? 0,
    turns,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    costComplete,
    activeMs,
    failedCalls,
    status: hasError || failedCalls > 0 ? 'error' : stopped ? 'stopped' : turns > 0 ? 'success' : 'empty',
    source: typeof conversation.metadata?.source === 'string' ? conversation.metadata.source : undefined,
    // Whose it is: the person who started it (a name), or the kind of traffic that did (a trigger, a public A2A call...).
    createdBy: conversation.createdBy,
    ...(owner ? { owner } : {}),
    // The viewer started it (so the table can say "you" without knowing who the viewer is).
    ...(viewerId ? { ownSession: String(conversation.createdBy) === viewerId } : {}),
    // Waiting for an answer: whether THIS viewer could give it, as the server will decide it.
    ...(answerability ? answerability : {}),
    // 'requires_action' = waiting on an approval / answer (the "Waiting for you" badge);
    // 'budget_paused' = the session's spend budget stopped it.
    runtimeStatus: conversation.runtimeStatus,
    ...(conversation.budget ? { budget: conversation.budget, spentUsd: Math.max(conversation.spentUsd ?? 0, costUsd) } : {}),
    hasContext: Boolean(
      conversation.metadata?.runtimeContext
      && Object.keys(conversation.metadata.runtimeContext as Record<string, unknown>).length > 0,
    ),
  };
}

/** The `channel` values a run can carry (the runs list filters on them). */
export const RUN_CHANNEL_VALUES = ['runs', 'responses', 'chat_completions', 'a2a', 'trigger', 'reminder', 'messaging'] as const satisfies ReadonlyArray<NonNullable<IAgentRun['channel']>>;

/** A session row's run that is waiting for its time, queued or running. */
export interface ActiveRunRow { id: string; status: IAgentRun['status']; scheduledFor?: number; cancelRequested: boolean }

/** The run each session of the agent (of the whole project without `agentKey`) is waiting on or running now (a reminder's own wait is not one), newest first. */
export async function activeRunsBySession(
  tenantDbName: string,
  filter: { tenantId: string; projectId: string; agentKey?: string },
): Promise<Map<string, ActiveRunRow>> {
  const runs = await listAgentRuns(tenantDbName, {
    ...filter,
    excludeModes: ['sync'],
    status: ['scheduled', 'queued', 'running'],
    limit: 500,
  });
  const out = new Map<string, ActiveRunRow>();
  for (const run of runs) {
    if (out.has(run.conversationId)) continue;
    if (run.status === 'scheduled' && run.channel === 'reminder') continue;
    out.set(run.conversationId, {
      id: `run_${String(run._id)}`,
      status: run.status,
      ...(run.notBefore ? { scheduledFor: Math.floor(new Date(run.notBefore).getTime() / 1000) } : {}),
      cancelRequested: Boolean(run.cancelRequestedAt),
    });
  }
  return out;
}

/** What the Sessions list says of a session's agent (the dashboard opens a session through it). */
export type SessionAgent = Pick<IAgent, '_id' | 'key' | 'name'>;

/**
 * The agents the given sessions ran on, by key. Those of the project first; a key it does not hold is looked
 * for once among the tenant's agents (one stored without a project is tenant-wide). A session whose agent is
 * not found stays out of the map: every session route is addressed through an agent, so nothing could open it.
 */
export async function agentsOfSessions(
  tenantDbName: string,
  projectId: string,
  sessions: ReadonlyArray<Pick<IAgentConversation, 'agentKey'>>,
): Promise<Map<string, SessionAgent>> {
  const agents = new Map<string, SessionAgent>();
  for (const agent of await listAgents(tenantDbName, { projectId })) agents.set(agent.key, agent);
  if (sessions.some((entry) => !agents.has(entry.agentKey))) {
    for (const agent of await listAgents(tenantDbName)) {
      if (agents.has(agent.key)) continue;
      if (!agent.projectId || String(agent.projectId) === String(projectId)) agents.set(agent.key, agent);
    }
  }
  return agents;
}

/** The sessions a trigger's runs ran in, newest first (Triggers → history). */
export async function sessionsOfTrigger(
  tenantDbName: string,
  filter: { tenantId: string; projectId: string; agentKey: string; triggerId: string; createdBy?: string },
): Promise<IAgentConversation[]> {
  const runs = await listAgentRuns(tenantDbName, {
    tenantId: filter.tenantId,
    projectId: filter.projectId,
    agentKey: filter.agentKey,
    triggerId: filter.triggerId,
    excludeModes: ['sync'],
    limit: 100,
  });
  const ids = [...new Set(runs.map((run) => run.conversationId))];
  const found = await Promise.all(ids.map((id) => getConversationById(tenantDbName, id).catch(() => null)));
  return found.filter((conversation): conversation is IAgentConversation => Boolean(conversation)
    && conversation!.projectId === filter.projectId
    && conversation!.agentKey === filter.agentKey
    && (!filter.createdBy || conversation!.createdBy === filter.createdBy));
}

/** Session titles for the reminders list (at most 50 sessions are looked up). */
export async function sessionTitles(tenantDbName: string, projectId: string, ids: string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(ids)].slice(0, 50);
  const found = await Promise.all(distinct.map((id) => getConversationById(tenantDbName, id).catch(() => null)));
  const out = new Map<string, string>();
  for (const conversation of found) {
    if (conversation && conversation.projectId === projectId && conversation.title) out.set(String(conversation._id), conversation.title);
  }
  return out;
}
