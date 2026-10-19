import { parseAgentRequestReasoning } from '@/lib/services/agents/agentReasoning';
import { AgentDocumentParseError } from '@/lib/services/agents/import/document';
import {
  AgentImportError,
  applyAgentDocumentImport,
  previewAgentDocumentImport,
  type ApplyAgentDocumentImportInput,
} from '@/lib/services/agents/import/importService';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';
import type { AgentStatus, IAgent, IAgentConfig, IAgentConversation, IAgentRun, IAgentSessionBudget, IUser } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createAgentRecord,
  createConversation,
  deleteAgentRecord,
  deleteConversation,
  executePlaygroundChat,
  getAgentById,
  getConversationById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  listConversations,
  updateAgentRecord,
} from '@/lib/services/agents';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
import { watchTurnCancellation } from '@/lib/services/agents/turnWatch';
// By path: the agents barrel does not export the error class.
import {
  AgentGuardrailBlockedError,
  checkAgentModel,
  executeAgentContinueLocal,
  // Imported BY PATH: the barrel exports the queue-routing wrapper, and the
  // streaming route deliberately needs the local one (a progress callback
  // cannot cross the job queue).
  executePlaygroundChatLocal,
} from '@/lib/services/agents/agentService';
import { AgentBudgetReachedError } from '@/lib/services/agents/agentErrors';
import { assertSessionBudgetAvailable, parseSessionBudget } from '@/lib/services/agents/sessionBudget';
import { updateSessionBudget } from '@/lib/services/agents/sessionBudgetService';
import {
  validateAgentConfig,
  type AgentConfigIssue,
} from '@/lib/services/agents/agentConfigValidation';
import { classifyAgentRunError, logAgentRunFailure } from '@/lib/services/agents/agentErrors';
import { enforceAgentRunQuota, settleAgentRun, type AgentRunCaller } from '@/lib/services/agents/agentQuota';
import { createRunUsageSink, runWithUsageSink } from '@/lib/services/agents/runUsage';
import {
  AgentManifestError,
  manifestErrorStatus,
  applyAgentManifest,
  buildAgentManifest,
  parseAgentManifest,
  previewAgentImport,
  serializeAgentManifest,
  type AgentManifestFormat,
} from '@/lib/services/agents/agentManifest';
import { collectManifestResources, parseResourceInclude } from '@/lib/services/agents/manifestResources';
import {
  generateAgentProject,
  type AgentCodegenTarget,
} from '@/lib/services/agents/agentCodegen';
import { buildPromptVariables, renderPromptTemplate } from '@/lib/services/agents/promptVariables';
import { getDatabase } from '@/lib/database';
import {
  AGENT_RUN_TRIGGERS,
  getAgentRunStatus,
  listAgentRuns,
  requestAgentRunCancellation,
  reserveConversationForSyncTurn,
  resolveAgentRunLimits,
  runWithTenantDb,
  serializeAgentRun,
} from '@/lib/services/agents/agentRunService';
import type { LicenseType } from '@/lib/license/license-manager';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import { sessionEventBus } from '@/lib/services/agents/sessionEvents';
import { DASHBOARD_AGENT_HITL_DEFAULTS } from '@/lib/services/agents/agentHumanInTheLoop';
import {
  pendingActionsBlockingMessage,
  resolveAgentPendingAction,
  type ResolveActor,
  type ResolveOutcome,
} from '@/lib/services/agents/agentActionResolution';
import {
  listConversationActions,
  listSessionEvents,
  streamSessionEvents,
  toPublicPendingAction,
} from './agent-session-events';
import {
  approvalAuthorizerFor,
  authorizeEndingOpenRequests,
  CANCEL_PENDING_FORBIDDEN_MESSAGE,
  describeAnswerAbility,
  refuseCancelPending,
  withAnswerAbility,
  type AnswerAbility,
} from './agent-approval-authz';
import {
  AgentModelError,
  advertisedModelsForRequest,
  rememberSessionModel,
  resolveAgentConfigForModels,
  resolveRunModelForRequest,
} from './agent-model-authz';
import type { AgentModelChoice } from '@/lib/services/agents/agentModelSelection';
import {
  decideSessionAccess,
  loadSessionForPrincipal,
  sendAuthorizationUnavailable,
  sendSessionRefusal,
  sessionListScope,
  sessionStreamStillAllowed,
  type SessionNeed,
} from './agent-session-access';
import { resolveSessionOwners, type SessionOwner } from '@/lib/services/agents/sessionOwners';
import {
  activeRemindersBySession,
  cancelReminder,
  fireReminderNow,
  listReminders,
  reminderPlatformLimits,
  serializeReminder,
} from '@/lib/services/agents/agentReminders';
import {
  applyStreamHeaders,
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { BucketNamingForbiddenError } from '@/lib/services/agents/attachmentsBucketAccess';
import {
  applyConfigGuardrailBindings,
  bucketNamingForbiddenBody,
  connectedConfigForUpdate,
  invalidAgentStatusBody,
  normalizeA2aUpdate,
  pickAgentUpdateFields,
  prepareNewAgentConfig,
  publishValidatedAgent,
  redactAgent,
  redactVersion,
  sendAgentGuardrailBlock,
  validateNativeConfigUpdate,
} from './agent-config-write';
import { requestCanNameBucket } from './files-permission';
import { sessionHasAgentsPermission } from './agents-permission';
import {
  FeedbackError,
  FEEDBACK_REASONS,
  listAgentFeedback,
  listSessionFeedback,
  summarizeAgentFeedback,
  toFeedbackView,
} from '@/lib/services/agents/agentFeedback';

const logger = createLogger('api:agents');

/**
 * Resolve an agent by id within the caller's project scope.
 *
 * getAgentById is scoped only by the tenant database, so without this an
 * ordinary member could address any agent in the tenant: read its prompt and
 * connection config, rewrite or delete it, or run it on the owning project's
 * credentials. Returns null for an out-of-scope id so it is indistinguishable
 * from a missing one. Owners and admins keep tenant-wide reach, which
 * resolveProjectContext already grants them, and agents stored without a
 * projectId stay tenant-wide.
 */
async function agentInProjectScope(
  tenantDbName: string,
  agentId: string,
  projectId: string,
  user: Pick<IUser, 'role'>,
): Promise<IAgent | null> {
  const agent = await getAgentById(tenantDbName, agentId);
  if (!agent) return null;
  if (user.role === 'owner' || user.role === 'admin') return agent;
  if (!agent.projectId) return agent;
  return String(agent.projectId) === String(projectId) ? agent : null;
}

/**
 * The caller's project context plus the agent `:agentId` names, or null —
 * with the 404 already sent — when it is missing or out of scope.
 */
export async function requireScopedAgent(request: FastifyRequest, reply: FastifyReply) {
  const context = await requireProjectContextForRequest(request);
  const { agentId } = request.params as { agentId: string };
  const agent = await agentInProjectScope(context.session.tenantDbName, agentId, context.projectId, context.user);
  if (!agent) {
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
  return { ...context, agentId, agent };
}

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
  options: { need: SessionNeed | 'none' },
) {
  const scoped = await requireScopedAgent(request, reply);
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
function feedbackDays(rawQuery: unknown): number {
  const days = Number((rawQuery as { days?: string } | undefined)?.days);
  return Number.isFinite(days) && days >= 1 ? Math.min(Math.floor(days), 365) : 30;
}

/** The filter of the Feedback tab's queries, or the 400 message. */
function parseFeedbackFilter(rawQuery: unknown, agentKey: string, projectId: string) {
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
function sendRouteError(reply: FastifyReply, error: unknown, logMessage: string, message: string) {
  logger.error(logMessage, { error });
  return sendProjectContextError(reply, error) ?? reply.code(500).send({ error: message });
}

/** The still-open requests of a session, as stored (who raised each, under which agent version). */
function openActionsOf(tenantDbName: string, conversationId: string) {
  return runWithTenantDb(tenantDbName, (db) => db.listAgentPendingActions(conversationId, { status: 'pending' }));
}

/**
 * What the caller could do with the requests a waiting session holds, for its row in the table: `canResolve` is
 * true when every open request is theirs to answer; otherwise the first reason they cannot. Nothing for a
 * session that waits on nobody, or when the answer cannot be given (it is only a hint: the server decides again).
 */
async function answerabilityOfRow(
  request: FastifyRequest,
  tenantDbName: string,
  agent: Pick<IAgent, '_id' | 'key'>,
  conversation: IAgentConversation,
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
async function reserveDashboardSession(input: {
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
function turnWatchFor(turn: { reservation?: { run: { _id?: unknown } } | null; run: { tenantDbName: string; tenantId: string; projectId: string; conversationId?: string } }) {
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
function dashboardActor(scoped: NonNullable<Awaited<ReturnType<typeof requireScopedAgent>>>): ResolveActor {
  const { user, session } = scoped;
  return {
    userId: session.userId,
    channel: 'dashboard',
    email: user.email,
    role: user.role,
  };
}

/** The refusal for a resolve that did not start a continuation, or null for the outcomes that did. */
function resolveRefusal(outcome: ResolveOutcome): { status: number; body: Record<string, unknown> } | null {
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

const SESSION_BUSY_BODY = {
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
function readStatelessHistory(body: Record<string, unknown>): Array<{ role: string; content: string }> | undefined {
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
async function prepareDashboardTurn(request: FastifyRequest, reply: FastifyReply) {
  const { projectId, user, session } = await requireProjectContextForRequest(request);
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
  const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);
  if (!agent) {
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
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

/**
 * An SSE response that opens lazily — at the first event it is given — so a
 * refusal that comes before anything has happened can still be a normal JSON
 * response. Disabled (`enabled` false) it swallows every call.
 */
function openLazyEventStream(reply: FastifyReply, enabled: boolean) {
  let started = false;
  let closed = false;
  const pendingFrames: Array<() => void> = [];
  const write = (event: string, data: unknown, id?: number) => {
    if (closed) return;
    try {
      reply.raw.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };
  const start = () => {
    if (started || !enabled) return;
    started = true;
    applyStreamHeaders(reply);
    reply.raw.flushHeaders?.();
    reply.raw.on('close', () => { closed = true; });
    for (const frame of pendingFrames.splice(0)) frame();
  };
  const send = (event: string, data: unknown, id?: number) => {
    if (!enabled) return;
    if (!started) {
      pendingFrames.push(() => write(event, data, id));
      return;
    }
    write(event, data, id);
  };
  return {
    start,
    send,
    started: () => started,
    /** A callback that starts the stream and forwards one kind of progress event. */
    live: <A extends unknown[]>(event: string, map: (...args: A) => unknown) => (...args: A) => {
      start();
      send(event, map(...args));
    },
    end: () => { if (!closed) reply.raw.end(); },
  };
}

/**
 * One row of the sessions table: what it is, what it cost, how long it worked.
 *
 * Totals come from the turns themselves — each one recorded its own tokens,
 * price and server-measured latency when it ran (`persistSessionTurn`) — so a
 * session listed months later shows the same numbers it showed live, at the
 * prices that applied then rather than today's.
 */
/** How many waiting sessions of one list are checked for "could you answer it" (the rest simply do not say). */
const WAITING_ROWS_ANSWERABILITY_LIMIT = 50;

function summariseConversation(
  conversation: IAgentConversation,
  owner?: SessionOwner,
  answerability?: { canResolve: boolean; resolveBlockedReason?: AnswerAbility['reason'] } | null,
  viewerId?: string,
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
    title: conversation.title,
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
const RUN_CHANNEL_VALUES = ['runs', 'responses', 'chat_completions', 'a2a', 'trigger', 'reminder'] as const satisfies ReadonlyArray<NonNullable<IAgentRun['channel']>>;

/** The run each session of the agent is waiting on or running now (a reminder's own wait is not one), newest first. */
async function activeRunsBySession(
  tenantDbName: string,
  filter: { tenantId: string; projectId: string; agentKey: string },
): Promise<Map<string, { id: string; status: IAgentRun['status']; scheduledFor?: number; cancelRequested: boolean }>> {
  const runs = await listAgentRuns(tenantDbName, {
    ...filter,
    excludeModes: ['sync'],
    status: ['scheduled', 'queued', 'running'],
    limit: 500,
  });
  const out = new Map<string, { id: string; status: IAgentRun['status']; scheduledFor?: number; cancelRequested: boolean }>();
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

/** The sessions a trigger's runs ran in, newest first (Triggers → history). */
async function sessionsOfTrigger(
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
async function sessionTitles(tenantDbName: string, projectId: string, ids: string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(ids)].slice(0, 50);
  const found = await Promise.all(distinct.map((id) => getConversationById(tenantDbName, id).catch(() => null)));
  const out = new Map<string, string>();
  for (const conversation of found) {
    if (conversation && conversation.projectId === projectId && conversation.title) out.set(String(conversation._id), conversation.title);
  }
  return out;
}

export const agentsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; status?: string };
      const agents = await listAgents(session.tenantDbName, {
        projectId,
        search: query.search,
        status: query.status as AgentStatus | undefined,
      });

      return reply.code(200).send({ agents: agents.map(redactAgent) });
    } catch (error) {
      return sendRouteError(reply, error, 'List agents error', 'Failed to list agents');
    }
  }));

  app.post('/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session, user } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const invalidStatus = invalidAgentStatusBody(body);
      if (invalidStatus) return reply.code(400).send(invalidStatus);

      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'Agent name is required' });
      }

      const prepared = await prepareNewAgentConfig(body.config, {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        user,
        canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
      });
      if ('forbidden' in prepared) return reply.code(403).send(prepared.forbidden);
      if ('badRequest' in prepared) return reply.code(400).send(prepared.badRequest);

      // An agent created from the dashboard asks before its tools run unless the
      // form said otherwise. Stored explicitly so it shows (and can be changed)
      // in Configure → Approvals & questions. The client API's create route does
      // not do this: an API-created agent keeps running unattended.
      if (prepared.config.kind !== 'external' && prepared.config.humanInTheLoop === undefined) {
        prepared.config.humanInTheLoop = structuredClone(DASHBOARD_AGENT_HITL_DEFAULTS);
      }

      const agent = await createAgentRecord(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          config: prepared.config,
          description: body.description as string | undefined,
          name: body.name,
        },
      );

      return reply.code(201).send({ agent: redactAgent(agent), warnings: prepared.warnings });
    } catch (error) {
      return sendRouteError(reply, error, 'Create agent error', 'Failed to create agent');
    }
  }));

  app.get('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      // The models the playground may pick among (main + additional the caller may use).
      const models = await advertisedModelsForRequest(request, {
        agent: scoped.agent, tenantDbName: scoped.session.tenantDbName, projectId: scoped.projectId,
      }).catch(() => undefined);
      return reply.code(200).send({ agent: redactAgent(scoped.agent), ...(models ? { models } : {}) });
    } catch (error) {
      return sendRouteError(reply, error, 'Get agent error', 'Failed to get agent');
    }
  }));

  app.patch('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent: existing, agentId, projectId, session, user } = scoped;
      const body = readJsonBody<Record<string, unknown>>(request);
      const invalidStatus = invalidAgentStatusBody(body);
      if (invalidStatus) return reply.code(400).send(invalidStatus);
      let warnings: AgentConfigIssue[] = [];

      if (body.config && typeof body.config === 'object') {
        const cfg = body.config as Record<string, unknown>;
        if (cfg.kind === 'external') {
          let externalConfig: IAgentConfig;
          try {
            externalConfig = connectedConfigForUpdate(cfg, existing);
          } catch (validationError) {
            return reply.code(400).send({
              error: validationError instanceof Error ? validationError.message : 'Invalid agent config',
            });
          }
          const bindingError = await applyConfigGuardrailBindings(
            externalConfig,
            session.tenantDbName,
            projectId,
            user,
          );
          if (bindingError) {
            return reply.code(400).send({ error: bindingError });
          }
          body.config = externalConfig;
        } else if (existing.config?.kind === 'external') {
          // Guard: never let a native-shaped config silently clobber a stored
          // connected agent's connection (e.g. a stray playground auto-save).
          delete body.config;
        } else {
          const checked = await validateNativeConfigUpdate(cfg, existing.key, {
            tenantDbName: session.tenantDbName,
            tenantId: session.tenantId,
            projectId,
            user,
            canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
          }, existing.config);
          if ('forbidden' in checked) return reply.code(403).send(checked.forbidden);
          if ('conflict' in checked) return reply.code(409).send(checked.conflict);
          if ('badRequest' in checked) return reply.code(400).send(checked.badRequest);
          warnings = checked.warnings;
        }
      }

      normalizeA2aUpdate(body, existing);

      const agent = await updateAgentRecord(session.tenantDbName, agentId, pickAgentUpdateFields(body), session.userId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent: redactAgent(agent), warnings });
    } catch (error) {
      return sendRouteError(reply, error, 'Update agent error', 'Failed to update agent');
    }
  }));

  app.delete('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const deleted = await deleteAgentRecord(scoped.session.tenantDbName, scoped.agentId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendRouteError(reply, error, 'Delete agent error', 'Failed to delete agent');
    }
  }));

  app.get('/agents/:agentId/versions', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, agentId, session } = scoped;
      const query = (request.query ?? {}) as { limit?: string; skip?: string; version?: string };

      if (query.version) {
        const version = await getAgentVersion(
          session.tenantDbName,
          agentId,
          Number.parseInt(query.version, 10),
        );

        if (!version) {
          return reply.code(404).send({ error: 'Version not found' });
        }

        return reply.code(200).send({ version: redactVersion(version) });
      }

      const result = await listAgentVersions(session.tenantDbName, agentId, {
        limit: Number.parseInt(query.limit ?? '50', 10),
        skip: Number.parseInt(query.skip ?? '0', 10),
      });

      return reply.code(200).send({
        publishedVersion: agent.publishedVersion ?? null,
        total: result.total,
        versions: result.versions.map(redactVersion),
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent versions error', 'Failed to list agent versions');
    }
  }));

  /**
   * Flattens `promptKey` + `promptVariables` into a literal `systemPrompt` for
   * code export. The generated project has no Prompts module and no runtime
   * context, so anything left unresolved here would stay unresolved forever.
   */
  async function resolveConfigForExport(
    tenantDbName: string,
    projectId: string,
    agent: IAgent,
    config: IAgentConfig,
  ): Promise<IAgentConfig> {
    let template = config.systemPrompt;
    if (!template && config.promptKey) {
      const db = await getDatabase();
      await db.switchToTenant(tenantDbName);
      const prompt = await db.findPromptByKey(config.promptKey, projectId);
      template = prompt?.template;
    }
    if (!template) return config;

    const variables = buildPromptVariables({
      config,
      agentKey: agent.key,
      agentName: agent.name,
      version: agent.publishedVersion ?? null,
    });
    const rendered = renderPromptTemplate(template, variables);
    return { ...config, systemPrompt: rendered.text, promptKey: undefined };
  }

  // ── Manifest export / import ───────────────────────────────────────────

  app.get('/agents/:agentId/export', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, agentId, projectId, session } = scoped;
      const query = (request.query ?? {}) as { format?: string; version?: string; download?: string; include?: string };

      const format: AgentManifestFormat = query.format === 'yaml' ? 'yaml' : 'json';
      // `include=skills,prompts,mcp,tools` (or `all`) embeds those definitions
      // so the manifest can be imported into a project that lacks them.
      let include;
      try {
        include = parseResourceInclude(query.include);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }

      // No `version` exports the DRAFT config — what the playground runs. A
      // version number exports that immutable snapshot instead, which is what
      // anyone promoting between environments actually wants.
      let config = agent.config;
      let version: number | null = null;
      if (query.version) {
        const requested = Number.parseInt(query.version, 10);
        if (!Number.isFinite(requested)) {
          return reply.code(400).send({ error: 'version must be a number' });
        }
        const snapshot = await getAgentVersion(session.tenantDbName, agentId, requested);
        if (!snapshot) return reply.code(404).send({ error: 'Version not found' });
        config = snapshot.snapshot.config;
        version = requested;
      }

      const { resources, skipped } = await collectManifestResources(session.tenantDbName, projectId, config, include);
      const manifest = buildAgentManifest(agent, config, version, resources);
      const body = serializeAgentManifest(manifest, format);

      if (query.download === '1') {
        return reply
          .code(200)
          .header('content-type', format === 'yaml' ? 'application/yaml' : 'application/json')
          .header(
            'content-disposition',
            `attachment; filename="${agent.key}${version !== null ? `-v${version}` : ''}.${format}"`,
          )
          .send(body);
      }

      return reply.code(200).send({ format, manifest, content: body, skippedResources: skipped });
    } catch (error) {
      return sendRouteError(reply, error, 'Export agent error', 'Failed to export agent');
    }
  }));

  app.post('/agents/import', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const body = await readJsonBody<{
        content?: string;
        manifest?: unknown;
        format?: AgentManifestFormat;
        /** `true` validates and reports only — nothing is written. */
        dryRun?: boolean;
        mode?: 'create' | 'update' | 'upsert';
        key?: string;
        name?: string;
        allowMissingDependencies?: boolean;
      }>(request);

      if (!body?.content && !body?.manifest) {
        return reply.code(400).send({ error: 'content or manifest is required' });
      }

      const manifest = body.content
        ? parseAgentManifest(body.content, body.format)
        : parseAgentManifest(JSON.stringify(body.manifest), 'json');

      if (body.dryRun) {
        const preview = await previewAgentImport(session.tenantDbName, projectId, manifest);
        return reply.code(200).send(preview);
      }

      const result = await applyAgentManifest(
        session.tenantDbName,
        session.tenantId,
        projectId,
        String(user._id),
        manifest,
        {
          mode: body.mode,
          key: body.key,
          name: body.name,
          allowMissingDependencies: body.allowMissingDependencies,
          // Importing is a config write like any other: naming a bucket takes the right to name it.
          canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
        },
      );

      return reply.code(result.action === 'created' ? 201 : 200).send({
        agent: redactAgent(result.agent),
        action: result.action,
        missing: result.missing,
      });
    } catch (error) {
      if (error instanceof BucketNamingForbiddenError) {
        return reply.code(403).send(bucketNamingForbiddenBody(error));
      }
      if (error instanceof AgentManifestError) {
        return reply.code(manifestErrorStatus(error)).send({
          error: error.message,
          issues: error.issues,
          ...(error.code ? { type: error.code, code: error.code } : {}),
        });
      }
      return sendRouteError(reply, error, 'Import agent error', 'Failed to import agent');
    }
  }));

  // ── Import from a definition document (New → Import) ────────────────
  // Any supported format — the console manifest or a Claude Managed Agent
  // (JSON / YAML / Markdown front-matter) — auto-detected unless `format`
  // says otherwise. `/preview` writes nothing.
  const sendImportError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AgentDocumentParseError) return reply.code(400).send({ error: error.message });
    if (error instanceof BucketNamingForbiddenError) return reply.code(403).send(bucketNamingForbiddenBody(error));
    if (error instanceof AgentImportError) {
      return reply.code(error.status).send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    if (error instanceof AgentManifestError) return reply.code(manifestErrorStatus(error)).send({ error: error.message, issues: error.issues, ...(error.code ? { type: error.code, code: error.code } : {}) });
    return null;
  };

  app.post('/agents/import/document/preview', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const body = await readJsonBody<{ content?: string; format?: string }>(request);
      if (typeof body?.content !== 'string' || !body.content.trim()) {
        return reply.code(400).send({ error: 'content is required' });
      }
      const preview = await previewAgentDocumentImport(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: String(user._id) },
        body.content,
        body.format,
      );
      return reply.code(200).send(preview);
    } catch (error) {
      return sendImportError(reply, error)
        ?? sendRouteError(reply, error, 'Preview agent document import error', 'Failed to read the document');
    }
  }));

  app.post('/agents/import/document', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const body = await readJsonBody<ApplyAgentDocumentImportInput>(request);
      if (typeof body?.content !== 'string' || !body.content.trim()) {
        return reply.code(400).send({ error: 'content is required' });
      }
      const result = await applyAgentDocumentImport(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          userId: String(user._id),
          canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
        },
        body,
      );
      return reply.code(result.action === 'created' ? 201 : 200).send({
        agent: redactAgent(result.agent),
        action: result.action,
        created: result.created,
        warnings: result.warnings,
      });
    } catch (error) {
      return sendImportError(reply, error)
        ?? sendRouteError(reply, error, 'Agent document import error', 'Failed to import agent');
    }
  }));

  // ── Code export ────────────────────────────────────────────────────────

  app.post('/agents/:agentId/codegen', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const body = await readJsonBody<{
        target?: AgentCodegenTarget;
        packageName?: string;
        consoleBaseUrl?: string;
        includeDockerfile?: boolean;
        version?: number;
        /** `zip` streams an archive; anything else returns the file list as JSON. */
        format?: 'zip' | 'json';
      }>(request);

      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);
      if (!agent) return reply.code(404).send({ error: 'Agent not found' });

      const target = body?.target ?? 'server';
      if (!['cli', 'server', 'worker', 'lambda'].includes(target)) {
        return reply.code(400).send({ error: `Unknown target "${target}"` });
      }

      let config = agent.config;
      if (typeof body?.version === 'number') {
        const snapshot = await getAgentVersion(session.tenantDbName, agentId, body.version);
        if (!snapshot) return reply.code(404).send({ error: 'Version not found' });
        config = snapshot.snapshot.config;
      }

      // Resolve the prompt the way the runtime does before handing it to the
      // generator. Without this an agent backed by a shared prompt exports with
      // no system prompt at all, and one with variables exports the hollow
      // template — both produce a project that quietly behaves differently from
      // the agent it was generated from.
      const exportConfig = await resolveConfigForExport(session.tenantDbName, projectId, agent, config);

      const result = generateAgentProject(agent, exportConfig, {
        target,
        packageName: body?.packageName,
        consoleBaseUrl: body?.consoleBaseUrl,
        includeDockerfile: body?.includeDockerfile,
      });

      if (body?.format === 'zip') {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        const root = zip.folder(result.rootDir);
        for (const file of result.files) root?.file(file.path, file.contents);
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        return reply
          .code(200)
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${result.rootDir}.zip"`)
          .send(buffer);
      }

      return reply.code(200).send(result);
    } catch (error) {
      return sendRouteError(reply, error, 'Agent codegen error', 'Failed to generate agent code');
    }
  }));

  app.post('/agents/:agentId/publish', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const scoped = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);
      if (!scoped) {
        // Same failure an unknown id already raises inside publishAgent, so the
        // route cannot confirm that another project's agent exists.
        throw new Error(`Agent "${agentId}" not found`);
      }
      const published = await publishValidatedAgent(
        request,
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        scoped,
        agentId,
        session.userId,
      );
      if ('badRequest' in published) return reply.code(400).send(published.badRequest);
      return reply.code(201).send({ version: redactVersion(published.version) });
    } catch (error) {
      return sendRouteError(
        reply,
        error,
        'Publish agent error',
        error instanceof Error ? error.message : 'Failed to publish agent',
      );
    }
  }));

  /**
   * What the Sandbox section of an agent can offer: whether this deployment
   * has the sandbox module, whether the tenant's license unlocks it, and the
   * templates to pick from. Always 200 — `available: false` with a `reason`
   * is an answer the UI renders, not a failure.
   */
  app.get('/agents/sandbox/capabilities', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const availability = await resolveSandboxAvailability(session.tenantId);
      if (!availability.available) {
        return reply.code(200).send({ available: false, reason: availability.reason, templates: [] });
      }
      const templates = await availability.runner.listTemplates(session.tenantDbName, session.tenantId)
        .catch((error: unknown) => {
          logger.warn('Could not list sandbox templates', { error });
          return [];
        });
      return reply.code(200).send({ available: true, templates });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent sandbox capabilities error', 'Failed to read sandbox capabilities');
    }
  }));

  // Effective run limits for this tenant/project (env ∧ quota). Agents have no
  // say in them any more; the Studio shows them for reference.
  app.get('/agents/execution/limits', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const limits = await resolveAgentRunLimits({
        quotaContext: {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          licenseType: session.licenseType as LicenseType,
          userId: session.userId,
        },
      });
      return reply.code(200).send({
        syncWaitSeconds: Math.floor(limits.syncWaitMs / 1000),
        maxDurationMinutes: Math.floor(limits.maxDurationMs / 60_000),
        maxActivePerTenant: limits.maxActivePerTenant,
        maxActivePerProject: limits.maxActivePerProject,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent execution limits error', 'Failed to read execution limits');
    }
  }));

  // Background runs of one agent, newest first (Sessions → Background runs).
  app.get('/agents/:agentId/runs', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const query = (request.query ?? {}) as { status?: string; limit?: string; conversationId?: string; triggerId?: string; trigger?: string; channel?: string };
      const trigger = AGENT_RUN_TRIGGERS.find((value) => value === query.trigger);
      const channels = (query.channel ?? '').split(',').filter((value): value is NonNullable<IAgentRun['channel']> => (RUN_CHANNEL_VALUES as readonly string[]).includes(value));
      const allowed = new Set(['scheduled', 'queued', 'running', 'requires_action', 'succeeded', 'failed', 'canceled']);
      const status = (query.status ?? '').split(',').filter((value) => allowed.has(value)) as Array<'scheduled' | 'queued' | 'running' | 'requires_action' | 'succeeded' | 'failed' | 'canceled'>;
      // A run carries the answer of somebody's session: the caller who may not view other people's sessions of
      // this agent sees only the runs they queued, and a run of one session is the session's to read.
      const scope = await sessionListScope(request, { agent, projectId, actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (query.conversationId) {
        const loaded = await loadSessionForPrincipal(request, query.conversationId, {
          need: 'view',
          agentKey: agent.key,
          agent,
          projectId,
          actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        });
        if (!loaded.ok) return sendSessionRefusal(reply, request, loaded);
      }
      const runs = await listAgentRuns(session.tenantDbName, {
        tenantId: session.tenantId,
        projectId,
        agentKey: agent.key,
        // Every run (queued or inline); a dashboard reservation is not one.
        excludeModes: ['sync'],
        ...(status.length > 0 ? { status } : {}),
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        // A trigger's history (Studio's Triggers list links here).
        ...(query.triggerId ? { triggerId: query.triggerId } : {}),
        ...(trigger ? { trigger } : {}),
        ...(channels.length === 1 ? { channel: channels[0] } : {}),
        ...(scope.ownOnly ? { userId: scope.userId } : {}),
        limit: Math.min(Number(query.limit) || 100, 500),
      });
      const shown = channels.length > 1 ? runs.filter((run) => run.channel && channels.includes(run.channel)) : runs;
      return reply.code(200).send({ runs: shown.map(serializeAgentRun) });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent runs error', 'Failed to list runs');
    }
  }));

  app.post('/agents/:agentId/runs/:runId/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { runId } = request.params as { runId: string };
      // Ownership first: the run must belong to THIS agent, not merely to the project.
      const existing = await getAgentRunStatus(session.tenantDbName, session.tenantId, projectId, runId);
      if (!existing || existing.agentKey !== agent.key || existing.mode === 'sync') {
        return reply.code(404).send({ error: 'Run not found' });
      }
      // Cancelling a run is acting on its session: the session's owner always may, anybody else needs
      // `agent.session_manage_others`.
      const conversation = await getConversationById(session.tenantDbName, existing.conversationId);
      if (conversation && conversation.projectId === projectId) {
        const access = await decideSessionAccess(request, conversation, {
          need: 'manage',
          agent,
          actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
          alsoOwnedBy: [existing.userId],
        });
        if (!access.ok) return sendSessionRefusal(reply, request, access);
      }
      // A run paused on an approval is ended by cancelling it, which answers the open request with "no".
      if (existing.status === 'requires_action') {
        if (conversation && conversation.projectId === projectId) {
          const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: session.tenantDbName, conversation, agent });
          if (!verdict.allowed && verdict.unavailable) {
            return sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
          }
          if (!verdict.allowed) {
            return reply.code(403).send({
              error: 'This run is waiting for an approval or an answer. You are not allowed to answer it, so you cannot cancel it.',
              code: 'forbidden',
              ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}),
            });
          }
        }
      }
      if (existing.channel === 'reminder' && existing.status === 'scheduled') {
        const canceled = await cancelReminder(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
          runId,
          { agentKey: agent.key, actor: { userId: session.userId, via: 'dashboard' } },
        );
        if (canceled.kind === 'canceled') return reply.code(200).send({ run: serializeAgentRun(canceled.run) });
      }
      const outcome = await requestAgentRunCancellation(session.tenantDbName, session.tenantId, projectId, runId);
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Run not found' });
      if (outcome.kind === 'already_terminal') {
        return reply.code(409).send({ error: `Run is already ${outcome.run.status}` });
      }
      return reply.code(200).send({ run: serializeAgentRun(outcome.run) });
    } catch (error) {
      return sendRouteError(reply, error, 'Cancel agent run error', 'Failed to cancel run');
    }
  }));

  // A reminder that has not fired yet, started now (Sessions → Reminders "Fire now").
  app.post('/agents/:agentId/runs/:runId/fire', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { runId } = request.params as { runId: string };
      const existing = await getAgentRunStatus(session.tenantDbName, session.tenantId, projectId, runId);
      if (!existing || existing.agentKey !== agent.key || existing.channel !== 'reminder') {
        return reply.code(404).send({ error: 'Reminder not found' });
      }
      // Firing a reminder runs a turn in its session: the session's owner always may, anybody else needs
      // `agent.session_manage_others`.
      const conversation = await getConversationById(session.tenantDbName, existing.conversationId);
      if (!conversation || conversation.projectId !== projectId) return reply.code(404).send({ error: 'Reminder not found' });
      const access = await decideSessionAccess(request, conversation, {
        need: 'manage',
        agent,
        actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        alsoOwnedBy: [existing.userId],
      });
      if (!access.ok) return sendSessionRefusal(reply, request, access);
      const outcome = await fireReminderNow(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        runId,
        { agentKey: agent.key, actor: { userId: session.userId, via: 'dashboard' } },
      );
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Reminder not found' });
      if (outcome.kind === 'not_scheduled') return reply.code(409).send({ error: `The reminder is already ${outcome.run.status}` });
      if (outcome.kind === 'busy') return reply.code(409).send({ error: outcome.message });
      return reply.code(200).send({ run: serializeAgentRun(outcome.run), reminder: serializeReminder(outcome.run) });
    } catch (error) {
      return sendRouteError(reply, error, 'Fire agent reminder error', 'Failed to fire the reminder');
    }
  }));

  // The reminders the agent set itself, newest first (Sessions → Reminders; a session's own with `sessionId`).
  app.get('/agents/:agentId/reminders', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const query = (request.query ?? {}) as { status?: string; limit?: string; sessionId?: string };
      const actor = { tenantDbName: session.tenantDbName, projectId, userId: session.userId };
      const reminderScope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      const scope = await sessionListScope(request, { agent, projectId, actor });
      if (query.sessionId) {
        const loaded = await loadSessionForPrincipal(request, query.sessionId, { need: 'view', agentKey: agent.key, agent, projectId, actor });
        if (!loaded.ok) return sendSessionRefusal(reply, request, loaded);
      }
      // Somebody who may not view other people's sessions sees the reminders of their own (one session they may view: all of it).
      const ownOnly = !query.sessionId && scope.ownOnly ? { userId: scope.userId } : {};
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
      const [runs, active] = await Promise.all([
        listReminders(reminderScope, {
          agentKey: agent.key,
          ...(query.sessionId ? { conversationId: query.sessionId } : {}),
          active: query.status !== 'all',
          ...ownOnly,
          limit,
        }),
        listReminders(reminderScope, { agentKey: agent.key, ...(query.sessionId ? { conversationId: query.sessionId } : {}), active: true, ...ownOnly, limit: 500 }),
      ]);
      const owners = await resolveSessionOwners(runs.map((run) => run.userId));
      const titles = await sessionTitles(session.tenantDbName, projectId, runs.map((run) => run.conversationId));
      return reply.code(200).send({
        reminders: runs.map((run) => {
          const owner = run.userId ? owners.get(run.userId) : undefined;
          const title = titles.get(run.conversationId);
          return { ...serializeReminder(run), ...(owner ? { owner } : {}), ...(title ? { session_title: title } : {}) };
        }),
        summary: { active: active.length },
        scope: { viewOthers: !scope.ownOnly },
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent reminders error', 'Failed to list reminders');
    }
  }));

  // The platform ceilings of agent reminders (env), for the Configure hints.
  app.get('/agents/reminder-limits', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      return reply.code(200).send({ limits: reminderPlatformLimits() });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent reminder limits error', 'Failed to read reminder limits');
    }
  }));

  /**
   * Sends one tiny completion to a model through the agent runtime's own path,
   * so a wrong provider key is caught on the Configure page instead of in the
   * agent's first session. Always 200: the check's own verdict is the body.
   */
  app.post('/agents/model-check', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.modelKey !== 'string' || !body.modelKey) {
        return reply.code(400).send({ error: 'modelKey is required' });
      }
      const result = await checkAgentModel(session.tenantDbName, session.tenantId, projectId, body.modelKey);
      return reply.code(200).send(result);
    } catch (error) {
      return sendRouteError(reply, error, 'Agent model check error', 'Failed to check the model');
    }
  }));

  /**
   * Validates a config without saving it — the stored draft, or the `config`
   * in the body (what the editor currently holds). The Configure page calls
   * this to mark broken fields before Save.
   */
  app.post('/agents/:agentId/validate', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const body = readJsonBody<Record<string, unknown>>(request);
      const config = body.config && typeof body.config === 'object'
        ? body.config as IAgentConfig
        : agent.config;
      const validation = await validateAgentConfig({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        config,
        agentKey: agent.key,
      });
      return reply.code(200).send({ valid: validation.errors.length === 0, ...validation });
    } catch (error) {
      return sendRouteError(reply, error, 'Validate agent config error', 'Failed to validate agent config');
    }
  }));

  // ── Sessions ─────────────────────────────────────────────────────────
  //
  // A Session is the conversation record, presented under the name the
  // Sessions page uses.

  app.get('/agents/:agentId/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;

      // Somebody who may not view other people's sessions of this agent lists only their own - cut in the
      // database, before the page, so a busy teammate cannot push theirs off it (one decision per request).
      const scope = await sessionListScope(request, { agent, projectId, actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      const { triggerId } = (request.query ?? {}) as { triggerId?: string };
      const sessions = triggerId
        ? await sessionsOfTrigger(session.tenantDbName, { tenantId: session.tenantId, projectId, agentKey: agent.key, triggerId, ...(scope.ownOnly ? { createdBy: scope.userId } : {}) })
        : await listConversations(session.tenantDbName, agent.key, {
          limit: 100,
          projectId,
          ...(scope.ownOnly ? { createdBy: scope.userId } : {}),
        });
      const reminderScope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      const [activeRuns, reminders] = await Promise.all([
        activeRunsBySession(session.tenantDbName, { tenantId: session.tenantId, projectId, agentKey: agent.key }),
        activeRemindersBySession(reminderScope, agent.key),
      ]);
      const owners = await resolveSessionOwners(sessions.map((entry) => entry.createdBy));
      // The "waiting for you" state is per viewer: asked of the engine for the sessions that wait, not guessed.
      const waiting = sessions.filter((entry) => entry.runtimeStatus === 'requires_action').slice(0, WAITING_ROWS_ANSWERABILITY_LIMIT);
      const answerable = new Map<string, Awaited<ReturnType<typeof answerabilityOfRow>>>();
      for (const entry of waiting) {
        answerable.set(String(entry._id), await answerabilityOfRow(request, session.tenantDbName, agent, entry, { tenantDbName: session.tenantDbName, projectId, userId: session.userId }));
      }
      // Summarised here rather than shipped whole: every record carries its
      // full transcript, and a hundred of those is megabytes of tool payloads
      // sent so the list can render a row count. The session PAGE fetches the
      // one transcript it actually shows.
      return reply.code(200).send({
        sessions: sessions.map((entry) => {
          const id = String(entry._id);
          const run = activeRuns.get(id);
          const due = reminders.get(id);
          return {
            ...summariseConversation(entry, owners.get(entry.createdBy), answerable.get(id), session.userId),
            ...(run ? { activeRun: run } : {}),
            ...(due ? { reminders: { active: due.active, nextAt: due.nextAt.toISOString() } } : {}),
          };
        }),
        // Whether this is everybody's sessions of the agent or only the caller's own.
        scope: { viewOthers: !scope.ownOnly },
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent sessions error', 'Failed to list sessions');
    }
  }));

  app.post('/agents/:agentId/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;

      const body = readJsonBody<Record<string, unknown>>(request);

      // Session context is stamped with the dashboard user's identity the same
      // way a per-message one is — `userId`/`source` stay server-owned, so a
      // client cannot start a session that claims to be someone else.
      const sessionContext = body.context && typeof body.context === 'object'
        ? buildRuntimeContextFromRequest(body.context, request.headers, {
          userId: session.userId,
          source: 'playground',
        })
        : undefined;

      // Optional spend budget for this session (`null` = none); absent = the agent's default.
      let budget: IAgentSessionBudget | null | undefined;
      if (body.budget === null) budget = null;
      else if (body.budget !== undefined) {
        const parsed = parseSessionBudget(body.budget);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.message });
        budget = parsed.budget;
      }

      const created = await createConversation(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        agent.key,
        typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined,
        { source: 'console', ...(sessionContext ? { runtimeContext: sessionContext } : {}) },
        budget,
      );
      return reply.code(201).send({ session: created });
    } catch (error) {
      return sendRouteError(reply, error, 'Create agent session error', 'Failed to create session');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      // Scope check, not just existence - a session id valid for a sibling agent (or project) in the same
      // tenant must 404 here too - and the caller's right to read what somebody else started.
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const { agent, session } = scoped;
      const found = scoped.conversation;

      // Whose it is, and which of its open requests THIS caller could answer (the page shows the server's
      // verdict instead of deriving one from the agent's setting and the viewer's role).
      const [owners, actions] = await Promise.all([
        resolveSessionOwners([found.createdBy]),
        openActionsOf(session.tenantDbName, String(found._id)),
      ]);
      const ability = await describeAnswerAbility(request, { tenantDbName: session.tenantDbName, conversation: found, actions, agent, actor: { tenantDbName: session.tenantDbName, projectId: scoped.projectId, userId: session.userId } });
      return reply.code(200).send({
        session: found,
        owner: owners.get(found.createdBy) ?? null,
        // The caller started it: nothing more than the route's own check was needed.
        ownSession: scoped.owner,
        pendingActions: withAnswerAbility(actions.map(toPublicPendingAction), ability),
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Get agent session error', 'Failed to load session');
    }
  }));

  // ── Session spend budget ──
  //
  // `{ budget: { maxCostUsd, onReach } | null }` adds, changes or removes the
  // session's budget. A paused session is continued with `…/continue` (Studio
  // calls this, then that).
  app.patch('/agents/:agentId/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.budget === undefined) {
        return reply.code(400).send({ error: 'budget is required: { maxCostUsd, onReach }, or null to remove it' });
      }
      const outcome = await updateSessionBudget({
        tenantDbName: scoped.session.tenantDbName,
        projectId: scoped.projectId,
        conversationId: String(scoped.conversation._id),
        budget: body.budget,
      });
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Session not found' });
      if (outcome.kind === 'invalid') return reply.code(400).send({ error: outcome.message });
      // `continuable`: the session was waiting on its budget with a turn left to carry on, so
      // `…/continue` now makes sense. False for a budget that stops (raise it and send a message),
      // for a session whose turn already ended with its answer, and for one that was not stopped.
      return reply.code(200).send({ session: outcome.conversation, continuable: outcome.wasBudgetPaused });
    } catch (error) {
      return sendRouteError(reply, error, 'Update session budget error', 'Failed to update the session budget');
    }
  }));

  /**
   * Stop: ends the session's running turn (what it had streamed is kept as the
   * answer, `cancelled`) and cancels the approvals/questions of a paused one.
   * Works for a turn started from anywhere — the playground, the API, a portal
   * — and on any node. Nothing to stop is a 200 with `cancelled: false`.
   */
  app.post('/agents/:agentId/sessions/:sessionId/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      // Ending an open approval is answering it "no": without that right the turn still stops, the approval stays.
      const verdict = await authorizeEndingOpenRequests(request, {
        tenantDbName: scoped.session.tenantDbName,
        conversation: scoped.conversation,
        agent: scoped.agent,
      });
      if (!verdict.allowed && verdict.unavailable) {
        return sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
      }
      const outcome = await cancelConversationTurn({
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        conversationId: String(scoped.conversation._id),
        agentKey: scoped.agent.key,
        requestedBy: scoped.session.userId,
        cancelActions: verdict.allowed,
      });
      return reply.code(200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, error, 'Cancel session turn error', 'Failed to stop the turn');
    }
  }));

  /**
   * Continue a session that stopped on its spend budget (after the budget was
   * raised): the agent carries on from where it stopped, with no new user
   * message. Without `?stream=1` the call returns when the turn has finished
   * (JSON); with it, the turn is an SSE stream in the same event format as
   * `/chat/stream`. A refusal (402, 409, 404) is a normal JSON response either
   * way: the stream only opens once there is a turn to report.
   */
  app.post('/agents/:agentId/sessions/:sessionId/continue', withApiRequestContext(async (request, reply) => {
    let scoped: Awaited<ReturnType<typeof requireScopedSession>>;
    try {
      // A turn in the session: its owner always may; anybody else must be allowed to change AND to view it.
      scoped = await requireScopedSession(request, reply, { need: 'continue' });
    } catch (error) {
      return sendRouteError(reply, error, 'Continue session error', 'Failed to continue the session');
    }
    if (!scoped) return reply;
    const conversationId = String(scoped.conversation._id);
    const source = scoped.conversation.metadata?.source;
    if (typeof source === 'string' && source !== 'console') {
      return reply.code(409).send({ error: `This session came in via ${source} and is read-only. Start a new session to test the agent.` });
    }
    const query = (request.query ?? {}) as Record<string, unknown>;
    const wantsStream = query.stream === '1' || query.stream === 'true';
    const body = readJsonBody<Record<string, unknown>>(request);

    const reservation = await reserveDashboardSession({
      session: scoped.session,
      projectId: scoped.projectId,
      agentKey: scoped.agent.key,
      conversationId,
      userMessage: '',
    });
    if (reservation === null) return reply.code(409).send(SESSION_BUSY_BODY);

    const stream = openLazyEventStream(reply, wantsStream);
    const unsubscribe = wantsStream
      ? sessionEventBus.subscribe(conversationId, (frame) => {
        if (frame.type === 'action.required') stream.send('action', frame.data, frame.seq);
        else if (frame.type.startsWith('session.status_')) stream.send('status', { type: frame.type, ...frame.data }, frame.seq);
      })
      : undefined;

    const watch = reservation
      ? watchTurnCancellation({
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        conversationId,
        runId: String(reservation.run._id),
      })
      : undefined;

    try {
      const continued = await executeAgentContinueLocal({
        ...(watch ? { signal: watch.signal } : {}),
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        agentKey: scoped.agent.key,
        conversationId,
        userId: scoped.session.userId,
        runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
          userId: scoped.session.userId,
          source: 'playground',
        }),
        continuation: {
          source: 'agent-playground',
          ...(typeof body.version === 'number' ? { version: body.version } : {}),
        },
        ...(wantsStream
          ? {
            onToolEvent: stream.live('tool', (event) => event),
            onTextChunk: stream.live('text', (text: string) => ({ text })),
            onReasoningChunk: stream.live('reasoning', (text: string) => ({ text })),
            onCompaction: stream.live('summary', (compaction) => compaction),
          }
          : {}),
      });
      if (wantsStream) {
        stream.start();
        stream.send('result', continued.result);
        stream.end();
        return reply;
      }
      return reply.code(200).send({ status: 'continued', result: continued.result });
    } catch (error) {
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      const resumeStatus = (error as { status?: unknown })?.status;
      if (stream.started()) {
        // The status line is long gone; the error travels as an event, like `/chat/stream`.
        stream.send('error', { error: classified.error.message, type: classified.error.type, code: classified.error.code });
        stream.end();
        return reply;
      }
      if (error instanceof AgentGuardrailBlockedError) {
        return sendAgentGuardrailBlock(reply, error);
      }
      if (classified.status >= 500) logger.error('Continue session error', { error });
      return sendProjectContextError(reply, error) ?? reply.code(
        typeof resumeStatus === 'number' && (error as Error).name === 'AgentResumeError' ? resumeStatus : classified.status,
      ).send({
        error: classified.error.message,
        type: classified.error.type,
        code: classified.error.code,
        ...(classified.error.spentUsd !== undefined ? { spentUsd: classified.error.spentUsd } : {}),
        ...(classified.error.maxCostUsd !== undefined ? { maxCostUsd: classified.error.maxCostUsd } : {}),
      });
    } finally {
      watch?.stop();
      unsubscribe?.();
      await reservation?.release();
    }
  }));

  app.delete('/agents/:agentId/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      // Deleting somebody else's session is acting on it: the owner always may, anybody else needs
      // `agent.session_manage_others`.
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      await deleteConversation(scoped.session.tenantDbName, String(scoped.conversation._id));
      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendRouteError(reply, error, 'Delete agent session error', 'Failed to delete session');
    }
  }));

  // ── Session event log + pending actions ──

  app.get('/agents/:agentId/sessions/:sessionId/events', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const body = await listSessionEvents(
        scoped.session.tenantDbName,
        String(scoped.conversation._id),
        (request.query ?? {}) as Record<string, unknown>,
      );
      return reply.code(200).send(body);
    } catch (error) {
      return sendRouteError(reply, error, 'List session events error', 'Failed to list session events');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId/events/stream', withApiRequestContext(async (request, reply) => {
    let scoped: Awaited<ReturnType<typeof requireScopedSession>>;
    try {
      scoped = await requireScopedSession(request, reply, { need: 'view' });
    } catch (error) {
      return sendRouteError(reply, error, 'Session event stream error', 'Failed to open the event stream');
    }
    if (!scoped) return reply;
    const conversationId = String(scoped.conversation._id);
    return streamSessionEvents(request, reply, scoped.session.tenantDbName, conversationId, 'dashboard', () => sessionStreamStillAllowed(request, conversationId, {
      agentKey: scoped.agent.key,
      agent: scoped.agent,
      projectId: scoped.projectId,
    }));
  }));

  // ── Feedback: what people said about this agent's answers ──
  //
  // Counts and reasons are for everyone who can read agents; the words people wrote (and
  // who wrote them) only for those who can change them (`canReadComments` says which).

  app.get('/agents/:agentId/sessions/:sessionId/feedback', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const canReadComments = await sessionHasAgentsPermission(scoped.session, 'write');
      const rows = await listSessionFeedback({
        tenantDbName: scoped.session.tenantDbName,
        projectId: scoped.projectId,
        conversationId: String(scoped.conversation._id),
        agentKey: scoped.agent.key,
      });
      return reply.code(200).send({
        feedback: rows.map((row) => {
          const view = toFeedbackView(row, { includeComment: canReadComments });
          return canReadComments ? view : { ...view, userId: undefined };
        }),
        canReadComments,
      });
    } catch (error) {
      if (error instanceof FeedbackError) return reply.code(error.status).send({ error: error.message, code: error.code });
      return sendRouteError(reply, error, 'List session feedback error', 'Failed to list feedback');
    }
  }));

  app.get('/agents/:agentId/feedback', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const filter = parseFeedbackFilter(request.query, agent.key, projectId);
      if ('error' in filter) return reply.code(400).send({ error: filter.error });
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const canReadComments = await sessionHasAgentsPermission(session, 'write');
      const page = await listAgentFeedback(session.tenantDbName, filter, {
        limit: Math.min(Math.max(Number(query.limit) || 25, 1), 100),
        skip: Math.max(Number(query.skip) || 0, 0),
      });
      return reply.code(200).send({
        items: page.items.map((row) => ({
          ...toFeedbackView(row, { includeComment: canReadComments }),
          conversationId: row.conversationId,
          agentVersion: row.agentVersion ?? null,
          ...(canReadComments ? {} : { userId: undefined }),
        })),
        total: page.total,
        canReadComments,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent feedback error', 'Failed to list feedback');
    }
  }));

  app.get('/agents/:agentId/feedback/summary', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const filter = parseFeedbackFilter(request.query, agent.key, projectId);
      if ('error' in filter) return reply.code(400).send({ error: filter.error });
      const summary = await summarizeAgentFeedback(session.tenantDbName, filter);
      return reply.code(200).send({ summary, days: feedbackDays(request.query) });
    } catch (error) {
      return sendRouteError(reply, error, 'Summarize agent feedback error', 'Failed to summarize feedback');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId/actions', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const body = await listConversationActions(
        scoped.session.tenantDbName,
        String(scoped.conversation._id),
        (request.query ?? {}) as Record<string, unknown>,
      );
      // What THIS caller could do with each open request, decided by the engine's own rule - the page shows it
      // instead of guessing from the agent's setting and the viewer's role.
      const ability = await describeAnswerAbility(request, {
        tenantDbName: scoped.session.tenantDbName,
        conversation: scoped.conversation,
        actions: await openActionsOf(scoped.session.tenantDbName, String(scoped.conversation._id)),
        agent: scoped.agent,
        actor: { tenantDbName: scoped.session.tenantDbName, projectId: scoped.projectId, userId: scoped.session.userId },
      });
      return reply.code(200).send({ actions: withAnswerAbility(body.actions, ability) });
    } catch (error) {
      return sendRouteError(reply, error, 'List session actions error', 'Failed to list session actions');
    }
  }));

  /**
   * Answer a pending approval / question and let the paused turn continue.
   *
   * Without `?stream=1` the call returns when the continuation has finished
   * (JSON). With it, the continuation is an SSE stream in the SAME event format
   * as `/chat/stream` (`tool`, `text`, `summary`, `result`, `error`, plus the
   * additive `action` / `status`), so a client renders it like any other turn.
   * A refusal (404, 403, 409, 410, 400) is a normal JSON response either way:
   * the stream only opens once there is a continuation to report.
   */
  app.post('/agents/:agentId/sessions/:sessionId/actions/:actionId/resolve', withApiRequestContext(async (request, reply) => {
    let scoped: Awaited<ReturnType<typeof requireScopedSession>>;
    try {
      // Who may answer is asked below, of the request itself: `agent.approve` for a tool approval, the session's
      // ownership for a question - not the "view / change somebody else's session" pair this loader asks.
      scoped = await requireScopedSession(request, reply, { need: 'none' });
    } catch (error) {
      return sendRouteError(reply, error, 'Resolve action error', 'Failed to resolve the request');
    }
    if (!scoped) return reply;

    const { actionId } = request.params as { actionId: string };
    const conversationId = String(scoped.conversation._id);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const wantsStream = query.stream === '1' || query.stream === 'true';
    const body = readJsonBody<Record<string, unknown>>(request);

    // The stream opens lazily; the continuation's first event starts it.
    let started = false;
    let closed = false;
    const pendingFrames: Array<() => void> = [];
    const write = (event: string, data: unknown, id?: number) => {
      if (closed) return;
      try {
        reply.raw.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };
    const startStream = () => {
      if (started || !wantsStream) return;
      started = true;
      applyStreamHeaders(reply);
      reply.raw.flushHeaders?.();
      reply.raw.on('close', () => { closed = true; });
      for (const frame of pendingFrames.splice(0)) frame();
    };
    const send = (event: string, data: unknown, id?: number) => {
      if (!wantsStream) return;
      if (!started) {
        pendingFrames.push(() => write(event, data, id));
        return;
      }
      write(event, data, id);
    };
    const live = <A extends unknown[]>(event: string, map: (...args: A) => unknown) => (...args: A) => {
      startStream();
      send(event, map(...args));
    };

    const unsubscribe = wantsStream
      ? sessionEventBus.subscribe(conversationId, (frame) => {
        if (frame.type === 'action.required') send('action', frame.data, frame.seq);
        else if (frame.type.startsWith('session.status_')) send('status', { type: frame.type, ...frame.data }, frame.seq);
      })
      : undefined;

    try {
      const outcome = await resolveAgentPendingAction({
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        conversationId,
        actionId,
        agentKey: scoped.agent.key,
        body,
        actor: dashboardActor(scoped),
        authorize: approvalAuthorizerFor(request, scoped.session.tenantDbName),
        mode: 'sync',
        runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
          userId: scoped.session.userId,
          source: 'playground',
        }),
        ...(wantsStream
          ? {
            stream: {
              onToolEvent: live('tool', (event) => event),
              onTextChunk: live('text', (text: string) => ({ text })),
              onReasoningChunk: live('reasoning', (text: string) => ({ text })),
              onCompaction: live('summary', (compaction) => compaction),
            },
          }
          : {}),
        audit: {
          ipAddress: request.ip,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        },
      });

      // The engine could not decide who may answer: 503 (never a 403), nothing was recorded.
      if (outcome.kind === 'unavailable') {
        return sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: outcome.decisionId });
      }
      const refusal = resolveRefusal(outcome);
      if (refusal) return reply.code(refusal.status).send(refusal.body);

      if (outcome.kind === 'pending') {
        return reply.code(200).send({ status: 'requires_action', pendingActions: outcome.pendingActions });
      }
      if (outcome.kind === 'resumed') {
        if (wantsStream) {
          startStream();
          send('result', outcome.result);
          if (!closed) reply.raw.end();
          return reply;
        }
        return reply.code(200).send({ status: 'resumed', result: outcome.result });
      }
      return reply.code(500).send({ error: 'Unexpected resolution outcome' });
    } catch (error) {
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      const resumeStatus = (error as { status?: unknown })?.status;
      if (started) {
        // The status line is long gone; the error travels as an event, like `/chat/stream`.
        send('error', { error: classified.error.message, type: classified.error.type, code: classified.error.code });
        if (!closed) reply.raw.end();
        return reply;
      }
      if (error instanceof AgentGuardrailBlockedError) {
        return sendAgentGuardrailBlock(reply, error);
      }
      logger.error('Resolve action error', { error });
      return sendProjectContextError(reply, error) ?? reply.code(
        typeof resumeStatus === 'number' && (error as Error).name === 'AgentResumeError' ? resumeStatus : classified.status,
      ).send({
        error: classified.error.message,
        type: classified.error.type,
        code: classified.error.code,
      });
    } finally {
      unsubscribe?.();
    }
  }));

  /**
   * The same run as `/chat`, reported as it happens.
   *
   * A playground that says only "working…" for forty seconds is asking the
   * operator to trust it. Tool calls are the interesting part of an agent
   * run — which tool, with what argument, how long — and they are precisely
   * what a request/response POST cannot show until it is too late to matter.
   *
   * SSE over POST (rather than EventSource, which is GET-only) because the
   * body carries the message, the session and the runtime context. The final
   * `result` event repeats what `/chat` would have returned, so the client's
   * completed-turn rendering is identical either way — this endpoint adds
   * visibility, it does not fork the contract.
   *
   * `executePlaygroundChatLocal` is called directly, NOT the queue-routing
   * `executePlaygroundChat`: the progress callback is a function and cannot
   * cross the job queue. A run that would have been routed to another node
   * runs here instead, which is the right trade for a dashboard-only debug
   * surface and the reason this is not the path production traffic takes.
   */
  app.post('/agents/:agentId/chat/stream', withApiRequestContext(async (request, reply) => {
    const turn = await prepareDashboardTurn(request, reply);
    if (!turn) return reply;

    // Agent-run quota (domain `agent`). This route runs the playground runtime
    // directly (below), bypassing the `executePlaygroundChat` wrapper that
    // counts every other caller, so it counts here — before the stream opens,
    // which lets an exhausted caller get a real 429 instead of an error event.
    const quotaCaller: AgentRunCaller = {
      tenantDbName: turn.run.tenantDbName,
      tenantId: turn.run.tenantId,
      projectId: turn.run.projectId,
      agentKey: turn.run.agentKey,
      userId: turn.run.runtimeContext?.userId,
      tokenId: turn.run.runtimeContext?.tokenId,
    };
    try {
      await enforceAgentRunQuota(quotaCaller);
    } catch (error) {
      await turn.reservation?.release();
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      return reply.code(classified.status).send({
        error: classified.error.message,
        type: classified.error.type,
        code: classified.error.code,
      });
    }

    applyStreamHeaders(reply);
    reply.raw.flushHeaders?.();

    // A stateless turn (no Session) has no run record for `…/cancel` to point at, so the client's
    // Stop is closing the stream: the run ends with what it had streamed. A Session turn keeps
    // running after a tab closes and is stopped through the session instead (`turnWatchFor`).
    const disconnect = typeof turn.run.conversationId === 'string' ? undefined : new AbortController();
    let closed = false;
    reply.raw.on('close', () => {
      closed = true;
      if (!reply.raw.writableEnded) disconnect?.abort();
    });
    const send = (event: string, data: unknown, id?: number) => {
      if (closed) return;
      try {
        reply.raw.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };

    // A run that fails or is aborted late has still spent its tokens (see runUsage.ts).
    const usage = createRunUsageSink();

    // Additive events for a Session turn, taken from the same log the
    // `/events` endpoints serve (`id:` = the event's seq): `action` when the
    // agent pauses for an approval or a question, `status` as the turn starts
    // and stops. The events above are unchanged; an older client ignores these.
    const unsubscribeSessionEvents = typeof turn.run.conversationId === 'string'
      ? sessionEventBus.subscribe(turn.run.conversationId, (frame) => {
        if (frame.type === 'action.required') send('action', frame.data, frame.seq);
        else if (frame.type.startsWith('session.status_')) send('status', { type: frame.type, ...frame.data }, frame.seq);
      })
      : undefined;

    const watch = turnWatchFor(turn);
    try {
      const result = await runWithUsageSink(usage, () => executePlaygroundChatLocal({
        ...turn.run,
        ...(watch ? { signal: watch.signal } : disconnect ? { signal: disconnect.signal } : {}),
        // A stateless call (Compare versions) carries its own earlier messages.
        history: readStatelessHistory(turn.body),
        onToolEvent: (event) => send('tool', event),
        onTextChunk: (text) => send('text', { text }),
        // The model's thinking as it happens (additive event: older clients ignore it).
        onReasoningChunk: (text) => send('reasoning', { text }),
        // The agent summarized its context mid-run: shown in the transcript
        // as it happens, not only once the turn is over.
        onCompaction: (compaction) => send('summary', compaction),
      }));

      settleAgentRun(quotaCaller, usage, result.usage?.totalTokens);
      send('result', result);
    } catch (error) {
      settleAgentRun(quotaCaller, usage);
      // The status line is long gone by now, so the error travels as an
      // event. A client that only listened for `result` would otherwise hang
      // until the socket closed and call it a network fault.
      if (error instanceof AgentGuardrailBlockedError) {
        logger.info('Agent playground stream blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
        send('error', { error: error.message, type: 'guardrail_block' });
      } else {
        logAgentRunFailure(logger, 'Agent playground stream error', error);
        const classified = classifyAgentRunError(error, { exposeInternal: true });
        send('error', { error: classified.error.message, type: classified.error.type, code: classified.error.code });
      }
    } finally {
      watch?.stop();
      unsubscribeSessionEvents?.();
      await turn.reservation?.release();
      if (!closed) reply.raw.end();
    }
    return reply;
  }));

  app.post('/agents/:agentId/chat', withApiRequestContext(async (request, reply) => {
    try {
      const turn = await prepareDashboardTurn(request, reply);
      if (!turn) return reply;
      const { body } = turn;

      let result: Awaited<ReturnType<typeof executePlaygroundChat>>;
      const watch = turnWatchFor(turn);
      try {
        result = await executePlaygroundChat({
          ...turn.run,
          ...(watch ? { signal: watch.signal } : {}),
          // Ignored server-side when conversationId is set (history loads from
          // the session instead) — still parsed so a stateless call (no
          // conversationId) keeps working exactly as before.
          history: readStatelessHistory(body),
        });
      } finally {
        watch?.stop();
        await turn.reservation?.release();
      }

      return reply.code(200).send(result);
    } catch (error) {
      // A guardrail block is logged at info, not error: it is the configured
      // outcome, and an error-level line per refused prompt would page for
      // policy working as written.
      if (error instanceof AgentGuardrailBlockedError) {
        logger.info('Agent playground chat blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
      } else {
        logAgentRunFailure(logger, 'Agent playground chat error', error);
      }
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      return sendAgentGuardrailBlock(reply, error)
        ?? sendProjectContextError(reply, error)
        ?? reply.code(classified.status).send({
          error: classified.error.message,
          type: classified.error.type,
          code: classified.error.code,
        });
    }
  }));
};
