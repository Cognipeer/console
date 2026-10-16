/**
 * `buildNotificationMessage`: one channel-neutral rendering of an alert
 * notification, used by Slack, Teams and any channel without a bespoke layout.
 */

import {
  describeBreach,
  entityLabel,
  formatDuration,
  formatTimestamp,
  formatValue,
  formatVersionChange,
  formatWindow,
  operatorSymbol,
  severityLabel,
  truncate,
} from './format';
import type { AlertNotification, ChannelMessage } from './types';

const MAX_ERROR_SIGNATURES = 3;

function titleFor(n: AlertNotification): string {
  const name = n.rule.name;
  switch (n.kind) {
    case 'resolved':
      return `Resolved: ${name}`;
    case 'renotify':
      return `[${severityLabel(n.severity)}] Still firing: ${name}`;
    case 'test':
      return `Test notification: ${name}`;
    default:
      return `[${severityLabel(n.severity)}] ${name}`;
  }
}

export function buildNotificationMessage(n: AlertNotification): ChannelMessage {
  const fields: ChannelMessage['fields'] = [];
  const { rule } = n;
  const entity = entityLabel(n);

  if (n.projectName) fields.push({ label: 'Project', value: n.projectName });
  fields.push({ label: 'Metric', value: rule.metricLabel });
  if (entity) fields.push({ label: 'Entity', value: entity });
  fields.push({ label: n.kind === 'resolved' ? 'Value now' : 'Value', value: formatValue(n.value, rule.unit) });

  if (rule.mode === 'threshold' && typeof rule.threshold === 'number') {
    fields.push({ label: 'Condition', value: `${operatorSymbol(rule.operator)} ${formatValue(rule.threshold, rule.unit)}` });
  } else if (n.baseline !== null && n.baseline !== undefined) {
    fields.push({ label: 'Baseline', value: formatValue(n.baseline, rule.unit) });
  } else {
    fields.push({ label: 'Condition', value: rule.mode.replace('_', ' ') });
  }
  fields.push({ label: 'Window', value: formatWindow(rule.windowMinutes) });
  fields.push({ label: 'Fired at', value: formatTimestamp(n.firedAt) });
  if (n.kind === 'resolved' && n.resolvedAt) {
    fields.push({ label: 'Resolved at', value: formatTimestamp(n.resolvedAt) });
    fields.push({ label: 'Duration', value: formatDuration(new Date(n.firedAt).getTime(), new Date(n.resolvedAt).getTime()) });
  }

  const version = formatVersionChange(n.context?.versionChange, n.firedAt);
  if (version) fields.push({ label: 'Version change', value: version });
  const signatures = (n.context?.errorSignatures ?? []).slice(0, MAX_ERROR_SIGNATURES);
  if (signatures.length > 0 && n.kind !== 'resolved') {
    fields.push({
      label: signatures.length === 1 ? 'Top error' : 'Top errors',
      value: signatures.map((s) => `${truncate(s.message, 160)} (${s.count}x)`).join('\n'),
    });
  }

  const url = n.incidentUrl || n.entityUrl || n.dashboardUrl || undefined;
  return {
    title: titleFor(n),
    summary: describeBreach(n),
    severity: n.kind === 'resolved' ? 'ok' : n.severity,
    fields,
    ...(url ? { url, urlLabel: n.incidentUrl ? 'View incident' : 'Open in Cognipeer Console' } : {}),
    footer: [n.companyName, 'Cognipeer Console'].filter(Boolean).join(' · '),
  };
}
