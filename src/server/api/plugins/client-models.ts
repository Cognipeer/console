/**
 * Client Models API plugin (token-authenticated admin surface).
 *
 * Project-scoped model registry CRUD via an API token. Gated by the `models`
 * RBAC service (GET → read, writes → write) against the token owner (or an
 * explicit `models` token scope). Every route resolves tenant/project/actor
 * ONLY from the authenticated token context (`auth`) — never from the body or
 * query — so a token can only ever touch its own project.
 *
 * Secret redaction: model `settings` may hold provider credentials
 * (`apiKey`, `secretAccessKey`, `serviceAccountKey`, `sessionToken`). Reads mask
 * them with a placeholder (`sanitizeModel`); updates merge the incoming settings
 * over the stored ones so a masked value round-tripped from a read is preserved
 * rather than overwriting the real secret (`mergeSettings`). Model providers are
 * returned via the provider service's already-sanitized view (`hasCredentials`).
 *
 *   GET    /client/v1/models              – list (?category,?providerKey,?providerDriver,?includeProviders)
 *   POST   /client/v1/models              – create
 *   POST   /client/v1/models/dynamic      – create a dynamic (routing) model
 *   GET    /client/v1/models/providers    – list model providers (sanitized)
 *   POST   /client/v1/models/providers    – create a model provider
 *   GET    /client/v1/models/:id          – fetch one
 *   PUT    /client/v1/models/:id          – update
 *   DELETE /client/v1/models/:id          – delete
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  type IDynamicRoutingConfig,
  type IModel,
  type ModelCategory,
} from '@/lib/database';
import type { UpdateModelInput } from '@/lib/services/models/types';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import {
  createDynamicModel,
  createModel,
  createModelProvider,
  deleteModel,
  getModelById,
  listModelProviders,
  listModels,
  updateModel,
} from '@/lib/services/models/modelService';
import { createLogger } from '@/lib/core/logger';
import { readJsonBody, sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-models');

const PLACEHOLDER = '••••••••';
const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'secretAccessKey',
  'serviceAccountKey',
  'sessionToken',
]);

function sanitizeSettings(settings: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings || {})) {
    sanitized[key] = SENSITIVE_FIELDS.has(key) && value ? PLACEHOLDER : value;
  }
  return sanitized;
}

function sanitizeModel(model: IModel) {
  return {
    ...model,
    settings: sanitizeSettings(model.settings || {}),
  };
}

function mergeSettings(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (value === PLACEHOLDER || value === undefined) {
      continue;
    }

    if (value === null) {
      delete merged[key];
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

type ModelQuery = {
  category?: ModelCategory;
  includeProviders?: string;
  providerDriver?: string;
  providerKey?: string;
};

/**
 * Every model service fn is project-scoped. The token carries its project in
 * `auth.projectId`; if it is somehow absent the request cannot be scoped, so we
 * reject rather than fall back to a tenant-wide read. Returns the id, or null
 * after sending the 400 (caller returns immediately on null).
 */
function requireProjectId(projectId: string, reply: FastifyReply): string | null {
  if (!projectId) {
    reply.code(400).send({ error: 'projectId is required' });
    return null;
  }
  return projectId;
}

export const clientModelsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/models/providers', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const query = (request.query ?? {}) as { driver?: string; status?: ProviderStatus };
      const providers = await listModelProviders(auth.tenantDbName, auth.tenantId, projectId, {
        driver: query.driver,
        status: query.status,
      });
      return reply.code(200).send({ providers });
    } catch (error) {
      logger.error('Client list model providers error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.post('/client/v1/models/providers', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const body = readJsonBody<Record<string, unknown>>(request);
      for (const field of ['key', 'driver', 'label', 'credentials']) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const provider = await createModelProvider(auth.tenantDbName, auth.tenantId, projectId, {
        capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
        createdBy: String(auth.tokenRecord.userId),
        credentials: body.credentials as Record<string, unknown>,
        description: body.description as string | undefined,
        driver: body.driver as string,
        key: body.key as string,
        label: body.label as string,
        metadata: body.metadata as Record<string, unknown> | undefined,
        settings: body.settings as Record<string, unknown> | undefined,
        status: body.status as ProviderStatus | undefined,
      });

      return reply.code(201).send({ provider });
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        return reply.code(409).send({ error: error.message });
      }
      logger.error('Client create model provider error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.post('/client/v1/models/dynamic', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const body = readJsonBody<Record<string, unknown>>(request);

      if (!body.name || typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name is required' });
      }
      const dynamic = body.dynamic as IDynamicRoutingConfig | undefined;
      if (!dynamic || typeof dynamic !== 'object') {
        return reply.code(400).send({ error: 'dynamic routing config is required' });
      }

      const model = await createDynamicModel(auth.tenantDbName, auth.tenantId, projectId, String(auth.tokenRecord.userId), {
        name: body.name,
        description: body.description as string | undefined,
        key: body.key as string | undefined,
        dynamic,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });

      return reply.code(201).send({ model: sanitizeModel(model) });
    } catch (error) {
      logger.error('Client create dynamic model error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(400).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.get('/client/v1/models', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const query = (request.query ?? {}) as ModelQuery;

      const models = await listModels(auth.tenantDbName, projectId, {
        category: query.category,
        providerDriver: query.providerDriver,
        providerKey: query.providerKey,
      });

      const payload: Record<string, unknown> = {
        models: models.map(sanitizeModel),
      };

      if (query.includeProviders === 'true') {
        payload.providers = await listModelProviders(auth.tenantDbName, auth.tenantId, projectId, {});
      }

      return reply.code(200).send(payload);
    } catch (error) {
      logger.error('Client list models error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.post('/client/v1/models', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const body = readJsonBody<Record<string, unknown>>(request);
      const requiredFields = ['name', 'providerKey', 'category', 'modelId', 'pricing', 'settings'];

      for (const field of requiredFields) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const model = await createModel(auth.tenantDbName, auth.tenantId, projectId, String(auth.tokenRecord.userId), {
        category: body.category as ModelCategory,
        description: body.description as string | undefined,
        isMultimodal: body.isMultimodal as boolean | undefined,
        key: body.key as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
        modelId: body.modelId as string,
        name: body.name as string,
        pricing: body.pricing as UpdateModelInput['pricing'] & { currency?: string },
        providerKey: body.providerKey as string,
        settings: body.settings as Record<string, unknown>,
        supportsToolCalls: body.supportsToolCalls as boolean | undefined,
      });

      return reply.code(201).send({ model: sanitizeModel(model) });
    } catch (error) {
      logger.error('Client create model error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.get('/client/v1/models/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const { id } = request.params as { id: string };
      const model = await getModelById(auth.tenantDbName, id, projectId);

      if (!model) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      return reply.code(200).send({ model: sanitizeModel(model) });
    } catch (error) {
      logger.error('Client fetch model error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.put('/client/v1/models/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const { id } = request.params as { id: string };
      const existing = await getModelById(auth.tenantDbName, id, projectId);

      if (!existing) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      const body = readJsonBody<Partial<UpdateModelInput> & Record<string, unknown>>(request);
      const updates: Partial<UpdateModelInput> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.key !== undefined) updates.key = body.key;
      if (body.modelId !== undefined) updates.modelId = body.modelId;
      if (body.pricing !== undefined) updates.pricing = body.pricing;
      if (body.isMultimodal !== undefined) updates.isMultimodal = body.isMultimodal;
      if (body.supportsToolCalls !== undefined) updates.supportsToolCalls = body.supportsToolCalls;
      if (body.semanticCache !== undefined) updates.semanticCache = body.semanticCache;
      // Pass the value through as-is (incl. empty string) so clearing a
      // guardrail persists — `|| undefined` would skip the DB write and the
      // previous binding would stick. Empty string reads as "no guardrail".
      if (body.inputGuardrailKey !== undefined) {
        updates.inputGuardrailKey = body.inputGuardrailKey as string;
      }
      if (body.outputGuardrailKey !== undefined) {
        updates.outputGuardrailKey = body.outputGuardrailKey as string;
      }
      if (body.metadata !== undefined) updates.metadata = body.metadata;
      if (body.providerKey !== undefined) updates.providerKey = body.providerKey as string;

      if (body.settings && typeof body.settings === 'object') {
        updates.settings = mergeSettings(
          existing.settings || {},
          body.settings as Record<string, unknown>,
        );
      }

      const updated = await updateModel(auth.tenantDbName, projectId, id, updates, String(auth.tokenRecord.userId));

      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update model' });
      }

      return reply.code(200).send({ model: sanitizeModel(updated) });
    } catch (error) {
      logger.error('Client update model error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.delete('/client/v1/models/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const projectId = requireProjectId(auth.projectId, reply);
      if (!projectId) return reply;
      const { id } = request.params as { id: string };
      const existing = await getModelById(auth.tenantDbName, id, projectId);

      if (!existing) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      const deleted = await deleteModel(auth.tenantDbName, projectId, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client delete model error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));
};
