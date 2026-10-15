/**
 * Trace error classification and session-status derivation — shared by every
 * tracing ingest path (OTLP, batch, stream, hosted-agent sink), the session
 * store and the entity health emitters, so one rule decides what an "error
 * event" is. Dependency-free: no `@/lib/database`, no node builtins.
 *
 * Event semantics (agent SDK): status is `success | error | skipped | retry`;
 * `skipped` (policy or cancellation) and `retry` are not errors. An event may
 * also carry an `error` object without a status. SQLite returns `{}` for an
 * empty error, so `error` is never tested for truthiness, only for content.
 */

export interface TraceEventLike {
  type?: unknown;
  status?: unknown;
  error?: unknown;
  model?: unknown;
  actor?: unknown;
}

export type TraceErrorKind = 'tool' | 'ai' | 'other';

export interface TraceErrorCounts {
  errorEvents: number;
  toolErrors: number;
  aiErrors: number;
  toolCalls: number;
  aiCalls: number;
}

const AI_EVENT_TYPES = new Set(['ai_call', 'summarization', 'reflection', 'embedding']);

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasErrorContent(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'string') return error.trim().length > 0;
  if (Array.isArray(error)) return error.length > 0;
  if (typeof error === 'object') return Object.keys(error as Record<string, unknown>).length > 0;
  return false;
}

function actorScope(actor: unknown): string {
  if (actor && typeof actor === 'object') {
    return normalized((actor as Record<string, unknown>).scope);
  }
  return '';
}

/** True when the event failed: status `error`/`failed`, or no status and a non-empty `error`. */
export function isErrorTraceEvent(event: TraceEventLike | null | undefined): boolean {
  if (!event) return false;
  const status = normalized(event.status);
  if (status) return status === 'error' || status === 'failed';
  return hasErrorContent(event.error);
}

/** Which kind of work an event represents: a tool call, an AI call (llm, summarization, reflection, embedding) or anything else. */
export function traceErrorKind(event: TraceEventLike | null | undefined): TraceErrorKind {
  if (!event) return 'other';
  const type = normalized(event.type);
  if (type === 'tool_call' || actorScope(event.actor) === 'tool') return 'tool';
  if (AI_EVENT_TYPES.has(type)) return 'ai';
  if (typeof event.model === 'string' && event.model.trim()) return 'ai';
  return 'other';
}

/**
 * Error and call counters for a set of events. Calls exclude `skipped` events
 * (they never ran), so `toolErrors / toolCalls` is a failure rate of executed
 * calls.
 */
export function countTraceErrors(events: ReadonlyArray<TraceEventLike> | null | undefined): TraceErrorCounts {
  const counts: TraceErrorCounts = { errorEvents: 0, toolErrors: 0, aiErrors: 0, toolCalls: 0, aiCalls: 0 };
  if (!events) return counts;
  for (const event of events) {
    if (!event) continue;
    const kind = traceErrorKind(event);
    const skipped = normalized(event.status) === 'skipped';
    if (kind === 'tool' && !skipped) counts.toolCalls += 1;
    else if (kind === 'ai' && !skipped) counts.aiCalls += 1;
    if (isErrorTraceEvent(event)) {
      counts.errorEvents += 1;
      if (kind === 'tool') counts.toolErrors += 1;
      else if (kind === 'ai') counts.aiErrors += 1;
    }
  }
  return counts;
}

export interface DeriveSessionStatusInput {
  /** Status explicitly supplied by the client (or the stored one on a re-derive). */
  clientStatus?: string | null;
  /** Error events counted from the session's events. */
  errorEvents: number;
  /** Errors reported on the session payload that did not come from the tracing sink itself. */
  nonSinkErrors: number;
  /** Whether the session has ended (root span finished, batch complete, `/end` received). */
  ended: boolean;
}

/** True when `clientStatus` is a usable client-supplied end status (the one `deriveSessionStatus` returns as-is). */
export function isExplicitClientStatus(clientStatus: string | null | undefined): boolean {
  const raw = typeof clientStatus === 'string' ? clientStatus.trim() : '';
  const lowered = raw.toLowerCase();
  return raw !== '' && lowered !== 'unknown' && lowered !== 'in_progress';
}

/**
 * Session status.
 *  - An explicit client status wins, so a recovered session the client calls
 *    `success` stays `success` (its error events are tracked by the counters).
 *  - `in_progress` is never overridden while the session has not ended.
 *  - Without a (usable) client status: not ended => `in_progress`; ended =>
 *    `error` when any error event or non-sink error exists, otherwise `success`.
 */
export function deriveSessionStatus(input: DeriveSessionStatusInput): string {
  const raw = typeof input.clientStatus === 'string' ? input.clientStatus.trim() : '';
  const lowered = raw.toLowerCase();

  if (!input.ended && lowered === 'in_progress') return 'in_progress';
  if (raw && lowered !== 'unknown' && lowered !== 'in_progress') return raw;

  if (!input.ended) return 'in_progress';
  return input.errorEvents > 0 || input.nonSinkErrors > 0 ? 'error' : 'success';
}
