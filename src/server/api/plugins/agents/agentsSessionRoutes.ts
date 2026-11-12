import type { FastifyInstance } from 'fastify';
import type {
  IAgentConversationActivityRow,
  IAgentSessionBudget,
} from '@/lib/database';
import {
  createConversation,
  deleteConversation,
  listConversations,
} from '@/lib/services/agents';
import {
  cancelConversationTurn,
} from '@/lib/services/agents/turnCancellation';
import {
  watchTurnCancellation,
} from '@/lib/services/agents/turnWatch';
import {
  acquireAgentSessionSlot,
  type AgentSessionSlot,
} from '@/lib/services/agents/agentSessionLease';
import {
  isPlanLimitError,
  planLimitErrorBody,
  planLimitHeaders,
} from '@/lib/limits/errors';
// By path: the agents barrel does not export the error class.
import {
  AgentGuardrailBlockedError,
  executeAgentContinueLocal,
} from '@/lib/services/agents/agentService';
import {
  parseSessionBudget,
} from '@/lib/services/agents/sessionBudget';
import {
  updateSessionBudget,
} from '@/lib/services/agents/sessionBudgetService';
import {
  classifyAgentRunError,
} from '@/lib/services/agents/agentErrors';
import {
  runWithTenantDb,
} from '@/lib/services/agents/agentRunService';
import {
  buildRuntimeContextFromRequest,
} from '@/lib/services/runtimeContext';
import {
  sessionEventBus,
} from '@/lib/services/agents/sessionEvents';
import {
  readSessionPlan,
} from '@/lib/services/agents/sessionPlan';
import {
  listSessionEvents,
  streamSessionEvents,
  toPublicPendingAction,
} from '../agent-session-events';
import {
  authorizeEndingOpenRequests,
  describeAnswerAbility,
  withAnswerAbility,
} from '../agent-approval-authz';
import {
  sendAuthorizationUnavailable,
  sessionListScope,
  sessionStreamStillAllowed,
  sessionsWithHiddenContent,
} from '../agent-session-access';
import {
  resolveSessionOwners,
} from '@/lib/services/agents/sessionOwners';
import {
  decodeActivityCursor,
  listProjectSessions,
  SESSION_LIST_MAX_LIMIT,
} from '@/lib/services/agents/sessionList';
import {
  isRunInFlight,
  isSessionActive,
  isSessionOngoing,
} from '@/lib/services/agents/sessionActivityState';
import {
  activeRemindersBySession,
} from '@/lib/services/agents/agentReminders';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../../fastify-utils';
import {
  sendAgentGuardrailBlock,
} from '../agent-config-write';
import {
  requireScopedAgent,
  requireScopedSession,
  logger,
  AGENT_SCOPED,
  sendRouteError,
  openActionsOf,
  answerabilityOfRow,
  reserveDashboardSession,
  SESSION_BUSY_BODY,
  openLazyEventStream,
  WAITING_ROWS_ANSWERABILITY_LIMIT,
  summariseConversation,
  type ActiveRunRow,
  activeRunsBySession,
  agentsOfSessions,
  sessionsOfTrigger,
} from './agentsRouteHelpers';

export function registerAgentsSessionRoutes(app: FastifyInstance): void {
  // ── Sessions ─────────────────────────────────────────────────────────
  //
  // A Session is the conversation record, presented under the name the
  // Sessions page uses.

  // Every agent's sessions of the project in one list (Agents → Sessions): `view=active` holds the ones in
  // progress or waiting on someone (running ones first; `hasMore` without a cursor says some were left out),
  // `view=all` pages through everything by last activity. Static, so it wins over `/agents/:agentId`.
  app.get('/agents/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const query = (request.query ?? {}) as { view?: unknown; limit?: unknown; cursor?: unknown };
      const view = query.view ?? 'all';
      if (view !== 'active' && view !== 'all') return reply.code(400).send({ error: 'view must be "active" or "all"' });
      const limit = query.limit === undefined ? 50 : typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number(query.limit) : 0;
      if (limit < 1 || limit > SESSION_LIST_MAX_LIMIT) {
        return reply.code(400).send({ error: `limit must be an integer between 1 and ${SESSION_LIST_MAX_LIMIT}` });
      }
      // The Active list is not paged, so it has no cursor to follow.
      let before: { updatedAt: Date; id: string } | undefined;
      if (view === 'all' && query.cursor !== undefined && query.cursor !== '') {
        const decoded = typeof query.cursor === 'string' ? decodeActivityCursor(query.cursor) : null;
        if (!decoded) return reply.code(400).send({ error: 'cursor is not valid' });
        before = decoded;
      }

      const { projectId, session } = await requireProjectContextForRequest(request);
      const actor = { tenantDbName: session.tenantDbName, projectId, userId: session.userId };
      // Without an agent: the viewer's scope across the project's agents (their own sessions, plus every
      // session of the agents they may view), applied in the database before the page is cut.
      const scope = await sessionListScope(request, { projectId, actor });

      const reminderScope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      // What each row is waiting on or running, best effort: the list itself never fails over it.
      const decoration = <T,>(what: string) => (error: unknown): Map<string, T> => {
        logger.warn(`Project sessions list: ${what} not shown`, { error: error instanceof Error ? error.message : String(error) });
        return new Map();
      };
      const [activeRuns, reminders] = await Promise.all([
        activeRunsBySession(session.tenantDbName, { tenantId: session.tenantId, projectId })
          .catch(decoration<ActiveRunRow>('active runs')),
        activeRemindersBySession(reminderScope)
          .catch(decoration<{ active: number; nextAt: Date }>('reminders')),
      ]);

      // Sessions with a run queued or running: their "running" status is not questioned (no stale-run lookup per row).
      const knownInFlight = new Set([...activeRuns].filter(([, run]) => isRunInFlight(run)).map(([id]) => id));

      let rows: IAgentConversationActivityRow[];
      let hasMore = false;
      let nextCursor: string | undefined;
      if (view === 'all') {
        ({ sessions: rows, hasMore, nextCursor } = await listProjectSessions(session.tenantDbName, { projectId, ownOnly: scope.ownOnly, limit, before, knownInFlight }));
      } else {
        // Running sessions and waiting ones are asked apart, so a crowd of waiting sessions (a status flip does not
        // bump `updatedAt`) cannot push a running one out of its query; plus the sessions with a run queued or
        // running that has not marked its session yet. A session whose turn died is read as idle and falls out below.
        const common = { projectId, ownOnly: scope.ownOnly, limit: SESSION_LIST_MAX_LIMIT, knownInFlight };
        const [running, waiting] = await Promise.all([
          listProjectSessions(session.tenantDbName, { ...common, runtimeStatuses: ['running'] }),
          listProjectSessions(session.tenantDbName, { ...common, runtimeStatuses: ['requires_action', 'budget_paused'] }),
        ]);
        const listed = new Set([...running.sessions, ...waiting.sessions].map((entry) => String(entry._id)));
        const unlisted = [...knownInFlight].filter((id) => !listed.has(id));
        const byRun = unlisted.length > 0
          ? await listProjectSessions(session.tenantDbName, { ...common, ids: unlisted.slice(0, SESSION_LIST_MAX_LIMIT) })
          : { sessions: [], hasMore: false };
        const stamp = (entry: IAgentConversationActivityRow) => new Date(entry.updatedAt ?? 0).getTime();
        const newestFirst = (a: IAgentConversationActivityRow, b: IAgentConversationActivityRow) => stamp(b) - stamp(a) || (String(a._id) < String(b._id) ? 1 : -1);
        const seen = new Set<string>();
        const active = [...running.sessions, ...byRun.sessions, ...waiting.sessions].filter((entry) => {
          const id = String(entry._id);
          if (seen.has(id)) return false;
          seen.add(id);
          return isSessionActive({ runtimeStatus: entry.runtimeStatus, activeRun: activeRuns.get(id) });
        });
        const isOngoing = (entry: IAgentConversationActivityRow) => isSessionOngoing({ runtimeStatus: entry.runtimeStatus, activeRun: activeRuns.get(String(entry._id)) });
        // Ongoing sessions are kept before waiting ones when the cap cuts, then everything is shown newest first.
        const ranked = [...active.filter(isOngoing).sort(newestFirst), ...active.filter((entry) => !isOngoing(entry)).sort(newestFirst)];
        rows = ranked.slice(0, SESSION_LIST_MAX_LIMIT).sort(newestFirst);
        // No cursor: the Active list is not paged, but it says when sessions were left out.
        hasMore = running.hasMore || waiting.hasMore || byRun.hasMore || unlisted.length > SESSION_LIST_MAX_LIMIT || ranked.length > SESSION_LIST_MAX_LIMIT;
      }

      const agents = await agentsOfSessions(session.tenantDbName, projectId, rows);
      rows = rows.filter((entry) => agents.has(entry.agentKey));
      const owners = await resolveSessionOwners(rows.map((entry) => entry.createdBy));
      const hidden = await sessionsWithHiddenContent(request, actor, rows);
      // The "waiting for you" state is per viewer: asked of the engine for the sessions that wait, not guessed.
      const waiting = rows.filter((entry) => entry.runtimeStatus === 'requires_action').slice(0, WAITING_ROWS_ANSWERABILITY_LIMIT);
      const answerable = new Map<string, Awaited<ReturnType<typeof answerabilityOfRow>>>();
      for (const entry of waiting) {
        answerable.set(String(entry._id), await answerabilityOfRow(request, session.tenantDbName, agents.get(entry.agentKey)!, entry, actor));
      }
      return reply.code(200).send({
        sessions: rows.map((entry) => {
          const id = String(entry._id);
          const agent = agents.get(entry.agentKey)!;
          const run = activeRuns.get(id);
          const due = reminders.get(id);
          return {
            ...summariseConversation(entry, owners.get(entry.createdBy), answerable.get(id), session.userId, hidden.has(id)),
            agentId: String(agent._id),
            agentKey: agent.key,
            agentName: agent.name,
            ...(run ? { activeRun: run } : {}),
            ...(due ? { reminders: { active: due.active, nextAt: due.nextAt.toISOString() } } : {}),
          };
        }),
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        // Everybody's sessions or only the caller's own; `partial` = their own plus those of the agents they may view.
        scope: {
          viewOthers: !scope.ownOnly,
          ...(scope.ownOnly && (scope.ownOnly.viewableAgentKeys?.length ?? 0) > 0 ? { partial: true } : {}),
        },
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List project sessions error', 'Failed to list sessions');
    }
  }));

  app.get('/agents/:agentId/sessions', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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
      // What each row is waiting on or running, best effort: the list itself never fails over it.
      const decoration = <T,>(what: string) => (error: unknown): Map<string, T> => {
        logger.warn(`Sessions list: ${what} not shown`, { agentKey: agent.key, error: error instanceof Error ? error.message : String(error) });
        return new Map();
      };
      const [activeRuns, reminders] = await Promise.all([
        activeRunsBySession(session.tenantDbName, { tenantId: session.tenantId, projectId, agentKey: agent.key })
          .catch(decoration<ActiveRunRow>('active runs')),
        activeRemindersBySession(reminderScope, agent.key)
          .catch(decoration<{ active: number; nextAt: Date }>('reminders')),
      ]);
      const owners = await resolveSessionOwners(sessions.map((entry) => entry.createdBy));
      const hidden = await sessionsWithHiddenContent(request, { tenantDbName: session.tenantDbName, userId: session.userId }, sessions);
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
            ...summariseConversation(entry, owners.get(entry.createdBy), answerable.get(id), session.userId, hidden.has(id)),
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

  app.post('/agents/:agentId/sessions', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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

  app.get('/agents/:agentId/sessions/:sessionId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      // Scope check, not just existence - a session id valid for a sibling agent (or project) in the same
      // tenant must 404 here too - and the caller's right to read what somebody else started.
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const { agent, session } = scoped;
      const found = scoped.conversation;

      // Whose it is, and which of its open requests THIS caller could answer (the page shows the server's
      // verdict instead of deriving one from the agent's setting and the viewer's role).
      const [owners, actions, plan] = await Promise.all([
        resolveSessionOwners([found.createdBy]),
        openActionsOf(session.tenantDbName, String(found._id)),
        // Where the agent's plan stands now (the newest version its turns recorded, else the carried state); null when it has none.
        runWithTenantDb(session.tenantDbName, (db) => readSessionPlan(db, found, agent.config)).catch(() => null),
      ]);
      const ability = await describeAnswerAbility(request, { tenantDbName: session.tenantDbName, conversation: found, actions, agent, actor: { tenantDbName: session.tenantDbName, projectId: scoped.projectId, userId: session.userId } });
      return reply.code(200).send({
        session: found,
        plan,
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
  app.patch('/agents/:agentId/sessions/:sessionId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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
  app.post('/agents/:agentId/sessions/:sessionId/cancel', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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
  app.post('/agents/:agentId/sessions/:sessionId/continue', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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

    // Plan limit (agent sessions): a continued dashboard turn is console-originated and takes a slot like a new one.
    let slot: AgentSessionSlot | undefined;
    try {
      slot = await acquireAgentSessionSlot({
        tenantId: scoped.session.tenantId,
        holderId: reservation ? String(reservation.run._id) : undefined,
        origin: 'console',
        signal: watch?.signal,
        onQueued: stream.live('run.queued', (info) => info),
        onStarted: () => stream.send('run.started', {}),
      });
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
            onPlan: stream.live('plan', (plan) => plan),
            onSubagent: stream.live('subagent', (event) => event),
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
        stream.send('error', isPlanLimitError(error) ? planLimitErrorBody(error) : { error: classified.error.message, type: classified.error.type, code: classified.error.code });
        stream.end();
        return reply;
      }
      if (error instanceof AgentGuardrailBlockedError) {
        return sendAgentGuardrailBlock(reply, error);
      }
      if (isPlanLimitError(error)) return reply.headers(planLimitHeaders(error)).code(error.status).send(planLimitErrorBody(error));
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
      await slot?.release();
      await reservation?.release();
    }
  }));

  app.delete('/agents/:agentId/sessions/:sessionId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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

  app.get('/agents/:agentId/sessions/:sessionId/events', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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

  app.get('/agents/:agentId/sessions/:sessionId/events/stream', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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
}
