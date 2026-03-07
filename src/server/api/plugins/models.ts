import type { FastifyPluginAsync } from 'fastify';
import {
  createModel,
  createModelProvider,
  deleteModel,
  getModelById,
  getUsageAggregate,
  listModelProviders,
  listModels,
  listUsageLogs,
  updateModel,
} from '@/lib/services/models/modelService';
import type { UpdateModelInput } from '@/lib/services/models/types';
import {
  type IModel,
  type ModelCategory,
  type ProviderDomain,
} from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota, type QuotaContext } from '@/lib/quota';
import { providerRegistry } from '@/lib/providers';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import {
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import {
  isDateInDashboardRange,
  parseDashboardDateFilterFromSearchParams,
} from '@/lib/utils/dashboardDateFilter';
import { createLogger } from '@/lib/core/logger';
import {
  readJsonBody,
  requireProjectContextForRequest,
} from '../fastify-utils';

const logger = createLogger('api:models');
const MAX_LIMIT = 200;
const PLACEHOLDER = '••••••••';
const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'secretAccessKey',
  'serviceAccountKey',
  'sessionToken',
]);

type ModelQuery = {
  category?: ModelCategory;
  includeProviders?: string;
  providerDriver?: string;
  providerKey?: string;
};

type ModelLogsQuery = {
  from?: string;
  limit?: string;
  skip?: string;
  to?: string;
};

type ModelUsageQuery = {
  from?: string;
  groupBy?: 'hour' | 'day' | 'month';
  to?: string;
};

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Unauthorized';
}

function sendProjectError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  if (error instanceof ProjectContextError) {
    return reply.code(error.status).send({ error: error.message });
  }

  if (isUnauthorizedError(error)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  return null;
}

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

function buildDate(value?: string): Date | undefined {
  return value ? new Date(value) : undefined;
}

export const modelsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/models/providers/drivers', async (request, reply) => {
    try {
      const query = (request.query ?? {}) as { domain?: ProviderDomain };
      const drivers = providerRegistry.listDescriptors(query.domain ?? 'model');
      return reply.code(200).send({ drivers });
    } catch (error) {
      logger.error('List model provider drivers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/models/providers/drivers/:driverId/form', async (request, reply) => {
    try {
      const { driverId } = request.params as { driverId: string };
      const schema = providerRegistry.getFormSchema(driverId);
      const descriptor = providerRegistry
        .listDescriptors('model')
        .find((item) => item.id === driverId);

      return reply.code(200).send({
        descriptor,
        driverId,
        schema,
      });
    } catch (error) {
      logger.error('Get model provider driver form error', { error });
      return reply.code(404).send({
        error:
          error instanceof Error ? error.message : 'Failed to load form schema',
      });
    }
  });

  app.get('/models/providers', async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        driver?: string;
        status?: ProviderStatus;
      };

      const providers = await listModelProviders(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          driver: query.driver,
          status: query.status,
        },
      );

      return reply.code(200).send({ providers });
    } catch (error) {
      logger.error('List model providers error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/models/providers', async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const requiredFields = ['key', 'driver', 'label', 'credentials'];

      for (const field of requiredFields) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const provider = await createModelProvider(
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
      logger.error('Create model provider error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  });

  app.get('/models/dashboard', async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const searchParams = new URLSearchParams(
        request.query as Record<string, string>,
      );
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);

      const [models, providers] = await Promise.all([
        listModels(session.tenantDbName, projectId, {}),
        listModelProviders(session.tenantDbName, session.tenantId, projectId, {}),
      ]);

      const aggregates = await Promise.all(
        models.map(async (model) => {
          try {
            const agg = await getUsageAggregate(
              session.tenantDbName,
              model.key,
              projectId,
              {
                from: filter.from,
                groupBy: 'day',
                to: filter.to,
              },
            );
            return { agg, model };
          } catch {
            return { agg: null, model };
          }
        }),
      );

      const hasDateFilter = Boolean(filter.from || filter.to);
      const scopedAggregates = hasDateFilter
        ? aggregates.filter(({ model, agg }) => {
          if (isDateInDashboardRange(model.createdAt, filter)) {
            return true;
          }
          return Boolean(agg && agg.totalCalls > 0);
        })
        : aggregates;

      const scopedModels = scopedAggregates.map((item) => item.model);
      const topModels = scopedAggregates
        .filter((item) => item.agg && item.agg.totalCalls > 0)
        .map(({ model, agg }) => ({
          avgLatencyMs: agg!.avgLatencyMs,
          callCount: agg!.totalCalls,
          category: model.category,
          errorRate: agg!.totalCalls > 0 ? agg!.errorCalls / agg!.totalCalls : 0,
          key: model.key,
          name: model.name,
          totalCost: agg!.costSummary?.totalCost ?? 0,
          totalTokens: agg!.totalTokens,
        }))
        .sort((a, b) => b.callCount - a.callCount)
        .slice(0, 10);

      let totalCalls = 0;
      let successCalls = 0;
      let errorCalls = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalTokens = 0;
      let totalToolCalls = 0;
      let cacheHits = 0;
      let totalCost = 0;
      let latencySum = 0;
      let latencyCount = 0;
      const dailyMap = new Map<string, { callCount: number; totalTokens: number }>();

      for (const { agg } of scopedAggregates) {
        if (!agg) {
          continue;
        }

        totalCalls += agg.totalCalls;
        successCalls += agg.successCalls;
        errorCalls += agg.errorCalls;
        totalInputTokens += agg.totalInputTokens;
        totalOutputTokens += agg.totalOutputTokens;
        totalTokens += agg.totalTokens;
        totalToolCalls += agg.totalToolCalls;
        cacheHits += agg.cacheHits;
        totalCost += agg.costSummary?.totalCost ?? 0;

        if (agg.avgLatencyMs !== null && agg.avgLatencyMs !== undefined) {
          latencySum += agg.avgLatencyMs * agg.totalCalls;
          latencyCount += agg.totalCalls;
        }

        for (const row of agg.timeseries ?? []) {
          const key = row.period.slice(0, 10);
          const existing = dailyMap.get(key) ?? { callCount: 0, totalTokens: 0 };
          dailyMap.set(key, {
            callCount: existing.callCount + row.callCount,
            totalTokens: existing.totalTokens + row.totalTokens,
          });
        }
      }

      const avgLatencyMs = latencyCount > 0
        ? Math.round(latencySum / latencyCount)
        : null;
      const cacheHitRate = totalCalls > 0 ? cacheHits / totalCalls : 0;
      const errorRate = totalCalls > 0 ? errorCalls / totalCalls : 0;
      const daily = Array.from(dailyMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-14)
        .map(([period, data]) => ({ period, ...data }));

      const scopedProviderKeys = new Set(
        scopedModels.map((model) => model.providerKey),
      );
      const scopedProviderCount = hasDateFilter
        ? providers.filter((provider) => scopedProviderKeys.has(provider.key)).length
        : providers.length;

      return reply.code(200).send({
        daily,
        overview: {
          avgLatencyMs,
          cacheHitRate,
          cacheHits,
          currency: 'USD',
          embeddingCount: scopedModels.filter((model) => model.category === 'embedding').length,
          errorCalls,
          errorRate,
          llmCount: scopedModels.filter((model) => model.category === 'llm').length,
          providerCount: scopedProviderCount,
          successCalls,
          totalCalls,
          totalCost,
          totalInputTokens,
          totalModels: scopedModels.length,
          totalOutputTokens,
          totalTokens,
          totalToolCalls,
        },
        topModels,
      });
    } catch (error) {
      logger.error('Models dashboard error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });

  app.get('/models', async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as ModelQuery;

      const models = await listModels(session.tenantDbName, projectId, {
        category: query.category,
        providerDriver: query.providerDriver,
        providerKey: query.providerKey,
      });

      const payload: Record<string, unknown> = {
        models: models.map(sanitizeModel),
      };

      if (query.includeProviders === 'true') {
        payload.providers = await listModelProviders(
          session.tenantDbName,
          session.tenantId,
          projectId,
          {},
        );
      }

      return reply.code(200).send(payload);
    } catch (error) {
      logger.error('List models error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });

  app.post('/models', async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const requiredFields = [
        'name',
        'providerKey',
        'category',
        'modelId',
        'pricing',
        'settings',
      ];

      for (const field of requiredFields) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const existingModels = await listModels(session.tenantDbName, projectId, {});
      const quotaContext: QuotaContext = {
        domain: 'llm',
        licenseType: session.licenseType as LicenseType,
        projectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
      };
      const quotaCheck = await checkResourceQuota(
        quotaContext,
        'models',
        existingModels.length,
      );

      if (!quotaCheck.allowed) {
        return reply.code(429).send({
          error: quotaCheck.reason ?? 'Model quota exceeded',
        });
      }

      const model = await createModel(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          category: body.category as ModelCategory,
          description: body.description as string | undefined,
          isMultimodal: body.isMultimodal as boolean | undefined,
          key: body.key as string | undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
          modelId: body.modelId as string,
          name: body.name as string,
          pricing: body.pricing as UpdateModelInput['pricing'] & {
            currency?: string;
          },
          providerKey: body.providerKey as string,
          settings: body.settings as Record<string, unknown>,
          supportsToolCalls: body.supportsToolCalls as boolean | undefined,
        },
      );

      return reply.code(201).send({ model: sanitizeModel(model) });
    } catch (error) {
      logger.error('Create model error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });

  app.get('/models/:id/logs', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const model = await getModelById(session.tenantDbName, id, projectId);

      if (!model) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      const query = (request.query ?? {}) as ModelLogsQuery;
      const parsedFilter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(query as Record<string, string>),
      );
      const limit = Math.min(Number.parseInt(query.limit || '50', 10), MAX_LIMIT);
      const skip = Number.parseInt(query.skip || '0', 10);
      const from = query.from || parsedFilter.from?.toISOString();
      const to = query.to || parsedFilter.to?.toISOString();

      const logs = await listUsageLogs(session.tenantDbName, model.key, projectId, {
        from: from ? new Date(from) : undefined,
        limit,
        skip,
        to: to ? new Date(to) : undefined,
      });

      return reply.code(200).send({ logs });
    } catch (error) {
      logger.error('Fetch model logs error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });

  app.get('/models/:id/usage', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const model = await getModelById(session.tenantDbName, id, projectId);

      if (!model) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      const query = (request.query ?? {}) as ModelUsageQuery;
      const parsedFilter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(query as Record<string, string>),
      );
      const aggregate = await getUsageAggregate(
        session.tenantDbName,
        model.key,
        projectId,
        {
          from: buildDate(query.from || parsedFilter.from?.toISOString()),
          groupBy: query.groupBy || 'day',
          to: buildDate(query.to || parsedFilter.to?.toISOString()),
        },
      );

      return reply.code(200).send({ usage: aggregate });
    } catch (error) {
      logger.error('Fetch model usage error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });

  app.get('/models/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const model = await getModelById(session.tenantDbName, id, projectId);

      if (!model) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      return reply.code(200).send({ model: sanitizeModel(model) });
    } catch (error) {
      logger.error('Fetch model error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });

  app.put('/models/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const existing = await getModelById(session.tenantDbName, id, projectId);

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
      if (body.inputGuardrailKey !== undefined) {
        updates.inputGuardrailKey = (body.inputGuardrailKey as string) || undefined;
      }
      if (body.outputGuardrailKey !== undefined) {
        updates.outputGuardrailKey = (body.outputGuardrailKey as string) || undefined;
      }
      if (body.metadata !== undefined) updates.metadata = body.metadata;
      if (body.providerKey !== undefined) updates.providerKey = body.providerKey as string;

      if (body.settings && typeof body.settings === 'object') {
        updates.settings = mergeSettings(
          existing.settings || {},
          body.settings as Record<string, unknown>,
        );
      }

      const updated = await updateModel(
        session.tenantDbName,
        projectId,
        id,
        updates,
        session.userId,
      );

      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update model' });
      }

      return reply.code(200).send({ model: sanitizeModel(updated) });
    } catch (error) {
      logger.error('Update model error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });

  app.delete('/models/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const deleted = await deleteModel(session.tenantDbName, projectId, id);

      if (!deleted) {
        return reply.code(404).send({ error: 'Model not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete model error', { error });
      return sendProjectError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  });
};
