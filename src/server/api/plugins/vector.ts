import type { FastifyPluginAsync } from 'fastify';
import type { ProviderDomain } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import type { LicenseType } from '@/lib/license/license-manager';
import { providerRegistry } from '@/lib/providers';
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
  createVectorMigration,
  listVectorMigrations,
  getVectorMigration,
  startVectorMigration,
  cancelVectorMigration,
  deleteVectorMigration,
  listVectorMigrationLogs,
  countVectorMigrationLogs,
} from '@/lib/services/vector';
import type { VectorMetric } from '@/lib/services/vector/types';
import type { VectorMigrationStatus } from '@/lib/database/provider/types.base';
import {
  checkPerRequestLimits,
  checkRateLimit,
  checkResourceQuota,
} from '@/lib/quota/quotaGuard';
import {
  isDateInDashboardRange,
  parseDashboardDateFilterFromSearchParams,
} from '@/lib/utils/dashboardDateFilter';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:vector');

type VectorProvidersQuery = {
  driver?: string;
  includeIndexes?: string;
  status?: ProviderStatus;
};

type VectorIndexQuery = {
  days?: string;
  from?: string;
  providerKey?: string;
  to?: string;
};

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    normalized.includes('vector index metadata not found')
    || normalized.includes('vector provider configuration not found')
  );
}

export const vectorApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/vector/providers/drivers', withApiRequestContext(async (request, reply) => {
    try {
      const query = (request.query ?? {}) as { domain?: ProviderDomain };
      const drivers = providerRegistry.listDescriptors(query.domain ?? 'vector');
      return reply.code(200).send({ drivers });
    } catch (error) {
      logger.error('List vector provider drivers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/vector/providers/drivers/:driverId/form', withApiRequestContext(async (request, reply) => {
    try {
      const { driverId } = request.params as { driverId: string };
      const schema = providerRegistry.getFormSchema(driverId);
      const descriptor = providerRegistry
        .listDescriptors('vector')
        .find((item) => item.id === driverId);

      return reply.code(200).send({ descriptor, driverId, schema });
    } catch (error) {
      logger.error('Get vector provider driver form error', { error });
      return reply.code(404).send({
        error: error instanceof Error ? error.message : 'Failed to load form schema',
      });
    }
  }));

  app.get('/vector/providers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as VectorProvidersQuery;

      const providers = await listVectorProviders(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          driver: query.driver,
          status: query.status,
        },
      );

      if (query.includeIndexes !== 'true') {
        return reply.code(200).send({ providers });
      }

      const indexEntries = await Promise.all(
        providers.map(async (provider) => {
          try {
            const indexes = await listVectorIndexes(
              session.tenantDbName,
              session.tenantId,
              projectId,
              provider.key,
            );

            return [provider.key, indexes] as const;
          } catch (error) {
            logger.warn('Vector provider indexes preload failed', {
              error,
              projectId,
              providerKey: provider.key,
            });
            return [provider.key, []] as const;
          }
        }),
      );

      const indexesByProvider = Object.fromEntries(indexEntries);

      return reply.code(200).send({ indexesByProvider, providers });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/vector/providers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const requiredFields = ['key', 'driver', 'label', 'credentials'];

      for (const field of requiredFields) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const provider = await createVectorProvider(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
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
        },
      );

      return reply.code(201).send({ provider });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/vector/dashboard', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const filter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(request.query as Record<string, string>),
      );

      const providers = await listVectorProviders(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {},
      );

      const indexesByProvider = await Promise.all(
        providers.map(async (provider) => {
          try {
            const indexes = await listVectorIndexes(
              session.tenantDbName,
              session.tenantId,
              projectId,
              provider.key,
            );
            return {
              indexes: indexes.filter((index) => isDateInDashboardRange(index.createdAt, filter)),
              provider,
            };
          } catch {
            return { indexes: [], provider };
          }
        }),
      );

      const hasDateFilter = Boolean(filter.from || filter.to);
      const providersWithIndexes = new Set(
        indexesByProvider
          .filter((item) => item.indexes.length > 0)
          .map((item) => item.provider.key),
      );

      const scopedProviders = hasDateFilter
        ? providers.filter(
          (provider) =>
            isDateInDashboardRange(provider.createdAt, filter)
            || providersWithIndexes.has(provider.key),
        )
        : providers;

      const scopedProviderKeys = new Set(scopedProviders.map((provider) => provider.key));
      const scopedIndexesByProvider = indexesByProvider.filter((item) =>
        scopedProviderKeys.has(item.provider.key),
      );
      const allIndexes = scopedIndexesByProvider.flatMap((item) => item.indexes);

      const dimensionMap = new Map<number, number>();
      for (const index of allIndexes) {
        const dimension = index.dimension ?? 0;
        dimensionMap.set(dimension, (dimensionMap.get(dimension) ?? 0) + 1);
      }

      const metricMap = new Map<string, number>();
      for (const index of allIndexes) {
        const metric = index.metric ?? 'cosine';
        metricMap.set(metric, (metricMap.get(metric) ?? 0) + 1);
      }

      const recentIndexes = [...allIndexes]
        .sort((a, b) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tb - ta;
        })
        .slice(0, 5)
        .map((index) => ({
          createdAt: index.createdAt,
          dimension: index.dimension,
          key: index.key,
          metric: index.metric,
          name: index.name,
          providerKey: index.providerKey,
        }));

      return reply.code(200).send({
        dimensionDistribution: Array.from(dimensionMap.entries())
          .sort(([a], [b]) => b - a)
          .map(([dimension, count]) => ({ count, dimension })),
        metricDistribution: Array.from(metricMap.entries()).map(([metric, count]) => ({
          count,
          metric,
        })),
        overview: {
          activeProviders: scopedProviders.filter((item) => item.status === 'active').length,
          disabledProviders: scopedProviders.filter((item) => item.status === 'disabled').length,
          erroredProviders: scopedProviders.filter((item) => item.status === 'errored').length,
          totalIndexes: allIndexes.length,
          totalProviders: scopedProviders.length,
        },
        providerBreakdown: scopedIndexesByProvider.map(({ indexes, provider }) => ({
          driver: provider.driver,
          indexCount: indexes.length,
          key: provider.key,
          label: provider.label,
          status: provider.status,
        })),
        recentIndexes,
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/vector/indexes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { providerKey?: string };

      if (!query.providerKey) {
        return reply.code(400).send({ error: 'providerKey query parameter is required' });
      }

      const indexes = await listVectorIndexes(
        session.tenantDbName,
        session.tenantId,
        projectId,
        query.providerKey,
      );

      return reply.code(200).send({ indexes });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/vector/indexes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const licenseType = session.licenseType as LicenseType;

      if (!body.providerKey || !body.name) {
        return reply.code(400).send({ error: 'providerKey and name are required' });
      }

      const dimensionValue =
        typeof body.dimension === 'number'
          ? body.dimension
          : Number.parseInt(String(body.dimension), 10);

      if (!dimensionValue || Number.isNaN(dimensionValue) || dimensionValue <= 0) {
        return reply.code(400).send({ error: 'dimension must be a positive number' });
      }

      const existingIndexes = await listVectorIndexes(
        session.tenantDbName,
        session.tenantId,
        projectId,
        body.providerKey as string,
      );
      const normalizedName = String(body.name).trim().toLowerCase();
      const matchingIndex = existingIndexes.find(
        (item) => item.name.trim().toLowerCase() === normalizedName,
      );

      if (matchingIndex) {
        return reply.code(200).send({ index: matchingIndex, reused: true });
      }

      const quotaContext = {
        domain: 'vector' as const,
        licenseType,
        projectId,
        providerKey: body.providerKey as string,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
      };

      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const resourceCheck = await checkResourceQuota(
        quotaContext,
        'vectorIndexes',
        existingIndexes.length,
      );
      if (!resourceCheck.allowed) {
        return reply.code(429).send({
          error: resourceCheck.reason || 'Vector index quota exceeded',
        });
      }

      const index = await createVectorIndex(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          createdBy: session.userId,
          dimension: dimensionValue,
          metadata: body.metadata as Record<string, unknown> | undefined,
          metric: body.metric as VectorMetric | undefined,
          name: body.name as string,
          providerKey: body.providerKey as string,
        },
      );

      return reply.code(201).send({ index });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/vector/indexes/:externalId', withApiRequestContext(async (request, reply) => {
    try {
      const { externalId } = request.params as { externalId: string };
      const query = (request.query ?? {}) as VectorIndexQuery;
      const { projectId, session } = await requireProjectContextForRequest(request);

      if (!query.providerKey) {
        return reply.code(400).send({ error: 'providerKey query parameter is required' });
      }

      const { index, provider } = await getVectorIndex(
        session.tenantDbName,
        session.tenantId,
        projectId,
        query.providerKey,
        externalId,
      );

      return reply.code(200).send({ index, provider });
    } catch (error) {
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/vector/indexes/:externalId', withApiRequestContext(async (request, reply) => {
    try {
      const { externalId } = request.params as { externalId: string };
      const query = (request.query ?? {}) as VectorIndexQuery;
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (!query.providerKey) {
        return reply.code(400).send({ error: 'providerKey query parameter is required' });
      }
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
        session.tenantDbName,
        session.tenantId,
        projectId,
        query.providerKey,
        externalId,
        {
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string | undefined,
          updatedBy: session.userId,
        },
      );

      return reply.code(200).send({ index });
    } catch (error) {
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/vector/indexes/:externalId', withApiRequestContext(async (request, reply) => {
    try {
      const { externalId } = request.params as { externalId: string };
      const query = (request.query ?? {}) as VectorIndexQuery;
      const { projectId, session } = await requireProjectContextForRequest(request);

      if (!query.providerKey) {
        return reply.code(400).send({ error: 'providerKey query parameter is required' });
      }

      await deleteVectorIndex(
        session.tenantDbName,
        session.tenantId,
        projectId,
        query.providerKey,
        externalId,
        { updatedBy: session.userId },
      );

      return reply.code(200).send({ success: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.post('/vector/indexes/:externalId/query', withApiRequestContext(async (request, reply) => {
    try {
      const { externalId } = request.params as { externalId: string };
      const query = (request.query ?? {}) as VectorIndexQuery;
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, { filter?: unknown; topK?: unknown; vector?: unknown }>>(request);

      if (!query.providerKey) {
        return reply.code(400).send({ error: 'providerKey query parameter is required' });
      }
      if (!Array.isArray(body.query?.vector)) {
        return reply.code(400).send({ error: 'query.vector array is required' });
      }

      const topK = body.query?.topK ?? 5;
      if (typeof topK !== 'number' || topK <= 0) {
        return reply.code(400).send({ error: 'query.topK must be a positive number' });
      }

      const result = await queryVectorIndex(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          indexKey: externalId,
          providerKey: query.providerKey,
          query: {
            filter: body.query.filter as Record<string, unknown> | undefined,
            topK,
            vector: body.query.vector as number[],
          },
        },
      );

      return reply.code(200).send({ result });
    } catch (error) {
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/vector/indexes/:externalId/stats', withApiRequestContext(async (request, reply) => {
    try {
      const { externalId } = request.params as { externalId: string };
      const query = (request.query ?? {}) as VectorIndexQuery;
      const { session } = await requireProjectContextForRequest(request);

      const parsedFilter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(request.query as Record<string, string>),
      );
      const daysParam = query.days;
      const fromParam = query.from || parsedFilter.from?.toISOString();
      const toParam = query.to || parsedFilter.to?.toISOString();

      const now = new Date();
      const parsedFrom = fromParam ? new Date(fromParam) : undefined;
      const parsedTo = toParam ? new Date(toParam) : undefined;
      const hasFrom = parsedFrom && !Number.isNaN(parsedFrom.getTime());
      const hasTo = parsedTo && !Number.isNaN(parsedTo.getTime());
      const since = hasFrom
        ? parsedFrom
        : new Date(Date.now() - (daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 30, 7), 90) : 30) * 24 * 3_600_000);
      const until = hasTo ? parsedTo : now;
      const diffMs = Math.max(until.getTime() - since.getTime(), 0);
      const computedDays = Math.floor(diffMs / (24 * 3_600_000)) + 1;
      const days = hasFrom || hasTo
        ? Math.min(Math.max(computedDays, 1), 365)
        : (daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 30, 7), 90) : 30);

      const dbProvider = await getDatabase() as MongoDBProvider;
      const client = dbProvider.getClient();
      if (!client) {
        return reply.code(503).send({ error: 'Database not available' });
      }

      const db = client.db(session.tenantDbName);
      const indexQuery: Record<string, unknown> = { externalId };
      if (query.providerKey) {
        indexQuery.providerKey = query.providerKey;
      }

      const indexDoc = await db
        .collection('vector_indexes')
        .findOne(indexQuery, { projection: { _id: 0, key: 1 } });

      const indexKey = (indexDoc?.key as string | undefined) ?? externalId;
      const [daily, totalsRaw, topKDist] = await Promise.all([
        db.collection('vector_query_logs').aggregate([
          { $match: { indexKey, timestamp: { $gte: since, $lte: until } } },
          {
            $group: {
              _id: { $dateToString: { date: '$timestamp', format: '%Y-%m-%d' } },
              avgLatencyMs: { $avg: '$latencyMs' },
              avgScore: { $avg: '$avgScore' },
              filterCount: { $sum: { $cond: [{ $eq: ['$filterApplied', true] }, 1, 0] } },
              queryCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]).toArray(),
        db.collection('vector_query_logs').aggregate([
          { $match: { indexKey, timestamp: { $gte: since, $lte: until } } },
          {
            $group: {
              _id: null,
              avgLatencyMs: { $avg: '$latencyMs' },
              avgScore: { $avg: '$avgScore' },
              maxLatencyMs: { $max: '$latencyMs' },
              minLatencyMs: { $min: '$latencyMs' },
              totalQueries: { $sum: 1 },
            },
          },
        ]).toArray(),
        db.collection('vector_query_logs').aggregate([
          { $match: { indexKey, timestamp: { $gte: since, $lte: until } } },
          { $group: { _id: '$topK', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]).toArray(),
      ]);

      const dateMap = new Map(daily.map((item) => [item._id as string, item]));
      const filledDaily: Array<{
        avgLatencyMs: number;
        avgScore: number;
        date: string;
        filterCount: number;
        queryCount: number;
      }> = [];
      const dayStart = new Date(since);
      dayStart.setHours(0, 0, 0, 0);

      for (let index = 0; index < days; index += 1) {
        const date = new Date(dayStart);
        date.setDate(dayStart.getDate() + index);
        const key = date.toISOString().substring(0, 10);
        const row = dateMap.get(key);

        filledDaily.push({
          avgLatencyMs: row ? Math.round((row.avgLatencyMs as number | undefined) ?? 0) : 0,
          avgScore: row ? parseFloat(((row.avgScore as number | undefined) ?? 0).toFixed(4)) : 0,
          date: key,
          filterCount: (row?.filterCount as number | undefined) ?? 0,
          queryCount: (row?.queryCount as number | undefined) ?? 0,
        });
      }

      const totals = totalsRaw[0] ?? {};
      return reply.code(200).send({
        daily: filledDaily,
        days,
        topKDistribution: topKDist.map((item) => ({
          count: item.count as number,
          topK: item._id as number,
        })),
        totals: {
          avgLatencyMs: totals.avgLatencyMs ? Math.round(totals.avgLatencyMs as number) : 0,
          avgScore: totals.avgScore ? parseFloat((totals.avgScore as number).toFixed(4)) : 0,
          maxLatencyMs: (totals.maxLatencyMs as number | undefined) ?? 0,
          minLatencyMs: (totals.minLatencyMs as number | undefined) ?? 0,
          totalQueries: (totals.totalQueries as number | undefined) ?? 0,
        },
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/vector/indexes/:externalId/upsert', withApiRequestContext(async (request, reply) => {
    try {
      const { externalId } = request.params as { externalId: string };
      const query = (request.query ?? {}) as VectorIndexQuery;
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<{ vectors?: Array<{ id?: string; values?: unknown[] }> }>(request);
      const licenseType = session.licenseType as LicenseType;

      if (!query.providerKey) {
        return reply.code(400).send({ error: 'providerKey query parameter is required' });
      }
      if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
        return reply.code(400).send({ error: 'vectors array is required' });
      }

      const invalidEntry = body.vectors.find(
        (entry) => typeof entry?.id !== 'string' || !Array.isArray(entry?.values),
      );
      if (invalidEntry) {
        return reply.code(400).send({
          error: 'Each vector must include an id and values array.',
        });
      }

      const vectorCount = body.vectors.length;
      const firstVector = body.vectors[0];
      const vectorDimensions = Array.isArray(firstVector?.values)
        ? firstVector.values.length
        : undefined;
      const quotaContext = {
        domain: 'vector' as const,
        licenseType,
        projectId,
        providerKey: query.providerKey,
        resourceKey: externalId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
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
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const maxVectorsTotal = quotaResult.effectiveLimits.quotas?.maxVectorsTotal;
      if (maxVectorsTotal !== undefined && maxVectorsTotal !== -1) {
        const currentApprox = await db.getProjectVectorCountApprox(projectId);
        const projected = currentApprox + vectorCount;
        if (projected > maxVectorsTotal) {
          return reply.code(429).send({
            error: `vectorsTotal limit exceeded (${projected}/${maxVectorsTotal})`,
          });
        }
      }

      await upsertVectors(session.tenantDbName, session.tenantId, projectId, {
        indexKey: externalId,
        providerKey: query.providerKey,
        updatedBy: session.userId,
        vectors: body.vectors as Array<{ id: string; values: number[] }>,
      });

      await db.incrementProjectVectorCountApprox(projectId, vectorCount);
      return reply.code(200).send({ success: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/vector/indexes/:externalId/vectors', withApiRequestContext(async (request, reply) => {
    try {
      const { externalId } = request.params as { externalId: string };
      const query = (request.query ?? {}) as VectorIndexQuery;
      const { projectId, session } = await requireProjectContextForRequest(request);
      const licenseType = session.licenseType as LicenseType;
      const payload = readJsonBody<{ ids?: unknown[] }>(request);

      if (!query.providerKey) {
        return reply.code(400).send({ error: 'providerKey query parameter is required' });
      }

      const ids = Array.isArray(payload.ids)
        ? payload.ids.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
        : [];
      if (ids.length === 0) {
        return reply.code(400).send({ error: 'ids array is required' });
      }

      const quotaContext = {
        domain: 'vector' as const,
        licenseType,
        projectId,
        providerKey: query.providerKey,
        resourceKey: externalId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
      };

      const rateLimitResult = await checkRateLimit(quotaContext, {
        requests: 1,
        vectors: ids.length,
      });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      await deleteVectors(session.tenantDbName, session.tenantId, projectId, {
        ids,
        indexKey: externalId,
        providerKey: query.providerKey,
        updatedBy: session.userId,
      });

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      await db.incrementProjectVectorCountApprox(projectId, -ids.length);

      return reply.code(200).send({ success: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  // ── Vector migrations ────────────────────────────────────────────────

  app.get('/vector/migrations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string };
      const migrations = await listVectorMigrations(
        session.tenantDbName,
        projectId,
        query.status as VectorMigrationStatus | undefined,
      );
      return reply.code(200).send({ migrations });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/vector/migrations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const required = ['name', 'sourceProviderKey', 'sourceIndexKey', 'destinationProviderKey', 'destinationIndexKey'];
      for (const field of required) {
        if (!body[field] || typeof body[field] !== 'string') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const migration = await createVectorMigration(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          name: body.name as string,
          description: typeof body.description === 'string' ? body.description : undefined,
          sourceProviderKey: body.sourceProviderKey as string,
          sourceIndexKey: body.sourceIndexKey as string,
          destinationProviderKey: body.destinationProviderKey as string,
          destinationIndexKey: body.destinationIndexKey as string,
          batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
          createdBy: session.userId,
        },
      );

      return reply.code(201).send({ migration });
    } catch (error) {
      if (error instanceof Error && (error.message.includes('not found') || error.message.includes('cannot be the same'))) {
        return reply.code(400).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/vector/migrations/:key', withApiRequestContext(async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const { session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { logsLimit?: string; logsOffset?: string };

      const migration = await getVectorMigration(session.tenantDbName, key);
      if (!migration) {
        return reply.code(404).send({ error: 'Migration not found' });
      }

      const logsLimit = parseInt(query.logsLimit ?? '50', 10);
      const logsOffset = parseInt(query.logsOffset ?? '0', 10);

      const [logs, totalLogs] = await Promise.all([
        listVectorMigrationLogs(session.tenantDbName, key, { limit: logsLimit, offset: logsOffset }),
        countVectorMigrationLogs(session.tenantDbName, key),
      ]);

      return reply.code(200).send({ migration, logs, totalLogs });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/vector/migrations/:key', withApiRequestContext(async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const { session } = await requireProjectContextForRequest(request);

      await deleteVectorMigration(session.tenantDbName, key);

      return reply.code(200).send({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot delete')) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof Error && error.message.includes('not found')) {
        return reply.code(404).send({ error: 'Migration not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/vector/migrations/:key/start', withApiRequestContext(async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const { projectId, session } = await requireProjectContextForRequest(request);

      const migration = await startVectorMigration(session.tenantDbName, session.tenantId, projectId, key);

      return reply.code(200).send({ migration });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return reply.code(404).send({ error: 'Migration not found' });
      }
      if (error instanceof Error && (error.message.includes('already running') || error.message.includes('already completed'))) {
        return reply.code(409).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/vector/migrations/:key/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const { session } = await requireProjectContextForRequest(request);

      const migration = await cancelVectorMigration(session.tenantDbName, key);

      return reply.code(200).send({ migration });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return reply.code(404).send({ error: 'Migration not found' });
      }
      if (error instanceof Error && error.message.includes('not running')) {
        return reply.code(409).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
