import type { FastifyPluginAsync } from 'fastify';
import type { ProviderDomain } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { providerRegistry } from '@/lib/providers';
import type {
  CreateProviderConfigInput,
  ProviderStatus,
  UpdateProviderConfigInput,
} from '@/lib/services/providers/providerService';
import {
  createProviderConfig,
  deleteProviderConfig,
  getProviderConfigById,
  listProviderConfigs,
  updateProviderConfig,
} from '@/lib/services/providers/providerService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:providers');

function parseStatus(value: string | undefined): ProviderStatus | undefined {
  if (value === 'active' || value === 'disabled' || value === 'errored') {
    return value;
  }
  return undefined;
}

function isProviderAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateCreatePayload(body: unknown): asserts body is CreateProviderConfigInput {
  if (!isRecord(body)) {
    throw new Error('Invalid payload');
  }

  const requiredFields = ['key', 'type', 'driver', 'label', 'credentials', 'createdBy'];
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new Error(`${field} is required`);
    }
  }
}

function sanitizeUpdatePayload(body: unknown): UpdateProviderConfigInput {
  const payload: UpdateProviderConfigInput = {};
  if (!isRecord(body)) {
    return payload;
  }

  if (typeof body.label === 'string') payload.label = body.label;
  if (typeof body.description === 'string' || body.description === null) {
    payload.description = (body.description ?? undefined) as string | undefined;
  }
  if (body.status === 'active' || body.status === 'disabled' || body.status === 'errored') {
    payload.status = body.status;
  }
  if (isRecord(body.settings)) payload.settings = body.settings;
  if (isRecord(body.metadata)) payload.metadata = body.metadata;
  if (isRecord(body.credentials)) payload.credentials = body.credentials;
  if (
    Array.isArray(body.projectIds)
    && body.projectIds.every((item) => typeof item === 'string')
  ) {
    payload.projectIds = body.projectIds;
  }
  if (
    Array.isArray(body.capabilitiesOverride)
    && body.capabilitiesOverride.every((item) => typeof item === 'string')
  ) {
    payload.capabilitiesOverride = body.capabilitiesOverride;
  }

  return payload;
}

export const providersApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/providers/drivers', withApiRequestContext(async (request, reply) => {
    try {
      const query = (request.query ?? {}) as { domain?: ProviderDomain };
      const drivers = providerRegistry.listDescriptors(query.domain);
      return reply.code(200).send({ drivers });
    } catch (error) {
      logger.error('List provider drivers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/providers/drivers/:driverId/form', withApiRequestContext(async (request, reply) => {
    try {
      const { driverId } = request.params as { driverId: string };
      const schema = providerRegistry.getFormSchema(driverId);
      const descriptor = providerRegistry
        .listDescriptors()
        .find((item) => item.id === driverId);

      return reply.code(200).send({ descriptor, driverId, schema });
    } catch (error) {
      logger.error('Get provider driver form error', { error });
      return reply.code(404).send({
        error: error instanceof Error ? error.message : 'Failed to load form schema',
      });
    }
  }));

  app.get('/providers', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as {
        driver?: string;
        scope?: string;
        status?: string;
        type?: ProviderDomain;
      };

      if (query.scope === 'tenant') {
        if (!isProviderAdmin(session.userRole)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const providers = await listProviderConfigs(session.tenantDbName, session.tenantId, {
          driver: query.driver || undefined,
          status: parseStatus(query.status),
          type: query.type || undefined,
        });

        return reply.code(200).send({ providers });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const providers = await listProviderConfigs(session.tenantDbName, session.tenantId, {
        driver: query.driver || undefined,
        projectId,
        status: parseStatus(query.status),
        type: query.type || undefined,
      });

      return reply.code(200).send({ providers });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/providers', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isProviderAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const query = (request.query ?? {}) as { scope?: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      body.createdBy = session.userId;
      validateCreatePayload(body);

      if (query.scope === 'tenant') {
        const provider = await createProviderConfig(session.tenantDbName, session.tenantId, {
          capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
          createdBy: session.userId,
          credentials: body.credentials as Record<string, unknown>,
          description: body.description as string | undefined,
          driver: body.driver as string,
          key: body.key as string,
          label: body.label as string,
          metadata: body.metadata as Record<string, unknown> | undefined,
          settings: body.settings as Record<string, unknown> | undefined,
          status: body.status as ProviderStatus | undefined,
          type: body.type as ProviderDomain,
        });

        return reply.code(201).send({ provider });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const provider = await createProviderConfig(session.tenantDbName, session.tenantId, {
        capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
        createdBy: session.userId,
        credentials: body.credentials as Record<string, unknown>,
        description: body.description as string | undefined,
        driver: body.driver as string,
        key: body.key as string,
        label: body.label as string,
        metadata: body.metadata as Record<string, unknown> | undefined,
        projectId,
        settings: body.settings as Record<string, unknown> | undefined,
        status: body.status as ProviderStatus | undefined,
        type: body.type as ProviderDomain,
      });

      return reply.code(201).send({ provider });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('already exists')) {
          return reply.code(409).send({ error: error.message });
        }
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Create provider error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/providers/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as { scope?: string };

      if (query.scope === 'tenant') {
        if (!isProviderAdmin(session.userRole)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const provider = await getProviderConfigById(session.tenantDbName, id);
        if (!provider || provider.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Not found' });
        }

        return reply.code(200).send({ provider });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const provider = await getProviderConfigById(session.tenantDbName, id);
      const assigned = provider && (
        String(provider.projectId) === String(projectId)
        || (
          Array.isArray(provider.projectIds)
          && provider.projectIds.map(String).includes(String(projectId))
        )
      );

      if (!provider || provider.tenantId !== session.tenantId || !assigned) {
        return reply.code(404).send({ error: 'Not found' });
      }

      return reply.code(200).send({ provider });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/providers/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as { scope?: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const payload = sanitizeUpdatePayload(body);
      payload.updatedBy = session.userId;

      if (query.scope === 'tenant') {
        if (!isProviderAdmin(session.userRole)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const existing = await getProviderConfigById(session.tenantDbName, id);
        if (!existing || existing.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Not found' });
        }

        const updated = await updateProviderConfig(session.tenantDbName, id, payload);
        if (!updated) {
          return reply.code(404).send({ error: 'Not found' });
        }

        return reply.code(200).send({ provider: updated });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const existing = await getProviderConfigById(session.tenantDbName, id);
      const assigned = existing && (
        String(existing.projectId) === String(projectId)
        || (
          Array.isArray(existing.projectIds)
          && existing.projectIds.map(String).includes(String(projectId))
        )
      );

      if (!existing || existing.tenantId !== session.tenantId || !assigned) {
        return reply.code(404).send({ error: 'Not found' });
      }

      const updated = await updateProviderConfig(session.tenantDbName, id, payload);
      if (!updated) {
        return reply.code(404).send({ error: 'Not found' });
      }

      return reply.code(200).send({ provider: updated });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/providers/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as { scope?: string };

      if (query.scope === 'tenant') {
        if (!isProviderAdmin(session.userRole)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const existing = await getProviderConfigById(session.tenantDbName, id);
        if (!existing || existing.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Not found' });
        }

        const deleted = await deleteProviderConfig(session.tenantDbName, id);
        if (!deleted) {
          return reply.code(404).send({ error: 'Not found' });
        }

        return reply.code(200).send({ success: true });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const existing = await getProviderConfigById(session.tenantDbName, id);
      const assigned = existing && (
        String(existing.projectId) === String(projectId)
        || (
          Array.isArray(existing.projectIds)
          && existing.projectIds.map(String).includes(String(projectId))
        )
      );

      if (!existing || existing.tenantId !== session.tenantId || !assigned) {
        return reply.code(404).send({ error: 'Not found' });
      }

      const deleted = await deleteProviderConfig(session.tenantDbName, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
