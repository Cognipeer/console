import type { FastifyPluginAsync } from 'fastify';
import Mustache from 'mustache';
import { createLogger } from '@/lib/core/logger';
import {
  activatePromptDeployment,
  comparePromptVersions,
  getPromptByKey,
  listPromptDeployments,
  listPrompts,
  listPromptVersions,
  planPromptDeployment,
  promotePromptVersion,
  resolvePromptForEnvironment,
  rollbackPromptDeployment,
  type PromptEnvironment,
} from '@/lib/services/prompts';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-prompts');

function isPromptEnvironment(value: unknown): value is PromptEnvironment {
  return value === 'dev' || value === 'staging' || value === 'prod';
}

export const clientPromptsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/prompts', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const prompts = await listPrompts(ctx.tenantDbName, ctx.projectId, {
        search: query.search,
      });

      return reply.code(200).send({ prompts });
    } catch (error) {
      logger.error('List client prompts error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/prompts/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { environment?: string; version?: string };
      const environment = query.environment as PromptEnvironment | undefined;
      const version = query.version !== undefined ? Number.parseInt(query.version, 10) : undefined;

      if (environment && !isPromptEnvironment(environment)) {
        return reply.code(400).send({ error: 'Invalid environment' });
      }

      if (query.version !== undefined && (!Number.isFinite(version) || (version as number) <= 0)) {
        return reply.code(400).send({ error: 'Invalid version' });
      }

      const resolved = await resolvePromptForEnvironment(
        ctx.tenantDbName,
        ctx.projectId,
        key,
        environment,
        version,
      );

      if (!resolved) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      return reply.code(200).send({
        prompt: resolved.prompt,
        resolvedVersion: resolved.resolvedVersion
          ? {
            description: resolved.resolvedVersion.description,
            id: resolved.resolvedVersion.id,
            isLatest: resolved.resolvedVersion.isLatest,
            name: resolved.resolvedVersion.name,
            version: resolved.resolvedVersion.version,
          }
          : null,
      });
    } catch (error) {
      logger.error('Get client prompt error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/prompts/:key/versions', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const prompt = await getPromptByKey(ctx.tenantDbName, ctx.projectId, key);

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      const versions = await listPromptVersions(ctx.tenantDbName, ctx.projectId, prompt.id);
      return reply.code(200).send({
        prompt: {
          key: prompt.key,
          name: prompt.name,
        },
        versions: versions.map((version) => ({
          comment: version.comment,
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          description: version.description,
          id: version.id,
          isLatest: version.isLatest,
          name: version.name,
          version: version.version,
        })),
      });
    } catch (error) {
      logger.error('List client prompt versions error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/prompts/:key/compare', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { fromVersionId?: string; toVersionId?: string };
      const prompt = await getPromptByKey(ctx.tenantDbName, ctx.projectId, key);

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      if (!query.fromVersionId || !query.toVersionId) {
        return reply.code(400).send({ error: 'fromVersionId and toVersionId are required' });
      }

      const comparison = await comparePromptVersions(
        ctx.tenantDbName,
        ctx.projectId,
        prompt.id,
        query.fromVersionId,
        query.toVersionId,
      );

      if (!comparison) {
        return reply.code(404).send({ error: 'Prompt or versions not found' });
      }

      return reply.code(200).send({
        comparison,
        prompt: {
          id: prompt.id,
          key: prompt.key,
          name: prompt.name,
        },
      });
    } catch (error) {
      logger.error('Compare client prompt versions error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/prompts/:key/deployments', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const prompt = await getPromptByKey(ctx.tenantDbName, ctx.projectId, key);

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      const deployments = await listPromptDeployments(ctx.tenantDbName, ctx.projectId, prompt.id);
      return reply.code(200).send({
        deployments,
        prompt: {
          id: prompt.id,
          key: prompt.key,
          name: prompt.name,
        },
      });
    } catch (error) {
      logger.error('List client prompt deployments error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/prompts/:key/deployments', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const prompt = await getPromptByKey(ctx.tenantDbName, ctx.projectId, key);

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const action = typeof body.action === 'string' ? body.action : '';
      const note = typeof body.note === 'string' ? body.note.trim() : undefined;
      const environment = body.environment;

      if (!isPromptEnvironment(environment)) {
        return reply.code(400).send({ error: 'environment must be one of dev/staging/prod' });
      }

      let updatedPrompt = null;
      if (action === 'promote') {
        const versionId = typeof body.versionId === 'string' ? body.versionId.trim() : '';
        if (!versionId) {
          return reply.code(400).send({ error: 'versionId is required for promote action' });
        }
        updatedPrompt = await promotePromptVersion(
          ctx.tenantDbName,
          ctx.projectId,
          prompt.id,
          ctx.tokenRecord.userId,
          { environment, note, versionId },
        );
      } else if (action === 'plan') {
        updatedPrompt = await planPromptDeployment(
          ctx.tenantDbName,
          ctx.projectId,
          prompt.id,
          ctx.tokenRecord.userId,
          { environment, note },
        );
      } else if (action === 'activate') {
        updatedPrompt = await activatePromptDeployment(
          ctx.tenantDbName,
          ctx.projectId,
          prompt.id,
          ctx.tokenRecord.userId,
          environment,
          note,
        );
      } else if (action === 'rollback') {
        updatedPrompt = await rollbackPromptDeployment(
          ctx.tenantDbName,
          ctx.projectId,
          prompt.id,
          ctx.tokenRecord.userId,
          environment,
          note,
        );
      } else {
        return reply.code(400).send({
          error: 'action must be one of promote, plan, activate, rollback',
        });
      }

      if (!updatedPrompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      const deployments = await listPromptDeployments(ctx.tenantDbName, ctx.projectId, prompt.id);
      return reply.code(200).send({ deployments, prompt: updatedPrompt });
    } catch (error) {
      logger.error('Mutate client prompt deployment error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/prompts/:key/render', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { environment?: string; version?: string };
      const environment = query.environment as PromptEnvironment | undefined;
      const version = query.version !== undefined ? Number.parseInt(query.version, 10) : undefined;

      if (environment && !isPromptEnvironment(environment)) {
        return reply.code(400).send({ error: 'Invalid environment' });
      }

      if (query.version !== undefined && (!Number.isFinite(version) || (version as number) <= 0)) {
        return reply.code(400).send({ error: 'Invalid version' });
      }

      const resolved = await resolvePromptForEnvironment(
        ctx.tenantDbName,
        ctx.projectId,
        key,
        environment,
        version,
      );

      if (!resolved) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const rawData = body.data && typeof body.data === 'object' ? body.data : body;
      const rendered = Mustache.render(
        resolved.prompt.template,
        rawData as Record<string, unknown>,
      );

      return reply.code(200).send({
        prompt: {
          environment: environment ?? null,
          key: resolved.prompt.key,
          name: resolved.prompt.name,
          version: resolved.prompt.currentVersion ?? 1,
        },
        rendered,
      });
    } catch (error) {
      logger.error('Render client prompt error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
