import type { FastifyPluginAsync } from 'fastify';
import type { ProviderDomain } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { providerRegistry } from '@/lib/providers';
import type { VectorUpsertItem } from '@/lib/providers';
import {
  checkPerRequestLimits,
  checkRateLimit,
  checkResourceQuota,
} from '@/lib/quota/quotaGuard';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import {
  createVectorIndex,
  createVectorProvider,
  deleteVectorIndex,
  deleteVectors,
  getVectorIndex,
  listVectorIndexes,
  listVectorProviders,
  queryVectorIndex,
  updateVectorIndex,
  upsertVectors,
  type VectorIndexRecord,
  type VectorMetric,
} from '@/lib/services/vector';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-vector');

function serializeIndex(index: VectorIndexRecord) {
  return {
    ...index,
    indexId: index.key,
    metadata: index.metadata ?? {},
  };
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    normalized.includes('vector index record not found')
    || normalized.includes('vector index metadata not found')
    || normalized.includes('vector provider configuration not found')
  );
}

export const clientVectorApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/vector/providers/drivers', withClientApiRequestContext(async (request, reply) => {
    try {
      const query = (request.query ?? {}) as { domain?: ProviderDomain };
      const drivers = providerRegistry.listDescriptors(query.domain ?? 'vector');
      return reply.code(200).send({ drivers });
    } catch (error) {
      logger.error('List client vector provider drivers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/vector/providers/drivers/:driverId/form', withClientApiRequestContext(async (request, reply) => {
    try {
      const { driverId } = request.params as { driverId: string };
      const schema = providerRegistry.getFormSchema(driverId);
      const descriptor = providerRegistry.listDescriptors('vector').find((item) => item.id === driverId);
      return reply.code(200).send({ descriptor, driverId, schema });
    } catch (error) {
      logger.error('Get client vector provider driver form error', { error });
      return reply.code(404).send({
        error: error instanceof Error ? error.message : 'Failed to load form schema',
      });
    }
  }));

  app.get('/client/v1/vector/providers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { driver?: string; status?: ProviderStatus };
      const providers = await listVectorProviders(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        driver: query.driver,
        status: query.status,
      });

      return reply.code(200).send({ providers });
    } catch (error) {
      logger.error('List client vector providers error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/vector/providers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      for (const field of ['key', 'driver', 'label', 'credentials']) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const provider = await createVectorProvider(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
        createdBy: ctx.tokenRecord.userId,
        credentials: body.credentials as Record<string, unknown>,
        description: body.description as string | undefined,
        driver: body.driver as string,
        key: (body.key as string).trim(),
        label: body.label as string,
        metadata: body.metadata as Record<string, unknown> | undefined,
        settings: body.settings as Record<string, unknown> | undefined,
        status: body.status as ProviderStatus | undefined,
      });

      return reply.code(201).send({ provider });
    } catch (error) {
      logger.error('Create client vector provider error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/vector/providers/:providerKey/indexes', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { providerKey } = request.params as { providerKey: string };
      const indexes = await listVectorIndexes(ctx.tenantDbName, ctx.tenantId, ctx.projectId, providerKey);
      return reply.code(200).send({ indexes: indexes.map(serializeIndex) });
    } catch (error) {
      logger.error('List client vector indexes error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/vector/providers/:providerKey/indexes', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { providerKey } = request.params as { providerKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.name === undefined || body.dimension === undefined) {
        return reply.code(400).send({ error: 'name and dimension are required' });
      }

      const dimension = typeof body.dimension === 'number'
        ? body.dimension
        : Number.parseInt(String(body.dimension), 10);
      if (!dimension || Number.isNaN(dimension) || dimension <= 0) {
        return reply.code(400).send({ error: 'dimension must be a positive number' });
      }

      const existingIndexes = await listVectorIndexes(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        providerKey,
      );
      const normalizedName = String(body.name).trim().toLowerCase();
      const matchingIndex = existingIndexes.find(
        (item) => item.name.trim().toLowerCase() === normalizedName,
      );
      if (matchingIndex) {
        return reply.code(200).send({ index: serializeIndex(matchingIndex), reused: true });
      }

      const quotaContext = {
        domain: 'vector' as const,
        licenseType: ctx.tenant.licenseType as LicenseType,
        projectId: ctx.projectId,
        providerKey,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
        userId: ctx.tokenRecord.userId,
      };

      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({ error: rateLimitResult.reason || 'Rate limit exceeded' });
      }

      const resourceCheck = await checkResourceQuota(quotaContext, 'vectorIndexes', existingIndexes.length);
      if (!resourceCheck.allowed) {
        return reply.code(429).send({
          error: resourceCheck.reason || 'Vector index quota exceeded',
        });
      }

      const index = await createVectorIndex(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        createdBy: ctx.tokenRecord.userId,
        dimension,
        metadata: body.metadata as Record<string, unknown> | undefined,
        metric: body.metric as VectorMetric | undefined,
        name: body.name as string,
        providerKey,
      });

      return reply.code(201).send({ index: serializeIndex(index) });
    } catch (error) {
      logger.error('Create client vector index error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/vector/providers/:providerKey/indexes/:externalId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { externalId, providerKey } = request.params as { externalId: string; providerKey: string };
      const { index, provider } = await getVectorIndex(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        providerKey,
        externalId,
      );

      return reply.code(200).send({ index: serializeIndex(index), provider });
    } catch (error) {
      logger.error('Get client vector index error', { error });
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.patch('/client/v1/vector/providers/:providerKey/indexes/:externalId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { externalId, providerKey } = request.params as { externalId: string; providerKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.name !== undefined && typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name must be a string when provided' });
      }
      if (body.metadata !== undefined && typeof body.metadata !== 'object') {
        return reply.code(400).send({ error: 'metadata must be an object when provided' });
      }
      if (body.name === undefined && body.metadata === undefined) {
        return reply.code(400).send({ error: 'Provide a field to update' });
      }

      const index = await updateVectorIndex(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        providerKey,
        externalId,
        {
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string | undefined,
          updatedBy: ctx.tokenRecord.userId,
        },
      );

      return reply.code(200).send({ index: serializeIndex(index) });
    } catch (error) {
      logger.error('Update client vector index error', { error });
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/client/v1/vector/providers/:providerKey/indexes/:externalId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { externalId, providerKey } = request.params as { externalId: string; providerKey: string };
      await deleteVectorIndex(ctx.tenantDbName, ctx.tenantId, ctx.projectId, providerKey, externalId, {
        updatedBy: ctx.tokenRecord.userId,
      });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client vector index error', { error });
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/vector/providers/:providerKey/indexes/:externalId/query', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { externalId, providerKey } = request.params as { externalId: string; providerKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const query = body.query as { filter?: Record<string, unknown>; topK?: number; vector?: number[] } | undefined;

      if (!Array.isArray(query?.vector)) {
        return reply.code(400).send({ error: 'query.vector array is required' });
      }

      const topK = query.topK ?? 5;
      if (typeof topK !== 'number' || topK <= 0) {
        return reply.code(400).send({ error: 'query.topK must be a positive number' });
      }

      const quotaContext = {
        domain: 'vector' as const,
        licenseType: ctx.tenant.licenseType as LicenseType,
        projectId: ctx.projectId,
        providerKey,
        resourceKey: externalId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
        userId: ctx.tokenRecord.userId,
      };
      const quotaResult = await checkPerRequestLimits(quotaContext, {
        queryResults: topK,
        vectorDimensions: query.vector.length,
      });
      if (!quotaResult.allowed) {
        return reply.code(429).send({ error: quotaResult.reason || 'Quota exceeded' });
      }

      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({ error: rateLimitResult.reason || 'Rate limit exceeded' });
      }

      const result = await queryVectorIndex(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        indexKey: externalId,
        providerKey,
        query: {
          filter: query.filter,
          topK,
          vector: query.vector,
        },
      });

      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Query client vector index error', { error });
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/vector/providers/:providerKey/indexes/:externalId/upsert', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { externalId, providerKey } = request.params as { externalId: string; providerKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
        return reply.code(400).send({ error: 'vectors array is required' });
      }

      const invalidEntry = body.vectors.find(
        (entry) =>
          !entry
          || typeof entry !== 'object'
          || typeof (entry as { id?: unknown }).id !== 'string'
          || !Array.isArray((entry as { values?: unknown }).values),
      );
      if (invalidEntry) {
        return reply.code(400).send({ error: 'Each vector must include an id and values array.' });
      }

      const vectorCount = body.vectors.length;
      const firstVector = body.vectors[0] as { values?: number[] };
      const vectorDimensions = Array.isArray(firstVector.values) ? firstVector.values.length : undefined;
      const quotaContext = {
        domain: 'vector' as const,
        licenseType: ctx.tenant.licenseType as LicenseType,
        projectId: ctx.projectId,
        providerKey,
        resourceKey: externalId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
        userId: ctx.tokenRecord.userId,
      };

      const quotaResult = await checkPerRequestLimits(quotaContext, {
        vectorCount,
        vectorDimensions,
      });
      if (!quotaResult.allowed) {
        return reply.code(429).send({ error: quotaResult.reason || 'Quota exceeded' });
      }

      const rateLimitResult = await checkRateLimit(quotaContext, {
        requests: 1,
        vectors: vectorCount,
      });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({ error: rateLimitResult.reason || 'Rate limit exceeded' });
      }

      const maxVectorsTotal = quotaResult.effectiveLimits.quotas?.maxVectorsTotal;
      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);
      if (maxVectorsTotal !== undefined && maxVectorsTotal !== -1) {
        const currentApprox = await db.getProjectVectorCountApprox(ctx.projectId);
        const projected = currentApprox + vectorCount;
        if (projected > maxVectorsTotal) {
          return reply.code(429).send({
            error: `vectorsTotal limit exceeded (${projected}/${maxVectorsTotal})`,
          });
        }
      }

      await upsertVectors(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        indexKey: externalId,
        providerKey,
        updatedBy: ctx.tokenRecord.userId,
        vectors: body.vectors as VectorUpsertItem[],
      });

      await db.incrementProjectVectorCountApprox(ctx.projectId, vectorCount);
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Upsert client vector entries error', { error });
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/client/v1/vector/providers/:providerKey/indexes/:externalId/vectors', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { externalId, providerKey } = request.params as { externalId: string; providerKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];

      if (ids.length === 0) {
        return reply.code(400).send({ error: 'ids array is required' });
      }

      const quotaContext = {
        domain: 'vector' as const,
        licenseType: ctx.tenant.licenseType as LicenseType,
        projectId: ctx.projectId,
        providerKey,
        resourceKey: externalId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
        userId: ctx.tokenRecord.userId,
      };
      const rateLimitResult = await checkRateLimit(quotaContext, {
        requests: 1,
        vectors: ids.length,
      });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({ error: rateLimitResult.reason || 'Rate limit exceeded' });
      }

      await deleteVectors(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        ids,
        indexKey: externalId,
        providerKey,
        updatedBy: ctx.tokenRecord.userId,
      });

      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);
      await db.incrementProjectVectorCountApprox(ctx.projectId, -ids.length);

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client vector entries error', { error });
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
