/**
 * Cost API plugin — observed-model spend + external pricing catalog.
 *
 * Backs the dashboard Cost pages: which models were observed (gateway +
 * observability), which are priced by the Model Hub, which are priced by the
 * tenant's external catalog, and which are unpriced. Pricing entries are
 * effective-dated: new usage is priced by the version effective that day, and
 * recorded usage can be repriced retroactively.
 *
 * Every GET accepts `scope=all` to aggregate across all projects ("total"
 * view); the default is the active project.
 *
 *   GET    /cost/models              – observed models with pricing status
 *   GET    /cost/agents              – per-agent spend breakdown
 *   GET    /cost/pricing             – external pricing catalog entries
 *   GET    /cost/pricing/catalog     – unified hub + external + observed catalog
 *   PUT    /cost/pricing             – upsert one catalog entry (effective-dated)
 *   POST   /cost/pricing/reprice     – recompute recorded spend for one model
 *   DELETE /cost/pricing/:modelName  – remove one catalog entry
 *   GET    /cost/reports             – daily/weekly/monthly spend series
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IModelPricing } from '@/lib/database';
import {
  deleteExternalPricing,
  getAgentCosts,
  getCostReport,
  getObservedModelCosts,
  getPricingCatalog,
  listExternalPricing,
  repriceExternalModelUsage,
  upsertExternalPricing,
  type ReportGranularity,
} from '@/lib/services/cost/costService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:cost');

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** `scope=all` widens the context to every project ("total" view). */
function scopedProjectId(projectId: string | undefined, scope: string | undefined): string | undefined {
  return scope === 'all' ? undefined : projectId;
}

const REPORT_GRANULARITIES: ReportGranularity[] = ['daily', 'weekly', 'monthly'];

export const costApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/cost/models', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = request.query as { from?: string; to?: string; scope?: string };
      const overview = await getObservedModelCosts(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId: scopedProjectId(projectId, query.scope),
        },
        { from: parseDate(query.from), to: parseDate(query.to) },
      );
      return reply.code(200).send(overview);
    } catch (error) {
      logger.error('Cost models overview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.get('/cost/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = request.query as { from?: string; to?: string; scope?: string };
      const overview = await getAgentCosts(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId: scopedProjectId(projectId, query.scope),
        },
        { from: parseDate(query.from), to: parseDate(query.to) },
      );
      return reply.code(200).send(overview);
    } catch (error) {
      logger.error('Cost agents overview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.get('/cost/pricing/catalog', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = request.query as { from?: string; to?: string; scope?: string };
      const catalog = await getPricingCatalog(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId: scopedProjectId(projectId, query.scope),
        },
        { from: parseDate(query.from), to: parseDate(query.to) },
      );
      return reply.code(200).send(catalog);
    } catch (error) {
      logger.error('Pricing catalog error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.get('/cost/reports', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = request.query as {
        from?: string;
        to?: string;
        scope?: string;
        granularity?: string;
      };
      const granularity = REPORT_GRANULARITIES.includes(query.granularity as ReportGranularity)
        ? (query.granularity as ReportGranularity)
        : 'daily';
      const report = await getCostReport(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId: scopedProjectId(projectId, query.scope),
        },
        { granularity, from: parseDate(query.from), to: parseDate(query.to) },
      );
      return reply.code(200).send(report);
    } catch (error) {
      logger.error('Cost report error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.get('/cost/pricing', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const entries = await listExternalPricing(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
      );
      return reply.code(200).send({ entries });
    } catch (error) {
      logger.error('Cost pricing list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.put('/cost/pricing', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<{
        modelName?: string;
        pricing?: IModelPricing;
        effectiveFrom?: string;
        scope?: string;
      }>(request);
      if (typeof body.modelName !== 'string' || !body.modelName.trim()) {
        return reply.code(400).send({ error: '`modelName` is required' });
      }
      const entry = await upsertExternalPricing(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        {
          modelName: body.modelName,
          pricing: body.pricing ?? { inputTokenPer1M: 0, outputTokenPer1M: 0 },
          effectiveFrom: body.effectiveFrom,
          tenantWide: body.scope === 'all',
          updatedBy: session.userId,
        },
      );
      return reply.code(200).send({ entry });
    } catch (error) {
      if (error instanceof Error && /required|must|Model Hub/.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Cost pricing upsert error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/cost/pricing/reprice', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<{
        modelName?: string;
        from?: string;
        to?: string;
        scope?: string;
      }>(request);
      if (typeof body.modelName !== 'string' || !body.modelName.trim()) {
        return reply.code(400).send({ error: '`modelName` is required' });
      }
      const result = await repriceExternalModelUsage(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId: scopedProjectId(projectId, body.scope),
        },
        {
          modelName: body.modelName,
          from: parseDate(body.from),
          to: parseDate(body.to),
        },
      );
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof Error && /required|must|Model Hub|No pricing entry/.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Cost reprice error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.delete('/cost/pricing/:modelName', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { modelName } = request.params as { modelName: string };
      const deleted = await deleteExternalPricing(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        decodeURIComponent(modelName),
      );
      if (!deleted) return reply.code(404).send({ error: 'Pricing entry not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Cost pricing delete error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
