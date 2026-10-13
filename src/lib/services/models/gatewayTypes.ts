/**
 * Types of the gateway core (`gatewayCore.ts`): a model call in agent-sdk native
 * terms. The HTTP edges (`openaiAdapter`, `anthropicWire`) translate their wire
 * formats to and from these; an in-process caller (an agent, a judge) uses them
 * directly.
 */

import type {
  AudioContent,
  ChatCompletionResponse,
  FileContent,
  ImageContent,
  ProviderResponseFields,
  ProviderToolCall,
  ProviderToolDefinition,
  TextContent,
  UnifiedMessage,
} from '@cognipeer/agent-sdk';
import type { IModelUsageRouting, IModelPricing } from '@/lib/database';
import type { UsageAttribution } from '@/lib/services/usage/usageEvents';
import type { RoutingCallerContext } from './routingCallerContext';
import type { TokenUsage, UsageCostResult } from './usageLogger';

/** agent-sdk shapes the package does not export under their own names. */
export type ToolCall = ProviderToolCall;
export type ToolDefinition = ProviderToolDefinition;
export type ContentPart = TextContent | ImageContent | FileContent | AudioContent;
export type ReasoningPayload = NonNullable<UnifiedMessage['reasoning']>;
export type ReasoningBlock = NonNullable<ReasoningPayload['blocks']>[number];

/**
 * A chat request as the core consumes it: unified messages and the native
 * request fields. What the native shape cannot say (unknown caller fields, the
 * reasoning spellings, `stream_options`, `metadata`, non-function tools, the
 * `response_format` exactly as written) travels in the OpenAI-shaped `wire` view
 * of the call (`ModelCallInput.wire`).
 *
 * The OpenAI wire spells the token limit two ways (`max_tokens` /
 * `max_completion_tokens`); the gateway's rules tell them apart (the token-limit
 * message), so both survive.
 */
export interface GatewayChatRequest {
  messages: UnifiedMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };
  responseFormat?: { type: 'json_schema' | 'json_object' | 'text'; schema?: Record<string, unknown>; name?: string };
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxCompletionTokens?: number;
  stop?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  parallelToolCalls?: boolean;
  requestId?: string;
}

/** Who is calling and what rides along. Everything is optional: a plain call needs none of it. */
export interface GatewayCallContext {
  /** Who asks and through which door (Dynamic LLM caller conditions). */
  callerContext?: RoutingCallerContext;
  /**
   * Called with the REALIZED cost once usage is known: for a stream long after
   * the call returned. Fires for success and for a cancelled stream with partial
   * usage, never for a call that produced no usage.
   */
  onUsageSettled?: (cost: UsageCostResult, usage?: TokenUsage) => void;
  /** Aborts the upstream request; a streamed call that is aborted is logged `cancelled` with estimated output tokens. */
  signal?: AbortSignal;
  /** Usage row route. Default `chat.completions`. */
  route?: string;
  /** Extra attribution on every usage row of this call (agent key, run id, channel ...). */
  attribution?: Partial<UsageAttribution>;
  /** An agent's own reasoning pick: outranks the Model Hub default. In-process only. */
  reasoningOverride?: unknown;
  /**
   * false: the caller will not show the reasoning text (an agent with `showReasoning: false`).
   * Like the Model Hub's `returnReasoning`, it can only narrow what is shown, and the provider
   * is not asked for thought text it would only have thrown away.
   */
  showReasoning?: boolean;
  /** Extra facts about the caller (agent key, session, purpose ...): merged into the `providerRequest` of every usage row of this call. */
  requestTags?: Record<string, unknown>;
  /**
   * False keeps the prompt out of the usage rows (only its size is recorded). An
   * agent's context is the whole conversation plus tool results at every step and
   * the trace already holds it: copying it into each row multiplies storage.
   */
  logPrompt?: boolean;
  /**
   * A non-streamed call (or a stream that fails to open) that fails writes an
   * `error` usage row. Off by default: an HTTP caller gets the error itself. An
   * in-process caller that has no other record of the failure turns it on.
   * A call whose `signal` aborts is always logged `cancelled`.
   */
  logFailures?: boolean;
  /**
   * Input guardrails evaluate the latest user message once per turn: a caller that
   * calls the model repeatedly inside one turn (an agent's tool loop) names the turn,
   * and the same turn + the same message is not evaluated twice.
   */
  guardrailTurnKey?: string;
  /** Internal: recursion depth when a Dynamic LLM resolves to another model. */
  routingDepth?: number;
  /** Internal: the Dynamic LLM decision this call serves. */
  routedBy?: RoutedBy;
}

/** Routing attribution handed to the child / decider call it caused. */
export interface RoutedBy {
  routing: IModelUsageRouting;
  /** Baseline model pricing: the child row records its usage priced there. */
  baselinePricing?: IModelPricing;
}

export interface ModelCallInput {
  tenantDbName: string;
  tenantId?: string;
  projectId: string;
  modelKey: string;
  request: GatewayChatRequest;
  stream?: boolean;
  /** The OpenAI-shaped body `request` was translated from. Logs, the cache key and the routing signals read it; derived from `request` when absent. */
  wire?: Record<string, unknown>;
  context?: GatewayCallContext;
}

/**
 * A hook's entry in the response's `guardrails` extension field.
 *
 * `guardrail_key` + `findings` are the shape documented since the single-slot
 * days (docs/guide/guardrails.md) and are LEFT ALONE for the one-guardrail case.
 * When several guardrails contributed, the entry grows a `results` breakdown:
 * `findings` becomes the concatenation over all of them and `results` says which
 * guardrail each finding came from; `guardrail_key` stays the FIRST contributor
 * in binding order.
 */
export interface GuardrailAnnotation {
  guardrail_key: string;
  findings: unknown[];
  results?: Array<{ guardrail_key: string; findings: unknown[] }>;
}

/** The answer of a non-streamed call. */
export interface ModelCallResult {
  /** Native, after the output guardrails (redaction applied), the inline reasoning split out and JSON mode repaired. */
  response: ChatCompletionResponse;
  /** Non-blocking guardrail findings, by hook. */
  guardrails: Record<string, GuardrailAnnotation>;
  /** `finish_reason` as the OpenAI wire carries it. */
  wireFinishReason: string;
}

export interface ModelStreamDelta {
  type: 'delta';
  content?: string;
  /** Reasoning TEXT of this step (summary / inline-split). */
  reasoning?: string;
  /** Provider reasoning payload as it arrived (summary + signed blocks). The text is also in `reasoning`. */
  reasoningPayload?: ReasoningPayload;
  toolCalls?: Array<Partial<ToolCall>>;
  /** Only on the terminal step: the `finish_reason` as the OpenAI wire carries it. */
  finishReason?: string;
  providerFields?: ProviderResponseFields;
}

/** The end of a successfully completed stream. `response` is the whole answer, assembled. */
export interface ModelStreamDone {
  type: 'done';
  response: ChatCompletionResponse;
  usage: TokenUsage;
  /** The provider's usage exactly as the native client reported it (the shape agent-sdk consumers read); absent when the stream carried none. */
  nativeUsage?: ChatCompletionResponse['usage'];
  wireFinishReason: string;
  /** The model hit its output limit without producing an answer. */
  outputLimitReached: boolean;
}

export type ModelStreamEvent =
  /** First event, before any provider byte: an OpenAI stream opens with the assistant role. */
  | { type: 'start' }
  | ModelStreamDelta
  /** The usage frame; present only when the caller asked for it. */
  | { type: 'usage'; usage: TokenUsage; wire: Record<string, unknown> }
  /** The stream ended without a finish reason of its own: a terminal step the caller must say. */
  | { type: 'finish'; finishReason: string }
  /** The model reached its output limit before producing anything: an error frame, then the end. */
  | { type: 'output_limit'; error: { message: string; type: string; code?: string | null; param?: string | null } }
  /**
   * An output guardrail blocked the answer mid-stream. The consumer writes its
   * terminal frames and CLOSES, and only then resumes the generator: the core
   * aborts the upstream after that, so the block is never filed as a hang-up.
   */
  | {
    type: 'blocked';
    message: string;
    guardrailKey?: string;
    code?: string;
    /** Gated characters already reached the caller: tell it to discard them. */
    discardPrior: boolean;
  }
  /** The provider failed mid-stream. */
  | { type: 'failed'; error: { message: string; type: string; code?: string | null; param?: string | null }; status: number }
  | ModelStreamDone
  /** The stream was aborted by its caller. Terminal; nothing more can be written. */
  | { type: 'cancelled' };

export interface ModelCallOutcome {
  requestId: string;
  latencyMs?: number;
  usage?: TokenUsage;
  cacheHit?: boolean;
  routing?: IModelUsageRouting;
  /**
   * The OpenAI-shaped rendition of a non-streamed answer (also what the semantic
   * cache stores): the final response, guardrail annotations and all. A cache hit
   * carries the stored body here.
   */
  wire?: Record<string, unknown>;
  /** Non-streamed answer. */
  result?: ModelCallResult;
  /** Streamed answer. */
  stream?: AsyncGenerator<ModelStreamEvent, void, void>;
  /** Verdict headers of a streamed answer, filled in as the stream unfolds. */
  streamHeaders?: Record<string, string>;
  /** The id the OpenAI wire shows for the model: the MODEL's id, never a replica's. */
  wireModel?: string;
  /** Streamed answer: the completion id / creation time every OpenAI frame of it carries (the stream gate mints frames with them too). */
  wireCompletion?: { id: string; created: number };
  /** Whether reasoning text may leave (Model Hub switch narrowed by the request). Hiding is the edge's job; the core never hides. */
  includeReasoning?: boolean;
}
