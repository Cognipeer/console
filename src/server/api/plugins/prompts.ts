import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import {
  activatePromptDeployment,
  comparePromptVersions,
  createPrompt,
  createPromptComment,
  deletePrompt,
  deletePromptComment,
  getPromptById,
  listPromptComments,
  listPromptDeployments,
  listPrompts,
  listPromptVersions,
  planPromptDeployment,
  promotePromptVersion,
  rollbackPromptDeployment,
  setPromptLatestVersion,
  updatePrompt,
  type PromptEnvironment,
} from '@/lib/services/prompts';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:prompts');

type PromptsQuery = {
  search?: string;
};

type PromptCompareQuery = {
  fromVersionId?: string;
  toVersionId?: string;
};

type PromptCommentsQuery = {
  versionId?: string;
};

function isPromptEnvironment(value: unknown): value is PromptEnvironment {
  return value === 'dev' || value === 'staging' || value === 'prod';
}

export const promptsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/prompts', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as PromptsQuery;
      const prompts = await listPrompts(session.tenantDbName, projectId, {
        search: query.search,
      });

      return reply.code(200).send({ prompts });
    } catch (error) {
      logger.error('List prompts error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/prompts', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      for (const field of ['name', 'template']) {
        const value = body[field];
        if (!value || (typeof value === 'string' && value.trim() === '')) {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const prompt = await createPrompt(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          description: body.description as string | undefined,
          key: body.key as string | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string,
          template: body.template as string,
          versionComment: (body.versionComment ?? body.comment) as string | undefined,
        },
      );

      return reply.code(201).send({ prompt });
    } catch (error) {
      logger.error('Create prompt error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/prompts/stats', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const prompts = await listPrompts(session.tenantDbName, projectId, {});

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const versionCounts = await Promise.all(
        prompts.map((prompt) =>
          db
            .listPromptVersions(prompt.id, projectId)
            .then((versions) => versions.length)
            .catch(() => 0),
        ),
      );

      const totalVersions = versionCounts.reduce((sum, count) => sum + count, 0);
      const totalVariablePrompts = prompts.filter((prompt) => /{{\s*\w+\s*}}/.test(prompt.template)).length;
      const recentlyUpdated = [...prompts]
        .sort((left, right) => {
          const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
          const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
          return rightTime - leftTime;
        })
        .slice(0, 6)
        .map((prompt) => ({
          createdAt: prompt.createdAt,
          currentVersion: prompt.currentVersion ?? 1,
          id: prompt.id,
          key: prompt.key,
          name: prompt.name,
          updatedAt: prompt.updatedAt,
        }));

      return reply.code(200).send({
        overview: {
          avgVersionsPerPrompt: prompts.length > 0
            ? Math.round((totalVersions / prompts.length) * 10) / 10
            : 0,
          totalPrompts: prompts.length,
          totalVariablePrompts,
          totalVersions,
        },
        recentlyUpdated,
        versionDistribution: [
          { count: versionCounts.filter((count) => count <= 1).length, label: '1 version' },
          { count: versionCounts.filter((count) => count >= 2 && count <= 5).length, label: '2-5 versions' },
          { count: versionCounts.filter((count) => count > 5).length, label: '6+ versions' },
        ],
      });
    } catch (error) {
      logger.error('Prompt stats error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/prompts/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const prompt = await getPromptById(session.tenantDbName, projectId, id);

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      return reply.code(200).send({ prompt });
    } catch (error) {
      logger.error('Get prompt error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/prompts/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      const prompt = await updatePrompt(session.tenantDbName, projectId, id, {
        description: body.description as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
        name: body.name as string | undefined,
        template: body.template as string | undefined,
        updatedBy: session.userId,
        versionComment: (body.versionComment ?? body.comment) as string | undefined,
      });

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      return reply.code(200).send({ prompt });
    } catch (error) {
      logger.error('Update prompt error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/prompts/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const deleted = await deletePrompt(session.tenantDbName, projectId, id);

      if (!deleted) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete prompt error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/prompts/:id/versions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const versions = await listPromptVersions(session.tenantDbName, projectId, id);

      return reply.code(200).send({ versions });
    } catch (error) {
      logger.error('List prompt versions error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/prompts/:id/versions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.versionId !== 'string' || body.versionId.trim() === '') {
        return reply.code(400).send({ error: 'versionId is required' });
      }

      const prompt = await setPromptLatestVersion(
        session.tenantDbName,
        projectId,
        id,
        body.versionId,
        session.userId,
      );

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt or version not found' });
      }

      return reply.code(200).send({ prompt });
    } catch (error) {
      logger.error('Set prompt latest version error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/prompts/:id/deployments', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const deployments = await listPromptDeployments(session.tenantDbName, projectId, id);

      if (!deployments) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      return reply.code(200).send(deployments);
    } catch (error) {
      logger.error('List prompt deployments error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/prompts/:id/deployments', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const action = typeof body.action === 'string' ? body.action : '';
      const note = typeof body.note === 'string' ? body.note.trim() : undefined;
      const environment = body.environment;

      if (!isPromptEnvironment(environment)) {
        return reply.code(400).send({ error: 'environment must be one of dev/staging/prod' });
      }

      let prompt = null;

      if (action === 'promote') {
        const versionId = typeof body.versionId === 'string' ? body.versionId.trim() : '';
        if (!versionId) {
          return reply.code(400).send({ error: 'versionId is required for promote action' });
        }

        prompt = await promotePromptVersion(session.tenantDbName, projectId, id, session.userId, {
          environment,
          note,
          versionId,
        });
      } else if (action === 'plan') {
        prompt = await planPromptDeployment(session.tenantDbName, projectId, id, session.userId, {
          environment,
          note,
        });
      } else if (action === 'activate') {
        prompt = await activatePromptDeployment(
          session.tenantDbName,
          projectId,
          id,
          session.userId,
          environment,
          note,
        );
      } else if (action === 'rollback') {
        prompt = await rollbackPromptDeployment(
          session.tenantDbName,
          projectId,
          id,
          session.userId,
          environment,
          note,
        );
      } else {
        return reply.code(400).send({
          error: 'action must be one of promote, plan, activate, rollback',
        });
      }

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      const deployments = await listPromptDeployments(session.tenantDbName, projectId, id);
      return reply.code(200).send({ deployments, prompt });
    } catch (error) {
      logger.error('Mutate prompt deployment error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/prompts/:id/compare', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as PromptCompareQuery;
      const fromVersionId = query.fromVersionId?.trim();
      const toVersionId = query.toVersionId?.trim();

      if (!fromVersionId || !toVersionId) {
        return reply.code(400).send({ error: 'fromVersionId and toVersionId are required' });
      }

      const comparison = await comparePromptVersions(
        session.tenantDbName,
        projectId,
        id,
        fromVersionId,
        toVersionId,
      );

      if (!comparison) {
        return reply.code(404).send({ error: 'Prompt or versions not found' });
      }

      return reply.code(200).send({ comparison });
    } catch (error) {
      logger.error('Compare prompt versions error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/prompts/:id/comments', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as PromptCommentsQuery;
      const comments = await listPromptComments(
        session.tenantDbName,
        projectId,
        id,
        query.versionId,
      );

      return reply.code(200).send({ comments });
    } catch (error) {
      logger.error('List prompt comments error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list comments' });
    }
  }));

  app.post('/prompts/:id/comments', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const content = body.content;

      if (typeof content !== 'string' || content.trim() === '') {
        return reply.code(400).send({ error: 'Comment content is required' });
      }

      const comment = await createPromptComment(
        session.tenantDbName,
        session.tenantId,
        projectId,
        id,
        session.userId,
        session.userEmail ?? 'Unknown',
        {
          content: content.trim(),
          version: body.version as number | undefined,
          versionId: body.versionId as string | undefined,
        },
      );

      return reply.code(201).send({ comment });
    } catch (error) {
      logger.error('Create prompt comment error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to create comment' });
    }
  }));

  app.delete('/prompts/:id/comments/:commentId', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { commentId } = request.params as { commentId: string; id: string };
      const deleted = await deletePromptComment(session.tenantDbName, commentId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Comment not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete prompt comment error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to delete comment' });
    }
  }));
};
