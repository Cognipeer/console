import { agentShowsReasoning } from '@/lib/services/agents/agentReasoning';
import { shouldReturnReasoning } from '@/lib/services/models/reasoning';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AgentRunClass, AgentStatus, IAgentConfig, IAgentConversation, IAgentRun, IAgentSessionBudget } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createAgentRecord,
  deleteAgentRecord,
  getAgentByKey,
  getConversationById,
  listAgents,
  updateAgentRecord,
  getAgentRunStatus,
  isBackgroundModeRequested,
  agentRunConflictErrorBody,
  idempotencyKeyConflictErrorBody,
  agentRunConcurrencyLimitErrorBody,
} from '@/lib/services/agents';
import {
  isAgentRunActive,
  lookupIdempotentAgentRun,
  startAgentRun,
  waitForAgentRun,
  type StartAgentRunOutcome,
} from '@/lib/services/agents/agentRunService';
import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { toClientErrorBody } from '@/lib/services/agents/clientWire';
import { assertQueuedTurnSpendAllowed } from '@/lib/services/agents/agentSpendLimits';
import { namedFileIds } from '@/lib/services/agents/responseInputFiles';
import { describeAgentAttachments } from '@/lib/services/agents/agentAttachmentInfo';
// By path: the agents barrel does not export the error class.
import { AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';
import {
  authorizationRefusalOf,
  getApiTokenContextForRequest,
  getHeaderValue,
  readJsonBody,
  withClientApiRequestContext,
  withOpenAiApiRequestContext,
} from '../fastify-utils';
import { authz } from '@/lib/iam/routeAuthz';
import {
  connectedConfigForUpdate,
  normalizeA2aUpdate,
  pickAgentUpdateFields,
  prepareNewAgentConfig,
  publishValidatedAgent,
  redactAgent,
  sendAgentGuardrailBlock,
  validateNativeConfigUpdate,
} from './agent-config-write';
import { requestCanNameBucket } from './files-permission';
import { resolveConfigGuardrailBindings } from './guardrail-bindings';
import { advertisedModelsForRequest } from './agent-model-authz';
import { sendAuthorizationUnavailable } from './agent-session-access';
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
  resolveInvocationTarget,
  resolvePublishedAgentConfig,
  sendInvocationFailure,
} from './agent-invocation';
import { sendAgentResponseObject } from './agent-response-object';
import { inputsToJsonSchema } from '@/lib/services/agents/agentInputs';

const logger = createLogger('api:client-agents');

/**
 * `previous_response_id` → the run (or, for the oldest ids, the session) it
 * names. `resp_<runId>` is what every response is now (one run = one
 * response); `run_<runId>` is the runs API's id of the same run; a
 * `resp_<conversationId>` from before responses were run-scoped still names
 * its session. Null for anything else — an unrecognized prefix must 404, not
 * silently start a new conversation.
 */
function responseIdReference(responseId: string): { strippedId: string; kind: 'resp' | 'run' } | null {
  if (responseId.startsWith('resp_')) return { strippedId: responseId.slice(5), kind: 'resp' };
  if (responseId.startsWith('run_')) return { strippedId: responseId.slice(4), kind: 'run' };
  return null;
}

/**
 * The session a Responses request continues, named by `session_id` or its
 * OpenAI-style alias `conversation` (a string, or `{ id }`). Naming it twice is
 * fine as long as both say the same session.
 */
export function readSessionReference(body: Record<string, unknown>): { id?: string } | { error: string } {
  const named: string[] = [];
  if (body.session_id !== undefined && body.session_id !== null) {
    if (typeof body.session_id !== 'string' || body.session_id.trim() === '') return { error: 'session_id must be a session id (a string)' };
    named.push(body.session_id.trim());
  }
  if (body.conversation !== undefined && body.conversation !== null) {
    const raw = typeof body.conversation === 'object' && !Array.isArray(body.conversation)
      ? (body.conversation as { id?: unknown }).id
      : body.conversation;
    if (typeof raw !== 'string' || raw.trim() === '') return { error: 'conversation must be a session id, or an object { id }' };
    named.push(raw.trim());
  }
  if (named.length === 2 && named[0] !== named[1]) return { error: 'session_id and conversation name different sessions' };
  return named.length > 0 ? { id: named[0] } : {};
}

/** Responses parameters an agent does not take (its own config decides); listed back in `X-Cognipeer-Ignored-Params`. */
const AGENT_IGNORED_PARAMS = ['instructions', 'temperature', 'top_p', 'max_output_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'truncation'] as const;

const openAiFail = (
  reply: FastifyReply,
  status: number,
  message: string,
  code: string,
  options: { type?: string; param?: string; extra?: Record<string, unknown> } = {},
) => sendInvocationFailure(reply, 'openai', {
  status, type: options.type ?? 'invalid_request_error', message, code, ...(options.param ? { param: options.param } : {}), ...(options.extra ? { extra: options.extra } : {}),
});

/** The 409 / 429 a start outcome is refused with (OpenAI envelope), or null for a run. */
function openAiOutcomeRefusal(outcome: StartAgentRunOutcome): { status: number; body: unknown } | null {
  switch (outcome.kind) {
    case 'conflict':
      return { status: 409, body: openAiEnvelopeOf(agentRunConflictErrorBody()) };
    case 'idempotency_conflict':
      return { status: 409, body: openAiEnvelopeOf(idempotencyKeyConflictErrorBody()) };
    case 'concurrency_limit':
      return { status: 429, body: openAiEnvelopeOf(agentRunConcurrencyLimitErrorBody(outcome.limit, outcome.scope, outcome.runClass)) };
    default:
      return null;
  }
}

/**
 * `POST /client/v1/responses` (models and agents) and `POST
 * /client/v1/agents/responses` (agents only). An agent turn is a run (§4.1):
 * a plain call waits up to the window and answers 200 with the response, or
 * 202 with it `in_progress` while the run carries on; `background: true`
 * queues it (202 `queued`); `service_tier: "flex"` makes it a deferred run the
 * call waits on like a plain one. Both routes run the published version unless
 * the request pins `version: N` or asks for `"draft"`.
 */
function createResponsesHandler(agentsOnly: boolean) {
  return withOpenAiApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const model = body.model;
      if (typeof model !== 'string' || model.trim() === '') {
        return openAiFail(reply, 400, agentsOnly
          ? 'model is required and must contain the agent key'
          : 'model is required: a model key, an agent key or agent:<key>', 'missing_model', { param: 'model' });
      }

      const resolvedTarget = await resolveInvocationTarget(ctx, model, { agentsOnly });
      if (resolvedTarget.kind === 'not_found') {
        return openAiFail(reply, 404, `The model "${model}" does not exist in this project`, 'model_not_found', { param: 'model' });
      }
      // §5.8: agents for an agent target, models for a model target.
      await authorizeInvocationTarget(request, resolvedTarget.kind);
      if (resolvedTarget.kind === 'model') {
        return openAiFail(reply, 400, 'model targets are not supported on this route yet', 'model_target_unsupported', { param: 'model' });
      }

      const target = await resolveInvocationAgent(reply, 'openai', ctx, resolvedTarget.agentKey, body.version);
      if (!target) return reply;
      const { agent } = target;

      const ignored = AGENT_IGNORED_PARAMS.filter((name) => body[name] !== undefined && body[name] !== null);
      if (ignored.length > 0) void reply.header('X-Cognipeer-Ignored-Params', ignored.join(','));

      // The text, and the files (`input_file` / `input_image`) of the last user message.
      const input = parseInvocationInput(reply, 'openai', agent, body.input, { allowEmpty: body.inputs !== undefined && body.inputs !== null });
      if (!input) return reply;
      const { userInput, userMessage } = input;

      const metadata = parseRunMetadata(body.metadata);
      if (!metadata.ok) return openAiFail(reply, 400, metadata.message, 'invalid_metadata', { param: 'metadata' });
      const textFormat = body.text && typeof body.text === 'object' && !Array.isArray(body.text)
        ? (body.text as { format?: unknown }).format
        : undefined;
      const responseFormat = parseInvocationResponseFormat(reply, 'openai', textFormat, 'text.format');
      if (!responseFormat) return reply;
      const inputs = resolveInvocationInputs(reply, 'openai', await resolveInvocationConfig(ctx, target), body.inputs);
      if (!inputs) return reply;
      // `flex` is OpenAI's "cheaper, slower" tier: here the deferred class. Anything else runs as default.
      const runClass: AgentRunClass = body.service_tier === 'flex' ? 'deferred' : 'default';
      const background = isBackgroundModeRequested(getHeaderValue(request, 'x-cognipeer-background'), body);

      // The session this request continues: `previous_response_id`, or `session_id` / `conversation`.
      const sessionRef = readSessionReference(body);
      if ('error' in sessionRef) return openAiFail(reply, 400, sessionRef.error, 'invalid_request');
      const previousResponseId = typeof body.previous_response_id === 'string' ? body.previous_response_id : null;
      if (userInput.files.some((file) => file.fileId) && previousResponseId === null && sessionRef.id === undefined) {
        return openAiFail(
          reply,
          400,
          'file_id names a file already uploaded to a session: continue that session with session_id (or previous_response_id), or send file_data / image_url.',
          'attachment_not_found',
        );
      }

      let sessionConversation: IAgentConversation | null = null;
      // The idempotency hash must never depend on a conversation that is FRESH on
      // this attempt (a retry of "start a new conversation" gets a new one every
      // time); it is the session only when the request continues an existing one.
      let idempotencyConversationScope: string | null = null;
      let resolvedConversationId: string | undefined;
      if (previousResponseId !== null) {
        // Scoped on tenant AND project: the same agent key can exist in another project.
        const parsed = responseIdReference(previousResponseId);
        const run = parsed
          ? await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, parsed.strippedId)
          : null;
        resolvedConversationId = run ? run.conversationId : parsed?.kind === 'resp' ? parsed.strippedId : undefined;
        if (resolvedConversationId === undefined) {
          return openAiFail(reply, 404, 'previous_response_id does not match a response of this project', 'previous_response_not_found', { param: 'previous_response_id' });
        }
      }
      // With `previous_response_id` too they must agree: two different sessions is a mistake, not a choice.
      if (sessionRef.id !== undefined) {
        if (resolvedConversationId !== undefined && resolvedConversationId !== sessionRef.id) {
          return openAiFail(reply, 400, 'session_id and previous_response_id name different sessions: send one of them', 'session_conflict');
        }
        resolvedConversationId = sessionRef.id;
      }
      if (resolvedConversationId !== undefined) {
        const conversation = await getConversationById(ctx.tenantDbName, resolvedConversationId).catch(() => null);
        if (!conversation || conversation.agentKey !== agent.key || conversation.projectId !== ctx.projectId) {
          return sessionRef.id !== undefined && previousResponseId === null
            ? openAiFail(reply, 404, 'session_id does not match a session of this agent', 'session_not_found', { param: 'session_id' })
            : openAiFail(reply, 404, 'previous_response_id does not match a response of this agent', 'previous_response_not_found', { param: 'previous_response_id' });
        }
        // Access, an open approval/question, `cancel_pending` and a spent budget (agent-invocation.ts).
        if (!await checkSessionContinuable(request, reply, 'openai', ctx, agent, conversation)) return reply;
        sessionConversation = conversation;
        idempotencyConversationScope = resolvedConversationId;
      }

      // A spend budget for the session this request starts; a follow-up turn ignores the field
      // (that session's budget changes with PATCH /client/v1/agents/sessions/:id).
      let sessionBudget: IAgentSessionBudget | null | undefined;
      if (!sessionConversation) {
        const parsedBudget = parseNewSessionBudget(reply, 'openai', agent, body.budget);
        if (!parsedBudget) return reply;
        sessionBudget = parsedBudget.budget;
      }

      const reasoningRequest = parseInvocationReasoning(reply, 'openai', body);
      if (!reasoningRequest) return reply;
      const chosenModel = await resolveInvocationModel(request, reply, 'openai', ctx, { target, body, conversation: sessionConversation });
      if (!chosenModel) return reply;
      const { modelChoice } = chosenModel;
      const limits = await resolveInvocationLimits(ctx);
      const idempotency = readIdempotencyKey(request, reply, 'openai');
      if (!idempotency) return reply;
      const idempotencyKey = idempotency.key;
      // Accepted on any call; it fires only if the run ends up async (queued, or detached past the window).
      const callback = await resolveInvocationCallback(reply, 'openai', agent, body.callback_url, body.callback_secret);
      if (!callback) return reply;

      const objectOptions = {
        model,
        previousResponseId,
        ...(modelChoice ? { agentModel: modelChoice.modelKey } : {}),
        includeReasoning: shouldReturnReasoning(undefined, body),
      };
      const ref = { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId };
      const queued = background || runClass === 'deferred';
      // A plain (or flex) call waits up to the window on a run that is still going; `background` never waits.
      const settle = async (run: IAgentRun) => (!background && isAgentRunActive(run) && run.status !== 'scheduled'
        ? (await waitForAgentRun({ ...ref, runId: String(run._id) }, limits.syncWaitMs)) ?? run
        : run);

      // A replayed request must not mint a fresh conversation first — every
      // retry of "start a new conversation" would leave an orphan behind.
      if (idempotencyKey) {
        const prior = await lookupIdempotentAgentRun({
          ...ref,
          agentKey: agent.key,
          userMessage,
          idempotencyAttachments: namedFileIds(userInput.files),
          version: target.version,
          idempotencyKey,
          idempotencyConversationScope,
        });
        if (prior.kind === 'conflict') return reply.code(409).send(openAiEnvelopeOf(idempotencyKeyConflictErrorBody()));
        if (prior.kind === 'replay') return sendAgentResponseObject(reply, await settle(prior.run), objectOptions);
      }

      // A queued turn learns of an exhausted tenant spend limit here (429), before a session is created for it.
      if (queued) {
        await assertQueuedTurnSpendAllowed({ ...ref, agentKey: agent.key, userId: ctx.tokenRecord.userId });
      }

      // The session (new or continued), the model choice stored on it, the request's files as its files.
      const prepared = await prepareInvocationSession(ctx, {
        agent,
        conversation: sessionConversation,
        sessionBudget,
        ...(modelChoice ? { modelChoice } : {}),
        userInput,
      });
      const apiTokenId = invocationApiTokenId(ctx);
      const base = {
        ...ref,
        agentKey: agent.key,
        conversationId: prepared.conversationId,
        userMessage,
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
        channel: 'responses' as const,
        trigger: 'request' as const,
        metadata: metadata.metadata,
        callback: callback.url ? { url: callback.url, ...(callback.secret ? { secret: callback.secret } : {}) } : null,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        idempotencyConversationScope,
        limits,
      };

      const outcome = await startAgentRun(queued
        ? { ...base, execution: { kind: 'queued' } }
        : {
          ...base,
          ...(modelChoice ? { modelKey: modelChoice.modelKey } : {}),
          ...(reasoningRequest.value ? { requestReasoning: reasoningRequest.value } : {}),
          execution: { kind: 'inline', waitMs: limits.syncWaitMs, cancelOnDisconnect: false },
        });
      const refusal = openAiOutcomeRefusal(outcome);
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      if (outcome.kind === 'completed') {
        const { _conversation_messages, ...responseBody } = outcome.response;
        void _conversation_messages;
        return sendAgentResponseObject(reply, outcome.run, objectOptions, responseBody as unknown as Record<string, unknown>);
      }
      // `detached`: the window ended with the run still going — it continues; follow it with GET /responses/{id}.
      if (outcome.kind === 'detached') return sendAgentResponseObject(reply, outcome.run, objectOptions);
      if (outcome.kind === 'accepted' || outcome.kind === 'replay') {
        return sendAgentResponseObject(reply, await settle(outcome.run), objectOptions);
      }
      return openAiFail(reply, 500, 'Internal error', 'internal_error', { type: 'server_error' });
    } catch (error) {
      // A refused target is the wrapper's to answer (403 / 503, OpenAI envelope).
      if (authorizationRefusalOf(error)) throw error;
      if (error instanceof AgentGuardrailBlockedError) {
        // Info, not error: a refused prompt is policy working as configured.
        logger.info('Client agent response blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
        return sendAgentGuardrailBlock(reply, error);
      }
      // Which failure it was — a provider rejecting its key, a model that no
      // longer exists, a rate limit — instead of one opaque 500 for all. A
      // refusal the caller can act on (a spent budget, a pending approval) is
      // logged as such, without a stack; only a server fault is an error.
      const classified = logAgentRouteError(logger, 'Client agent responses error', error);
      return reply.code(classified.status).send(openAiEnvelopeOf({ error: toClientErrorBody(classified.error) }));
    }
  });
}

export const clientAgentsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/agents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: AgentStatus };
      const agents = await listAgents(ctx.tenantDbName, {
        ...(query.status ? { status: query.status } : {}),
        projectId: ctx.projectId,
      });

      // Only agents that list additional models are asked about them (one policy check per extra model).
      const modelsByAgent = new Map<string, Awaited<ReturnType<typeof advertisedModelsForRequest>>>();
      await Promise.all(agents.filter((agent) => agent.config.additionalModels?.length).map(async (agent) => {
        const models = await advertisedModelsForRequest(request, { agent, tenantDbName: ctx.tenantDbName, projectId: ctx.projectId }).catch(() => undefined);
        if (models) modelsByAgent.set(agent.key, models);
      }));

      return reply.code(200).send({
        agents: agents.map((agent) => ({
          ...(modelsByAgent.has(agent.key) ? { models: modelsByAgent.get(agent.key) } : {}),
          config: {
            maxTokens: agent.config.maxTokens,
            modelKey: agent.config.modelKey,
            temperature: agent.config.temperature,
            topP: agent.config.topP,
            // false: the agent hides its reasoning text (agent-server / chat-ui honour it).
            showReasoning: agentShowsReasoning(agent.config),
          },
          createdAt: agent.createdAt,
          description: agent.description,
          key: agent.key,
          name: agent.name,
          status: agent.status,
        })),
      });
    } catch (error) {
      logger.error('List client agents error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/agents/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      // The config API callers run: the published version (the draft while nothing is published).
      const runConfig = await resolvePublishedAgentConfig(ctx.tenantDbName, agent, ctx.projectId);

      // The models a caller may pick, when the agent offers more than its main one (those they may not use are left out).
      const models = !agent.config.additionalModels?.length ? undefined : await advertisedModelsForRequest(request, {
        agent: { ...agent, config: runConfig },
        tenantDbName: ctx.tenantDbName,
        projectId: ctx.projectId,
      }).catch(() => undefined);

      // What a client needs to decide whether to offer an attach button (and to warn about an image).
      const attachments = await describeAgentAttachments({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        config: agent.config,
      }).catch(() => null);

      return reply.code(200).send({
        agent: {
          config: {
            maxTokens: agent.config.maxTokens,
            modelKey: agent.config.modelKey,
            temperature: agent.config.temperature,
            topP: agent.config.topP,
            // false: the agent hides its reasoning text (agent-server / chat-ui honour it).
            showReasoning: agentShowsReasoning(agent.config),
          },
          createdAt: agent.createdAt,
          description: agent.description,
          key: agent.key,
          name: agent.name,
          status: agent.status,
          // The agent as a typed function: what `inputs` it takes and the shape of its structured answer (null = none).
          input_schema: inputsToJsonSchema(runConfig.inputs),
          output_schema: runConfig.structuredOutput?.enabled && runConfig.structuredOutput.schema ? runConfig.structuredOutput.schema : null,
          ...(models ? { models } : {}),
          ...(attachments ? {
            attachments: {
              enabled: attachments.enabled,
              max_files: attachments.maxFiles,
              max_file_size_mb: attachments.maxFileSizeMb,
              allowed_mime_types: attachments.allowedMimeTypes,
              accepts_images: attachments.acceptsImages,
              // Files the agent writes for the person (session_files_create): off, or on with its limits and types.
              outputs: {
                enabled: attachments.outputs.enabled,
                max_files_per_turn: attachments.outputs.maxFilesPerTurn,
                max_file_size_mb: attachments.outputs.maxFileSizeMb,
                types: attachments.outputs.types,
              },
            },
          } : {}),
        },
      });
    } catch (error) {
      logger.error('Get client agent error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Both run the published version by default (`version: "draft"` asks for the draft);
  // /agents/responses is the agents-only alias, /responses resolves models and agents (§1.2).
  app.post('/client/v1/agents/responses', createResponsesHandler(true));
  app.post('/client/v1/responses', { config: authz.serviceAnyOf(['models', 'agents']) }, createResponsesHandler(false));

  // ── Authoring: create an agent definition ──
  app.post('/client/v1/agents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'Agent name is required' });
      }

      // Guardrail bindings, validated exactly as the dashboard route validates
      // them. No `user`: a token is scoped to its project, so a guardrail owned
      // by another project is out of reach and only a tenant-wide one (no
      // projectId) falls back.
      const prepared = await prepareNewAgentConfig(body.config, {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId }, bucketKey),
      });
      if ('forbidden' in prepared) return reply.code(403).send(prepared.forbidden);
      if ('badRequest' in prepared) return reply.code(400).send(prepared.badRequest);

      const agent = await createAgentRecord(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        ctx.tokenRecord.userId,
        {
          config: prepared.config,
          description: typeof body.description === 'string' ? body.description : undefined,
          name: body.name,
          status: body.status as AgentStatus | undefined,
        },
      );

      return reply.code(201).send({ agent: redactAgent(agent) });
    } catch (error) {
      // The engine could not decide who may name the bucket: 503, not a failure of ours.
      const refusal = authorizationRefusalOf(error);
      if (refusal?.status === 503) return sendAuthorizationUnavailable(reply, request, 'client', { action: 'file-bucket.update', level: 'write', decisionId: refusal.decisionId });
      logger.error('Create client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  // ── Authoring: update an agent definition (project-scoped resolve by key) ──
  app.patch('/client/v1/agents/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const existing = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);

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
          const bindings = await resolveConfigGuardrailBindings(
            ctx.tenantDbName,
            ctx.projectId,
            cfg.guardrails,
          );
          if (bindings.error) {
            return reply.code(400).send({ error: bindings.error });
          }
          if (bindings.patch) Object.assign(externalConfig, bindings.patch);
          body.config = externalConfig;
        } else if (existing.config?.kind === 'external') {
          // Guard: never let a native-shaped config silently clobber a stored
          // connected agent's connection.
          delete body.config;
        } else {
          const checked = await validateNativeConfigUpdate(cfg, existing.key, {
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId }, bucketKey),
          }, existing.config);
          if ('forbidden' in checked) return reply.code(403).send(checked.forbidden);
          if ('badRequest' in checked) return reply.code(400).send(checked.badRequest);
        }
      }

      normalizeA2aUpdate(body, existing);

      const agent = await updateAgentRecord(
        ctx.tenantDbName,
        String(existing._id),
        pickAgentUpdateFields(body),
        ctx.tokenRecord.userId,
      );
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent: redactAgent(agent) });
    } catch (error) {
      const refusal = authorizationRefusalOf(error);
      if (refusal?.status === 503) return sendAuthorizationUnavailable(reply, request, 'client', { action: 'file-bucket.update', level: 'write', decisionId: refusal.decisionId });
      logger.error('Update client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  // ── Authoring: delete an agent definition (project-scoped resolve by key) ──
  app.delete('/client/v1/agents/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const existing = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const deleted = await deleteAgentRecord(ctx.tenantDbName, String(existing._id));
      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  // ── Authoring: publish the current config as a new version ──
  app.post('/client/v1/agents/:agentKey/publish', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const existing = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const published = await publishValidatedAgent(
        request,
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        existing,
        String(existing._id),
        ctx.tokenRecord.userId,
      );
      if ('badRequest' in published) return reply.code(400).send(published.badRequest);
      return reply.code(201).send({ version: published.version });
    } catch (error) {
      logger.error('Publish client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to publish agent',
      });
    }
  }));
};
