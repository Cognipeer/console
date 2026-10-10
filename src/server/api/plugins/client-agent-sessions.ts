/**
 * Client-facing agent Session endpoints — the runtime state of a conversation
 * and its event log, for a client that was not holding the original request
 * (a reload, another device, a channel adapter).
 *
 * Like `/client/v1/agents/runs/:runId`, every route resolves the conversation
 * through the token's tenant AND project — never the tenant alone — so a token
 * cannot read a session belonging to another project, even with its id.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IAgentConversation } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getAgentByKey, getConversationById } from '@/lib/services/agents';
import {
  apiErrorBody,
  backgroundDisabledErrorBody,
  isBackgroundModeRequested,
  queueAgentRunContinue,
  resolveAgentExecutionLimits,
  serializeAgentRun,
} from '@/lib/services/agents/agentRunService';
import {
  resolveAgentPendingAction,
  type ResolveOutcome,
} from '@/lib/services/agents/agentActionResolution';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import { activeSessionBudget, clientBudgetViolation, parseSessionBudget, sessionSpentUsd } from '@/lib/services/agents/sessionBudget';
import { updateSessionBudget } from '@/lib/services/agents/sessionBudgetService';
import { AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import type { LicenseType } from '@/lib/license/license-manager';
import {
  describeSessionRuntime,
  listSessionEvents,
  streamSessionEvents,
} from './agent-session-events';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { getHeaderValue, readJsonBody, withClientApiRequestContext } from '../fastify-utils';
import { sendAgentGuardrailBlock } from './agent-config-write';

const logger = createLogger('api:client-agent-sessions');

const INTERNAL_ERROR_BODY = apiErrorBody('api_error', 'Internal error', 'internal_error');
const NOT_FOUND_BODY = apiErrorBody('not_found_error', 'Session not found', 'session_not_found');

/** The conversation `:conversationId` names, in the token's project; null (404 sent) otherwise. */
async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ApiTokenContext,
): Promise<IAgentConversation | null> {
  const { conversationId } = request.params as { conversationId: string };
  let found: IAgentConversation | null = null;
  try {
    found = await getConversationById(ctx.tenantDbName, conversationId);
  } catch {
    found = null;
  }
  if (!found || found.projectId !== ctx.projectId) {
    void reply.code(404).send(NOT_FOUND_BODY);
    return null;
  }
  return found;
}

/** The session's budget as the client API spells it, or null. */
export function publicSessionBudget(conversation: Pick<IAgentConversation, 'budget'>) {
  const budget = activeSessionBudget(conversation);
  return budget ? { max_cost_usd: budget.maxCostUsd, on_reach: budget.onReach } : null;
}

/** The session resource: its runtime state, budget and what it has spent. */
function serializeSession(conversation: IAgentConversation, runtime: Awaited<ReturnType<typeof describeSessionRuntime>>) {
  return {
    id: String(conversation._id),
    object: 'agent.session',
    agent: conversation.agentKey,
    runtime_status: runtime.runtimeStatus,
    stop_reason: runtime.stopReason,
    pending_actions: runtime.pendingActions,
    last_event_seq: runtime.lastEventSeq,
    budget: publicSessionBudget(conversation),
    spent_usd: sessionSpentUsd(conversation),
  };
}

export const clientAgentSessionsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Runtime state: running / idle / waiting for an action ──
  app.get('/client/v1/agents/sessions/:conversationId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx);
      if (!conversation) return reply;
      const runtime = await describeSessionRuntime(ctx.tenantDbName, conversation);
      return reply.code(200).send(serializeSession(conversation, runtime));
    } catch (error) {
      logger.error('Client agent session get error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Session spend budget ──
  //
  // `{ budget: { max_cost_usd, on_reach } | null, resume?: boolean }` adds,
  // changes or removes the session's budget (a new budget must exceed what the
  // session has already spent). A session paused on its budget is then
  // continued — without a new message — as a background run (202 with the run),
  // unless `resume` is false (default true).
  app.patch('/client/v1/agents/sessions/:conversationId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx);
      if (!conversation) return reply;
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.budget === undefined) {
        return reply.code(400).send(apiErrorBody(
          'invalid_request_error', 'budget is required: { max_cost_usd, on_reach }, or null to remove it', 'invalid_budget',
        ));
      }
      if (body.resume !== undefined && typeof body.resume !== 'boolean') {
        return reply.code(400).send(apiErrorBody('invalid_request_error', 'resume must be a boolean', 'invalid_request'));
      }
      const resume = body.resume !== false;

      // An agent whose admin set a session budget binds its API clients to it.
      const requestedBudget = body.budget === null ? null : parseSessionBudget(body.budget);
      if (requestedBudget === null || requestedBudget.ok) {
        const owningAgent = await getAgentByKey(ctx.tenantDbName, conversation.agentKey, ctx.projectId);
        const violation = clientBudgetViolation(
          owningAgent?.config,
          requestedBudget === null ? null : requestedBudget.budget,
          activeSessionBudget(conversation),
        );
        if (violation) return reply.code(403).send(apiErrorBody('permission_error', violation, 'budget_override_forbidden'));
      }

      // A continuation runs in the background: fail before changing anything if it cannot.
      const willResume = resume && conversation.runtimeStatus === 'budget_paused';
      const agent = willResume ? await getAgentByKey(ctx.tenantDbName, conversation.agentKey, ctx.projectId) : null;
      const limits = willResume
        ? await resolveAgentExecutionLimits({
          agentConfig: agent?.config,
          quotaContext: {
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            licenseType: ctx.tenant.licenseType as LicenseType,
            userId: ctx.tokenRecord.userId,
            tokenId: ctx.tokenRecord._id?.toString(),
          },
        })
        : null;
      if (limits && !limits.backgroundEnabled) return reply.code(400).send(backgroundDisabledErrorBody());

      const outcome = await updateSessionBudget({
        tenantDbName: ctx.tenantDbName,
        projectId: ctx.projectId,
        conversationId: String(conversation._id),
        budget: body.budget,
      });
      if (outcome.kind === 'not_found') return reply.code(404).send(NOT_FOUND_BODY);
      if (outcome.kind === 'invalid') {
        return reply.code(400).send(apiErrorBody('invalid_request_error', outcome.message, 'invalid_budget'));
      }

      if (willResume && outcome.wasBudgetPaused) {
        const apiTokenId = ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined;
        const queued = await queueAgentRunContinue({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          agentKey: conversation.agentKey,
          conversationId: String(conversation._id),
          userId: ctx.tokenRecord.userId,
          // Config the way /agents/responses runs it: the published version, else the draft.
          usePublished: true,
          runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
            userId: ctx.tokenRecord.userId,
            tokenId: apiTokenId,
            source: 'api',
          }),
          ...(apiTokenId ? { apiTokenId } : {}),
          actorType: 'api_token',
        });
        if (queued.kind === 'conflict') {
          return reply.code(409).send(apiErrorBody(
            'invalid_request_error',
            'An active run (queued or running) already exists for this conversation.',
            'agent_run_conflict',
          ));
        }
        return reply.code(202).send(serializeAgentRun(queued.run));
      }

      const runtime = await describeSessionRuntime(ctx.tenantDbName, outcome.conversation);
      return reply.code(200).send(serializeSession(outcome.conversation, runtime));
    } catch (error) {
      logger.error('Client agent session update error', { error });
      const classified = classifyAgentRunError(error);
      return reply.code(classified.status).send({ error: classified.error });
    }
  }));

  // ── Event log (poll) ──
  app.get('/client/v1/agents/sessions/:conversationId/events', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx);
      if (!conversation) return reply;
      const body = await listSessionEvents(
        ctx.tenantDbName,
        String(conversation._id),
        (request.query ?? {}) as Record<string, unknown>,
      );
      return reply.code(200).send({ object: 'list', ...body });
    } catch (error) {
      logger.error('Client agent session events error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Event log (SSE; resumes from Last-Event-ID or ?after=) ──
  app.get('/client/v1/agents/sessions/:conversationId/events/stream', withClientApiRequestContext(async (request, reply, ctx) => {
    let conversation: IAgentConversation | null;
    try {
      conversation = await requireSession(request, reply, ctx);
    } catch (error) {
      logger.error('Client agent session stream error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
    if (!conversation) return reply;
    return streamSessionEvents(request, reply, ctx.tenantDbName, String(conversation._id));
  }));

  // ── Answer a pending approval / question ──
  //
  // Body: `{decision, comment?, approvedArgs?, rememberForSession?}` for a tool
  // approval, `{answers, cancelled?}` for a question. The turn continues from
  // where it paused: inline (200, the Responses shape — which is
  // `requires_action` again if it paused again) or, with `background: true`,
  // as a run (202). Nothing is returned for a request someone else answered
  // first (409), that ran out of time (410), or that this caller may not answer (403).
  app.post('/client/v1/agents/sessions/:conversationId/actions/:actionId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx);
      if (!conversation) return reply;
      const { actionId } = request.params as { actionId: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      const agent = await getAgentByKey(ctx.tenantDbName, conversation.agentKey, ctx.projectId);
      const limits = await resolveAgentExecutionLimits({
        agentConfig: agent?.config,
        quotaContext: {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          licenseType: ctx.tenant.licenseType as LicenseType,
          userId: ctx.tokenRecord.userId,
          tokenId: ctx.tokenRecord._id?.toString(),
        },
      });
      const background = isBackgroundModeRequested(getHeaderValue(request, 'x-cognipeer-background'), body, 'sync');
      if (background && !limits.backgroundEnabled) {
        return reply.code(400).send(backgroundDisabledErrorBody());
      }

      const apiTokenId = ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined;
      const owner = ctx.user;
      const outcome = await resolveAgentPendingAction({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        conversationId: String(conversation._id),
        actionId,
        body,
        actor: {
          userId: ctx.tokenRecord.userId,
          isAdmin: owner?.role === 'owner' || owner?.role === 'admin' || owner?.role === 'project_admin',
          channel: 'api',
          ...(owner?.email ? { email: owner.email } : {}),
          ...(owner?.role ? { role: owner.role } : {}),
          ...(apiTokenId ? { apiTokenId } : {}),
        },
        mode: background ? 'background' : 'sync',
        runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
          userId: ctx.tokenRecord.userId,
          tokenId: apiTokenId,
          source: 'api',
        }),
        // The same ceiling a synchronous /responses call has.
        ...(background ? {} : { cancellationCell: { deadlineAt: Date.now() + limits.syncTimeoutMs, cancelled: false } }),
        audit: {
          ipAddress: request.ip,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        },
      });

      const refusal = clientRefusal(outcome);
      if (refusal) return reply.code(refusal.status).send(refusal.body);

      if (outcome.kind === 'queued') return reply.code(202).send(serializeAgentRun(outcome.run));
      if (outcome.kind === 'pending') {
        return reply.code(200).send({
          id: `resp_${String(conversation._id)}`,
          object: 'response',
          model: conversation.agentKey,
          output: [],
          status: 'requires_action',
          stop_reason: 'requires_action',
          required_action: { type: 'agent_actions', actions: outcome.pendingActions },
        });
      }
      if (outcome.kind === 'resumed') {
        const { _conversation_messages, ...responseBody } = outcome.response;
        void _conversation_messages;
        return reply.code(200).send(responseBody);
      }
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    } catch (error) {
      if (error instanceof AgentGuardrailBlockedError) return sendAgentGuardrailBlock(reply, error);
      logger.error('Client agent action resolve error', { error });
      const classified = classifyAgentRunError(error);
      const resumeStatus = (error as { status?: unknown })?.status;
      return reply.code(
        typeof resumeStatus === 'number' && (error as Error).name === 'AgentResumeError' ? resumeStatus : classified.status,
      ).send({ error: classified.error });
    }
  }));
};

/** The client-envelope refusal for a resolve that did not start a continuation, or null. */
function clientRefusal(outcome: ResolveOutcome): { status: number; body: unknown } | null {
  switch (outcome.kind) {
    case 'not_found':
      return { status: 404, body: apiErrorBody('not_found_error', 'Request not found', 'action_not_found') };
    case 'not_pending':
      return {
        status: 409,
        body: apiErrorBody('invalid_request_error', 'This request is no longer open', 'action_not_pending', { actionStatus: outcome.status }),
      };
    case 'expired':
      return { status: 410, body: apiErrorBody('invalid_request_error', 'This request has expired', 'action_expired') };
    case 'forbidden':
      return { status: 403, body: apiErrorBody('permission_error', outcome.message, 'action_forbidden') };
    case 'invalid':
      return { status: 400, body: apiErrorBody('invalid_request_error', outcome.message, 'invalid_resolution') };
    case 'busy':
      return { status: 409, body: apiErrorBody('invalid_request_error', 'An active run (queued or running) already exists for this conversation.', 'agent_run_conflict') };
    default:
      return null;
  }
}
