import { parseAgentRequestReasoning } from '@/lib/services/agents/agentReasoning';
import { shouldReturnReasoning } from '@/lib/services/models/reasoning';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { getConversationById } from '@/lib/services/agents/agentService';
import { createLogger } from '@/lib/core/logger';
import {
  GuardrailBlockError,
  handleChatCompletion,
  handleEmbeddingRequest,
  handleImageRequest,
} from '@/lib/services/models/inferenceService';
import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { toClientErrorBody } from '@/lib/services/agents/clientWire';
import { getModelByKey } from '@/lib/services/models/modelService';
import type { AgentRunClass, IAgent, IAgentConversation, IAgentRun } from '@/lib/database';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import { approvalAuthorizerFor } from './agent-approval-authz';
import { decideSessionAccess, sendOpenAiSessionRefusal } from './agent-session-access';
import {
  agentRunLocation,
  authorizeInvocationTarget,
  checkSessionContinuable,
  clientGoneSignal,
  openAiEnvelopeOf,
  parseInvocationInput,
  parseInvocationResponseFormat,
  parseRunMetadata,
  prepareInvocationSession,
  readIdempotencyKey,
  refuseStreamAdmission,
  resolveInvocationConfig,
  resolveInvocationInputs,
  resolveInvocationLimits,
  resolveInvocationVersion,
  sendInvocationFailure,
  type InvocationInput,
} from './agent-invocation';
import { idempotencyKeyConflictErrorBody } from '@/lib/services/agents';
import { isAgentRunActive, lookupIdempotentAgentRun, publicAgentRunId, waitForAgentRun } from '@/lib/services/agents/agentRunService';
import { assertQueuedTurnSpendAllowed } from '@/lib/services/agents/agentSpendLimits';
import { namedFileIds } from '@/lib/services/agents/responseInputFiles';
import { findChatTranscriptSessionId, rememberChatTranscript } from '@/lib/services/agents/chatTranscript';
import { agentResponseStatus } from './agent-response-object';
import { sendAgentGuardrailBlock } from './agent-config-write';
import { openSseConnection } from './sse-connection';
import { AgentModelError, requestedAgentModel, resolveRunModelForRequest, sendOpenAiAgentModelError } from './agent-model-authz';
import {
  AGENT_MODEL_PREFIX,
  completionOfRun,
  resolveAgentModel,
  runAgentCompletion,
  toChatChunk,
  toChatCompletion,
  toChatToolCallsChunk,
  toChatUsageChunk,
  extractToolAnswers,
  type OpenAiMessage,
  type RunAgentCompletionInput,
} from './agent-openai-bridge';
import {
  calculateCost,
  logModelUsage,
} from '@/lib/services/models/usageLogger';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
} from '@/lib/quota/quotaGuard';
import {
  anthropicErrorBody,
  anthropicErrorTypeForStatus,
  anthropicRequestToOpenAi,
  AnthropicRequestError,
  openAiResponseToAnthropic,
  isThinkingRequested,
  openAiStreamToAnthropic,
  type AnthropicMessagesRequest,
} from '@/lib/services/models/anthropicWire';
import {
  applyStreamHeaders,
  authorizationRefusalOf,
  getHeaderValue,
  readJsonBody,
  withAnthropicApiRequestContext,
  withOpenAiApiRequestContext,
} from '../fastify-utils';
import { authz } from '@/lib/iam/routeAuthz';
import {
  estimateTokens,
  extractMessageText,
  modelChatFailure,
  quotaExceededPayload,
  runModelChatCompletion,
  sanitize,
  type ChatCompletionRequest,
} from './model-chat-gateway';

const logger = createLogger('api:client-inference');

type EmbeddingRequest = {
  [key: string]: unknown;
  input?: string | string[];
  model?: string;
  request_id?: string;
};

function extractEmbeddingInputText(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .join('\n');
  }

  if (input === null || input === undefined) {
    return '';
  }

  return JSON.stringify(input);
}

function invalidJson(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      message: 'Invalid JSON body',
      type: 'invalid_request_error',
    },
  });
}

/** Chat parameters an agent does not take (its own config decides); listed back in `X-Cognipeer-Ignored-Params`. */
const AGENT_IGNORED_CHAT_PARAMS = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'parallel_tool_calls',
  'stop', 'seed', 'presence_penalty', 'frequency_penalty', 'n', 'logit_bias', 'logprobs', 'top_logprobs',
] as const;

const chatFail = (
  reply: FastifyReply,
  status: number,
  message: string,
  code: string,
  options: { type?: string; param?: string } = {},
) => sendInvocationFailure(reply, 'openai', {
  status, type: options.type ?? 'invalid_request_error', message, code, ...(options.param ? { param: options.param } : {}),
});

/**
 * Runs an agent and answers in the chat-completions shape, streaming when
 * the caller asked for it. System and developer messages are ignored (the
 * agent owns its prompt), and only the last user message is the turn: the
 * session holds the rest, found by `conversation_id`, the
 * `X-Cognipeer-Session-Id` header or, failing both, the transcript the client
 * resends (chatTranscript.ts). The turn is a run like on the other dialects:
 * `service_tier: "flex"` queues it as a deferred run the call waits on, an
 * `Idempotency-Key` makes a retry the same run, a wait window that ends first
 * answers 202 and a stream that loses its reader stops the run.
 *
 * Quota and usage accounting stay the agent runtime's own: `executeAgentChat`
 * records the turn against the agent, which is where an agent run belongs.
 * Charging it again here, as a model call, would double-count every agent
 * invocation in the tenant's bill.
 */
async function handleAgentChatCompletion(input: {
  request: FastifyRequest;
  agent: IAgent;
  auth: ApiTokenContext;
  body: Record<string, unknown>;
  model: string;
  reply: FastifyReply;
}) {
  const { request, agent, auth, body, model, reply } = input;
  try {
    return await runAgentChat({ request, agent, auth, body, model, reply });
  } catch (error) {
    // A refused target is the wrapper's to answer (403 / 503, OpenAI envelope).
    if (authorizationRefusalOf(error)) throw error;
    return sendAgentChatFailure(reply, error);
  }
}

function sendAgentChatFailure(reply: FastifyReply, error: unknown) {
  const blocked = sendAgentGuardrailBlock(reply, error);
  if (blocked) return blocked;
  const classified = logAgentRouteError(logger, 'Agent chat completion failed', error);
  return reply.code(classified.status).send({ error: toClientErrorBody(classified.error) });
}

async function runAgentChat(input: {
  request: FastifyRequest;
  agent: IAgent;
  auth: ApiTokenContext;
  body: Record<string, unknown>;
  model: string;
  reply: FastifyReply;
}) {
  const { request, agent, auth, body, model, reply } = input;
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const streaming = body.stream === true;
  // The agent's `showReasoning` is applied by the run itself; a request can only narrow it further
  // (`include_reasoning: false` / `reasoning: { exclude: true }`), never bring back what the agent hid.
  const includeReasoning = shouldReturnReasoning(undefined, body);
  const messages = Array.isArray(body.messages) ? body.messages as OpenAiMessage[] : undefined;
  const answeringToolCalls = extractToolAnswers(messages).length > 0;
  // `version`: a published version number (or numeric string) or `"draft"`, refused otherwise - as on /responses.
  const target = await resolveInvocationVersion(reply, 'openai', auth, agent, body.version);
  if (!target) return reply;
  const { version, usePublished } = target;

  const ignored = AGENT_IGNORED_CHAT_PARAMS.filter((name) => body[name] !== undefined && body[name] !== null);
  if (ignored.length > 0) void reply.header('X-Cognipeer-Ignored-Params', ignored.join(','));

  const runtimeContext = buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
    userId: auth.tokenRecord.userId,
    tokenId: auth.tokenRecord._id ? String(auth.tokenRecord._id) : undefined,
    source: 'api',
  });

  // `reasoning_effort` / `reasoning: { effort }`: the lowest rung (agent pick > Model Hub > this), refused when invalid.
  const reasoningRequest = parseAgentRequestReasoning(body);
  if (reasoningRequest.error) {
    return chatFail(reply, 400, reasoningRequest.error, 'invalid_reasoning', { param: 'reasoning_effort' });
  }

  // `response_format` (the answer comes back as a JSON string in `message.content`), the `inputs` extension and
  // `metadata`: all refused here, before a run exists, in OpenAI's envelope.
  const responseFormat = parseInvocationResponseFormat(reply, 'openai', body.response_format, 'response_format');
  if (!responseFormat) return reply;
  const runConfig = await resolveInvocationConfig(auth, target);
  const runInputs = resolveInvocationInputs(reply, 'openai', runConfig, body.inputs);
  if (!runInputs) return reply;
  const metadata = parseRunMetadata(body.metadata);
  if (!metadata.ok) return chatFail(reply, 400, metadata.message, 'invalid_metadata', { param: 'metadata' });
  // `flex` is OpenAI's "cheaper, slower" tier: here the deferred class, waited on like a plain call.
  const runClass: AgentRunClass = body.service_tier === 'flex' ? 'deferred' : 'default';
  // A deferred run waits for a slot in its own queue: there is no turn to stream yet.
  if (streaming && runClass === 'deferred') {
    return chatFail(reply, 400, 'stream cannot be combined with service_tier "flex"', 'unsupported_parameter', { param: 'service_tier' });
  }
  const idempotency = readIdempotencyKey(request, reply, 'openai');
  if (!idempotency) return reply;

  // The turn: the last user message's text and files (an image-only message is a message), or the answers to tool calls.
  let userInput: InvocationInput | null = null;
  if (!answeringToolCalls) {
    userInput = parseInvocationInput(reply, 'openai', agent, messages, { allowEmpty: true });
    if (!userInput) return reply;
    if (!userInput.userMessage && userInput.userInput.files.length === 0 && !runInputs.inputs) {
      return chatFail(reply, 400, 'messages must contain at least one user message', 'missing_messages', { param: 'messages' });
    }
  }

  // The session: named by the caller, else (a user turn) the one whose last turn left the transcript the request continues.
  const namedBySession = typeof body.conversation_id === 'string' && body.conversation_id !== '' ? body.conversation_id : undefined;
  const namedByHeader = getHeaderValue(request, 'x-cognipeer-session-id') || undefined;
  if (namedBySession && namedByHeader && namedBySession !== namedByHeader) {
    return chatFail(reply, 400, 'conversation_id and X-Cognipeer-Session-Id name different sessions: send one of them', 'session_conflict');
  }
  const named = namedBySession ?? namedByHeader;
  // OpenAI's `user` (the end user an application serves) takes part in the transcript match.
  const endUser = typeof body.user === 'string' && body.user !== '' ? body.user : undefined;
  const matched = named || answeringToolCalls
    ? undefined
    : await findChatTranscriptSessionId(auth.tenantDbName, { projectId: auth.projectId, agentKey: agent.key, userId: String(auth.tokenRecord.userId ?? '') }, messages, endUser);
  const sessionId = named ?? matched;
  if (answeringToolCalls && !sessionId) {
    return chatFail(reply, 400, 'conversation_id is required to answer a tool call: send the one the reply carried', 'missing_conversation_id', { param: 'conversation_id' });
  }
  let conversation: IAgentConversation | null = null;
  if (sessionId) {
    const found = await getConversationById(auth.tenantDbName, sessionId).catch(() => null);
    if (found && found.agentKey === agent.key && found.projectId === auth.projectId) conversation = found;
    else if (named) return chatFail(reply, 404, 'conversation_id does not match a conversation for this agent', 'session_not_found', { param: 'conversation_id' });
  }
  if (conversation) {
    if (answeringToolCalls) {
      // A `tool` message answers an open call (authorized when it is resolved): only the access to the session is asked here.
      const access = await decideSessionAccess(request, conversation, {
        need: 'continue',
        agent,
        actor: { tenantDbName: auth.tenantDbName, projectId: auth.projectId, userId: String(auth.tokenRecord.userId ?? '') },
      });
      if (!access.ok) return sendOpenAiSessionRefusal(reply, request, access);
    } else if (!await checkSessionContinuable(request, reply, 'openai', auth, agent, conversation)) {
      return reply;
    }
  }
  if (userInput?.userInput.files.some((file) => file.fileId) && !conversation) {
    return chatFail(reply, 400, 'file_id names a file already uploaded to a session: continue that session with conversation_id, or send file_data / image_url.', 'attachment_not_found');
  }

  // Which of the agent's models answers (`agent_model` in the body - `extra_body` for OpenAI SDKs - or the
  // `x-cognipeer-agent-model` header; the session's last model otherwise). `model` stays the agent's id.
  let modelChoice: Awaited<ReturnType<typeof resolveRunModelForRequest>> | undefined;
  const askedModel = requestedAgentModel(request, body);
  if (askedModel || agent.config.additionalModels?.length) {
    try {
      if (askedModel || runConfig.additionalModels?.length) {
        modelChoice = await resolveRunModelForRequest(request, { agent, config: runConfig, projectId: auth.projectId, requested: askedModel, conversation });
      }
    } catch (error) {
      if (error instanceof AgentModelError) return sendOpenAiAgentModelError(reply, error);
      throw error;
    }
  }
  const cognipeer = modelChoice ? { cognipeer: { agent_model: modelChoice.modelKey } } : {};
  const limits = await resolveInvocationLimits(auth);
  const ref = { tenantDbName: auth.tenantDbName, tenantId: auth.tenantId, projectId: auth.projectId };
  // Only a session the caller named is part of what makes a retry "the same": a new (or matched) one is not.
  const idempotencyConversationScope = named ?? null;

  // A retry of a run this key already started: its answer, without a second session or a second run.
  let replayed: IAgentRun | null = null;
  if (idempotency.key && userInput) {
    const prior = await lookupIdempotentAgentRun({
      ...ref,
      agentKey: agent.key,
      userMessage: userInput.userMessage,
      idempotencyAttachments: namedFileIds(userInput.userInput.files),
      version,
      idempotencyKey: idempotency.key,
      idempotencyConversationScope,
    });
    if (prior.kind === 'conflict') return reply.code(409).send(openAiEnvelopeOf(idempotencyKeyConflictErrorBody()));
    if (prior.kind === 'replay') replayed = prior.run;
  }

  // A queued turn learns of an exhausted tenant spend limit here (429), before a session is created for it.
  if (runClass === 'deferred' && userInput && !replayed) {
    await assertQueuedTurnSpendAllowed({ ...ref, agentKey: agent.key, userId: auth.tokenRecord.userId });
  } else if (streaming && userInput && !replayed && await refuseStreamAdmission(reply, 'openai', auth, agent.key, limits)) {
    // Over a cap or the quota: a plain 429 before the stream opens (and before a session exists).
    return reply;
  }

  // The session (new or continued), the model choice stored on it, the message's files as its files.
  const turn = userInput && !replayed
    ? {
      userMessage: userInput.userMessage,
      session: await prepareInvocationSession(auth, { agent, conversation, ...(modelChoice ? { modelChoice } : {}), userInput: userInput.userInput }),
    }
    : undefined;
  const conversationId = replayed?.conversationId ?? turn?.session.conversationId ?? String(sessionId);
  void reply.header('X-Cognipeer-Session-Id', conversationId);

  const common = {
    limits,
    ...(auth.tokenRecord._id ? { apiTokenId: String(auth.tokenRecord._id) } : {}),
    ...(modelChoice ? { modelChoice } : {}),
    ...(reasoningRequest.value ? { requestReasoning: reasoningRequest.value } : {}),
    ...(responseFormat.format ? { responseFormat: responseFormat.format } : {}),
    ...(runInputs.inputs ? { inputs: runInputs.inputs } : {}),
    runClass,
    metadata: metadata.metadata,
    ...(idempotency.key ? { idempotencyKey: idempotency.key, idempotencyConversationScope } : {}),
    agent,
    model,
    messages,
    ...(turn ? { turn } : {}),
    conversationId,
    ...(version !== undefined ? { version } : {}),
    usePublished,
    runtimeContext,
    ctx: {
      tenantDbName: auth.tenantDbName,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      userId: auth.tokenRecord.userId,
    },
    // Answering a client tool call (a `tool` message) is the same act as POST .../actions/{id}: same token, same engine decision.
    answer: {
      authorize: approvalAuthorizerFor(request, auth.tenantDbName),
      actor: {
        userId: String(auth.tokenRecord.userId ?? ''),
        channel: 'api' as const,
        ...(auth.user?.email ? { email: auth.user.email } : {}),
        ...(auth.user?.role ? { role: auth.user.role } : {}),
        ...(auth.tokenRecord._id ? { apiTokenId: String(auth.tokenRecord._id) } : {}),
      },
      audit: {
        ipAddress: request.ip,
        ...(typeof request.headers['user-agent'] === 'string' ? { userAgent: request.headers['user-agent'] } : {}),
      },
    },
  };
  // A retry's run waits up to the window when it is still going; every other call goes through the engine.
  // A wait stops when the client goes away.
  const gone = clientGoneSignal(reply);
  const execute = async (hooks: Pick<RunAgentCompletionInput, 'signal' | 'onTextChunk' | 'onReasoningChunk'> = {}) => {
    if (!replayed) return runAgentCompletion({ ...common, ...hooks, waitSignal: gone });
    const settled = isAgentRunActive(replayed) && replayed.status !== 'scheduled'
      ? (await waitForAgentRun({ ...ref, runId: String(replayed._id) }, limits.syncWaitMs, gone)) ?? replayed
      : replayed;
    return completionOfRun(settled, conversationId);
  };
  // The next request of this client carries what it holds now: remember it (a retry's answer is not a new turn).
  const remember = (result: { content: string; toolCalls?: unknown[] }) =>
    replayed || result.toolCalls?.length ? undefined : rememberChatTranscript(auth.tenantDbName, conversationId, messages, result.content, endUser);

  if (!streaming) {
    const result = await execute();
    if ('error' in result) {
      if (result.retryAfterSeconds) void reply.header('Retry-After', String(result.retryAfterSeconds));
      return reply.code(result.status).send({
        error: {
          message: result.error,
          type: result.type ?? 'invalid_request_error',
          ...(result.code ? { code: result.code } : {}),
          ...result.extra,
        },
      });
    }
    if ('accepted' in result) {
      // The wait window ended with the run still going: it carries on; follow it on the runs API.
      return reply
        .code(202)
        .header('Location', agentRunLocation(result.accepted))
        .header('Retry-After', '2')
        .send({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          cognipeer: {
            status: agentResponseStatus(result.accepted),
            run_id: publicAgentRunId(result.accepted),
            session_id: result.conversationId,
            ...(modelChoice ? { agent_model: modelChoice.modelKey } : {}),
          },
        });
    }
    await remember(result);
    return reply.code(200).send({
      ...toChatCompletion({ id, model, ...result, ...(includeReasoning ? {} : { reasoning: undefined }) }),
      ...cognipeer,
    });
  }

  const sse = openSseConnection(reply);
  const send = (payload: unknown) => sse.write(`data: ${JSON.stringify(payload)}\n\n`);
  send(toChatChunk({ id, model, opening: true, conversationId }));

  let streamed = '';
  let streamedReasoning = '';
  try {
    // A reader that goes away stops the run, as OpenAI's stream does.
    const result = await execute({
      signal: sse.signal,
      onTextChunk: (text) => {
        streamed += text;
        send(toChatChunk({ id, model, delta: text }));
      },
      ...(includeReasoning
        ? {
          onReasoningChunk: (text: string) => {
            streamedReasoning += text;
            send(toChatChunk({ id, model, reasoning: text }));
          },
        }
        : {}),
    });

    if ('error' in result) {
      send({ error: { message: result.error, type: result.type ?? 'invalid_request_error', ...(result.code ? { code: result.code } : {}) } });
    } else if ('accepted' in result) {
      // Only a retry of a run that is still going gets here (a stream has no window): say where it can be followed.
      send({ error: { message: 'The run is still in progress', type: 'server_error', code: 'agent_run_in_progress', run_id: publicAgentRunId(result.accepted) } });
    } else {
      // Thinking that did not stream (a routed run without relay, a model call that was not streamed)
      // still comes out, ahead of the answer's missing tail.
      if (includeReasoning && result.reasoning && !streamedReasoning) {
        send(toChatChunk({ id, model, reasoning: result.reasoning }));
      }
      // A run that streamed nothing (an agent bound to output.pre answers in
      // one guarded piece; a routed run without relay) must still deliver the
      // answer rather than an empty one followed by [DONE]. A relayed run may
      // also have lost its last frames (best-effort pub/sub): when the final
      // answer extends what streamed, send the missing tail.
      if (!streamed && result.content) {
        send(toChatChunk({ id, model, delta: result.content }));
      } else if (streamed && result.content && result.content.length > streamed.length) {
        if (result.content.startsWith(streamed)) {
          send(toChatChunk({ id, model, delta: result.content.slice(streamed.length) }));
        } else {
          logger.warn('Streamed agent text diverged from the final answer', {
            model, streamedLength: streamed.length, finalLength: result.content.length,
          });
        }
      }
      if (result.toolCalls?.length) {
        // Ends the stream the way OpenAI does when the model calls tools: the calls, then finish_reason "tool_calls".
        send({ ...toChatToolCallsChunk({ id, model, toolCalls: result.toolCalls }), conversation_id: result.conversationId });
      } else {
        send({ ...toChatChunk({ id, model, finish: true, stopReason: result.stopReason, files: result.outputFiles, conversationId: result.conversationId }), ...cognipeer });
      }
      // `stream_options.include_usage`: the run's usage, in a chunk of its own after the last one.
      if (result.usage && (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true) {
        send(toChatUsageChunk({ id, model, usage: result.usage }));
      }
      await remember(result);
    }
  } catch (error) {
    const classified = logAgentRouteError(logger, 'Agent chat completion stream failed', error);
    send({ error: toClientErrorBody(classified.error) });
  } finally {
    sse.write('data: [DONE]\n\n');
    sse.end();
  }
  return reply;
}

export const clientInferenceApiPlugin: FastifyPluginAsync = async (app) => {
  // Models and agents (`agent:<key>`, or an agent's bare key): a holder of either service gets in, the target
  // decides what is needed (§5.8, authorizeInvocationTarget).
  app.post('/client/v1/chat/completions', { config: authz.serviceAnyOf(['models', 'agents']) }, withOpenAiApiRequestContext(async (request, reply, auth) => {
    const startedAt = Date.now();
    let body: ChatCompletionRequest = {};
    let modelKey = '';

    try {
      try {
        const parsed = readJsonBody<unknown>(request);
        body = parsed && typeof parsed === 'object'
          ? parsed as ChatCompletionRequest
          : {};
      } catch (error) {
        if (error instanceof SyntaxError) {
          return invalidJson(reply);
        }
        throw error;
      }

      if (!body.model || typeof body.model !== 'string') {
        return reply.code(400).send({
          error: {
            message: '`model` is required',
            type: 'invalid_request_error',
          },
        });
      }

      modelKey = body.model;

      /*
       * An agent can be addressed here by key, so any OpenAI client can call
       * one without knowing this console exists.
       *
       * Checked AFTER the model lookup for a bare name (`resolveAgentModel`
       * asks `modelExists` first): no existing caller may have its traffic
       * re-routed because someone later created an agent whose key collides
       * with a model. The run is delegated to `executeAgentChat` — the same
       * entry point `/responses` uses — so there is one agent runtime, not a
       * second one hiding behind an OpenAI-shaped door.
       */
      // `agent:<key>` needs the agents service before it is even looked up; a bare name once it is resolved.
      const explicitAgent = modelKey.startsWith(AGENT_MODEL_PREFIX);
      if (explicitAgent) await authorizeInvocationTarget(request, 'agent');
      const agent = await resolveAgentModel(
        modelKey,
        { tenantDbName: auth.tenantDbName, projectId: auth.projectId },
        async (key) => Boolean(await getModelByKey(auth.tenantDbName, key, auth.projectId)),
      );
      if (explicitAgent && !agent) {
        return reply.code(404).send({
          error: { message: `The model \`${modelKey}\` does not exist`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' },
        });
      }
      if (!explicitAgent) await authorizeInvocationTarget(request, agent ? 'agent' : 'model');
      if (agent) {
        return handleAgentChatCompletion({ request, agent, auth, body: body as Record<string, unknown>, model: modelKey, reply });
      }

      const outcome = await runModelChatCompletion(auth, body, { modelKey });
      if (outcome.kind === 'refused') return reply.code(outcome.status).send(outcome.body);
      const { result } = outcome;

      if (result.stream) {
        applyStreamHeaders(reply, result.requestId);

        return reply.send(
          Readable.fromWeb(result.stream as unknown as NodeReadableStream<Uint8Array>),
        );
      }

      return reply.code(200).send({
        ...result.response,
        request_id: result.requestId,
      });
    } catch (error) {
      // A refused target is the wrapper's to answer (403 / 503, OpenAI envelope), not a model error.
      if (authorizationRefusalOf(error)) throw error;
      logger.error('Client chat completion error', { error });
      const failure = await modelChatFailure(request, auth, { modelKey, body, startedAt }, error);
      return reply.code(failure.status).send(failure.body);
    }
  }));

  /**
   * Anthropic Messages, served from the same Model Hub as chat/completions.
   *
   * The platform's internal dialect is and stays the OpenAI schema — this route
   * translates at the edge and hands the result to the exact same
   * `handleChatCompletion` the OpenAI route uses, so guardrails, quota, budget,
   * usage logging and dynamic routing all apply unchanged. Anything else would
   * mean a second, quietly divergent metering path.
   *
   * The translation is lossy in one direction worth stating out loud:
   * `cache_control` breakpoints and extended-thinking blocks have no
   * chat-completions equivalent and do not survive. A client that depends on
   * prompt caching wants an AI App Gateway instance in native mode, where the
   * bytes are forwarded unchanged, not this endpoint.
   */
  app.post('/client/v1/messages', withAnthropicApiRequestContext(async (request, reply, auth) => {
    const startedAt = Date.now();
    let anthropicBody: AnthropicMessagesRequest = {};
    let modelKey = '';
    // Set once the inference layer has assigned one; the error log below
    // correlates with the same id the client saw rather than a fresh UUID.
    let requestId: string | undefined;

    try {
      try {
        const parsed = readJsonBody<unknown>(request);
        anthropicBody = parsed && typeof parsed === 'object'
          ? parsed as AnthropicMessagesRequest
          : {};
      } catch (error) {
        if (error instanceof SyntaxError) {
          return reply.code(400).send(anthropicErrorBody('Invalid JSON body'));
        }
        throw error;
      }

      let body: ChatCompletionRequest;
      try {
        body = anthropicRequestToOpenAi(anthropicBody) as ChatCompletionRequest;
      } catch (error) {
        if (error instanceof AnthropicRequestError) {
          return reply.code(400).send(anthropicErrorBody(error.message));
        }
        throw error;
      }

      modelKey = anthropicBody.model as string;
      const requestedOutputTokens = anthropicBody.max_tokens;
      const estimatedInputTokens = estimateTokens(extractMessageText(body.messages));
      const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
      const quotaContext = {
        domain: 'llm' as const,
        licenseType: auth.tenant.licenseType as LicenseType,
        projectId: auth.projectId,
        resourceKey: modelKey,
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        tokenId,
        userId: auth.tokenRecord.userId,
      };

      try {
        const quotaResult = await checkPerRequestLimits(quotaContext, {
          inputTokens: estimatedInputTokens,
          outputTokens: requestedOutputTokens,
          totalTokens: estimatedInputTokens + (requestedOutputTokens ?? 0),
        });
        if (!quotaResult.allowed) {
          return reply.code(429).send(
            anthropicErrorBody(quotaResult.reason || 'Quota exceeded', 'rate_limit_error'),
          );
        }
        const rateLimitResult = await checkRateLimit(quotaContext, {
          requests: 1,
          tokens: estimatedInputTokens,
        });
        if (!rateLimitResult.allowed) {
          return reply.code(429).send(
            anthropicErrorBody(rateLimitResult.reason || 'Rate limit exceeded', 'rate_limit_error'),
          );
        }
        const budgetResult = await checkBudget(quotaContext);
        if (!budgetResult.allowed) {
          return reply.code(429).send(
            anthropicErrorBody(budgetResult.reason || 'Budget exceeded', 'rate_limit_error'),
          );
        }
      } catch (error) {
        logger.error('Client messages quota check error', { error });
        return reply.code(500).send(anthropicErrorBody('Quota check failed', 'api_error'));
      }

      const result = await handleChatCompletion({
        body,
        modelKey,
        projectId: auth.projectId,
        stream: Boolean(body.stream),
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        callerContext: {
          channel: 'api',
          apiTokenId: auth.tokenRecord._id ? String(auth.tokenRecord._id) : undefined,
          projectId: auth.projectId,
        },
      });
      requestId = result.requestId;

      const actualOutputTokens = result.usage?.outputTokens || 0;
      if (actualOutputTokens > 0) {
        void checkRateLimit(quotaContext, { tokens: actualOutputTokens }).catch((error) =>
          logger.error('Failed to update messages rate limit usage', { error }),
        );
      }

      if (result.usage) {
        const usage = result.usage;
        void getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
          .then((model) => {
            if (!model) return undefined;
            const cost = calculateCost(model.pricing, usage);
            if (
              cost.currency !== 'USD'
              || !Number.isFinite(cost.totalCost)
              || cost.totalCost <= 0
            ) {
              return undefined;
            }
            return checkBudget(quotaContext, { usd: cost.totalCost });
          })
          .catch((error) => logger.error('Failed to update messages budget usage', { error }));
      }

      if (result.stream) {
        applyStreamHeaders(reply, result.requestId);
        const translated = openAiStreamToAnthropic(
          result.stream as ReadableStream<Uint8Array>,
          modelKey,
          { emitThinking: isThinkingRequested(anthropicBody) },
        );
        return reply.send(
          Readable.fromWeb(translated as unknown as NodeReadableStream<Uint8Array>),
        );
      }

      // Same correlation the chat route offers: the id in the body for clients
      // that log responses, and the `request-id` header the Anthropic SDKs
      // surface on their error/response objects.
      reply.header('request-id', result.requestId);
      return reply.code(200).send({
        ...openAiResponseToAnthropic(result.response ?? {}, modelKey, {
          emitThinking: isThinkingRequested(anthropicBody),
        }),
        request_id: result.requestId,
      });
    } catch (error) {
      logger.error('Client messages error', { error, requestId });

      if (error instanceof GuardrailBlockError) {
        return reply.code(400).send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: error.message,
            guardrail_key: error.guardrailKey,
            action: error.action,
            findings: error.findings,
          },
        });
      }

      const normalizedError = normalizeInferenceError(error);

      try {
        const model = modelKey
          ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
          : null;
        if (model) {
          const errorMessage = normalizedError.error.message;
          await logModelUsage(auth.tenantDbName, model, {
            errorMessage,
            latencyMs: Date.now() - startedAt,
            providerRequest: sanitize({ body: anthropicBody, model: modelKey }),
            providerResponse: sanitize({ error: errorMessage }),
            requestId: requestId ?? request.apiRequestId ?? crypto.randomUUID(),
            // Its own route label: a Messages turn and a chat-completions turn
            // are different client contracts and a usage report that merges them
            // cannot answer "which dialect is this team on".
            route: 'messages',
            status: 'error',
            usage: {},
          });
        }
      } catch (logError) {
        logger.error('Failed to log client messages error', { error: logError });
      }

      if (normalizedError.status >= 400 && normalizedError.status < 500) {
        request.upstreamStatusForwarded = true;
      }

      return reply.code(normalizedError.status).send(
        anthropicErrorBody(
          normalizedError.error.message,
          anthropicErrorTypeForStatus(normalizedError.status),
        ),
      );
    }
  }));

  // ─── POST /client/v1/images/generations ──────────────────────────────
  // The OpenAI images schema, so an OpenAI client pointed at Console works
  // unchanged. Image models bill per image rather than per token, so the quota
  // guard runs on request count and the budget is settled from the model's own
  // per-image price after the call.
  app.post('/client/v1/images/generations', withOpenAiApiRequestContext(async (request, reply, auth) => {
    const startedAt = Date.now();
    let modelKey = '';

    try {
      let body: Record<string, unknown>;
      try {
        const parsed = readJsonBody<unknown>(request);
        body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      } catch (error) {
        if (error instanceof SyntaxError) return invalidJson(reply);
        throw error;
      }

      if (typeof body.model !== 'string' || !body.model) {
        return reply.code(400).send({
          error: { message: '`model` is required', type: 'invalid_request_error' },
        });
      }
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return reply.code(400).send({
          error: { message: '`prompt` is required', type: 'invalid_request_error' },
        });
      }
      if (body.n !== undefined && (typeof body.n !== 'number' || body.n < 1)) {
        return reply.code(400).send({
          error: { message: '`n` must be a positive number', type: 'invalid_request_error' },
        });
      }

      modelKey = body.model;
      const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
      const quotaContext = {
        domain: 'image' as const,
        licenseType: auth.tenant.licenseType as LicenseType,
        projectId: auth.projectId,
        resourceKey: modelKey,
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        tokenId,
        userId: auth.tokenRecord.userId,
      };

      try {
        const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1, tokens: 0 });
        if (!rateLimitResult.allowed) {
          return reply.code(429).send(
            quotaExceededPayload(rateLimitResult.reason || 'Rate limit exceeded'),
          );
        }
        const budgetResult = await checkBudget(quotaContext);
        if (!budgetResult.allowed) {
          return reply.code(429).send(
            quotaExceededPayload(budgetResult.reason || 'Budget exceeded'),
          );
        }
      } catch (error) {
        logger.error('Client image quota check error', { error });
        return reply.code(500).send({
          error: { message: 'Quota check failed', type: 'server_error' },
        });
      }

      const result = await handleImageRequest({
        tenantDbName: auth.tenantDbName,
        modelKey,
        projectId: auth.projectId,
        input: {
          prompt: body.prompt,
          n: typeof body.n === 'number' ? body.n : undefined,
          size: typeof body.size === 'string' ? body.size : undefined,
          quality: typeof body.quality === 'string' ? body.quality : undefined,
          style: typeof body.style === 'string' ? body.style : undefined,
          background: typeof body.background === 'string' ? body.background : undefined,
          outputFormat: typeof body.output_format === 'string' ? body.output_format : undefined,
          responseFormat:
            body.response_format === 'url' || body.response_format === 'b64_json'
              ? body.response_format
              : undefined,
          user: typeof body.user === 'string' ? body.user : undefined,
        },
      });

      try {
        const cost = calculateCost(result.model.pricing, {
          images: result.response.usage?.images ?? result.response.data.length,
          inputTokens: result.response.usage?.inputTokens ?? 0,
          outputTokens: result.response.usage?.outputTokens ?? 0,
        });
        if (cost.currency === 'USD' && Number.isFinite(cost.totalCost) && cost.totalCost > 0) {
          void checkBudget(quotaContext, { usd: cost.totalCost }).catch((error) =>
            logger.error('Failed to update image budget usage', { error }),
          );
        }
      } catch (error) {
        logger.error('Image budget update error', { error });
      }

      return reply.code(200).send({ ...result.response, request_id: result.requestId });
    } catch (error) {
      logger.error('Client image generation error', { error });
      const normalizedError = normalizeInferenceError(error);

      try {
        const model = modelKey
          ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
          : null;
        if (model) {
          await logModelUsage(auth.tenantDbName, model, {
            errorMessage: normalizedError.error.message,
            latencyMs: Date.now() - startedAt,
            providerRequest: { model: modelKey },
            providerResponse: { error: normalizedError.error.message },
            requestId: crypto.randomUUID(),
            route: 'images.generations',
            status: 'error',
            usage: {},
          });
        }
      } catch (logError) {
        logger.error('Failed to log image generation error', { error: logError });
      }

      return reply.code(normalizedError.status).send(normalizedError);
    }
  }));

  app.post('/client/v1/embeddings', withOpenAiApiRequestContext(async (request, reply, auth) => {
    const startedAt = Date.now();
    let body: EmbeddingRequest = {};
    let modelKey = '';

    try {
      try {
        const parsed = readJsonBody<unknown>(request);
        body = parsed && typeof parsed === 'object'
          ? parsed as EmbeddingRequest
          : {};
      } catch (error) {
        if (error instanceof SyntaxError) {
          return invalidJson(reply);
        }
        throw error;
      }

      if (!body.model || typeof body.model !== 'string') {
        return reply.code(400).send({
          error: {
            message: '`model` is required',
            type: 'invalid_request_error',
          },
        });
      }

      if (
        body.input !== undefined
        && typeof body.input !== 'string'
        && !(Array.isArray(body.input) && body.input.every((item) => typeof item === 'string'))
      ) {
        return reply.code(400).send({
          error: {
            message: '`input` must be a string or array of strings',
            type: 'invalid_request_error',
          },
        });
      }

      modelKey = body.model;
      const estimatedInputTokens = estimateTokens(extractEmbeddingInputText(body.input));
      const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
      const quotaContext = {
        domain: 'embedding' as const,
        licenseType: auth.tenant.licenseType as LicenseType,
        projectId: auth.projectId,
        resourceKey: modelKey,
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        tokenId,
        userId: auth.tokenRecord.userId,
      };

      try {
        const quotaResult = await checkPerRequestLimits(quotaContext, {
          inputTokens: estimatedInputTokens,
        });
        if (!quotaResult.allowed) {
          return reply.code(429).send(
            quotaExceededPayload(quotaResult.reason || 'Quota exceeded'),
          );
        }

        const rateLimitResult = await checkRateLimit(quotaContext, {
          requests: 1,
          tokens: estimatedInputTokens,
        });
        if (!rateLimitResult.allowed) {
          return reply.code(429).send(
            quotaExceededPayload(rateLimitResult.reason || 'Rate limit exceeded'),
          );
        }

        const budgetResult = await checkBudget(quotaContext);
        if (!budgetResult.allowed) {
          return reply.code(429).send(
            quotaExceededPayload(budgetResult.reason || 'Budget exceeded'),
          );
        }
      } catch (error) {
        logger.error('Client embeddings quota check error', { error });
        return reply.code(500).send({
          error: {
            message: 'Quota check failed',
            type: 'server_error',
          },
        });
      }

      const result = await handleEmbeddingRequest({
        body,
        modelKey,
        projectId: auth.projectId,
        tenantDbName: auth.tenantDbName,
      });

      try {
        const model = await getModelByKey(auth.tenantDbName, modelKey, auth.projectId);
        if (model) {
          const cost = calculateCost(model.pricing, {
            inputTokens: estimatedInputTokens,
            outputTokens: 0,
            totalTokens: estimatedInputTokens,
          });
          if (
            cost.currency === 'USD'
            && Number.isFinite(cost.totalCost)
            && cost.totalCost > 0
          ) {
            void checkBudget(quotaContext, { usd: cost.totalCost }).catch((error) =>
              logger.error('Failed to update embedding budget usage', { error }),
            );
          }
        }
      } catch (error) {
        logger.error('Embedding budget update error', { error });
      }

      return reply.code(200).send({
        ...result.response,
        request_id: result.requestId,
      });
    } catch (error) {
      logger.error('Client embeddings error', { error });
      const normalizedError = normalizeInferenceError(error);

      try {
        const model = modelKey
          ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
          : null;
        if (model) {
          const errorMessage = normalizedError.error.message;
          await logModelUsage(auth.tenantDbName, model, {
            errorMessage,
            latencyMs: Date.now() - startedAt,
            providerRequest: sanitize({ body, model: body?.model }),
            providerResponse: sanitize({ error: errorMessage }),
            requestId: typeof body?.request_id === 'string'
              ? body.request_id
              : crypto.randomUUID(),
            route: 'embeddings',
            status: 'error',
            usage: {},
          });
        }
      } catch (logError) {
        logger.error('Failed to log client embedding error', { error: logError });
      }

      if (normalizedError.status >= 400 && normalizedError.status < 500) {
        // Keeps a provider's 401/403 out of the security audit trail's `denied`
        // bucket — our own auth already passed to get here.
        request.upstreamStatusForwarded = true;
      }

      return reply.code(normalizedError.status).send({ error: normalizedError.error });
    }
  }));
};
