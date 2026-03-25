/**
 * OTLP → Internal Model Mapper
 *
 * Converts OTLP/HTTP JSON ExportTraceServiceRequest payloads into the internal
 * IAgentTracingSession + IAgentTracingEvent models used by the database layer.
 *
 * Supports both Cognipeer agent-sdk traces (identified by `cognipeer.*` attributes)
 * and generic third-party OpenTelemetry traces.
 */

import { createLogger } from '@/lib/core/logger';
import type {
  IAgentTracingSession,
  IAgentTracingEvent,
} from '@/lib/database/provider/types.base';

const logger = createLogger('otlp-mapper');

// ─── OTLP JSON Type Definitions ────────────────────────────────────────────

export interface OtlpKeyValue {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: { values?: OtlpAnyValue[] };
  };
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  kvlistValue?: { values?: OtlpKeyValue[] };
  arrayValue?: { values?: OtlpAnyValue[] };
}

export interface OtlpSpanEvent {
  timeUnixNano?: string;
  name?: string;
  attributes?: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpKeyValue[];
  status?: {
    code?: number;
    message?: string;
  };
  events?: OtlpSpanEvent[];
  links?: unknown[];
}

export interface OtlpScopeSpans {
  scope?: {
    name?: string;
    version?: string;
  };
  spans?: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource?: {
    attributes?: OtlpKeyValue[];
  };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpExportTraceServiceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read string attribute from OTel attribute array */
function getStringAttr(attrs: OtlpKeyValue[] | undefined, key: string): string | undefined {
  const found = attrs?.find((a) => a.key === key);
  return found?.value?.stringValue ?? undefined;
}

/** Read integer attribute (OTel ints are JSON strings) */
function getIntAttr(attrs: OtlpKeyValue[] | undefined, key: string): number | undefined {
  const found = attrs?.find((a) => a.key === key);
  if (found?.value?.intValue != null) return parseInt(found.value.intValue, 10);
  if (found?.value?.doubleValue != null) return Math.round(found.value.doubleValue);
  return undefined;
}

/** Read double attribute */
function getDoubleAttr(attrs: OtlpKeyValue[] | undefined, key: string): number | undefined {
  const found = attrs?.find((a) => a.key === key);
  if (found?.value?.doubleValue != null) return found.value.doubleValue;
  if (found?.value?.intValue != null) return parseFloat(found.value.intValue);
  return undefined;
}

/** Convert nanosecond timestamp string to Date */
function nanoToDate(nanoStr?: string): Date | undefined {
  if (!nanoStr) return undefined;
  const ms = Math.floor(parseInt(nanoStr, 10) / 1_000_000);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms);
}

/** Convert OTel StatusCode to internal status string */
function otlpStatusToString(code?: number): string {
  switch (code) {
    case 2: return 'error';
    case 1: return 'success';
    default: return 'success'; // UNSET maps to success
  }
}

/** Check if a span is a Cognipeer root session span */
function isCognipeerRootSpan(span: OtlpSpan): boolean {
  const eventType = getStringAttr(span.attributes, 'cognipeer.event.type');
  const sessionId = getStringAttr(span.attributes, 'cognipeer.session.id');
  // Root if: name starts with agent_session OR has cognipeer.session.id, AND no parent
  if (!span.parentSpanId && sessionId) return true;
  if (span.name?.startsWith('agent_session')) return true;
  // Root if no parent and no event type (means it's not an individual event)
  if (!span.parentSpanId && !eventType) return true;
  return false;
}

// ─── Main Mapper ────────────────────────────────────────────────────────────

export interface OtlpMappedResult {
  sessions: Array<Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>>;
  events: Array<Omit<IAgentTracingEvent, '_id' | 'createdAt'>>;
}

function hasRealRootSpan(spans: OtlpSpan[]): boolean {
  return spans.some((span) => !span.parentSpanId);
}

/**
 * Map an OTLP ExportTraceServiceRequest to internal sessions and events.
 *
 * Strategy:
 * 1. Group all spans by traceId
 * 2. For each trace, find the root span (no parentSpanId) → session
 * 3. All other spans → events
 * 4. Extract Cognipeer-specific attributes when available
 * 5. For generic OTel traces, derive session info from resource + root span
 */
export function mapOtlpToInternalModels(
  request: OtlpExportTraceServiceRequest,
  tenantId: string,
  projectId?: string
): OtlpMappedResult {
  const sessions: OtlpMappedResult['sessions'] = [];
  const events: OtlpMappedResult['events'] = [];

  if (!request.resourceSpans?.length) {
    return { sessions, events };
  }

  // Collect all spans grouped by traceId, with resource context
  const traceMap = new Map<string, { spans: OtlpSpan[]; resourceAttrs: OtlpKeyValue[] }>();

  for (const rs of request.resourceSpans) {
    const resourceAttrs = rs.resource?.attributes || [];
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        if (!span.traceId) continue;
        let entry = traceMap.get(span.traceId);
        if (!entry) {
          entry = { spans: [], resourceAttrs };
          traceMap.set(span.traceId, entry);
        }
        entry.spans.push(span);
      }
    }
  }

  // Process each trace
  for (const [traceId, { spans, resourceAttrs }] of traceMap) {
    // Find root span — prioritize Cognipeer root, then any span without parent, then longest span
    let rootSpan = spans.find((s) => isCognipeerRootSpan(s));
    if (!rootSpan) {
      rootSpan = spans.find((s) => !s.parentSpanId);
    }
    if (!rootSpan) {
      // Fallback: longest duration span
      rootSpan = spans.reduce((longest, s) => {
        const sDur = (parseInt(s.endTimeUnixNano || '0', 10) - parseInt(s.startTimeUnixNano || '0', 10));
        const lDur = (parseInt(longest.endTimeUnixNano || '0', 10) - parseInt(longest.startTimeUnixNano || '0', 10));
        return sDur > lDur ? s : longest;
      }, spans[0]);
    }

    if (!rootSpan) continue;

    const realRootExists = hasRealRootSpan(spans);

    // Extract session info from resource + root span attributes
    const serviceName = getStringAttr(resourceAttrs, 'service.name');
    const serviceVersion = getStringAttr(resourceAttrs, 'service.version');
    const sessionId = getStringAttr(resourceAttrs, 'cognipeer.session.id')
      || getStringAttr(rootSpan.attributes, 'cognipeer.session.id')
      || `otlp_${traceId.slice(0, 16)}`;
    const threadId = getStringAttr(resourceAttrs, 'cognipeer.thread.id')
      || getStringAttr(rootSpan.attributes, 'cognipeer.thread.id');
    const agentModel = getStringAttr(resourceAttrs, 'cognipeer.agent.model');
    const agentProvider = getStringAttr(resourceAttrs, 'cognipeer.agent.provider');

    const startedAt = nanoToDate(rootSpan.startTimeUnixNano);
    const endedAt = nanoToDate(rootSpan.endTimeUnixNano);
    const durationMs = startedAt && endedAt
      ? endedAt.getTime() - startedAt.getTime()
      : getDoubleAttr(rootSpan.attributes, 'cognipeer.session.duration_ms');

    const status = otlpStatusToString(rootSpan.status?.code);

    // Aggregate tokens from child spans
    let totalInputTokens = getIntAttr(rootSpan.attributes, 'cognipeer.session.total_input_tokens') ?? 0;
    let totalOutputTokens = getIntAttr(rootSpan.attributes, 'cognipeer.session.total_output_tokens') ?? 0;
    let totalCachedInputTokens = getIntAttr(rootSpan.attributes, 'cognipeer.session.total_cached_input_tokens') ?? 0;
    let totalBytesIn = getIntAttr(rootSpan.attributes, 'cognipeer.session.total_bytes_in') ?? 0;
    let totalBytesOut = getIntAttr(rootSpan.attributes, 'cognipeer.session.total_bytes_out') ?? 0;

    const modelsUsed = new Set<string>();
    const toolsUsed = new Set<string>();
    const eventCounts: Record<string, number> = {};
    const errors: Array<Record<string, unknown>> = [];

    // Child spans → events
    // Important for incremental OTLP processors (e.g. SimpleSpanProcessor):
    // if a payload arrives without a true root span, treat every span as an event
    // so we don't lose child spans that are exported before their parent/root.
    const childSpans = realRootExists
      ? spans.filter((s) => s !== rootSpan)
      : spans;
    let sequence = 0;

    for (const span of childSpans) {
      sequence++;
      const eventType = getStringAttr(span.attributes, 'cognipeer.event.type') || deriveEventType(span);
      const model = getStringAttr(span.attributes, 'cognipeer.model');
      const toolName = getStringAttr(span.attributes, 'cognipeer.actor.name');
      const actorScope = getStringAttr(span.attributes, 'cognipeer.actor.scope');
      const actorRole = getStringAttr(span.attributes, 'cognipeer.actor.role');
      const inputTokens = getIntAttr(span.attributes, 'cognipeer.tokens.input');
      const outputTokens = getIntAttr(span.attributes, 'cognipeer.tokens.output');
      const totalTokens = getIntAttr(span.attributes, 'cognipeer.tokens.total');
      const cachedInputTokens = getIntAttr(span.attributes, 'cognipeer.tokens.cached_input');
      const requestBytes = getIntAttr(span.attributes, 'cognipeer.bytes.request');
      const responseBytes = getIntAttr(span.attributes, 'cognipeer.bytes.response');
      const toolExecutionId = getStringAttr(span.attributes, 'cognipeer.tool.execution_id');
      const sectionsJson = getStringAttr(span.attributes, 'cognipeer.sections');
      const eventId = getStringAttr(span.attributes, 'cognipeer.event.id') || span.spanId;

      // Aggregate for session totals (only if session-level totals weren't pre-set)
      if (totalInputTokens === 0 && inputTokens) totalInputTokens += inputTokens;
      if (totalOutputTokens === 0 && outputTokens) totalOutputTokens += outputTokens;
      if (totalCachedInputTokens === 0 && cachedInputTokens) totalCachedInputTokens += cachedInputTokens;
      if (totalBytesIn === 0 && requestBytes) totalBytesIn += requestBytes;
      if (totalBytesOut === 0 && responseBytes) totalBytesOut += responseBytes;

      if (model) modelsUsed.add(model);
      if (actorScope === 'tool' && toolName) toolsUsed.add(toolName);
      eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;

      // Parse sections if available, or synthesize from span data
      let sections: Array<Record<string, unknown>> | undefined;
      if (sectionsJson) {
        try {
          sections = JSON.parse(sectionsJson);
        } catch {
          logger.warn('Failed to parse cognipeer.sections attribute', { spanId: span.spanId });
        }
      }

      // Synthesize sections from span attributes when cognipeer.sections is absent
      if (!sections || sections.length === 0) {
        sections = buildSectionsFromSpan(span, eventType);
      }

      const eventStartedAt = nanoToDate(span.startTimeUnixNano);
      const eventEndedAt = nanoToDate(span.endTimeUnixNano);
      const eventDurationMs = eventStartedAt && eventEndedAt
        ? eventEndedAt.getTime() - eventStartedAt.getTime()
        : undefined;

      const eventStatus = otlpStatusToString(span.status?.code);

      // Extract errors from span events
      let eventError: Record<string, unknown> | undefined;
      if (span.events) {
        for (const evt of span.events) {
          if (evt.name === 'exception') {
            eventError = {
              message: getStringAttr(evt.attributes, 'exception.message') || 'Unknown error',
              stack: getStringAttr(evt.attributes, 'exception.stacktrace'),
              type: getStringAttr(evt.attributes, 'exception.type'),
            };
            break;
          }
        }
      }

      if (eventStatus === 'error') {
        errors.push({
          eventId,
          message: eventError?.message || span.status?.message || 'Unknown error',
          type: eventType,
          timestamp: eventStartedAt?.toISOString(),
        });
      }

      events.push({
        sessionId,
        traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId || rootSpan.spanId,
        tenantId,
        projectId,
        id: eventId,
        type: eventType,
        label: getStringAttr(span.attributes, 'cognipeer.event.label') || span.name || eventType,
        sequence,
        timestamp: eventStartedAt,
        status: eventStatus,
        actor: actorScope ? { scope: actorScope, name: toolName, role: actorRole } : undefined,
        sections,
        model,
        durationMs: eventDurationMs,
        actorName: toolName || (actorScope === 'agent' ? serviceName : undefined),
        actorRole: actorRole || actorScope,
        toolName: actorScope === 'tool' ? toolName : undefined,
        toolExecutionId,
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens,
        requestBytes,
        responseBytes,
        error: eventError,
      });
    }

    // Extract root span errors
    if (rootSpan.events) {
      for (const evt of rootSpan.events) {
        if (evt.name === 'exception') {
          errors.push({
            eventId: 'session',
            message: getStringAttr(evt.attributes, 'exception.message') || 'Unknown error',
            stack: getStringAttr(evt.attributes, 'exception.stacktrace'),
            type: getStringAttr(evt.attributes, 'exception.type'),
            timestamp: nanoToDate(evt.timeUnixNano)?.toISOString(),
          });
        }
      }
    }

    sessions.push({
      sessionId,
      traceId,
      rootSpanId: rootSpan.spanId,
      threadId,
      tenantId,
      projectId,
      source: 'otlp',
      agent: {
        name: serviceName,
        version: serviceVersion,
        model: agentModel,
        provider: agentProvider,
      },
      agentName: serviceName,
      agentVersion: serviceVersion,
      agentModel,
      status,
      startedAt,
      endedAt,
      durationMs,
      errors,
      modelsUsed: [...modelsUsed],
      toolsUsed: [...toolsUsed],
      eventCounts,
      totalEvents: childSpans.length,
      totalInputTokens,
      totalOutputTokens,
      totalCachedInputTokens,
      totalBytesIn,
      totalBytesOut,
    });
  }

  logger.info('Mapped OTLP traces', {
    resourceSpanCount: request.resourceSpans?.length,
    sessionCount: sessions.length,
    eventCount: events.length,
  });

  return { sessions, events };
}

// ─── Section Synthesis ──────────────────────────────────────────────────────

/**
 * Build sections from span attributes when `cognipeer.sections` is absent.
 * Mirrors the section structure used by agent-sdk custom tracing:
 *   - kind: "message" | "tool_call" | "tool_result" | "metadata"
 *   - label, content, role, tool
 *
 * Uses standard OTel semantic conventions (gen_ai.*) and common patterns
 * to extract meaningful input/output data from generic spans.
 */
function buildSectionsFromSpan(
  span: OtlpSpan,
  eventType: string
): Array<Record<string, unknown>> | undefined {
  const sections: Array<Record<string, unknown>>[] = [];
  const attrs = span.attributes || [];

  // ── 1. Extract gen_ai.* semantic convention content ───────────
  //    gen_ai.prompt.0.content, gen_ai.prompt.0.role, gen_ai.completion.0.content, etc.
  const prompts = extractGenAiMessages(attrs, 'gen_ai.prompt');
  const completions = extractGenAiMessages(attrs, 'gen_ai.completion');

  if (prompts.length > 0) {
    for (const msg of prompts) {
      sections.push([{
        kind: 'message',
        label: buildMessageLabel(msg.role || 'user', msg.index),
        role: msg.role || 'user',
        content: msg.content,
      }]);
    }
  }

  if (completions.length > 0) {
    for (const msg of completions) {
      sections.push([{
        kind: 'message',
        label: buildMessageLabel(msg.role || 'assistant', msg.index),
        role: msg.role || 'assistant',
        content: msg.content,
      }]);
    }
  }

  // ── 2. Generic input/output attributes ────────────────────────
  const inputContent = getStringAttr(attrs, 'input')
    || getStringAttr(attrs, 'cognipeer.input')
    || getStringAttr(attrs, 'llm.input')
    || getStringAttr(attrs, 'ai.input');
  const outputContent = getStringAttr(attrs, 'output')
    || getStringAttr(attrs, 'cognipeer.output')
    || getStringAttr(attrs, 'llm.output')
    || getStringAttr(attrs, 'ai.output');

  if (inputContent && prompts.length === 0) {
    const label = eventType === 'tool_call' ? 'Tool Input' : 'Input';
    const kind = eventType === 'tool_call' ? 'tool_call' : 'message';
    sections.push([{
      kind,
      label,
      role: eventType === 'tool_call' ? undefined : 'user',
      content: inputContent,
    }]);
  }

  if (outputContent && completions.length === 0) {
    const label = eventType === 'tool_call' ? 'Tool Result' : 'Output';
    const kind = eventType === 'tool_call' ? 'tool_result' : 'message';
    sections.push([{
      kind,
      label,
      role: eventType === 'tool_call' ? undefined : 'assistant',
      content: outputContent,
    }]);
  }

  // ── 3. Tool-specific attributes ───────────────────────────────
  if (eventType === 'tool_call') {
    const toolArgs = getStringAttr(attrs, 'tool.args')
      || getStringAttr(attrs, 'cognipeer.tool.args')
      || getStringAttr(attrs, 'tool.parameters');
    const toolResult = getStringAttr(attrs, 'tool.result')
      || getStringAttr(attrs, 'cognipeer.tool.result')
      || getStringAttr(attrs, 'tool.output');

    if (toolArgs && !inputContent) {
      sections.push([{
        kind: 'tool_call',
        label: 'Tool Arguments',
        content: toolArgs,
      }]);
    }
    if (toolResult && !outputContent) {
      sections.push([{
        kind: 'tool_result',
        label: 'Tool Result',
        content: toolResult,
      }]);
    }
  }

  // ── 4. Non-cognipeer attributes as metadata section ────────────
  //    If no content sections were created, show raw span attributes as metadata
  const flat = sections.flat();
  if (flat.length === 0) {
    const userAttrs: Record<string, string> = {};
    for (const kv of attrs) {
      if (kv.key.startsWith('cognipeer.')) continue; // already extracted
      const val = kv.value.stringValue
        ?? (kv.value.intValue != null ? kv.value.intValue : undefined)
        ?? (kv.value.doubleValue != null ? String(kv.value.doubleValue) : undefined)
        ?? (kv.value.boolValue != null ? String(kv.value.boolValue) : undefined);
      if (val !== undefined) userAttrs[kv.key] = String(val);
    }

    if (Object.keys(userAttrs).length > 0) {
      flat.push({
        kind: 'metadata',
        label: 'Span Attributes',
        content: JSON.stringify(userAttrs, null, 2),
      });
    }

    // At minimum show the span name
    if (flat.length === 0 && span.name) {
      flat.push({
        kind: 'metadata',
        label: 'Span',
        content: span.name,
      });
    }

    return flat.length > 0 ? flat : undefined;
  }

  return flat;
}

/** Build a label for a message section, e.g. "User Message", "Assistant Message #2" */
function buildMessageLabel(role: string, index: number): string {
  const normalized = role.trim() || 'message';
  const base = `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} Message`;
  return index > 1 ? `${base} #${index}` : base;
}

/**
 * Extract gen_ai.prompt.N.content / gen_ai.prompt.N.role style attributes.
 * Returns array of { content, role, index } ordered by index.
 */
function extractGenAiMessages(
  attrs: OtlpKeyValue[],
  prefix: string
): Array<{ content: string; role?: string; index: number }> {
  const map = new Map<number, { content?: string; role?: string }>();

  for (const kv of attrs) {
    if (!kv.key.startsWith(prefix + '.')) continue;
    const rest = kv.key.slice(prefix.length + 1); // "0.content" or "0.role"
    const dotIdx = rest.indexOf('.');
    if (dotIdx < 0) continue;
    const idx = parseInt(rest.slice(0, dotIdx), 10);
    if (Number.isNaN(idx)) continue;
    const field = rest.slice(dotIdx + 1);

    let entry = map.get(idx);
    if (!entry) { entry = {}; map.set(idx, entry); }

    const val = kv.value.stringValue;
    if (field === 'content' && val) entry.content = val;
    if (field === 'role' && val) entry.role = val;
  }

  return [...map.entries()]
    .filter(([, v]) => v.content)
    .sort(([a], [b]) => a - b)
    .map(([idx, v]) => ({ content: v.content!, role: v.role, index: idx + 1 }));
}

/**
 * Derive an event type from a generic OTel span (no cognipeer.* attributes).
 * Heuristic based on span name and kind.
 */
function deriveEventType(span: OtlpSpan): string {
  const name = (span.name || '').toLowerCase();

  // Common LLM/AI patterns
  if (name.includes('llm') || name.includes('chat') || name.includes('completion') || name.includes('generate')) {
    return 'ai_call';
  }
  if (name.includes('tool') || name.includes('function_call')) {
    return 'tool_call';
  }
  if (name.includes('embed')) {
    return 'embedding';
  }
  if (name.includes('retriev') || name.includes('search') || name.includes('query')) {
    return 'retrieval';
  }
  if (name.includes('summar')) {
    return 'summarization';
  }

  // Kind-based fallback: CLIENT spans are likely outgoing API calls
  if (span.kind === 3) return 'ai_call'; // CLIENT
  if (span.kind === 2) return 'server'; // SERVER

  return 'span'; // generic
}
