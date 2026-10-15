/**
 * One reading of a tracing session / thread status for every tracing page: which `StatusBadge` look it gets,
 * which words it is shown with and which values the status filters offer. Pure.
 */

import { statusVariant } from '@/lib/utils/tracingUtils';

/** Statuses the sessions and threads filters offer, besides "all". */
export const TRACING_STATUS_FILTER_VALUES = ['success', 'error', 'in_progress', 'abandoned'] as const;

export type TracingStatusFilterValue = (typeof TRACING_STATUS_FILTER_VALUES)[number];

/** The statuses whose label has a translation (`tracingHealth.status.<id>`). */
export const TRACING_STATUS_LABELED = [
  'success',
  'completed',
  'error',
  'failed',
  'in_progress',
  'abandoned',
  'partial',
  'cancelled',
  'paused',
  'unknown',
] as const;

export type TracingStatusLabelId = (typeof TRACING_STATUS_LABELED)[number];

/** `running` and `in-progress` are spellings of `in_progress`; a missing status is `unknown`. */
export function normalizeTracingStatus(status: string | null | undefined): string {
  const value = (status ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value === 'running' || value === 'in-progress') return 'in_progress';
  if (value === 'canceled') return 'cancelled';
  return value;
}

/** Whether the value is one the status filters offer. */
export function isTracingStatusFilterValue(value: string | null | undefined): value is TracingStatusFilterValue {
  return TRACING_STATUS_FILTER_VALUES.includes(value as TracingStatusFilterValue);
}

/** The `StatusBadge` look: a run in flight reads as running, a quiet one as a warning, an unknown one as paused. */
export function tracingStatusBadgeKey(status: string | null | undefined): 'ok' | 'err' | 'warn' | 'info' | 'running' | 'paused' {
  const value = normalizeTracingStatus(status);
  if (value === 'in_progress') return 'running';
  if (value === 'unknown' || value === 'paused' || value === 'cancelled') return 'paused';
  if (value === 'partial') return 'warn';
  return statusVariant(value);
}

/** The id of the translated label of a status, or null for a status the vocabulary does not know. */
export function tracingStatusLabelId(status: string | null | undefined): TracingStatusLabelId | null {
  const value = normalizeTracingStatus(status);
  return (TRACING_STATUS_LABELED as readonly string[]).includes(value) ? (value as TracingStatusLabelId) : null;
}
