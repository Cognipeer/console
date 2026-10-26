/**
 * Unit tests — ModelService
 * Tests: listModels, getModelByKey, getModelById, deleteModel, updateModel,
 *        getUsageAggregate, listUsageLogs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

// Mock providerService to isolate modelService
vi.mock('@/lib/services/providers/providerService', () => ({
  getProviderConfigByKey: vi.fn(),
  listProviderConfigs: vi.fn(),
  createProviderConfig: vi.fn(),
}));

// Mock providerRegistry to avoid contract setup
vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    getContract: vi.fn().mockImplementation(() => ({ capabilities: {} })),
  },
}));

import { getDatabase } from '@/lib/database';
import { getProviderConfigByKey } from '@/lib/services/providers/providerService';
import { createMockDb } from '../helpers/db.mock';
import {
  listModels,
  getModelByKey,
  getModelById,
  deleteModel,
  listUsageLogs,
  validateDynamicConfigReferences,
} from '@/lib/services/models/modelService';
import type { IModel } from '@/lib/database';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

function makeModel(overrides: Partial<IModel> = {}): IModel {
  return {
    _id: 'model-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: 'GPT-4o',
    key: 'gpt-4o',
    providerKey: 'openai-main',
    providerDriver: 'openai',
    category: 'llm',
    modelId: 'gpt-4o',
    pricing: {
      currency: 'USD',
      inputTokenPer1M: 5,
      outputTokenPer1M: 15,
      cachedTokenPer1M: 0,
    },
    settings: {},
    isMultimodal: false,
    supportsToolCalls: true,
    metadata: {},
    createdBy: 'user-1',
    ...overrides,
  };
}

// ── listModels ────────────────────────────────────────────────────────────────

describe('listModels', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listModels.mockResolvedValue([makeModel()]);
  });

  it('returns all models for a project', async () => {
    const result = await listModels(TENANT_DB, PROJECT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('gpt-4o');
  });

  it('calls switchToTenant with correct DB name', async () => {
    await listModels(TENANT_DB, PROJECT_ID);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('passes filter options to db.listModels', async () => {
    await listModels(TENANT_DB, PROJECT_ID, { category: 'llm', providerKey: 'openai-main' });
    expect(db.listModels).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'llm', providerKey: 'openai-main', projectId: PROJECT_ID }),
    );
  });

  it('returns empty array when no models exist', async () => {
    db.listModels.mockResolvedValue([]);
    const result = await listModels(TENANT_DB, PROJECT_ID);
    expect(result).toHaveLength(0);
  });
});

// ── getModelByKey ─────────────────────────────────────────────────────────────

describe('getModelByKey', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns model when found', async () => {
    db.findModelByKey.mockResolvedValue(makeModel());
    const result = await getModelByKey(TENANT_DB, 'gpt-4o', PROJECT_ID);
    expect(result).not.toBeNull();
    expect(result!.key).toBe('gpt-4o');
  });

  it('returns null when not found', async () => {
    db.findModelByKey.mockResolvedValue(null);
    const result = await getModelByKey(TENANT_DB, 'nonexistent', PROJECT_ID);
    expect(result).toBeNull();
  });
});

// ── getModelById ──────────────────────────────────────────────────────────────

describe('getModelById', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns model when found', async () => {
    db.findModelById.mockResolvedValue(makeModel());
    const result = await getModelById(TENANT_DB, 'model-1', PROJECT_ID);
    expect(result).not.toBeNull();
    expect(result!._id).toBe('model-1');
  });

  it('returns null when not found', async () => {
    db.findModelById.mockResolvedValue(null);
    const result = await getModelById(TENANT_DB, 'missing', PROJECT_ID);
    expect(result).toBeNull();
  });
});

// ── deleteModel ───────────────────────────────────────────────────────────────

describe('deleteModel', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns true when model is deleted', async () => {
    db.findModelById.mockResolvedValue(makeModel());
    db.deleteModel.mockResolvedValue(true);
    const result = await deleteModel(TENANT_DB, PROJECT_ID, 'model-1');
    expect(result).toBe(true);
  });

  it('returns false when model not found', async () => {
    db.findModelById.mockResolvedValue(null);
    db.deleteModel.mockResolvedValue(false);
    const result = await deleteModel(TENANT_DB, PROJECT_ID, 'missing');
    expect(result).toBe(false);
  });

  it('switches to correct tenant DB', async () => {
    db.findModelById.mockResolvedValue(makeModel());
    db.deleteModel.mockResolvedValue(true);
    await deleteModel(TENANT_DB, PROJECT_ID, 'model-1');
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('drops the cached model so a deleted model stops serving immediately', async () => {
    const model = makeModel({ key: 'cached-then-deleted' });
    db.findModelByKey.mockResolvedValue(model);
    expect(await getModelByKey(TENANT_DB, 'cached-then-deleted', PROJECT_ID)).not.toBeNull();

    db.findModelById.mockResolvedValue(model);
    db.deleteModel.mockResolvedValue(true);
    db.findModelByKey.mockResolvedValue(null);
    await deleteModel(TENANT_DB, PROJECT_ID, 'model-1');

    expect(await getModelByKey(TENANT_DB, 'cached-then-deleted', PROJECT_ID)).toBeNull();
  });
});

// ── listUsageLogs ─────────────────────────────────────────────────────────────

describe('listUsageLogs', () => {
  let db: ReturnType<typeof createMockDb>;

  const mockLog = {
    _id: 'log-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    modelKey: 'gpt-4o',
    requestId: 'req-1',
    route: '/chat/completions',
    status: 'success' as const,
    providerRequest: {},
    providerResponse: {},
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    latencyMs: 800,
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listModelUsageLogs.mockResolvedValue([mockLog]);
  });

  it('returns usage logs', async () => {
    const result = await listUsageLogs(TENANT_DB, 'gpt-4o', PROJECT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].modelKey).toBe('gpt-4o');
  });

  it('calls switchToTenant with correct DB name', async () => {
    await listUsageLogs(TENANT_DB, 'gpt-4o', PROJECT_ID);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('returns empty array when no logs exist', async () => {
    db.listModelUsageLogs.mockResolvedValue([]);
    const result = await listUsageLogs(TENANT_DB, 'gpt-4o', PROJECT_ID);
    expect(result).toHaveLength(0);
  });
});

// ── listModelDriverDescriptors (via providerRegistry) ─────────────────────────

describe('createModel - provider validation', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('throws when model provider configuration not found', async () => {
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { createModel } = await import('@/lib/services/models/modelService');

    await expect(
      createModel(TENANT_DB, TENANT_ID, PROJECT_ID, 'user-1', {
        name: 'My Model',
        providerKey: 'missing-provider',
        category: 'llm',
        modelId: 'gpt-4o',
        pricing: { currency: 'USD', inputTokenPer1M: 5, outputTokenPer1M: 15, cachedTokenPer1M: 0 },
        settings: {},
      }),
    ).rejects.toThrow('is not available in this project');
  });

  it('throws when provider type is not model', async () => {
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: 'pinecone-main',
      type: 'vector', // wrong type
      driver: 'pinecone',
      label: 'Pinecone',
      hasCredentials: true,
      status: 'active',
    });

    const { createModel } = await import('@/lib/services/models/modelService');

    await expect(
      createModel(TENANT_DB, TENANT_ID, PROJECT_ID, 'user-1', {
        name: 'My Model',
        providerKey: 'pinecone-main',
        category: 'llm',
        modelId: 'gpt-4o',
        pricing: { currency: 'USD', inputTokenPer1M: 5, outputTokenPer1M: 15, cachedTokenPer1M: 0 },
        settings: {},
      }),
    ).rejects.toThrow('Provider is not configured for model operations.');
  });
});

describe('createModel - key clash', () => {
  let db: ReturnType<typeof createMockDb>;
  const provider = { key: 'openai-main', type: 'model', driver: 'openai', label: 'OpenAI', hasCredentials: true, status: 'active', driverCapabilities: {} };
  const input = (extra: object) => ({
    name: 'My Model', providerKey: 'openai-main', category: 'llm' as const, modelId: 'gpt-4o',
    pricing: { currency: 'USD', inputTokenPer1M: 5, outputTokenPer1M: 15, cachedTokenPer1M: 0 }, settings: {}, ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
    db.findModelByKey.mockImplementation(async (key: string) => (key === 'taken' || key === 'my-model' ? makeModel({ key }) : null));
    db.createModel.mockImplementation((async (m: object) => m) as never);
  });

  it('a key the caller names that is taken is a ModelKeyConflictError, nothing is created', async () => {
    const { createModel } = await import('@/lib/services/models/modelService');
    const { ModelKeyConflictError } = await import('@/lib/services/models/modelCapabilities');
    await expect(createModel(TENANT_DB, TENANT_ID, PROJECT_ID, 'user-1', input({ key: 'taken' }))).rejects.toBeInstanceOf(ModelKeyConflictError);
    expect(db.createModel).not.toHaveBeenCalled();
  });

  it('a key derived from the name still gets a suffix', async () => {
    const { createModel } = await import('@/lib/services/models/modelService');
    const created = await createModel(TENANT_DB, TENANT_ID, PROJECT_ID, 'user-1', input({}));
    expect(created.key).toBe('my-model-2');
  });

  it('keeps blank cache prices absent and every other pricing field; drops invalid values', async () => {
    const { createModel } = await import('@/lib/services/models/modelService');
    await createModel(TENANT_DB, TENANT_ID, PROJECT_ID, 'user-1', input({
      pricing: {
        inputTokenPer1M: 5,
        outputTokenPer1M: 15,
        cacheWriteTokenPer1M: 6.25,
        inputSecondPer1K: 0.4,
        inputCharacterPer1M: 15,
        pagePer1K: 1.5,
        imagePer1K: 40,
        cachedTokenPer1M: undefined,
        outputSecondPer1K: -1,
      },
    }));
    const saved = db.createModel.mock.calls[0][0] as unknown as { pricing: Record<string, unknown> };
    expect(saved.pricing).toEqual({
      currency: 'USD',
      inputTokenPer1M: 5,
      outputTokenPer1M: 15,
      cacheWriteTokenPer1M: 6.25,
      inputSecondPer1K: 0.4,
      inputCharacterPer1M: 15,
      pagePer1K: 1.5,
      imagePer1K: 40,
    });
    expect('cachedTokenPer1M' in saved.pricing).toBe(false);
  });

  it('keeps an explicit cache-read price', async () => {
    const { createModel } = await import('@/lib/services/models/modelService');
    await createModel(TENANT_DB, TENANT_ID, PROJECT_ID, 'user-1', input({
      pricing: { currency: 'EUR', inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0.3 },
    }));
    const saved = db.createModel.mock.calls[0][0] as unknown as { pricing: Record<string, unknown> };
    expect(saved.pricing).toEqual({ currency: 'EUR', inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0.3 });
  });
});

// ── validateDynamicConfigReferences ───────────────────────────────────────────

describe('validateDynamicConfigReferences', () => {
  let db: ReturnType<typeof createMockDb>;
  const known: Record<string, IModel> = {
    small: makeModel({ key: 'small' }),
    big: makeModel({ key: 'big' }),
    embed: makeModel({ key: 'embed', category: 'embedding' }),
    judge: makeModel({ key: 'judge', category: 'decision' }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    db.findModelByKey.mockImplementation(async (key: string) => known[key] ?? null);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  const config = (extra: object = {}) => ({
    strategy: 'rule-based' as const,
    defaultModelKey: 'small',
    rules: [
      {
        label: 'r',
        target: { pool: [{ modelKey: 'small' }, { modelKey: 'big' }] },
        conditions: [{ signal: 'messageCount' as const, operator: 'gt' as const, value: 1 }],
      },
    ],
    ...extra,
  });

  it('accepts a config whose targets all exist', async () => {
    await expect(validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, config(), 'router')).resolves.toBeUndefined();
  });

  it('names every unknown model key', async () => {
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, config({ fallbackModelKey: 'typo', guards: { economyModelKey: 'nope' } }), 'router'),
    ).rejects.toThrow('Unknown model keys in routing config: typo, nope');
  });

  it('rejects a non-LLM target and self-routing', async () => {
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, config({ defaultModelKey: 'embed' }), 'router'),
    ).rejects.toThrow(/not an LLM/);
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, config({ fallbackModelKey: 'router' }), 'router'),
    ).rejects.toThrow(/cannot route to itself/);
  });

  const modelBased = (decider: { modelKey: string }, extra: object = {}) => ({
    strategy: 'model-based' as const,
    defaultModelKey: 'small',
    decider: { labels: [{ label: 'hard', description: 'hard', targetModelKey: 'big' }], ...decider },
    ...extra,
  });

  it('accepts a decision model as the decider and as the complexity scorer', async () => {
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, modelBased({ modelKey: 'judge' }), 'router'),
    ).resolves.toBeUndefined();
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, config({ complexity: { modelKey: 'judge', levels: ['a', 'b'] } }), 'router'),
    ).resolves.toBeUndefined();
  });

  it('rejects a new chat (llm) decider but keeps one the config already had', async () => {
    const chat = modelBased({ modelKey: 'small' });
    await expect(validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, chat, 'router')).rejects.toThrow(
      /not a decision model and cannot be the decider/,
    );
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, chat, 'router', modelBased({ modelKey: 'small' })),
    ).resolves.toBeUndefined();
    // Swapping to a different chat model is a new attachment.
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, modelBased({ modelKey: 'big' }), 'router', modelBased({ modelKey: 'small' })),
    ).rejects.toThrow(/not a decision model/);
  });

  it('rejects a chat model as the complexity scorer, always', async () => {
    await expect(
      validateDynamicConfigReferences(TENANT_DB, PROJECT_ID, config({ complexity: { modelKey: 'small', levels: ['a', 'b'] } }), 'router'),
    ).rejects.toThrow(/complexity scorer/);
  });
});
