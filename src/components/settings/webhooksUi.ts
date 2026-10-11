/**
 * The pure parts of the Agents → Webhooks screens: how a subscription's event
 * list is shown and edited (exact types and `group.*` patterns), the wire types,
 * and the labels derived from an endpoint. No React.
 */

import { eventMatches, patternMatches } from '@/lib/services/webhooks/webhookEvents';

export interface WebhookEventType {
  type: string;
  group: string;
}

export interface WebhookEndpointRow {
  id: string;
  url: string;
  /** The address is shown without its query string and userinfo: the caller may read webhooks, not change them. */
  urlRedacted?: boolean;
  description: string | null;
  events: string[];
  /** null = every project. */
  projectId: string | null;
  status: 'active' | 'disabled';
  disabledReason: 'manual' | 'redirect' | 'blocked_address' | 'sustained_failure' | null;
  failingSince: string | null;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WebhookDeliveryRow {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  createdAt: string;
  deliveredAt: string | null;
}

/**
 * What the policy engine says the person may do on this page (`capabilities` of the list response): the controls
 * the page shows come from it, never from a role. `manage`: change webhooks in this project. `workspaceScope`: ...
 * and an endpoint for every project. A server that does not say (an older one) shows the controls and lets its
 * own checks refuse; the "every project" choice then stays hidden.
 */
export interface WebhookCapabilities {
  manage: boolean;
  workspaceScope: boolean;
}

export function parseWebhookCapabilities(body: unknown): WebhookCapabilities {
  const raw = body && typeof body === 'object' ? (body as { capabilities?: unknown }).capabilities : undefined;
  if (!raw || typeof raw !== 'object') return { manage: true, workspaceScope: false };
  const { manage, workspaceScope } = raw as { manage?: unknown; workspaceScope?: unknown };
  return { manage: manage === true, workspaceScope: workspaceScope === true };
}

/** `session.idled` → `session_idled`: the i18n key (a dot would read as a path). */
export function eventLabelKey(type: string): string {
  return type.replace(/\./g, '_');
}

export const groupPattern = (group: string) => `${group}.*`;

/** Events of one group, in catalog order. */
export function groupEvents(catalog: readonly WebhookEventType[], group: string): string[] {
  return catalog.filter((event) => event.group === group).map((event) => event.type);
}

/** Group ids in catalog order. */
export function eventGroups(catalog: readonly WebhookEventType[]): string[] {
  return [...new Set(catalog.map((event) => event.group))];
}

/** Is the event covered by the current selection (by its own entry or a pattern)? */
export function isEventSelected(selection: readonly string[], type: string): boolean {
  return eventMatches(selection, type);
}

/** Is every event of the group covered? */
export function isGroupSelected(selection: readonly string[], catalog: readonly WebhookEventType[], group: string): boolean {
  const types = groupEvents(catalog, group);
  return types.length > 0 && types.every((type) => isEventSelected(selection, type));
}

/**
 * Ticks / unticks one event. Unticking an event that a pattern covers first
 * expands that pattern into its group's exact types, so only the one event
 * goes. Ticking the last missing event of a group does not collapse to a
 * pattern: that is what the group checkbox is for.
 */
export function toggleEvent(selection: readonly string[], catalog: readonly WebhookEventType[], type: string): string[] {
  if (!isEventSelected(selection, type)) return [...selection, type];
  const next: string[] = [];
  for (const entry of selection) {
    if (entry === type) continue;
    if (entry === '*' || (entry.endsWith('.*') && patternMatches(entry, type))) {
      for (const known of catalog) {
        if (known.type !== type && patternMatches(entry, known.type) && !next.includes(known.type)) next.push(known.type);
      }
      continue;
    }
    if (!next.includes(entry)) next.push(entry);
  }
  return next;
}

/** Ticks / unticks a whole group: it becomes its `group.*` pattern, or loses every entry that is in the group. */
export function toggleGroup(selection: readonly string[], catalog: readonly WebhookEventType[], group: string): string[] {
  const pattern = groupPattern(group);
  const inGroup = (entry: string) => entry === pattern || patternMatches(pattern, entry);
  if (isGroupSelected(selection, catalog, group)) {
    let next = [...selection];
    for (const type of groupEvents(catalog, group)) {
      if (isEventSelected(next, type)) next = toggleEvent(next, catalog, type);
    }
    return next.filter((entry) => !inGroup(entry));
  }
  return [...selection.filter((entry) => !inGroup(entry)), pattern];
}

/** What the list shows for an endpoint's events: the first few, then a count. */
export function summarizeEvents(events: readonly string[], limit = 2): { shown: string[]; more: number; all: boolean } {
  if (events.includes('*')) return { shown: [], more: 0, all: true };
  return { shown: events.slice(0, limit), more: Math.max(0, events.length - limit), all: false };
}

/** The scope column. The list only holds this project's endpoints and tenant-wide ones. */
export function scopeOf(endpoint: Pick<WebhookEndpointRow, 'projectId'>): 'all' | 'project' {
  return endpoint.projectId === null ? 'all' : 'project';
}

/** An http(s) URL the form will accept (the server checks the address). */
export function isValidWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
