/**
 * Client Spend & Budget API plugin.
 *
 * The read side of cost control: what was spent (rolled up from the model
 * usage logs) and how close each budget window is to its limit. Budgets are
 * stored as quota policies with `limits.budget` set, so everything created
 * here is enforced by the same quota guard that protects the sync inference
 * and batch paths.
 *
 *   GET    /client/v1/spend/report     – spend totals + per-model + timeseries
 *   GET    /client/v1/budgets          – list budget policies
 *   POST   /client/v1/budgets          – create a budget policy
 *   PATCH  /client/v1/budgets/:id      – update limits/thresholds
 *   DELETE /client/v1/budgets/:id      – remove a budget policy
 *   GET    /client/v1/budgets/status   – current usage vs limits per window
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import type { QuotaDomain, QuotaPolicy, QuotaScope } from '@/lib/quota/types';
import { getBudgetUsage } from '@/lib/quota';
import {
  createQuotaPolicy,
  deleteQuotaPolicy,
  listQuotaPolicies,
  updateQuotaPolicy,
} from '@/lib/services/quota/quotaService';
import {
  getSpendEntityBreakdown,
  getSpendReport,
  type SpendGroupByEntity,
} from '@/lib/services/spend';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import {
  getApiTokenContextForRequest,
  safeReadJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-spend');

const VALID_DOMAINS: QuotaDomain[] = [
  'global', 'llm', 'embedding', 'vector', 'file', 'tracing', 'stt', 'tts', 'ocr',
];
const VALID_SCOPES: QuotaScope[] = ['tenant', 'user', 'token', 'resource', 'provider'];
const VALID_GROUP_BY = ['hour', 'day', 'month'] as const;
const VALID_GROUP_BY_ENTITY: SpendGroupByEntity[] = ['user', 'api_key'];

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SpendRequestError(`\`${field}\` must be an ISO date`);
  }
  return parsed;
}

class SpendRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendRequestError';
  }
}

function isBudgetPolicy(policy: QuotaPolicy): boolean {
  const budget = policy.limits?.budget;
  return Boolean(
    budget
    && (budget.dailySpendLimit !== undefined || budget.monthlySpendLimit !== undefined),
  );
}

/** Shape a quota policy as the snake_case budget view. */
function toClientBudget(policy: QuotaPolicy): Record<string, unknown> {
  const budget = policy.limits?.budget ?? {};
  return {
    id: policy._id ? String(policy._id) : null,
    object: 'budget',
    label: policy.label ?? null,
    description: policy.description ?? null,
    domain: policy.domain,
    scope: policy.scope,
    scope_id: policy.scopeId ?? null,
    project_id: policy.projectId ?? null,
    daily_limit_usd: budget.dailySpendLimit ?? null,
    monthly_limit_usd: budget.monthlySpendLimit ?? null,
    alert_thresholds: budget.alertThresholds ?? null,
    enabled: policy.enabled,
    priority: policy.priority,
    created_at: policy.createdAt ?? null,
    updated_at: policy.updatedAt ?? null,
  };
}

function parseOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (parsed < 0 && parsed !== -1)) {
    throw new SpendRequestError(`\`${field}\` must be a non-negative number (or -1 for unlimited)`);
  }
  return parsed;
}

function requireWriteAccess(auth: ApiTokenContext): void {
  const role = auth.user?.role;
  if (role !== 'owner' && role !== 'admin') {
    throw new SpendRequestError('Budget management requires an owner/admin API token');
  }
}

export const clientSpendApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Spend report ──
  //
  // Default (no `group_by_entity`): totals + per-model + timeseries rolled up
  // from the raw model usage logs — unchanged legacy behavior.
  //
  // With `group_by_entity=user|api_key`: a per-user / per-API-token breakdown
  // read from the cross-service `usage_daily` rollup instead. Attribution
  // (userId/apiTokenId) is only recorded from the rollup's deploy onward, so
  // earlier traffic appears under the empty-id (unattributed) entry.
  app.get('/client/v1/spend/report', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const query = request.query as {
        from?: string; to?: string; group_by?: string; group_by_entity?: string; model?: string;
      };
      const groupBy = query.group_by ?? 'day';
      if (!(VALID_GROUP_BY as readonly string[]).includes(groupBy)) {
        return reply.code(400).send({ error: '`group_by` must be hour, day, or month' });
      }

      if (query.group_by_entity !== undefined) {
        if (!(VALID_GROUP_BY_ENTITY as readonly string[]).includes(query.group_by_entity)) {
          return reply.code(400).send({ error: '`group_by_entity` must be user or api_key' });
        }
        const entity = query.group_by_entity as SpendGroupByEntity;

        const breakdown = await getSpendEntityBreakdown(
          {
            tenantDbName: auth.tenantDbName,
            tenantId: auth.tenantId,
            projectId: auth.projectId,
          },
          {
            from: parseDate(query.from, 'from'),
            to: parseDate(query.to, 'to'),
            modelKey: query.model,
            entity,
          },
        );

        const idField = entity === 'user' ? 'user_id' : 'api_token_id';
        return reply.code(200).send({
          object: 'spend.breakdown',
          group_by_entity: entity,
          from: breakdown.fromDay ?? null,
          to: breakdown.toDay ?? null,
          model: query.model ?? null,
          currency: 'USD',
          total_requests: breakdown.totals.requests,
          total_errors: breakdown.totals.errors,
          total_input_tokens: breakdown.totals.inputTokens,
          total_output_tokens: breakdown.totals.outputTokens,
          total_tokens: breakdown.totals.totalTokens,
          total_cost: breakdown.totals.costUsd,
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
      }

      const report = await getSpendReport(
        {
          tenantDbName: auth.tenantDbName,
          tenantId: auth.tenantId,
          projectId: auth.projectId,
        },
        {
          from: parseDate(query.from, 'from'),
          to: parseDate(query.to, 'to'),
          groupBy: groupBy as typeof VALID_GROUP_BY[number],
          modelKey: query.model,
        },
      );

      return reply.code(200).send({
        object: 'spend.report',
        from: report.from?.toISOString() ?? null,
        to: report.to?.toISOString() ?? null,
        group_by: report.groupBy,
        currency: report.currency,
        total_cost: report.totalCost,
        total_calls: report.totalCalls,
        total_input_tokens: report.totalInputTokens,
        total_output_tokens: report.totalOutputTokens,
        total_tokens: report.totalTokens,
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
          currency: entry.currency,
        })),
        timeseries: report.timeseries.map((point) => ({
          period: point.period,
          calls: point.calls,
          total_tokens: point.totalTokens,
          cost: point.cost,
        })),
      });
    } catch (error) {
      if (error instanceof SpendRequestError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Client spend report error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Budget status (usage vs limits) ──
  app.get('/client/v1/budgets/status', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const query = request.query as { domain?: string; model?: string; scope?: string };
      const domain = (query.domain ?? 'llm') as QuotaDomain;
      if (!VALID_DOMAINS.includes(domain)) {
        return reply.code(400).send({ error: `\`domain\` must be one of: ${VALID_DOMAINS.join(', ')}` });
      }

      // Default to the tenant-level window; `scope=token` narrows the counter
      // to the calling API token (matching how enforcement keys the counters).
      const usage = await getBudgetUsage({
        domain,
        licenseType: auth.tenant.licenseType as LicenseType,
        projectId: auth.projectId,
        resourceKey: query.model,
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        tokenId: query.scope === 'token'
          ? (auth.tokenRecord._id ? String(auth.tokenRecord._id) : undefined)
          : undefined,
      });

      const toWindow = (window: { limitUsd: number | null; usedUsd: number; remainingUsd: number | null }) => ({
        limit_usd: window.limitUsd,
        used_usd: window.usedUsd,
        remaining_usd: window.remainingUsd,
      });

      return reply.code(200).send({
        object: 'budget.status',
        domain,
        configured: usage.configured,
        per_day: toWindow(usage.perDay),
        per_month: toWindow(usage.perMonth),
        alert_thresholds: usage.alertThresholds ?? null,
      });
    } catch (error) {
      logger.error('Client budget status error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── List budgets ──
  app.get('/client/v1/budgets', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const policies = await listQuotaPolicies(auth.tenantDbName, auth.tenantId, {
        projectId: auth.projectId,
      });
      return reply.code(200).send({
        object: 'list',
        data: policies.filter(isBudgetPolicy).map(toClientBudget),
      });
    } catch (error) {
      logger.error('Client budgets list error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Create budget ──
  app.post('/client/v1/budgets', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      requireWriteAccess(auth);
      const body = safeReadJsonBody<Record<string, unknown>>(request);

      const domain = (body.domain ?? 'llm') as QuotaDomain;
      if (!VALID_DOMAINS.includes(domain)) {
        return reply.code(400).send({ error: `\`domain\` must be one of: ${VALID_DOMAINS.join(', ')}` });
      }
      const scope = (body.scope ?? 'tenant') as QuotaScope;
      if (!VALID_SCOPES.includes(scope)) {
        return reply.code(400).send({ error: `\`scope\` must be one of: ${VALID_SCOPES.join(', ')}` });
      }

      const dailyLimit = parseOptionalNumber(body.daily_limit_usd, 'daily_limit_usd');
      const monthlyLimit = parseOptionalNumber(body.monthly_limit_usd, 'monthly_limit_usd');
      if (dailyLimit === undefined && monthlyLimit === undefined) {
        return reply.code(400).send({ error: 'At least one of `daily_limit_usd` or `monthly_limit_usd` is required' });
      }
      const alertThresholds = Array.isArray(body.alert_thresholds)
        ? (body.alert_thresholds as unknown[]).map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : undefined;

      const policy = await createQuotaPolicy(auth.tenantDbName, auth.tenantId, {
        createdBy: auth.tokenRecord.userId ? String(auth.tokenRecord.userId) : 'api-token',
        description: typeof body.description === 'string' ? body.description : undefined,
        domain,
        enabled: body.enabled !== false,
        label: typeof body.label === 'string' ? body.label : 'Budget',
        limits: {
          budget: {
            dailySpendLimit: dailyLimit,
            monthlySpendLimit: monthlyLimit,
            alertThresholds,
          },
        },
        priority: Number(body.priority ?? 100),
        projectId: auth.projectId,
        scope,
        scopeId: typeof body.scope_id === 'string' ? body.scope_id : undefined,
      });

      return reply.code(201).send(toClientBudget(policy));
    } catch (error) {
      if (error instanceof SpendRequestError) {
        return reply.code(error.message.includes('owner/admin') ? 403 : 400).send({ error: error.message });
      }
      logger.error('Client budget create error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Update budget ──
  app.patch('/client/v1/budgets/:budgetId', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      requireWriteAccess(auth);
      const { budgetId } = request.params as { budgetId: string };
      const body = safeReadJsonBody<Record<string, unknown>>(request);

      const existing = (await listQuotaPolicies(auth.tenantDbName, auth.tenantId, {
        projectId: auth.projectId,
      })).find((policy) => String(policy._id) === budgetId);
      if (!existing || !isBudgetPolicy(existing)) {
        return reply.code(404).send({ error: 'Budget not found' });
      }

      const budget = { ...existing.limits.budget };
      if (body.daily_limit_usd !== undefined) {
        budget.dailySpendLimit = parseOptionalNumber(body.daily_limit_usd, 'daily_limit_usd');
      }
      if (body.monthly_limit_usd !== undefined) {
        budget.monthlySpendLimit = parseOptionalNumber(body.monthly_limit_usd, 'monthly_limit_usd');
      }
      if (body.alert_thresholds !== undefined) {
        budget.alertThresholds = Array.isArray(body.alert_thresholds)
          ? (body.alert_thresholds as unknown[]).map((value) => Number(value)).filter((value) => Number.isFinite(value))
          : undefined;
      }

      const updated = await updateQuotaPolicy(
        auth.tenantDbName,
        auth.tenantId,
        budgetId,
        {
          enabled: body.enabled === undefined ? existing.enabled : body.enabled !== false,
          label: typeof body.label === 'string' ? body.label : existing.label,
          description: typeof body.description === 'string' ? body.description : existing.description,
          limits: { ...existing.limits, budget },
          updatedBy: auth.tokenRecord.userId ? String(auth.tokenRecord.userId) : 'api-token',
        },
        auth.projectId,
      );
      if (!updated) return reply.code(404).send({ error: 'Budget not found' });
      return reply.code(200).send(toClientBudget(updated));
    } catch (error) {
      if (error instanceof SpendRequestError) {
        return reply.code(error.message.includes('owner/admin') ? 403 : 400).send({ error: error.message });
      }
      logger.error('Client budget update error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Delete budget ──
  app.delete('/client/v1/budgets/:budgetId', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      requireWriteAccess(auth);
      const { budgetId } = request.params as { budgetId: string };

      const existing = (await listQuotaPolicies(auth.tenantDbName, auth.tenantId, {
        projectId: auth.projectId,
      })).find((policy) => String(policy._id) === budgetId);
      if (!existing || !isBudgetPolicy(existing)) {
        return reply.code(404).send({ error: 'Budget not found' });
      }

      const deleted = await deleteQuotaPolicy(auth.tenantDbName, auth.tenantId, budgetId, auth.projectId);
      if (!deleted) return reply.code(404).send({ error: 'Budget not found' });
      return reply.code(200).send({ deleted: true, id: budgetId });
    } catch (error) {
      if (error instanceof SpendRequestError) {
        return reply.code(403).send({ error: error.message });
      }
      logger.error('Client budget delete error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
