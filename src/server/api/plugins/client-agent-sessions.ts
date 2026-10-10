/**
 * Client-facing agent Session endpoints — start a session without a message,
 * list and delete sessions, and read the runtime state of a conversation and its
 * event log, for a client that was not holding the original request (a reload,
 * another device, a channel adapter).
 *
 * `POST /client/v1/agents/sessions` creates the (empty) session so files can be
 * uploaded to it before the first message; `POST /client/v1/agents/responses`
 * then continues it with `session_id`.
 *
 * Like `/client/v1/agents/runs/:runId`, every route resolves the conversation
 * through the token's tenant AND project — never the tenant alone — so a token
 * cannot read a session belonging to another project, even with its id.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentSessionRuntimeStatus, IAgentConversation, IAgentConversationListItem, IAgentSessionBudget } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { createConversation, deleteConversation, getAgentByKey, getConversationById } from '@/lib/services/agents';
import {
  apiErrorBody,
  backgroundDisabledErrorBody,
  invalidRequestErrorBody,
  isBackgroundModeRequested,
  queueAgentRunContinue,
  resolveAgentExecutionLimits,
  runWithTenantDb,
  serializeAgentRun,
} from '@/lib/services/agents/agentRunService';
import {
  resolveAgentPendingAction,
  type ResolveOutcome,
} from '@/lib/services/agents/agentActionResolution';
import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { normalizeClientResolveBody, toClientErrorBody, toClientPendingAction } from '@/lib/services/agents/clientWire';
import { activeSessionBudget, clientBudgetViolation, parseSessionBudget, roundUsd, sessionSpentUsd } from '@/lib/services/agents/sessionBudget';
import {
  SESSION_LIST_DEFAULT_LIMIT,
  SESSION_LIST_MAX_LIMIT,
  SESSION_RUNTIME_STATUSES,
  decodeSessionCursor,
  listSessionPage,
} from '@/lib/services/agents/sessionList';
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
// The same 409 (type and code) as `agentRunConflictErrorBody()` on the Responses route.
const RUN_CONFLICT_BODY = apiErrorBody('agent_run_conflict', 'An active run (queued or running) already exists for this conversation.');

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

// What a client may attach to a session as `metadata` (the OpenAI convention: small string pairs).
export const SESSION_METADATA_MAX_KEYS = 16;
export const SESSION_METADATA_MAX_KEY_LENGTH = 64;
export const SESSION_METADATA_MAX_VALUE_LENGTH = 512;
export const SESSION_TITLE_MAX_LENGTH = 200;

/** `metadata` of a create request: a flat map of short strings, or the reason it is not one. */
export function parseSessionMetadata(value: unknown): { ok: true; metadata: Record<string, string> } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, metadata: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'metadata must be an object of string values' };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SESSION_METADATA_MAX_KEYS) return { ok: false, message: `metadata can hold at most ${SESSION_METADATA_MAX_KEYS} keys` };
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > SESSION_METADATA_MAX_KEY_LENGTH) {
      return { ok: false, message: `metadata keys must be 1-${SESSION_METADATA_MAX_KEY_LENGTH} characters` };
    }
    if (typeof entry !== 'string') return { ok: false, message: `metadata.${key} must be a string` };
    if (entry.length > SESSION_METADATA_MAX_VALUE_LENGTH) {
      return { ok: false, message: `metadata.${key} must be at most ${SESSION_METADATA_MAX_VALUE_LENGTH} characters` };
    }
  }
  return { ok: true, metadata: Object.fromEntries(entries) as Record<string, string> };
}

/** What the client put in `metadata` when it created the session (kept apart from the server's own keys). */
function clientMetadataOf(conversation: Pick<IAgentConversation, 'metadata'>): Record<string, string> {
  const stored = conversation.metadata?.clientMetadata;
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, string> : {};
}

const isoOrNull = (value: Date | string | undefined) => (value ? new Date(value).toISOString() : null);

/** The session resource: its runtime state, budget and what it has spent. */
function serializeSession(conversation: IAgentConversation, runtime: Awaited<ReturnType<typeof describeSessionRuntime>>) {
  return {
    id: String(conversation._id),
    object: 'agent.session',
    agent: conversation.agentKey,
    title: conversation.title ?? null,
    created_at: isoOrNull(conversation.createdAt),
    updated_at: isoOrNull(conversation.updatedAt),
    metadata: clientMetadataOf(conversation),
    runtime_status: runtime.runtimeStatus,
    stop_reason: runtime.stopReason,
    pending_actions: runtime.pendingActions.map(toClientPendingAction),
    last_event_seq: runtime.lastEventSeq,
    budget: publicSessionBudget(conversation),
    spent_usd: sessionSpentUsd(conversation),
  };
}

/**
 * A session in a list: the same fields without `pending_actions` (open one
 * session to see them) and with `message_count` in place of the transcript.
 */
function serializeSessionSummary(conversation: IAgentConversationListItem) {
  const spent = typeof conversation.spentUsd === 'number' && Number.isFinite(conversation.spentUsd) ? roundUsd(conversation.spentUsd) : 0;
  return {
    id: String(conversation._id),
    object: 'agent.session',
    agent: conversation.agentKey,
    title: conversation.title ?? null,
    created_at: isoOrNull(conversation.createdAt),
    updated_at: isoOrNull(conversation.updatedAt),
    metadata: clientMetadataOf(conversation),
    message_count: conversation.messageCount,
    runtime_status: conversation.runtimeStatus ?? 'idle',
    stop_reason: conversation.stopReason ?? null,
    last_event_seq: conversation.lastEventSeq ?? 0,
    budget: publicSessionBudget(conversation),
    spent_usd: spent,
  };
}

export const clientAgentSessionsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Start a session: nothing runs, nothing is spent ──
  //
  // `{ agent, title?, metadata?, budget?, runtime_context? }`. The session belongs
  // to the token's owner and is marked `source: api`, like the first turn of
  // `POST /agents/responses` would. A client can upload files to it, then send the
  // first message with `session_id`.
  app.post('/client/v1/agents/sessions', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const body = readJsonBody<Record<string, unknown>>(request);
      const agentKey = typeof body.agent === 'string' ? body.agent.trim() : '';
      if (!agentKey) {
        return reply.code(400).send(invalidRequestErrorBody('agent is required: the key of the agent the session is for', 'invalid_request'));
      }
      let title: string | undefined;
      if (body.title !== undefined && body.title !== null) {
        if (typeof body.title !== 'string' || body.title.length > SESSION_TITLE_MAX_LENGTH) {
          return reply.code(400).send(invalidRequestErrorBody(`title must be text of at most ${SESSION_TITLE_MAX_LENGTH} characters`, 'invalid_request'));
        }
        title = body.title.trim() || undefined;
      }
      const metadata = parseSessionMetadata(body.metadata);
      if (!metadata.ok) return reply.code(400).send(invalidRequestErrorBody(metadata.message, 'invalid_metadata'));

      const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!agent) return reply.code(404).send(apiErrorBody('not_found_error', 'Agent not found', 'agent_not_found'));
      if (agent.status !== 'active') return reply.code(400).send(invalidRequestErrorBody('Agent is not active', 'agent_not_active'));

      // The same budget rules as the first turn of POST /agents/responses.
      let budget: IAgentSessionBudget | null | undefined;
      if (body.budget === null) budget = null;
      else if (body.budget !== undefined) {
        const parsed = parseSessionBudget(body.budget);
        if (!parsed.ok) return reply.code(400).send(invalidRequestErrorBody(parsed.message, 'invalid_budget'));
        budget = parsed.budget;
      }
      if (budget !== undefined) {
        const violation = clientBudgetViolation(agent.config, budget);
        if (violation) return reply.code(403).send(apiErrorBody('permission_error', violation, 'budget_override_forbidden'));
      }

      // A context entered once for the whole session, merged under every turn's own. Built from the
      // body alone: the HTTP headers of THIS request are not data to keep on the session.
      const apiTokenId = ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined;
      const sessionContext = body.runtime_context && typeof body.runtime_context === 'object'
        ? buildRuntimeContextFromRequest(body.runtime_context, {}, { userId: ctx.tokenRecord.userId, tokenId: apiTokenId, source: 'api' })
        : undefined;

      const created = await createConversation(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        ctx.tokenRecord.userId,
        agent.key,
        title,
        {
          source: 'api',
          ...(Object.keys(metadata.metadata).length > 0 ? { clientMetadata: metadata.metadata } : {}),
          ...(sessionContext ? { runtimeContext: sessionContext } : {}),
        },
        budget,
      );
      const runtime = await describeSessionRuntime(ctx.tenantDbName, created);
      return reply.code(201).send(serializeSession(created, runtime));
    } catch (error) {
      const classified = logAgentRouteError(logger, 'Client agent session create error', error);
      return reply.code(classified.status).send({ error: toClientErrorBody(classified.error) });
    }
  }));

  // ── List sessions: newest first, a cursor to the next page ──
  app.get('/client/v1/agents/sessions', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      let limit = SESSION_LIST_DEFAULT_LIMIT;
      if (query.limit !== undefined && query.limit !== '') {
        const parsed = Number(query.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > SESSION_LIST_MAX_LIMIT) {
          return reply.code(400).send(invalidRequestErrorBody(`limit must be a whole number from 1 to ${SESSION_LIST_MAX_LIMIT}`, 'invalid_limit'));
        }
        limit = parsed;
      }
      let after: { createdAt: Date; id: string } | undefined;
      if (typeof query.after === 'string' && query.after !== '') {
        const decoded = decodeSessionCursor(query.after);
        if (!decoded) return reply.code(400).send(invalidRequestErrorBody('after is not a cursor this API returned', 'invalid_cursor'));
        after = decoded;
      }
      let status: AgentSessionRuntimeStatus | undefined;
      if (typeof query.status === 'string' && query.status !== '') {
        if (!SESSION_RUNTIME_STATUSES.includes(query.status as AgentSessionRuntimeStatus)) {
          return reply.code(400).send(invalidRequestErrorBody(`status must be one of: ${SESSION_RUNTIME_STATUSES.join(', ')}`, 'invalid_status'));
        }
        status = query.status as AgentSessionRuntimeStatus;
      }
      const agentKey = typeof query.agent === 'string' && query.agent.trim() ? query.agent.trim() : undefined;

      const page = await listSessionPage(ctx.tenantDbName, {
        projectId: ctx.projectId,
        ...(agentKey ? { agentKey } : {}),
        ...(status ? { status } : {}),
        limit,
        ...(after ? { after } : {}),
      });
      return reply.code(200).send({
        object: 'list',
        data: page.sessions.map(serializeSessionSummary),
        has_more: page.hasMore,
        next_cursor: page.nextCursor ?? null,
      });
    } catch (error) {
      logger.error('Client agent session list error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Delete a session: its files, events and pending requests go with it ──
  app.delete('/client/v1/agents/sessions/:conversationId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx);
      if (!conversation) return reply;
      const conversationId = String(conversation._id);
      // A turn in flight would write its result into a session that no longer exists.
      const active = await runWithTenantDb(ctx.tenantDbName, (db) => db.listAgentRuns({
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        conversationId,
        status: ['queued', 'running'],
        limit: 1,
      }));
      if (active.length > 0) return reply.code(409).send(RUN_CONFLICT_BODY);
      const deleted = await deleteConversation(ctx.tenantDbName, conversationId);
      if (!deleted) return reply.code(404).send(NOT_FOUND_BODY);
      return reply.code(200).send({ id: conversationId, object: 'agent.session', deleted: true });
    } catch (error) {
      logger.error('Client agent session delete error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

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
          return reply.code(409).send(RUN_CONFLICT_BODY);
        }
        return reply.code(202).send(serializeAgentRun(queued.run));
      }

      const runtime = await describeSessionRuntime(ctx.tenantDbName, outcome.conversation);
      return reply.code(200).send(serializeSession(outcome.conversation, runtime));
    } catch (error) {
      const classified = logAgentRouteError(logger, 'Client agent session update error', error);
      return reply.code(classified.status).send({ error: toClientErrorBody(classified.error) });
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
        'client',
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
    return streamSessionEvents(request, reply, ctx.tenantDbName, String(conversation._id), 'client');
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
      // `approved_args` / `remember_for_session` (snake_case, like the rest of the client API).
      const body = normalizeClientResolveBody(readJsonBody<Record<string, unknown>>(request));

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
          required_action: { type: 'agent_actions', actions: outcome.pendingActions.map(toClientPendingAction) },
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
      const classified = logAgentRouteError(logger, 'Client agent action resolve error', error);
      const resumeStatus = (error as { status?: unknown })?.status;
      return reply.code(
        typeof resumeStatus === 'number' && (error as Error).name === 'AgentResumeError' ? resumeStatus : classified.status,
      ).send({ error: toClientErrorBody(classified.error) });
    }
  }));
};

/** The client-envelope refusal for a resolve that did not start a continuation, or null. */
function clientRefusal(outcome: ResolveOutcome): { status: number; body: unknown } | null {
  switch (outcome.kind) {
    case 'not_found':
      return { status: 404, body: apiErrorBody('not_found_error', 'Request not found', 'action_not_found') };
    case 'not_pending':
      // Told apart so a client can say what happened to it: answered elsewhere, cancelled (a new
      // message, a run cancel, the timeout policy), or timed out.
      if (outcome.status === 'cancelled') {
        return { status: 409, body: apiErrorBody('invalid_request_error', 'This request was cancelled', 'action_cancelled', { action_status: outcome.status }) };
      }
      if (outcome.status === 'expired') {
        return { status: 410, body: apiErrorBody('invalid_request_error', 'This request has expired', 'action_expired', { action_status: outcome.status }) };
      }
      return {
        status: 409,
        body: apiErrorBody('invalid_request_error', 'This request is no longer open', 'action_not_pending', { action_status: outcome.status }),
      };
    case 'expired':
      return { status: 410, body: apiErrorBody('invalid_request_error', 'This request has expired', 'action_expired') };
    case 'forbidden':
      return { status: 403, body: apiErrorBody('permission_error', outcome.message, 'action_forbidden') };
    case 'invalid':
      return { status: 400, body: apiErrorBody('invalid_request_error', outcome.message, 'invalid_resolution') };
    case 'busy':
      return { status: 409, body: RUN_CONFLICT_BODY };
    default:
      return null;
  }
}
