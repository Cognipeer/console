/**
 * Alert delivery log: one row per notification attempt on one channel
 * (`alert_deliveries`), written at the fire, resolve and renotify dispatch
 * sites, including the attempts that were suppressed (rule muted, incident
 * snoozed). Best effort: logging must never break an evaluation.
 */

import type {
  AlertDeliveryStatus,
  AlertDeliveryTrigger,
  DatabaseProvider,
  IAlertChannel,
  IAlertDelivery,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { AlertNotification, DispatchResult } from './channels/types';

const logger = createLogger('alert-deliveries');

/** Rows older than this are removed (opportunistically, on write). */
export const DELIVERY_RETENTION_MS = 30 * 86_400_000;
const MAX_ERROR_LENGTH = 500;
const PRUNE_MIN_INTERVAL_MS = 60 * 60_000;

export type SuppressionReason = 'rule_muted' | 'incident_snoozed';

export interface DeliveryBase {
  tenantId: string;
  projectId: string;
  ruleId: string;
  incidentId?: string | null;
  eventId?: string | null;
}

const TRIGGERS: Record<AlertNotification['kind'], AlertDeliveryTrigger> = {
  fired: 'fire',
  resolved: 'resolve',
  renotify: 'renotify',
  test: 'test',
};

export function deliveryTrigger(kind: AlertNotification['kind']): AlertDeliveryTrigger {
  return TRIGGERS[kind];
}

function clipError(error: string | undefined | null): string | null {
  if (!error) return null;
  return error.length > MAX_ERROR_LENGTH ? `${error.slice(0, MAX_ERROR_LENGTH - 1)}…` : error;
}

const lastPruneAt = new Map<string, number>();

/** Bounded retention: expired rows go at most once an hour per tenant, on a write. */
function maybePrune(db: DatabaseProvider, tenantId: string): void {
  const last = lastPruneAt.get(tenantId) ?? 0;
  if (Date.now() - last < PRUNE_MIN_INTERVAL_MS) return;
  lastPruneAt.set(tenantId, Date.now());
  db.pruneAlertDeliveries(new Date(Date.now() - DELIVERY_RETENTION_MS)).catch((error) => {
    logger.warn('Could not prune old alert deliveries', { error: error instanceof Error ? error.message : String(error) });
  });
}

async function write(db: DatabaseProvider, base: DeliveryBase, rows: Array<Omit<IAlertDelivery, '_id'>>): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.createAlertDeliveries(rows);
    maybePrune(db, base.tenantId);
  } catch (error) {
    logger.warn('Could not record alert deliveries', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Record what a dispatch produced (`sent` / `failed` per channel result). */
export async function recordDeliveries(
  db: DatabaseProvider,
  base: DeliveryBase,
  kind: AlertNotification['kind'],
  results: DispatchResult[],
): Promise<void> {
  const trigger = deliveryTrigger(kind);
  const fallbackAt = new Date();
  await write(db, base, results.map((result) => ({
    tenantId: base.tenantId,
    projectId: base.projectId,
    ruleId: base.ruleId,
    incidentId: base.incidentId ?? null,
    eventId: base.eventId ?? null,
    channelId: result.channelId ?? '',
    channelKind: result.type,
    channelName: result.channelName ?? null,
    trigger,
    status: (result.success ? 'sent' : 'failed') as AlertDeliveryStatus,
    reason: null,
    error: result.success ? null : clipError(result.error),
    attemptAt: result.at ?? fallbackAt,
  })));
}

/** Record that every channel of the rule was skipped, and why. */
export async function recordSuppressed(
  db: DatabaseProvider,
  base: DeliveryBase,
  kind: AlertNotification['kind'],
  channels: IAlertChannel[],
  reason: SuppressionReason,
): Promise<void> {
  const trigger = deliveryTrigger(kind);
  const attemptAt = new Date();
  await write(db, base, (channels ?? []).map((channel) => ({
    tenantId: base.tenantId,
    projectId: base.projectId,
    ruleId: base.ruleId,
    incidentId: base.incidentId ?? null,
    eventId: base.eventId ?? null,
    channelId: channel.id ?? '',
    channelKind: String((channel as { type?: unknown }).type ?? 'unknown'),
    channelName: null,
    trigger,
    status: 'suppressed' as AlertDeliveryStatus,
    reason,
    error: null,
    attemptAt,
  })));
}
