/**
 * Client Providers API plugin (token-authenticated admin surface).
 *
 * Manage tenant provider credentials/integrations via an API token. Gated by
 * the `providers` RBAC service (an adminService → owner/admin token owners, or a
 * token explicitly scoped `providers:admin`, per the per-token scope model).
 * Responses always use the service's sanitized `ProviderConfigView` — encrypted
 * credentials are NEVER returned (only `hasCredentials`).
 *
 *   GET    /client/v1/providers              – list (?scope=tenant|project,?type,?driver,?status)
 *   POST   /client/v1/providers              – create (?scope=tenant|project)
 *   GET    /client/v1/providers/drivers      – driver catalog (read-only)
 *   GET    /client/v1/providers/drivers/:id/form – driver form schema
 *   GET    /client/v1/providers/:id          – fetch one
 *   PATCH  /client/v1/providers/:id          – update
 *   DELETE /client/v1/providers/:id          – delete
 */

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
import { readJsonBody, sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-providers');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStatus(value: string | undefined): ProviderStatus | undefined {
  return value === 'active' || value === 'disabled' || value === 'errored' ? value : undefined;
}

function validateCreatePayload(body: unknown): asserts body is CreateProviderConfigInput {
  if (!isRecord(body)) throw new Error('Invalid payload');
  for (const field of ['key', 'type', 'driver', 'label', 'credentials', 'createdBy']) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new Error(`${field} is required`);
    }
  }
}

function sanitizeUpdatePayload(body: unknown): UpdateProviderConfigInput {
  const payload: UpdateProviderConfigInput = {};
  if (!isRecord(body)) return payload;
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
  if (Array.isArray(body.projectIds) && body.projectIds.every((i) => typeof i === 'string')) {
    payload.projectIds = body.projectIds;
  }
  if (Array.isArray(body.capabilitiesOverride) && body.capabilitiesOverride.every((i) => typeof i === 'string')) {
    payload.capabilitiesOverride = body.capabilitiesOverride;
  }
  return payload;
}

/** True when the provider row belongs to this project (direct or via projectIds). */
function isAssignedToProject(provider: { projectId?: unknown; projectIds?: unknown }, projectId: string): boolean {
  return (
    String(provider.projectId) === String(projectId)
    || (Array.isArray(provider.projectIds) && provider.projectIds.map(String).includes(String(projectId)))
  );
}

export const clientProvidersApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/providers/drivers', withClientApiRequestContext(async (request, reply) => {
    const query = (request.query ?? {}) as { domain?: ProviderDomain };
    return reply.code(200).send({ drivers: providerRegistry.listDescriptors(query.domain) });
  }));

  app.get('/client/v1/providers/drivers/:driverId/form', withClientApiRequestContext(async (request, reply) => {
    try {
      const { driverId } = request.params as { driverId: string };
      const schema = providerRegistry.getFormSchema(driverId);
      const descriptor = providerRegistry.listDescriptors().find((item) => item.id === driverId);
      return reply.code(200).send({ descriptor, driverId, schema });
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Failed to load form schema' });
    }
  }));

  app.get('/client/v1/providers', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const query = (request.query ?? {}) as { driver?: string; scope?: string; status?: string; type?: ProviderDomain };
      const filters = {
        driver: query.driver || undefined,
        status: parseStatus(query.status),
        type: query.type || undefined,
        ...(query.scope === 'tenant' ? {} : { projectId: auth.projectId }),
      };
      const providers = await listProviderConfigs(auth.tenantDbName, auth.tenantId, filters);
      return reply.code(200).send({ providers });
    } catch (error) {
      logger.error('Client list providers error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }));

  app.post('/client/v1/providers', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const query = (request.query ?? {}) as { scope?: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      body.createdBy = auth.tokenRecord.userId;
      validateCreatePayload(body);
      const provider = await createProviderConfig(auth.tenantDbName, auth.tenantId, {
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
        type: body.type as ProviderDomain,
        ...(query.scope === 'tenant' ? {} : { projectId: auth.projectId }),
      });
      return reply.code(201).send({ provider });
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof Error && /required|Invalid payload/.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Client create provider error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/providers/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as { scope?: string };
      const provider = await getProviderConfigById(auth.tenantDbName, id);
      const ok = provider
        && provider.tenantId === auth.tenantId
        && (query.scope === 'tenant' || (auth.projectId && isAssignedToProject(provider, auth.projectId)));
      if (!ok) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ provider });
    } catch (error) {
      logger.error('Client get provider error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/providers/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as { scope?: string };
      const payload = sanitizeUpdatePayload(readJsonBody<Record<string, unknown>>(request));
      payload.updatedBy = String(auth.tokenRecord.userId);
      const existing = await getProviderConfigById(auth.tenantDbName, id);
      const ok = existing
        && existing.tenantId === auth.tenantId
        && (query.scope === 'tenant' || (auth.projectId && isAssignedToProject(existing, auth.projectId)));
      if (!ok) return reply.code(404).send({ error: 'Not found' });
      const updated = await updateProviderConfig(auth.tenantDbName, id, payload);
      if (!updated) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ provider: updated });
    } catch (error) {
      logger.error('Client update provider error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/providers/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as { scope?: string };
      const existing = await getProviderConfigById(auth.tenantDbName, id);
      const ok = existing
        && existing.tenantId === auth.tenantId
        && (query.scope === 'tenant' || (auth.projectId && isAssignedToProject(existing, auth.projectId)));
      if (!ok) return reply.code(404).send({ error: 'Not found' });
      const deleted = await deleteProviderConfig(auth.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client delete provider error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
