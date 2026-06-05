/**
 * Unit tests — Model Provider Contracts
 *
 * Verifies that every model provider contract:
 *  1. createRuntime() returns an object with the expected runtime methods
 *  2. createChatModel() produces a LangChain-compatible object (has .invoke)
 *  3. createEmbeddingModel() produces a LangChain-compatible object (has .embedDocuments)
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

// ── Google Auth mock (Vertex) ────────────────────────────────────────────────
vi.mock('@langchain/google-vertexai', () => {
  const mockInvoke = vi.fn().mockResolvedValue({
    content: 'Hello from mock Vertex!',
    lc_namespace: ['langchain', 'schema'],
  });
  const mockEmbedDocuments = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);

  class FakeVertexAI {
    invoke = mockInvoke;
    stream = vi.fn();
    bindTools = vi.fn().mockReturnThis();
    withStructuredOutput = vi.fn().mockReturnThis();
  }

  class FakeVertexAIEmbeddings {
    embedDocuments = mockEmbedDocuments;
    embedQuery = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
  }

  return { VertexAI: FakeVertexAI, VertexAIEmbeddings: FakeVertexAIEmbeddings };
});

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

// ── Helper ───────────────────────────────────────────────────────────────────

function makeCtx(credentials: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    providerKey: 'test-provider',
    credentials,
    settings,
  };
}

function assertChatModel(model: unknown) {
  expect(model).toBeDefined();
  expect(typeof (model as Record<string, unknown>).invoke).toBe('function');
}

function assertEmbeddingModel(model: unknown) {
  expect(model).toBeDefined();
  expect(typeof (model as Record<string, unknown>).embedDocuments).toBe('function');
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
    expect(typeof runtime.createChatModel).toBe('function');
    expect(typeof runtime.createEmbeddingModel).toBe('function');
  });

  it('createChatModel returns LangChain-compatible object', () => {
    const model = runtime
      .createChatModel!({ modelId: 'gpt-4o', category: 'llm' });
    assertChatModel(model);
  });

  it('createEmbeddingModel returns LangChain-compatible object', () => {
    const model = runtime
      .createEmbeddingModel!({ modelId: 'text-embedding-3-small', category: 'embedding' });
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

  it('createChatModel returns LangChain-compatible object', () => {
    const model = runtime
      .createChatModel!({ modelId: 'mistral-large', category: 'llm' });
    assertChatModel(model);
  });

  it('createEmbeddingModel returns LangChain-compatible object', () => {
    const model = runtime
      .createEmbeddingModel!({ modelId: 'text-embedding', category: 'embedding' });
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

  it('createChatModel returns LangChain-compatible object', () => {
    const model = runtime
      .createChatModel!({ modelId: 'meta-llama/Llama-3.1-70B-Instruct-Turbo', category: 'llm' });
    assertChatModel(model);
  });

  it('createEmbeddingModel returns LangChain-compatible object', () => {
    const model = runtime
      .createEmbeddingModel!({ modelId: 'togethercomputer/m2-bert-80M', category: 'embedding' });
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
    expect(typeof runtime.createChatModel).toBe('function');
    expect(typeof runtime.createEmbeddingModel).toBe('function');
  });

  it('createChatModel returns LangChain-compatible object', () => {
    const model = runtime
      .createChatModel!({ modelId: 'anthropic.claude-3-7-sonnet-v1:0', category: 'llm' });
    assertChatModel(model);
  });

  it('createEmbeddingModel returns LangChain-compatible object', () => {
    const model = runtime
      .createEmbeddingModel!({ modelId: 'amazon.titan-embed-text-v1', category: 'embedding' });
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
    expect(typeof runtime.createChatModel).toBe('function');
    expect(typeof runtime.createEmbeddingModel).toBe('function');
  });

  it('createChatModel returns LangChain-compatible object', () => {
    const model = runtime
      .createChatModel!({ modelId: 'gemini-2.5-flash', category: 'llm' });
    assertChatModel(model);
  });

  it('createEmbeddingModel returns LangChain-compatible object', () => {
    const model = runtime
      .createEmbeddingModel!({ modelId: 'text-embedding-004', category: 'embedding' });
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
    expect(typeof runtime.createChatModel).toBe('function');
    expect(typeof runtime.createEmbeddingModel).toBe('function');
  });

  it('createChatModel returns LangChain-compatible object', () => {
    const model = runtime
      .createChatModel!({ modelId: 'gpt-4o', category: 'llm' });
    assertChatModel(model);
  });

  it('createEmbeddingModel returns LangChain-compatible object', () => {
    const model = runtime
      .createEmbeddingModel!({ modelId: 'text-embedding-ada-002', category: 'embedding' });
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
  it('openai — createChatModel accepts temperature override', () => {
    const runtime = OpenAiModelProviderContract.createRuntime(
      makeCtx({ apiKey: 'sk-test' }) as never,
    ) as unknown as ModelProviderRuntime;
    expect(() =>
      runtime
        .createChatModel!({
          modelId: 'gpt-4o',
          category: 'llm',
          modelSettings: { temperature: 0.7 },
        }),
    ).not.toThrow();
  });

  it('openai — createChatModel accepts reasoning effort override', () => {
    const runtime = OpenAiModelProviderContract.createRuntime(
      makeCtx({ apiKey: 'sk-test' }) as never,
    ) as unknown as ModelProviderRuntime;
    expect(() =>
      runtime
        .createChatModel!({
          modelId: 'o3',
          category: 'llm',
          modelSettings: { reasoning: { effort: 'high' } },
        }),
    ).not.toThrow();
  });

  it('bedrock — createChatModel accepts maxTokens override', () => {
    const runtime = BedrockModelProviderContract.createRuntime(
      makeCtx(
        { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        { region: 'us-east-1' },
      ) as never,
    ) as unknown as ModelProviderRuntime;
    expect(() =>
      runtime
        .createChatModel!({
          modelId: 'anthropic.claude-3-7-sonnet-v1:0',
          category: 'llm',
          modelSettings: { maxTokens: 2048 },
        }),
    ).not.toThrow();
  });
});
