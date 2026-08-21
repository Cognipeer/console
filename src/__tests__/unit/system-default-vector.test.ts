/**
 * Contract tests — System Default vector provider (S3 Vectors SDK mocked).
 *
 * This is the SaaS default provider, so every Knowledge Engine module that does
 * not pick a store of its own lands here. The two things asserted are the exact
 * command input it sends (a compound filter used to arrive as
 * `{"$and":{"$eq":[…]}}`, which S3 Vectors rejects) and that metadata written
 * by `upsertVectors` reads back unchanged through `queryVectors`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3vectors', () => {
  class MockCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    S3VectorsClient: class S3VectorsClient {
      send = send;
    },
    CreateIndexCommand: class CreateIndexCommand extends MockCommand {},
    DeleteIndexCommand: class DeleteIndexCommand extends MockCommand {},
    ListIndexesCommand: class ListIndexesCommand extends MockCommand {},
    PutVectorsCommand: class PutVectorsCommand extends MockCommand {},
    QueryVectorsCommand: class QueryVectorsCommand extends MockCommand {},
    DeleteVectorsCommand: class DeleteVectorsCommand extends MockCommand {},
    GetIndexCommand: class GetIndexCommand extends MockCommand {},
    ListVectorsCommand: class ListVectorsCommand extends MockCommand {},
  };
});

import { SystemDefaultVectorProviderContract } from '@/lib/providers/contracts/systemDefaultVector.contract';
import { parseVectorFilter, type VectorFilterNode } from '@/lib/providers/domains/vectorFilter';
import type { VectorIndexHandle, VectorProviderRuntime } from '@/lib/providers/domains/vector';

const HANDLE: VectorIndexHandle = {
  externalId: 'cognipeer-acme',
  name: 'cognipeer-acme',
  dimension: 3,
  metric: 'cosine',
};

function parse(filter: unknown): VectorFilterNode {
  const node = parseVectorFilter(filter);
  if (!node) throw new Error('expected a parsed filter');
  return node;
}

function lastCommandInput(): Record<string, unknown> {
  const calls = send.mock.calls;
  return (calls[calls.length - 1][0] as { input: Record<string, unknown> }).input;
}

async function createRuntime(): Promise<VectorProviderRuntime> {
  return (await SystemDefaultVectorProviderContract.createRuntime({
    tenantId: 'tenant-test',
    tenantSlug: 'acme',
    providerKey: 'system-default',
    credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    settings: { region: 'us-east-1', vectorBucketName: 'vectors' },
  } as never)) as VectorProviderRuntime;
}

describe('SystemDefaultVectorProvider — filter push-down', () => {
  let runtime: VectorProviderRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = await createRuntime();
  });

  it('sends a compound filter as an $and array', async () => {
    send.mockResolvedValueOnce({ vectors: [] });

    await runtime.queryVectors(HANDLE, {
      vector: [0.1, 0.2, 0.3],
      topK: 5,
      filter: parse({ source: 'crawler', category: 'tech' }),
    });

    expect(lastCommandInput().filter).toEqual({
      $and: [{ source: { $eq: 'crawler' } }, { category: { $eq: 'tech' } }],
    });
  });

  it('sends the module isolation guard ANDed with a caller filter', async () => {
    send.mockResolvedValueOnce({ vectors: [] });

    await runtime.queryVectors(HANDLE, {
      vector: [0.1, 0.2, 0.3],
      topK: 5,
      filter: parse({ $and: [{ source: 'crawler' }, { _ragModule: 'my-rag' }] }),
    });

    expect(lastCommandInput().filter).toEqual({
      $and: [{ source: { $eq: 'crawler' } }, { _ragModule: { $eq: 'my-rag' } }],
    });
  });

  it('sends a single condition unwrapped', async () => {
    send.mockResolvedValueOnce({ vectors: [] });

    await runtime.queryVectors(HANDLE, {
      vector: [0.1, 0.2, 0.3],
      topK: 5,
      filter: parse({ _ragModule: 'my-rag' }),
    });

    expect(lastCommandInput().filter).toEqual({ _ragModule: { $eq: 'my-rag' } });
  });

  it('omits the filter entirely when the caller passes none', async () => {
    send.mockResolvedValueOnce({ vectors: [] });

    await runtime.queryVectors(HANDLE, { vector: [0.1, 0.2, 0.3], topK: 5 });

    expect(lastCommandInput().filter).toBeUndefined();
  });
});

describe('SystemDefaultVectorProvider — metadata round-trip', () => {
  let runtime: VectorProviderRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = await createRuntime();
  });

  it('reads back the plain JSON document that upsertVectors wrote', async () => {
    const metadata = {
      _ragModule: 'my-rag',
      _documentId: 'doc-1',
      _fileName: 'handbook.pdf',
      _chunkIndex: 3,
      draft: false,
    };

    send.mockResolvedValueOnce({});
    await runtime.upsertVectors(HANDLE, [{ id: 'v1', values: [0.1, 0.2, 0.3], metadata }]);

    const written = (lastCommandInput().vectors as Array<{ metadata: unknown }>)[0].metadata;
    expect(written).toEqual(metadata);

    send.mockResolvedValueOnce({
      vectors: [{ key: 'v1', distance: 0.25, metadata: written }],
    });

    const result = await runtime.queryVectors(HANDLE, { vector: [0.1, 0.2, 0.3], topK: 5 });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].metadata).toEqual(metadata);
    expect(result.matches[0].score).toBeCloseTo(0.75);
  });

  it('asks S3 Vectors for distance and metadata', async () => {
    send.mockResolvedValueOnce({ vectors: [] });
    await runtime.queryVectors(HANDLE, { vector: [0.1, 0.2, 0.3], topK: 5 });

    const input = lastCommandInput();
    expect(input.returnDistance).toBe(true);
    expect(input.returnMetadata).toBe(true);
  });

  it('leaves metadata undefined when a hit carries none', async () => {
    send.mockResolvedValueOnce({ vectors: [{ key: 'v1', distance: 0.1 }] });

    const result = await runtime.queryVectors(HANDLE, { vector: [0.1, 0.2, 0.3], topK: 5 });
    expect(result.matches[0].metadata).toBeUndefined();
  });
});
