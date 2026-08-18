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
import { normalizeFinishReason } from '@/lib/shared/finishReason';

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
  /**
   * Reasoning ("thinking") tokens billed as part of the completion. This is
   * a SUBSET of `outputTokens`, never an addend — callers must not fold it
   * into `totalTokens` or any cost calculation. Recorded for attribution
   * only.
   */
  reasoningTokens?: number;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function: {
    name?: string;
    arguments: string;
  };
}

export interface ChatTransformOptions {
  model: string;
  stream?: boolean;
  completionId?: string;
  created?: number;
}

function normalizeContent(
  content: OpenAIMessage['content'],
  messageIndex: number,
): string | MessageContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item, partIndex) => {
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
        if (typeof rawImage === 'string' && rawImage.trim()) {
          return {
            type: 'image_url',
            image_url: { url: rawImage },
          } as MessageContentPart;
        }

        if (
          rawImage &&
          typeof rawImage === 'object' &&
          !Array.isArray(rawImage)
        ) {
          const url =
            typeof (rawImage as Record<string, unknown>).url === 'string'
              && (rawImage as Record<string, string>).url.trim()
              ? (rawImage as Record<string, unknown>).url
              : undefined;
          const detail = (rawImage as Record<string, unknown>).detail;

          if (url) {
            return {
              type: 'image_url',
              image_url: {
                url,
                ...(detail === 'auto' || detail === 'low' || detail === 'high'
                  ? { detail }
                  : {}),
              },
            } as MessageContentPart;
          }
        }

        throw new Error(
          `\`messages[${messageIndex}].content[${partIndex}].image_url\` must be a non-empty string or an object with a non-empty \`url\` string`,
        );
      }

      return record;
    });
  }

  return content;
}

export function toLangChainMessages(messages: OpenAIMessage[]): BaseMessage[] {
  return messages.map((message, messageIndex) => {
    const content = normalizeContent(message.content, messageIndex);

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

function extractUsage(message: AIMessage | AIMessageChunk): UsageMetrics {
  const metadata = message.response_metadata || {};
  const messageUsage = (message as { usage_metadata?: unknown }).usage_metadata;
  const usageSources = [
    metadata.tokenUsage,
    metadata.token_usage,
    metadata.usage,
    metadata.usage_metadata,
    messageUsage,
  ].filter(
    (source): source is Record<string, unknown> =>
      typeof source === 'object' && source !== null && !Array.isArray(source),
  );

  const coalesceNumber = (keys: string[]): number | undefined => {
    for (const usage of usageSources) {
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
    for (const usage of usageSources) {
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
  const cachedInputTokens = coalesceNumber([
    'cachedTokens',
    'cached_tokens',
    'cachedInputTokens',
    'cached_input_tokens',
    'cache_read_input_tokens',
  ]);
  const totalTokens =
    coalesceNumber(['totalTokens', 'total_tokens']) ??
    (typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? inputTokens + outputTokens + (cachedInputTokens || 0)
      : undefined);

  const promptTokensDetails = coalesceDetails([
    'promptTokensDetails',
    'prompt_tokens_details',
    'promptTokensDetail',
    'prompt_tokens_detail',
    'input_token_details',
  ]);

  const completionTokensDetails = coalesceDetails([
    'completionTokensDetails',
    'completion_tokens_details',
    'completionTokensDetail',
    'completion_tokens_detail',
    'output_token_details',
    'output_tokens_details',
  ]);

  const normalizedPromptTokensDetails = promptTokensDetails
    ? {
        ...promptTokensDetails,
        ...(promptTokensDetails.cache_read !== undefined
          ? { cached_tokens: promptTokensDetails.cache_read }
          : {}),
      }
    : undefined;
  const normalizedCompletionTokensDetails = completionTokensDetails
    ? {
        ...completionTokensDetails,
        ...(completionTokensDetails.reasoning !== undefined
          ? { reasoning_tokens: completionTokensDetails.reasoning }
          : {}),
      }
    : undefined;

  const nestedCachedTokens = normalizedPromptTokensDetails?.cached_tokens;

  // Reasoning tokens are a SUBSET of outputTokens (never an addend) — see
  // the `reasoningTokens` doc comment on `UsageMetrics`. Only accept a
  // finite, positive count; anything else is treated as "not reported".
  const rawReasoningTokens = normalizedCompletionTokensDetails?.reasoning_tokens;
  const reasoningTokens =
    typeof rawReasoningTokens === 'number' &&
    Number.isFinite(rawReasoningTokens) &&
    rawReasoningTokens > 0
      ? rawReasoningTokens
      : undefined;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cachedInputTokens ?? nestedCachedTokens,
    totalTokens,
    promptTokensDetails: normalizedPromptTokensDetails,
    completionTokensDetails: normalizedCompletionTokensDetails,
    reasoningTokens,
  };
}

/**
 * Read the raw provider finish reason off a LangChain message's
 * `response_metadata` (the same field `toOpenAIChatResponse` /
 * `toOpenAIStreamChunk` read to populate the wire `finish_reason`) and
 * normalize it via the shared `normalizeFinishReason` so persistence and
 * the response payload agree on the same value.
 */
export function extractFinishReason(message: {
  response_metadata?: unknown;
}): string | undefined {
  const metadata =
    (message.response_metadata as Record<string, unknown> | undefined) || {};
  const raw = metadata['finish_reason'] ?? metadata['finishReason'];
  return normalizeFinishReason(raw);
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
    id: newCompletionId(),
    object: 'chat.completion',
    created: timestamp,
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
function flattenDeltaContent(content: unknown): { text?: string; reasoning?: string } {
  if (typeof content === 'string') {
    return content.length > 0 ? { text: content } : {};
  }
  if (!Array.isArray(content)) return {};

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

    const value = typeof record.text === 'string' ? record.text : undefined;
    if (value !== undefined) textParts.push(value);
  }

  return {
    ...(textParts.length ? { text: textParts.join('') } : {}),
    ...(reasoningParts.length ? { reasoning: reasoningParts.join('') } : {}),
  };
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
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

  const chunkWithTools = chunk as AIMessageChunk & {
    tool_calls?: unknown;
    tool_call_chunks?: unknown;
  };
  const additional =
    chunk.additional_kwargs && typeof chunk.additional_kwargs === 'object'
      ? chunk.additional_kwargs as Record<string, unknown>
      : {};
  const normalizedToolCalls =
    normalizeRawStreamToolCalls(additional.tool_calls)
    ?? normalizeToolCallChunks(chunkWithTools.tool_call_chunks)
    ?? normalizeToolCalls(chunkWithTools.tool_calls);
  if (normalizedToolCalls) {
    delta.tool_calls = normalizedToolCalls;
  }

  return {
    id: options.completionId || newCompletionId(),
    object: 'chat.completion.chunk',
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: chunk.response_metadata?.finish_reason || null,
      },
    ],
    usage: usage.totalTokens !== undefined
      ? {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          cached_tokens: usage.cachedInputTokens ?? 0,
          total_tokens: usage.totalTokens,
          ...(usage.promptTokensDetails
            ? { prompt_tokens_details: usage.promptTokensDetails }
            : {}),
          ...(usage.completionTokensDetails
            ? { completion_tokens_details: usage.completionTokensDetails }
            : {}),
        }
      : undefined,
  };
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

/**
 * OpenAI's own completion ids are `chatcmpl-` + an opaque token. We emitted
 * `chatcmpl_` with a dashed UUID, which trips clients that pattern-match the id.
 *
 * Exported because the streaming path mints the id once and reuses it across
 * every frame — it used to build that id inline and kept the old shape long
 * after this was fixed for non-streamed responses.
 */
export function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizeToolCallChunks(
  rawToolCallChunks: unknown,
): OpenAIStreamToolCall[] | undefined {
  if (!Array.isArray(rawToolCallChunks) || rawToolCallChunks.length === 0) {
    return undefined;
  }

  return rawToolCallChunks.map((entry, position) => {
    const chunk = entry && typeof entry === 'object'
      ? entry as Record<string, unknown>
      : {};
    const id = typeof chunk.id === 'string' && chunk.id.length > 0
      ? chunk.id
      : undefined;
    const name = typeof chunk.name === 'string' && chunk.name.length > 0
      ? chunk.name
      : undefined;
    const index = typeof chunk.index === 'number' ? chunk.index : position;
    const argumentsChunk = typeof chunk.args === 'string'
      ? chunk.args
      : serializeArguments(chunk.args);

    return {
      index,
      ...(id ? { id, type: 'function' as const } : {}),
      function: {
        ...(name ? { name } : {}),
        arguments: argumentsChunk,
      },
    };
  });
}

function normalizeRawStreamToolCalls(
  rawToolCalls: unknown,
): OpenAIStreamToolCall[] | undefined {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    return undefined;
  }

  return rawToolCalls.map((entry, position) => {
    const call = entry && typeof entry === 'object'
      ? entry as Record<string, unknown>
      : {};
    const fn = call.function && typeof call.function === 'object'
      ? call.function as Record<string, unknown>
      : {};
    const id = typeof call.id === 'string' && call.id.length > 0
      ? call.id
      : undefined;
    const name = typeof fn.name === 'string' && fn.name.length > 0
      ? fn.name
      : undefined;
    const index = typeof call.index === 'number' ? call.index : position;
    const argumentsChunk = typeof fn.arguments === 'string'
      ? fn.arguments
      : fn.arguments === undefined
        ? ''
        : serializeArguments(fn.arguments);

    return {
      index,
      ...(id ? { id, type: 'function' as const } : {}),
      function: {
        ...(name ? { name } : {}),
        arguments: argumentsChunk,
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
