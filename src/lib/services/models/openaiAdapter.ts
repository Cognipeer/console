import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  FunctionMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import crypto from 'crypto';

type MessageContentPart = Record<string, unknown>;

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

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  name?: string;
  content: string | MessageContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCallPayload[];
}

interface UsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  promptTokensDetails?: Record<string, number>;
  completionTokensDetails?: Record<string, number>;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTransformOptions {
  model: string;
  stream?: boolean;
  /** Completion-scoped id, shared by every frame of one streamed response. */
  id?: string;
  /** Completion-scoped unix timestamp, likewise shared across frames. */
  created?: number;
}

/** OpenAI streaming tool-call deltas are indexed and carry partial argument text. */
interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function: {
    name?: string;
    arguments: string;
  };
}

function normalizeContent(
  content: OpenAIMessage['content'],
): string | MessageContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item) => {
      const record = item as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : undefined;

      if (type === 'text' && typeof record.text === 'string') {
        return {
          type: 'text',
          text: record.text,
        } as MessageContentPart;
      }

      if (type === 'image_url') {
        const rawImage = record.image_url;
        if (typeof rawImage === 'string') {
          return {
            type: 'image_url',
            image_url: rawImage,
          } as MessageContentPart;
        }

        if (
          rawImage &&
          typeof rawImage === 'object' &&
          !Array.isArray(rawImage)
        ) {
          const url =
            typeof (rawImage as Record<string, unknown>).url === 'string'
              ? (rawImage as Record<string, unknown>).url
              : undefined;

          if (url) {
            return {
              type: 'image_url',
              image_url: url,
            } as MessageContentPart;
          }
        }
      }

      return record;
    });
  }

  return content;
}

export function toLangChainMessages(messages: OpenAIMessage[]): BaseMessage[] {
  return messages.map((message) => {
    const content = normalizeContent(message.content);

    switch (message.role) {
      case 'system':
        return new SystemMessage({ content } as never);
      case 'assistant': {
        const assistantContent =
          typeof content === 'string' || Array.isArray(content)
            ? content
            : content
              ? String(content)
              : '';
        const additionalToolCalls = sanitizeIncomingToolCalls(
          message.tool_calls,
        );
        const langChainToolCalls = toLangChainToolCalls(additionalToolCalls);
        return new AIMessage({
          content: assistantContent,
          name: message.name,
          additional_kwargs: additionalToolCalls
            ? { tool_calls: additionalToolCalls }
            : {},
          tool_calls: langChainToolCalls,
        } as never);
      }
      case 'tool':
        return new ToolMessage({
          content:
            typeof content === 'string' ? content : JSON.stringify(content),
          tool_call_id: message.tool_call_id || message.name || 'tool-call',
        });
      case 'function':
        return new FunctionMessage({
          name: message.name || 'function',
          content:
            typeof content === 'string' ? content : JSON.stringify(content),
        });
      default:
        return new HumanMessage({
          content,
          name: message.name,
        } as never);
    }
  });
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function asUsageRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractUsage(message: AIMessage | AIMessageChunk): UsageMetrics {
  const metadata = message.response_metadata || {};

  // Every place a provider may report usage, most-specific first. The streaming
  // path only ever populates the first two: LangChain puts the terminal frame's
  // totals on the message's own `usage_metadata` and the raw provider numbers
  // under `response_metadata.usage`. Reading only the non-streaming keys meant
  // every streamed request was logged with zero tokens — and, because budget and
  // rate-limit updates are gated on usage being present, never billed.
  const sources = [
    asUsageRecord((message as { usage_metadata?: unknown }).usage_metadata),
    asUsageRecord(metadata.usage),
    asUsageRecord(metadata.tokenUsage),
    asUsageRecord(metadata.token_usage),
    asUsageRecord(metadata.usage_metadata),
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry));

  const coalesceNumber = (keys: string[]): number | undefined => {
    for (const usage of sources) {
      for (const key of keys) {
        const value = usage[key];
        if (typeof value === 'number') {
          return value;
        }
      }
    }
    return undefined;
  };

  const coalesceDetails = (
    keys: string[],
  ): Record<string, number> | undefined => {
    for (const usage of sources) {
      for (const key of keys) {
        const value = usage[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, detailValue]) => typeof detailValue === 'number')
            .map(([detailKey, detailValue]) => [
              detailKey,
              detailValue as number,
            ]);
          if (entries.length) {
            return Object.fromEntries(entries);
          }
        }
      }
    }
    return undefined;
  };

  const inputTokens = coalesceNumber([
    'promptTokens',
    'prompt_tokens',
    'inputTokens',
    'input_tokens',
  ]);
  const outputTokens = coalesceNumber([
    'completionTokens',
    'completion_tokens',
    'outputTokens',
    'output_tokens',
  ]);
  const coalesceNested = (
    containerKeys: string[],
    innerKeys: string[],
  ): number | undefined => {
    for (const usage of sources) {
      for (const containerKey of containerKeys) {
        const container = asUsageRecord(usage[containerKey]);
        if (!container) continue;
        for (const innerKey of innerKeys) {
          const value = container[innerKey];
          if (typeof value === 'number') {
            return value;
          }
        }
      }
    }
    return undefined;
  };

  const cachedInputTokens = coalesceNumber([
    'cachedTokens',
    'cached_tokens',
    'cachedInputTokens',
    'cached_input_tokens',
    'cache_read_input_tokens',
  ]) ?? coalesceNested(
    ['input_token_details', 'prompt_tokens_details', 'promptTokensDetails'],
    ['cache_read', 'cached_tokens', 'cacheRead'],
  );
  const totalTokens =
    coalesceNumber(['totalTokens', 'total_tokens']) ??
    // Cached tokens are already counted inside the prompt total, so they must
    // not be added again here.
    (typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? inputTokens + outputTokens
      : undefined);

  const promptTokensDetails = coalesceDetails([
    'promptTokensDetails',
    'prompt_tokens_details',
    'promptTokensDetail',
    'prompt_tokens_detail',
  ]);

  const completionTokensDetails = coalesceDetails([
    'completionTokensDetails',
    'completion_tokens_details',
    'completionTokensDetail',
    'completion_tokens_detail',
  ]);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    promptTokensDetails,
    completionTokensDetails,
  };
}

/**
 * Reasoning ("thinking") models emit their chain-of-thought separately from the
 * final answer. Over the OpenAI-compatible Chat Completions wire this arrives as
 * `delta.reasoning_content` / `message.reasoning_content`, which LangChain stores
 * under `additional_kwargs.reasoning_content` (string) — and for the Responses /
 * o-series shape under `additional_kwargs.reasoning` (object). We surface both so
 * downstream consumers (playground, SDK, agents) can render the thinking stream.
 */
function extractReasoning(message: { additional_kwargs?: unknown }): {
  reasoningContent?: string;
  reasoning?: unknown;
} {
  const additional =
    (message.additional_kwargs as Record<string, unknown> | undefined) || {};

  const rawReasoningContent = additional['reasoning_content'];
  const reasoningContent =
    typeof rawReasoningContent === 'string' && rawReasoningContent.length > 0
      ? rawReasoningContent
      : undefined;

  const rawReasoning = additional['reasoning'];
  const reasoning =
    rawReasoning !== undefined && rawReasoning !== null ? rawReasoning : undefined;

  return { reasoningContent, reasoning };
}

export function toOpenAIChatResponse(
  message: AIMessage,
  options: ChatTransformOptions,
) {
  const usage = extractUsage(message);
  const timestamp = Math.floor(Date.now() / 1000);
  const additional =
    (message.additional_kwargs as Record<string, unknown> | undefined) || {};
  const annotationsValue = additional['annotations'];
  const annotations = Array.isArray(annotationsValue) ? annotationsValue : [];
  const refusalValue = additional['refusal'];
  const refusal = refusalValue === undefined ? null : refusalValue;

  const normalizedContent = Array.isArray(message.content)
    ? message.content.length > 0
      ? message.content
      : null
    : typeof message.content === 'string'
      ? message.content.length > 0
        ? message.content
        : null
      : (message.content ?? null);

  const usagePayload: Record<string, unknown> = {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    cached_tokens: usage.cachedInputTokens ?? 0,
    total_tokens:
      usage.totalTokens ??
      (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cachedInputTokens ?? 0),
  };

  if (usage.promptTokensDetails) {
    usagePayload.prompt_tokens_details = usage.promptTokensDetails;
  }

  if (usage.completionTokensDetails) {
    usagePayload.completion_tokens_details = usage.completionTokensDetails;
  }

  const fingerprintFromMetadata = metadataFingerprint(
    message.response_metadata,
  );

  const systemFingerprint =
    fingerprintFromMetadata ||
    `fp_${crypto.createHash('sha256').update(`${options.model}`).digest('hex').slice(0, 24)}`;

  const messageWithTools = message as AIMessage & { tool_calls?: unknown };
  const normalizedToolCalls = normalizeToolCalls(messageWithTools.tool_calls);

  const assistantMessage: Record<string, unknown> = {
    role: 'assistant',
    content: normalizedContent,
    refusal,
    annotations,
  };

  const { reasoningContent, reasoning } = extractReasoning(message);
  if (reasoningContent !== undefined) {
    assistantMessage.reasoning_content = reasoningContent;
  }
  if (reasoning !== undefined) {
    assistantMessage.reasoning = reasoning;
  }

  if (normalizedToolCalls) {
    assistantMessage.tool_calls = normalizedToolCalls;
  }

  return {
    id: options.id ?? newCompletionId(),
    object: 'chat.completion',
    created: options.created ?? timestamp,
    model: options.model,
    usage: usagePayload,
    system_fingerprint: systemFingerprint,
    choices: [
      {
        index: 0,
        finish_reason: message.response_metadata?.finish_reason || 'stop',
        message: assistantMessage,
        logprobs: null,
      },
    ],
  };
}

/**
 * Streaming `delta.content` is a string in the OpenAI protocol. Providers that
 * speak in content blocks (the Responses API, Anthropic-style parts) would
 * otherwise put an array on the wire, and any client accumulating with
 * `content += delta.content` breaks mid-message.
 */
function flattenDeltaContent(content: unknown): {
  text?: string;
  reasoning?: string;
} {
  if (typeof content === 'string') {
    return content.length > 0 ? { text: content } : {};
  }

  if (!Array.isArray(content)) {
    return {};
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];

  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;

    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';

    // Reasoning blocks name their payload differently per provider: Anthropic
    // uses `thinking`, Bedrock Converse nests it under `reasoningText.text`,
    // the OpenAI-compatible shape uses `reasoning` or plain `text`.
    if (type === 'reasoning' || type === 'thinking' || type === 'reasoning_content') {
      const reasoningText = firstString(
        record.thinking,
        record.reasoning,
        record.text,
        (record.reasoningText as Record<string, unknown> | undefined)?.text,
      );
      if (reasoningText) reasoningParts.push(reasoningText);
      continue;
    }

    const text = typeof record.text === 'string' ? record.text : undefined;
    if (text !== undefined) {
      textParts.push(text);
    }
  }

  return {
    ...(textParts.length ? { text: textParts.join('') } : {}),
    ...(reasoningParts.length ? { reasoning: reasoningParts.join('') } : {}),
  };
}

/**
 * Streaming tool calls arrive as `tool_call_chunks`, one fragment of argument
 * text at a time, correlated by `index`. Reading the collapsed `tool_calls`
 * instead only ever yielded the first fragment — and, since LangChain drops a
 * chunk whose partial arguments do not parse, that first frame carried
 * `arguments: "{}"`. Clients saw every tool called with no parameters.
 */
function toStreamToolCallDeltas(
  chunk: AIMessageChunk,
): OpenAIToolCallDelta[] | undefined {
  const rawChunks = (chunk as { tool_call_chunks?: unknown }).tool_call_chunks;

  if (Array.isArray(rawChunks) && rawChunks.length > 0) {
    return rawChunks.map((entry, position) => {
      const call = (entry || {}) as Record<string, unknown>;
      const index = typeof call.index === 'number' ? call.index : position;
      const name = typeof call.name === 'string' && call.name ? call.name : undefined;
      const id = typeof call.id === 'string' && call.id ? call.id : undefined;
      // Raw partial text — never re-serialize, it is a fragment of a JSON document.
      const args = typeof call.args === 'string' ? call.args : '';

      return {
        index,
        ...(id ? { id, type: 'function' as const } : {}),
        function: {
          ...(name ? { name } : {}),
          arguments: args,
        },
      };
    });
  }

  // Providers that emit whole tool calls per chunk rather than argument deltas.
  const normalized = normalizeToolCalls((chunk as { tool_calls?: unknown }).tool_calls);
  return normalized?.map((call, index) => ({
    index,
    id: call.id,
    type: 'function' as const,
    function: { name: call.function.name, arguments: call.function.arguments },
  }));
}

function streamChunkEnvelope(options: ChatTransformOptions) {
  return {
    id: options.id ?? newCompletionId(),
    object: 'chat.completion.chunk' as const,
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: options.model,
  };
}

/** The opening frame of an OpenAI stream: role, no content. */
export function openAIStreamRoleChunk(options: ChatTransformOptions) {
  return {
    ...streamChunkEnvelope(options),
    choices: [
      { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
    ],
    usage: undefined as undefined | Record<string, number>,
  };
}

/** A terminal frame for upstreams that never send their own finish_reason. */
export function openAIStreamStopChunk(
  options: ChatTransformOptions,
  finishReason: string = 'stop',
) {
  return {
    ...streamChunkEnvelope(options),
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: undefined as undefined | Record<string, number>,
  };
}

/** True when a frame carries no delta payload — a usage-only terminal frame. */
export function isEmptyStreamDelta(payload: {
  choices: Array<{ delta: Record<string, unknown> }>;
}): boolean {
  const delta = payload.choices[0]?.delta;
  if (!delta) return true;
  return Object.entries(delta).every(([, value]) => value === '' || value === undefined);
}

export function toOpenAIStreamChunk(
  chunk: AIMessageChunk,
  options: ChatTransformOptions,
) {
  const usage = extractUsage(chunk);
  const delta: Record<string, unknown> = {};

  const { text, reasoning: reasoningFromContent } = flattenDeltaContent(chunk.content);
  if (text !== undefined) {
    delta.content = text;
  }

  const { reasoningContent, reasoning } = extractReasoning(chunk);
  if (reasoningContent !== undefined || reasoningFromContent !== undefined) {
    delta.reasoning_content = `${reasoningContent ?? ''}${reasoningFromContent ?? ''}`;
  }
  if (reasoning !== undefined) {
    delta.reasoning = reasoning;
  }

  const toolCallDeltas = toStreamToolCallDeltas(chunk);
  if (toolCallDeltas?.length) {
    delta.tool_calls = toolCallDeltas;
  }

  return {
    ...streamChunkEnvelope(options),
    choices: [
      {
        index: 0,
        delta,
        finish_reason: chunk.response_metadata?.finish_reason || null,
      },
    ],
    usage: usage.totalTokens
      ? {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          cached_tokens: usage.cachedInputTokens ?? 0,
          total_tokens: usage.totalTokens,
        }
      : undefined,
  };
}

/**
 * Maps a provider/transport failure onto the OpenAI error envelope. Upstream
 * 4xx responses used to arrive at the client as an opaque 500 `server_error`,
 * so a permanent 400 was indistinguishable from a bug and clients retried it.
 */
export function toOpenAIErrorType(error: unknown): string {
  const status = errorStatus(error);
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status !== undefined && status >= 400 && status < 500) {
    return 'invalid_request_error';
  }
  return 'server_error';
}

export function toOpenAIErrorCode(error: unknown): string | undefined {
  const record = error as { code?: unknown; error?: { code?: unknown } } | null;
  const code = record?.code ?? record?.error?.code;
  return typeof code === 'string' ? code : undefined;
}

export function toOpenAIErrorParam(error: unknown): string | undefined {
  const record = error as { param?: unknown; error?: { param?: unknown } } | null;
  const param = record?.param ?? record?.error?.param;
  return typeof param === 'string' ? param : undefined;
}

/** HTTP status from an OpenAI-SDK-shaped error, when there is one. */
export function errorStatus(error: unknown): number | undefined {
  const record = error as { status?: unknown; statusCode?: unknown } | null;
  const status = record?.status ?? record?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
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

export function summarizeUsage(message: AIMessage): UsageMetrics {
  return extractUsage(message);
}

function metadataFingerprint(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  const fingerprint = (metadata as Record<string, unknown>).system_fingerprint;
  return typeof fingerprint === 'string' ? fingerprint : undefined;
}

function normalizeToolCalls(
  rawToolCalls: unknown,
): OpenAIToolCall[] | undefined {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    return undefined;
  }

  return rawToolCalls.map((entry, index) => {
    const call =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : {};

    const functionPayload =
      call.function && typeof call.function === 'object'
        ? (call.function as Record<string, unknown>)
        : {};

    const nameCandidate =
      [functionPayload.name, call.name, call.tool_name].find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.length > 0,
      ) || 'tool_call';

    const argumentSource =
      functionPayload.arguments ??
      call.arguments ??
      call.args ??
      call.tool_input ??
      call.input ??
      call.parameters;

    const argsString = serializeArguments(argumentSource);

    const idCandidate = [call.id, call.tool_call_id].find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.length > 0,
    );

    const id = idCandidate || `call_${index}_${crypto.randomUUID()}`;

    return {
      id,
      type: 'function',
      function: {
        name: nameCandidate,
        arguments: argsString,
      },
    };
  });
}

function serializeArguments(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return '{}';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: '[unserializable]' });
  }
}

function toLangChainToolCalls(
  toolCalls: OpenAIToolCall[] | undefined,
): AIMessage['tool_calls'] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((call) => {
    const rawArguments = call.function?.arguments;
    let parsedArgs: unknown = {};

    if (typeof rawArguments === 'string') {
      const trimmed = rawArguments.trim();
      if (!trimmed) {
        parsedArgs = {};
      } else {
        try {
          parsedArgs = JSON.parse(rawArguments);
        } catch {
          parsedArgs = { raw: rawArguments };
        }
      }
    } else if (rawArguments && typeof rawArguments === 'object') {
      parsedArgs = rawArguments;
    }

    return {
      id: call.id,
      name: call.function.name || 'tool_call',
      args: parsedArgs,
      type: 'tool_call',
    };
  }) as AIMessage['tool_calls'];
}

function sanitizeIncomingToolCalls(
  rawToolCalls: ToolCallPayload[] | undefined,
): OpenAIToolCall[] | undefined {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    return undefined;
  }

  return rawToolCalls.map((call, index) => {
    const record = call && typeof call === 'object' ? call : {};
    const functionPayload =
      record.function && typeof record.function === 'object'
        ? (record.function as Record<string, unknown>)
        : {};

    const nameCandidate = [
      functionPayload.name,
      record.name,
      record.tool_name,
    ].find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.length > 0,
    );

    if (!nameCandidate) {
      throw new Error(
        `Invalid tool call at index ${index}: missing function name`,
      );
    }

    const argumentSource =
      functionPayload.arguments ??
      record.arguments ??
      record.args ??
      record.tool_input ??
      record.input ??
      record.parameters ??
      {};

    const idCandidate = [record.id, record.tool_call_id].find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.length > 0,
    );

    return {
      id: idCandidate || `call_${index}_${crypto.randomUUID()}`,
      type: 'function',
      function: {
        name: nameCandidate,
        arguments: serializeArguments(argumentSource),
      },
    };
  });
}
