import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { AgentGuardrailBlockedError, type AgentChatResponse } from '@/lib/services/agents/agentService';
import { createLogger } from '@/lib/core/logger';
import {
  GuardrailBlockError,
  handleChatCompletion,
  handleEmbeddingRequest,
  handleImageRequest,
} from '@/lib/services/models/inferenceService';
import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import { getModelByKey } from '@/lib/services/models/modelService';
import type { IAgent } from '@/lib/database';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import {
  resolveAgentModel,
  runAgentCompletion,
  toChatChunk,
  toChatCompletion,
  type OpenAiMessage,
} from './agent-openai-bridge';
import {
  calculateCost,
  logModelUsage,
} from '@/lib/services/models/usageLogger';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
  settleUsageBudget,
} from '@/lib/quota/quotaGuard';
import {
  anthropicErrorBody,
  anthropicErrorTypeForStatus,
  anthropicRequestToOpenAi,
  AnthropicRequestError,
  openAiResponseToAnthropic,
  openAiStreamToAnthropic,
  type AnthropicMessagesRequest,
} from '@/lib/services/models/anthropicWire';
import {
  applyStreamHeaders,
  readJsonBody,
  withAnthropicApiRequestContext,
  withOpenAiApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-inference');

type MessageContentPart = string | { text?: string };
type ChatMessage = {
  content?: string | MessageContentPart[];
};
type ChatCompletionRequest = {
  [key: string]: unknown;
  max_completion_tokens?: number;
  max_tokens?: number;
  messages?: unknown;
  model?: string;
  request_id?: string;
  stream?: boolean;
};
type EmbeddingRequest = {
  [key: string]: unknown;
  input?: string | string[];
  model?: string;
  request_id?: string;
};

function quotaExceededPayload(message = 'Quota exceeded') {
  return { error: { message, type: 'rate_limit_error' } };
}


function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function extractMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }

  const parts: string[] = [];
  for (const message of messages as ChatMessage[]) {
    const content = message?.content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }

      if (typeof part?.text === 'string') {
        parts.push(part.text);
      }
    }
  }

  return parts.join('\n');
}

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

function sanitize(value: unknown, max = 20_000) {
  if (value === null || value === undefined) {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= max) {
      return value;
    }

    return {
      preview: serialized.slice(0, max),
      truncated: true,
    };
  } catch {
    return '[unserializable]';
  }
}

function invalidJson(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      message: 'Invalid JSON body',
      type: 'invalid_request_error',
    },
  });
}

/**
 * Runs an agent and answers in the chat-completions shape, streaming when
 * the caller asked for it.
 *
 * Quota and usage accounting stay the agent runtime's own: `executeAgentChat`
 * records the turn against the agent, which is where an agent run belongs.
 * Charging it again here, as a model call, would double-count every agent
 * invocation in the tenant's bill.
 */
async function handleAgentChatCompletion(input: {
  agent: IAgent;
  auth: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    tokenRecord: { _id?: unknown; userId: string };
  };
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
  model: string;
  reply: FastifyReply;
}) {
  const { agent, auth, body, model, reply } = input;
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const streaming = body.stream === true;

  const runtimeContext = buildRuntimeContextFromRequest(
    body.runtime_context,
    input.headers as never,
    {
      userId: auth.tokenRecord.userId,
      tokenId: auth.tokenRecord._id ? String(auth.tokenRecord._id) : undefined,
      source: 'api',
    },
  );

  const common = {
    agent,
    model,
    messages: body.messages as OpenAiMessage[] | undefined,
    ...(typeof body.conversation_id === 'string' ? { conversationId: body.conversation_id } : {}),
    ...(typeof body.version === 'number' ? { version: body.version } : {}),
    runtimeContext,
    ctx: {
      tenantDbName: auth.tenantDbName,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      userId: auth.tokenRecord.userId,
    },
  };

  if (!streaming) {
    let result: Awaited<ReturnType<typeof runAgentCompletion>>;
    try {
      result = await runAgentCompletion(common);
    } catch (error) {
      if (error instanceof AgentGuardrailBlockedError) {
        return reply.code(error.status).send({
          error: {
            type: 'guardrail_block',
            action: 'block',
            message: error.message,
            reason: error.reason,
            guardrail_key: error.guardrailKey ?? null,
            hook: error.hook ?? null,
          },
        });
      }
      logger.error('Agent chat completion failed', { error });
      const classified = classifyAgentRunError(error);
      return reply.code(classified.status).send({ error: classified.error });
    }
    if ('error' in result) {
      return reply.code(result.status).send({
        error: { message: result.error, type: 'invalid_request_error' },
      });
    }
    return reply.code(200).send(toChatCompletion({
      id,
      model,
      content: result.content,
      conversationId: result.conversationId,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      ...(result.stopDetail ? { stopDetail: result.stopDetail } : {}),
    }));
  }

  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();

  let closed = false;
  reply.raw.on('close', () => { closed = true; });
  const send = (payload: unknown) => {
    if (closed) return;
    try {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      closed = true;
    }
  };

  let streamed = '';
  let stopReason: AgentChatResponse['stop_reason'];
  try {
    const result = await runAgentCompletion({
      ...common,
      onTextChunk: (text) => {
        streamed += text;
        send(toChatChunk({ id, model, delta: text }));
      },
    });

    if ('error' in result) {
      send({ error: { message: result.error, type: 'invalid_request_error' } });
    } else if (!streamed && result.content) {
      // A routed run streams nothing (the callback cannot cross the job
      // queue), and a caller that asked for a stream must still receive the
      // answer rather than an empty one followed by [DONE].
      send(toChatChunk({ id, model, delta: result.content }));
    }
    if (!('error' in result)) stopReason = result.stopReason;
    send(toChatChunk({ id, model, finish: true, stopReason }));
  } catch (error) {
    logger.error('Agent chat completion stream failed', { error });
    send({ error: classifyAgentRunError(error).error });
  } finally {
    if (!closed) {
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  }
  return reply;
}

export const clientInferenceApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/chat/completions', withOpenAiApiRequestContext(async (request, reply, auth) => {
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
      const agent = await resolveAgentModel(
        modelKey,
        { tenantDbName: auth.tenantDbName, projectId: auth.projectId },
        async (key) => Boolean(await getModelByKey(auth.tenantDbName, key, auth.projectId)),
      );
      if (agent) {
        return handleAgentChatCompletion({
          agent,
          auth,
          body: body as Record<string, unknown>,
          headers: request.headers,
          model: modelKey,
          reply,
        });
      }

      const requestedOutputTokens =
        typeof body.max_completion_tokens === 'number'
          ? body.max_completion_tokens
          : typeof body.max_tokens === 'number'
            ? body.max_tokens
            : undefined;
      const estimatedInputTokens = estimateTokens(extractMessageText(body.messages));
      const estimatedTotalTokens = requestedOutputTokens === undefined
        ? estimatedInputTokens
        : estimatedInputTokens + requestedOutputTokens;
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
          totalTokens: estimatedTotalTokens,
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
        logger.error('Client chat quota check error', { error });
        return reply.code(500).send({
          error: {
            message: 'Quota check failed',
            type: 'server_error',
          },
        });
      }

      const result = await handleChatCompletion({
        body,
        modelKey,
        projectId: auth.projectId,
        stream: Boolean(body.stream),
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        // Settling here (rather than after the call returns, as before) is
        // what makes this work for BOTH stream and non-stream: a streamed
        // response's real usage isn't known until long after this function
        // has already returned the still-open stream below, so a post-hoc
        // `if (result.usage)` check here silently never fired for it — the
        // budget counter never debited a single streamed request. See the
        // 2026-09-05 assessment, F-05.
        onUsageSettled: (cost) => {
          void settleUsageBudget(quotaContext, cost);
        },
      });

      const actualOutputTokens = result.usage?.outputTokens || 0;
      if (actualOutputTokens > 0) {
        void checkRateLimit(quotaContext, { tokens: actualOutputTokens }).catch((error) =>
          logger.error('Failed to update chat rate limit usage', { error }),
        );
      }

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
      logger.error('Client chat completion error', { error });

      if (error instanceof GuardrailBlockError) {
        return reply.code(400).send({
          error: {
            action: error.action,
            findings: error.findings,
            guardrail_key: error.guardrailKey,
            message: error.message,
            type: 'guardrail_block',
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
            providerRequest: sanitize({ body, model: body?.model }),
            providerResponse: sanitize({ error: errorMessage }),
            requestId: typeof body?.request_id === 'string'
              ? body.request_id
              : crypto.randomUUID(),
            route: 'chat.completions',
            status: 'error',
            usage: {},
          });
        }
      } catch (logError) {
        logger.error('Failed to log client chat completion error', { error: logError });
      }

      if (normalizedError.status >= 400 && normalizedError.status < 500) {
        // Keeps a provider's 401/403 out of the security audit trail's `denied`
        // bucket — our own auth already passed to get here.
        request.upstreamStatusForwarded = true;
      }

      return reply.code(normalizedError.status).send({ error: normalizedError.error });
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
        ...openAiResponseToAnthropic(result.response ?? {}, modelKey),
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
