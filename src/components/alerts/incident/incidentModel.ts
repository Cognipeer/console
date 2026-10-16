/**
 * View model of the incident detail additions: the safe external runbook link, the chart window,
 * the per-channel grouping of delivery attempts and the incident state line. Pure.
 */

import type { IncidentDto } from '../alertTypes';

/**
 * A URL the user entered (a runbook) as a link target: http(s) only, no whitespace or control
 * characters. Returns the normalized href or null. Never use `internalPath` for these: that helper
 * is for in-app paths and rejects every external address.
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Host of an external link, for the label. */
export function externalHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

// ── Chart window ────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/** The health chart window of an incident: the lead-up to the firing through shortly after it ended (min 6 h, max 7 d). */
export function incidentChartRange(incident: Pick<IncidentDto, 'firedAt' | 'resolvedAt' | 'closedAt'>, nowMs: number = Date.now()): { fromMs: number; toMs: number } | null {
  const fired = Date.parse(incident.firedAt);
  if (!Number.isFinite(fired)) return null;
  const endRaw = Date.parse(incident.resolvedAt ?? incident.closedAt ?? '');
  const end = Number.isFinite(endRaw) ? endRaw : nowMs;
  let toMs = Math.min(nowMs, end + HOUR_MS);
  let fromMs = fired - 3 * HOUR_MS;
  if (toMs - fromMs < 6 * HOUR_MS) toMs = Math.min(nowMs, fromMs + 6 * HOUR_MS);
  if (toMs - fromMs < 6 * HOUR_MS) fromMs = toMs - 6 * HOUR_MS;
  if (toMs - fromMs > 7 * 24 * HOUR_MS) fromMs = toMs - 7 * 24 * HOUR_MS;
  if (fromMs >= toMs) return null;
  return { fromMs, toMs };
}

// ── Deliveries ──────────────────────────────────────────────────────────────

export type DeliveryTrigger = 'fire' | 'resolve' | 'renotify' | 'test';
export type DeliveryStatus = 'sent' | 'failed' | 'suppressed';

/** One row of `GET /alerts/incidents/:id/deliveries`. */
export interface DeliveryDto {
  _id: string;
  channelId: string;
  channelKind: string;
  channelName?: string | null;
  trigger: DeliveryTrigger;
  status: DeliveryStatus;
  reason?: string | null;
  error?: string | null;
  attemptAt: string;
}

/** `channelKind` of a delivery row whose channel is a reference to a shared (library) channel. */
export const LIBRARY_KIND = 'library';

export interface ChannelDeliveries {
  key: string;
  kind: string;
  name: string | null;
  /** Oldest first. */
  attempts: DeliveryDto[];
  failed: number;
  suppressed: number;
  sent: number;
}

/** Group delivery attempts per channel (the API returns newest first); attempts read oldest first inside a channel. */
export function groupDeliveries(deliveries: DeliveryDto[]): ChannelDeliveries[] {
  const map = new Map<string, ChannelDeliveries>();
  for (const delivery of deliveries) {
    const key = delivery.channelId || `${delivery.channelKind}:${delivery.channelName ?? ''}`;
    let group = map.get(key);
    if (!group) {
      group = { key, kind: delivery.channelKind, name: delivery.channelName ?? null, attempts: [], failed: 0, suppressed: 0, sent: 0 };
      map.set(key, group);
    }
    group.attempts.push(delivery);
    if (!group.name && delivery.channelName) group.name = delivery.channelName;
    // A held-back row of a library reference only knows it is "library"; a row that resolved it names the real kind.
    if (group.kind === LIBRARY_KIND && delivery.channelKind !== LIBRARY_KIND) group.kind = delivery.channelKind;
    if (delivery.status === 'failed') group.failed += 1;
    else if (delivery.status === 'suppressed') group.suppressed += 1;
    else group.sent += 1;
  }
  const groups = [...map.values()];
  for (const group of groups) group.attempts.sort((a, b) => Date.parse(a.attemptAt) - Date.parse(b.attemptAt));
  // A channel with problems first, then by its latest attempt.
  const latest = (group: ChannelDeliveries) => Date.parse(group.attempts[group.attempts.length - 1]!.attemptAt);
  return groups.sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0) || latest(b) - latest(a));
}

export type DeliveryReasonKey = 'rule_muted' | 'incident_snoozed' | 'channel_missing';

/** The translation key suffix of a delivery reason code (`deliveries.reason.<x>`), or null for an unknown one. */
export function deliveryReasonKey(reason: string | null | undefined): DeliveryReasonKey | null {
  return reason === 'rule_muted' || reason === 'incident_snoozed' || reason === 'channel_missing' ? reason : null;
}

/**
 * The reason code of an attempt, wherever it was stored: `reason`, or `error` (rows written before a failed
 * delivery kept its code in `reason` carry it as the error text).
 */
export function deliveryCodeKey(attempt: Pick<DeliveryDto, 'reason' | 'error'>): DeliveryReasonKey | null {
  return deliveryReasonKey(attempt.reason) ?? deliveryReasonKey(attempt.error);
}

/** How long the server keeps delivery attempts (`DELIVERY_RETENTION_MS` in `deliveryLog.ts`; a test keeps the two equal). */
export const DELIVERY_RETENTION_DAYS = 30;

/** Whether an incident fired so long ago that its delivery history may already be gone. */
export function deliveriesBeyondRetention(firedAt: string | null | undefined, now: number = Date.now()): boolean {
  const fired = firedAt ? Date.parse(firedAt) : Number.NaN;
  return Number.isFinite(fired) && now - fired > DELIVERY_RETENTION_DAYS * 86_400_000;
}

// ── State line ──────────────────────────────────────────────────────────────

export interface IncidentFlags {
  snoozed: boolean;
  snoozedUntil: string | null;
  reopenCount: number;
}

/** Snooze and reopen state of an incident as the detail header shows it. */
export function incidentFlags(incident: Pick<IncidentDto, 'snoozedUntil' | 'reopenCount' | 'status'>, now: number = Date.now()): IncidentFlags {
  const until = incident.snoozedUntil ? Date.parse(incident.snoozedUntil) : Number.NaN;
  const snoozed = Number.isFinite(until) && until > now;
  return { snoozed, snoozedUntil: snoozed ? (incident.snoozedUntil ?? null) : null, reopenCount: incident.reopenCount ?? 0 };
}

/** Whether the incident may still be snoozed (a live one). */
export function canSnooze(status: IncidentDto['status']): boolean {
  return status === 'open' || status === 'acknowledged' || status === 'investigating';
}
