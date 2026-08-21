/**
 * Unit tests — hybrid (dense + keyword) retrieval
 *
 * Two things here are load-bearing. The first is the score scale: Reciprocal
 * Rank Fusion produces numbers around 1/60, and every caller downstream
 * thresholds against cosine similarity — a module with `defaultMinScore: 0.5`
 * would return nothing at all the moment hybrid was switched on. The second is
 * honesty: an adapter that cannot run the keyword channel must say so instead
 * of handing back dense results labelled as fused.
 *
 * The per-adapter cases assert query construction against a mocked client, so
 * a change to one Elasticsearch contract that skips its two near-identical
 * siblings shows up here rather than in production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const esSearch = vi.fn();
const esBulk = vi.fn().mockResolvedValue({ errors: false });
const esIndicesExists = vi.fn().mockResolvedValue(false);
const esIndicesCreate = vi.fn().mockResolvedValue({});

vi.mock('@elastic/elasticsearch', () => ({
  Client: class Client {
    search = esSearch;
    bulk = esBulk;
    indices = { exists: esIndicesExists, create: esIndicesCreate };
  },
}));

const azureSearch = vi.fn();
const azureCreateIndex = vi.fn().mockImplementation(async (index: unknown) => index);
const azureMergeOrUpload = vi.fn().mockResolvedValue({ results: [] });

vi.mock('@azure/search-documents', () => ({
  AzureKeyCredential: class AzureKeyCredential {
    constructor(public key: string) {}
  },
  SearchIndexClient: class SearchIndexClient {
    createIndex = azureCreateIndex;
  },
  SearchClient: class SearchClient {
    search = azureSearch;
    mergeOrUploadDocuments = azureMergeOrUpload;
  },
}));

const pgQuery = vi.fn();

vi.mock('pg', () => ({
  Pool: class Pool {
    async connect() {
      return { query: pgQuery, release: () => undefined };
    }
    async end() {
      return undefined;
    }
  },
}));

const mongoAggregate = vi.fn();
const mongoBulkWrite = vi.fn().mockResolvedValue({});
const mongoFindOne = vi.fn().mockResolvedValue(null);

vi.mock('mongodb', () => ({
  MongoClient: class MongoClient {
    async connect() {
      return this;
    }
    async close() {
      return undefined;
    }
    db() {
      return {
        collection: () => ({
          aggregate: (pipeline: unknown) => ({
            toArray: () => mongoAggregate(pipeline),
          }),
          bulkWrite: mongoBulkWrite,
          findOne: mongoFindOne,
        }),
      };
    }
  },
}));

import {
  DEFAULT_RRF_K,
  describeHybrid,
  extractVectorText,
  fuseHybridMatches,
  normalizeFusedScore,
  resolveHybridOptions,
} from '@/lib/providers/domains/vectorHybrid';
import type { VectorIndexHandle, VectorProviderRuntime } from '@/lib/providers/domains/vector';
import { CORE_PROVIDER_CONTRACTS } from '@/lib/providers/contracts';
import { ElasticsearchVectorProviderContract } from '@/lib/providers/contracts/elasticsearchVector.contract';
import { AzureAiSearchVectorProviderContract } from '@/lib/providers/contracts/azureAiSearchVector.contract';
import { PostgresVectorProviderContract } from '@/lib/providers/contracts/postgresVector.contract';
import { MongoDbVectorProviderContract } from '@/lib/providers/contracts/mongodbVector.contract';

/** The RRF score of a document that tops both channels — the scale's ceiling. */
const RRF_BEST = 2 / (DEFAULT_RRF_K + 1);
/** The RRF score of a document that tops the dense channel and only that one. */
const RRF_SINGLE_BEST = 1 / (DEFAULT_RRF_K + 1);

const MIN_SCORE = 0.5;

function rankedHits(prefix: string, count: number, from = 1): Array<{ id: string; score: number }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + from}`,
    score: 1 - index * 0.01,
  }));
}

// ── Score normalisation ───────────────────────────────────────────────────────

describe('normalizeFusedScore', () => {
  it('maps the theoretical best fusion to 1', () => {
    expect(normalizeFusedScore(RRF_BEST)).toBeCloseTo(1, 10);
  });

  it('lifts raw RRF scores clear of a cosine minScore', () => {
    // The raw number an untouched RRF pipeline would hand back.
    expect(RRF_BEST).toBeLessThan(0.05);
    expect(normalizeFusedScore(RRF_BEST)).toBeGreaterThan(MIN_SCORE);
    expect(normalizeFusedScore(RRF_SINGLE_BEST)).toBeGreaterThan(MIN_SCORE);
  });

  it('stays monotone in the fused score', () => {
    const ranks = [1, 2, 5, 10, 30, 60];
    const scores = ranks.map((rank) => normalizeFusedScore(2 / (DEFAULT_RRF_K + rank)));
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it('is anchored on the theoretical maximum, not on the best score seen', () => {
    // A page of uniformly deep matches must stay low. Anything min-max scaled
    // would have promoted the least bad of them to 1.0.
    const deep = normalizeFusedScore(2 / (DEFAULT_RRF_K + 400));
    expect(deep).toBeLessThan(MIN_SCORE);
  });

  it('clamps out-of-range input', () => {
    expect(normalizeFusedScore(0)).toBe(0);
    expect(normalizeFusedScore(-1)).toBe(0);
    expect(normalizeFusedScore(RRF_BEST * 10)).toBe(1);
    expect(normalizeFusedScore(Number.NaN)).toBe(0);
  });
});

// ── Fusion ────────────────────────────────────────────────────────────────────

describe('fuseHybridMatches — rrf', () => {
  it('promotes a document both channels agree on over a dense-only leader', () => {
    const fused = fuseHybridMatches({
      dense: [{ id: 'dense-only' }, { id: 'both' }, { id: 'c' }].map((hit, index) => ({
        ...hit,
        score: 0.9 - index * 0.05,
      })),
      lexical: [{ id: 'both', score: 12 }, { id: 'keyword-only', score: 3 }],
      topK: 4,
    });

    expect(fused.map((match) => match.id)).toEqual([
      'both',
      'dense-only',
      'keyword-only',
      'c',
    ]);
  });

  it('does not collapse a fused result set under a 0.5 threshold', () => {
    // The regression this whole scale exists for: 20 dense hits, 20 keyword
    // hits, half of them shared. Raw RRF scores would all be ~0.016 and every
    // one of them would be discarded by ragService's default minScore.
    const fused = fuseHybridMatches({
      dense: rankedHits('d', 20),
      lexical: rankedHits('d', 10).concat(rankedHits('k', 10)),
      topK: 10,
    });

    expect(fused).toHaveLength(10);
    for (const match of fused) {
      expect(match.score).toBeGreaterThan(MIN_SCORE);
      expect(match.score).toBeLessThanOrEqual(1);
    }
  });

  it('keeps each document once and carries both channel scores', () => {
    const fused = fuseHybridMatches({
      dense: [{ id: 'a', score: 0.82, metadata: { source: 'crawler' } }],
      lexical: [{ id: 'a', score: 7.5 }],
      topK: 5,
    });

    expect(fused).toHaveLength(1);
    expect(fused[0].denseScore).toBe(0.82);
    expect(fused[0].lexicalScore).toBe(7.5);
    expect(fused[0].metadata).toEqual({ source: 'crawler' });
  });

  it('honours topK after fusing, not before', () => {
    const fused = fuseHybridMatches({
      dense: rankedHits('d', 20),
      lexical: rankedHits('k', 20),
      topK: 3,
    });

    expect(fused).toHaveLength(3);
  });

  it('reads k from the caller', () => {
    const tight = fuseHybridMatches({
      dense: rankedHits('d', 5),
      lexical: [],
      topK: 5,
      options: { k: 1 },
    });

    // With k=1 the rank advantage is steep, so the tail falls away fast.
    expect(tight[0].score).toBeGreaterThan(tight[4].score * 1.5);
  });
});

describe('fuseHybridMatches — weighted', () => {
  it('leaves a dense-only hit on its own similarity scale', () => {
    // Blending against a zero for the channel that never saw the document
    // would report 0.8 as 0.4 and drop it behind the very threshold it clears.
    const fused = fuseHybridMatches({
      dense: [{ id: 'a', score: 0.8 }],
      lexical: [{ id: 'b', score: 9 }],
      topK: 5,
      options: { mode: 'weighted' },
    });

    const dense = fused.find((match) => match.id === 'a');
    expect(dense?.score).toBeCloseTo(0.8, 10);
  });

  it('scores the best keyword-only hit on the keyword channel alone', () => {
    const fused = fuseHybridMatches({
      dense: [{ id: 'a', score: 0.8 }],
      lexical: [{ id: 'b', score: 9 }, { id: 'c', score: 3 }],
      topK: 5,
      options: { mode: 'weighted' },
    });

    expect(fused.find((match) => match.id === 'b')?.score).toBeCloseTo(1, 10);
    expect(fused.find((match) => match.id === 'c')?.score).toBeCloseTo(3 / 9, 10);
  });

  it('blends the two channels at alpha', () => {
    const fused = fuseHybridMatches({
      dense: [{ id: 'a', score: 0.6 }],
      lexical: [{ id: 'a', score: 10 }],
      topK: 5,
      options: { mode: 'weighted', alpha: 0.25 },
    });

    expect(fused[0].score).toBeCloseTo(0.25 * 0.6 + 0.75 * 1, 10);
  });
});

describe('resolveHybridOptions', () => {
  it('defaults to rrf with k=60 and alpha=0.5', () => {
    expect(resolveHybridOptions()).toEqual({ mode: 'rrf', alpha: 0.5, k: 60 });
  });

  it('clamps a nonsensical alpha instead of producing negative weights', () => {
    expect(resolveHybridOptions({ alpha: 4 }).alpha).toBe(1);
    expect(resolveHybridOptions({ alpha: -2 }).alpha).toBe(0);
    expect(resolveHybridOptions({ k: 0 }).k).toBe(DEFAULT_RRF_K);
  });
});

// ── Searchable text + reporting ───────────────────────────────────────────────

describe('extractVectorText', () => {
  it('prefers the Knowledge Engine key over the generic ones', () => {
    expect(extractVectorText({ _content: 'first', text: 'second' })).toBe('first');
  });

  it('accepts the keys an external pipeline is likely to have written', () => {
    expect(extractVectorText({ page_content: 'from langchain' })).toBe('from langchain');
  });

  it('ignores blank and non-string values', () => {
    expect(extractVectorText({ content: '   ', text: 42 as unknown as string })).toBeUndefined();
    expect(extractVectorText(undefined)).toBeUndefined();
  });
});

describe('describeHybrid', () => {
  it('reports the mode that ran', () => {
    expect(describeHybrid({ ran: true, mode: 'weighted' })).toEqual({
      hybrid: true,
      hybridMode: 'weighted',
    });
  });

  it('reports why it did not run', () => {
    expect(describeHybrid({ ran: false, reason: 'index-schema' })).toEqual({
      hybrid: false,
      hybridUnavailable: 'index-schema',
    });
  });
});

// ── Capability declaration ────────────────────────────────────────────────────

describe('vector.supportsHybrid capability', () => {
  const vectorContracts = CORE_PROVIDER_CONTRACTS.filter((contract) =>
    contract.domains.includes('vector'),
  );

  it.each(vectorContracts.map((contract) => [contract.id, contract]))(
    '%s — declares the capability explicitly',
    (_, contract) => {
      // Absent would mean false, but only to whoever remembered that. Every
      // vector contract states the answer so nobody has to infer it.
      expect(typeof contract.capabilities?.['vector.supportsHybrid']).toBe('boolean');
    },
  );
});

// ── Elasticsearch ─────────────────────────────────────────────────────────────

const ES_HANDLE: VectorIndexHandle = {
  externalId: 'chunks',
  name: 'chunks',
  dimension: 3,
  metric: 'cosine',
};

async function elasticsearchRuntime(): Promise<VectorProviderRuntime> {
  return (await ElasticsearchVectorProviderContract.createRuntime({
    tenantId: 'tenant-test',
    providerKey: 'es-test',
    credentials: {},
    settings: { node: 'http://localhost:9200', dimensions: 3 },
  } as never)) as VectorProviderRuntime;
}

describe('Elasticsearch — hybrid query construction', () => {
  let runtime: VectorProviderRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    esIndicesExists.mockResolvedValue(false);
    esSearch.mockResolvedValue({ hits: { hits: [] } });
    runtime = await elasticsearchRuntime();
  });

  it('maps a searchable text field so the keyword channel has something to match', async () => {
    await runtime.createIndex({ name: 'chunks', dimension: 3, metric: 'cosine' });

    const [{ mappings }] = esIndicesCreate.mock.calls[0] as [{ mappings: { properties: Record<string, unknown> } }];
    expect(mappings.properties.content).toEqual({ type: 'text' });
  });

  it('writes the chunk text out of metadata on upsert', async () => {
    await runtime.upsertVectors(ES_HANDLE, [
      { id: 'v1', values: [1, 2, 3], metadata: { _content: 'ORA-01017 invalid credentials' } },
    ]);

    const [{ body }] = esBulk.mock.calls[0] as [{ body: Array<Record<string, unknown>> }];
    expect(body[1].content).toBe('ORA-01017 invalid credentials');
  });

  it('runs one knn search and no keyword search without text', async () => {
    const result = await runtime.queryVectors(ES_HANDLE, { topK: 5, vector: [1, 2, 3] });

    expect(esSearch).toHaveBeenCalledTimes(1);
    expect(esSearch.mock.calls[0][0]).toMatchObject({ index: 'chunks', size: 5 });
    expect(esSearch.mock.calls[0][0].query).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it('adds a keyword search over the content field when text is supplied', async () => {
    esSearch
      .mockResolvedValueOnce({ hits: { hits: [{ _id: 'a', _score: 0.71, _source: { metadata: { x: 1 } } }] } })
      .mockResolvedValueOnce({ hits: { hits: [{ _id: 'b', _score: 9.2, _source: { metadata: { x: 2 } } }] } });

    const result = await runtime.queryVectors(ES_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'ORA-01017',
    });

    expect(esSearch).toHaveBeenCalledTimes(2);
    expect(esSearch.mock.calls[1][0].query).toEqual({
      bool: { must: [{ match: { content: 'ORA-01017' } }] },
    });
    // Both channels reach past topK, or fusion has nothing to reorder.
    expect(esSearch.mock.calls[0][0].size).toBeGreaterThan(5);
    expect(result.usage).toMatchObject({ hybrid: true, hybridMode: 'rrf' });
    expect(result.matches.map((match) => match.id).sort()).toEqual(['a', 'b']);
    expect(result.matches.every((match) => match.score > MIN_SCORE)).toBe(true);
  });

  it('pushes the metadata filter into both channels', async () => {
    await runtime.queryVectors(ES_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'ORA-01017',
      filter: { kind: 'comparison', comparison: { op: '$eq', field: 'lang', value: 'tr' } },
    });

    expect(esSearch.mock.calls[0][0].knn.filter).toBeDefined();
    expect(esSearch.mock.calls[1][0].query.bool.filter).toHaveLength(1);
  });
});

// ── Azure AI Search ───────────────────────────────────────────────────────────

const AZURE_HYBRID_HANDLE: VectorIndexHandle = {
  externalId: 'chunks',
  name: 'chunks',
  dimension: 3,
  metric: 'cosine',
  metadata: { contentSchema: 'text-v1' },
};

/** An index created before the searchable text column existed. */
const AZURE_LEGACY_HANDLE: VectorIndexHandle = {
  ...AZURE_HYBRID_HANDLE,
  metadata: {},
};

function azureResults(docs: Array<{ id: string; metadata: string }>, score: number) {
  return {
    results: (async function* () {
      for (const doc of docs) {
        yield { document: doc, score };
      }
    })(),
  };
}

async function azureRuntime(): Promise<VectorProviderRuntime> {
  return (await AzureAiSearchVectorProviderContract.createRuntime({
    tenantId: 'tenant-test',
    providerKey: 'azure-test',
    credentials: { apiKey: 'k' },
    settings: { foundryProjectEndpoint: 'https://test.search.windows.net' },
  } as never)) as VectorProviderRuntime;
}

describe('Azure AI Search — hybrid query construction', () => {
  let runtime: VectorProviderRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    azureSearch.mockReturnValue(azureResults([], 0));
    runtime = await azureRuntime();
  });

  it('keeps searchText undefined for a pure vector search', async () => {
    await runtime.queryVectors(AZURE_HYBRID_HANDLE, { topK: 5, vector: [1, 2, 3] });

    expect(azureSearch.mock.calls[0][0]).toBeUndefined();
  });

  it('passes the text through and rescales the RRF score Azure hands back', async () => {
    // What Azure actually returns once searchText is non-undefined.
    azureSearch.mockReturnValueOnce(
      azureResults([{ id: 'a', metadata: '{"x":1}' }], 0.0163934),
    );

    const result = await runtime.queryVectors(AZURE_HYBRID_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'ORA-01017',
    });

    expect(azureSearch.mock.calls[0][0]).toBe('ORA-01017');
    expect(result.matches[0].score).toBeGreaterThan(MIN_SCORE);
    expect(result.usage).toMatchObject({ hybrid: true, hybridMode: 'rrf' });
  });

  it('stays dense on an index created before the searchable column', async () => {
    const result = await runtime.queryVectors(AZURE_LEGACY_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'ORA-01017',
    });

    expect(azureSearch.mock.calls[0][0]).toBeUndefined();
    expect(result.usage).toEqual({ hybrid: false, hybridUnavailable: 'index-schema' });
  });

  it('writes the chunk text only on an index that can search it', async () => {
    await runtime.upsertVectors(AZURE_HYBRID_HANDLE, [
      { id: 'v1', values: [1, 2, 3], metadata: { content: 'SKU-9912' } },
    ]);
    await runtime.upsertVectors(AZURE_LEGACY_HANDLE, [
      { id: 'v1', values: [1, 2, 3], metadata: { content: 'SKU-9912' } },
    ]);

    expect(azureMergeOrUpload.mock.calls[0][0][0].content).toBe('SKU-9912');
    // An unknown field is rejected outright by an index that never declared it.
    expect(azureMergeOrUpload.mock.calls[1][0][0].content).toBeUndefined();
  });
});

// ── PostgreSQL ────────────────────────────────────────────────────────────────

const PG_HANDLE: VectorIndexHandle = {
  externalId: 'vectors',
  name: 'vectors',
  dimension: 3,
  metric: 'cosine',
  metadata: { tableName: 'vectors' },
};

async function postgresRuntime(): Promise<VectorProviderRuntime> {
  return (await PostgresVectorProviderContract.createRuntime({
    tenantId: 'tenant-test',
    providerKey: 'pg-test',
    credentials: { connectionString: 'postgresql://localhost/test' },
    settings: { tableName: 'vectors', dimensions: 3 },
  } as never)) as VectorProviderRuntime;
}

function pgStatements(): string[] {
  return pgQuery.mock.calls.map(([sql]) => (sql as string).replace(/\s+/g, ' ').trim());
}

describe('PostgreSQL — hybrid query construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgQuery.mockResolvedValue({ rows: [] });
  });

  it('adds the text column and its GIN index before searching', async () => {
    const runtime = await postgresRuntime();
    await runtime.queryVectors(PG_HANDLE, { topK: 5, vector: [1, 2, 3], text: 'SKU-9912' });

    const statements = pgStatements();
    expect(statements.some((sql) => sql.startsWith('ALTER TABLE vectors ADD COLUMN IF NOT EXISTS content'))).toBe(true);
    expect(statements.some((sql) => sql.includes('USING GIN (to_tsvector(\'simple\''))).toBe(true);
  });

  it('runs a websearch_to_tsquery channel alongside the vector one', async () => {
    const runtime = await postgresRuntime();
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('websearch_to_tsquery')) {
        return { rows: [{ id: 'k1', metadata: {}, score: '0.31' }] };
      }
      if (sql.includes('ORDER BY vector')) {
        return { rows: [{ id: 'd1', metadata: {}, score: '0.77' }] };
      }
      return { rows: [] };
    });

    const result = await runtime.queryVectors(PG_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'SKU-9912',
    });

    const lexical = pgQuery.mock.calls.find(([sql]) => (sql as string).includes('websearch_to_tsquery'));
    expect(lexical?.[1]).toContain('SKU-9912');
    expect(result.usage).toMatchObject({ hybrid: true, hybridMode: 'rrf' });
    expect(result.matches.map((match) => match.id).sort()).toEqual(['d1', 'k1']);
  });

  it('stays dense and says so when the column cannot be added', async () => {
    const runtime = await postgresRuntime();
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('ALTER TABLE')) throw new Error('permission denied');
      return { rows: [{ id: 'd1', metadata: {}, score: '0.77' }] };
    });

    const result = await runtime.queryVectors(PG_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'SKU-9912',
    });

    expect(pgStatements().some((sql) => sql.includes('websearch_to_tsquery'))).toBe(false);
    expect(result.usage).toEqual({ hybrid: false, hybridUnavailable: 'index-schema' });
    expect(result.matches[0].score).toBeCloseTo(0.77, 10);
  });

  it('writes the chunk text on upsert once the column exists', async () => {
    const runtime = await postgresRuntime();
    await runtime.upsertVectors(PG_HANDLE, [
      { id: 'v1', values: [1, 2, 3], metadata: { chunk_text: 'SKU-9912 in stock' } },
    ]);

    const insert = pgQuery.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO'));
    expect(insert?.[0]).toContain('content');
    expect(insert?.[1]).toContain('SKU-9912 in stock');
  });
});

// ── MongoDB Atlas ─────────────────────────────────────────────────────────────

const MONGO_HANDLE: VectorIndexHandle = {
  externalId: 'db/chunks/vector_index',
  name: 'chunks',
  dimension: 3,
  metric: 'cosine',
  metadata: {
    database: 'db',
    collectionName: 'chunks',
    indexName: 'vector_index',
    vectorField: 'embedding',
  },
};

async function mongoRuntime(textIndexName?: string): Promise<VectorProviderRuntime> {
  return (await MongoDbVectorProviderContract.createRuntime({
    tenantId: 'tenant-test',
    providerKey: 'mongo-test',
    credentials: { uri: 'mongodb://localhost:27017' },
    settings: { database: 'db', collection: 'chunks', textIndexName },
  } as never)) as VectorProviderRuntime;
}

describe('MongoDB Atlas — hybrid query construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mongoAggregate.mockResolvedValue([]);
  });

  it('stays dense when no Atlas Search index has been configured', async () => {
    const runtime = await mongoRuntime();
    const result = await runtime.queryVectors(MONGO_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'SKU-9912',
    });

    expect(mongoAggregate).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({ hybrid: false, hybridUnavailable: 'not-configured' });
  });

  it('runs a $search channel when one is configured', async () => {
    const runtime = await mongoRuntime('chunks_text');
    mongoAggregate
      .mockResolvedValueOnce([{ _id: 'd1', metadata: {}, score: 0.8 }])
      .mockResolvedValueOnce([{ _id: 'k1', metadata: {}, score: 4.2 }]);

    const result = await runtime.queryVectors(MONGO_HANDLE, {
      topK: 5,
      vector: [1, 2, 3],
      text: 'SKU-9912',
    });

    const [lexicalPipeline] = mongoAggregate.mock.calls[1] as [Array<Record<string, unknown>>];
    expect(lexicalPipeline[0]).toEqual({
      $search: { index: 'chunks_text', text: { query: 'SKU-9912', path: 'content' } },
    });
    expect(result.usage).toMatchObject({ hybrid: true, hybridMode: 'rrf' });
    expect(result.matches.map((match) => match.id).sort()).toEqual(['d1', 'k1']);
  });

  it('writes the chunk text into the field the search index covers', async () => {
    const runtime = await mongoRuntime('chunks_text');
    await runtime.upsertVectors(MONGO_HANDLE, [
      { id: 'v1', values: [1, 2, 3], metadata: { body: 'SKU-9912 in stock' } },
    ]);

    const [ops] = mongoBulkWrite.mock.calls[0] as [Array<{ replaceOne: { replacement: Record<string, unknown> } }>];
    expect(ops[0].replaceOne.replacement.content).toBe('SKU-9912 in stock');
  });
});
