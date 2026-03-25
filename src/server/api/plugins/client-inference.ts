import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { runWithRequestContext } from '@/lib/core/requestContext';
import {
  ApiTokenAuthError,
  type ApiTokenContext,
} from '@/lib/services/apiTokenAuth';
import {
  GuardrailBlockError,
  handleChatCompletion,
  handleEmbeddingRequest,
} from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
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
  readJsonBody,
  requireApiTokenContext,
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

function unauthorizedPayload(message = 'Invalid API token') {
  return { error: { message, type: 'invalid_request_error' } };
}

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

function withOpenAiClientContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: { message: 'Service is shutting down', type: 'server_error' } });
    }

    let auth: ApiTokenContext;
    try {
      auth = await requireApiTokenContext(request);
      request.apiTokenContext = auth;
    } catch (error) {
      if (error instanceof ApiTokenAuthError) {
        return reply.code(401).send(unauthorizedPayload(error.message));
      }

      logger.error('Client inference auth error', { error });
      return reply.code(401).send(unauthorizedPayload());
    }

    return runWithRequestContext(
      {
        requestId: request.apiRequestId,
        tenantId: auth.tenantId,
        tenantSlug: auth.tenantSlug,
        userId: auth.user?._id ? String(auth.user._id) : undefined,
      },
      () => handler(request as TRequest, reply, auth),
    );
  };
}

export const clientInferenceApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/chat/completions', withOpenAiClientContext(async (request, reply, auth) => {
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
      });

      const actualOutputTokens = result.usage?.outputTokens || 0;
      if (actualOutputTokens > 0) {
        void checkRateLimit(quotaContext, { tokens: actualOutputTokens }).catch((error) =>
          logger.error('Failed to update chat rate limit usage', { error }),
        );
      }

      if (result.usage) {
        void getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
          .then((model) => {
            if (!model) {
              return undefined;
            }

            const cost = calculateCost(model.pricing, result.usage);
            if (
              cost.currency !== 'USD'
              || !Number.isFinite(cost.totalCost)
              || cost.totalCost <= 0
            ) {
              return undefined;
            }

            return checkBudget(quotaContext, { usd: cost.totalCost });
          })
          .catch((error) => logger.error('Failed to update chat budget usage', { error }));
      }

      if (result.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Request-Id', result.requestId);

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

      try {
        const model = modelKey
          ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
          : null;
        if (model) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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

      return reply.code(500).send({
        error: {
          message: error instanceof Error ? error.message : 'Inference error',
          type: 'server_error',
        },
      });
    }
  }));

  app.post('/client/v1/embeddings', withOpenAiClientContext(async (request, reply, auth) => {
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

      try {
        const model = modelKey
          ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
          : null;
        if (model) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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

      return reply.code(500).send({
        error: {
          message: error instanceof Error ? error.message : 'Inference error',
          type: 'server_error',
        },
      });
    }
  }));
};
