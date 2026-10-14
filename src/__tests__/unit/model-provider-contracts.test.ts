/**
 * Unit tests — Model Provider Contracts
 *
 * Verifies that every model provider contract:
 *  1. createRuntime() returns an object with the expected runtime methods
 *  2. createNativeChatClient() produces an agent-sdk native chat client (complete / stream)
 *  3. createNativeEmbedder() produces a native embedder (has .embed)
 *  4. Required credential / setting validation throws with a descriptive message
 *
 * AWS Bedrock and Google Vertex use SDK clients that perform auth at
 * construction time — those are mocked at the module level.
 * All other providers rely on HTTP which is intercepted by MSW.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/msw.server';

// ── AWS SDK mock (Bedrock) ───────────────────────────────────────────────────
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Hello from mock Bedrock!' }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 8 },
    }),
  })),
  InvokeModelCommand: vi.fn(),
  ConverseCommand: vi.fn(),
  ConverseStreamCommand: vi.fn(),
}));

// ── Config mock (system providers read from getConfig()) ─────────────────────
// ── MSW lifecycle ────────────────────────────────────────────────────────────────────────────
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

// ── Import contracts after mocks are in place ────────────────────────────────
import {
  OpenAiModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  TogetherModelProviderContract,
  BedrockModelProviderContract,
  VertexModelProviderContract,
  AzureModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { openAiMessagesToNative } from '@/lib/services/models/openaiAdapter';

// ── Helper ───────────────────────────────────────────────────────────────────

function makeCtx(credentials: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    providerKey: 'test-provider',
    credentials,
    settings,
  };
}

function assertChatModel(client: unknown) {
  expect(client).toBeDefined();
  expect(typeof (client as Record<string, unknown>).complete).toBe('function');
  expect(typeof (client as Record<string, unknown>).stream).toBe('function');
}

function assertEmbeddingModel(embedder: unknown) {
  expect(embedder).toBeDefined();
  expect(typeof (embedder as Record<string, unknown>).embed).toBe('function');
}

// ═══════════════════════════════════════════════════════════════════════════════
// openai
// ═══════════════════════════════════════════════════════════════════════════════

describe('openai provider', () => {
  const runtime = OpenAiModelProviderContract.createRuntime(
    makeCtx({ apiKey: 'sk-test-openai' }) as never,
  ) as unknown as ModelProviderRuntime;

  it('createRuntime returns runtime object', () => {
    expect(runtime).toBeDefined();
    expect(typeof runtime.createNativeChatClient).toBe('function');
    expect(typeof runtime.createNativeEmbedder).toBe('function');
  });

  it('createNativeChatClient returns a native chat client', async () => {
    const model = await runtime
      .createNativeChatClient!({ modelId: 'gpt-4o', category: 'llm' });
    assertChatModel(model);
  });

  it('createNativeEmbedder returns a native embedder', async () => {
    const model = await runtime
      .createNativeEmbedder!({ modelId: 'text-embedding-3-small', category: 'embedding' });
    assertEmbeddingModel(model);
  });

  it('throws when apiKey is missing', () => {
    expect(() =>
      OpenAiModelProviderContract.createRuntime(makeCtx({ apiKey: '' }) as never),
    ).toThrow('OpenAI API key is required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// openai-compatible
// ═══════════════════════════════════════════════════════════════════════════════

describe('openai-compatible provider', () => {
  const runtime = OpenAiCompatibleModelProviderContract.createRuntime(
    makeCtx({ apiKey: 'sk-test' }, { baseUrl: 'https://api.custom.com/v1' }) as never,
  ) as unknown as ModelProviderRuntime;

  it('createRuntime returns runtime object', () => {
    expect(runtime).toBeDefined();
  });

  it('createNativeChatClient returns a native chat client', async () => {
    const model = await runtime
      .createNativeChatClient!({ modelId: 'mistral-large', category: 'llm' });
    assertChatModel(model);
  });

  it('preserves canonical vision content in the provider HTTP payload', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.post('https://api.custom.com/v1/chat/completions', async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          id: 'chatcmpl-vision',
          object: 'chat.completion',
          created: 1,
          model: 'vision-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'A test image' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        });
      }),
    );
    const client = await runtime.createNativeChatClient!({
      modelId: 'vision-model',
      category: 'llm',
    });
    const imageUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const messages = openAiMessagesToNative([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: imageUrl },
      ],
    }]);

    await client.complete({ messages });

    expect(capturedBody).toMatchObject({
      model: 'vision-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    });
  });

  it('createNativeEmbedder returns a native embedder', async () => {
    const model = await runtime
      .createNativeEmbedder!({ modelId: 'text-embedding', category: 'embedding' });
    assertEmbeddingModel(model);
  });

  it('throws when apiKey is missing', () => {
    expect(() =>
      OpenAiCompatibleModelProviderContract.createRuntime(
        makeCtx({ apiKey: '' }, { baseUrl: 'https://api.custom.com/v1' }) as never,
      ),
    ).toThrow('API key is required');
  });

  it('throws when baseUrl is missing', () => {
    expect(() =>
      OpenAiCompatibleModelProviderContract.createRuntime(
        makeCtx({ apiKey: 'sk-x' }, { baseUrl: '' }) as never,
      ),
    ).toThrow('Base URL is required');
  });

  it('routes audio operations deployment-scoped when baseUrl is Azure', async () => {
    const azureRuntime = OpenAiCompatibleModelProviderContract.createRuntime(
      makeCtx(
        { apiKey: 'azure-key' },
        { baseUrl: 'https://my-res.openai.azure.com/openai/v1' },
      ) as never,
    ) as unknown as ModelProviderRuntime;

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }));
    try {
      const stt = await azureRuntime.createSttRuntime!({ modelId: 'gpt-4o-transcribe', category: 'stt' });
      await (stt as { transcribe: (input: unknown) => Promise<unknown> }).transcribe({
        audio: { data: Buffer.from('audio'), fileName: 'a.wav', contentType: 'audio/wav' },
      });
      const tts = await azureRuntime.createTtsRuntime!({ modelId: 'gpt-4o-mini-tts', category: 'tts' });
      await (tts as { synthesize: (input: unknown) => Promise<unknown> }).synthesize({
        text: 'hi',
        voice: 'alloy',
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls[0].url).toBe(
      'https://my-res.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview',
    );
    expect(calls[0].headers['api-key']).toBe('azure-key');
    expect(calls[1].url).toBe(
      'https://my-res.openai.azure.com/openai/deployments/gpt-4o-mini-tts/audio/speech?api-version=2025-03-01-preview',
    );
  });

  it('keeps plain baseUrl audio routing for non-Azure hosts', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }));
    try {
      const stt = await runtime.createSttRuntime!({ modelId: 'whisper-1', category: 'stt' });
      await (stt as { transcribe: (input: unknown) => Promise<unknown> }).transcribe({
        audio: { data: Buffer.from('audio'), fileName: 'a.wav', contentType: 'audio/wav' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls[0]).toBe('https://api.custom.com/v1/audio/transcriptions');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// together
// ═══════════════════════════════════════════════════════════════════════════════

describe('together provider', () => {
  const runtime = TogetherModelProviderContract.createRuntime(
    makeCtx({ apiKey: 'together-test-key' }) as never,
  ) as unknown as ModelProviderRuntime;

  it('createRuntime returns runtime object', () => {
    expect(runtime).toBeDefined();
  });

  it('createNativeChatClient returns a native chat client', async () => {
    const model = await runtime
      .createNativeChatClient!({ modelId: 'meta-llama/Llama-3.1-70B-Instruct-Turbo', category: 'llm' });
    assertChatModel(model);
  });

  it('createNativeEmbedder returns a native embedder', async () => {
    const model = await runtime
      .createNativeEmbedder!({ modelId: 'togethercomputer/m2-bert-80M', category: 'embedding' });
    assertEmbeddingModel(model);
  });

  it('throws when apiKey is missing', () => {
    expect(() =>
      TogetherModelProviderContract.createRuntime(makeCtx({ apiKey: '' }) as never),
    ).toThrow('Together API key is required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// bedrock
// ═══════════════════════════════════════════════════════════════════════════════

describe('bedrock provider', () => {
  const runtime = BedrockModelProviderContract.createRuntime(
    makeCtx(
      { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
      { region: 'us-east-1' },
    ) as never,
  ) as unknown as ModelProviderRuntime;

  it('createRuntime returns runtime object', () => {
    expect(runtime).toBeDefined();
    expect(typeof runtime.createNativeChatClient).toBe('function');
    expect(typeof runtime.createNativeEmbedder).toBe('function');
  });

  it('createNativeChatClient returns a native chat client', async () => {
    const model = await runtime
      .createNativeChatClient!({ modelId: 'anthropic.claude-3-7-sonnet-v1:0', category: 'llm' });
    assertChatModel(model);
  });

  it('createNativeEmbedder returns a native embedder', async () => {
    const model = await runtime
      .createNativeEmbedder!({ modelId: 'amazon.titan-embed-text-v1', category: 'embedding' });
    assertEmbeddingModel(model);
  });

  it('throws when accessKeyId is missing', () => {
    expect(() =>
      BedrockModelProviderContract.createRuntime(
        makeCtx({ accessKeyId: '', secretAccessKey: 'secret' }, { region: 'us-east-1' }) as never,
      ),
    ).toThrow('AWS accessKeyId is required');
  });

  it('throws when secretAccessKey is missing', () => {
    expect(() =>
      BedrockModelProviderContract.createRuntime(
        makeCtx({ accessKeyId: 'AKIA', secretAccessKey: '' }, { region: 'us-east-1' }) as never,
      ),
    ).toThrow('AWS secretAccessKey is required');
  });

  it('throws when region is missing', () => {
    expect(() =>
      BedrockModelProviderContract.createRuntime(
        makeCtx({ accessKeyId: 'AKIA', secretAccessKey: 'secret' }, { region: '' }) as never,
      ),
    ).toThrow('AWS region is required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// vertex
// ═══════════════════════════════════════════════════════════════════════════════

describe('vertex provider', () => {
  const validKey = JSON.stringify({ type: 'service_account', project_id: 'test' });

  const runtime = VertexModelProviderContract.createRuntime(
    makeCtx(
      { serviceAccountKey: validKey },
      { projectId: 'test-project', location: 'us-central1' },
    ) as never,
  ) as unknown as ModelProviderRuntime;

  it('createRuntime returns runtime object', () => {
    expect(runtime).toBeDefined();
    expect(typeof runtime.createNativeChatClient).toBe('function');
    expect(typeof runtime.createNativeEmbedder).toBe('function');
  });

  it('createNativeChatClient returns a native chat client', async () => {
    const model = await runtime
      .createNativeChatClient!({ modelId: 'gemini-2.5-flash', category: 'llm' });
    assertChatModel(model);
  });

  it('createNativeEmbedder returns a native embedder', async () => {
    const model = await runtime
      .createNativeEmbedder!({ modelId: 'text-embedding-004', category: 'embedding' });
    assertEmbeddingModel(model);
  });

  it('throws when projectId is missing', () => {
    expect(() =>
      VertexModelProviderContract.createRuntime(
        makeCtx({ serviceAccountKey: validKey }, { projectId: '', location: 'us-central1' }) as never,
      ),
    ).toThrow('Project ID is required');
  });

  it('throws when location is missing', () => {
    expect(() =>
      VertexModelProviderContract.createRuntime(
        makeCtx({ serviceAccountKey: validKey }, { projectId: 'p', location: '' }) as never,
      ),
    ).toThrow('Location is required');
  });

  it('throws when serviceAccountKey is invalid JSON', () => {
    expect(() =>
      VertexModelProviderContract.createRuntime(
        makeCtx({ serviceAccountKey: 'NOT_JSON' }, { projectId: 'p', location: 'us-central1' }) as never,
      ),
    ).toThrow('Invalid Google service account JSON');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// azure
// ═══════════════════════════════════════════════════════════════════════════════

describe('azure provider', () => {
  const runtime = AzureModelProviderContract.createRuntime(
    makeCtx(
      { apiKey: 'azure-key' },
      { instanceName: 'my-resource', deploymentName: 'gpt-4o', apiVersion: '2024-08-01-preview' },
    ) as never,
  ) as unknown as ModelProviderRuntime;

  it('createRuntime returns runtime object', () => {
    expect(runtime).toBeDefined();
    expect(typeof runtime.createNativeChatClient).toBe('function');
    expect(typeof runtime.createNativeEmbedder).toBe('function');
  });

  it('createNativeChatClient returns a native chat client', async () => {
    const model = await runtime
      .createNativeChatClient!({ modelId: 'gpt-4o', category: 'llm' });
    assertChatModel(model);
  });

  it('createNativeEmbedder returns a native embedder', async () => {
    const model = await runtime
      .createNativeEmbedder!({ modelId: 'text-embedding-ada-002', category: 'embedding' });
    assertEmbeddingModel(model);
  });

  it('throws when apiKey is missing', () => {
    expect(() =>
      AzureModelProviderContract.createRuntime(
        makeCtx(
          { apiKey: '' },
          { instanceName: 'r', deploymentName: 'd', apiVersion: 'v' },
        ) as never,
      ),
    ).toThrow('Azure OpenAI API key is required');
  });

  it('throws when instanceName is missing', () => {
    expect(() =>
      AzureModelProviderContract.createRuntime(
        makeCtx(
          { apiKey: 'k' },
          { instanceName: '', deploymentName: 'd', apiVersion: 'v' },
        ) as never,
      ),
    ).toThrow('Azure OpenAI instance name is required');
  });

  it('throws when deploymentName is missing', () => {
    expect(() =>
      AzureModelProviderContract.createRuntime(
        makeCtx(
          { apiKey: 'k' },
          { instanceName: 'r', deploymentName: '', apiVersion: 'v' },
        ) as never,
      ),
    ).toThrow('Azure OpenAI deployment name is required');
  });

  it('throws when apiVersion is missing', () => {
    expect(() =>
      AzureModelProviderContract.createRuntime(
        makeCtx(
          { apiKey: 'k' },
          { instanceName: 'r', deploymentName: 'd', apiVersion: '' },
        ) as never,
      ),
    ).toThrow('Azure OpenAI API version is required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Model settings overrides propagation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Model settings overrides propagation', () => {
  it('openai - a native client accepts a temperature override', async () => {
    const runtime = OpenAiModelProviderContract.createRuntime(
      makeCtx({ apiKey: 'sk-test' }) as never,
    ) as unknown as ModelProviderRuntime;
    await expect(runtime.createNativeChatClient!({ modelId: 'gpt-4o', category: 'llm', modelSettings: { temperature: 0.7 } })).resolves.toBeDefined();
  });

  it('openai - a native client accepts a reasoning effort override', async () => {
    const runtime = OpenAiModelProviderContract.createRuntime(
      makeCtx({ apiKey: 'sk-test' }) as never,
    ) as unknown as ModelProviderRuntime;
    await expect(runtime.createNativeChatClient!({ modelId: 'o3', category: 'llm', modelSettings: { reasoning: { effort: 'high' } } })).resolves.toBeDefined();
  });

  it('bedrock - a native client accepts a maxTokens override', async () => {
    const runtime = BedrockModelProviderContract.createRuntime(
      makeCtx({ accessKeyId: 'AKIA', secretAccessKey: 'secret' }, { region: 'us-east-1' }) as never,
    ) as unknown as ModelProviderRuntime;
    await expect(runtime.createNativeChatClient!({ modelId: 'anthropic.claude-3-7-sonnet-v1:0', category: 'llm', modelSettings: { maxTokens: 2048 } })).resolves.toBeDefined();
  });
});
