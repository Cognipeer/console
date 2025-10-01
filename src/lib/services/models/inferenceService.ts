import crypto from 'crypto';
import { buildChatModel, buildEmbeddingModel } from './langchainBuilder';
import { getModelByKey } from './modelService';
import { toLangChainMessages, toOpenAIChatResponse, toOpenAIStreamChunk, summarizeUsage } from './openaiAdapter';
import { logModelUsage, TokenUsage } from './usageLogger';
import { IModel } from '@/lib/database';

const encoder = new TextEncoder();

function sanitizeForLogging(payload: any, maxLength = 20000) {
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

function buildOverrides(body: any) {
  const overrides: Record<string, unknown> = {};
  const fields = ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'seed'];

  fields.forEach((field) => {
    if (body[field] !== undefined) {
      overrides[field] = body[field];
    }
  });

  if (body.stop) overrides.stop = body.stop;
  if (body.tools) overrides.tools = body.tools;
  if (body.tool_choice) overrides.tool_choice = body.tool_choice;
  if (body.response_format) overrides.response_format = body.response_format;
  if (body.modality) overrides.modality = body.modality;
  if (body.max_output_tokens) overrides.max_output_tokens = body.max_output_tokens;

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
  body: any;
  stream?: boolean;
}) {
  const { tenantDbName, modelKey, body, stream } = params;

  if (!body?.messages || !Array.isArray(body.messages)) {
    throw new Error('`messages` array is required');
  }

  const requestId = body?.request_id || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  ensureLlmModel(model);

  const messages = toLangChainMessages(body.messages);
  const overrides = buildOverrides(body);

  const chatModel = buildChatModel(model, { streaming: Boolean(stream) });
  const runnable = Object.keys(overrides).length ? chatModel.bind(overrides) : chatModel;

  if (stream) {
    const asyncIterator = await runnable.stream(messages);
    const startedAt = Date.now();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let aggregatedChunk: any = null;
        let lastUsage: TokenUsage | undefined;
        const toolCalls: any[] = [];

        try {
          for await (const chunk of asyncIterator) {
            aggregatedChunk = aggregatedChunk ? aggregatedChunk.concat(chunk) : chunk;

            if (chunk.tool_calls) {
              chunk.tool_calls.forEach((call: any) => {
                toolCalls.push(call);
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

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
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

          const providerResponse = aggregatedChunk ? aggregatedChunk : { tool_calls: toolCalls };

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
        } catch (error: any) {
          const latencyMs = Date.now() - startedAt;
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
            providerResponse: sanitizeForLogging({ error: error?.message }),
            errorMessage: error?.message,
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
  const toolCallCount = Array.isArray((aiMessage as any).tool_calls)
    ? (aiMessage as any).tool_calls.length
    : 0;
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
  body: any;
}) {
  const { tenantDbName, modelKey, body } = params;

  if (!body?.input) {
    throw new Error('`input` is required');
  }

  const requestId = body?.request_id || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  ensureEmbeddingModel(model);

  const embedder = buildEmbeddingModel(model);
  const inputs = Array.isArray(body.input) ? body.input : [body.input];

  const embeddings = await embedder.embedDocuments(inputs);
  const latencyMs = Date.now() - start;

  const tokenEstimate = typeof body.input_tokens === 'number'
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
    providerResponse: sanitizeForLogging({ embeddingsLength: embeddings.length }),
    latencyMs,
    usage,
  });

  return {
    response: {
      object: 'list',
      data: embeddings.map((vector: number[] | Float32Array, index: number) => ({
        object: 'embedding',
        index,
        embedding: Array.from(vector),
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
