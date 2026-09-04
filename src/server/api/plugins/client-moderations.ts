/**
 * Client Moderation API plugin (OpenAI-compatible).
 *
 *   POST /client/v1/moderations – classify text against a moderation guardrail
 *
 * The OpenAI `model` field selects the detector: a console guardrail key (the
 * LLM-judge path), or the key of a model whose category is `moderation` (a
 * native classifier). When omitted the project decides — its enabled moderation
 * guardrail, else its registered moderation model — so an OpenAI client pointed
 * at the console works without code changes once either exists.
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
        // Console extensions: which detector ran, and whether the scores are
        // model probabilities or severity buckets — a caller thresholding on
        // `category_scores` has to be able to tell.
        detector: result.detector,
        score_source: result.scoreSource,
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
