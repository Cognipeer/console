/**
 * Client Sandbox API — token-authenticated, designed for AI agents.
 *
 * Auth: API token (Bearer) under /api/client/v1/sandbox/*. Requests and
 * responses are intentionally minimal — spin a sandbox up with optional env,
 * run commands/code, manage its lifecycle. No internal bookkeeping is exposed.
 *
 * Routes are written without the '/api' prefix (added by the parent).
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getApiTokenContextForRequest, safeReadJsonBody, withClientApiRequestContext } from '../fastify-utils';
import { listTemplates } from '@/lib/services/sandbox/templateService';
import {
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
} from '@/lib/services/sandbox/instanceService';
import { codeRunInSandbox, execInSandbox } from '@/lib/services/sandbox/execService';

const logger = createLogger('api:client-sandbox');

/** Resolve a template by id, then by key, else the first available template. */
async function resolveTemplateId(tenantDbName: string, ref?: string): Promise<string | null> {
  const templates = await listTemplates(tenantDbName);
  if (templates.length === 0) return null;
  if (!ref) return templates[0].id;
  const byId = templates.find((t) => t.id === ref);
  if (byId) return byId.id;
  const byKey = templates.find((t) => t.key === ref);
  return byKey ? byKey.id : null;
}

export const clientSandboxApiPlugin: FastifyPluginAsync = async (app) => {
  // Create a sandbox.  Body: { template?, env?, name?, runnerId?, volumeId? }
  app.post(
    '/client/v1/sandbox/sandboxes',
    withClientApiRequestContext(async (request, reply) => {
      const ctx = await getApiTokenContextForRequest(request);
      const body = safeReadJsonBody(request) as {
        template?: string;
        env?: Record<string, string>;
        name?: string;
        runnerId?: string;
        volumeId?: string;
      };
      const templateId = await resolveTemplateId(ctx.tenantDbName, body.template);
      if (!templateId) return reply.code(400).send({ error: 'no-template-available' });
      try {
        const instance = await createInstance(
          ctx.tenantDbName,
          ctx.tenantId,
          {
            templateId,
            name: body.name ?? `sbx-${Date.now()}`,
            runnerId: body.runnerId ?? null,
            volumeId: body.volumeId ?? null,
            projectId: ctx.projectId ?? null,
            env: body.env ?? {},
          },
          'api-token',
        );
        return reply.code(201).send({ id: instance.id, status: instance.actualState });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'create-failed' });
      }
    }),
  );

  app.get(
    '/client/v1/sandbox/sandboxes',
    withClientApiRequestContext(async (request, reply) => {
      const ctx = await getApiTokenContextForRequest(request);
      const instances = await listInstances(
        ctx.tenantDbName,
        ctx.projectId ? { projectId: ctx.projectId } : undefined,
      );
      return reply.code(200).send({
        sandboxes: instances.map((i) => ({ id: i.id, name: i.name, status: i.actualState })),
      });
    }),
  );

  app.get(
    '/client/v1/sandbox/sandboxes/:id',
    withClientApiRequestContext(async (request, reply) => {
      const ctx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const instance = await getInstance(ctx.tenantDbName, id);
      if (!instance) return reply.code(404).send({ error: 'not-found' });
      return reply.code(200).send({ id: instance.id, name: instance.name, status: instance.actualState });
    }),
  );

  // Run a shell command and return the result.
  app.post(
    '/client/v1/sandbox/sandboxes/:id/exec',
    withClientApiRequestContext(async (request, reply) => {
      const ctx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = safeReadJsonBody(request) as { command?: string; cwd?: string; timeoutSec?: number };
      if (!body.command) return reply.code(400).send({ error: 'command-required' });
      const result = await execInSandbox({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        instanceId: id,
        command: body.command,
        cwd: body.cwd,
        timeoutSec: body.timeoutSec,
        by: 'api-token',
      });
      if (!result) return reply.code(404).send({ error: 'not-found-or-not-ready' });
      return reply.code(200).send(result);
    }),
  );

  // Run code with the appropriate interpreter and return the result.
  app.post(
    '/client/v1/sandbox/sandboxes/:id/code',
    withClientApiRequestContext(async (request, reply) => {
      const ctx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = safeReadJsonBody(request) as {
        code?: string;
        language?: 'python' | 'javascript' | 'typescript' | 'bash';
        cwd?: string;
        timeoutSec?: number;
      };
      if (!body.code) return reply.code(400).send({ error: 'code-required' });
      const result = await codeRunInSandbox({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        instanceId: id,
        code: body.code,
        language: body.language,
        cwd: body.cwd,
        timeoutSec: body.timeoutSec,
        by: 'api-token',
      });
      if (!result) return reply.code(404).send({ error: 'not-found-or-not-ready' });
      return reply.code(200).send(result);
    }),
  );

  app.delete(
    '/client/v1/sandbox/sandboxes/:id',
    withClientApiRequestContext(async (request, reply) => {
      const ctx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const instance = await deleteInstance(ctx.tenantDbName, ctx.tenantId, id, 'api-token');
      if (!instance) return reply.code(404).send({ error: 'not-found' });
      return reply.code(200).send({ ok: true });
    }),
  );

  logger.info('client sandbox API registered');
};
