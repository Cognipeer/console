import type { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { createLogger } from '@/lib/core/logger';
import {
  executeJsSandboxCode,
  executeJsSandboxInputSchema,
  formatJsSandboxValidationError,
  getJsSandboxRuntime,
  listJsSandboxRuntimes,
} from '@/lib/services/jsSandbox';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-js-sandbox');

function sendValidationError(reply: { code: (statusCode: number) => { send: (body: Record<string, unknown>) => unknown } }, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: formatJsSandboxValidationError(error) });
  }
  return null;
}

export const clientJsSandboxApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/js-sandbox/runtimes', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; search?: string };
      const runtimes = await listJsSandboxRuntimes(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { status: query.status, search: query.search },
      );
      return reply.code(200).send({ runtimes });
    } catch (error) {
      logger.error('List client JS Sandbox runtimes failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/js-sandbox/runtimes/:idOrKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const runtime = await getJsSandboxRuntime(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        idOrKey,
      );
      if (!runtime) return reply.code(404).send({ error: 'JS runtime not found' });
      return reply.code(200).send({ runtime });
    } catch (error) {
      logger.error('Get client JS Sandbox runtime failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/js-sandbox/execute', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = executeJsSandboxInputSchema.parse(readJsonBody<unknown>(request));
      const execution = await executeJsSandboxCode(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        {
          ...body,
          callerTokenId: String(ctx.tokenRecord._id ?? ''),
          callerType: 'api',
        },
      );
      return reply.code(200).send({
        durationMs: execution.durationMs,
        errorMessage: execution.errorMessage,
        executionId: execution.executionId,
        logs: execution.logs,
        result: execution.result,
        runtimeKey: execution.runtimeKey,
        status: execution.status,
      });
    } catch (error) {
      if (sendValidationError(reply, error)) return;
      logger.error('Execute client JS Sandbox code failed', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Failed to execute JS code',
      });
    }
  }));
};
