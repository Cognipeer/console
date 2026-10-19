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
import { sessionModelChoice } from '@/lib/services/agents/agentModelSelection';
import {
  apiErrorBody,
  invalidRequestErrorBody,
  isBackgroundModeRequested,
  queueAgentRunContinue,
  resolveAgentRunLimits,
  runWithTenantDb,
  serializeAgentRun,
} from '@/lib/services/agents/agentRunService';
import {
  resolveAgentPendingAction,
  type ResolveOutcome,
} from '@/lib/services/agents/agentActionResolution';
import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { FeedbackError, recordMessageFeedback } from '@/lib/services/agents/agentFeedback';
import { normalizeClientResolveBody, toClientErrorBody, toClientPendingAction, toClientTranscriptMessage } from '@/lib/services/agents/clientWire';
import { messageIdOf } from '@/lib/services/agents/messageIds';
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
import { approvalAuthorizerFor } from './agent-approval-authz';
import {
  loadSessionForPrincipal,
  sendAuthorizationUnavailable,
  sendClientListUnavailable,
  sendClientSessionRefusal,
  sessionListScope,
  sessionStreamStillAllowed,
  type SessionNeed,
} from './agent-session-access';

const logger = createLogger('api:client-agent-sessions');

const INTERNAL_ERROR_BODY = apiErrorBody('api_error', 'Internal error', 'internal_error');
const NOT_FOUND_BODY = apiErrorBody('not_found_error', 'Session not found', 'session_not_found');
// The same 409 (type and code) as `agentRunConflictErrorBody()` on the Responses route.
const RUN_CONFLICT_BODY = apiErrorBody('agent_run_conflict', 'An active run (queued or running) already exists for this conversation.');

/**
 * The conversation `:conversationId` names, in the token's project, and the caller's right to it: the token's
 * owner who started it needs nothing beyond the route's own service check; anybody else needs
 * `agent.session_view_others` (`need: 'view'`) or `agent.session_manage_others` (`need: 'manage'`) - decided
 * by the policy engine as the token's owner, within the token's scope (agent-session-access.ts). `need: 'none'`
 * skips that question for the route that asks its own (answering a pending request). Null, with the 404 / 403 /
 * 503 already sent, when it is missing, in another project, or not the caller's to touch.
 */
async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ApiTokenContext,
  need: SessionNeed | 'none',
): Promise<IAgentConversation | null> {
  const { conversationId } = request.params as { conversationId: string };
  if (need === 'none') {
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
  const loaded = await loadSessionForPrincipal(request, conversationId, {
    need,
    projectId: ctx.projectId,
    actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
  });
  if (!loaded.ok) {
    sendClientSessionRefusal(reply, request, loaded);
    return null;
  }
  return loaded.conversation;
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
    ...(sessionModelChoice(conversation.metadata) ? { model: sessionModelChoice(conversation.metadata)!.modelKey } : {}),
    budget: publicSessionBudget(conversation),
    spent_usd: sessionSpentUsd(conversation),
  };
}

/**
 * What a list row reports as `spent_usd`: the stored running total. A list does
 * not load the transcript, so it cannot add up the turns of a session that
 * never kept a total (one that last ran before the total was kept): that is
 * `null` — unknown, not zero — and the session resource has the figure. A
 * session with no turns has spent nothing.
 */
export function listedSpentUsd(conversation: Pick<IAgentConversationListItem, 'spentUsd' | 'messageCount'>): number | null {
  if (typeof conversation.spentUsd === 'number' && Number.isFinite(conversation.spentUsd)) return roundUsd(conversation.spentUsd);
  return conversation.messageCount > 0 ? null : 0;
}

/**
 * A session in a list: the same fields without `pending_actions` (open one
 * session to see them) and with `message_count` in place of the transcript.
 */
function serializeSessionSummary(conversation: IAgentConversationListItem) {
  const spent = listedSpentUsd(conversation);
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

      // Somebody who may not view other people's sessions lists only their own - cut in the database, before the
      // page. One decision for the named agent; without one, the project's agents are asked (once per request).
      const named = agentKey ? await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId) : null;
      const scope = await sessionListScope(request, {
        agent: named,
        projectId: ctx.projectId,
        actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
      });
      const page = await listSessionPage(ctx.tenantDbName, {
        projectId: ctx.projectId,
        ...(agentKey ? { agentKey } : {}),
        ...(status ? { status } : {}),
        limit,
        ...(after ? { after } : {}),
        ...(scope.ownOnly ? { ownOnly: scope.ownOnly } : {}),
      });
      return reply.code(200).send({
        object: 'list',
        data: page.sessions.map(serializeSessionSummary),
        has_more: page.hasMore,
        next_cursor: page.nextCursor ?? null,
      });
    } catch (error) {
      // The engine that could not say which sessions the caller may see is a 503 to retry, not a failure of the list.
      const unavailable = sendClientListUnavailable(reply, request, error);
      if (unavailable) return unavailable;
      logger.error('Client agent session list error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Delete a session: its files, events and pending requests go with it ──
  app.delete('/client/v1/agents/sessions/:conversationId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx, 'manage');
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
      const conversation = await requireSession(request, reply, ctx, 'view');
      if (!conversation) return reply;
      const runtime = await describeSessionRuntime(ctx.tenantDbName, conversation);
      return reply.code(200).send(serializeSession(conversation, runtime));
    } catch (error) {
      logger.error('Client agent session get error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Transcript ──
  //
  // `GET .../messages` lists the session's messages oldest first (`?limit` 1-200, default 100; `?after=<index>` pages on).
  // A message's `attachments` carry each file's `origin` (`user_upload` | `agent_output`) and its `download_url`
  // (the session file content route), so a client that reloads history still shows the files an agent produced.
  app.get('/client/v1/agents/sessions/:conversationId/messages', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx, 'view');
      if (!conversation) return reply;
      const query = request.query as { limit?: string; after?: string };
      const limit = Math.min(Math.max(Math.floor(Number(query.limit)) || 100, 1), 200);
      const after = Number.isInteger(Number(query.after)) ? Number(query.after) : -1;
      const conversationId = String(conversation._id);
      const all = conversation.messages ?? [];
      const page = all
        .map((message, index) => ({ message, index }))
        .filter(({ index }) => index > after)
        .slice(0, limit + 1);
      const data = page.slice(0, limit).map(({ message, index }) =>
        toClientTranscriptMessage(conversationId, index, message, messageIdOf(conversationId, index, message)));
      return reply.code(200).send({ object: 'list', data, has_more: page.length > limit });
    } catch (error) {
      logger.error('Client agent session messages error', { error });
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
      const conversation = await requireSession(request, reply, ctx, 'manage');
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

      // A continuation runs in the background, with the run limits of this caller.
      const willResume = resume && conversation.runtimeStatus === 'budget_paused';
      const limits = willResume
        ? await resolveAgentRunLimits({
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
          ...(limits ? { limits } : {}),
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
      const conversation = await requireSession(request, reply, ctx, 'view');
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
      conversation = await requireSession(request, reply, ctx, 'view');
    } catch (error) {
      logger.error('Client agent session stream error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
    if (!conversation) return reply;
    const conversationId = String(conversation._id);
    return streamSessionEvents(request, reply, ctx.tenantDbName, conversationId, 'client', () => sessionStreamStillAllowed(request, conversationId, {
      projectId: ctx.projectId,
    }));
  }));

  // ── Answer a pending approval / question ──
  //
  // Body: `{decision, comment?, approvedArgs?, rememberForSession?}` for a tool
  // approval, `{answers, cancelled?}` for a question. The turn continues from
  // where it paused: inline (200, the Responses shape — which is
  // `requires_action` again if it paused again) or, with `background: true`,
  // as a run (202). Nothing is returned for a request someone else answered
  // first (409), that ran out of time (410), or that this caller may not answer (403).
  // ── Rating an answer ──
  //
  // `PUT .../messages/{message_id}/feedback` with `{ rating: "up" | "down", reasons?, comment? }` stores the person's
  // rating of one answer (one per person per answer; rating again replaces it) and `DELETE` withdraws it. The
  // message id is the `id` of the message item the response returned. Only the person the session belongs to may
  // rate its answers: the token's owner, or the end user a delegating token acts for. It is the same record, trace
  // event, audit entry and `feedback.recorded` webhook as a portal's thumbs, with `channel: "api"`.
  const rateAnswer = (withdraw: boolean) => withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireSession(request, reply, ctx, 'view');
      if (!conversation) return reply;
      const userId = String(ctx.tokenRecord.userId ?? '');
      if (!userId || conversation.createdBy !== userId) {
        return reply.code(403).send(apiErrorBody(
          'permission_error', 'Only the person who started a session can rate its answers.', 'not_session_owner',
        ));
      }
      const { messageId } = request.params as { messageId: string };
      const body = withdraw ? {} : readJsonBody<Record<string, unknown>>(request);
      if (!withdraw && body.rating !== 'up' && body.rating !== 'down') {
        return reply.code(400).send(apiErrorBody('invalid_request_error', '`rating` must be "up" or "down"', 'invalid_rating'));
      }
      const userAgent = request.headers['user-agent'];
      const result = await recordMessageFeedback({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        conversationId: String(conversation._id),
        message: { id: messageId },
        userId,
        ...(ctx.user?.email ? { email: ctx.user.email } : {}),
        channel: 'api',
        rating: withdraw ? null : (body.rating as 'up' | 'down'),
        ...(withdraw ? {} : { reasons: body.reasons, comment: body.comment }),
        audit: {
          ipAddress: request.ip,
          ...(typeof userAgent === 'string' ? { userAgent } : {}),
          ...(request.apiRequestId ? { requestId: request.apiRequestId } : {}),
        },
      });
      const base = {
        object: 'agent.message.feedback',
        session_id: String(conversation._id),
        message_id: result.messageId,
      };
      if (withdraw) return reply.code(200).send({ ...base, deleted: true });
      const stored = result.feedback!;
      return reply.code(result.created ? 201 : 200).send({
        ...base,
        rating: stored.rating,
        reasons: stored.reasons,
        comment: stored.comment ?? null,
        created_at: isoOrNull(stored.createdAt),
        updated_at: isoOrNull(stored.updatedAt),
      });
    } catch (error) {
      if (error instanceof FeedbackError) {
        return reply.code(error.status).send(apiErrorBody(error.status === 404 ? 'not_found_error' : 'invalid_request_error', error.message, error.code));
      }
      logger.error('Client agent message feedback error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  });
  app.put('/client/v1/agents/sessions/:conversationId/messages/:messageId/feedback', rateAnswer(false));
  app.delete('/client/v1/agents/sessions/:conversationId/messages/:messageId/feedback', rateAnswer(true));

  app.post('/client/v1/agents/sessions/:conversationId/actions/:actionId', withClientApiRequestContext(async (request, reply, ctx) => {
    let conversation: IAgentConversation | null;
    try {
      conversation = await requireSession(request, reply, ctx, 'none');
    } catch (error) {
      logger.error('Client agent action resolve error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
    if (!conversation) return reply;
    const { actionId } = request.params as { actionId: string };
    return resolveClientSessionAction(request, reply, ctx, conversation, actionId);
  }));
};

/**
 * Answers a pending approval / question of `conversation` (the caller has
 * already found it in the token's project) — the session actions route and the
 * runs API's `POST /runs/{id}/actions/{actionId}` (the run's session). The
 * engine decides whether this token may answer; an action of another session
 * is `action_not_found`.
 */
export async function resolveClientSessionAction(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ApiTokenContext,
  conversation: IAgentConversation,
  actionId: string,
): Promise<FastifyReply> {
  try {
    // `approved_args` / `remember_for_session` (snake_case, like the rest of the client API).
    const body = normalizeClientResolveBody(readJsonBody<Record<string, unknown>>(request));

    const limits = await resolveAgentRunLimits({
      quotaContext: {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        licenseType: ctx.tenant.licenseType as LicenseType,
        userId: ctx.tokenRecord.userId,
        tokenId: ctx.tokenRecord._id?.toString(),
      },
    });
    const background = isBackgroundModeRequested(getHeaderValue(request, 'x-cognipeer-background'), body);

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
        channel: 'api',
        ...(owner?.email ? { email: owner.email } : {}),
        ...(owner?.role ? { role: owner.role } : {}),
        ...(apiTokenId ? { apiTokenId } : {}),
      },
      // May this token answer? The engine decides, as the token's owner within the token's scope.
      authorize: approvalAuthorizerFor(request, ctx.tenantDbName),
      mode: background ? 'background' : 'sync',
      // A switched-off agent does not continue; the request stays open for when it is back on.
      requireActiveAgent: true,
      runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
        userId: ctx.tokenRecord.userId,
        tokenId: apiTokenId,
        source: 'api',
      }),
      // The same ceiling a synchronous /responses call has.
      ...(background ? {} : { cancellationCell: { deadlineAt: Date.now() + limits.syncWaitMs, cancelled: false } }),
      audit: {
        ipAddress: request.ip,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
      },
    });

    // The engine could not decide who may answer: 503 (never a 403), nothing was recorded.
    if (outcome.kind === 'unavailable') {
      return sendAuthorizationUnavailable(reply, request, 'client', { action: 'agent.approve', level: 'write', decisionId: outcome.decisionId });
    }
    const refusal = clientRefusal(outcome);
    if (refusal) return reply.code(refusal.status).send(refusal.body);

    if (outcome.kind === 'queued') return reply.code(202).send(serializeAgentRun(outcome.run));
    if (outcome.kind === 'pending') {
      return reply.code(200).send({
        // The paused run's response id (readable at GET /responses/{id}); a pause no run owns keeps the session's.
        id: `resp_${outcome.runId ?? String(conversation._id)}`,
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
    if (error instanceof AgentGuardrailBlockedError) return sendAgentGuardrailBlock(reply, error) ?? reply;
    const classified = logAgentRouteError(logger, 'Client agent action resolve error', error);
    const resumeStatus = (error as { status?: unknown })?.status;
    return reply.code(
      typeof resumeStatus === 'number' && (error as Error).name === 'AgentResumeError' ? resumeStatus : classified.status,
    ).send({ error: toClientErrorBody(classified.error) });
  }
}

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
      return {
        status: 403,
        body: apiErrorBody('permission_error', outcome.message, 'action_forbidden', outcome.decisionId ? { decision_id: outcome.decisionId } : undefined),
      };
    case 'invalid':
      return { status: 400, body: apiErrorBody('invalid_request_error', outcome.message, 'invalid_resolution') };
    case 'busy':
      return { status: 409, body: RUN_CONFLICT_BODY };
    case 'agent_inactive':
      return { status: 400, body: apiErrorBody('invalid_request_error', 'Agent is not active', 'agent_inactive') };
    default:
      return null;
  }
}
