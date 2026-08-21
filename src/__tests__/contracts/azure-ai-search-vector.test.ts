/**
 * Contract tests — Azure AI Search Vector Provider (SDK mocked)
 *
 * Azure AI Search document keys may only contain letters, digits, underscore,
 * dash, or equal sign. These tests verify that unsafe caller-supplied ids
 * (e.g. Knowledge Engine's "module:documentId:chunkIndex") are transparently
 * encoded on write (upsert/delete) and decoded on read (query/list), while
 * already-safe ids pass through untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mergeOrUploadDocuments = vi.fn().mockResolvedValue({ results: [] });
const deleteDocuments = vi.fn().mockResolvedValue({ results: [] });
const search = vi.fn();
const createIndex = vi.fn().mockImplementation(async (index: unknown) => index);

vi.mock('@azure/search-documents', () => ({
  AzureKeyCredential: class AzureKeyCredential {
    constructor(public key: string) {}
  },
  SearchIndexClient: class SearchIndexClient {
    createIndex = createIndex;
  },
  SearchClient: class SearchClient {
    mergeOrUploadDocuments = mergeOrUploadDocuments;
    deleteDocuments = deleteDocuments;
    search = search;
  },
}));

import { AzureAiSearchVectorProviderContract } from '@/lib/providers/contracts/azureAiSearchVector.contract';
import type { VectorProviderRuntime, VectorIndexHandle } from '@/lib/providers/domains/vector';

const AZURE_KEY_PATTERN = /^[A-Za-z0-9_\-=]+$/;

/** An index created before filterable metadata existed. */
const HANDLE: VectorIndexHandle = {
  externalId: 'test-index',
  name: 'test-index',
  dimension: 3,
  metric: 'cosine',
};

/** An index created with the flattened, filterable metadata columns. */
const FILTERABLE_HANDLE: VectorIndexHandle = {
  ...HANDLE,
  metadata: { filterSchema: 'kv-v1' },
};

function asyncResults(docs: Array<Record<string, unknown>>) {
  return {
    count: docs.length,
    results: (async function* () {
      for (const doc of docs) {
        yield { document: doc, score: 0.9 };
      }
    })(),
  };
}

async function createRuntime(): Promise<VectorProviderRuntime> {
  return (await AzureAiSearchVectorProviderContract.createRuntime({
    tenantId: 'tenant-test',
    providerKey: 'azure-ai-search-test',
    credentials: { apiKey: 'test-key' },
    settings: { foundryProjectEndpoint: 'https://test.search.windows.net' },
  } as never)) as VectorProviderRuntime;
}

describe('AzureAiSearchVectorProvider — document key encoding', () => {
  let runtime: VectorProviderRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = await createRuntime();
  });

  it('encodes ids with unsafe characters into Azure-safe keys on upsert', async () => {
    const unsafeId = 'akbank-55d99256:6a87cf02fca13acf380663aa:0';
    await runtime.upsertVectors(HANDLE, [
      { id: unsafeId, values: [0.1, 0.2, 0.3], metadata: { a: 1 } },
    ]);

    expect(mergeOrUploadDocuments).toHaveBeenCalledTimes(1);
    const [docs] = mergeOrUploadDocuments.mock.calls[0];
    expect(docs).toHaveLength(1);
    expect(docs[0].id).not.toBe(unsafeId);
    expect(docs[0].id).toMatch(AZURE_KEY_PATTERN);
  });

  it('leaves already-safe ids untouched on upsert', async () => {
    await runtime.upsertVectors(HANDLE, [
      { id: 'safe_id-123=', values: [0.1, 0.2, 0.3] },
    ]);

    const [docs] = mergeOrUploadDocuments.mock.calls[0];
    expect(docs[0].id).toBe('safe_id-123=');
  });

  it('round-trips unsafe ids through queryVectors', async () => {
    const unsafeId = 'akbank-55d99256:6a87cf02fca13acf380663aa:5';
    await runtime.upsertVectors(HANDLE, [
      { id: unsafeId, values: [0.1, 0.2, 0.3], metadata: { chunk: 5 } },
    ]);
    const [docs] = mergeOrUploadDocuments.mock.calls[0];
    const storedKey = docs[0].id as string;

    search.mockReturnValueOnce(
      asyncResults([{ id: storedKey, metadata: JSON.stringify({ chunk: 5 }) }]),
    );

    const result = await runtime.queryVectors(HANDLE, {
      vector: [0.1, 0.2, 0.3],
      topK: 5,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].id).toBe(unsafeId);
    expect(result.matches[0].metadata).toEqual({ chunk: 5 });
  });

  it('round-trips unsafe ids through listVectors', async () => {
    const unsafeId = 'module:doc:0';
    await runtime.upsertVectors(HANDLE, [
      { id: unsafeId, values: [0.1, 0.2, 0.3] },
    ]);
    const storedKey = mergeOrUploadDocuments.mock.calls[0][0][0].id as string;

    search.mockReturnValueOnce(
      asyncResults([{ id: storedKey, vector: [0.1, 0.2, 0.3], metadata: '{}' }]),
    );

    const result = await runtime.listVectors(HANDLE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(unsafeId);
  });

  it('encodes ids consistently on deleteVectors so stored documents are targeted', async () => {
    const unsafeId = 'akbank-55d99256:6a87cf02fca13acf380663aa:2';
    await runtime.upsertVectors(HANDLE, [
      { id: unsafeId, values: [0.1, 0.2, 0.3] },
    ]);
    const storedKey = mergeOrUploadDocuments.mock.calls[0][0][0].id as string;

    await runtime.deleteVectors(HANDLE, [unsafeId, 'safe-id']);

    expect(deleteDocuments).toHaveBeenCalledTimes(1);
    const [, keys] = deleteDocuments.mock.calls[0];
    expect(keys).toEqual([storedKey, 'safe-id']);
  });

  it('produces distinct keys for distinct unsafe ids (no collisions)', async () => {
    const ids = [
      'akbank-55d99256:6a87cf02fca13acf380663aa:0',
      'akbank-55d99256:6a87cf02fca13acf380663aa:1',
      'akbank-55d99256:6a87cf02fca13acf380663ab:0',
    ];
    await runtime.upsertVectors(
      HANDLE,
      ids.map((id) => ({ id, values: [0.1, 0.2, 0.3] })),
    );

    const [docs] = mergeOrUploadDocuments.mock.calls[0];
    const keys = docs.map((d: { id: string }) => d.id);
    expect(new Set(keys).size).toBe(ids.length);
    for (const key of keys) {
      expect(key).toMatch(AZURE_KEY_PATTERN);
    }
  });
});


describe('AzureAiSearchVectorProvider — metadata filtering', () => {
  let runtime: VectorProviderRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = await createRuntime();
  });

  it('creates indexes with filterable metadata columns and marks the schema', async () => {
    const handle = await runtime.createIndex({ name: 'kb', dimension: 3, metric: 'cosine' });

    const [definition] = createIndex.mock.calls[0];
    const fieldNames = (definition.fields as Array<{ name: string; filterable?: boolean }>)
      .filter((f) => f.filterable)
      .map((f) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(['metadata_kv', 'metadata_keys']));
    expect(handle.metadata?.filterSchema).toBe('kv-v1');
  });

  it('writes flattened metadata alongside the JSON blob on filterable indexes', async () => {
    await runtime.upsertVectors(FILTERABLE_HANDLE, [
      { id: 'a', values: [0.1, 0.2, 0.3], metadata: { source: 'crawler', depth: 2 } },
    ]);

    const [docs] = mergeOrUploadDocuments.mock.calls[0];
    expect(docs[0].metadata_kv).toEqual(['source=crawler', 'depth=2']);
    expect(docs[0].metadata_keys).toEqual(['source', 'depth']);
    expect(JSON.parse(docs[0].metadata)).toEqual({ source: 'crawler', depth: 2 });
  });

  it('omits the flattened columns on pre-existing indexes that lack them', async () => {
    await runtime.upsertVectors(HANDLE, [
      { id: 'a', values: [0.1, 0.2, 0.3], metadata: { source: 'crawler' } },
    ]);

    const [docs] = mergeOrUploadDocuments.mock.calls[0];
    expect(docs[0].metadata_kv).toBeUndefined();
    expect(docs[0].metadata_keys).toBeUndefined();
  });

  it('pushes the filter down as an OData expression', async () => {
    search.mockReturnValueOnce(asyncResults([]));

    await runtime.queryVectors(FILTERABLE_HANDLE, {
      vector: [0.1, 0.2, 0.3],
      topK: 5,
      filter: {
        kind: 'comparison',
        comparison: { op: '$eq', field: 'source', value: 'crawler' },
      },
    });

    const [, options] = search.mock.calls[0];
    expect(options.filter).toBe("metadata_kv/any(kv: kv eq 'source=crawler')");
  });

  it('rejects a filtered query against an index without the filterable schema', async () => {
    await expect(
      runtime.queryVectors(HANDLE, {
        vector: [0.1, 0.2, 0.3],
        topK: 5,
        filter: {
          kind: 'comparison',
          comparison: { op: '$eq', field: 'source', value: 'crawler' },
        },
      }),
    ).rejects.toThrow(/Recreate the index/);
  });

  it('leaves unfiltered queries alone', async () => {
    search.mockReturnValueOnce(asyncResults([]));
    await runtime.queryVectors(HANDLE, { vector: [0.1, 0.2, 0.3], topK: 5 });

    const [, options] = search.mock.calls[0];
    expect(options.filter).toBeUndefined();
  });
});
