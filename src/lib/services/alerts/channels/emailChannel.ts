/**
 * Email alert channel dispatcher.
 *
 * Sends alert-fired notifications using the existing mailer infrastructure.
 * When recipient list is empty, falls back to sending to the tenant
 * owner/admin emails.
 */

import { sendEmail } from '@/lib/email/mailer';
import { getTenantDatabase } from '@/lib/database';
import type { IAlertEvent, IAlertChannel } from '@/lib/database';
import type { AlertContext, DispatchResult, IAlertDispatcher } from './types';

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
  rag_avg_latency_ms: 'RAG Avg Query Latency',
  rag_total_queries: 'RAG Total Queries',
  rag_failed_documents: 'RAG Failed Documents',
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
    event: Omit<IAlertEvent, '_id'>,
    channel: IAlertChannel,
    ctx: AlertContext,
  ): Promise<DispatchResult[]> {
    if (channel.type !== 'email') return [];

    let recipients = channel.recipients;

    // Fallback: if no explicit recipients, send to tenant owner/admins
    if (!recipients || recipients.length === 0) {
      recipients = await this.getDefaultRecipients(ctx.tenantDbName);
    }

    if (recipients.length === 0) {
      return [
        { type: 'email', target: '(none)', success: false, error: 'No recipients available' },
      ];
    }

    const templateData = {
      alertName: event.ruleName,
      projectName: ctx.projectName,
      companyName: ctx.companyName,
      metricLabel: METRIC_LABELS[event.metric] ?? event.metric,
      operator: OPERATOR_LABELS[(event as Record<string, unknown>).operator as string] ?? '≥',
      threshold: event.threshold,
      actualValue: Number(event.actualValue.toFixed(2)),
      unit: METRIC_UNITS[event.metric] ?? '',
      firedAt: event.firedAt.toISOString(),
      dashboardUrl: ctx.dashboardUrl,
      incidentUrl: ctx.incidentUrl || ctx.dashboardUrl,
      incidentId: ctx.incidentId || '',
      metadata: event.metadata,
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

  /** Fetch owner + admin emails from the tenant DB as fallback recipients */
  private async getDefaultRecipients(tenantDbName: string): Promise<string[]> {
    try {
      const db = await getTenantDatabase(tenantDbName);
      const users = await db.listUsers();
      return users
        .filter((u) => u.role === 'owner' || u.role === 'admin')
        .map((u) => u.email);
    } catch {
      return [];
    }
  }
}
