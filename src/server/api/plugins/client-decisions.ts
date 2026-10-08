/**
 * Client Decisions API plugin.
 *
 *   POST /client/v1/decisions – typed answers (choice / score / boolean) with
 *                               probabilities for a set of closed questions
 *
 * `model` is the key of a Model Hub entry whose category is `decision`. In P1
 * every decision model is served by the structured-output emulator over a chat
 * model (`backend.kind: 'structured'`); native vendor endpoints come later
 * behind the same contract. No streaming.
 *
 * Auth, tenant binding and RBAC are the shared `withClientApiRequestContext`
 * lifecycle (path `/api/client/v1/decisions` is gated as the `models` service in
 * `rbac.ts`); quota follows the other model-invocation routes.
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import {
  DecisionRequestError,
  parseDecisionRequest,
  type ParsedDecisionRequest,
} from '@/lib/providers/contracts/decisionHelpers';
import { DecisionBackendError } from '@/lib/providers/contracts/structuredDecisionRuntime';
import { handleDecisionRequest } from '@/lib/services/models/decisionService';
import { GuardrailBlockError } from '@/lib/services/models/inferenceService';
import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
  settleUsageBudget,
} from '@/lib/quota/quotaGuard';
import { readJsonBody, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-decisions');

function estimateRequestTokens(request: ParsedDecisionRequest): number {
  let chars = 0;
  for (const part of request.input) {
    if (part.type === 'text') chars += part.text.length;
  }
  for (const question of Object.values(request.questions)) {
    chars += question.instructions?.length ?? 0;
    if (question.type === 'choice') {
      for (const [key, description] of Object.entries(question.choices)) chars += key.length + description.length;
    } else if (question.type === 'score') {
      for (const level of question.levels) chars += level.length;
    }
  }
  return Math.ceil(chars / 4);
}

function invalidRequest(message: string, extra: Record<string, unknown> = {}) {
  return { error: { message, type: 'invalid_request_error', ...extra } };
}

export const clientDecisionsApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/decisions', withClientApiRequestContext(async (request, reply, auth) => {
    const startedAt = Date.now();
    let modelKey = '';
    let parsed: ParsedDecisionRequest | undefined;

    try {
      let body: unknown;
      try {
        body = readJsonBody<unknown>(request);
      } catch (error) {
        if (error instanceof SyntaxError) {
          return reply.code(400).send(invalidRequest('Invalid JSON body'));
        }
        throw error;
      }

      parsed = parseDecisionRequest(body);
      modelKey = parsed.model;

      const estimatedInputTokens = estimateRequestTokens(parsed);
      const quotaContext = {
        domain: 'decision' as const,
        licenseType: auth.tenant.licenseType as LicenseType,
        projectId: auth.projectId,
        resourceKey: modelKey,
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        tokenId: auth.tokenRecord._id?.toString() ?? auth.token,
        userId: auth.tokenRecord.userId,
      };

      try {
        const limits = await checkPerRequestLimits(quotaContext, {
          inputTokens: estimatedInputTokens,
          totalTokens: estimatedInputTokens,
        });
        if (!limits.allowed) {
          return reply.code(429).send({
            error: { message: limits.reason || 'Quota exceeded', type: 'rate_limit_error' },
          });
        }
        const rate = await checkRateLimit(quotaContext, { requests: 1, tokens: estimatedInputTokens });
        if (!rate.allowed) {
          return reply.code(429).send({
            error: { message: rate.reason || 'Rate limit exceeded', type: 'rate_limit_error' },
          });
        }
        const budget = await checkBudget(quotaContext);
        if (!budget.allowed) {
          return reply.code(429).send({
            error: { message: budget.reason || 'Budget exceeded', type: 'rate_limit_error' },
          });
        }
      } catch (error) {
        logger.error('Client decision quota check error', { error });
        return reply.code(500).send({
          error: { message: 'Quota check failed', type: 'server_error' },
        });
      }

      const outcome = await handleDecisionRequest({
        tenantDbName: auth.tenantDbName,
        projectId: auth.projectId,
        request: parsed,
      });

      void settleUsageBudget(quotaContext, outcome.cost);
      if (outcome.usage.outputTokens > 0) {
        void checkRateLimit(quotaContext, { tokens: outcome.usage.outputTokens }).catch((error) =>
          logger.error('Failed to update decision rate limit usage', { error }),
        );
      }

      const { result } = outcome;
      return reply.code(200).send({
        id: `dec_${outcome.requestId.replace(/-/g, '')}`,
        model: modelKey,
        answers: result.answers,
        // Console extension; only present when `include_rationale` produced one.
        ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
        usage: {
          input_tokens: outcome.usage.inputTokens,
          output_tokens: outcome.usage.outputTokens,
        },
        latency_ms: outcome.latencyMs,
        backend: result.backend,
      });
    } catch (error) {
      if (error instanceof DecisionRequestError) {
        return reply.code(400).send(invalidRequest(error.message, {
          ...(error.param ? { param: error.param } : {}),
          ...(error.questionId ? { question_id: error.questionId } : {}),
        }));
      }
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

      logger.error('Client decision error', { error });
      const normalized = error instanceof DecisionBackendError
        ? { status: 502, error: { message: error.message, type: 'server_error' } }
        : normalizeInferenceError(error);

      if (modelKey && normalized.status >= 500) {
        try {
          const model = await getModelByKey(auth.tenantDbName, modelKey, auth.projectId);
          if (model) {
            await logModelUsage(auth.tenantDbName, model, {
              errorMessage: normalized.error.message,
              latencyMs: Date.now() - startedAt,
              providerRequest: { model: modelKey },
              providerResponse: { error: normalized.error.message },
              requestId: crypto.randomUUID(),
              route: 'decisions',
              status: 'error',
              usage: {},
            });
          }
        } catch (logError) {
          logger.error('Failed to log decision error', { error: logError });
        }
      }

      return reply.code(normalized.status).send(
        'error' in normalized && normalized.error ? { error: normalized.error } : normalized,
      );
    }
  }));
};
