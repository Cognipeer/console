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
import {
  buildResponseFormatSection,
  normalizeSectionListResponseFormat,
} from '@/lib/services/tracingResponseFormat';
import {
  buildToolDefinitionsSection,
  normalizeSectionListToolDefinitions,
} from '@/lib/services/tracingToolDefinitions';

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
  // Some instrumentations emit counts as strings.
  if (found?.value?.stringValue != null) {
    const parsed = Number(found.value.stringValue);
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  }
  return undefined;
}

/** First key that carries a string value. */
function firstStringAttr(attrs: OtlpKeyValue[] | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getStringAttr(attrs, key);
    if (value) return value;
  }
  return undefined;
}

/** First key that carries an integer value. */
function firstIntAttr(attrs: OtlpKeyValue[] | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = getIntAttr(attrs, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Read double attribute */
function getDoubleAttr(attrs: OtlpKeyValue[] | undefined, key: string): number | undefined {
  const found = attrs?.find((a) => a.key === key);
  if (found?.value?.doubleValue != null) return found.value.doubleValue;
  if (found?.value?.intValue != null) return parseFloat(found.value.intValue);
  return undefined;
}

function parseJsonRecord(value: string | undefined, logContext: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    logger.warn('Failed to parse JSON trace attribute', logContext);
    return undefined;
  }
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

// ─── Third-party GenAI semantic conventions ─────────────────────────────────
//
// Agent frameworks that are not instrumented by the Cognipeer SDK still reach
// this endpoint through one of three attribute conventions, and a customer
// usually cannot choose which:
//
//   * OpenInference (Arize/Phoenix) — `openinference.span.kind`, `llm.*`
//   * OTel GenAI semconv / OpenLLMetry >= 0.55 — `gen_ai.*` with JSON message
//     blobs, and the system prompt split out into `gen_ai.system_instructions`
//   * OpenLLMetry <= 0.54 — indexed `gen_ai.prompt.{i}.*` / `llm.request.*`
//
// A single span can carry two of them at once (an app running both an
// OpenInference instrumentor and a Traceloop one), so everything below reads
// by attribute presence and merges rather than picking a "winner".

/** OpenInference span kind → internal event type. */
const OPENINFERENCE_KIND_TO_EVENT: Record<string, string> = {
  LLM: 'ai_call',
  TOOL: 'tool_call',
  RETRIEVER: 'retrieval',
  EMBEDDING: 'embedding',
  RERANKER: 'retrieval',
  GUARDRAIL: 'guardrail',
  EVALUATOR: 'guardrail',
  AGENT: 'span',
  CHAIN: 'span',
};

/** OTel GenAI `gen_ai.operation.name` → internal event type. */
const GENAI_OPERATION_TO_EVENT: Record<string, string> = {
  chat: 'ai_call',
  text_completion: 'ai_call',
  generate_content: 'ai_call',
  embeddings: 'embedding',
  execute_tool: 'tool_call',
  invoke_agent: 'span',
  create_agent: 'span',
};

/** Instrumentations replace redacted values with this literal. */
const REDACTION_SENTINEL = '__REDACTED__';

function isUsableContent(value: string | undefined): value is string {
  return Boolean(value) && value !== REDACTION_SENTINEL;
}

/**
 * Group flat indexed attributes (`prefix.0.field`) into per-index records,
 * ordered by index. Both OpenInference and legacy OpenLLMetry encode lists
 * this way, and the keys arrive in arbitrary order.
 */
function groupIndexedAttrs(
  attrs: OtlpKeyValue[],
  prefix: string,
): Array<Record<string, string>> {
  const groups = new Map<number, Record<string, string>>();
  for (const kv of attrs) {
    if (!kv.key.startsWith(`${prefix}.`)) continue;
    const rest = kv.key.slice(prefix.length + 1);
    const dot = rest.indexOf('.');
    if (dot < 0) continue;
    const index = parseInt(rest.slice(0, dot), 10);
    if (Number.isNaN(index)) continue;
    const value = kv.value.stringValue
      ?? kv.value.intValue
      ?? (kv.value.doubleValue != null ? String(kv.value.doubleValue) : undefined)
      ?? (kv.value.boolValue != null ? String(kv.value.boolValue) : undefined);
    if (value === undefined) continue;
    const group = groups.get(index) ?? {};
    group[rest.slice(dot + 1)] = value;
    groups.set(index, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
}

/**
 * Parse a JSON-array attribute. Attribute values are subject to OTel's length
 * limit, so a long conversation can arrive truncated mid-JSON — a parse
 * failure must lose that one attribute, never the whole span.
 */
function parseJsonArrayAttr(attrs: OtlpKeyValue[], key: string): unknown[] {
  const raw = getStringAttr(attrs, key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.warn('Failed to parse JSON trace attribute', { attribute: key });
    return [];
  }
}

/** Model name across all three conventions. */
function getConventionModel(attrs: OtlpKeyValue[] | undefined): string | undefined {
  return firstStringAttr(attrs, [
    'cognipeer.model',
    'llm.model_name',
    'gen_ai.response.model',
    'gen_ai.request.model',
  ]);
}

/** Token counts across all three conventions. */
function getConventionTokens(attrs: OtlpKeyValue[] | undefined) {
  return {
    inputTokens: firstIntAttr(attrs, [
      'cognipeer.tokens.input',
      'llm.token_count.prompt',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.prompt_tokens',
    ]),
    outputTokens: firstIntAttr(attrs, [
      'cognipeer.tokens.output',
      'llm.token_count.completion',
      'gen_ai.usage.output_tokens',
      'gen_ai.usage.completion_tokens',
    ]),
    totalTokens: firstIntAttr(attrs, [
      'cognipeer.tokens.total',
      'llm.token_count.total',
      'gen_ai.usage.total_tokens',
    ]),
    // Deliberately excludes cache *write* / *creation* counts: those are a
    // different, separately-priced number, and the Console treats
    // cachedInputTokens as a subset of inputTokens.
    cachedInputTokens: firstIntAttr(attrs, [
      'cognipeer.tokens.cached_input',
      'llm.token_count.prompt_details.cache_read',
      'gen_ai.usage.cache_read.input_tokens',
      'gen_ai.usage.cache_read_input_tokens',
    ]),
  };
}

/** Conversation identifier — the closest thing OTel has to a thread id. */
function getConventionThreadId(attrs: OtlpKeyValue[] | undefined): string | undefined {
  return firstStringAttr(attrs, [
    'cognipeer.thread.id',
    'session.id',
    'gen_ai.conversation.id',
    'traceloop.association.properties.session_id',
  ]);
}

/** Tool name for a tool span. */
function getConventionToolName(attrs: OtlpKeyValue[] | undefined): string | undefined {
  return firstStringAttr(attrs, ['tool.name', 'gen_ai.tool.name', 'traceloop.entity.name']);
}

/**
 * Sections from OpenInference's indexed message attributes:
 * `llm.input_messages.{i}.message.role` / `.message.content`, with nested
 * `.message.tool_calls.{j}.tool_call.function.name` / `.arguments`.
 */
function buildOpenInferenceMessageSections(
  attrs: OtlpKeyValue[],
): Array<Record<string, unknown>> {
  const sections: Array<Record<string, unknown>> = [];

  for (const [prefix, fallbackRole] of [
    ['llm.input_messages', 'user'],
    ['llm.output_messages', 'assistant'],
  ] as const) {
    for (const message of groupIndexedAttrs(attrs, prefix)) {
      const role = message['message.role'] || fallbackRole;
      const content = message['message.content'];
      if (isUsableContent(content)) {
        sections.push({
          kind: 'message',
          label: buildMessageLabel(role, sections.length + 1),
          role,
          content,
        });
      }

      // Tool calls are nested one level deeper under the same message.
      const toolCalls = groupIndexedAttrs(
        Object.entries(message).map(([key, value]) => ({
          key,
          value: { stringValue: value },
        })),
        'message.tool_calls',
      );
      for (const call of toolCalls) {
        const name = call['tool_call.function.name'];
        if (!name) continue;
        sections.push({
          kind: 'tool_call',
          label: `Tool call: ${name}`,
          tool: name,
          content: call['tool_call.function.arguments'],
        });
      }
    }
  }

  return sections;
}

/**
 * Sections from the current OTel GenAI convention, where messages are whole
 * JSON documents: `[{role, parts: [{type, content|name|arguments|response}]}]`.
 *
 * The system prompt is NOT in `gen_ai.input.messages` — OpenLLMetry 0.55 moved
 * it to `gen_ai.system_instructions`. Reading only the former silently drops
 * it, which is exactly the part of the prompt that dominates token cost.
 */
function buildGenAiJsonSections(attrs: OtlpKeyValue[]): Array<Record<string, unknown>> {
  const sections: Array<Record<string, unknown>> = [];

  for (const instruction of parseJsonArrayAttr(attrs, 'gen_ai.system_instructions')) {
    const content = readPartContent(instruction);
    if (isUsableContent(content)) {
      sections.push({ kind: 'message', label: 'System message', role: 'system', content });
    }
  }

  for (const key of ['gen_ai.input.messages', 'gen_ai.output.messages']) {
    for (const entry of parseJsonArrayAttr(attrs, key)) {
      const message = entry as { role?: string; parts?: unknown[] };
      const role = typeof message?.role === 'string' ? message.role : 'user';
      for (const rawPart of message?.parts ?? []) {
        const part = rawPart as {
          type?: string;
          content?: unknown;
          name?: string;
          arguments?: unknown;
          id?: string;
          response?: unknown;
        };
        switch (part?.type) {
          case 'text':
          case 'reasoning':
          case 'refusal': {
            const content = readPartContent(part);
            if (isUsableContent(content)) {
              sections.push({
                kind: 'message',
                label: buildMessageLabel(role, sections.length + 1),
                role,
                content,
              });
            }
            break;
          }
          case 'tool_call':
            sections.push({
              kind: 'tool_call',
              label: `Tool call: ${part.name ?? 'tool'}`,
              tool: part.name,
              content:
                typeof part.arguments === 'string'
                  ? part.arguments
                  : JSON.stringify(part.arguments ?? {}),
            });
            break;
          case 'tool_call_response':
            sections.push({
              kind: 'tool_result',
              label: 'Tool result',
              tool: part.id,
              content:
                typeof part.response === 'string'
                  ? part.response
                  : JSON.stringify(part.response ?? null),
            });
            break;
          default:
            break;
        }
      }
    }
  }

  const toolResult = getStringAttr(attrs, 'gen_ai.tool.call.result');
  if (isUsableContent(toolResult)) {
    sections.push({ kind: 'tool_result', label: 'Tool result', content: toolResult });
  }

  return sections;
}

function readPartContent(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  const content = (part as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return undefined;
  return JSON.stringify(content);
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
    // Conversation grouping. Third-party instrumentations only emit this when
    // the application opted in (OpenInference `using_session`, OpenLLMetry
    // `set_association_properties`), and a child span often carries it while
    // the root does not — so every span in the trace is consulted.
    const threadId = getConventionThreadId(resourceAttrs)
      || getConventionThreadId(rootSpan.attributes)
      || spans.map((span) => getConventionThreadId(span.attributes)).find(Boolean);
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
      const model = getConventionModel(span.attributes);
      const conventionToolName = getConventionToolName(span.attributes);
      const toolName = getStringAttr(span.attributes, 'cognipeer.actor.name') || conventionToolName;
      const actorScope = getStringAttr(span.attributes, 'cognipeer.actor.scope')
        || (eventType === 'tool_call' && conventionToolName ? 'tool' : undefined);
      const actorRole = getStringAttr(span.attributes, 'cognipeer.actor.role');
      const {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens,
      } = getConventionTokens(span.attributes);
      const requestBytes = getIntAttr(span.attributes, 'cognipeer.bytes.request');
      const responseBytes = getIntAttr(span.attributes, 'cognipeer.bytes.response');
      const toolExecutionId = getStringAttr(span.attributes, 'cognipeer.tool.execution_id');
      const toolDetails = parseJsonRecord(
        getStringAttr(span.attributes, 'cognipeer.tool.details'),
        { attribute: 'cognipeer.tool.details', spanId: span.spanId },
      );
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
          // Same cap/shape treatment tool_definitions and response_format
          // sections get on every other ingestion path.
          if (Array.isArray(sections)) {
            sections = normalizeSectionListResponseFormat(normalizeSectionListToolDefinitions(sections));
          }
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
        metadata: toolDetails ? { toolDetails } : undefined,
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
 *   - kind: "tool_definitions" — the tool menu offered to the model on THIS
 *     call (per-event, never per-session — the menu can change between
 *     turns); contract in tracingToolDefinitions.ts
 *   - kind: "response_format" — the structured-output contract enforced on
 *     THIS call, per-event for the same reason; contract in
 *     tracingResponseFormat.ts
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

  // ── 0. Current-generation conventions ─────────────────────────
  //    OpenInference's indexed `llm.input_messages.{i}.message.*` and the OTel
  //    GenAI JSON blobs. A span can carry both (two instrumentors in one app),
  //    so both are collected before falling through to the older forms.
  const openInferenceSections = buildOpenInferenceMessageSections(attrs);
  if (openInferenceSections.length > 0) sections.push(openInferenceSections);

  const genAiSections = buildGenAiJsonSections(attrs);
  if (genAiSections.length > 0) sections.push(genAiSections);

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
  //    `input.value` / `output.value` are OpenInference's catch-all, and the
  //    only place a TOOL span's result reliably appears; `traceloop.entity.*`
  //    is OpenLLMetry's equivalent.
  const hasStructuredMessages =
    openInferenceSections.length > 0 || genAiSections.length > 0 || prompts.length > 0;
  const inputContent = getStringAttr(attrs, 'input')
    || getStringAttr(attrs, 'input.value')
    || getStringAttr(attrs, 'cognipeer.input')
    || getStringAttr(attrs, 'llm.input')
    || getStringAttr(attrs, 'ai.input')
    || getStringAttr(attrs, 'traceloop.entity.input');
  const outputContent = getStringAttr(attrs, 'output')
    || getStringAttr(attrs, 'output.value')
    || getStringAttr(attrs, 'cognipeer.output')
    || getStringAttr(attrs, 'llm.output')
    || getStringAttr(attrs, 'ai.output')
    || getStringAttr(attrs, 'traceloop.entity.output');

  if (isUsableContent(inputContent) && !hasStructuredMessages) {
    const label = eventType === 'tool_call' ? 'Tool Input' : 'Input';
    const kind = eventType === 'tool_call' ? 'tool_call' : 'message';
    sections.push([{
      kind,
      label,
      role: eventType === 'tool_call' ? undefined : 'user',
      content: inputContent,
    }]);
  }

  // Guarded the same way as the input: on an LLM span that already produced
  // structured messages, `output.value` is the same response again in raw form.
  if (
    isUsableContent(outputContent)
    && completions.length === 0
    && (!hasStructuredMessages || eventType === 'tool_call')
  ) {
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

  // ── 3b. Tool definitions offered to the model ─────────────────
  //    Attached to the same synthesized event that carries the span's model
  //    call — per event, so a menu that changes between turns is captured
  //    turn by turn.
  const toolDefinitionEntries = extractToolDefinitionAttrs(attrs, span.spanId);
  if (toolDefinitionEntries.length > 0) {
    const toolDefinitionsSection = buildToolDefinitionsSection(toolDefinitionEntries);
    if (toolDefinitionsSection) sections.push([toolDefinitionsSection]);
  }

  // ── 3c. Structured-output contract for this call ──────────────
  //    The other half of the request shape (see tracingResponseFormat.ts).
  //    Per event for the same reason the menu is: a run can enforce a schema
  //    on its final turn only.
  const responseFormatSection = buildResponseFormatSection(extractResponseFormatAttrs(attrs, span.spanId));
  if (responseFormatSection) sections.push([responseFormatSection]);

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
 * Where the structured-output contract hides across instrumentors:
 *   - OTel GenAI semconv: `gen_ai.output.type` ('json' | 'text' | …) plus
 *     `gen_ai.request.structured_output_schema` (a JSON-encoded schema);
 *   - OpenInference: the whole request body in `llm.invocation_parameters`,
 *     which carries `response_format` verbatim;
 *   - OpenLLMetry and ad-hoc emitters: a JSON-encoded `response_format`.
 * Contract + caps live in tracingResponseFormat.ts.
 */
const RESPONSE_FORMAT_JSON_ATTRS = [
  'cognipeer.response_format',
  'gen_ai.request.response_format',
  'llm.request.response_format',
  'llm.response_format',
  'ai.response.format',
];
const INVOCATION_PARAM_ATTRS = ['llm.invocation_parameters', 'gen_ai.request.parameters'];

/**
 * Extract the structured-output contract from span attributes, in the raw form
 * `buildResponseFormatSection` normalizes. Same tolerance as the tool-menu
 * extraction: unparseable JSON is warned about and ignored rather than failing
 * the ingest.
 */
function extractResponseFormatAttrs(
  attrs: OtlpKeyValue[],
  spanId: string,
): Record<string, unknown> | undefined {
  for (const key of RESPONSE_FORMAT_JSON_ATTRS) {
    const raw = getStringAttr(attrs, key);
    if (!raw) continue;
    const parsed = parseJsonRecord(raw, { attribute: key, spanId });
    if (parsed) return parsed;
  }

  // OpenInference ships the entire request body; response_format rides inside.
  for (const key of INVOCATION_PARAM_ATTRS) {
    const raw = getStringAttr(attrs, key);
    if (!raw) continue;
    const parsed = parseJsonRecord(raw, { attribute: key, spanId });
    const nested = parsed?.response_format ?? parsed?.responseFormat;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }

  // GenAI semconv splits it in two: the output MODE and the schema.
  const outputType = getStringAttr(attrs, 'gen_ai.output.type');
  const schemaRaw = getStringAttr(attrs, 'gen_ai.request.structured_output_schema');
  if (schemaRaw) {
    const schema = parseJsonRecord(schemaRaw, { attribute: 'gen_ai.request.structured_output_schema', spanId });
    if (schema) {
      return {
        type: 'json_schema',
        json_schema: {
          ...(getStringAttr(attrs, 'gen_ai.request.structured_output_name')
            ? { name: getStringAttr(attrs, 'gen_ai.request.structured_output_name') }
            : {}),
          schema,
        },
      };
    }
  }
  // `json` with no schema is still a contract — the model was told to emit JSON.
  if (outputType === 'json') return { type: 'json_object' };

  return undefined;
}

/** Indexed tool-definition attribute prefixes, most common first:
 *  OpenLLMetry/Traceloop `llm.request.functions.{i}.name/.description/
 *  .parameters` (parameters is a JSON string) and its `gen_ai.request.
 *  functions.{i}.*` mirror. */
const TOOL_DEFINITION_ATTR_PREFIXES = ['llm.request.functions', 'gen_ai.request.functions'];
/** Single-attribute variant: one JSON array of tool definitions (bare
 *  `{name, description, parameters}` entries or OpenAI `{type:'function',
 *  function:{...}}` envelopes — the normalizer accepts both). */
const TOOL_DEFINITION_JSON_ATTRS = ['gen_ai.request.tools', 'llm.request.tools'];

/**
 * Extract the tool definitions offered to the model from span attributes.
 * Returns raw entries for `buildToolDefinitionsSection` to normalize
 * (`parameters` may still be a JSON string here). Same tolerance level as the
 * prompt extraction: bad indices are skipped, unparseable JSON is warned and
 * ignored.
 */
function extractToolDefinitionAttrs(
  attrs: OtlpKeyValue[],
  spanId: string
): Array<Record<string, unknown>> {
  // OpenInference: `llm.tools.{i}.tool.json_schema`, where each value is the
  // WHOLE tool object as JSON — usually the OpenAI envelope, which
  // normalizeToolDefinitions unwraps.
  const openInferenceTools = groupIndexedAttrs(attrs, 'llm.tools')
    .map((tool) => {
      const raw = tool['tool.json_schema'];
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        logger.warn('Failed to parse JSON trace attribute', {
          attribute: 'llm.tools.{i}.tool.json_schema',
          spanId,
        });
        return undefined;
      }
    })
    .filter((tool): tool is Record<string, unknown> => Boolean(tool));
  if (openInferenceTools.length > 0) return openInferenceTools;

  // OTel GenAI / OpenLLMetry >= 0.55: one JSON array of unwrapped definitions.
  const genAiTools = parseJsonArrayAttr(attrs, 'gen_ai.tool.definitions');
  if (genAiTools.length > 0) return genAiTools as Array<Record<string, unknown>>;

  for (const prefix of TOOL_DEFINITION_ATTR_PREFIXES) {
    const map = new Map<number, Record<string, unknown>>();
    for (const kv of attrs) {
      if (!kv.key.startsWith(prefix + '.')) continue;
      const rest = kv.key.slice(prefix.length + 1); // "0.name" / "0.parameters"
      const dotIdx = rest.indexOf('.');
      if (dotIdx < 0) continue;
      const idx = parseInt(rest.slice(0, dotIdx), 10);
      if (Number.isNaN(idx)) continue;
      const field = rest.slice(dotIdx + 1);
      const val = kv.value.stringValue;
      if (!val) continue;

      let entry = map.get(idx);
      if (!entry) { entry = {}; map.set(idx, entry); }
      if (field === 'name') entry.name = val;
      if (field === 'description') entry.description = val;
      // JSON string — buildToolDefinitionsSection parses it.
      if (field === 'parameters' || field === 'arguments') entry.parameters = val;
    }
    const entries = [...map.entries()]
      .filter(([, entry]) => typeof entry.name === 'string')
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => entry);
    if (entries.length > 0) return entries;
  }

  for (const key of TOOL_DEFINITION_JSON_ATTRS) {
    const raw = getStringAttr(attrs, key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    } catch {
      logger.warn('Failed to parse JSON trace attribute', { attribute: key, spanId });
    }
  }

  return [];
}

/**
 * Derive an event type from a generic OTel span (no cognipeer.* attributes).
 * Heuristic based on span name and kind.
 */
function deriveEventType(span: OtlpSpan): string {
  // An explicit convention attribute always beats guessing from the name.
  const openInferenceKind = getStringAttr(span.attributes, 'openinference.span.kind');
  if (openInferenceKind) {
    const mapped = OPENINFERENCE_KIND_TO_EVENT[openInferenceKind.toUpperCase()];
    if (mapped) return mapped;
  }

  const genAiOperation = getStringAttr(span.attributes, 'gen_ai.operation.name');
  if (genAiOperation) {
    const mapped = GENAI_OPERATION_TO_EVENT[genAiOperation.toLowerCase()];
    if (mapped) return mapped;
  }

  // OpenLLMetry's own span-kind attribute (workflow/task/agent/tool).
  const traceloopKind = getStringAttr(span.attributes, 'traceloop.span.kind');
  if (traceloopKind === 'tool') return 'tool_call';

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
