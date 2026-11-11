/**
 * Integration - the postgres vector driver (table-per-index layout) against a real PostgreSQL with pgvector.
 *
 * Skipped unless PGVECTOR_TEST_URL is set, for example
 *
 *   PGVECTOR_TEST_URL=postgresql://user:password@127.0.0.1:5432/dbname npx vitest run postgres-vector-pgvector
 *
 * The database needs the pgvector extension available (version 0.7 or newer for halfvec). The test creates two
 * schemas of its own and drops them at the end.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresVectorProviderContract } from '@/lib/providers/contracts/postgresVector.contract';
import type { VectorIndexHandle, VectorProviderRuntime } from '@/lib/providers/domains/vector';

const URL_ = process.env.PGVECTOR_TEST_URL ?? '';
const run = `it${randomBytes(3).toString('hex')}`;
const schemaA = `${run}_a`;
const schemaB = `${run}_b`;
const noop = { debug() {}, info() {}, warn() {}, error() {} };

async function runtime(schema: string): Promise<VectorProviderRuntime> {
  return PostgresVectorProviderContract.createRuntime({
    tenantId: 't', providerKey: 'k', credentials: { connectionString: URL_ }, logger: noop,
    settings: { indexLayout: 'table-per-index', schema },
  } as any) as Promise<VectorProviderRuntime>;
}

const eq = (field: string, value: string) => ({ kind: 'comparison', comparison: { op: '$eq', field, value } }) as any;

describe.runIf(Boolean(URL_))('postgres vector driver against pgvector', () => {
  let a: VectorProviderRuntime;
  let b: VectorProviderRuntime;
  let small: VectorIndexHandle;
  let big: VectorIndexHandle;
  let euclid: VectorIndexHandle;

  beforeAll(async () => {
    a = await runtime(schemaA);
    b = await runtime(schemaB);
  });

  afterAll(async () => {
    if (!a) return;
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: URL_, max: 1 });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaA}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaB}" CASCADE`);
    } finally {
      await pool.end();
    }
    await a.close?.();
    await b?.close?.();
  });

  it('creates indexes at 3 and 3072 dimensions and with another metric', async () => {
    small = await a.createIndex({ name: 'Small Docs', dimension: 3, metric: 'cosine' });
    big = await a.createIndex({ name: 'big', dimension: 3072, metric: 'cosine' });
    euclid = await a.createIndex({ name: 'euclid', dimension: 3, metric: 'euclidean' });
    expect(small.externalId).toMatch(/^v_small_docs_[0-9a-f]{8}$/);
    expect(small.metadata).not.toHaveProperty('tableName');
    const listed = await a.listIndexes();
    expect(listed.map((i) => [i.name, i.dimension, i.metric]).sort()).toEqual([
      ['Small Docs', 3, 'cosine'], ['big', 3072, 'cosine'], ['euclid', 3, 'euclidean'],
    ].sort());
    expect(await b.listIndexes()).toEqual([]);
  });

  it('upserts (duplicate id in one call), queries with and without a filter, and runs a hybrid query', async () => {
    await a.upsertVectors(small, [
      { id: 'x', values: [1, 0, 0], metadata: { lang: 'en', text: 'the quick brown fox' } },
      { id: 'y', values: [0, 1, 0], metadata: { lang: 'tr', text: 'hızlı kahverengi tilki' } },
      { id: 'z', values: [0.9, 0.1, 0], metadata: { lang: 'tr', text: 'lazy dog' } },
      { id: 'x', values: [0.8, 0.2, 0], metadata: { lang: 'en', text: 'the quick brown fox' } },
    ]);
    const total = await a.listVectors(small, { limit: 1 });
    expect(total.total).toBe(3);
    const plain = await a.queryVectors(small, { topK: 3, vector: [1, 0, 0] });
    expect(plain.matches.map((m) => m.id)).toEqual(['z', 'x', 'y']);
    expect(plain.matches[0].score).toBeGreaterThan(plain.matches[2].score);
    const filtered = await a.queryVectors(small, { topK: 3, vector: [1, 0, 0], filter: eq('lang', 'tr') });
    expect(filtered.matches.map((m) => m.id)).toEqual(['z', 'y']);
    const hybrid = await a.queryVectors(small, { topK: 3, vector: [0, 0, 1], text: 'fox' });
    expect(hybrid.usage).toMatchObject({ hybrid: true });
    expect(hybrid.matches[0].id).toBe('x');
  });

  it('works on a halfvec index and a euclidean index', async () => {
    const v = (i: number) => Array.from({ length: 3072 }, (_, k) => (k === i ? 1 : 0));
    await a.upsertVectors(big, [{ id: 'p', values: v(0) }, { id: 'q', values: v(1) }]);
    const out = await a.queryVectors(big, { topK: 1, vector: v(1) });
    expect(out.matches[0].id).toBe('q');
    await a.upsertVectors(euclid, [{ id: 'near', values: [1, 1, 1] }, { id: 'far', values: [9, 9, 9] }]);
    const e = await a.queryVectors(euclid, { topK: 2, vector: [1, 1, 1] });
    expect(e.matches.map((m) => m.id)).toEqual(['near', 'far']);
  });

  it('reports existing ids and metadata, deletes vectors', async () => {
    expect((await a.existingVectorIds!(small, ['x', 'nope'])).sort()).toEqual(['x']);
    expect(await a.existingVectors!(small, ['y', 'nope'])).toEqual([{ id: 'y', metadata: { lang: 'tr', text: 'hızlı kahverengi tilki' } }]);
    await a.deleteVectors(small, ['y']);
    expect((await a.listVectors(small)).total).toBe(2);
  });

  it('keeps tenant B out of tenant A tables', async () => {
    for (const externalId of [small.externalId, `${schemaA}.${small.externalId}`, `"${schemaA}"."${small.externalId}"`]) {
      const handle = { ...small, externalId, metadata: { tableName: `${schemaA}.${small.externalId}` } };
      await expect(b.queryVectors(handle, { topK: 1, vector: [1, 0, 0] })).rejects.toThrow();
      await expect(b.listVectors(handle)).rejects.toThrow();
    }
    await expect(b.deleteIndex({ externalId: small.externalId })).resolves.toBeUndefined();
    expect((await a.listVectors(small)).total).toBe(2);
  });

  it('uses the HNSW index for an unfiltered top-k query', async () => {
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: URL_, max: 1 });
    try {
      const rows = Array.from({ length: 300 }, (_, i) => `('r${i}', '[${Math.sin(i)},${Math.cos(i)},${i / 300}]')`).join(',');
      await pool.query(`INSERT INTO "${schemaA}"."${small.externalId}" (id, vector) VALUES ${rows} ON CONFLICT DO NOTHING`);
      await pool.query(`ANALYZE "${schemaA}"."${small.externalId}"`);
      const client = await pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        const plan = await client.query(
          `EXPLAIN SELECT id FROM "${schemaA}"."${small.externalId}" ORDER BY vector <=> '[1,0,0]'::vector LIMIT 5`,
        );
        const text = plan.rows.map((r: any) => r['QUERY PLAN']).join('\n');
        expect(text).toContain(`${small.externalId}_hnsw`);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('drops an index', async () => {
    await a.deleteIndex({ externalId: euclid.externalId });
    expect((await a.listIndexes()).map((i) => i.name).sort()).toEqual(['Small Docs', 'big']);
  });
});
