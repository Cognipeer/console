import crypto from 'crypto';
import type { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { IModel } from '@/lib/database';
import { getModelByKey } from './modelService';
import {
  toLangChainMessages,
  toOpenAIChatResponse,
  toOpenAIStreamChunk,
  summarizeUsage,
} from './openaiAdapter';

import { logModelUsage, TokenUsage } from './usageLogger';
import { buildModelRuntime } from './runtimeService';

const encoder = new TextEncoder();

interface ChatRunnable {
  bind(overrides: Record<string, unknown>): ChatRunnable;
  invoke(input: unknown): Promise<AIMessage>;
  stream?(input: unknown): AsyncIterable<AIMessageChunk> | Promise<AsyncIterable<AIMessageChunk>>;
}

function ensureChatRunnable(value: unknown): ChatRunnable {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid chat runtime.');
  }

  const candidate = value as Partial<ChatRunnable>;
  if (typeof candidate.bind !== 'function' || typeof candidate.invoke !== 'function') {
    throw new Error('Model provider returned an invalid chat runtime.');
  }

  return candidate as ChatRunnable;
}

type EmbeddingVector = number[] | Float32Array | { values: number[] };

interface EmbeddingRunnable {
  embedDocuments(inputs: string[]): Promise<EmbeddingVector[]>;
}

function ensureEmbeddingRunnable(value: unknown): EmbeddingRunnable {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid embedding runtime.');
  }

  const candidate = value as Partial<EmbeddingRunnable>;
  if (typeof candidate.embedDocuments !== 'function') {
    throw new Error('Model provider returned an invalid embedding runtime.');
  }

  return candidate as EmbeddingRunnable;
}

function normalizeEmbeddingVector(vector: EmbeddingVector): number[] {
  if (Array.isArray(vector)) {
    return vector;
  }

  if (vector instanceof Float32Array) {
    return Array.from(vector);
  }

  if (
    vector &&
    typeof vector === 'object' &&
    Array.isArray((vector as { values?: unknown }).values)
  ) {
    return (vector as { values: number[] }).values;
  }

  return [];
}

type ToolCallPayload = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

function getToolCallCount(message: AIMessage): number {
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) {
    return 0;
  }

  return toolCalls.length;
}

interface ChatCompletionRequestBody extends Record<string, unknown> {
  messages?: unknown;
  stream?: unknown;
  request_id?: string;
}

interface EmbeddingRequestBody extends Record<string, unknown> {
  input?: string | string[];
  request_id?: string;
  input_tokens?: number;
  inputTokenCount?: number;
}

function sanitizeForLogging(payload: unknown, maxLength = 20000) {
  if (payload === null || payload === undefined) {
    return payload;
  }

  try {
    const json = JSON.stringify(payload);
    if (json.length <= maxLength) {
      return payload;
    }
    return {
      truncated: true,
      preview: json.slice(0, maxLength),
    };
  } catch {
    return '[unserializable]';
  }
}

function buildOverrides(body: Record<string, unknown>) {
  const overrides: Record<string, unknown> = {};
  const fields = [
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
    'seed',
  ];

  fields.forEach((field) => {
    if (body[field] !== undefined) {
      overrides[field] = body[field];
    }
  });

  if (body.stop !== undefined) overrides.stop = body.stop;
  if (body.tools !== undefined) overrides.tools = body.tools;
  if (body.tool_choice !== undefined) overrides.tool_choice = body.tool_choice;
  if (body.response_format !== undefined)
    overrides.response_format = body.response_format;
  if (body.modality !== undefined) overrides.modality = body.modality;
  if (body.max_output_tokens !== undefined)
    overrides.max_output_tokens = body.max_output_tokens;

  // Reasoning model support (o1, o3, o4-mini, etc.)
  // max_completion_tokens is required for reasoning models instead of max_tokens
  if (body.max_completion_tokens !== undefined)
    overrides.max_completion_tokens = body.max_completion_tokens;

  // reasoning parameter: { effort: "low" | "medium" | "high", summary?: "auto" | "concise" }
  if (body.reasoning !== undefined) overrides.reasoning = body.reasoning;

  // Legacy reasoning_effort parameter (deprecated but still supported)
  // Will be mapped to reasoning.effort by LangChain
  if (body.reasoning_effort !== undefined)
    overrides.reasoning_effort = body.reasoning_effort;

  return overrides;
}

function ensureLlmModel(model: IModel) {
  if (model.category !== 'llm') {
    throw new Error('Model is not configured for chat completions');
  }
}

function ensureEmbeddingModel(model: IModel) {
  if (model.category !== 'embedding') {
    throw new Error('Model is not configured for embeddings');
  }
}

export async function handleChatCompletion(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  body: ChatCompletionRequestBody;
  stream?: boolean;
}) {
  const { tenantDbName, modelKey, projectId, body, stream } = params;

  if (!Array.isArray(body?.messages)) {
    throw new Error('`messages` array is required');
  }

  const requestId =
    typeof body.request_id === 'string' && body.request_id.length > 0
      ? body.request_id
      : crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  ensureLlmModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createChatModel) {
    throw new Error('Model provider does not support chat completions');
  }

  const messagesInput = body.messages as Parameters<typeof toLangChainMessages>[0];
  const messages = toLangChainMessages(messagesInput);
  const overrides = buildOverrides(body);

  const chatModel = ensureChatRunnable(await runtime.createChatModel({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
    options: { streaming: Boolean(stream) },
  }));
  const runnable = Object.keys(overrides).length
    ? chatModel.bind(overrides)
    : chatModel;

  if (stream) {
    if (typeof runnable.stream !== 'function') {
      throw new Error('Model provider does not support streaming responses');
    }

    const asyncIterator = await runnable.stream(messages);
    const startedAt = Date.now();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let aggregatedChunk: AIMessageChunk | null = null;
        let lastUsage: TokenUsage | undefined;
  const toolCalls: ToolCallPayload[] = [];

        try {
          for await (const chunk of asyncIterator) {
            aggregatedChunk = aggregatedChunk
              ? aggregatedChunk.concat(chunk)
              : chunk;

            const chunkToolCalls = (chunk as { tool_calls?: unknown }).tool_calls;
            if (Array.isArray(chunkToolCalls)) {
              chunkToolCalls.forEach((call) => {
                toolCalls.push(call as ToolCallPayload);
              });
            }

            const payload = toOpenAIStreamChunk(chunk, {
              model: model.modelId,
              stream: true,
            });

            if (payload.usage) {
              lastUsage = {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
                cachedInputTokens: payload.usage.cached_tokens,
                totalTokens: payload.usage.total_tokens,
              };
            }

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
            );
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();

          const latencyMs = Date.now() - startedAt;
          const usage: TokenUsage = lastUsage
            ? {
              ...lastUsage,
              toolCalls: toolCalls.length || undefined,
            }
            : { toolCalls: toolCalls.length || undefined };

          const providerResponse = aggregatedChunk
            ? aggregatedChunk
            : { tool_calls: toolCalls };

          await logModelUsage(tenantDbName, model, {
            requestId,
            route: 'chat.completions',
            status: 'success',
            providerRequest: sanitizeForLogging({
              model: modelKey,
              messages: body.messages,
              overrides,
              stream: true,
            }),
            providerResponse: sanitizeForLogging(providerResponse),
            latencyMs,
            usage,
          });
        } catch (error: unknown) {
          const latencyMs = Date.now() - startedAt;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await logModelUsage(tenantDbName, model, {
            requestId,
            route: 'chat.completions',
            status: 'error',
            providerRequest: sanitizeForLogging({
              model: modelKey,
              messages: body.messages,
              overrides,
              stream: true,
            }),
            providerResponse: sanitizeForLogging({ error: errorMessage }),
            errorMessage,
            latencyMs,
            usage: {},
          });

          controller.error(error);
        }
      },
    });

    return { stream: readable, requestId };
  }

  const aiMessage = await runnable.invoke(messages);
  const latencyMs = Date.now() - start;
  const response = toOpenAIChatResponse(aiMessage, {
    model: model.modelId,
    stream: false,
  });

  const usage = summarizeUsage(aiMessage) as TokenUsage;
  const toolCallCount = getToolCallCount(aiMessage);
  if (toolCallCount) {
    usage.toolCalls = toolCallCount;
  }

  await logModelUsage(tenantDbName, model, {
    requestId,
    route: 'chat.completions',
    status: 'success',
    providerRequest: sanitizeForLogging({
      model: modelKey,
      messages: body.messages,
      overrides,
      stream: false,
    }),
    providerResponse: sanitizeForLogging(response),
    latencyMs,
    usage,
  });

  return { response, usage, latencyMs, requestId };
}

export async function handleEmbeddingRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  body: EmbeddingRequestBody;
}) {
  const { tenantDbName, modelKey, projectId, body } = params;

  if (!body?.input) {
    throw new Error('`input` is required');
  }

  const requestId = body?.request_id || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  ensureEmbeddingModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createEmbeddingModel) {
    throw new Error('Model provider does not support embeddings');
  }

  const embedder = ensureEmbeddingRunnable(await runtime.createEmbeddingModel({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  }));
  const rawInput = body.input;
  const inputsArray = Array.isArray(rawInput) ? rawInput : [rawInput];
  const inputs = inputsArray.map((value) => {
    if (typeof value !== 'string') {
      throw new Error('`input` must be a string or an array of strings');
    }
    return value;
  });

  const embeddings = await embedder.embedDocuments(inputs);
  const latencyMs = Date.now() - start;

  const tokenEstimate =
    typeof body.input_tokens === 'number'
      ? body.input_tokens
      : typeof body.inputTokenCount === 'number'
        ? body.inputTokenCount
        : 0;

  const usage: TokenUsage = {
    inputTokens: tokenEstimate,
    outputTokens: 0,
    totalTokens: tokenEstimate,
  };

  await logModelUsage(tenantDbName, model, {
    requestId,
    route: 'embeddings',
    status: 'success',
    providerRequest: sanitizeForLogging({
      model: modelKey,
      input: inputs.slice(0, 5),
    }),
    providerResponse: sanitizeForLogging({
      embeddingsLength: embeddings.length,
    }),
    latencyMs,
    usage,
  });

  return {
    response: {
      object: 'list',
      data: embeddings.map((vector, index) => ({
        object: 'embedding',
        index,
        embedding: normalizeEmbeddingVector(vector),
      })),
      model: model.modelId,
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        total_tokens: usage.totalTokens ?? 0,
      },
    },
    latencyMs,
    requestId,
  };
}
