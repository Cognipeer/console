/**
 * Stream mechanics of the gateway core that do not depend on a request: the
 * assembler that turns provider chunks into one native answer, the `finish_reason`
 * the OpenAI wire shows, and the two-way conversion between native steps and the
 * OpenAI-shaped frames the stream gate adjudicates.
 */

import crypto from 'crypto';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  FinishReason,
  ProviderResponseFields,
  TokenUsage as NativeUsage,
} from '@cognipeer/agent-sdk';
import { OPENAI_SCHEMA_DRIVERS } from '@/lib/providers/contracts/nativeClients';
import type { OpenAiStreamChunkLike } from '@/lib/services/guardrail/hooks/streamGate';
import { OpenAiStreamFramer, wireToolCallsToNative } from './openaiAdapter';
import type { ModelStreamDelta, ReasoningBlock, ReasoningPayload, ToolCall } from './gatewayTypes';

/** `finish_reason` values OpenAI clients know. Anything else from a non-OpenAI upstream is translated. */
const OPENAI_FINISH_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call',
]);

/**
 * The `finish_reason` on the OpenAI wire.
 *
 * An OpenAI-schema upstream (OpenAI, Azure, Together, any compatible server) is
 * passed through RAW - including the values only some servers invent - because
 * clients and the usage rows have always seen exactly what the upstream said. A
 * provider with its own vocabulary (Anthropic `end_turn` / `tool_use` /
 * `max_tokens`, Bedrock, Gemini) cannot put its words on this wire: its reason is
 * the SDK's OpenAI-vocabulary one, and the SDK's `error` (not an OpenAI value) is
 * a plain `stop`.
 */
export function wireFinishReason(
  driver: string | undefined,
  raw: string | undefined,
  normalized: FinishReason | undefined,
): string {
  if (raw && ((driver && OPENAI_SCHEMA_DRIVERS.has(driver)) || OPENAI_FINISH_REASONS.has(raw))) return raw;
  // Reasons of the other families the SDK's own collapse does not know (Bedrock's
  // `guardrail_intervened`, Gemini's safety stops): a filtered answer must not
  // read as a normal `stop`.
  const own = raw ? PROVIDER_FINISH_REASONS[raw.toLowerCase()] : undefined;
  if (own) return own;
  if (!normalized || normalized === 'error') return 'stop';
  return normalized;
}

const PROVIDER_FINISH_REASONS: Readonly<Record<string, string>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  content_filtered: 'content_filter',
  guardrail_intervened: 'content_filter',
  guardrail: 'content_filter',
  refusal: 'content_filter',
  safety: 'content_filter',
  recitation: 'content_filter',
  blocklist: 'content_filter',
  prohibited_content: 'content_filter',
  spii: 'content_filter',
  image_safety: 'content_filter',
};

function blankArguments(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed === '' || /^\{\s*$/.test(trimmed);
}

interface AssembledCall {
  id: string;
  name: string;
  args: string;
  thoughtSignature?: string;
}

/** Folds the provider chunks of one completion into a native answer. */
export class StreamAssembler {
  id = '';
  model = '';
  content = '';
  reasoningSummary = '';
  reasoningBlocks: ReasoningBlock[] | undefined;
  usage: NativeUsage | undefined;
  finishReason: FinishReason | undefined;
  rawFinishReason: string | undefined;
  providerFields: ProviderResponseFields = {};

  private readonly calls = new Map<number, AssembledCall>();
  private readonly idToIndex = new Map<string, number>();
  private lastIndex = -1;

  push(chunk: ChatCompletionChunk): void {
    this.id = chunk.id || this.id;
    this.model = chunk.model || this.model;
    if (chunk.usage) this.usage = chunk.usage;
    if (typeof chunk.rawFinishReason === 'string') {
      this.rawFinishReason = chunk.rawFinishReason;
      this.finishReason = chunk.finishReason;
    }
    if (chunk.providerFields) this.providerFields = { ...this.providerFields, ...chunk.providerFields };

    const delta = chunk.delta ?? {};
    if (delta.content) this.content += delta.content;
    if (delta.reasoning) {
      if (typeof delta.reasoning.summary === 'string') this.reasoningSummary += delta.reasoning.summary;
      // The signed blocks arrive complete, on the closing chunk.
      if (delta.reasoning.blocks?.length) this.reasoningBlocks = delta.reasoning.blocks;
    }
    for (const partial of delta.toolCalls ?? []) {
      let index = partial.index;
      if (index === undefined) {
        const known = partial.id ? this.idToIndex.get(partial.id) : undefined;
        index = known ?? (partial.id ? this.lastIndex + 1 : Math.max(this.lastIndex, 0));
      }
      this.lastIndex = Math.max(this.lastIndex, index);
      let call = this.calls.get(index);
      if (!call) {
        call = { id: '', name: '', args: '' };
        this.calls.set(index, call);
      }
      if (partial.id && !call.id) {
        call.id = partial.id;
        this.idToIndex.set(partial.id, index);
      }
      if (partial.name && !call.name) call.name = partial.name;
      if (partial.arguments) call.args += partial.arguments;
      if (partial.thoughtSignature) call.thoughtSignature = partial.thoughtSignature;
    }
  }

  get toolCallCount(): number {
    return this.calls.size;
  }

  /** Calls whose arguments do not parse on their own: empty, or the lone `{` some tool parsers emit for a no-argument tool. */
  blankToolCalls(): Array<{ index: number; completion: string }> {
    const out: Array<{ index: number; completion: string }> = [];
    for (const [index, call] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!blankArguments(call.args)) continue;
      out.push({ index, completion: call.args.trim() === '' ? '{}' : '}' });
    }
    return out;
  }

  /** Applies the completion `blankToolCalls()` named, so the assembled answer parses like what the stream was told. */
  complete(index: number, completion: string): void {
    const call = this.calls.get(index);
    if (call) call.args = call.args.trim() === '' ? completion : `${call.args}${completion}`;
  }

  toolCalls(): ToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}_${crypto.randomUUID()}`,
        name: call.name || 'tool_call',
        arguments: call.args,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
      }));
  }

  reasoning(): ReasoningPayload | undefined {
    const summary = this.reasoningSummary;
    if (!summary && !this.reasoningBlocks?.length) return undefined;
    return {
      ...(this.reasoningBlocks?.length ? { blocks: this.reasoningBlocks } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  /** The assembled answer. `content` is what the provider streamed (inline reasoning is the core's to split). */
  toResponse(emptyUsage: NativeUsage): ChatCompletionResponse {
    const toolCalls = this.toolCalls();
    const reasoning = this.reasoning();
    return {
      id: this.id,
      model: this.model,
      content: this.content.length > 0 ? this.content : null,
      toolCalls,
      usage: this.usage ?? emptyUsage,
      finishReason: this.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      ...(this.rawFinishReason ? { rawFinishReason: this.rawFinishReason } : {}),
      ...(Object.keys(this.providerFields).length > 0 ? { providerFields: this.providerFields } : {}),
      ...(reasoning ? { reasoning } : {}),
      raw: null,
    };
  }
}

// ── The stream gate speaks OpenAI frames ─────────────────────────────────

/** A native step as the frame the gate adjudicates; null when it carries nothing. */
export function toGateFrame(step: ModelStreamDelta, framer: OpenAiStreamFramer): OpenAiStreamChunkLike | null {
  return framer.delta(step) as OpenAiStreamChunkLike | null;
}

/** A frame the gate released, as a native step. */
export function fromGateFrame(frame: OpenAiStreamChunkLike): ModelStreamDelta {
  const choice = frame.choices?.[0];
  const delta = (choice?.delta ?? {}) as Record<string, unknown>;
  const toolCalls = wireToolCallsToNative(delta.tool_calls);
  return {
    type: 'delta',
    ...(typeof delta.content === 'string' && delta.content.length > 0 ? { content: delta.content } : {}),
    ...(typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
      ? { reasoning: delta.reasoning_content }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
  };
}

/** True when a frame the gate released put characters on the wire. */
export function frameHasContent(frame: OpenAiStreamChunkLike): boolean {
  return (frame.choices ?? []).some((choice) => {
    const content = choice.delta?.content;
    return typeof content === 'string' && content.length > 0;
  });
}
