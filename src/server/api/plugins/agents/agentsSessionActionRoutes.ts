import type { FastifyInstance } from 'fastify';
import {
  isPlanLimitError,
  planLimitErrorBody,
  planLimitHeaders,
} from '@/lib/limits/errors';
// By path: the agents barrel does not export the error class.
import {
  AgentGuardrailBlockedError,
} from '@/lib/services/agents/agentService';
import {
  classifyAgentRunError,
} from '@/lib/services/agents/agentErrors';
import {
  buildRuntimeContextFromRequest,
} from '@/lib/services/runtimeContext';
import {
  sessionEventBus,
} from '@/lib/services/agents/sessionEvents';
import {
  resolveAgentPendingAction,
} from '@/lib/services/agents/agentActionResolution';
import {
  listConversationActions,
} from '../agent-session-events';
import {
  approvalAuthorizerFor,
  describeAnswerAbility,
  withAnswerAbility,
} from '../agent-approval-authz';
import {
  sendAuthorizationUnavailable,
} from '../agent-session-access';
import {
  readJsonBody,
  sendProjectContextError,
  withApiRequestContext,
} from '../../fastify-utils';
import {
  openLazySseStream,
} from '../../sseWire';
import {
  isOwnedAgent,
} from '@/lib/utils/ownedAgents';
import {
  getFlowsHost,
} from '@/enterprise/flows';
import {
  sendAgentGuardrailBlock,
} from '../agent-config-write';
import {
  requireScopedSession,
  logger,
  AGENT_SCOPED,
  sendRouteError,
  openActionsOf,
  dashboardActor,
  resolveRefusal,
} from './agentsRouteHelpers';
import { canSeeRawProviderErrors } from './agentsErrorVisibility';

export function registerAgentsSessionActionRoutes(app: FastifyInstance): void {
  app.get('/agents/:agentId/sessions/:sessionId/actions', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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
  app.post('/agents/:agentId/sessions/:sessionId/actions/:actionId/resolve', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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
    const stream = openLazySseStream(reply, wantsStream);
    const { send, live } = stream;
    const startStream = stream.start;

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
              onPlan: live('plan', (plan) => plan),
              onSubagent: live('subagent', (event) => event),
              onRunQueued: live('run.queued', (info) => info),
              onRunStarted: () => send('run.started', {}),
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
        // A flow step waiting on this agent's answer continues now (the sweeper would find it within a minute).
        if (isOwnedAgent(scoped.agent)) {
          await getFlowsHost()?.wakeAgentActionWaits(
            { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
            { flowId: scoped.agent.owner.flowId, sessionId: conversationId },
          ).catch((error) => logger.warn('Could not wake the flow run waiting on the agent', { error: error instanceof Error ? error.message : String(error) }));
        }
        if (wantsStream) {
          startStream();
          send('result', outcome.result);
          stream.end();
          return reply;
        }
        return reply.code(200).send({ status: 'resumed', result: outcome.result });
      }
      return reply.code(500).send({ error: 'Unexpected resolution outcome' });
    } catch (error) {
      const classified = classifyAgentRunError(error, { exposeInternal: await canSeeRawProviderErrors(request) });
      const resumeStatus = (error as { status?: unknown })?.status;
      if (stream.started()) {
        // The status line is long gone; the error travels as an event, like `/chat/stream`.
        send('error', isPlanLimitError(error) ? planLimitErrorBody(error) : { error: classified.error.message, type: classified.error.type, code: classified.error.code });
        stream.end();
        return reply;
      }
      if (error instanceof AgentGuardrailBlockedError) {
        return sendAgentGuardrailBlock(reply, error);
      }
      if (isPlanLimitError(error)) return reply.headers(planLimitHeaders(error)).code(error.status).send(planLimitErrorBody(error));
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
}
