/**
 * Client Moderation API plugin (OpenAI-compatible).
 *
 *   POST /client/v1/moderations – classify text against a moderation guardrail
 *
 * The OpenAI `model` field selects the console guardrail to evaluate with
 * (any enabled guardrail key). When omitted, the tenant's first enabled
 * guardrail with an active moderation policy is used, so an OpenAI client
 * pointed at the console works without code changes once such a guardrail
 * exists.
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  ModerationRequestError,
  runModeration,
} from '@/lib/services/guardrail';
import {
  getApiTokenContextForRequest,
  safeReadJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-moderations');

export const clientModerationsApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/moderations', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = safeReadJsonBody<Record<string, unknown>>(request);

      if (body.input === undefined) {
        return reply.code(400).send({
          error: { message: '`input` is required', type: 'invalid_request_error' },
        });
      }
      if (body.model !== undefined && typeof body.model !== 'string') {
        return reply.code(400).send({
          error: { message: '`model` must be a guardrail key string', type: 'invalid_request_error' },
        });
      }

      const result = await runModeration(
        {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
        },
        { input: body.input, model: body.model },
      );

      return reply.code(200).send({
        id: result.id,
        model: result.model,
        results: result.results.map((entry) => ({
          flagged: entry.flagged,
          categories: entry.categories,
          category_scores: entry.categoryScores,
          // Console extension: the raw guardrail findings (includes PII and
          // prompt-shield findings when those policies are enabled).
          findings: entry.findings,
        })),
      });
    } catch (error) {
      if (error instanceof ModerationRequestError) {
        return reply.code(400).send({
          error: { message: error.message, type: 'invalid_request_error' },
        });
      }
      logger.error('Client moderation error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({
          error: {
            message: error instanceof Error ? error.message : 'Moderation error',
            type: 'server_error',
          },
        });
    }
  }));
};
