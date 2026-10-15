/**
 * Alert channel dispatcher interface.
 *
 * Each notification channel (email, Slack, webhook …) implements this
 * contract so the evaluator can dispatch alerts polymorphically.
 */

import type {
  AlertConditionMode,
  AlertConditionOperator,
  AlertMetric,
  AlertModule,
  EntityMetricType,
  IAlertChannel,
  IAlertEvent,
  IIncidentContext,
  IncidentSeverity,
} from '@/lib/database';

export interface AlertContext {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  companyName: string;
  projectName: string;
  dashboardUrl: string;
  incidentUrl?: string;
  incidentId?: string;
}

export interface DispatchResult {
  type: string;
  target: string;
  success: boolean;
  error?: string;
}

/** What a channel is told about: one alert state change (fired, resolved, re-notified) or a test. */
export interface AlertNotification {
  kind: 'fired' | 'resolved' | 'renotify' | 'test';
  rule: {
    id: string;
    name: string;
    module: AlertModule;
    metric: AlertMetric;
    metricLabel: string;
    unit: string;
    mode: AlertConditionMode;
    windowMinutes: number;
    operator?: AlertConditionOperator;
    threshold?: number;
  };
  entity?: { type: EntityMetricType; key: string } | null;
  value: number | null;
  baseline?: number | null;
  severity: IncidentSeverity;
  firedAt: Date;
  resolvedAt?: Date | null;
  projectName: string;
  companyName: string;
  incidentUrl?: string;
  dashboardUrl: string;
  entityUrl?: string;
  context?: IIncidentContext | null;
}

/** Channel-neutral message (digests and other non-alert notices) rendered by each channel in its own format. */
export interface ChannelMessage {
  title: string;
  summary: string;
  severity?: IncidentSeverity | 'ok';
  fields: Array<{ label: string; value: string }>;
  url?: string;
  urlLabel?: string;
  footer?: string;
}

/**
 * The event-shaped payload channels received before notifications existed.
 * @deprecated Transitional: the evaluator still hands the stored event to the
 * dispatcher until it sends an `AlertNotification`; remove with that change.
 */
export type LegacyAlertDispatchPayload = Omit<IAlertEvent, '_id'>;

export interface IAlertDispatcher {
  readonly type: IAlertChannel['type'];
  dispatch(
    notification: AlertNotification | LegacyAlertDispatchPayload,
    channel: IAlertChannel,
    context: AlertContext,
  ): Promise<DispatchResult[]>;
  /** Optional: deliver a generic message (digests). */
  sendMessage?(message: ChannelMessage, channel: IAlertChannel, context: AlertContext): Promise<DispatchResult[]>;
}

export function isAlertNotification(
  payload: AlertNotification | LegacyAlertDispatchPayload,
): payload is AlertNotification {
  return typeof (payload as AlertNotification).kind === 'string' && 'rule' in payload;
}
