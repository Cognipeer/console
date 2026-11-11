/**
 * Unit tests - the postgres vector driver: the table-per-index layout, the shared-table layout (legacy SQL unchanged)
 * and the shared connection pools. pg is mocked; the tests read the SQL the driver sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: [] as Array<{ sql: string; params?: unknown[] }>,
  responder: null as null | ((sql: string, params?: unknown[]) => { rows: any[] } | Promise<{ rows: any[] }>),
  pools: [] as any[],
  released: 0,
  discarded: 0,
}));

vi.mock('pg', () => ({
  Pool: class Pool {
    listeners: Record<string, Array<(...a: any[]) => void>> = {};
    ended = 0;
    constructor(public config: Record<string, unknown>) {
      h.pools.push(this);
    }
    on(event: string, fn: (...a: any[]) => void) {
      (this.listeners[event] ??= []).push(fn);
      return this;
    }
    async connect() {
      return {
        query: async (sql: string, params?: unknown[]) => {
          h.sql.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
          return h.responder ? h.responder(sql, params) : { rows: [] };
        },
        release: (err?: boolean) => { h.released += 1; if (err) h.discarded += 1; },
      };
    }
    async end() { this.ended += 1; }
  },
}));

import {
  PostgresVectorProviderContract as contract,
  isPostgresIndexTableName,
  resetPostgresVectorPoolsForTests,
} from '@/lib/providers/contracts/postgresVector.contract';
import type { VectorIndexHandle, VectorProviderRuntime } from '@/lib/providers/domains/vector';

const warn = vi.fn();
const logger = { debug() {}, info() {}, warn, error() {} };
const creds = { connectionString: 'postgresql://u:p@db.example:5432/app' };

async function perIndex(extra: Record<string, unknown> = {}, credentials: Record<string, unknown> = creds): Promise<VectorProviderRuntime> {
  return contract.createRuntime({
    tenantId: 't', providerKey: 'k', credentials, logger,
    settings: { indexLayout: 'table-per-index', schema: 'tenant_a', ...extra },
  } as any) as Promise<VectorProviderRuntime>;
}
async function shared(extra: Record<string, unknown> = {}, credentials: Record<string, unknown> = creds): Promise<VectorProviderRuntime> {
  return contract.createRuntime({
    tenantId: 't', providerKey: 'k', credentials, logger, settings: { tableName: 'vectors', ...extra },
  } as any) as Promise<VectorProviderRuntime>;
}
const handle = (over: Partial<VectorIndexHandle> = {}): VectorIndexHandle =>
  ({ externalId: 'v_docs_0123abcd', name: 'docs', dimension: 3, metric: 'cosine', ...over });
const sqls = () => h.sql.map((s) => s.sql);

beforeEach(() => {
  h.sql.length = 0;
  h.responder = null;
  h.pools.length = 0;
  h.released = 0;
  h.discarded = 0;
  warn.mockClear();
  resetPostgresVectorPoolsForTests();
});

describe('isPostgresIndexTableName', () => {
  it('accepts only v_<slug>_<8 hex>', () => {
    expect(isPostgresIndexTableName('v_docs_0123abcd')).toBe(true);
    expect(isPostgresIndexTableName('v__0123abcd')).toBe(true);
    for (const bad of ['x"; drop table y', 'other.v_a_0123abcd', 'V_DOCS_0123abcd', 'vectors', 'v_a_0123ABCD', 'v_a_0123abc', '"v_a_0123abcd"', `v_${'a'.repeat(41)}_0123abcd`, undefined, 5]) {
      expect(isPostgresIndexTableName(bad)).toBe(false);
    }
  });
});

describe('table-per-index: settings', () => {
  it('rejects a bad schema and an unknown layout', async () => {
    for (const schema of ['Public', 'a-b', '1x', 'x"y', 'a'.repeat(64)]) {
      await expect(perIndex({ schema })).rejects.toThrow(/schema/);
    }
    await expect(shared({ indexLayout: 'weird' })).rejects.toThrow(/layout/);
  });
  it('needs tableName for shared-table only', async () => {
    await expect(contract.createRuntime({ tenantId: 't', providerKey: 'k', credentials: creds, settings: {} } as any)).rejects.toThrow(/table name/);
    await expect(perIndex({ tableName: undefined })).resolves.toBeTruthy();
  });
  it('clamps maxConnections', async () => {
    await perIndex({ maxConnections: 500 }, { connectionString: 'postgresql://a/1' });
    await perIndex({ maxConnections: 0 }, { connectionString: 'postgresql://a/2' });
    await perIndex({ maxConnections: 7.9 }, { connectionString: 'postgresql://a/3' });
    await perIndex({}, { connectionString: 'postgresql://a/4' });
    expect(h.pools.map((p) => p.config.max)).toEqual([100, 10, 7, 10]);
  });
});

describe('table-per-index: createIndex', () => {
  const create = async (name: string, dimension: number, metric?: 'cosine' | 'dot' | 'euclidean', extra?: Record<string, unknown>) => {
    h.sql.length = 0;
    h.responder = (sql) => (sql.startsWith('SELECT format') ? { rows: [{ statement: 'COMMENT ON TABLE x IS y' }] } : { rows: [] });
    const handleOut = await (await perIndex()).createIndex({ name, dimension, metric, ...extra });
    return handleOut;
  };

  it('creates a quoted, schema-qualified table in one transaction with an HNSW index, a GIN index and a comment', async () => {
    const out = await create('Product Docs!', 3, 'cosine', { metadata: { tableName: 'evil', keep: 1 } });
    expect(out.externalId).toMatch(/^v_product_docs_[0-9a-f]{8}$/);
    expect(out).toMatchObject({ name: 'Product Docs!', dimension: 3, metric: 'cosine' });
    expect(out.metadata).toEqual({ keep: 1, provider: 'postgres' });
    const t = out.externalId;
    const all = sqls();
    expect(all[0]).toBe('CREATE EXTENSION IF NOT EXISTS vector');
    expect(all[1]).toBe('SELECT 1 FROM pg_namespace WHERE nspname = $1');
    expect(all[2]).toBe('CREATE SCHEMA IF NOT EXISTS "tenant_a"');
    expect(all[3]).toBe('BEGIN');
    expect(all[4]).toContain(`CREATE TABLE "tenant_a"."${t}" (`);
    expect(all[4]).not.toContain('IF NOT EXISTS');
    expect(all[4]).toContain('vector vector(3)');
    expect(all[4]).toContain("metadata JSONB NOT NULL DEFAULT '{}'");
    expect(all[5]).toBe(`CREATE INDEX "${t}_hnsw" ON "tenant_a"."${t}" USING hnsw (vector vector_cosine_ops)`);
    expect(all[6]).toBe(`CREATE INDEX "${t}_fts" ON "tenant_a"."${t}" USING GIN (to_tsvector('simple', coalesce(content, '')))`);
    expect(all[7]).toContain('format(\'COMMENT ON TABLE %I.%I IS %L\'');
    expect(h.sql[7].params).toEqual(['tenant_a', t, JSON.stringify({ name: 'Product Docs!', metric: 'cosine' })]);
    expect(all[8]).toBe('COMMENT ON TABLE x IS y');
    expect(all[9]).toBe('COMMIT');
  });

  it.each([
    [1, 'vector', 'vector_cosine_ops'],
    [2000, 'vector', 'vector_cosine_ops'],
    [2001, 'halfvec', 'halfvec_cosine_ops'],
    [4000, 'halfvec', 'halfvec_cosine_ops'],
  ])('dimension %i uses %s with an HNSW index', async (dim, type, ops) => {
    await create('d', dim);
    expect(sqls().find((s) => s.startsWith('CREATE TABLE'))).toContain(`vector ${type}(${dim})`);
    expect(sqls().find((s) => s.includes('_hnsw'))).toContain(`USING hnsw (vector ${ops})`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('dimension 4001 and 16000 are exact-scan vector columns without an ANN index, with a warning', async () => {
    for (const dim of [4001, 16000]) {
      warn.mockClear();
      await create('big', dim);
      expect(sqls().find((s) => s.startsWith('CREATE TABLE'))).toContain(`vector vector(${dim})`);
      expect(sqls().some((s) => s.includes('hnsw'))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects dimensions outside 1..16000', async () => {
    const runtime = await perIndex();
    for (const dimension of [16001, -1, 1.5]) {
      await expect(runtime.createIndex({ name: 'x', dimension })).rejects.toThrow(/dimension/);
    }
  });

  it.each([
    ['cosine', 'vector_cosine_ops'],
    ['euclidean', 'vector_l2_ops'],
    ['dot', 'vector_ip_ops'],
  ] as const)('metric %s uses %s', async (metric, ops) => {
    await create('m', 3, metric);
    expect(sqls().find((s) => s.includes('_hnsw'))).toContain(ops);
  });

  it('halfvec metric operator classes', async () => {
    await create('m', 3072, 'dot');
    expect(sqls().find((s) => s.includes('_hnsw'))).toContain('halfvec_ip_ops');
    await create('m', 3072, 'euclidean');
    expect(sqls().find((s) => s.includes('_hnsw'))).toContain('halfvec_l2_ops');
  });

  it('tolerates a concurrent schema creator', async () => {
    h.responder = (sql) => {
      if (sql.startsWith('CREATE SCHEMA')) throw Object.assign(new Error('dup'), { code: '42P06' });
      return sql.startsWith('SELECT format') ? { rows: [{ statement: 'S' }] } : { rows: [] };
    };
    await expect((await perIndex()).createIndex({ name: 'a', dimension: 3 })).resolves.toBeTruthy();
  });

  it('retries a duplicate table with a new suffix (3 tries) and rolls back each failed transaction', async () => {
    h.responder = (sql) => {
      if (sql.startsWith('CREATE TABLE')) throw Object.assign(new Error('exists'), { code: '42P07' });
      return { rows: [] };
    };
    await expect((await perIndex()).createIndex({ name: 'a', dimension: 3 })).rejects.toThrow(/exists/);
    expect(sqls().filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(3);
    expect(sqls().filter((s) => s === 'ROLLBACK')).toHaveLength(3);
    const names = sqls().filter((s) => s.startsWith('CREATE TABLE')).map((s) => /"v_[^"]+"/.exec(s)![0]);
    expect(new Set(names).size).toBe(3);
  });

  it('rolls back and leaves no table when a later DDL statement fails', async () => {
    h.responder = (sql) => {
      if (sql.includes('USING hnsw')) throw new Error('boom');
      return { rows: [] };
    };
    await expect((await perIndex()).createIndex({ name: 'a', dimension: 3 })).rejects.toThrow('boom');
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
  });
});

describe('table-per-index: handle resolution', () => {
  it('ignores metadata.tableName', async () => {
    const runtime = await perIndex();
    await runtime.deleteVectors(handle({ metadata: { tableName: 'other_table' } }), ['a']);
    expect(sqls()[0]).toBe('DELETE FROM "tenant_a"."v_docs_0123abcd" WHERE id = ANY($1::text[])');
    expect(sqls().join('|')).not.toContain('other_table');
  });

  it('refuses every method for an invalid externalId', async () => {
    const runtime = await perIndex();
    for (const externalId of ['x"; drop table y', 'other.v_a_0123abcd', 'V_A_0123abcd', 'vectors', '']) {
      const bad = handle({ externalId });
      await expect(runtime.deleteIndex({ externalId })).rejects.toThrow(/identifier/);
      await expect(runtime.upsertVectors(bad, [{ id: 'a', values: [1, 2, 3] }])).rejects.toThrow(/identifier/);
      await expect(runtime.queryVectors(bad, { topK: 1, vector: [1, 2, 3] })).rejects.toThrow(/identifier/);
      await expect(runtime.deleteVectors(bad, ['a'])).rejects.toThrow(/identifier/);
      await expect(runtime.listVectors(bad)).rejects.toThrow(/identifier/);
      await expect(runtime.existingVectorIds!(bad, ['a'])).rejects.toThrow(/identifier/);
      await expect(runtime.existingVectors!(bad, ['a'])).rejects.toThrow(/identifier/);
    }
    expect(h.sql).toHaveLength(0);
  });

  it('deleteIndex drops the qualified table without CASCADE', async () => {
    await (await perIndex()).deleteIndex({ externalId: 'v_docs_0123abcd' });
    expect(sqls()).toEqual(['DROP TABLE IF EXISTS "tenant_a"."v_docs_0123abcd"']);
  });
});

describe('table-per-index: upsert', () => {
  it('dedupes by id (last wins), batches by 100 and runs in one transaction', async () => {
    const runtime = await perIndex();
    const items = Array.from({ length: 250 }, (_, i) => ({ id: `id${i}`, values: [i, 0, 0], metadata: { text: `t${i}` } }));
    items.push({ id: 'id0', values: [9, 9, 9], metadata: { text: 'last' } });
    await runtime.upsertVectors(handle(), items);
    const all = sqls();
    expect(all[0]).toBe('BEGIN');
    expect(all[all.length - 1]).toBe('COMMIT');
    const inserts = h.sql.filter((s) => s.sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((s) => (s.params as unknown[]).length / 4)).toEqual([100, 100, 50]);
    expect(inserts[0].sql).toContain('INSERT INTO "tenant_a"."v_docs_0123abcd" (id, vector, metadata, content) VALUES ($1, $2::vector, $3::jsonb, $4), ($5, $6::vector');
    expect(inserts[0].sql).toContain('ON CONFLICT (id) DO UPDATE SET vector = EXCLUDED.vector, metadata = EXCLUDED.metadata, content = EXCLUDED.content');
    const firstRow = inserts[0].params!.slice(0, 4);
    expect(firstRow).toEqual(['id0', '[9,9,9]', JSON.stringify({ text: 'last' }), 'last']);
    const ids = inserts.flatMap((s) => (s.params as unknown[]).filter((_, i) => i % 4 === 0));
    expect(new Set(ids).size).toBe(250);
    expect(h.released).toBe(1);
  });

  it('casts to halfvec for a 3072 handle', async () => {
    await (await perIndex()).upsertVectors(handle({ dimension: 3072 }), [{ id: 'a', values: [1] }]);
    expect(h.sql.find((s) => s.sql.startsWith('INSERT'))!.sql).toContain('$2::halfvec');
  });

  it('rolls back on failure and always releases the client', async () => {
    h.responder = (sql) => {
      if (sql.startsWith('INSERT')) throw new Error('insert failed');
      return { rows: [] };
    };
    await expect((await perIndex()).upsertVectors(handle(), [{ id: 'a', values: [1, 2, 3] }])).rejects.toThrow('insert failed');
    expect(sqls()).toEqual(expect.arrayContaining(['BEGIN', 'ROLLBACK']));
    expect(sqls()).not.toContain('COMMIT');
    expect(h.released).toBe(1);
  });

  it('discards the client when ROLLBACK itself fails', async () => {
    h.responder = (sql) => {
      if (sql.startsWith('INSERT')) throw new Error('insert failed');
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [] };
    };
    await expect((await perIndex()).upsertVectors(handle(), [{ id: 'a', values: [1, 2, 3] }])).rejects.toThrow('insert failed');
    expect(h.discarded).toBe(1);
  });

  it('createIndex skips CREATE SCHEMA when the schema already exists', async () => {
    h.responder = (sql) => (sql.includes('pg_namespace') ? { rows: [{ '?column?': 1 }] } : sql.startsWith('SELECT format') ? { rows: [{ statement: 'COMMENT ON TABLE x IS y' }] } : { rows: [] });
    await (await perIndex()).createIndex({ name: 'a', dimension: 3 });
    expect(sqls().some((q) => q.startsWith('CREATE SCHEMA'))).toBe(false);
  });

  it('createIndex creates a missing schema', async () => {
    h.responder = (sql) => (sql.startsWith('SELECT format') ? { rows: [{ statement: 'COMMENT ON TABLE x IS y' }] } : { rows: [] });
    await (await perIndex()).createIndex({ name: 'a', dimension: 3 });
    expect(sqls().some((q) => q.startsWith('CREATE SCHEMA'))).toBe(true);
  });

  it('an empty list sends nothing', async () => {
    await (await perIndex()).upsertVectors(handle(), []);
    expect(h.sql).toHaveLength(0);
  });
});

describe('table-per-index: query', () => {
  it('uses the typed cast, qualified names, a parameterised filter and re-sorts by score', async () => {
    h.responder = () => ({ rows: [{ id: 'b', score: '0.2', metadata: {} }, { id: 'a', score: '0.9', metadata: {} }] });
    const runtime = await perIndex();
    const out = await runtime.queryVectors(handle({ dimension: 3072 }), {
      topK: 5, vector: [1, 2],
      filter: { kind: 'comparison', comparison: { op: '$eq', field: 'lang', value: 'tr' } },
    });
    expect(out.matches.map((m) => m.id)).toEqual(['a', 'b']);
    const q = h.sql[0];
    expect(q.sql).toContain('FROM "tenant_a"."v_docs_0123abcd" WHERE');
    expect(q.sql).toContain('ORDER BY vector <=> $1::halfvec');
    expect(q.sql).toContain('1 - ("tenant_a"."v_docs_0123abcd".vector <=> $1::halfvec)');
    expect(q.params![0]).toBe('[1,2]');
    expect(q.params).toContain('tr');
    expect(q.params![q.params!.length - 1]).toBe(5);
    expect(q.sql).not.toContain("'tr'");
  });

  it('uses the operator of the metric', async () => {
    const runtime = await perIndex();
    await runtime.queryVectors(handle({ metric: 'euclidean' }), { topK: 1, vector: [1, 2, 3] });
    expect(h.sql[0].sql).toContain('ORDER BY vector <-> $1::vector');
    await runtime.queryVectors(handle({ metric: 'dot' }), { topK: 1, vector: [1, 2, 3] });
    expect(h.sql[1].sql).toContain('ORDER BY vector <#> $1::vector');
  });

  it('runs the lexical channel and fuses when text is given', async () => {
    h.responder = (sql) => (sql.includes('websearch_to_tsquery')
      ? { rows: [{ id: 'b', score: '1', metadata: {} }] }
      : { rows: [{ id: 'a', score: '0.9', metadata: {} }, { id: 'b', score: '0.8', metadata: {} }] });
    const out = await (await perIndex()).queryVectors(handle(), { topK: 2, vector: [1, 2, 3], text: ' hello ' });
    expect(h.sql).toHaveLength(2);
    expect(h.sql[1].sql).toContain('FROM "tenant_a"."v_docs_0123abcd", websearch_to_tsquery(\'simple\', $1) q');
    expect(h.sql[1].params![0]).toBe('hello');
    expect(out.usage).toMatchObject({ hybrid: true });
    expect(out.matches.length).toBeGreaterThan(0);
  });
});

describe('existing ids, list and listIndexes', () => {
  it.each([['table-per-index', perIndex, '"tenant_a"."v_docs_0123abcd"', handle()], ['shared-table', shared, 'vectors', handle({ externalId: 'vectors' })]] as const)(
    '%s: existingVectorIds and existingVectors chunk by 1000', async (_n, make, table, hnd) => {
      h.responder = (sql, params) => ({ rows: (params![0] as string[]).slice(0, 1).map((id) => ({ id, metadata: { m: id } })) });
      const runtime = await make();
      const ids = Array.from({ length: 2500 }, (_, i) => `i${i}`);
      expect(await runtime.existingVectorIds!(hnd, ids)).toEqual(['i0', 'i1000', 'i2000']);
      expect(h.sql).toHaveLength(3);
      expect(h.sql[0].sql).toBe(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`);
      h.sql.length = 0;
      expect(await runtime.existingVectors!(hnd, ids.slice(0, 5))).toEqual([{ id: 'i0', metadata: { m: 'i0' } }]);
      expect(h.sql[0].sql).toBe(`SELECT id, metadata FROM ${table} WHERE id = ANY($1::text[])`);
    });

  it('listVectors returns offset cursors and the total', async () => {
    h.responder = (sql) => (sql.includes('COUNT') ? { rows: [{ cnt: 5 }] } : { rows: [{ id: 'a', vector: '[1,2,3]', metadata: { x: 1 } }, { id: 'b', vector: '[4,5,6]', metadata: {} }] });
    const out = await (await perIndex()).listVectors(handle(), { limit: 2, cursor: '2' });
    expect(out).toMatchObject({ total: 5, nextCursor: '4' });
    expect(out.items[0].values).toEqual([1, 2, 3]);
    expect(h.sql[0].params).toEqual([2, 2]);
  });

  it('listIndexes reads the configured schema, parses the dimension and the comment', async () => {
    h.responder = () => ({
      rows: [
        { table_name: 'v_docs_0123abcd', vector_type: 'halfvec(3072)', comment: JSON.stringify({ name: 'Docs', metric: 'dot' }) },
        { table_name: 'v_plain_89abcdef', vector_type: 'vector(3)', comment: null },
        { table_name: 'not_ours', vector_type: 'vector(3)', comment: null },
      ],
    });
    const out = await (await perIndex()).listIndexes();
    expect(h.sql[0].params).toEqual(['tenant_a', '^v_[a-z0-9_]{0,40}_[0-9a-f]{8}$']);
    expect(out).toEqual([
      { externalId: 'v_docs_0123abcd', name: 'Docs', dimension: 3072, metric: 'dot', metadata: { provider: 'postgres' } },
      { externalId: 'v_plain_89abcdef', name: 'v_plain_89abcdef', dimension: 3, metric: 'cosine', metadata: { provider: 'postgres' } },
    ]);
  });
});

describe('shared pools', () => {
  it('one Pool for one config; closing ends it once the last runtime closes (idempotent)', async () => {
    const a = await perIndex({ schema: 'a' });
    const b = await perIndex({ schema: 'b' });
    expect(h.pools).toHaveLength(1);
    await a.close!();
    await a.close!();
    expect(h.pools[0].ended).toBe(0);
    await b.close!();
    expect(h.pools[0].ended).toBe(1);
    const c = await perIndex();
    expect(h.pools).toHaveLength(2);
    await c.close!();
  });

  it('a different connection, size or layout is a different pool', async () => {
    await perIndex();
    await perIndex({}, { connectionString: 'postgresql://u:p@other.example/app' });
    await perIndex({ maxConnections: 5 });
    await shared();
    expect(h.pools).toHaveLength(4);
  });

  it('registers an error listener that swallows errors', async () => {
    await perIndex();
    expect(h.pools[0].listeners.error).toHaveLength(1);
    expect(() => h.pools[0].listeners.error[0](new Error('idle client'))).not.toThrow();
  });

  it('table-per-index pools set the connect hook, timeout and relaxed iterative scan; shared-table pools do not', async () => {
    await perIndex();
    await shared();
    const [per, sh] = h.pools;
    expect(per.config.connectionTimeoutMillis).toBe(10000);
    expect(sh.config.connectionTimeoutMillis).toBeUndefined();
    expect(per.listeners.connect).toHaveLength(1);
    expect(sh.listeners.connect).toBeUndefined();
    const run = vi.fn(async () => { throw new Error('unknown setting'); });
    per.listeners.connect[0]({ query: run });
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith('SET hnsw.iterative_scan = relaxed_order');
  });
});

describe('shared-table layout keeps its SQL', () => {
  it('createIndex, upsert and query statements are the legacy ones', async () => {
    const runtime = await shared();
    const out = await runtime.createIndex({ name: 'n', dimension: 3 });
    expect(out).toEqual({ externalId: 'vectors', name: 'n', dimension: 3, metric: 'cosine', metadata: { tableName: 'vectors', provider: 'postgres' } });
    expect(sqls()).toEqual([
      'CREATE EXTENSION IF NOT EXISTS vector',
      "CREATE TABLE IF NOT EXISTS vectors ( id TEXT PRIMARY KEY, vector vector(3), metadata JSONB DEFAULT '{}', content TEXT )",
      'ALTER TABLE vectors ADD COLUMN IF NOT EXISTS content TEXT',
      "CREATE INDEX IF NOT EXISTS vectors_content_fts ON vectors USING GIN (to_tsvector('simple', coalesce(content, '')))",
    ]);

    h.sql.length = 0;
    await runtime.upsertVectors(handle({ externalId: 'vectors' }), [{ id: 'a', values: [1, 2, 3], metadata: { text: 'hi' } }]);
    expect(h.sql[0].sql).toBe(
      'INSERT INTO vectors (id, vector, metadata, content) VALUES ($1, $2::vector, $3::jsonb, $4) ON CONFLICT (id) DO UPDATE SET vector = EXCLUDED.vector, metadata = EXCLUDED.metadata, content = EXCLUDED.content',
    );
    expect(h.sql[0].params).toEqual(['a', '[1,2,3]', '{"text":"hi"}', 'hi']);

    h.sql.length = 0;
    await runtime.queryVectors(handle({ externalId: 'vectors', metadata: { tableName: 'other' } }), { topK: 3, vector: [1, 2, 3] });
    expect(h.sql[0].sql).toBe('SELECT id, metadata, 1 - (other.vector <=> $1::vector) AS score FROM other ORDER BY vector <=> $1::vector LIMIT $2');
    expect(h.sql[0].params).toEqual(['[1,2,3]', 3]);
  });
});
