/**
 * Alert service — CRUD operations for alert rules and event history.
 *
 * All operations are tenant-scoped and project-aware.
 */

import { getTenantDatabase } from '@/lib/database';
import type {
  IAlertRule,
  IAlertEvent,
  AlertMetric,
  AlertModule,
  IAlertCondition,
  IAlertChannel,
  AlertEventStatus,
} from '@/lib/database';

/** Module-to-metrics mapping */
const MODULE_METRICS: Record<AlertModule, AlertMetric[]> = {
  models: ['error_rate', 'avg_latency_ms', 'p95_latency_ms', 'total_cost', 'total_requests'],
  inference: ['gpu_cache_usage', 'request_queue_depth'],
  guardrails: ['guardrail_fail_rate', 'guardrail_avg_latency_ms', 'guardrail_total_evaluations'],
  rag: ['rag_avg_latency_ms', 'rag_total_queries', 'rag_failed_documents'],
  mcp: ['mcp_error_rate', 'mcp_avg_latency_ms', 'mcp_total_requests'],
};

/** Supported metric names for validation */
const VALID_METRICS: AlertMetric[] = Object.values(MODULE_METRICS).flat();

/** Supported module names */
const VALID_MODULES: AlertModule[] = ['models', 'inference', 'guardrails', 'rag', 'mcp'];

/** Supported window durations (minutes) */
const VALID_WINDOWS = [5, 15, 30, 60];

export interface CreateAlertRuleInput {
  name: string;
  description?: string;
  module: AlertModule;
  metric: AlertMetric;
  condition: IAlertCondition;
  windowMinutes: number;
  cooldownMinutes?: number;
  scope?: { modelKey?: string; serverKey?: string; guardrailKey?: string; ragModuleKey?: string; mcpServerKey?: string };
  channels?: IAlertChannel[];
  enabled?: boolean;
}

export class AlertService {
  // ── Rule CRUD ────────────────────────────────────────────────────────

  static async createRule(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    input: CreateAlertRuleInput,
  ): Promise<IAlertRule> {
    this.validateRuleInput(input);

    const db = await getTenantDatabase(tenantDbName);

    const rule = await db.createAlertRule({
      tenantId,
      projectId,
      name: input.name.trim(),
      description: input.description?.trim(),
      module: input.module,
      enabled: input.enabled ?? true,
      metric: input.metric,
      condition: input.condition,
      windowMinutes: input.windowMinutes,
      cooldownMinutes: input.cooldownMinutes ?? 60,
      scope: input.scope,
      channels: input.channels ?? [{ type: 'email', recipients: [] }],
      createdBy: userId,
    });

    return rule;
  }

  static async updateRule(
    tenantDbName: string,
    ruleId: string,
    data: Partial<CreateAlertRuleInput> & { updatedBy?: string },
  ): Promise<IAlertRule | null> {
    if (data.metric && !VALID_METRICS.includes(data.metric)) {
      throw new Error(`Invalid metric: ${data.metric}`);
    }
    if (data.module && !VALID_MODULES.includes(data.module)) {
      throw new Error(`Invalid module: ${data.module}`);
    }
    if (data.windowMinutes && !VALID_WINDOWS.includes(data.windowMinutes)) {
      throw new Error(`Invalid window: ${data.windowMinutes}. Must be one of: ${VALID_WINDOWS.join(', ')}`);
    }

    const db = await getTenantDatabase(tenantDbName);
    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description?.trim();
    if (data.module !== undefined) updateData.module = data.module;
    if (data.metric !== undefined) updateData.metric = data.metric;
    if (data.condition !== undefined) updateData.condition = data.condition;
    if (data.windowMinutes !== undefined) updateData.windowMinutes = data.windowMinutes;
    if (data.cooldownMinutes !== undefined) updateData.cooldownMinutes = data.cooldownMinutes;
    if (data.scope !== undefined) updateData.scope = data.scope;
    if (data.channels !== undefined) updateData.channels = data.channels;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.updatedBy) updateData.updatedBy = data.updatedBy;

    return db.updateAlertRule(ruleId, updateData);
  }

  static async deleteRule(
    tenantDbName: string,
    ruleId: string,
  ): Promise<boolean> {
    const db = await getTenantDatabase(tenantDbName);
    return db.deleteAlertRule(ruleId);
  }

  static async getRule(
    tenantDbName: string,
    ruleId: string,
  ): Promise<IAlertRule | null> {
    const db = await getTenantDatabase(tenantDbName);
    return db.findAlertRuleById(ruleId);
  }

  static async listRules(
    tenantDbName: string,
    tenantId: string,
    projectId?: string,
  ): Promise<IAlertRule[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listAlertRules(tenantId, { projectId });
  }

  static async toggleRule(
    tenantDbName: string,
    ruleId: string,
    enabled: boolean,
    userId: string,
  ): Promise<IAlertRule | null> {
    const db = await getTenantDatabase(tenantDbName);
    return db.updateAlertRule(ruleId, { enabled, updatedBy: userId });
  }

  // ── Event (History) ──────────────────────────────────────────────────

  static async listEvents(
    tenantDbName: string,
    tenantId: string,
    options?: {
      projectId?: string;
      ruleId?: string;
      status?: AlertEventStatus;
      limit?: number;
      skip?: number;
    },
  ): Promise<IAlertEvent[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listAlertEvents(tenantId, options);
  }

  static async acknowledgeEvent(
    tenantDbName: string,
    eventId: string,
  ): Promise<IAlertEvent | null> {
    const db = await getTenantDatabase(tenantDbName);
    return db.updateAlertEvent(eventId, { status: 'acknowledged' });
  }

  static async countActive(
    tenantDbName: string,
    tenantId: string,
    projectId?: string,
  ): Promise<number> {
    const db = await getTenantDatabase(tenantDbName);
    return db.countActiveAlerts(tenantId, projectId);
  }

  // ── Validation ───────────────────────────────────────────────────────

  private static validateRuleInput(input: CreateAlertRuleInput): void {
    if (!input.name || !input.name.trim()) {
      throw new Error('Alert rule name is required');
    }
    if (!input.module || !VALID_MODULES.includes(input.module)) {
      throw new Error(`Invalid module: ${input.module}. Must be one of: ${VALID_MODULES.join(', ')}`);
    }
    if (!VALID_METRICS.includes(input.metric)) {
      throw new Error(`Invalid metric: ${input.metric}. Must be one of: ${VALID_METRICS.join(', ')}`);
    }
    // Validate metric belongs to the specified module
    const moduleMetrics = MODULE_METRICS[input.module];
    if (!moduleMetrics.includes(input.metric)) {
      throw new Error(`Metric "${input.metric}" is not available for module "${input.module}". Valid: ${moduleMetrics.join(', ')}`);
    }
    if (!input.condition || typeof input.condition.threshold !== 'number') {
      throw new Error('Condition with numeric threshold is required');
    }
    const validOps = ['gt', 'lt', 'gte', 'lte', 'eq'];
    if (!validOps.includes(input.condition.operator)) {
      throw new Error(`Invalid operator: ${input.condition.operator}`);
    }
    if (!VALID_WINDOWS.includes(input.windowMinutes)) {
      throw new Error(`Invalid window: ${input.windowMinutes}. Must be one of: ${VALID_WINDOWS.join(', ')}`);
    }
  }
}

/** Re-export for convenience */
export { VALID_METRICS, VALID_WINDOWS, VALID_MODULES, MODULE_METRICS };
