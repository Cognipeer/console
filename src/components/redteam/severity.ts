/**
 * One severity / outcome / status palette for every red-team screen, so a
 * "high" finding looks the same in the probe picker, the scan table, the
 * overview and the compare panel.
 *
 * `badge` is the design-system class, `color` the Mantine colour name.
 */

import type { RedTeamOutcome, RedTeamRunStatus, RedTeamSeverity } from './types';

export const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const SEVERITY_COLOR: Record<string, string> = {
  critical: 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'gray',
};

export const SEVERITY_BADGE: Record<string, string> = {
  critical: 'ds-badge-err',
  high: 'ds-badge-warn',
  medium: 'ds-badge-info',
  low: 'ds-badge',
};

export function severityBadgeClass(severity: RedTeamSeverity | string): string {
  return `ds-badge ${SEVERITY_BADGE[severity] ?? ''}`.trim();
}

export const OUTCOME_BADGE: Record<RedTeamOutcome, string> = {
  safe: 'ds-badge-teal',
  vulnerable: 'ds-badge-err',
  needs_review: 'ds-badge-warn',
};

export const OUTCOME_COLOR: Record<string, string> = { safe: 'teal', vulnerable: 'red', needs_review: 'yellow' };

export const RUN_STATUS_BADGE: Record<RedTeamRunStatus, string> = {
  completed: 'ds-badge-teal',
  running: 'ds-badge-info',
  failed: 'ds-badge-err',
  pending: 'ds-badge',
  cancelled: 'ds-badge-warn',
};

export function runStatusBadgeClass(status: string): string {
  return `ds-badge ${RUN_STATUS_BADGE[status as RedTeamRunStatus] ?? ''}`.trim();
}
