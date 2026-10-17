/**
 * The runs API (§5.1) — the canonical surface for agent runs: create (wait,
 * async, scheduled, deferred, streamed), list, queue, get (long-poll), cancel,
 * the run's event log (JSON + SSE) and its pending actions; plus the session
 * cancel (§5.2) and the Responses cancel routes.
 *
 * Every route resolves the run through the caller's tenantId AND projectId
 * (§12.11) — never tenantId alone — so a token cannot read or cancel a run
 * belonging to a different project in the same tenant, even if it knows or
 * guesses the run id. Errors use the client envelope `{ error: { type, message, code } }`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { AgentRunClass, IAgentConversation, IAgentRun } from '@/lib/database';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { cancelAgentRun, getAgentByKey, getAgentRunStatus, getConversationById } from '@/lib/services/agents';
import {
  MAX_RUN_SCHEDULE_AHEAD_MS,
  agentRunNotFoundErrorBody,
  apiErrorBody,
  idempotencyKeyConflictErrorBody,
  invalidRequestErrorBody,
  isAgentRunActive,
  listAgentRuns,
  lookupIdempotentAgentRun,
  normalizeAgentRunId,
  publicAgentRunId,
  runWithTenantDb,
  serializeAgentRun,
  startAgentRun,
  waitForAgentRun,
  type StartAgentRunExecution,
} from '@/lib/services/agents/agentRunService';
import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { assertQueuedTurnSpendAllowed } from '@/lib/services/agents/agentSpendLimits';
import { AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';
import { toClientErrorBody } from '@/lib/services/agents/clientWire';
import { namedFileIds } from '@/lib/services/agents/responseInputFiles';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
import { authorizationRefusalOf, getHeaderValue, readJsonBody, withClientApiRequestContext, withOpenAiApiRequestContext } from '../fastify-utils';
import { authz } from '@/lib/iam/routeAuthz';
import { authorizeEndingOpenRequests } from './agent-approval-authz';
import { sendAgentGuardrailBlock } from './agent-config-write';
import {
  authorizeInvocationTarget,
  checkSessionContinuable,
  invocationApiTokenId,
  invocationRuntimeContext,
  openAiEnvelopeOf,
  parseInvocationInput,
  parseInvocationReasoning,
  parseNewSessionBudget,
  parseInvocationResponseFormat,
  parseRunMetadata,
  prepareInvocationSession,
  readIdempotencyKey,
  resolveInvocationAgent,
  resolveInvocationCallback,
  resolveInvocationConfig,
  resolveInvocationInputs,
  resolveInvocationLimits,
  resolveInvocationModel,
  runOutcomeRefusal,
  sendRunAccepted,
} from './agent-invocation';
import { toAgentResponseObject } from './agent-response-object';
import { streamAgentRunAsResponses } from './agent-responses-stream';
import { listSessionEvents, streamSessionEvents } from './agent-session-events';
import {
  refuseSessionLinked,
  sendAuthorizationUnavailable,
  sendClientListUnavailable,
  sendClientSessionRefusal,
  sendOpenAiSessionRefusal,
  sessionListScope,
  sessionStreamStillAllowed,
  type SessionNeed,
} from './agent-session-access';
import { resolveClientSessionAction } from './client-agent-sessions';

const logger = createLogger('api:client-agent-runs');

const INTERNAL_ERROR_BODY = apiErrorBody('api_error', 'Internal error', 'internal_error');

const RUN_STATUSES: ReadonlyArray<IAgentRun['status']> = ['scheduled', 'queued', 'running', 'requires_action', 'succeeded', 'failed', 'canceled'];
const RUN_CHANNELS: ReadonlyArray<NonNullable<IAgentRun['channel']>> = ['runs', 'responses', 'chat_completions', 'a2a', 'routine'];
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
const LIST_MAX_METADATA_FILTERS = 3;

// ── Request parsing ──────────────────────────────────────────────────────

/** RFC 7240 `Prefer`: `wait=N` and `respond-async` (other preferences are ignored). */
export function parsePreferHeader(value: string | null | undefined): { wait?: number; respondAsync: boolean } {
  const out: { wait?: number; respondAsync: boolean } = { respondAsync: false };
  if (!value) return out;
  for (const raw of value.split(/[,;]/)) {
    const token = raw.trim().toLowerCase();
    if (token === 'respond-async') out.respondAsync = true;
    const wait = /^wait\s*=\s*"?(\d+)"?$/.exec(token);
    if (wait) out.wait = Number(wait[1]);
  }
  return out;
}

/** Unix seconds (number or numeric string) or an ISO-8601 date. */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000);
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return new Date(Number(text) * 1000);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `run_at` / `delay_seconds` → the scheduled start (undefined = now), at most 30 days ahead. */
export function parseRunSchedule(body: Record<string, unknown>, now = Date.now()): { notBefore?: Date } | { error: string; param: string } {
  const hasRunAt = body.run_at !== undefined && body.run_at !== null;
  const hasDelay = body.delay_seconds !== undefined && body.delay_seconds !== null;
  if (hasRunAt && hasDelay) return { error: 'send run_at or delay_seconds, not both', param: 'run_at' };
  let at: Date | undefined;
  if (hasDelay) {
    const delay = body.delay_seconds;
    if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0) {
      return { error: 'delay_seconds must be a whole number of seconds (0 or more)', param: 'delay_seconds' };
    }
    at = new Date(now + delay * 1000);
  } else if (hasRunAt) {
    const parsed = parseTimestamp(body.run_at);
    if (!parsed) return { error: 'run_at must be an ISO-8601 date or unix seconds', param: 'run_at' };
    at = parsed;
  }
  if (!at) return {};
  if (at.getTime() - now > MAX_RUN_SCHEDULE_AHEAD_MS) {
    return { error: `a run can be scheduled at most ${Math.round(MAX_RUN_SCHEDULE_AHEAD_MS / 86_400_000)} days ahead`, param: hasDelay ? 'delay_seconds' : 'run_at' };
  }
  // A time already past is "now".
  return at.getTime() > now ? { notBefore: at } : {};
}

/** Seconds to wait (body `wait`, query `?wait=`): a non-negative number; undefined when absent. */
function parseWaitSeconds(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** `metadata[key]=value` (flat query keys) or a parsed `metadata` object. */
function readMetadataFilter(query: Record<string, unknown>): Record<string, string> | { error: string } {
  const pairs: Record<string, string> = {};
  const nested = query.metadata;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) pairs[key] = String(value);
  }
  for (const [name, value] of Object.entries(query)) {
    const match = /^metadata\[(.+)\]$/.exec(name);
    if (match) pairs[match[1]] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  if (Object.keys(pairs).length > LIST_MAX_METADATA_FILTERS) return { error: `at most ${LIST_MAX_METADATA_FILTERS} metadata filters` };
  return pairs;
}

// ── Replies ──────────────────────────────────────────────────────────────

/** A run that may be finished: 200 with the run when it is not active, else 202 (Location + Retry-After). */
function sendRun(reply: FastifyReply, run: IAgentRun) {
  return isAgentRunActive(run) ? sendRunAccepted(reply, run) : reply.code(200).send(serializeAgentRun(run));
}

function sendClassifiedError(reply: FastifyReply, message: string, error: unknown) {
  if (error instanceof AgentGuardrailBlockedError) return sendAgentGuardrailBlock(reply, error) ?? reply;
  const classified = logAgentRouteError(logger, message, error);
  return reply.code(classified.status).send({ error: toClientErrorBody(classified.error) });
}

// ── Plugin ───────────────────────────────────────────────────────────────

export const clientAgentRunsApiPlugin: FastifyPluginAsync = async (app) => {
  /**
   * The run `:runId` names, in the token's project, and the caller's right to
   * its session: a run is a handle on its session (its `result` is the
   * answer), so reading it is reading the session (`view`) and acting on it is
   * acting on the session (`manage`). The token's owner who queued it, or who
   * started the session, needs nothing more. Null with the reply already sent.
   */
  const loadRun = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: ApiTokenContext,
    need: SessionNeed | 'none',
  ): Promise<IAgentRun | null> => {
    const { runId } = request.params as { runId: string };
    const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, runId);
    // A sync reservation is an internal lock row, not a run a caller owns.
    if (!run || run.mode === 'sync') {
      void reply.code(404).send(agentRunNotFoundErrorBody());
      return null;
    }
    if (need === 'none') return run;
    // (A session that is gone has nothing to protect; one the store cannot be asked about is a 503, not an allow.)
    const refusal = await refuseSessionLinked(request, run.conversationId, need, {
      actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
      alsoOwnedBy: [run.userId],
    });
    if (refusal) {
      sendClientSessionRefusal(reply, request, refusal);
      return null;
    }
    return run;
  };

  // ── Create ──
  //
  // Async-first: `wait` (seconds, default 0; `Prefer: wait=N`) holds the call
  // until the run finishes (200, the run) or the wait ends (202, the run, its
  // Location). `stream: true` answers with the turn as Responses SSE. The run
  // is queued (default class) or handed to the deferred dispatcher; a future
  // `run_at` / `delay_seconds` makes it `scheduled`.
  app.post('/client/v1/agents/:agentKey/runs', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { agentKey } = request.params as { agentKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const bad = (message: string, code: string) => reply.code(400).send(invalidRequestErrorBody(message, code));

      const target = await resolveInvocationAgent(reply, 'client', ctx, agentKey, body.version);
      if (!target) return reply;
      const { agent } = target;
      const input = parseInvocationInput(reply, 'client', agent, body.input, { allowEmpty: body.inputs !== undefined && body.inputs !== null });
      if (!input) return reply;

      let runClass: AgentRunClass = 'default';
      if (body.class !== undefined && body.class !== null) {
        if (body.class !== 'default' && body.class !== 'deferred') return bad('class must be "default" or "deferred"', 'invalid_class');
        runClass = body.class;
      }
      const schedule = parseRunSchedule(body);
      if ('error' in schedule) return bad(schedule.error, 'invalid_schedule');
      const stream = body.stream === true;
      if (body.stream !== undefined && typeof body.stream !== 'boolean') return bad('stream must be a boolean', 'invalid_request');
      if (body.on_disconnect !== undefined && body.on_disconnect !== 'continue' && body.on_disconnect !== 'cancel') {
        return bad('on_disconnect must be "continue" or "cancel"', 'invalid_request');
      }
      if (stream && (runClass === 'deferred' || schedule.notBefore)) {
        return bad('stream cannot be combined with class "deferred" or a scheduled start', 'invalid_request');
      }

      // `wait` in the body wins over `Prefer: wait=N`; `Prefer: respond-async` alone is wait 0.
      const prefer = parsePreferHeader(getHeaderValue(request, 'prefer'));
      const bodyWait = parseWaitSeconds(body.wait);
      if (bodyWait === null) return bad('wait must be a number of seconds (0 or more)', 'invalid_wait');
      const waitSeconds = bodyWait ?? (prefer.respondAsync ? 0 : prefer.wait ?? 0);

      const metadata = parseRunMetadata(body.metadata);
      if (!metadata.ok) return bad(metadata.message, 'invalid_metadata');
      const responseFormat = parseInvocationResponseFormat(reply, 'client', body.response_format, 'response_format');
      if (!responseFormat) return reply;
      const inputs = resolveInvocationInputs(reply, 'client', await resolveInvocationConfig(ctx, target), body.inputs);
      if (!inputs) return reply;

      // The session it continues (`session_id`), or a new one.
      let conversation: IAgentConversation | null = null;
      if (body.session_id !== undefined && body.session_id !== null) {
        if (typeof body.session_id !== 'string' || body.session_id.trim() === '') return bad('session_id must be a session id (a string)', 'invalid_request');
        const found = await getConversationById(ctx.tenantDbName, body.session_id.trim()).catch(() => null);
        if (!found || found.agentKey !== agent.key || found.projectId !== ctx.projectId) {
          return reply.code(404).send(apiErrorBody('not_found_error', 'session_id does not match a session of this agent', 'session_not_found'));
        }
        if (!await checkSessionContinuable(request, reply, 'client', ctx, agent, found)) return reply;
        conversation = found;
      } else if (input.userInput.files.some((file) => file.fileId)) {
        return bad(
          'file_id names a file already uploaded to a session: continue that session with session_id, or send file_data / image_url.',
          'attachment_not_found',
        );
      }

      let sessionBudget;
      if (!conversation) {
        const parsedBudget = parseNewSessionBudget(reply, 'client', agent, body.budget);
        if (!parsedBudget) return reply;
        sessionBudget = parsedBudget.budget;
      }
      const reasoning = parseInvocationReasoning(reply, 'client', body);
      if (!reasoning) return reply;
      const chosenModel = await resolveInvocationModel(request, reply, 'client', ctx, { target, body, conversation });
      if (!chosenModel) return reply;
      const limits = await resolveInvocationLimits(ctx);
      const idempotency = readIdempotencyKey(request, reply, 'client');
      if (!idempotency) return reply;
      const callbackBody = body.callback && typeof body.callback === 'object' && !Array.isArray(body.callback)
        ? body.callback as { url?: unknown; secret?: unknown }
        : body.callback === undefined || body.callback === null ? {} : null;
      if (!callbackBody) return bad('callback must be an object { url, secret? }', 'invalid_callback');
      const callback = await resolveInvocationCallback(reply, 'client', agent, callbackBody.url, callbackBody.secret);
      if (!callback) return reply;

      const waitMs = Math.min(waitSeconds * 1000, limits.syncWaitMs);
      if (bodyWait === undefined && (prefer.respondAsync || prefer.wait !== undefined)) {
        void reply.header('Preference-Applied', prefer.respondAsync ? 'respond-async' : `wait=${Math.round(waitMs / 1000)}`);
      }
      const ref = { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId };
      const idempotencyConversationScope = conversation ? String(conversation._id) : null;

      // A replayed request must not mint a fresh session first.
      if (idempotency.key) {
        const prior = await lookupIdempotentAgentRun({
          ...ref,
          agentKey: agent.key,
          userMessage: input.userMessage,
          idempotencyAttachments: namedFileIds(input.userInput.files),
          version: target.version,
          idempotencyKey: idempotency.key,
          idempotencyConversationScope,
        });
        if (prior.kind === 'conflict') return reply.code(409).send(idempotencyKeyConflictErrorBody());
        if (prior.kind === 'replay') {
          const settled = isAgentRunActive(prior.run) && waitMs > 0
            ? (await waitForAgentRun({ ...ref, runId: String(prior.run._id) }, waitMs)) ?? prior.run
            : prior.run;
          return isAgentRunActive(settled) ? sendRunAccepted(reply, settled) : reply.code(200).send(serializeAgentRun(settled));
        }
      }

      // A queued turn learns of an exhausted tenant spend limit here (429), before a session is created for it.
      if (!stream) {
        await assertQueuedTurnSpendAllowed({ ...ref, agentKey: agent.key, userId: ctx.tokenRecord.userId });
      }

      const prepared = await prepareInvocationSession(ctx, {
        agent,
        conversation,
        sessionBudget,
        ...(chosenModel.modelChoice ? { modelChoice: chosenModel.modelChoice } : {}),
        userInput: input.userInput,
      });
      const apiTokenId = invocationApiTokenId(ctx);
      const base = {
        ...ref,
        agentKey: agent.key,
        conversationId: prepared.conversationId,
        userMessage: input.userMessage,
        ...(prepared.attachments.length > 0 ? { attachments: prepared.attachments, idempotencyAttachments: prepared.namedAttachments } : {}),
        userId: ctx.tokenRecord.userId,
        ...(apiTokenId ? { apiTokenId } : {}),
        actorType: 'api_token' as const,
        ...(target.version !== undefined ? { version: target.version } : {}),
        usePublished: target.usePublished,
        runtimeContext: invocationRuntimeContext(request, ctx, body.runtime_context),
        responseFormat: responseFormat.format,
        inputs: inputs.inputs,
        runClass,
        channel: 'runs' as const,
        trigger: 'request' as const,
        metadata: metadata.metadata,
        callback: callback.url ? { url: callback.url, ...(callback.secret ? { secret: callback.secret } : {}) } : null,
        ...(idempotency.key ? { idempotencyKey: idempotency.key } : {}),
        idempotencyConversationScope,
        limits,
      };

      if (stream) {
        return await streamAgentRunAsResponses(reply, base, {
          cancelOnDisconnect: body.on_disconnect === 'cancel',
          modelKey: chosenModel.modelChoice?.modelKey,
          requestReasoning: reasoning.value,
          streamReasoning: true,
          object: { model: agent.key, ...(chosenModel.modelChoice ? { agentModel: chosenModel.modelChoice.modelKey } : {}) },
        });
      }

      const execution: StartAgentRunExecution = { kind: 'queued', ...(schedule.notBefore ? { notBefore: schedule.notBefore } : {}) };
      const outcome = await startAgentRun({ ...base, execution });
      const refusal = runOutcomeRefusal(outcome);
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      if (outcome.kind !== 'accepted' && outcome.kind !== 'replay') return reply.code(500).send(INTERNAL_ERROR_BODY);
      const run = outcome.run;
      const settled = waitMs > 0 && isAgentRunActive(run) && run.status !== 'scheduled'
        ? (await waitForAgentRun({ ...ref, runId: String(run._id) }, waitMs)) ?? run
        : run;
      return sendRun(reply, settled);
    } catch (error) {
      return sendClassifiedError(reply, 'Client agent run create error', error);
    }
  }));

  // ── List ──
  app.get('/client/v1/agents/runs', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const bad = (message: string, code: string) => reply.code(400).send(invalidRequestErrorBody(message, code));
      const text = (name: string) => (typeof query[name] === 'string' && (query[name] as string).trim() !== '' ? (query[name] as string).trim() : undefined);

      let limit = LIST_DEFAULT_LIMIT;
      if (query.limit !== undefined && query.limit !== '') {
        const parsed = Number(query.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > LIST_MAX_LIMIT) return bad(`limit must be a whole number from 1 to ${LIST_MAX_LIMIT}`, 'invalid_limit');
        limit = parsed;
      }
      let status: IAgentRun['status'][] | undefined;
      const statusText = text('status');
      if (statusText) {
        const values = statusText.split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = values.find((value) => !RUN_STATUSES.includes(value as IAgentRun['status']));
        if (unknown) return bad(`status must be one or more of: ${RUN_STATUSES.join(', ')}`, 'invalid_status');
        status = values as IAgentRun['status'][];
      }
      const runClass = text('class');
      if (runClass && runClass !== 'default' && runClass !== 'deferred') return bad('class must be "default" or "deferred"', 'invalid_class');
      const channel = text('channel');
      if (channel && !RUN_CHANNELS.includes(channel as NonNullable<IAgentRun['channel']>)) return bad(`channel must be one of: ${RUN_CHANNELS.join(', ')}`, 'invalid_channel');
      const metadata = readMetadataFilter(query);
      if ('error' in metadata) return bad(String(metadata.error), 'invalid_metadata');
      const range: { createdAfter?: Date; createdBefore?: Date } = {};
      for (const [name, key] of [['created_after', 'createdAfter'], ['created_before', 'createdBefore']] as const) {
        if (query[name] === undefined || query[name] === '') continue;
        const parsed = parseTimestamp(query[name]);
        if (!parsed) return bad(`${name} must be unix seconds or an ISO-8601 date`, 'invalid_date');
        range[key] = parsed;
      }
      const agentKey = text('agent');
      const after = text('after');

      // Somebody who may not view other people's sessions lists only the runs they started.
      const named = agentKey ? await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId) : null;
      const scope = await sessionListScope(request, {
        agent: named,
        projectId: ctx.projectId,
        actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
      });
      const rows = await listAgentRuns(ctx.tenantDbName, {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        excludeModes: ['sync'],
        ...(agentKey ? { agentKey } : {}),
        ...(text('session_id') ? { conversationId: text('session_id') } : {}),
        ...(status ? { status } : {}),
        ...(runClass ? { runClass: runClass as AgentRunClass } : {}),
        ...(text('routine_id') ? { routineId: text('routine_id') } : {}),
        ...(channel ? { channel: channel as NonNullable<IAgentRun['channel']> } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...range,
        ...(after ? { cursor: normalizeAgentRunId(after) } : {}),
        ...(scope.ownOnly ? { userId: scope.ownOnly.userId } : {}),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit).map(serializeAgentRun);
      return reply.code(200).send({
        object: 'list',
        data: page,
        first_id: page[0]?.id ?? null,
        last_id: page[page.length - 1]?.id ?? null,
        has_more: rows.length > limit,
      });
    } catch (error) {
      const unavailable = sendClientListUnavailable(reply, request, error);
      if (unavailable) return unavailable;
      logger.error('Client agent run list error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Queue visibility: tenant-wide counts per class, and the caller project's under `project` ──
  app.get('/client/v1/agents/runs/queue', withClientApiRequestContext(async (_request, reply, ctx) => {
    try {
      const cfg = getConfig().agent;
      const limits = await resolveInvocationLimits(ctx);
      const statuses: IAgentRun['status'][] = ['running', 'queued', 'scheduled'];
      const counts = await runWithTenantDb(ctx.tenantDbName, async (db) => {
        const count = (runClass: AgentRunClass, projectId?: string) => db.countAgentRunsByStatus(ctx.tenantId, {
          statuses, runClass, ...(projectId ? { projectId } : {}),
        });
        const [tenantDefault, tenantDeferred, projectDefault, projectDeferred, oldest] = await Promise.all([
          count('default'),
          count('deferred'),
          count('default', ctx.projectId),
          count('deferred', ctx.projectId),
          db.listQueuedDeferredAgentRuns(ctx.tenantId, { limit: 1, dueBefore: new Date() }),
        ]);
        return { tenantDefault, tenantDeferred, projectDefault, projectDeferred, oldest: oldest[0] ?? null };
      });
      const pick = (c: Record<string, number>) => ({ running: c.running ?? 0, queued: c.queued ?? 0, scheduled: c.scheduled ?? 0 });
      return reply.code(200).send({
        object: 'agent.run_queue',
        default: { ...pick(counts.tenantDefault), limit: limits.maxActivePerTenant },
        deferred: {
          ...pick(counts.tenantDeferred),
          running_limit: cfg.deferredMaxRunningPerTenant,
          queued_limit: cfg.deferredMaxQueuedPerTenant,
          oldest_queued_at: counts.oldest ? Math.floor(new Date(counts.oldest.notBefore ?? counts.oldest.createdAt ?? Date.now()).getTime() / 1000) : null,
        },
        project: {
          id: ctx.projectId,
          default: { ...pick(counts.projectDefault), ...(limits.maxActivePerProject > 0 ? { limit: limits.maxActivePerProject } : {}) },
          deferred: pick(counts.projectDeferred),
        },
      });
    } catch (error) {
      logger.error('Client agent run queue error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Get (status + result); `?wait=<s>` long-polls until it finishes, pauses or the wait ends ──
  app.get('/client/v1/agents/runs/:runId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const waitSeconds = parseWaitSeconds(query.wait);
      if (waitSeconds === null) return reply.code(400).send(invalidRequestErrorBody('wait must be a number of seconds (0 or more)', 'invalid_wait'));
      let run = await loadRun(request, reply, ctx, 'view');
      if (!run) return reply;
      if (waitSeconds && isAgentRunActive(run)) {
        const limits = await resolveInvocationLimits(ctx);
        run = (await waitForAgentRun({
          tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, runId: String(run._id),
        }, Math.min(waitSeconds * 1000, limits.syncWaitMs))) ?? run;
      }
      return reply.code(200).send(serializeAgentRun(run));
    } catch (error) {
      logger.error('Client agent run get error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Cancel (§4.7): queued/scheduled now, running cooperatively, paused settled; terminal 409 ──
  app.post('/client/v1/agents/runs/:runId/cancel', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { runId } = request.params as { runId: string };
      const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, runId);
      if (run && run.mode !== 'sync') {
        if (await refuseRunCancel(request, reply, ctx, run, 'client')) return reply;
      }
      const outcome = await cancelAgentRun({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, runId });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send(agentRunNotFoundErrorBody());
      }
      if (outcome.kind === 'already_terminal') {
        return reply.code(409).send(apiErrorBody(
          'agent_run_already_terminal',
          `Agent run is already ${outcome.run.status}; it cannot be canceled.`,
          'agent_run_already_terminal',
          { status: outcome.run.status },
        ));
      }
      return reply.code(200).send(serializeAgentRun(outcome.run));
    } catch (error) {
      logger.error('Client agent run cancel error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── The run's events: the session event log, only what this run wrote (`?after_seq=` / `?after=`) ──
  app.get('/client/v1/agents/runs/:runId/events', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const run = await loadRun(request, reply, ctx, 'view');
      if (!run) return reply;
      const query = { ...((request.query ?? {}) as Record<string, unknown>) };
      if (query.after === undefined && query.after_seq !== undefined) query.after = query.after_seq;
      const page = await listSessionEvents(ctx.tenantDbName, run.conversationId, query, 'client', { runId: String(run._id) });
      return reply.code(200).send({ object: 'list', run_id: publicAgentRunId(run), session_id: run.conversationId, ...page });
    } catch (error) {
      logger.error('Client agent run events error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── The same as SSE; resumes from Last-Event-ID or ?after_seq= ──
  app.get('/client/v1/agents/runs/:runId/events/stream', withClientApiRequestContext(async (request, reply, ctx) => {
    let run: IAgentRun | null;
    try {
      run = await loadRun(request, reply, ctx, 'view');
    } catch (error) {
      logger.error('Client agent run event stream error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
    if (!run) return reply;
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (query.after === undefined && query.after_seq !== undefined) query.after = query.after_seq;
    const conversationId = run.conversationId;
    return streamSessionEvents(
      request,
      reply,
      ctx.tenantDbName,
      conversationId,
      'client',
      () => sessionStreamStillAllowed(request, conversationId, { projectId: ctx.projectId }),
      { runId: String(run._id) },
    );
  }));

  // ── Answer a pending approval / question of the run (the session actions logic, on the run's session) ──
  app.post('/client/v1/agents/runs/:runId/actions/:actionId', withClientApiRequestContext(async (request, reply, ctx) => {
    let run: IAgentRun | null;
    let conversation: IAgentConversation | null = null;
    const { actionId } = request.params as { actionId: string };
    try {
      run = await loadRun(request, reply, ctx, 'none');
      if (!run) return reply;
      const owned = run;
      conversation = await getConversationById(ctx.tenantDbName, owned.conversationId).catch(() => null);
      const action = await runWithTenantDb(ctx.tenantDbName, (db) => db.findAgentPendingActionById(actionId)).catch(() => null);
      // The action must be one of this run's session (and of this run, when it says which run asked).
      if (!conversation || conversation.projectId !== ctx.projectId
        || !action || action.conversationId !== owned.conversationId
        || (action.runId && normalizeAgentRunId(action.runId) !== String(owned._id))) {
        return reply.code(404).send(apiErrorBody('not_found_error', 'Request not found', 'action_not_found'));
      }
    } catch (error) {
      logger.error('Client agent run action error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
    return resolveClientSessionAction(request, reply, ctx, conversation, actionId);
  }));

  // ── Stop a session's turn (§5.2): its running run stops, its paused run is settled ──
  //
  // An inline request (`/responses`, chat completions, A2A) holds its
  // connection until the answer is done, so the way to stop it is a second request
  // naming the session. The turn ends with what it had streamed as its answer
  // (`stop_reason: cancelled`) and the model call stops. Nothing running is a 200
  // with `cancelled: false`, not an error: a Stop that lands as the turn ends is normal.
  const cancelByConversation = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: { tenantDbName: string; tenantId: string; projectId: string; tokenRecord: { userId?: unknown } },
    conversationId: string,
  ) => {
    const conversation = await getConversationById(ctx.tenantDbName, conversationId).catch(() => null);
    if (!conversation || conversation.projectId !== ctx.projectId) return null;
    // Stopping a session is acting on it: the owner always may, anybody else needs `agent.session_manage_others`.
    const refusal = await refuseSessionLinked(request, conversationId, 'manage', {
      actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
    });
    if (refusal) return sendClientSessionRefusal(reply, request, refusal);
    // Ending an open approval is answering it "no": without that right the turn still stops, the approval stays.
    const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: ctx.tenantDbName, conversation });
    if (!verdict.allowed && verdict.unavailable) {
      return sendAuthorizationUnavailable(reply, request, 'client', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
    }
    return cancelConversationTurn({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      conversationId,
      cancelActions: verdict.allowed,
    });
  };
  const sessionNotFound = () => apiErrorBody('not_found_error', 'Session not found', 'session_not_found');

  app.post('/client/v1/agents/sessions/:conversationId/cancel', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const outcome = await cancelByConversation(request, reply, ctx, conversationId);
      if (!outcome) return reply.code(404).send(sessionNotFound());
      if (reply.sent || !('cancelled' in outcome)) return reply;
      return reply.code(200).send({
        object: 'agent.session.cancel',
        session_id: conversationId,
        cancelled: outcome.cancelled,
        run_ids: outcome.runIds.map((id) => `run_${normalizeAgentRunId(id)}`),
      });
    } catch (error) {
      logger.error('Client session cancel error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // The older name of the session cancel: same semantics, its original body.
  app.post('/client/v1/agents/conversations/:conversationId/cancel', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const outcome = await cancelByConversation(request, reply, ctx, conversationId);
      if (!outcome) return reply.code(404).send(agentRunNotFoundErrorBody());
      if (reply.sent || !('cancelled' in outcome)) return reply;
      return reply.code(200).send({ conversation_id: conversationId, cancelled: outcome.cancelled, run_ids: outcome.runIds });
    } catch (error) {
      logger.error('Client conversation cancel error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── OpenAI Responses: read and cancel a response (§5.3) ──
  //
  // A response is a run (`resp_<runId>`; the runs API's `run_<runId>` names the
  // same one), answered as the Response object in OpenAI's error envelope.
  const responseNotFound = (reply: FastifyReply, responseId: string) => reply.code(404).send({
    error: { message: `No response found with id '${responseId}'.`, type: 'invalid_request_error', param: null, code: 'response_not_found' },
  });
  const loadResponseRun = async (ctx: ApiTokenContext, responseId: string): Promise<IAgentRun | null> => {
    if (!responseId.startsWith('resp_') && !responseId.startsWith('run_')) return null;
    const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, normalizeAgentRunId(responseId));
    return run && run.mode !== 'sync' ? run : null;
  };

  // A stored response is an agent run: on /responses (open to models too) it needs the agents service.
  const getResponse = withOpenAiApiRequestContext(async (request, reply, ctx) => {
    try {
      const { responseId } = request.params as { responseId: string };
      const run = await loadResponseRun(ctx, responseId);
      if (!run) return responseNotFound(reply, responseId);
      await authorizeInvocationTarget(request, 'agent');
      const refusal = await refuseSessionLinked(request, run.conversationId, 'view', {
        actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
        alsoOwnedBy: [run.userId],
      });
      if (refusal) return sendOpenAiSessionRefusal(reply, request, refusal);
      return reply.code(200).send(toAgentResponseObject(run));
    } catch (error) {
      if (authorizationRefusalOf(error)) throw error;
      logger.error('Client response get error', { error });
      return reply.code(500).send(openAiEnvelopeOf(INTERNAL_ERROR_BODY));
    }
  });
  app.get('/client/v1/responses/:responseId', { config: authz.serviceAnyOf(['models', 'agents']) }, getResponse);
  app.get('/client/v1/agents/responses/:responseId', getResponse);

  // Cancel (§4.7) → the Response object (`cancelled`, or `in_progress` while a cooperative
  // cancel lands); an already finished one answers 200 with its final object, as OpenAI does.
  // A `resp_<conversationId>` from before responses were run-scoped still stops its session's turn.
  const cancelResponse = withOpenAiApiRequestContext(async (request, reply, ctx) => {
    try {
      const { responseId } = request.params as { responseId: string };
      const run = await loadResponseRun(ctx, responseId);
      // A run, or a legacy `resp_<conversationId>`: both are agent sessions.
      if (run || responseId.startsWith('resp_')) await authorizeInvocationTarget(request, 'agent');
      if (run) {
        if (await refuseRunCancel(request, reply, ctx, run, 'openai')) return reply;
        const outcome = await cancelAgentRun({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, runId: String(run._id) });
        if (outcome.kind === 'not_found') return responseNotFound(reply, responseId);
        return reply.code(200).send(toAgentResponseObject(outcome.run));
      }
      const conversationId = responseId.startsWith('resp_') ? responseId.slice(5) : undefined;
      const outcome = conversationId ? await cancelByConversation(request, reply, ctx, conversationId) : null;
      if (!outcome) return responseNotFound(reply, responseId);
      if (reply.sent || !('cancelled' in outcome)) return reply;
      return reply.code(200).send({ id: responseId, conversation_id: conversationId, cancelled: outcome.cancelled, run_ids: outcome.runIds });
    } catch (error) {
      if (authorizationRefusalOf(error)) throw error;
      logger.error('Client response cancel error', { error });
      return reply.code(500).send(openAiEnvelopeOf(INTERNAL_ERROR_BODY));
    }
  });
  app.post('/client/v1/responses/:responseId/cancel', { config: authz.serviceAnyOf(['models', 'agents']) }, cancelResponse);
  app.post('/client/v1/agents/responses/:responseId/cancel', cancelResponse);
};

/**
 * May this caller cancel `run`? Cancelling a run is acting on its session (the
 * owner always may, anybody else needs `agent.session_manage_others`), and a
 * run paused on an approval is ended by answering it "no", which takes the
 * right to answer it. True when refused (the reply is sent). A boolean, not the
 * reply: a reply is thenable, and awaiting one waits for it to be sent.
 */
async function refuseRunCancel(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ApiTokenContext,
  run: IAgentRun,
  dialect: 'client' | 'openai',
): Promise<boolean> {
  const refusal = await refuseSessionLinked(request, run.conversationId, 'manage', {
    actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
    alsoOwnedBy: [run.userId],
  });
  if (refusal) {
    if (dialect === 'openai') sendOpenAiSessionRefusal(reply, request, refusal);
    else sendClientSessionRefusal(reply, request, refusal);
    return true;
  }
  if (run.status !== 'requires_action') return false;
  const conversation = await getConversationById(ctx.tenantDbName, run.conversationId);
  if (!conversation || conversation.projectId !== ctx.projectId) return false;
  const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: ctx.tenantDbName, conversation });
  if (!verdict.allowed && verdict.unavailable) {
    sendAuthorizationUnavailable(reply, request, 'client', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
    return true;
  }
  if (verdict.allowed) return false;
  const body = apiErrorBody(
    'permission_error',
    'This run is waiting for an approval or an answer. You are not allowed to answer it, so you cannot cancel it.',
    'action_forbidden',
    verdict.decisionId ? { decision_id: verdict.decisionId } : undefined,
  );
  void reply.code(403).send(dialect === 'openai' ? openAiEnvelopeOf(body) : body);
  return true;
}
