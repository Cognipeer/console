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
        return new SystemMessage({ content });
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
        });
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
        });
    }
  });
}

function extractUsage(message: AIMessage | AIMessageChunk): UsageMetrics {
  const metadata = message.response_metadata || {};
  const usageSource =
    metadata.tokenUsage ||
    metadata.token_usage ||
    metadata.usage_metadata ||
    {};
  const usage =
    typeof usageSource === 'object' && usageSource !== null
      ? (usageSource as Record<string, unknown>)
      : {};

  const coalesceNumber = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === 'number') {
        return value;
      }
    }
    return undefined;
  };

  const coalesceDetails = (
    keys: string[],
  ): Record<string, number> | undefined => {
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

  if (normalizedToolCalls) {
    assistantMessage.tool_calls = normalizedToolCalls;
  }

  return {
    id: `chatcmpl_${crypto.randomUUID()}`,
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

export function toOpenAIStreamChunk(
  chunk: AIMessageChunk,
  options: ChatTransformOptions,
) {
  const usage = extractUsage(chunk);
  const delta: Record<string, unknown> = {};

  if (typeof chunk.content === 'string') {
    delta.content = chunk.content;
  } else if (Array.isArray(chunk.content)) {
    delta.content = chunk.content;
  }

  const chunkWithTools = chunk as AIMessageChunk & { tool_calls?: unknown };
  const normalizedToolCalls = normalizeToolCalls(chunkWithTools.tool_calls);
  if (normalizedToolCalls) {
    delta.tool_calls = normalizedToolCalls;
  }

  return {
    id: `chatcmpl_${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
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
