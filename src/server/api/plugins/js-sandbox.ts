import type { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { createLogger } from '@/lib/core/logger';
import {
  createJsSandboxRuntime,
  deleteJsSandboxRuntime,
  executeJsSandboxCode,
  formatJsSandboxValidationError,
  getJsSandboxExecution,
  getJsSandboxRuntime,
  JS_SANDBOX_LIBRARY_DESCRIPTORS,
  listJsSandboxExecutions,
  listJsSandboxRuntimes,
  updateJsSandboxRuntime,
  createJsSandboxRuntimeInputSchema,
  executeJsSandboxInputSchema,
  updateJsSandboxRuntimeInputSchema,
} from '@/lib/services/jsSandbox';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:js-sandbox');

function sendValidationError(reply: { code: (statusCode: number) => { send: (body: Record<string, unknown>) => unknown } }, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: formatJsSandboxValidationError(error) });
  }
  return null;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export const jsSandboxApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/js-sandbox/libraries', withApiRequestContext(async (_request, reply) => {
    return reply.code(200).send({ libraries: JS_SANDBOX_LIBRARY_DESCRIPTORS });
  }));

  app.get('/js-sandbox/runtimes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; search?: string };
      const runtimes = await listJsSandboxRuntimes(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { status: query.status, search: query.search },
      );
      return reply.code(200).send({ runtimes });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List JS Sandbox runtimes failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/js-sandbox/runtimes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = createJsSandboxRuntimeInputSchema.parse(readJsonBody<unknown>(request));
      const runtime = await createJsSandboxRuntime(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send({ runtime });
    } catch (error) {
      if (sendProjectContextError(reply, error) || sendValidationError(reply, error)) return;
      logger.error('Create JS Sandbox runtime failed', { error });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Failed to create JS runtime' });
    }
  }));

  app.get('/js-sandbox/runtimes/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const runtime = await getJsSandboxRuntime(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
      );
      if (!runtime) return reply.code(404).send({ error: 'JS runtime not found' });
      return reply.code(200).send({ runtime });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Get JS Sandbox runtime failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/js-sandbox/runtimes/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = updateJsSandboxRuntimeInputSchema.parse(readJsonBody<unknown>(request));
      const runtime = await updateJsSandboxRuntime(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
        { ...body, updatedBy: session.userEmail ?? session.userId },
      );
      if (!runtime) return reply.code(404).send({ error: 'JS runtime not found' });
      return reply.code(200).send({ runtime });
    } catch (error) {
      if (sendProjectContextError(reply, error) || sendValidationError(reply, error)) return;
      logger.error('Update JS Sandbox runtime failed', { error });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Failed to update JS runtime' });
    }
  }));

  app.delete('/js-sandbox/runtimes/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const deleted = await deleteJsSandboxRuntime(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
      );
      if (!deleted) return reply.code(404).send({ error: 'JS runtime not found' });
      return reply.code(204).send();
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Delete JS Sandbox runtime failed', { error });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Failed to delete JS runtime' });
    }
  }));

  app.post('/js-sandbox/execute', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = executeJsSandboxInputSchema.parse(readJsonBody<unknown>(request));
      const execution = await executeJsSandboxCode(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, callerType: 'dashboard' },
      );
      return reply.code(200).send({ execution });
    } catch (error) {
      if (sendProjectContextError(reply, error) || sendValidationError(reply, error)) return;
      logger.error('Execute JS Sandbox code failed', { error });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Failed to execute JS code' });
    }
  }));

  app.post('/js-sandbox/runtimes/:idOrKey/execute', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const raw = readJsonBody<Record<string, unknown>>(request);
      const body = executeJsSandboxInputSchema.parse({ ...raw, jsRuntimeId: idOrKey });
      const execution = await executeJsSandboxCode(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, callerType: 'dashboard' },
      );
      return reply.code(200).send({ execution });
    } catch (error) {
      if (sendProjectContextError(reply, error) || sendValidationError(reply, error)) return;
      logger.error('Execute JS Sandbox runtime code failed', { error });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Failed to execute JS code' });
    }
  }));

  app.get('/js-sandbox/executions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        from?: string;
        limit?: string;
        page?: string;
        runtimeId?: string;
        runtimeKey?: string;
        skip?: string;
        status?: string;
        to?: string;
      };
      const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '50', 10) || 50, 1), 200);
      const page = Math.max(Number.parseInt(query.page ?? '1', 10) || 1, 1);
      const skip = Number.isNaN(Number.parseInt(query.skip ?? 'NaN', 10))
        ? (page - 1) * limit
        : Math.max(Number.parseInt(query.skip ?? '0', 10), 0);
      const result = await listJsSandboxExecutions(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        {
          from: parseDate(query.from),
          limit,
          runtimeId: query.runtimeId,
          runtimeKey: query.runtimeKey,
          skip,
          status: query.status,
          to: parseDate(query.to),
        },
      );
      return reply.code(200).send({
        ...result,
        limit,
        page,
        totalPages: Math.max(Math.ceil(result.total / limit), 1),
      });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List JS Sandbox executions failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/js-sandbox/executions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const execution = await getJsSandboxExecution(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        id,
      );
      if (!execution) return reply.code(404).send({ error: 'Execution not found' });
      return reply.code(200).send({ execution });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Get JS Sandbox execution failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
