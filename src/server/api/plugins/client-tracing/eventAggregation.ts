import type {
  IAgentTracingEvent,
} from '@/lib/database/provider/types.base';
import {
  toIso,
} from '@/lib/services/tracing/traceEntityMetrics';
import {
  isTruncatedFinishReason,
} from '@/lib/shared/finishReason';
import {
  countTraceErrors,
  isErrorTraceEvent,
} from '@/lib/shared/traceHealth';
import type { TracingSummaryPayload } from './payloadTypes';
import { getSummaryNumber, toNumber } from './recordCoerce';

/** Message of a failed event: its own error text, else its label. */
function eventErrorMessage(event: Pick<IAgentTracingEvent, 'error' | 'label'>): string {
  if (typeof event.error === 'string' && event.error) return event.error;
  const nested = event.error && typeof event.error === 'object'
    ? (event.error as Record<string, unknown>).message
    : undefined;
  if (typeof nested === 'string' && nested) return nested;
  return typeof event.label === 'string' ? event.label : 'Event error';
}

/**
 * Events that wrap other events. The SDK widens an iteration or an agent span to cover its children (the
 * wall-clock extent of the run), so adding their duration to the children's would count the same time twice.
 * (A sub-agent's own work is the other double count: see `delegatedEvents`.)
 */
const CONTAINER_EVENT_TYPES = new Set(['agent_iteration', 'span']);

/**
 * Delegated work: the delegation tool call (its duration is the child's whole run) and everything that runs
 * under a sub-agent span. A sub-agent span is the SDK's `span` event that hangs off a tool call; a `span` any
 * other client sends as a plain wrapper is not delegation. The run's duration is the parent's own model and
 * tool time, like the SDK's summary, so none of it adds to the total.
 */
function delegatedEvents(events: readonly IAgentTracingEvent[]): Set<IAgentTracingEvent> {
  const byId = new Map<string, IAgentTracingEvent>();
  for (const event of events) if (event.spanId) byId.set(event.spanId, event);
  const parentOf = (event: IAgentTracingEvent) => (event.parentSpanId ? byId.get(event.parentSpanId) : undefined);
  const delegated = new Set<IAgentTracingEvent>();
  const subagentSpans = new Set<IAgentTracingEvent>();
  for (const event of events) {
    if (event.type !== 'span') continue;
    const delegation = parentOf(event);
    if (delegation?.type !== 'tool_call') continue;
    subagentSpans.add(event);
    delegated.add(delegation);
  }
  if (subagentSpans.size === 0) return delegated;
  for (const event of events) {
    // Walk up the owner chain; the hop limit guards against a cycle in malformed input.
    let parent = parentOf(event);
    for (let hops = 0; parent && hops < 64; hops += 1) {
      if (subagentSpans.has(parent)) { delegated.add(event); break; }
      parent = parentOf(parent);
    }
  }
  return delegated;
}

export function aggregateEvents(events: IAgentTracingEvent[]) {
  const delegated = delegatedEvents(events);
  const eventCounts: Record<string, number> = {};
  const modelsUsed = new Set<string>();
  const toolsUsed = new Set<string>();
  const errors: Array<Record<string, unknown>> = [];

  let totalBytesIn = 0;
  let totalBytesOut = 0;
  let totalCachedInputTokens = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let truncatedEvents = 0;

  for (const event of events) {
    if (typeof event.type === 'string') {
      eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    }

    if (typeof event.model === 'string') {
      modelsUsed.add(event.model);
    }

    if (typeof event.toolName === 'string') {
      toolsUsed.add(event.toolName);
    }

    totalInputTokens += typeof event.inputTokens === 'number' ? event.inputTokens : 0;
    totalOutputTokens += typeof event.outputTokens === 'number' ? event.outputTokens : 0;
    totalCachedInputTokens += typeof event.cachedInputTokens === 'number' ? event.cachedInputTokens : 0;
    totalBytesIn += typeof event.requestBytes === 'number' ? event.requestBytes : 0;
    totalBytesOut += typeof event.responseBytes === 'number' ? event.responseBytes : 0;
    if (typeof event.durationMs === 'number' && !CONTAINER_EVENT_TYPES.has(String(event.type)) && !delegated.has(event)) {
      totalDurationMs += event.durationMs;
    }
    totalReasoningTokens += typeof event.reasoningTokens === 'number' ? event.reasoningTokens : 0;
    if (isTruncatedFinishReason(event.finishReason)) truncatedEvents += 1;

    if (isErrorTraceEvent(event)) {
      errors.push({
        eventId: typeof event.id === 'string' ? event.id : undefined,
        message: eventErrorMessage(event),
        timestamp: toIso(event.timestamp),
        type: typeof event.type === 'string' ? event.type : undefined,
      });
    }
  }

  const errorCounts = countTraceErrors(events);

  return {
    aiErrors: errorCounts.aiErrors,
    errorEvents: errorCounts.errorEvents,
    errors,
    eventCounts,
    modelsUsed: [...modelsUsed],
    toolsUsed: [...toolsUsed],
    totalBytesIn,
    totalBytesOut,
    totalCachedInputTokens,
    totalDurationMs,
    totalEvents: events.length,
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    toolErrors: errorCounts.toolErrors,
    truncatedEvents,
  };
}

/** Errors on a session payload that did not come from the SDK's tracing sink (sink failures are not run failures). */
export function countNonSinkErrors(errors: ReadonlyArray<Record<string, unknown>> | undefined): number {
  return (errors ?? []).filter((error) => error?.type !== 'sink').length;
}

/**
 * Largest value a running total has reached, across the incoming payload, the
 * session's own summary and its denormalized column. Session totals accumulate
 * over the life of a sessionId, so a later write must never shrink them.
 */
export function maxTotal(
  payloadSummary: unknown,
  sessionSummary: unknown,
  denormalized: number | undefined,
  key: keyof TracingSummaryPayload,
): number {
  const candidates = [
    getSummaryNumber(payloadSummary, key),
    getSummaryNumber(sessionSummary, key),
    toNumber(denormalized),
  ].filter((value): value is number => typeof value === 'number');

  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

export function mergeUnique(...lists: Array<string[] | undefined>): string[] {
  return Array.from(new Set(lists.flatMap((list) => list ?? [])));
}

/** Drops repeats so a retried `end` cannot grow the session's error list. */
export function dedupeErrors(errors: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();

  return errors.filter((error) => {
    const key = JSON.stringify(error);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
