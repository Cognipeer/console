/**
 * Alert channel dispatcher interface.
 *
 * Each notification channel (email, Slack, webhook …) implements this
 * contract so the evaluator can dispatch alerts polymorphically.
 */

import type { IAlertEvent, IAlertChannel } from '@/lib/database';

export interface AlertContext {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  companyName: string;
  projectName: string;
  dashboardUrl: string;
}

export interface DispatchResult {
  type: string;
  target: string;
  success: boolean;
  error?: string;
}

export interface IAlertDispatcher {
  readonly type: string;
  dispatch(
    event: Omit<IAlertEvent, '_id'>,
    channel: IAlertChannel,
    context: AlertContext,
  ): Promise<DispatchResult[]>;
}
