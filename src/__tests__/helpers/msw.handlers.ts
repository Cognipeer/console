/**
 * Default MSW handlers for external provider APIs.
 * These mock the HTTP calls made by LangChain / provider SDKs
 * so tests never hit real external services.
 */

import { http, HttpResponse } from 'msw';

// ── OpenAI ─────────────────────────────────────────────────────────────────

const openaiChatCompletionsHandler = http.post(
  'https://api.openai.com/v1/chat/completions',
  () =>
    HttpResponse.json({
      id: 'chatcmpl-test-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from mock OpenAI!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }),
);

const openaiEmbeddingsHandler = http.post(
  'https://api.openai.com/v1/embeddings',
  () =>
    HttpResponse.json({
      object: 'list',
      data: [
        {
          object: 'embedding',
          index: 0,
          embedding: Array.from({ length: 1536 }, (_, i) => i * 0.001),
        },
      ],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 5, total_tokens: 5 },
    }),
);

const openaiModelsHandler = http.get('https://api.openai.com/v1/models', () =>
  HttpResponse.json({
    object: 'list',
    data: [{ id: 'gpt-4o', object: 'model' }],
  }),
);

// ── Together AI ─────────────────────────────────────────────────────────────

const togetherChatHandler = http.post(
  'https://api.together.xyz/v1/chat/completions',
  () =>
    HttpResponse.json({
      id: 'together-test-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from mock Together!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }),
);

const togetherEmbeddingsHandler = http.post(
  'https://api.together.xyz/v1/embeddings',
  () =>
    HttpResponse.json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 768 }, () => 0.1) }],
    }),
);

// ── AWS Bedrock (uses AWS SDK, not plain HTTP — covered separately) ──────────

// ── Export ───────────────────────────────────────────────────────────────────

export const defaultHandlers = [
  openaiChatCompletionsHandler,
  openaiEmbeddingsHandler,
  openaiModelsHandler,
  togetherChatHandler,
  togetherEmbeddingsHandler,
];
