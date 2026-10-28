/**
 * The model side of `POST /client/v1/chat/completions`, as a function: the
 * per-request, rate and budget checks, the gateway call (guardrails, routing,
 * usage logging) and the failure answer. `POST /client/v1/responses` with a
 * model target runs its translated request through the same function, so a
 * model call is metered and guarded the same way whichever dialect asked —
 * never over HTTP.
 */

import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { GuardrailBlockError, handleChatCompletion, type ChatCompletionOutcome } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { isUsageBookedError, normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { checkBudget, checkPerRequestLimits, checkRateLimit, settleUsageBudget } from '@/lib/quota/quotaGuard';

const logger = createLogger('api:model-chat-gateway');

export type ChatCompletionRequest = {
  [key: string]: unknown;
  max_completion_tokens?: number;
  max_tokens?: number;
  messages?: unknown;
  model?: string;
  request_id?: string;
  stream?: boolean;
};

type MessageContentPart = string | { text?: string };

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function extractMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }

  const parts: string[] = [];
  for (const message of messages as Array<{ content?: string | MessageContentPart[] }>) {
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

export function sanitize(value: unknown, max = 20_000) {
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

export function quotaExceededPayload(message = 'Quota exceeded') {
  return { error: { message, type: 'rate_limit_error' } };
}

export type ModelChatOutcome =
  /** A check refused the call before it reached the model (429, or 500 when a check could not run). */
  | { kind: 'refused'; status: number; body: { error: Record<string, unknown> } }
  | { kind: 'ok'; result: ChatCompletionOutcome };

/**
 * One model call through the gateway for a client token: per-request limits,
 * rate limit and budget first (refusals are returned, not thrown), then
 * `handleChatCompletion`, whose realized cost settles the budget when it is
 * known — for a stream that is long after this returns. `route` labels the
 * usage row (the dialect the client spoke). Gateway errors throw; answer
 * them with `modelChatFailure`.
 */
export async function runModelChatCompletion(
  auth: ApiTokenContext,
  body: ChatCompletionRequest,
  options: { modelKey: string; route?: string },
): Promise<ModelChatOutcome> {
  const { modelKey } = options;
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
      return { kind: 'refused', status: 429, body: quotaExceededPayload(quotaResult.reason || 'Quota exceeded') };
    }

    const rateLimitResult = await checkRateLimit(quotaContext, {
      requests: 1,
      tokens: estimatedInputTokens,
    });
    if (!rateLimitResult.allowed) {
      return { kind: 'refused', status: 429, body: quotaExceededPayload(rateLimitResult.reason || 'Rate limit exceeded') };
    }

    const budgetResult = await checkBudget(quotaContext);
    if (!budgetResult.allowed) {
      return { kind: 'refused', status: 429, body: quotaExceededPayload(budgetResult.reason || 'Budget exceeded') };
    }
  } catch (error) {
    logger.error('Client chat quota check error', { error });
    return { kind: 'refused', status: 500, body: { error: { message: 'Quota check failed', type: 'server_error' } } };
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
    ...(options.route ? { route: options.route } : {}),
    // Settling here (rather than after the call returns, as before) is
    // what makes this work for BOTH stream and non-stream: a streamed
    // response's real usage isn't known until long after this function
    // has already returned the still-open stream, so a post-hoc
    // `if (result.usage)` check silently never fired for it — the
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
  return { kind: 'ok', result };
}

/**
 * The answer to a model call that threw: a guardrail block is a 400 naming
 * it; anything else is the upstream's error, normalized to an OpenAI status
 * and body, and recorded as an error usage row on the model.
 */
export async function modelChatFailure(
  request: FastifyRequest,
  auth: ApiTokenContext,
  call: { modelKey: string; body: unknown; startedAt: number; route?: string },
  error: unknown,
): Promise<{ status: number; body: { error: Record<string, unknown> } }> {
  if (error instanceof GuardrailBlockError) {
    return {
      status: 400,
      body: {
        error: {
          action: error.action,
          findings: error.findings,
          guardrail_key: error.guardrailKey,
          message: error.message,
          type: 'guardrail_block',
        },
      },
    };
  }

  const normalizedError = normalizeInferenceError(error);

  try {
    // A limit hit the core billed already has its row (real tokens, status error).
    const model = call.modelKey && !isUsageBookedError(error)
      ? await getModelByKey(auth.tenantDbName, call.modelKey, auth.projectId)
      : null;
    if (model) {
      const errorMessage = normalizedError.error.message;
      const body = call.body as { model?: unknown; request_id?: unknown } | undefined;
      await logModelUsage(auth.tenantDbName, model, {
        errorMessage,
        latencyMs: Date.now() - call.startedAt,
        providerRequest: sanitize({ body: call.body, model: body?.model }),
        providerResponse: sanitize({ error: errorMessage }),
        requestId: typeof body?.request_id === 'string'
          ? body.request_id
          : crypto.randomUUID(),
        route: call.route ?? 'chat.completions',
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

  return { status: normalizedError.status, body: { error: normalizedError.error as unknown as Record<string, unknown> } };
}
