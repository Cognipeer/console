import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ConfigValueType } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  ConfigServiceError,
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
import { sendRouteError } from '../routeErrors';
import { authz } from '@/lib/iam/routeAuthz';

/** Every route here is gated by the "config" service (the same one its path prefix maps to). */
const GATE = { config: authz.service('config') } as const;

const logger = createLogger('api:client-config');

/** A request the config service refuses for the caller to correct (a key already taken, a group or item not found). */
const sendConfigServiceError = (reply: FastifyReply) => (error: unknown) =>
  error instanceof ConfigServiceError ? reply.code(error.status).send({ error: error.message }) : null;

export const clientConfigApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/config/groups', GATE, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; tags?: string };
      const groups = await listConfigGroups(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        search: query.search,
        tags: parseCsvQuery(query.tags),
      });

      return reply.code(200).send({ groups });
    } catch (error) {
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'List client config groups error' });
    }
  }));

  app.post('/client/v1/config/groups', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Create client config group error' });
    }
  }));

  app.get('/client/v1/config/groups/:groupKey', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Get client config group error' });
    }
  }));

  app.patch('/client/v1/config/groups/:groupKey', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Update client config group error' });
    }
  }));

  app.delete('/client/v1/config/groups/:groupKey', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Delete client config group error' });
    }
  }));

  app.get('/client/v1/config/groups/:groupKey/items', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'List client config group items error' });
    }
  }));

  app.post('/client/v1/config/groups/:groupKey/items', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Create client config item error' });
    }
  }));

  app.get('/client/v1/config/items', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'List client config items error' });
    }
  }));

  app.get('/client/v1/config/items/:key', GATE, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const item = await getConfigItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, key);

      if (!item) {
        return reply.code(404).send({ error: 'Config item not found' });
      }

      return reply.code(200).send({ item });
    } catch (error) {
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Get client config item error' });
    }
  }));

  app.patch('/client/v1/config/items/:key', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Update client config item error' });
    }
  }));

  app.delete('/client/v1/config/items/:key', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Delete client config item error' });
    }
  }));

  app.get('/client/v1/config/items/:key/audit', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'List client config audit logs error' });
    }
  }));

  app.post('/client/v1/config/resolve', GATE, withClientApiRequestContext(async (request, reply) => {
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
      return sendRouteError(reply, error, { logger, typed: sendConfigServiceError(reply), log: 'Resolve client config values error' });
    }
  }));
};
