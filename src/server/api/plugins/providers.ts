import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ProviderDomain } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { providerRegistry } from '@/lib/providers';
import type {
  CreateProviderConfigInput,
  ProviderStatus,
  ProviderTestOverrides,
  ProviderTestTarget,
  UpdateProviderConfigInput,
} from '@/lib/services/providers/providerService';
import {
  createProviderConfig,
  deleteProviderConfig,
  getProviderConfigById,
  hasProviderTestOverrides,
  listProviderConfigs,
  loadProviderRuntimeData,
  ProviderCredentialDecryptError,
  recordProviderTest,
  resolveProviderTestTarget,
  resolveTenantProjectIds,
  updateProviderConfig,
} from '@/lib/services/providers/providerService';
import { foundCount, testProviderConnection } from '@/lib/services/providers/providerConnectionTest';
import { getProviderUsage } from '@/lib/services/providers/providerUsage';
import { WebSearchCacheConfigError } from '@/lib/services/webSearch/cacheSettings';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { isProviderConfigError, sendProviderConfigError } from '../providerConfigErrors';

const logger = createLogger('api:providers');

/**
 * These handlers used to swallow every failure into an unlogged
 * `{ error: 'Internal server error' }`, so the most common real cause — stored
 * credentials that cannot be decrypted with this environment's key — was
 * invisible in both the UI and the server log.
 */
function sendProviderError(reply: FastifyReply, error: unknown) {
  if (isProviderConfigError(error)) {
    // A refusal is the caller's to fix and is answered to the caller. Its text can quote what was typed into an
    // endpoint or credential field, so the log keeps what and where, not the words.
    logger.error('Provider request refused', { name: error.name, code: error.code, field: error.field });
  } else {
    logger.error('Provider request failed', {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
  }

  if (error instanceof ProviderCredentialDecryptError) {
    return reply.code(409).send({ error: error.message });
  }

  if (sendProviderConfigError(reply, error)) return reply;

  if (error instanceof WebSearchCacheConfigError) {
    return reply.code(400).send({ error: error.message });
  }

  return reply.code(500).send({
    error: error instanceof Error ? error.message : 'Internal server error',
  });
}

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

class ProviderProjectIdsError extends Error {}

/**
 * `projectIds` of a create body: absent is fine, otherwise an array of ids that are each a project
 * of the caller's tenant (deduped). Anything else is a 400 that says what is wrong.
 */
async function readCreateProjectIds(
  body: Record<string, unknown>,
  tenantDbName: string,
  tenantId: string,
): Promise<string[] | undefined> {
  if (body.projectIds === undefined || body.projectIds === null) return undefined;
  if (
    !Array.isArray(body.projectIds)
    || !body.projectIds.every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    throw new ProviderProjectIdsError('projectIds must be an array of project ids');
  }
  const { projectIds, unknown } = await resolveTenantProjectIds(
    tenantDbName,
    tenantId,
    body.projectIds as string[],
  );
  if (unknown.length > 0) {
    throw new ProviderProjectIdsError(`Unknown project(s): ${unknown.join(', ')}`);
  }
  return projectIds;
}

/** What `POST /providers/test` needs of a body: the same fields a create does, minus the identity ones. */
function readTestPayload(body: unknown): {
  type: ProviderDomain;
  driver: string;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
} {
  if (!isRecord(body)) throw new Error('Invalid payload');
  if (typeof body.type !== 'string' || body.type === '') throw new Error('type is required');
  if (typeof body.driver !== 'string' || body.driver === '') throw new Error('driver is required');
  if (body.credentials !== undefined && !isRecord(body.credentials)) throw new Error('credentials must be an object');
  if (body.settings !== undefined && !isRecord(body.settings)) throw new Error('settings must be an object');
  if (!providerRegistry.listDescriptors().some((descriptor) => descriptor.id === body.driver)) {
    throw new Error(`Unknown driver "${body.driver}"`);
  }
  return {
    type: body.type as ProviderDomain,
    driver: body.driver,
    credentials: (body.credentials ?? {}) as Record<string, unknown>,
    settings: (body.settings ?? {}) as Record<string, unknown>,
  };
}

/** The stored connection of a provider, decrypted here for a test: nothing typed on top of it. */
async function loadStoredTestTarget(tenantDbName: string, id: string, tenantId: string): Promise<ProviderTestTarget> {
  const { record, credentials } = await loadProviderRuntimeData(tenantDbName, { id, tenantId });
  return { record, credentials, settings: record.settings ?? {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The optional body of `POST /providers/:id/test`: the form's unsaved edits, to test instead of what is stored. No body
 * (or `{}`) is a plain re-test of the stored connection. Throws a message fit for a 400.
 */
function readSavedTestOverrides(request: FastifyRequest): ProviderTestOverrides {
  // An empty body is the plain re-test, not a malformed one (`readJsonBody` refuses both).
  if (request.body === undefined || request.body === null || request.body === '') return {};
  const body = readJsonBody<unknown>(request);
  if (!isPlainObject(body)) throw new Error('Invalid payload');
  if (body.credentials !== undefined && !isPlainObject(body.credentials)) throw new Error('credentials must be an object');
  if (body.settings !== undefined && !isPlainObject(body.settings)) throw new Error('settings must be an object');
  return { credentials: body.credentials, settings: body.settings };
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
        ?? sendProviderError(reply, error);
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
        const projectIds = await readCreateProjectIds(body, session.tenantDbName, session.tenantId);
        const provider = await createProviderConfig(session.tenantDbName, session.tenantId, {
          capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
          createdBy: session.userId,
          credentials: body.credentials as Record<string, unknown>,
          description: body.description as string | undefined,
          driver: body.driver as string,
          key: body.key as string,
          label: body.label as string,
          metadata: body.metadata as Record<string, unknown> | undefined,
          projectIds,
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
      if (sendProviderConfigError(reply, error)) return reply;
      if (error instanceof ProviderProjectIdsError) {
        return reply.code(400).send({ error: error.message });
      }
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

  // "Test connection" of a provider that is not saved yet (the create form). Nothing is persisted.
  app.post('/providers/test', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isProviderAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      let payload: ReturnType<typeof readTestPayload>;
      try {
        payload = readTestPayload(readJsonBody<unknown>(request));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid payload' });
      }

      const result = await testProviderConnection({
        ...payload,
        tenantId: session.tenantId,
      });
      return reply.code(200).send(result);
    } catch (error) {
      return sendProviderError(reply, error);
    }
  }));

  // "Test connection" of a stored provider: its credentials are decrypted here and never leave. Without a body it re-tests
  // the stored connection and keeps the outcome on the record. With `{ credentials?, settings? }` (the edit form's unsaved
  // values) it tests what an update with those values would store - a blank credential keeps the stored one, settings
  // replace the stored ones - and keeps nothing: the outcome describes a connection that is not saved. Same admin gate as
  // updating the provider.
  app.post('/providers/:id/test', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isProviderAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const existing = await getProviderConfigById(session.tenantDbName, id);
      if (!existing || existing.tenantId !== session.tenantId) {
        return reply.code(404).send({ error: 'Not found' });
      }

      let overrides: ProviderTestOverrides;
      try {
        overrides = readSavedTestOverrides(request);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid payload' });
      }

      const overridden = hasProviderTestOverrides(overrides);
      const { record, credentials, settings } = overridden
        ? await resolveProviderTestTarget(session.tenantDbName, { id, tenantId: session.tenantId }, overrides)
        : await loadStoredTestTarget(session.tenantDbName, id, session.tenantId);

      const result = await testProviderConnection({
        type: record.type,
        driver: record.driver,
        credentials,
        settings,
        tenantId: session.tenantId,
        providerKey: record.key,
      });

      if (!overridden) {
        const deployments = foundCount(result);
        await recordProviderTest(session.tenantDbName, id, {
          ok: result.ok,
          at: new Date(),
          latencyMs: result.latencyMs,
          message: result.message,
          ...(deployments !== undefined ? { deployments } : {}),
        });
      }
      return reply.code(200).send(result);
    } catch (error) {
      return sendProviderError(reply, error);
    }
  }));

  // Where a provider is used: per project, the models on it and the agents that use them. Read before unassigning.
  app.get('/providers/:id/usage', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isProviderAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const existing = await getProviderConfigById(session.tenantDbName, id);
      if (!existing || existing.tenantId !== session.tenantId) {
        return reply.code(404).send({ error: 'Not found' });
      }

      const usage = await getProviderUsage(session.tenantDbName, session.tenantId, existing);
      return reply.code(200).send(usage);
    } catch (error) {
      return sendProviderError(reply, error);
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

        // The edit form opens from this read: it carries which credential fields are stored (names, never values).
        const provider = await getProviderConfigById(session.tenantDbName, id, { credentialFields: true });
        if (!provider || provider.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Not found' });
        }

        return reply.code(200).send({ provider });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const provider = await getProviderConfigById(session.tenantDbName, id, { credentialFields: true });
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
        ?? sendProviderError(reply, error);
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

      // Assignment edits (the Projects tab / assign step) may only name projects of the caller's tenant.
      if (payload.projectIds !== undefined) {
        const { projectIds, unknown } = await resolveTenantProjectIds(
          session.tenantDbName,
          session.tenantId,
          payload.projectIds,
        );
        if (unknown.length > 0) {
          return reply.code(400).send({ error: `Unknown project(s): ${unknown.join(', ')}` });
        }
        payload.projectIds = projectIds;
      }

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

      const updated = await updateProviderConfig(session.tenantDbName, id, payload, { projectId });
      if (!updated) {
        return reply.code(404).send({ error: 'Not found' });
      }

      return reply.code(200).send({ provider: updated });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? sendProviderError(reply, error);
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
        ?? sendProviderError(reply, error);
    }
  }));
};
