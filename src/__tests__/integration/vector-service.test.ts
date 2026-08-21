/**
 * Integration tests — VectorService
 *
 * Tests higher-level service functions with mocked DB,
 * providerService, and providerRegistry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn(() => ({
    userId: 'user-1',
    apiTokenId: 'token-1',
    actorType: 'user',
  })),
}));

vi.mock('@/lib/services/providers/providerService', () => ({
  loadProviderRuntimeData: vi.fn(),
  listProviderConfigs: vi.fn(),
  createProviderConfig: vi.fn(),
  getProviderConfigByKey: vi.fn(),
}));

// Only the registry is mocked: filter parsing and capability checks are pure
// functions the service depends on, so they run for real here.
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers')>()),
  providerRegistry: {
    listDescriptors: vi.fn(),
    getContract: vi.fn(),
    createRuntime: vi.fn(),
  },
}));

import { getDatabase } from '@/lib/database';
import {
  loadProviderRuntimeData,
  listProviderConfigs,
  getProviderConfigByKey,
} from '@/lib/services/providers/providerService';
import { providerRegistry } from '@/lib/providers';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { createMockDb } from '../helpers/db.mock';

import {
  listVectorDrivers,
  listVectorProviders,
  listVectorIndexes,
  createVectorIndex,
  queryVectorIndex,
  upsertVectors,
} from '@/lib/services/vector/vectorService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const PROVIDER_KEY = 'my-pinecone';
const CREATED_BY = 'user-1';

const MOCK_PROVIDER_RECORD = {
  _id: 'prov-1',
  key: PROVIDER_KEY,
  driver: 'pinecone',
  type: 'vector',
  status: 'active',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  name: 'My Pinecone',
  credentials: {},
  settings: {},
  metadata: {},
};

const MOCK_CREDENTIALS = { apiKey: 'pc-secret' };

const MOCK_RUNTIME = {
  createIndex: vi.fn(),
  listIndexes: vi.fn(),
  getIndex: vi.fn(),
  deleteIndex: vi.fn(),
  upsertVectors: vi.fn(),
  queryVectors: vi.fn(),
  deleteVectors: vi.fn(),
};

// IVectorIndexRecord requires: tenantId, providerKey, key, name, externalId, dimension, metric, createdBy
const MOCK_INDEX_RECORD = {
  _id: 'idx-1',
  key: 'my-index',
  name: 'My Index',
  externalId: 'ext-001',
  providerKey: PROVIDER_KEY,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  dimension: 1536,
  metric: 'cosine' as const,
  status: 'active',
  createdBy: CREATED_BY,
};

// ── listVectorDrivers ─────────────────────────────────────────────────────────

describe('listVectorDrivers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to providerRegistry.listDescriptors with domain "vector"', async () => {
    const DESCRIPTORS = [
      { id: 'dummy-vector', name: 'Dummy Vector', domains: ['vector'] },
      { id: 'aws-s3-vectors', name: 'AWS S3 Vectors', domains: ['vector'] },
    ];
    (providerRegistry.listDescriptors as ReturnType<typeof vi.fn>).mockReturnValue(DESCRIPTORS);

    const result = await listVectorDrivers();

    expect(providerRegistry.listDescriptors).toHaveBeenCalledWith('vector');
    expect(result).toEqual(DESCRIPTORS);
  });
});

// ── listVectorProviders ───────────────────────────────────────────────────────

describe('listVectorProviders', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('lists provider configs filtered to vector type', async () => {
    const CONFIGS = [MOCK_PROVIDER_RECORD];
    (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue(CONFIGS);
    (providerRegistry.getContract as ReturnType<typeof vi.fn>).mockReturnValue({
      capabilities: { filtering: true },
    });

    const result = await listVectorProviders(TENANT_DB, TENANT_ID, PROJECT_ID);

    expect(listProviderConfigs).toHaveBeenCalledWith(
      TENANT_DB,
      TENANT_ID,
      expect.objectContaining({ type: 'vector' }),
    );
    expect(result.length).toBe(1);
  });

  it('attaches driver capabilities when contract exists', async () => {
    (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PROVIDER_RECORD]);
    (providerRegistry.getContract as ReturnType<typeof vi.fn>).mockReturnValue({
      capabilities: { namespaces: true },
    });

    const [provider] = await listVectorProviders(TENANT_DB, TENANT_ID, PROJECT_ID);
    expect(provider.driverCapabilities).toEqual({ namespaces: true });
  });
});

// ── listVectorIndexes ─────────────────────────────────────────────────────────

describe('listVectorIndexes', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb({ findVectorIndexByKey: vi.fn().mockResolvedValue(null) });
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    // listVectorIndexes calls getProviderConfigByKey first
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROVIDER_RECORD);
    db.listVectorIndexes.mockResolvedValue([MOCK_INDEX_RECORD]);
  });

  it('switches to tenant DB and calls db.listVectorIndexes', async () => {
    const result = await listVectorIndexes(TENANT_DB, TENANT_ID, PROJECT_ID, PROVIDER_KEY);

    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
    expect(db.listVectorIndexes).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: PROVIDER_KEY }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('my-index');
  });

  it('throws when provider config is not found', async () => {
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      listVectorIndexes(TENANT_DB, TENANT_ID, PROJECT_ID, 'nonexistent-key'),
    ).rejects.toThrow(/not found/i);
  });
});

// ── createVectorIndex ─────────────────────────────────────────────────────────

describe('createVectorIndex', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb({ findVectorIndexByKey: vi.fn().mockResolvedValue(null) });
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: MOCK_PROVIDER_RECORD,
      credentials: MOCK_CREDENTIALS,
    });
    (providerRegistry.createRuntime as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RUNTIME);
    MOCK_RUNTIME.createIndex.mockResolvedValue({ externalId: 'ext-new', metadata: {} });
    db.createVectorIndex.mockResolvedValue(MOCK_INDEX_RECORD);
  });

  const makeInput = (name = 'My New Index') => ({
    name,
    providerKey: PROVIDER_KEY,
    dimension: 1536,
    metric: 'cosine' as const,
    createdBy: CREATED_BY,
  });

  it('builds runtime and calls runtime.createIndex', async () => {
    await createVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, makeInput());

    expect(loadProviderRuntimeData).toHaveBeenCalledWith(
      TENANT_DB,
      expect.objectContaining({ key: PROVIDER_KEY }),
    );
    expect(MOCK_RUNTIME.createIndex).toHaveBeenCalledTimes(1);
    expect(db.createVectorIndex).toHaveBeenCalledTimes(1);
  });

  it('slugifies name to generate unique key', async () => {
    await createVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, makeInput('My Fancy Index!!!'));

    const createCall = db.createVectorIndex.mock.calls[0][0];
    expect(createCall.key).toMatch(/^[a-z0-9-]+$/);
  });

  it('throws when provider type is not vector', async () => {
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: { ...MOCK_PROVIDER_RECORD, type: 'model' },
      credentials: {},
    });

    await expect(
      createVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, makeInput('bad')),
    ).rejects.toThrow(/not a vector provider/i);
  });

  it('throws when provider is not active', async () => {
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: { ...MOCK_PROVIDER_RECORD, status: 'inactive' },
      credentials: {},
    });

    await expect(
      createVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, makeInput('bad')),
    ).rejects.toThrow(/not active/i);
  });
});

// ── queryVectorIndex ──────────────────────────────────────────────────────────

describe('queryVectorIndex', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb({ findVectorIndexByKey: vi.fn().mockResolvedValue(MOCK_INDEX_RECORD) });
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: MOCK_PROVIDER_RECORD,
      credentials: MOCK_CREDENTIALS,
    });
    (providerRegistry.createRuntime as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RUNTIME);
  });

  it('calls runtime.queryVectors and returns matches', async () => {
    const MATCHES = [{ id: 'v1', score: 0.95, metadata: {} }];
    MOCK_RUNTIME.queryVectors.mockResolvedValue({ matches: MATCHES });

    const request = {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: { topK: 5, vector: Array<number>(1536).fill(0.1) },
    };

    const result = await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, request);

    expect(MOCK_RUNTIME.queryVectors).toHaveBeenCalledTimes(1);
    expect(result.matches).toEqual(MATCHES);
  });

  it('passes topK and filter through to runtime', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({ matches: [] });
    // The driver must declare it can push the filter down, or the service
    // rejects the query rather than returning unfiltered results.
    (providerRegistry.getContract as ReturnType<typeof vi.fn>).mockReturnValue({
      capabilities: { 'vector.filterOperators': ['$eq', '$and'] },
    });

    const request = {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: {
        topK: 10,
        vector: Array<number>(1536).fill(0.2),
        filter: { category: 'docs' },
      },
    };

    await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, request);

    const runtimeQueryArg = MOCK_RUNTIME.queryVectors.mock.calls[0][1];
    expect(runtimeQueryArg.topK).toBe(10);
    // The service hands the provider a parsed filter tree, never the raw document.
    expect(runtimeQueryArg.filter).toEqual({
      kind: 'comparison',
      comparison: { op: '$eq', field: 'category', value: 'docs' },
    });
  });

  it('counts the query in the usage rollup', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({
      matches: [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.7 }],
    });

    await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: { topK: 5, vector: Array<number>(1536).fill(0.1) },
    });

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantDbName: TENANT_DB,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        service: 'vector',
        refKey: 'my-index',
        status: 'success',
        units: { matches: 2 },
      }),
    );
  });

  it('counts a failed query as a usage error and writes no query log', async () => {
    MOCK_RUNTIME.queryVectors.mockRejectedValue(new Error('index unreachable'));

    await expect(
      queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
        providerKey: PROVIDER_KEY,
        indexKey: 'my-index',
        query: { topK: 5, vector: Array<number>(1536).fill(0.1) },
      }),
    ).rejects.toThrow('index unreachable');

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'vector', status: 'error', units: { matches: 0 } }),
    );
    expect(db.createVectorQueryLog).not.toHaveBeenCalled();
  });

  it('stamps the query log with the resolved usage attribution', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({ matches: [] });

    await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: { topK: 5, vector: Array<number>(1536).fill(0.1) },
    });

    const [log] = db.createVectorQueryLog.mock.calls[0];
    expect(log.userId).toBe('user-1');
    expect(log.apiTokenId).toBe('token-1');
    expect(log.actorType).toBe('user');
  });

  it('records a query log the analytics panel can aggregate', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({
      matches: [
        { id: 'a', score: 0.9, metadata: {} },
        { id: 'b', score: 0.7, metadata: {} },
      ],
    });

    await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: { topK: 5, vector: Array<number>(1536).fill(0.1) },
    });

    expect(db.createVectorQueryLog).toHaveBeenCalledTimes(1);
    const [log] = db.createVectorQueryLog.mock.calls[0];
    // indexKey must be the record's key — the stats aggregation matches on it.
    expect(log.indexKey).toBe('my-index');
    expect(log.providerKey).toBe(PROVIDER_KEY);
    expect(log.topK).toBe(5);
    expect(log.matchCount).toBe(2);
    expect(log.avgScore).toBeCloseTo(0.8);
    expect(log.filterApplied).toBe(false);
    expect(log.latencyMs).toBeGreaterThanOrEqual(0);
    expect(log.timestamp).toBeInstanceOf(Date);
  });

  it('marks filtered queries in the log', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({ matches: [] });
    (providerRegistry.getContract as ReturnType<typeof vi.fn>).mockReturnValue({
      capabilities: { 'vector.filterOperators': ['$eq'] },
    });

    await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: { topK: 5, vector: Array<number>(1536).fill(0.1), filter: { category: 'docs' } },
    });

    const [log] = db.createVectorQueryLog.mock.calls[0];
    expect(log.filterApplied).toBe(true);
    expect(log.avgScore).toBeUndefined();
    expect(log.matchCount).toBe(0);
  });

  it('still returns results when writing the query log fails', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({ matches: [{ id: 'a', score: 0.5 }] });
    db.createVectorQueryLog.mockRejectedValue(new Error('logging is down'));

    const result = await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: { topK: 5, vector: Array<number>(1536).fill(0.1) },
    });

    expect(result.matches).toHaveLength(1);
  });

  it('returns empty matches when no results', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({ matches: [] });

    const result = await queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      query: { topK: 5, vector: Array<number>(1536).fill(0.0) },
    });

    expect(result.matches).toEqual([]);
  });

  it('rejects a query vector whose dimension does not match the index', async () => {
    MOCK_RUNTIME.queryVectors.mockResolvedValue({ matches: [] });

    await expect(
      queryVectorIndex(TENANT_DB, TENANT_ID, PROJECT_ID, {
        providerKey: PROVIDER_KEY,
        indexKey: 'my-index',
        query: { topK: 5, vector: Array<number>(768).fill(0.1) },
      }),
    ).rejects.toThrow(/768 values but index .* expects 1536/);

    expect(MOCK_RUNTIME.queryVectors).not.toHaveBeenCalled();
  });
});

// ── upsertVectors ─────────────────────────────────────────────────────────────

describe('upsertVectors', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb({ findVectorIndexByKey: vi.fn().mockResolvedValue(MOCK_INDEX_RECORD) });
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: MOCK_PROVIDER_RECORD,
      credentials: MOCK_CREDENTIALS,
    });
    (providerRegistry.createRuntime as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RUNTIME);
    MOCK_RUNTIME.upsertVectors.mockResolvedValue(undefined);
  });

  it('calls runtime.upsertVectors with the provided vectors', async () => {
    const vectors = [
      { id: 'v1', values: Array<number>(1536).fill(0.1), metadata: { text: 'hello' } },
      { id: 'v2', values: Array<number>(1536).fill(0.2), metadata: { text: 'world' } },
    ];

    await upsertVectors(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: PROVIDER_KEY,
      indexKey: 'my-index',
      vectors,
    });

    expect(MOCK_RUNTIME.upsertVectors).toHaveBeenCalledTimes(1);
    const [, passedVectors] = MOCK_RUNTIME.upsertVectors.mock.calls[0];
    expect(passedVectors).toHaveLength(2);
    expect(passedVectors[0].id).toBe('v1');
  });

  it('propagates runtime error', async () => {
    MOCK_RUNTIME.upsertVectors.mockRejectedValue(new Error('Runtime failure'));

    await expect(
      upsertVectors(TENANT_DB, TENANT_ID, PROJECT_ID, {
        providerKey: PROVIDER_KEY,
        indexKey: 'my-index',
        vectors: [{ id: 'v1', values: Array<number>(1536).fill(0.1), metadata: {} }],
      }),
    ).rejects.toThrow('Runtime failure');
  });
});
