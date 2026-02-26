/**
 * Alert evaluator — the core engine that checks alert rules against
 * live metric data and dispatches notifications when thresholds are breached.
 *
 * Called periodically by the alert scheduler for every active tenant.
 */

import { getTenantDatabase } from '@/lib/database';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('alert-evaluator');
import type { IAlertEvent, AlertConditionOperator } from '@/lib/database';
import { collectMetric } from './metrics';
import { getChannel } from './channels';
import type { AlertContext, DispatchResult } from './channels';

/**
 * Evaluate a single condition: `actualValue <op> threshold`
 */
function evaluateCondition(
  actual: number,
  operator: AlertConditionOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt': return actual > threshold;
    case 'lt': return actual < threshold;
    case 'gte': return actual >= threshold;
    case 'lte': return actual <= threshold;
    case 'eq': return actual === threshold;
    default: return false;
  }
}

export interface EvaluationContext {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  companyName: string;
}

/**
 * Evaluate all active alert rules for a given tenant.
 *
 * For each enabled rule:
 * 1. Check cooldown — skip if recently triggered
 * 2. Collect the metric value for the rule's window
 * 3. Evaluate condition
 * 4. If breached → create alert event + dispatch notifications
 * 5. Update rule's lastTriggeredAt
 */
export async function evaluateTenantAlerts(
  ctx: EvaluationContext,
): Promise<number> {
  const db = await getTenantDatabase(ctx.tenantDbName);

  // Fetch all enabled rules for this tenant
  const rules = await db.listAlertRules(ctx.tenantId, { enabled: true });
  if (rules.length === 0) return 0;

  let firedCount = 0;
  const now = new Date();

  for (const rule of rules) {
    try {
      // 1. Cooldown check
      if (rule.lastTriggeredAt) {
        const cooldownMs = rule.cooldownMinutes * 60 * 1000;
        const elapsed = now.getTime() - new Date(rule.lastTriggeredAt).getTime();
        if (elapsed < cooldownMs) continue;
      }

      // 2. Collect metric
      const metricResult = await collectMetric({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        metric: rule.metric,
        windowMinutes: rule.windowMinutes,
        scope: {
          projectId: rule.projectId,
          modelKey: rule.scope?.modelKey,
          serverKey: rule.scope?.serverKey,
          guardrailKey: rule.scope?.guardrailKey,
          ragModuleKey: rule.scope?.ragModuleKey,
        },
      });

      // Skip evaluation if no data in the window
      if (metricResult.sampleCount === 0) continue;

      // 3. Evaluate condition
      const breached = evaluateCondition(
        metricResult.value,
        rule.condition.operator,
        rule.condition.threshold,
      );

      if (!breached) continue;

      // 4. Resolve project name
      let projectName = 'Unknown Project';
      try {
        const project = await db.findProjectById(rule.projectId);
        if (project) projectName = project.name;
      } catch { /* ignore */ }

      // 5. Build alert event
      const alertEvent: Omit<IAlertEvent, '_id'> = {
        tenantId: ctx.tenantId,
        projectId: rule.projectId,
        ruleId: String(rule._id),
        ruleName: rule.name,
        metric: rule.metric,
        threshold: rule.condition.threshold,
        actualValue: metricResult.value,
        status: 'fired',
        channels: [],
        firedAt: now,
        metadata: {
          operator: rule.condition.operator,
          windowMinutes: rule.windowMinutes,
          sampleCount: metricResult.sampleCount,
          scope: rule.scope,
        },
      };

      // 6. Dispatch to channels
      const channelCtx: AlertContext = {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        companyName: ctx.companyName,
        projectName,
        dashboardUrl: `${getConfig().app.url}/dashboard/alerts`,
      };

      const allResults: DispatchResult[] = [];
      for (const ch of rule.channels) {
        const dispatcher = getChannel(ch.type);
        if (!dispatcher) {
          allResults.push({
            type: ch.type,
            target: '(unknown channel)',
            success: false,
            error: `No dispatcher for channel type "${ch.type}"`,
          });
          continue;
        }
        const results = await dispatcher.dispatch(alertEvent, ch, channelCtx);
        allResults.push(...results);
      }

      alertEvent.channels = allResults;

      // 7. Persist event
      // Re-switch tenant in case channel dispatchers touched it
      await db.switchToTenant(ctx.tenantDbName);
      await db.createAlertEvent(alertEvent);

      // 8. Update rule's lastTriggeredAt
      await db.updateAlertRule(String(rule._id), { lastTriggeredAt: now });

      firedCount++;

      logger.info(`FIRED: "${rule.name}" (${rule.metric} = ${metricResult.value.toFixed(2)}, threshold ${rule.condition.operator} ${rule.condition.threshold}) for tenant ${ctx.tenantSlug}`);
    } catch (err) {
      logger.error(`Error evaluating rule "${rule.name}" for tenant ${ctx.tenantSlug}`, {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  return firedCount;
}
