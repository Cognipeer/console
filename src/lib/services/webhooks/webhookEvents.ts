/**
 * The webhook event vocabulary (v1) and how a subscription's event list
 * matches it. Pure: no database, no queue.
 *
 * A subscription lists exact types (`session.idled`) and/or `prefix.*`
 * patterns (`agent_run.*`); `*` subscribes to everything. `webhook.test` is
 * only ever sent to the endpoint being tested, never published.
 */

export const WEBHOOK_TEST_EVENT = 'webhook.test';

export interface WebhookEventDefinition {
  type: string;
  /** UI grouping and the `prefix.*` family. */
  group: 'session' | 'action' | 'budget' | 'feedback' | 'agent_run' | 'schedule' | 'alert';
}

/** Every event type publishers emit today. The data of each is ids and small fields only. */
export const WEBHOOK_EVENT_CATALOG: readonly WebhookEventDefinition[] = [
  { type: 'session.idled', group: 'session' },
  { type: 'session.work_done', group: 'session' },
  { type: 'action.required', group: 'action' },
  { type: 'budget.reached', group: 'budget' },
  { type: 'feedback.recorded', group: 'feedback' },
  { type: 'agent_run.succeeded', group: 'agent_run' },
  { type: 'agent_run.failed', group: 'agent_run' },
  { type: 'agent_run.canceled', group: 'agent_run' },
  { type: 'agent_run.requires_action', group: 'agent_run' },
  { type: 'schedule.fired', group: 'schedule' },
  { type: 'schedule.failed', group: 'schedule' },
  { type: 'alert.fired', group: 'alert' },
  { type: 'alert.resolved', group: 'alert' },
];

const KNOWN_TYPES = new Set(WEBHOOK_EVENT_CATALOG.map((event) => event.type));

/** Does one subscription entry (exact type, `prefix.*` or `*`) cover `type`? */
export function patternMatches(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/** Does a subscription's event list cover `type`? */
export function eventMatches(patterns: readonly string[], type: string): boolean {
  return patterns.some((pattern) => patternMatches(pattern, type));
}

/** An entry is valid when it is a known type, `*`, or a pattern that matches at least one known type. */
export function isValidEventPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return WEBHOOK_EVENT_CATALOG.some((event) => patternMatches(pattern, event.type));
  return KNOWN_TYPES.has(pattern);
}

export type EventListResult = { ok: true; events: string[] } | { ok: false; message: string };

/** Validates and de-duplicates the `events` of a create / update request. */
export function normalizeEventList(value: unknown): EventListResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: 'events must be a non-empty array of event types' };
  }
  const events: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return { ok: false, message: 'events must contain only non-empty strings' };
    }
    const pattern = entry.trim();
    if (!isValidEventPattern(pattern)) {
      return { ok: false, message: `Unknown event type "${pattern}"` };
    }
    if (!events.includes(pattern)) events.push(pattern);
  }
  return { ok: true, events };
}
