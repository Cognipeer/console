import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }

  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/services/models/modelService', () => ({
  listModels: vi.fn(),
  listModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
  createModel: vi.fn(),
  createDynamicModel: vi.fn(),
  getModelById: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import { getModelById, listModels, updateModel } from '@/lib/services/models/modelService';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { clientModelsApiPlugin } from '@/server/api/plugins/client-models';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
};

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

describe('client model registry', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    const db = createMockDb();
    db.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
    mockFn(getDatabase).mockResolvedValue(db);
    mockFn(getPermissionServiceForPath).mockReturnValue('models');
    mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true, service: 'models', required: 'read' });
    mockFn(listModels).mockResolvedValue([
      {
        _id: 'model-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'Takas AI Flash',
        key: 'takasai-flash',
        providerKey: 'openai-compatible-main',
        providerDriver: 'openai-compatible',
        category: 'llm',
        modelId: 'qwen3.6-27b',
        isMultimodal: false,
        supportsToolCalls: true,
        settings: { apiKey: 'secret', maxTokens: 4096 },
        pricing: { currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0, cachedTokenPer1M: 0 },
        metadata: {
          contextLength: 32768,
          supportsReasoning: false,
          capabilities: {
            contextWindow: 131072,
            maxOutputTokens: 16384,
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsReasoning: true,
            supportsStructuredOutputs: true,
          },
        },
        createdAt: new Date('2026-07-30T14:46:33.177Z'),
      },
      {
        _id: 'model-2',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'Tenant Embedder',
        key: 'tenant-embedder',
        providerKey: 'openai-compatible-main',
        providerDriver: 'openai-compatible',
        category: 'embedding',
        modelId: 'text-embedding-3-large',
        supportsToolCalls: false,
        settings: {},
        pricing: { currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0, cachedTokenPer1M: 0 },
        metadata: {},
        createdAt: new Date('2026-07-30T14:46:33.177Z'),
      },
    ]);
    app = await createFastifyApiTestApp(clientModelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns legacy models plus an OpenAI-shaped discovery list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/models',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{
      object: string;
      data: Array<Record<string, unknown>>;
      models: Array<{
        key: string;
        category: string;
        capabilities: {
          canonicalModelId: string;
          outputModalities: string[];
        };
        settings: { apiKey?: string };
      }>;
    }>(res.body);

    expect(body.object).toBe('list');
    expect(body.models).toHaveLength(2);
    expect(body.models[0]?.settings.apiKey).toBe('••••••••');
    expect(body.models[1]).toEqual(expect.objectContaining({
      key: 'tenant-embedder',
      category: 'embedding',
      capabilities: expect.objectContaining({
        canonicalModelId: 'text-embedding-3-large',
        outputModalities: ['embeddings'],
      }),
    }));
    expect(body.data).toEqual([
      expect.objectContaining({
        id: 'takasai-flash',
        object: 'model',
        name: 'Takas AI Flash',
        owned_by: 'cognipeer',
        context_length: 131072,
        max_output_tokens: 16384,
        supports_image_input: true,
        supports_reasoning: true,
        supports_structured_outputs: true,
        supports_tool_calls: true,
        category: 'llm',
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        cognipeer: expect.objectContaining({
          schema_version: '1.0',
          canonical_model_id: 'qwen3.6-27b',
        }),
      }),
    ]);
  });

  it('normalizes capability updates and preserves masked settings', async () => {
    const existingModel = {
      _id: 'model-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'Public Alias',
      key: 'public-alias',
      providerKey: 'openai-compatible-main',
      providerDriver: 'openai-compatible',
      category: 'llm',
      modelId: 'upstream-model',
      isMultimodal: false,
      supportsToolCalls: true,
      settings: { apiKey: 'real-secret', temperature: 0.7 },
      pricing: {
        currency: 'USD',
        inputTokenPer1M: 0,
        outputTokenPer1M: 0,
        cachedTokenPer1M: 0,
      },
      metadata: {},
    };
    mockFn(getModelById).mockResolvedValue(existingModel);
    mockFn(updateModel).mockResolvedValue(existingModel);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/client/v1/models/model-1',
      headers: { authorization: 'Bearer tok' },
      payload: {
        settings: { apiKey: '••••••••', temperature: 0.9 },
        capabilities: {
          contextWindow: 131072,
          maxOutputTokens: 16384,
          inputModalities: ['text', 'image', 'image'],
          outputModalities: ['text'],
          supportsReasoning: true,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateModel).toHaveBeenCalledWith(
      'tenant_acme',
      'proj-1',
      'model-1',
      expect.objectContaining({
        settings: { apiKey: 'real-secret', temperature: 0.9 },
        capabilities: expect.objectContaining({
          contextWindow: 131072,
          maxOutputTokens: 16384,
          inputModalities: ['text', 'image'],
          supportsReasoning: true,
        }),
      }),
      'user-1',
    );
  });
});
