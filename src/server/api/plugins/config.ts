import type { FastifyPluginAsync } from 'fastify';
import type { ConfigValueType } from '@/lib/database';
import {
  createConfigGroup,
  createConfigItem,
  deleteConfigGroup,
  deleteConfigItem,
  getConfigGroupWithItems,
  getConfigItemById,
  listConfigAuditLogs,
  listConfigGroups,
  listConfigItems,
  updateConfigGroup,
  updateConfigItem,
} from '@/lib/services/config/configService';
import {
  parseBooleanQuery,
  parseCsvQuery,
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

type ConfigListQuery = {
  groupId?: string;
  isSecret?: string;
  search?: string;
  tags?: string;
};

export const configApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/config/groups', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as ConfigListQuery;

      const groups = await listConfigGroups(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          search: query.search || undefined,
          tags: parseCsvQuery(query.tags),
        },
      );

      return reply.code(200).send({ groups });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.post('/config/groups', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (!body.name || typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name is required' });
      }

      const group = await createConfigGroup(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          createdBy: session.userEmail || session.userId,
          description: body.description as string | undefined,
          key: body.key as string | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name,
          tags: body.tags as string[] | undefined,
        },
      );

      return reply.code(201).send({ group });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/config/groups/:groupId', withApiRequestContext(async (request, reply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);

      const group = await getConfigGroupWithItems(
        session.tenantDbName,
        session.tenantId,
        projectId,
        groupId,
      );

      if (!group) {
        return reply.code(404).send({ error: 'Config group not found' });
      }

      return reply.code(200).send({ group });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.patch('/config/groups/:groupId', withApiRequestContext(async (request, reply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const group = await updateConfigGroup(
        session.tenantDbName,
        session.tenantId,
        projectId,
        groupId,
        {
          description: body.description as string | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string | undefined,
          tags: body.tags as string[] | undefined,
          updatedBy: session.userEmail || session.userId,
        },
      );

      return reply.code(200).send({ group });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/config/groups/:groupId', withApiRequestContext(async (request, reply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);

      await deleteConfigGroup(
        session.tenantDbName,
        session.tenantId,
        projectId,
        groupId,
        session.userEmail || session.userId,
      );

      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/config/groups/:groupId/items', withApiRequestContext(async (request, reply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as ConfigListQuery;

      const items = await listConfigItems(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          groupId,
          isSecret: parseBooleanQuery(query.isSecret),
          search: query.search || undefined,
          tags: parseCsvQuery(query.tags),
        },
      );

      return reply.code(200).send({ items });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.post('/config/groups/:groupId/items', withApiRequestContext(async (request, reply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (!body.name || typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (body.value === undefined || body.value === null) {
        return reply.code(400).send({ error: 'value is required' });
      }

      const item = await createConfigItem(
        session.tenantDbName,
        session.tenantId,
        projectId,
        groupId,
        {
          createdBy: session.userEmail || session.userId,
          description: body.description as string | undefined,
          isSecret: body.isSecret as boolean | undefined,
          key: body.key as string | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name,
          tags: body.tags as string[] | undefined,
          value: String(body.value),
          valueType: body.valueType as ConfigValueType | undefined,
        },
      );

      return reply.code(201).send({ item });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/config/items', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as ConfigListQuery;

      const items = await listConfigItems(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          groupId: query.groupId || undefined,
          isSecret: parseBooleanQuery(query.isSecret),
          search: query.search || undefined,
          tags: parseCsvQuery(query.tags),
        },
      );

      return reply.code(200).send({ items });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/config/items/:itemId', withApiRequestContext(async (request, reply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);

      const item = await getConfigItemById(
        session.tenantDbName,
        session.tenantId,
        projectId,
        itemId,
      );

      if (!item) {
        return reply.code(404).send({ error: 'Config item not found' });
      }

      const auditLogs = await listConfigAuditLogs(
        session.tenantDbName,
        session.tenantId,
        item.key,
        { limit: 20 },
      );

      return reply.code(200).send({ auditLogs, item });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.patch('/config/items/:itemId', withApiRequestContext(async (request, reply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const item = await updateConfigItem(
        session.tenantDbName,
        session.tenantId,
        projectId,
        itemId,
        {
          description: body.description as string | undefined,
          isSecret: body.isSecret as boolean | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string | undefined,
          tags: body.tags as string[] | undefined,
          updatedBy: session.userEmail || session.userId,
          value: body.value !== undefined ? String(body.value) : undefined,
          valueType: body.valueType as ConfigValueType | undefined,
        },
      );

      return reply.code(200).send({ item });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/config/items/:itemId', withApiRequestContext(async (request, reply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const { projectId, session } = await requireProjectContextForRequest(request);

      await deleteConfigItem(
        session.tenantDbName,
        session.tenantId,
        projectId,
        itemId,
        session.userEmail || session.userId,
      );

      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));
};
