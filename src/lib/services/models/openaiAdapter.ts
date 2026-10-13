/**
 * The OpenAI Chat Completions wire <-> the gateway's native (agent-sdk) types.
 *
 * Nothing here knows a chat library: a request body is translated to unified
 * messages / tools / response format, and a native answer (or a native stream
 * step) is rendered as an OpenAI `chat.completion` / `chat.completion.chunk`.
 * Both directions exist because both kinds of caller do: an HTTP client speaks
 * OpenAI JSON, an in-process caller (an agent) speaks native types, and the core
 * logs, caches and routes on the OpenAI-shaped view of either.
 *
 * Wire rules kept here (each one has been a production incident):
 *  - `finish_reason` is the upstream's own value (`wireFinishReason`, decided by
 *    the core), not the SDK's collapsed enum.
 *  - A streamed tool call opens with `index` + `id` + `type` + `name`; every later
 *    fragment is `index` + `arguments` only. The SDK repeats id and name on every
 *    fragment, which strict clients (the OpenAI SDK, Open WebUI, Onyx) merge into
 *    garbage; one framer per completion remembers what it has already opened.
 *  - A tool call's `arguments` always parses: a lone `{` (Bedrock's Qwen tool
 *    parser for a no-argument tool) and an empty string become `{}`.
 *  - `usage` leaves in the OpenAI shape with reasoning as a SUBSET of completion.
 */

import crypto from 'crypto';
import type { ChatCompletionResponse, FinishReason, UnifiedMessage } from '@cognipeer/agent-sdk';
import { normalizeFinishReason } from '@/lib/shared/finishReason';
import { FILE_REFERENCE_PART_TYPE } from '@/lib/providers/contracts/wireNormalization';
import type {
  ContentPart,
  GatewayChatRequest,
  GuardrailAnnotation,
  ModelStreamDelta,
  ReasoningPayload,
  ToolCall,
  ToolDefinition,
} from './gatewayTypes';
import type { TokenUsage } from './usageLogger';
import { fromWireUsage, toWireUsage } from './gatewayUsage';

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type ToolCallPayload = {
  id?: string;
  type?: string;
  tool_call_id?: string;
  name?: string;
  arguments?: unknown;
  args?: unknown;
  tool_input?: unknown;
  input?: unknown;
  parameters?: unknown;
  tool_name?: string;
  function?: {
    name?: string;
    arguments?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  name?: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: ToolCallPayload[];
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTransformOptions {
  /** The model id the caller sees. */
  model: string;
  completionId?: string;
  created?: number;
  /**
   * false hides the model's reasoning text (`reasoning_content`) from the caller:
   * the Model Hub's "return reasoning" switch, or a request's
   * `include_reasoning: false`. The tokens are still counted.
   */
  includeReasoning?: boolean;
}

// ── Request: OpenAI -> native ────────────────────────────────────────────

const DATA_URL = /^data:([^;,]*)((?:;[^;,=]+=[^;,]+)*)(;base64)?,([\s\S]*)$/i;

/** An image part may carry the OpenAI `detail` hint; the native shape has no slot for it, so it rides on the part. */
export type ImagePartWithDetail = Extract<ContentPart, { type: 'image' }> & { detail?: 'auto' | 'low' | 'high' };

function imagePart(url: string, detail?: unknown): ContentPart {
  const hint = detail === 'auto' || detail === 'low' || detail === 'high' ? { detail } : {};
  const data = DATA_URL.exec(url);
  if (data) {
    const base64 = data[3] ? data[4] : Buffer.from(decodeURIComponent(data[4]), 'utf8').toString('base64');
    return { type: 'image', source: { type: 'base64', mediaType: data[1] || 'image/png', data: base64 }, ...hint } as ContentPart;
  }
  return { type: 'image', source: { type: 'url', url }, ...hint } as ContentPart;
}

/** The OpenAI `image_url` part of an image part (the form an OpenAI-schema upstream is sent when a `detail` hint has to survive). */
export function imagePartToOpenAi(part: ImagePartWithDetail): AnyRecord {
  const source = part.source;
  const url = source.type === 'url' ? source.url : `data:${source.mediaType};base64,${source.data}`;
  return { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } };
}

function audioMediaType(format: unknown): string {
  const f = typeof format === 'string' ? format.toLowerCase() : 'wav';
  if (f === 'mp3' || f === 'mpeg') return 'audio/mpeg';
  return `audio/${f}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function contentPartsToNative(content: unknown[], messageIndex: number): ContentPart[] {
  const parts: ContentPart[] = [];
  content.forEach((item, partIndex) => {
    if (typeof item === 'string') {
      parts.push({ type: 'text', text: item });
      return;
    }
    if (!isRecord(item)) return;
    const type = typeof item.type === 'string' ? item.type : undefined;

    if (type === 'text' && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text });
      return;
    }

    if (type === 'image_url') {
      const raw = item.image_url;
      const url = typeof raw === 'string' ? nonEmptyString(raw) : isRecord(raw) ? nonEmptyString(raw.url) : undefined;
      if (!url) {
        throw new Error(
          `\`messages[${messageIndex}].content[${partIndex}].image_url\` must be a non-empty string or an object with a non-empty \`url\` string`,
        );
      }
      parts.push(imagePart(url, isRecord(raw) ? raw.detail : undefined));
      return;
    }

    if (type === 'input_audio' && isRecord(item.input_audio) && typeof item.input_audio.data === 'string') {
      parts.push({
        type: 'audio',
        source: { type: 'base64', mediaType: audioMediaType(item.input_audio.format), data: item.input_audio.data },
      });
      return;
    }

    if (type === 'file' && isRecord(item.file)) {
      const fileData = nonEmptyString(item.file.file_data);
      const fileName = nonEmptyString(item.file.filename);
      const data = fileData ? DATA_URL.exec(fileData) : null;
      if (data) {
        parts.push({
          type: 'file',
          source: { type: 'base64', mediaType: data[1] || 'application/octet-stream', data: data[4] },
          ...(fileName ? { fileName } : {}),
        });
      } else if (nonEmptyString(item.file.file_id)) {
        // A reference to a file the upstream already holds: kept as the caller
        // wrote it (an OpenAI-schema upstream receives it; the core drops it for a
        // provider that could not read it) rather than degraded to a text note.
        parts.push({ type: FILE_REFERENCE_PART_TYPE, file: item.file } as unknown as ContentPart);
      }
      return;
    }

    if (typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text });
      return;
    }
    // A part type this gateway does not know (a newer OpenAI type): kept as the
    // caller wrote it. An OpenAI-schema upstream receives it verbatim; the core
    // drops it for providers that could not read it.
    if (type) parts.push(item as unknown as ContentPart);
  });
  return parts;
}

function textOfParts(parts: ContentPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : '')).filter(Boolean).join('\n');
}

function contentToNative(content: unknown, messageIndex: number): string | ContentPart[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return contentPartsToNative(content, messageIndex);
  if (content === null || content === undefined) return '';
  return String(content);
}

function contentAsText(content: unknown, messageIndex: number): string {
  const native = contentToNative(content, messageIndex);
  if (typeof native === 'string') return native;
  return native.length > 0 ? textOfParts(native) || JSON.stringify(content) : '';
}

function serializeArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: '[unserializable]' });
  }
}

function incomingToolCalls(rawToolCalls: ToolCallPayload[] | undefined): ToolCall[] | undefined {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return undefined;

  return rawToolCalls.map((call, index) => {
    const record = call && typeof call === 'object' ? call : {};
    const fn = isRecord(record.function) ? record.function : {};
    const name = [fn.name, record.name, record.tool_name].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
    if (!name) {
      throw new Error(`Invalid tool call at index ${index}: missing function name`);
    }
    const args = fn.arguments ?? record.arguments ?? record.args ?? record.tool_input ?? record.input ?? record.parameters ?? {};
    const id = [record.id, record.tool_call_id].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
    return {
      id: id || `call_${index}_${crypto.randomUUID()}`,
      name,
      arguments: serializeArguments(args),
    };
  });
}

export function openAiMessagesToNative(messages: OpenAIMessage[]): UnifiedMessage[] {
  return messages.map((message, messageIndex): UnifiedMessage => {
    switch (message.role) {
      case 'system':
      case 'developer':
        return { role: 'system', content: contentAsText(message.content, messageIndex) };
      case 'assistant': {
        const content = contentToNative(message.content, messageIndex);
        const toolCalls = incomingToolCalls(message.tool_calls);
        return {
          role: 'assistant',
          content,
          ...(message.name ? { name: message.name } : {}),
          ...(toolCalls ? { toolCalls } : {}),
        };
      }
      case 'tool':
        return {
          role: 'tool',
          content: contentAsText(message.content, messageIndex),
          toolCallId: message.tool_call_id || message.name || 'tool-call',
          ...(message.name ? { name: message.name } : {}),
        };
      case 'function':
        return {
          role: 'tool',
          content: contentAsText(message.content, messageIndex),
          toolCallId: message.name || 'function',
          name: message.name || 'function',
        };
      default:
        return {
          role: 'user',
          content: contentToNative(message.content, messageIndex),
          ...(message.name ? { name: message.name } : {}),
        };
    }
  });
}

// ── Request: tools, tool choice, response format ─────────────────────────

/** `additionalProperties: false` on every object schema: what a strict function tool needs. */
function normalizeStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStrictJsonSchema);
  if (!value || typeof value !== 'object') return value;

  const schema = Object.fromEntries(
    Object.entries(value as AnyRecord).map(([key, nested]) => [key, normalizeStrictJsonSchema(nested)]),
  );
  if (schema.type === 'object' || schema.properties) schema.additionalProperties = false;
  return schema;
}

/** Function tools as unified definitions. Tools of any other type cannot be expressed natively and stay in the wire view. */
export function openAiToolsToNative(tools: unknown, strictOverride?: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    const fn = tool.function;
    if (typeof fn.name !== 'string' || !fn.name) continue;
    const strict = typeof strictOverride === 'boolean' ? strictOverride : fn.strict;
    const parameters = isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} };
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: (strict === true ? normalizeStrictJsonSchema(parameters) : parameters) as Record<string, unknown>,
      ...(strict === true ? { strict: true } : typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    });
  }
  return out;
}

export function openAiToolChoiceToNative(choice: unknown): GatewayChatRequest['toolChoice'] {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isRecord(choice)) {
    const fn = isRecord(choice.function) ? choice.function : choice;
    if (typeof fn.name === 'string' && fn.name) return { name: fn.name };
  }
  return undefined;
}

export function openAiResponseFormatToNative(format: unknown): GatewayChatRequest['responseFormat'] {
  if (!isRecord(format)) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'text') return { type: 'text' };
  if (format.type === 'json_schema') {
    const spec = isRecord(format.json_schema) ? format.json_schema : {};
    return {
      type: 'json_schema',
      ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
      ...(isRecord(spec.schema) ? { schema: spec.schema } : {}),
    };
  }
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stopOf(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const stops = value.filter((entry): entry is string => typeof entry === 'string');
    return stops.length > 0 ? stops : undefined;
  }
  return undefined;
}

/** The native request of an OpenAI Chat Completions body. Throws on a malformed message exactly as the old path did. */
export function openAiBodyToNative(body: AnyRecord): GatewayChatRequest {
  const tools = openAiToolsToNative(body.tools, body.strict);
  const toolChoice = openAiToolChoiceToNative(body.tool_choice);
  const responseFormat = openAiResponseFormatToNative(body.response_format);
  const request: GatewayChatRequest = {
    messages: openAiMessagesToNative(body.messages as OpenAIMessage[]),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(responseFormat ? { responseFormat } : {}),
  };
  const set = <K extends keyof GatewayChatRequest>(key: K, value: GatewayChatRequest[K] | undefined) => {
    if (value !== undefined) request[key] = value as never;
  };
  set('temperature', numberOf(body.temperature));
  set('topP', numberOf(body.top_p));
  set('maxTokens', numberOf(body.max_tokens));
  set('maxCompletionTokens', numberOf(body.max_completion_tokens));
  set('stop', stopOf(body.stop));
  set('presencePenalty', numberOf(body.presence_penalty));
  set('frequencyPenalty', numberOf(body.frequency_penalty));
  set('seed', numberOf(body.seed));
  if (typeof body.parallel_tool_calls === 'boolean') request.parallelToolCalls = body.parallel_tool_calls;
  if (typeof body.request_id === 'string' && body.request_id) request.requestId = body.request_id;
  return request;
}

// ── Request: native -> OpenAI (the wire view of an in-process call) ──────

function contentPartToWire(part: ContentPart): AnyRecord {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') return imagePartToOpenAi(part as ImagePartWithDetail);
  if (part.type === 'file') {
    const source = part.source;
    return source.type === 'base64'
      ? { type: 'file', file: { filename: part.fileName ?? 'file', file_data: `data:${source.mediaType};base64,${source.data}` } }
      : { type: 'text', text: `[file: ${source.url}]` };
  }
  if ((part as { type: string }).type === FILE_REFERENCE_PART_TYPE) {
    return { type: 'file', file: (part as unknown as { file: unknown }).file };
  }
  if (part.type !== 'audio') return part as unknown as AnyRecord;
  const source = part.source;
  return source.type === 'base64'
    ? { type: 'input_audio', input_audio: { data: source.data, format: source.mediaType.split('/')[1] ?? 'wav' } }
    : { type: 'text', text: `[audio: ${source.url}]` };
}

export function nativeMessagesToOpenAi(messages: UnifiedMessage[]): OpenAIMessage[] {
  return messages.map((message): OpenAIMessage => {
    const content = typeof message.content === 'string' ? message.content : message.content.map(contentPartToWire);
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        ...(message.name ? { name: message.name } : {}),
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: typeof content === 'string' && content.length === 0 ? (null as unknown as string) : content,
        ...(message.name ? { name: message.name } : {}),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content, ...(message.name ? { name: message.name } : {}) };
  });
}

/** The OpenAI-shaped view of a native request (for an in-process caller that has no wire body of its own). */
export function nativeRequestToWire(request: GatewayChatRequest, options: { streamUsage?: boolean } = {}): AnyRecord {
  const wire: AnyRecord = { messages: nativeMessagesToOpenAi(request.messages) };
  if (request.tools?.length) {
    wire.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
  }
  if (request.toolChoice !== undefined) {
    wire.tool_choice = typeof request.toolChoice === 'string'
      ? request.toolChoice
      : { type: 'function', function: { name: request.toolChoice.name } };
  }
  if (request.responseFormat) {
    const format = request.responseFormat;
    wire.response_format = format.type === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: format.name ?? 'response', schema: format.schema, strict: true } }
      : { type: format.type };
  }
  if (request.temperature !== undefined) wire.temperature = request.temperature;
  if (request.topP !== undefined) wire.top_p = request.topP;
  if (request.maxTokens !== undefined) wire.max_tokens = request.maxTokens;
  if (request.maxCompletionTokens !== undefined) wire.max_completion_tokens = request.maxCompletionTokens;
  if (request.stop) wire.stop = request.stop;
  if (request.presencePenalty !== undefined) wire.presence_penalty = request.presencePenalty;
  if (request.frequencyPenalty !== undefined) wire.frequency_penalty = request.frequencyPenalty;
  if (request.seed !== undefined) wire.seed = request.seed;
  if (request.parallelToolCalls !== undefined) wire.parallel_tool_calls = request.parallelToolCalls;
  if (request.requestId) wire.request_id = request.requestId;
  if (options.streamUsage) wire.stream_options = { include_usage: true };
  return wire;
}

// ── Response: native -> OpenAI ───────────────────────────────────────────

/**
 * OpenAI's own completion ids are `chatcmpl-` + an opaque token. The streaming
 * path mints the id once and reuses it across every frame.
 */
export function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * `arguments` is a JSON string on the wire. Some upstreams truncate it to a bare
 * `"{"` for a call that takes no parameters (Bedrock's Qwen tool parser does),
 * which every strict client then fails to parse. That one shape - and an empty
 * string - is unambiguously an empty object, so it is repaired; anything else is
 * passed through exactly as the model produced it, because inventing arguments
 * would be worse than reporting the ones it actually emitted.
 */
export function normalizeArgumentsString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '{}';
  try {
    JSON.parse(trimmed);
    return raw;
  } catch {
    return /^\{\s*$/.test(trimmed) ? '{}' : raw;
  }
}

/** The text the completion's reasoning carries: the summary, or the text of the blocks when there is no summary. */
export function reasoningText(reasoning: ReasoningPayload | undefined): string | undefined {
  if (!reasoning) return undefined;
  if (typeof reasoning.summary === 'string' && reasoning.summary.length > 0) return reasoning.summary;
  const fromBlocks = (reasoning.blocks ?? [])
    .map((block) => (block.type === 'thinking' ? block.text ?? '' : ''))
    .join('');
  return fromBlocks.length > 0 ? fromBlocks : undefined;
}

export function toOpenAiToolCalls(toolCalls: ReadonlyArray<Partial<ToolCall>> | undefined): OpenAIToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((call, index) => ({
    id: call.id || `call_${index}_${crypto.randomUUID()}`,
    type: 'function',
    function: {
      name: call.name || 'tool_call',
      arguments: normalizeArgumentsString(call.arguments ?? ''),
    },
  }));
}

export interface WireResponseOptions extends ChatTransformOptions {
  usage: TokenUsage;
  wireFinishReason: string;
  guardrails?: Record<string, GuardrailAnnotation>;
}

/** An OpenAI `chat.completion` of a native answer. */
export function toOpenAIChatResponse(
  response: Pick<ChatCompletionResponse, 'content' | 'toolCalls' | 'reasoning' | 'providerFields'>,
  options: WireResponseOptions,
): Record<string, unknown> {
  const fields = response.providerFields ?? {};
  const message: AnyRecord = {
    role: 'assistant',
    content: typeof response.content === 'string' && response.content.length > 0 ? response.content : null,
    refusal: fields.refusal === undefined ? null : fields.refusal,
    annotations: Array.isArray(fields.annotations) ? fields.annotations : [],
  };

  const reasoning = reasoningText(response.reasoning);
  if (reasoning && options.includeReasoning !== false) message.reasoning_content = reasoning;

  const toolCalls = toOpenAiToolCalls(response.toolCalls);
  if (toolCalls) message.tool_calls = toolCalls;

  const fingerprint = typeof fields.system_fingerprint === 'string' && fields.system_fingerprint
    ? fields.system_fingerprint
    : `fp_${crypto.createHash('sha256').update(options.model).digest('hex').slice(0, 24)}`;

  return {
    id: options.completionId ?? newCompletionId(),
    object: 'chat.completion',
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: options.model,
    usage: toWireUsage(options.usage),
    system_fingerprint: fingerprint,
    ...(typeof fields.service_tier === 'string' ? { service_tier: fields.service_tier } : {}),
    choices: [
      {
        index: 0,
        finish_reason: options.wireFinishReason,
        message,
        logprobs: fields.logprobs ?? null,
      },
    ],
    ...(options.guardrails && Object.keys(options.guardrails).length > 0 ? { guardrails: options.guardrails } : {}),
  };
}

function toSdkFinishReason(raw: unknown): FinishReason {
  const reason = normalizeFinishReason(raw);
  if (reason === 'tool_calls' || reason === 'function_call' || reason === 'tool_use') return 'tool_calls';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

/** The native view of a stored OpenAI response (a semantic-cache hit handed to a native caller). */
export function openAiResponseToNative(wire: Record<string, unknown>): {
  response: ChatCompletionResponse;
  wireFinishReason: string;
  guardrails: Record<string, GuardrailAnnotation>;
  usage: TokenUsage;
} {
  const choice = (Array.isArray(wire.choices) ? wire.choices[0] : undefined) as AnyRecord | undefined;
  const message = (isRecord(choice?.message) ? choice?.message : {}) as AnyRecord;
  const usage = fromWireUsage(wire.usage);
  const toolCalls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((entry, index) => {
    const call = (isRecord(entry) ? entry : {}) as AnyRecord;
    const fn = (isRecord(call.function) ? call.function : {}) as AnyRecord;
    return {
      id: typeof call.id === 'string' && call.id ? call.id : `call_${index}_${crypto.randomUUID()}`,
      name: typeof fn.name === 'string' ? fn.name : 'tool_call',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
    };
  });
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop';
  const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content
    ? { summary: message.reasoning_content }
    : undefined;
  return {
    response: {
      id: typeof wire.id === 'string' ? wire.id : newCompletionId(),
      model: typeof wire.model === 'string' ? wire.model : '',
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        cachedWriteTokens: 0,
        cachedOutputTokens: 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
      },
      finishReason: toSdkFinishReason(finish),
      rawFinishReason: finish,
      ...(reasoning ? { reasoning } : {}),
      raw: wire,
    },
    wireFinishReason: finish,
    guardrails: isRecord(wire.guardrails) ? (wire.guardrails as Record<string, GuardrailAnnotation>) : {},
    usage,
  };
}

// ── Stream: native steps -> OpenAI chunks ────────────────────────────────

interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function: {
    name?: string;
    arguments: string;
  };
}

function streamChunkEnvelope(options: ChatTransformOptions) {
  return {
    id: options.completionId || newCompletionId(),
    object: 'chat.completion.chunk' as const,
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: options.model,
  };
}

/** The opening frame of an OpenAI stream: role, no content. */
export function openAIStreamRoleChunk(options: ChatTransformOptions) {
  return {
    ...streamChunkEnvelope(options),
    choices: [{ index: 0, delta: { role: 'assistant', content: '' } as Record<string, unknown>, finish_reason: null as string | null }],
  };
}

/** A terminal frame for upstreams that never send their own finish_reason. */
export function openAIStreamStopChunk(options: ChatTransformOptions, finishReason: string = 'stop') {
  return {
    ...streamChunkEnvelope(options),
    choices: [{ index: 0, delta: {} as Record<string, unknown>, finish_reason: finishReason as string | null }],
  };
}

/** A content/reasoning-only frame. */
export function openAIStreamDeltaChunk(options: ChatTransformOptions, delta: Record<string, unknown>) {
  return {
    ...streamChunkEnvelope(options),
    choices: [{ index: 0, delta, finish_reason: null as string | null }],
  };
}

/** The dedicated usage frame (`stream_options.include_usage`). */
export function openAIStreamUsageChunk(options: ChatTransformOptions, usage: Record<string, unknown>) {
  return {
    ...streamChunkEnvelope(options),
    choices: [] as never[],
    usage,
  };
}

/** True when a frame carries no delta payload. */
export function isEmptyStreamDelta(payload: {
  choices: Array<{ delta: Record<string, unknown> }>;
}): boolean {
  const delta = payload.choices[0]?.delta;
  if (!delta) return true;
  return Object.entries(delta).every(([, value]) => value === '' || value === undefined);
}

export type OpenAIStreamFrame = ReturnType<typeof openAIStreamDeltaChunk>;

/**
 * Frames the steps of ONE streamed completion. It remembers which tool calls it
 * has already opened, so the first fragment of a call carries `index` + `id` +
 * `type` + `name` and every later one only `index` + `arguments` (the SDK repeats
 * id and name on each fragment).
 */
export class OpenAiStreamFramer {
  private readonly opened = new Map<number, string>();
  /** Calls whose `name` has been put on the wire. */
  private readonly named = new Set<number>();
  private readonly byId = new Map<string, number>();
  private lastIndex = -1;

  constructor(readonly options: ChatTransformOptions) {}

  /** The wire `tool_calls` of one step. Fragments of a call the stream has not opened yet open it. */
  toolCalls(partials: ReadonlyArray<Partial<ToolCall>> | undefined): OpenAIStreamToolCall[] | undefined {
    if (!partials || partials.length === 0) return undefined;
    const out: OpenAIStreamToolCall[] = [];
    partials.forEach((partial) => {
      let index = partial.index;
      if (index === undefined) {
        // A provider that does not number its calls: an id it has seen is that call,
        // a new id opens the next one, no id continues the latest.
        const known = partial.id ? this.byId.get(partial.id) : undefined;
        index = known ?? (partial.id ? this.lastIndex + 1 : Math.max(this.lastIndex, 0));
      }
      this.lastIndex = Math.max(this.lastIndex, index);
      const args = partial.arguments ?? '';
      let id = this.opened.get(index);
      if (id === undefined) {
        id = partial.id && partial.id.length > 0 ? partial.id : `call_${index}_${crypto.randomUUID()}`;
        this.opened.set(index, id);
        this.byId.set(id, index);
        if (partial.name) this.named.add(index);
        out.push({
          index,
          id,
          type: 'function',
          function: { name: partial.name ?? '', arguments: args },
        });
        return;
      }
      // An upstream that sends a call's id in one delta and its name in a later
      // one opened the call with an empty name: the name still has to reach the
      // client, which merges fragments by index.
      if (partial.name && !this.named.has(index)) {
        this.named.add(index);
        out.push({ index, function: { name: partial.name, arguments: args } });
        return;
      }
      out.push({ index, function: { arguments: args } });
    });
    return out;
  }

  /** Whether the stream opened any tool call. */
  get hasToolCalls(): boolean {
    return this.opened.size > 0;
  }

  /**
   * One step as a frame; null when the step carries nothing a client could use
   * (the inline-reasoning splitter can swallow a whole delta while it waits for
   * the rest of a tag - what is left is not a valid frame).
   */
  delta(step: ModelStreamDelta): OpenAIStreamFrame | null {
    const delta: Record<string, unknown> = {};
    if (step.content !== undefined && step.content !== '') delta.content = step.content;
    if (step.reasoning && this.options.includeReasoning !== false) delta.reasoning_content = step.reasoning;
    const toolCalls = this.toolCalls(step.toolCalls);
    if (toolCalls) delta.tool_calls = toolCalls;
    if (Object.keys(delta).length === 0 && step.finishReason == null) return null;
    return {
      ...streamChunkEnvelope(this.options),
      choices: [{ index: 0, delta, finish_reason: step.finishReason ?? null }],
    };
  }
}

/** The first and later fragments of a wire tool call, as native partials (the stream gate hands frames back). */
export function wireToolCallsToNative(toolCalls: unknown): Array<Partial<ToolCall>> | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  return toolCalls.map((entry, position) => {
    const call = (isRecord(entry) ? entry : {}) as AnyRecord;
    const fn = (isRecord(call.function) ? call.function : {}) as AnyRecord;
    return {
      index: typeof call.index === 'number' ? call.index : position,
      ...(typeof call.id === 'string' && call.id ? { id: call.id } : {}),
      ...(typeof fn.name === 'string' && fn.name ? { name: fn.name } : {}),
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
    } as Partial<ToolCall>;
  });
}

export function buildErrorResponse(message: string, status = 400) {
  return {
    error: {
      message,
      type: 'invalid_request_error',
    },
    status,
  };
}
