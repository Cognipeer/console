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
  resolveAgentExecutionLimits,
  serializeAgentRun,
} from '@/lib/services/agents/agentRunService';
import {
  resolveAgentPendingAction,
  type ResolveOutcome,
} from '@/lib/services/agents/agentActionResolution';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
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

export const clientAgentSessionsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Runtime state: running / idle / waiting for an action ──
  app.get('/client/v1/agents/sessions/:conversationId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx);
      if (!conversation) return reply;
      const runtime = await describeSessionRuntime(ctx.tenantDbName, conversation);
      return reply.code(200).send({
        id: String(conversation._id),
        object: 'agent.session',
        agent: conversation.agentKey,
        runtime_status: runtime.runtimeStatus,
        stop_reason: runtime.stopReason,
        pending_actions: runtime.pendingActions,
        last_event_seq: runtime.lastEventSeq,
      });
    } catch (error) {
      logger.error('Client agent session get error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
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
