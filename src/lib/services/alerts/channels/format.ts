/**
 * Shared text formatting for alert notifications: every channel renders the
 * same numbers, operators and timestamps the same way.
 */

import type { AlertConditionOperator, IncidentSeverity } from '@/lib/database';
import type { AlertNotification } from './types';

const OPERATOR_SYMBOLS: Record<AlertConditionOperator, string> = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  eq: '=',
};

const SEVERITY_LABELS: Record<IncidentSeverity | 'ok', string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
  ok: 'Resolved',
};

export function operatorSymbol(operator: AlertConditionOperator | undefined): string {
  return (operator && OPERATOR_SYMBOLS[operator]) || '≥';
}

export function severityLabel(severity: IncidentSeverity | 'ok' | undefined): string {
  return (severity && SEVERITY_LABELS[severity]) || 'Info';
}

/** 12.5 -> "12.5", 1234.5678 -> "1,234.57", 0.00042 -> "0.0004" (at most 2 decimals, 4 under 0.01). */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  const digits = abs !== 0 && abs < 0.01 ? 4 : 2;
  return Number(value.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** `12.5%`, `840ms`, `$3.2`, `17`: the unit placed the way it reads. */
export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const text = formatNumber(value);
  switch (unit) {
    case '%':
    case 'ms':
      return `${text}${unit}`;
    case '$':
      return `$${text}`;
    case 'USD':
      return `${text} USD`;
    default:
      return text;
  }
}

export function formatWindow(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'n/a';
  if (minutes % 1440 === 0) return minutes === 1440 ? '24 hours' : `${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** `2026-10-15 12:30 UTC` */
export function formatTimestamp(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function formatDuration(fromMs: number, toMs: number): string {
  const total = Math.max(0, Math.round((toMs - fromMs) / 60_000));
  if (total < 1) return 'under a minute';
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours < 24) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} d ${rest} h` : `${days} d`;
}

/** `1.4.0 → 1.5.0 (first seen 18 min before this fired)`; empty when no version is known. */
export function formatVersionChange(
  version: { from: string | null; to: string | null; firstSeenAt?: string } | null | undefined,
  firedAt: Date | string | number,
): string {
  if (!version || (!version.from && !version.to)) return '';
  const text = `${version.from ?? 'n/a'} → ${version.to ?? 'n/a'}`;
  const firstSeenMs = version.firstSeenAt ? new Date(version.firstSeenAt).getTime() : Number.NaN;
  const firedMs = new Date(firedAt).getTime();
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(firedMs) || firstSeenMs > firedMs) return text;
  return `${text} (first seen ${formatDuration(firstSeenMs, firedMs)} before this fired)`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function entityLabel(n: Pick<AlertNotification, 'entity'>): string | null {
  return n.entity?.key ? `${n.entity.type}: ${n.entity.key}` : null;
}

/** The sentence every channel leads with: what happened to which metric. */
export function describeBreach(n: AlertNotification): string {
  const { rule } = n;
  const subject = n.entity?.key ? `${rule.metricLabel} for ${n.entity.key}` : rule.metricLabel;
  const value = formatValue(n.value, rule.unit);
  const hasThreshold = typeof rule.threshold === 'number' && Number.isFinite(rule.threshold);
  const threshold = hasThreshold ? formatValue(rule.threshold, rule.unit) : null;
  const windowText = formatWindow(rule.windowMinutes);

  if (n.kind === 'resolved') {
    return `${subject} is back to ${value} over the last ${windowText}.`;
  }
  switch (rule.mode) {
    case 'baseline': {
      const base = n.baseline !== null && n.baseline !== undefined ? ` against a baseline of ${formatValue(n.baseline, rule.unit)}` : '';
      return `${subject} is ${value}${base} over the last ${windowText}, outside its normal range.`;
    }
    case 'absence':
      return `${subject} received no data over the last ${windowText}, although data is normally expected.`;
    case 'slo_burn': {
      const burn = threshold ? ` (burn threshold ${threshold})` : '';
      return `${subject} is burning its error budget too fast: ${value}${burn} over the last ${windowText}.`;
    }
    default:
      return threshold
        ? `${subject} is ${value} over the last ${windowText} (condition: ${operatorSymbol(rule.operator)} ${threshold}).`
        : `${subject} is ${value} over the last ${windowText}.`;
  }
}
