/**
 * Client Evaluation API plugin.
 *
 * External-facing, API-token-authenticated surface under `/client/v1/*` with
 * snake_case fields like the other client modules. It is read- and
 * trigger-oriented — designed for CI/automation:
 *
 *   GET  /client/v1/evaluation/suites             – list configured suites
 *   POST /client/v1/evaluation/suites/:key/run    – run a suite (synchronous)
 *   GET  /client/v1/evaluation/runs               – list runs (?suite_key, ?limit)
 *   GET  /client/v1/evaluation/runs/:id           – get one run + per-item scores
 *
 * Authoring of targets / datasets / suites stays on the dashboard surface
 * (`/api/evaluation/*`, session-authenticated) — an admin concern.
 *
 * Serializers are shared with the route-handler layer
 * (`routes/client/v1/evaluation/shared.ts`) so both speak one envelope.
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getRun, listRuns, listSuites, runSuite } from '@/lib/services/evaluation/service';
import {
  toRunSummary,
  toRunView,
  toSuiteView,
} from '../routes/client/v1/evaluation/shared';
import {
  getApiTokenContextForRequest,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-evaluation');

function clampLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 200);
}

function fail(reply: import('fastify').FastifyReply, error: unknown, scope: string) {
  logger.error(`Client evaluation ${scope} error`, { error });
  const message = error instanceof Error ? error.message : 'Internal error';
  return (
    sendApiTokenError(reply, error)
    ?? reply.code(message.toLowerCase().includes('not found') ? 404 : 500).send({ error: message })
  );
}

export const clientEvaluationsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/evaluation/suites', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const suites = await listSuites(ctx.tenantDbName, { projectId: ctx.projectId });
      return reply.code(200).send({ suites: suites.map(toSuiteView) });
    } catch (error) {
      return fail(reply, error, 'list suites');
    }
  }));

  app.post('/client/v1/evaluation/suites/:key/run', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      if (!key) return reply.code(400).send({ error: 'suite key is required' });
      const run = await runSuite({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        createdBy: ctx.tokenRecord.userId ?? 'api-token',
        suiteKey: key,
      });
      return reply.code(201).send({ run: toRunView(run) });
    } catch (error) {
      return fail(reply, error, 'run suite');
    }
  }));

  app.get('/client/v1/evaluation/runs', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { suite_key?: string; limit?: string };
      const runs = await listRuns(ctx.tenantDbName, {
        projectId: ctx.projectId,
        suiteKey: query.suite_key,
        limit: clampLimit(query.limit),
      });
      return reply.code(200).send({ runs: runs.map(toRunSummary) });
    } catch (error) {
      return fail(reply, error, 'list runs');
    }
  }));

  app.get('/client/v1/evaluation/runs/:id', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const run = await getRun(ctx.tenantDbName, id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run: toRunView(run) });
    } catch (error) {
      return fail(reply, error, 'get run');
    }
  }));
};
