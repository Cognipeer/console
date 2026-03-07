import type { FastifyPluginAsync } from 'fastify';
import type { ConfigValueType } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createConfigGroup,
  createConfigItem,
  deleteConfigGroup,
  deleteConfigItem,
  getConfigGroupByKey,
  getConfigGroupWithItems,
  getConfigItem,
  listConfigAuditLogs,
  listConfigGroups,
  listConfigItems,
  resolveConfigValues,
  updateConfigGroup,
  updateConfigItem,
} from '@/lib/services/config/configService';
import {
  getApiTokenContextForRequest,
  parseBooleanQuery,
  parseCsvQuery,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-config');

export const clientConfigApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/config/groups', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; tags?: string };
      const groups = await listConfigGroups(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        search: query.search,
        tags: parseCsvQuery(query.tags),
      });

      return reply.code(200).send({ groups });
    } catch (error) {
      logger.error('List client config groups error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/config/groups', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name is required' });
      }

      const group = await createConfigGroup(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        createdBy: ctx.user?.email ?? ctx.tokenRecord.userId,
        description: body.description as string | undefined,
        key: body.key as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
        name: body.name,
        tags: body.tags as string[] | undefined,
      });

      return reply.code(201).send({ group });
    } catch (error) {
      logger.error('Create client config group error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/config/groups/:groupKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { groupKey } = request.params as { groupKey: string };
      const groupMeta = await getConfigGroupByKey(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        groupKey,
      );

      if (!groupMeta?._id) {
        return reply.code(404).send({ error: 'Config group not found' });
      }

      const group = await getConfigGroupWithItems(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        typeof groupMeta._id === 'string' ? groupMeta._id : String(groupMeta._id),
      );

      return reply.code(200).send({ group });
    } catch (error) {
      logger.error('Get client config group error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.patch('/client/v1/config/groups/:groupKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { groupKey } = request.params as { groupKey: string };
      const existing = await getConfigGroupByKey(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        groupKey,
      );

      if (!existing?._id) {
        return reply.code(404).send({ error: 'Config group not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const group = await updateConfigGroup(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        typeof existing._id === 'string' ? existing._id : String(existing._id),
        {
          description: body.description as string | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string | undefined,
          tags: body.tags as string[] | undefined,
          updatedBy: ctx.user?.email ?? ctx.tokenRecord.userId,
        },
      );

      return reply.code(200).send({ group });
    } catch (error) {
      logger.error('Update client config group error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/client/v1/config/groups/:groupKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { groupKey } = request.params as { groupKey: string };
      const existing = await getConfigGroupByKey(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        groupKey,
      );

      if (!existing?._id) {
        return reply.code(404).send({ error: 'Config group not found' });
      }

      await deleteConfigGroup(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        typeof existing._id === 'string' ? existing._id : String(existing._id),
        ctx.user?.email ?? ctx.tokenRecord.userId,
      );

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client config group error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/config/groups/:groupKey/items', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { groupKey } = request.params as { groupKey: string };
      const query = (request.query ?? {}) as {
        isSecret?: string;
        search?: string;
        tags?: string;
      };
      const group = await getConfigGroupByKey(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        groupKey,
      );

      if (!group?._id) {
        return reply.code(404).send({ error: 'Config group not found' });
      }

      const items = await listConfigItems(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        groupId: typeof group._id === 'string' ? group._id : String(group._id),
        isSecret: parseBooleanQuery(query.isSecret),
        search: query.search,
        tags: parseCsvQuery(query.tags),
      });

      return reply.code(200).send({ items });
    } catch (error) {
      logger.error('List client config group items error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/config/groups/:groupKey/items', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { groupKey } = request.params as { groupKey: string };
      const group = await getConfigGroupByKey(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        groupKey,
      );

      if (!group?._id) {
        return reply.code(404).send({ error: 'Config group not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (body.value === undefined || body.value === null) {
        return reply.code(400).send({ error: 'value is required' });
      }

      const item = await createConfigItem(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        typeof group._id === 'string' ? group._id : String(group._id),
        {
          createdBy: ctx.user?.email ?? ctx.tokenRecord.userId,
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
      logger.error('Create client config item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/config/items', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as {
        groupId?: string;
        isSecret?: string;
        search?: string;
        tags?: string;
      };
      const items = await listConfigItems(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        groupId: query.groupId,
        isSecret: parseBooleanQuery(query.isSecret),
        search: query.search,
        tags: parseCsvQuery(query.tags),
      });

      return reply.code(200).send({ items });
    } catch (error) {
      logger.error('List client config items error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/config/items/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const item = await getConfigItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, key);

      if (!item) {
        return reply.code(404).send({ error: 'Config item not found' });
      }

      return reply.code(200).send({ item });
    } catch (error) {
      logger.error('Get client config item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.patch('/client/v1/config/items/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const existing = await getConfigItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, key);

      if (!existing?._id) {
        return reply.code(404).send({ error: 'Config item not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const item = await updateConfigItem(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        typeof existing._id === 'string' ? existing._id : String(existing._id),
        {
          description: body.description as string | undefined,
          isSecret: body.isSecret as boolean | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string | undefined,
          tags: body.tags as string[] | undefined,
          updatedBy: ctx.user?.email ?? ctx.tokenRecord.userId,
          value: body.value !== undefined ? String(body.value) : undefined,
          valueType: body.valueType as ConfigValueType | undefined,
        },
      );

      return reply.code(200).send({ item });
    } catch (error) {
      logger.error('Update client config item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/client/v1/config/items/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const existing = await getConfigItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, key);

      if (!existing?._id) {
        return reply.code(404).send({ error: 'Config item not found' });
      }

      await deleteConfigItem(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        typeof existing._id === 'string' ? existing._id : String(existing._id),
        ctx.user?.email ?? ctx.tokenRecord.userId,
      );

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client config item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/config/items/:key/audit', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { limit?: string; skip?: string };
      const limit = Math.min(Number.parseInt(query.limit ?? '50', 10), 100);
      const skip = Number.parseInt(query.skip ?? '0', 10);
      const logs = await listConfigAuditLogs(ctx.tenantDbName, ctx.tenantId, key, {
        limit,
        skip,
      });

      return reply.code(200).send({ logs });
    } catch (error) {
      logger.error('List client config audit logs error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/config/resolve', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        return reply.code(400).send({ error: 'keys array is required' });
      }

      if (body.keys.length > 50) {
        return reply.code(400).send({ error: 'Maximum 50 keys per request' });
      }

      const configs = await resolveConfigValues(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        { keys: body.keys as string[] },
        ctx.user?.email ?? ctx.tokenRecord.userId,
      );

      return reply.code(200).send({ configs });
    } catch (error) {
      logger.error('Resolve client config values error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
