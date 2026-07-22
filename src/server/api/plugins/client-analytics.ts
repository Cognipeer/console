/**
 * Client Analytics API plugin.
 *
 * Read-only observability surface for token callers: usage time-series /
 * breakdowns and the dashboard rollup. Everything is derived from the same
 * services that back the dashboard UI — no new data access. All reads are
 * strictly tenant + project scoped via the API token context.
 *
 *   GET /client/v1/analytics/usage     – time-series / breakdown (model|user|token|service)
 *   GET /client/v1/analytics/overview  – dashboard rollup (stats + recent sessions + daily)
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDashboardData } from '@/lib/services/dashboard/dashboardService';
import { getSpendEntityBreakdown, getSpendReport } from '@/lib/services/spend';
import { getUsageServiceBreakdown } from '@/lib/services/usage/usageBreakdown';
import { sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-analytics');

const VALID_GROUP_BY = ['model', 'user', 'token', 'service'] as const;
const VALID_INTERVAL = ['hour', 'day', 'month'] as const;

class AnalyticsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsRequestError';
  }
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AnalyticsRequestError(`\`${field}\` must be an ISO date`);
  }
  return parsed;
}

export const clientAnalyticsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Usage time-series / breakdown ──
  app.get('/client/v1/analytics/usage', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!auth.projectId) {
        return reply.code(400).send({ error: 'API token is not scoped to a project' });
      }

      const query = request.query as {
        from?: string; to?: string; group_by?: string; interval?: string; model?: string;
      };
      const groupBy = query.group_by ?? 'model';
      if (!(VALID_GROUP_BY as readonly string[]).includes(groupBy)) {
        return reply.code(400).send({ error: '`group_by` must be model, user, token, or service' });
      }
      const interval = query.interval ?? 'day';
      if (!(VALID_INTERVAL as readonly string[]).includes(interval)) {
        return reply.code(400).send({ error: '`interval` must be hour, day, or month' });
      }

      const from = parseDate(query.from, 'from');
      const to = parseDate(query.to, 'to');

      if (groupBy === 'model') {
        const report = await getSpendReport(
          {
            tenantDbName: auth.tenantDbName,
            tenantId: auth.tenantId,
            projectId: auth.projectId,
          },
          {
            from,
            to,
            groupBy: interval as typeof VALID_INTERVAL[number],
            modelKey: query.model,
          },
        );

        return reply.code(200).send({
          object: 'analytics.usage',
          group_by: 'model',
          interval: report.groupBy,
          from: report.from?.toISOString() ?? null,
          to: report.to?.toISOString() ?? null,
          currency: report.currency,
          totals: {
            cost: report.totalCost,
            calls: report.totalCalls,
            input_tokens: report.totalInputTokens,
            output_tokens: report.totalOutputTokens,
            total_tokens: report.totalTokens,
          },
          by_model: report.byModel.map((entry) => ({
            model_key: entry.modelKey,
            model_name: entry.modelName ?? null,
            category: entry.category ?? null,
            provider_key: entry.providerKey ?? null,
            calls: entry.calls,
            input_tokens: entry.inputTokens,
            output_tokens: entry.outputTokens,
            total_tokens: entry.totalTokens,
            cost: entry.cost,
          })),
          timeseries: report.timeseries.map((point) => ({
            period: point.period,
            calls: point.calls,
            total_tokens: point.totalTokens,
            cost: point.cost,
          })),
        });
      }

      if (groupBy === 'service') {
        const breakdown = await getUsageServiceBreakdown(
          {
            tenantDbName: auth.tenantDbName,
            tenantId: auth.tenantId,
            projectId: auth.projectId,
          },
          { from, to },
        );

        return reply.code(200).send({
          object: 'analytics.usage',
          group_by: 'service',
          from: breakdown.fromDay ?? null,
          to: breakdown.toDay ?? null,
          currency: 'USD',
          totals: {
            requests: breakdown.totals.requests,
            errors: breakdown.totals.errors,
            input_tokens: breakdown.totals.inputTokens,
            output_tokens: breakdown.totals.outputTokens,
            total_tokens: breakdown.totals.totalTokens,
            cost: breakdown.totals.costUsd,
          },
          breakdown: breakdown.entries.map((entry) => ({
            service: entry.service,
            requests: entry.requests,
            errors: entry.errors,
            input_tokens: entry.inputTokens,
            output_tokens: entry.outputTokens,
            total_tokens: entry.totalTokens,
            cost: entry.costUsd,
          })),
        });
      }

      // group_by=user | token → per-entity attribution from usage_daily.
      const entity = groupBy === 'token' ? 'api_key' : 'user';
      const breakdown = await getSpendEntityBreakdown(
        {
          tenantDbName: auth.tenantDbName,
          tenantId: auth.tenantId,
          projectId: auth.projectId,
        },
        {
          from,
          to,
          modelKey: query.model,
          entity,
        },
      );

      const idField = entity === 'user' ? 'user_id' : 'api_token_id';
      return reply.code(200).send({
        object: 'analytics.usage',
        group_by: groupBy,
        from: breakdown.fromDay ?? null,
        to: breakdown.toDay ?? null,
        currency: 'USD',
        totals: {
          requests: breakdown.totals.requests,
          errors: breakdown.totals.errors,
          input_tokens: breakdown.totals.inputTokens,
          output_tokens: breakdown.totals.outputTokens,
          total_tokens: breakdown.totals.totalTokens,
          cost: breakdown.totals.costUsd,
        },
        breakdown: breakdown.entries.map((entry) => ({
          [idField]: entry.id,
          name: entry.name ?? null,
          label: entry.label ?? null,
          requests: entry.requests,
          errors: entry.errors,
          input_tokens: entry.inputTokens,
          output_tokens: entry.outputTokens,
          total_tokens: entry.totalTokens,
          cost: entry.costUsd,
        })),
      });
    } catch (error) {
      if (error instanceof AnalyticsRequestError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Client analytics usage error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Dashboard overview rollup ──
  app.get('/client/v1/analytics/overview', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!auth.projectId) {
        return reply.code(400).send({ error: 'API token is not scoped to a project' });
      }

      const query = request.query as { from?: string; to?: string };
      const data = await getDashboardData(
        auth.tenantDbName,
        auth.tenantId,
        auth.projectId,
        {
          from: parseDate(query.from, 'from'),
          to: parseDate(query.to, 'to'),
        },
      );

      return reply.code(200).send({
        object: 'analytics.overview',
        stats: data.stats,
        recent_sessions: data.recentSessions,
        daily: data.daily,
      });
    } catch (error) {
      if (error instanceof AnalyticsRequestError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Client analytics overview error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
