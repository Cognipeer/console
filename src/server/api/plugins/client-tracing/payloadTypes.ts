import {
  type TraceUsageBasis,
} from '@/lib/services/tracing/traceUsage';

export type TracingUsage = {
  cacheReadInputTokens?: number | null;
  cache_read_input_tokens?: number | null;
  cachedInputTokens?: number | null;
  cached_input_tokens?: number | null;
  /** Cache-WRITE subset of the input count (Anthropic's `cache_creation_input_tokens`). */
  cacheWriteTokens?: number | null;
  cache_write_tokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Where the sender's native counts differ from the inclusive canonical basis. */
  usageBasis?: TraceUsageBasis | null;
  inputTokens?: number | null;
  input_tokens?: number | null;
  outputTokens?: number | null;
  output_tokens?: number | null;
  /** Subset of the output count — recorded, never re-billed. */
  reasoningTokens?: number | null;
  reasoning_tokens?: number | null;
  /** OpenAI/Azure raw usage shape: reasoning tokens nested under a details bag. */
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  /** OTel GenAI convention's mirror of the same nested shape. */
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
};

export type TracingActorPayload = Record<string, unknown> & {
  name?: string | null;
  role?: string | null;
  scope?: string | null;
};

export type TracingSummaryPayload = Record<string, unknown> & {
  eventCounts?: Record<string, number>;
  totalBytesIn?: number | null;
  totalBytesOut?: number | null;
  totalCachedInputTokens?: number | null;
  totalDurationMs?: number | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
};

export type TracingEventPayload = {
  actor?: TracingActorPayload;
  bytesIn?: number | null;
  bytesOut?: number | null;
  cachedInputTokens?: number | null;
  /** Cache-WRITE subset of `inputTokens` (SDK wire name). */
  cacheWriteTokens?: number | null;
  /** SDK-declared basis of the native counts: `inputExcludesCache` /
   *  `outputExcludesReasoning`. Absent = already inclusive. */
  usageBasis?: TraceUsageBasis | null;
  data?: Record<string, unknown> & {
    sections?: unknown[];
    toolDetails?: Record<string, unknown>;
  };
  durationMs?: number | null;
  error?: string | null;
  id?: string | null;
  inputTokens?: number | null;
  label?: string | null;
  metadata?: Record<string, unknown> & {
    finishReason?: string | null;
    /** Python-style SDKs that only wrote the snake_case field. */
    finish_reason?: string | null;
    /** Claude Agent SDK integration writes Anthropic's own vocabulary here. */
    stop_reason?: string | null;
    /** OTel exporter's plural form — a JSON array or comma-joined string. */
    finishReasons?: string[] | string | null;
    reasoningTokens?: number | null;
    cacheWriteTokens?: number | null;
    usageBasis?: TraceUsageBasis | null;
    modelName?: string | null;
    usage?: TracingUsage;
  };
  /** Why the model stopped: stop | tool_calls | length | content_filter | error. */
  finishReason?: string | null;
  /** Reasoning tokens billed inside `outputTokens` (a subset of it). */
  reasoningTokens?: number | null;
  model?: string | null;
  modelName?: string | null;
  modelNames?: string[];
  outputTokens?: number | null;
  parentSpanId?: string;
  requestBytes?: number | null;
  responseBytes?: number | null;
  sections?: unknown[];
  sequence?: number | null;
  spanId?: string;
  status?: string | null;
  timestamp?: string | Date;
  /** Structured-output contract sent with THIS call (OpenAI `response_format`
   *  shape, or the SDK's `{ response_format: … }` envelope) — normalized into a
   *  `response_format` section. Ignored silently when malformed. */
  responseFormat?: unknown;
  /** Tool menu offered to the model on THIS call — normalized into a
   *  `tool_definitions` section so SDK senders don't need to know the
   *  section encoding. Ignored silently when malformed. */
  toolDefinitions?: unknown;
  toolDetails?: Record<string, unknown>;
  toolExecutionId?: string | null;
  toolName?: string | null;
  totalTokens?: number | null;
  traceId?: string;
  type?: string | null;
  usage?: TracingUsage;
};

export type TracingAgentPayload = Record<string, unknown> & {
  model?: string | null;
  name?: string | null;
  version?: string | null;
};

export type TracingSessionPayload = {
  agent?: TracingAgentPayload;
  config?: Record<string, unknown>;
  durationMs?: number;
  endedAt?: string | Date;
  errors?: unknown[];
  events?: TracingEventPayload[];
  /** Free-form caller-supplied attribution tags (e.g. `{ complexity: 'complex' }`),
   *  sibling of `agent` — sanitized by `sanitizeTracingMetadata` before storage. */
  metadata?: Record<string, unknown>;
  rootSpanId?: string;
  sessionId?: string;
  startedAt?: string | Date;
  status?: string;
  summary?: TracingSummaryPayload;
  threadId?: string;
  traceId?: string;
};

export type TracingStreamEventPayload = {
  event?: TracingEventPayload;
};

export type TracingStreamEndPayload = {
  durationMs?: number;
  endedAt?: string | Date;
  errors?: unknown[];
  status?: string;
  summary?: TracingSummaryPayload;
};
