/**
 * Email alert channel dispatcher.
 *
 * Sends alert-fired notifications using the existing mailer infrastructure.
 * When recipient list is empty, falls back to sending to the tenant
 * owner/admin emails.
 */

import { sendEmail } from '@/lib/email/mailer';
import { getTenantDatabase } from '@/lib/database';
import type { IAlertChannel } from '@/lib/database';
import { isUserDisabled } from '@/lib/services/users/userAuthState';
import {
  isAlertNotification,
  type AlertContext,
  type AlertNotification,
  type DispatchResult,
  type IAlertDispatcher,
  type LegacyAlertDispatchPayload,
} from './types';

/** Human-readable labels for metric names */
const METRIC_LABELS: Record<string, string> = {
  error_rate: 'Error Rate',
  avg_latency_ms: 'Average Latency',
  p95_latency_ms: 'P95 Latency',
  total_cost: 'Total Cost',
  total_requests: 'Total Requests',
  gpu_cache_usage: 'GPU Cache Usage',
  request_queue_depth: 'Request Queue Depth',
  guardrail_fail_rate: 'Guardrail Fail Rate',
  guardrail_avg_latency_ms: 'Guardrail Avg Latency',
  guardrail_total_evaluations: 'Guardrail Total Evaluations',
  rag_avg_latency_ms: 'Knowledge Engine Avg Query Latency',
  rag_total_queries: 'Knowledge Engine Total Queries',
  rag_failed_documents: 'Knowledge Engine Failed Documents',
};

/** Human-readable operator symbols */
const OPERATOR_LABELS: Record<string, string> = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  eq: '=',
};

/** Unit strings per metric */
const METRIC_UNITS: Record<string, string> = {
  error_rate: '%',
  avg_latency_ms: 'ms',
  p95_latency_ms: 'ms',
  total_cost: 'USD',
  total_requests: '',
  gpu_cache_usage: '%',
  request_queue_depth: '',
  guardrail_fail_rate: '%',
  guardrail_avg_latency_ms: 'ms',
  guardrail_total_evaluations: '',
  rag_avg_latency_ms: 'ms',
  rag_total_queries: '',
  rag_failed_documents: '',
};

export class EmailAlertChannel implements IAlertDispatcher {
  readonly type = 'email';

  async dispatch(
    payload: AlertNotification | LegacyAlertDispatchPayload,
    channel: IAlertChannel,
    ctx: AlertContext,
  ): Promise<DispatchResult[]> {
    if (channel.type !== 'email') return [];

    let recipients = channel.recipients;

    // Fallback: if no explicit recipients, send to tenant owner/admins
    if (!recipients || recipients.length === 0) {
      recipients = await this.getDefaultRecipients(ctx.tenantDbName);
    }

    // A disabled account must not keep receiving operational mail, whether it
    // was listed explicitly or picked up by the owner/admin fallback.
    recipients = await this.withoutDisabledUsers(ctx.tenantDbName, recipients);

    if (recipients.length === 0) {
      return [
        { type: 'email', target: '(none)', success: false, error: 'No recipients available' },
      ];
    }

    const templateData = isAlertNotification(payload)
      ? {
          alertName: payload.rule.name,
          projectName: ctx.projectName,
          companyName: ctx.companyName,
          metricLabel: payload.rule.metricLabel,
          operator: OPERATOR_LABELS[payload.rule.operator ?? 'gte'] ?? '≥',
          threshold: payload.rule.threshold,
          actualValue: Number((payload.value ?? 0).toFixed(2)),
          unit: payload.rule.unit,
          firedAt: payload.firedAt.toISOString(),
          dashboardUrl: ctx.dashboardUrl,
          incidentUrl: ctx.incidentUrl || ctx.dashboardUrl,
          incidentId: ctx.incidentId || '',
          metadata: undefined,
        }
      : {
          alertName: payload.ruleName,
          projectName: ctx.projectName,
          companyName: ctx.companyName,
          metricLabel: METRIC_LABELS[payload.metric] ?? payload.metric,
          operator: OPERATOR_LABELS[(payload as Record<string, unknown>).operator as string] ?? '≥',
          threshold: payload.threshold,
          actualValue: Number(payload.actualValue.toFixed(2)),
          unit: METRIC_UNITS[payload.metric] ?? '',
          firedAt: payload.firedAt.toISOString(),
          dashboardUrl: ctx.dashboardUrl,
          incidentUrl: ctx.incidentUrl || ctx.dashboardUrl,
          incidentId: ctx.incidentId || '',
          metadata: payload.metadata,
        };

    const results: DispatchResult[] = [];

    for (const recipient of recipients) {
      try {
        const sent = await sendEmail(recipient, 'alert-fired', templateData);
        results.push({ type: 'email', target: recipient, success: sent });
      } catch (err) {
        results.push({
          type: 'email',
          target: recipient,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Drop recipients that belong to a disabled user. Best effort: if the user
   * list can't be read the recipients are kept, since failing to notify is
   * worse than one stray mail to an account disabled moments ago.
   */
  private async withoutDisabledUsers(tenantDbName: string, recipients: string[]): Promise<string[]> {
    if (recipients.length === 0) return recipients;
    try {
      const db = await getTenantDatabase(tenantDbName);
      const users = await db.listUsers();
      const disabled = new Set(
        users.filter(isUserDisabled).map((u) => (u.email ?? '').trim().toLowerCase()).filter(Boolean),
      );
      if (disabled.size === 0) return recipients;
      return recipients.filter((r) => !disabled.has(r.trim().toLowerCase()));
    } catch {
      return recipients;
    }
  }

  /** Fetch owner + admin emails from the tenant DB as fallback recipients */
  private async getDefaultRecipients(tenantDbName: string): Promise<string[]> {
    try {
      const db = await getTenantDatabase(tenantDbName);
      const users = await db.listUsers();
      return users
        .filter((u) => (u.role === 'owner' || u.role === 'admin') && !isUserDisabled(u))
        .map((u) => u.email);
    } catch {
      return [];
    }
  }
}
