/**
 * Unit tests — MongoDB Community Vector Provider Contract
 *
 * Runs the same contract behaviour as the SQLite vector store tests, but
 * against a real MongoDB instance (mongodb-memory-server) — no Atlas
 * `$vectorSearch` index involved, since this contract scores candidates in
 * application code.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { MongoClient } from 'mongodb';
import { MongoCommunityVectorProviderContract } from '@/lib/providers/contracts/mongoCommunityVector.contract';
import type { VectorProviderRuntime } from '@/lib/providers/domains/vector';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const MONGO_AVAILABLE: boolean = (() => {
  try {
    createRequire(import.meta.url).resolve('mongodb-memory-server');
    return true;
  } catch {
    return false;
  }
})();

const TENANT_ID = 'test-tenant-1';
const PROVIDER_KEY = 'test-mongo-vec-provider';

describe.runIf(MONGO_AVAILABLE)('MongoCommunityVectorProviderContract', () => {
  let server: { getUri(): string; stop(): Promise<boolean> };
  let runtime: VectorProviderRuntime;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    server = await MongoMemoryServer.create();

    runtime = await MongoCommunityVectorProviderContract.createRuntime({
      tenantId: TENANT_ID,
      providerKey: PROVIDER_KEY,
      credentials: { uri: server.getUri() },
      settings: { database: 'test_vectors' },
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  // ── Contract shape ────────────────────────────────────────────────────

  it('has the correct id and declares vector domain', () => {
    expect(MongoCommunityVectorProviderContract.id).toBe('mongodb-community-vector');
    expect(MongoCommunityVectorProviderContract.domains).toContain('vector');
  });

  it('declares the builtin capability without being node-local', () => {
    expect(MongoCommunityVectorProviderContract.capabilities?.builtin).toBe(true);
    expect(MongoCommunityVectorProviderContract.capabilities?.local).toBe(false);
  });

  it('has an optional uri credential (falls back to the app MongoDB connection)', () => {
    const fields = MongoCommunityVectorProviderContract.form.sections.flatMap((s) => s.fields);
    const uriField = fields.find((f) => f.name === 'uri');
    expect(uriField).toBeDefined();
    expect(uriField!.required).toBe(false);
    expect(uriField!.scope).toBe('credentials');
  });

  // ── Index CRUD ────────────────────────────────────────────────────────

  it('creates an index and returns a handle', async () => {
    const handle = await runtime.createIndex({ name: 'test-index', dimension: 3, metric: 'cosine' });
    expect(handle.externalId).toBeTruthy();
    expect(handle.name).toBe('test-index');
    expect(handle.dimension).toBe(3);
    expect(handle.metric).toBe('cosine');
  });

  it('lists indexes', async () => {
    const indexes = await runtime.listIndexes();
    expect(indexes.find((i) => i.name === 'test-index')).toBeDefined();
  });

  it('deletes an index and cascades its vectors', async () => {
    const handle = await runtime.createIndex({ name: 'to-delete', dimension: 2 });
    await runtime.upsertVectors(handle, [{ id: 'x1', values: [1, 0] }]);

    await runtime.deleteIndex({ externalId: handle.externalId });

    const indexes = await runtime.listIndexes();
    expect(indexes.find((i) => i.name === 'to-delete')).toBeUndefined();

    // Recreating with the same handle id space must not resurrect old vectors.
    const revived = await runtime.createIndex({ name: 'to-delete', dimension: 2 });
    const result = await runtime.queryVectors(revived, { vector: [1, 0], topK: 10 });
    expect(result.matches).toHaveLength(0);
  });

  // ── Vector operations ─────────────────────────────────────────────────

  describe('Vector upsert and query', () => {
    let handle: Awaited<ReturnType<typeof runtime.createIndex>>;

    beforeAll(async () => {
      handle = await runtime.createIndex({ name: 'query-test', dimension: 3, metric: 'cosine' });
      await runtime.upsertVectors(handle, [
        { id: 'v1', values: [1, 0, 0], metadata: { label: 'x-axis' } },
        { id: 'v2', values: [0, 1, 0], metadata: { label: 'y-axis' } },
        { id: 'v3', values: [0, 0, 1], metadata: { label: 'z-axis' } },
        { id: 'v4', values: [0.7071, 0.7071, 0], metadata: { label: 'xy-diagonal' } },
      ]);
    });

    it('returns top-K results sorted by cosine similarity', async () => {
      const result = await runtime.queryVectors(handle, { vector: [1, 0, 0], topK: 2 });
      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].id).toBe('v1');
      expect(result.matches[0].score).toBeCloseTo(1.0, 4);
      expect(result.matches[1].id).toBe('v4');
    });

    it('includes metadata in query results', async () => {
      const result = await runtime.queryVectors(handle, { vector: [0, 1, 0], topK: 1 });
      expect(result.matches[0].id).toBe('v2');
      expect(result.matches[0].metadata).toEqual({ label: 'y-axis' });
    });

    it('reports usage with candidate count', async () => {
      const result = await runtime.queryVectors(handle, { vector: [0, 0, 1], topK: 10 });
      expect(result.usage?.candidateCount).toBe(4);
      expect(result.matches).toHaveLength(4);
    });

    it('upserts (updates) existing vectors in place', async () => {
      await runtime.upsertVectors(handle, [{ id: 'v1', values: [0, 0, 1], metadata: { label: 'updated-to-z' } }]);
      const result = await runtime.queryVectors(handle, { vector: [0, 0, 1], topK: 1 });
      expect(result.matches[0].id).toBe('v1');
      expect(result.matches[0].metadata).toEqual({ label: 'updated-to-z' });
    });

    it('deletes vectors by id', async () => {
      await runtime.deleteVectors(handle, ['v1']);
      const result = await runtime.queryVectors(handle, { vector: [1, 0, 0], topK: 10 });
      expect(result.matches.map((m) => m.id)).not.toContain('v1');
      expect(result.matches).toHaveLength(3);
    });
  });

  // ── On-prem single-database mode ────────────────────────────────────

  describe('MONGODB_SINGLE_DATABASE mode', () => {
    const originalSource = getConfigSource();

    afterEach(() => {
      setConfigSource(originalSource);
    });

    it('reuses the app main database (as its own collections) when the store reuses the app connection with no explicit database setting', async () => {
      setConfigSource({
        name: 'test-single-db',
        get: (key: string) => {
          const overrides: Record<string, string> = {
            DB_PROVIDER: 'mongodb',
            MONGODB_URI: server.getUri(),
            MONGODB_SINGLE_DATABASE: 'true',
            MAIN_DB_NAME: 'single_db_test_main',
          };
          return overrides[key];
        },
      } as ConfigSource);

      // No `uri` credential (reuses the app connection) and no `database`
      // setting — must collapse into the app's single main database instead
      // of the dedicated `cognipeer_vectors` database.
      await MongoCommunityVectorProviderContract.createRuntime({
        tenantId: 'single_db_tenant',
        providerKey: PROVIDER_KEY,
        credentials: {},
        settings: {},
      });

      const client = new MongoClient(server.getUri());
      await client.connect();
      try {
        const mainDbCollections = await client.db('single_db_test_main').listCollections().toArray();
        expect(mainDbCollections.some((c) => c.name.includes('single_db_tenant'))).toBe(true);

        const dedicatedDbCollections = await client.db('cognipeer_vectors').listCollections().toArray();
        expect(dedicatedDbCollections.some((c) => c.name.includes('single_db_tenant'))).toBe(false);
      } finally {
        await client.close();
      }
    });

    it('still honors an explicit database setting even in single-database mode', async () => {
      setConfigSource({
        name: 'test-single-db-explicit',
        get: (key: string) => {
          const overrides: Record<string, string> = {
            DB_PROVIDER: 'mongodb',
            MONGODB_URI: server.getUri(),
            MONGODB_SINGLE_DATABASE: 'true',
            MAIN_DB_NAME: 'single_db_test_main',
          };
          return overrides[key];
        },
      } as ConfigSource);

      await MongoCommunityVectorProviderContract.createRuntime({
        tenantId: 'single-db-tenant-explicit',
        providerKey: PROVIDER_KEY,
        credentials: {},
        settings: { database: 'explicit_vectors_db' },
      });

      const client = new MongoClient(server.getUri());
      await client.connect();
      try {
        const explicitDbCollections = await client.db('explicit_vectors_db').listCollections().toArray();
        expect(explicitDbCollections.some((c) => c.name.includes('single_db_tenant_explicit'))).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────

  it('does not leak vectors between tenant/provider collection pairs', async () => {
    const handleA = await runtime.createIndex({ name: 'iso-a', dimension: 2 });
    await runtime.upsertVectors(handleA, [{ id: 'a1', values: [1, 0] }]);

    const runtimeB = await MongoCommunityVectorProviderContract.createRuntime({
      tenantId: 'other-tenant',
      providerKey: PROVIDER_KEY,
      credentials: { uri: server.getUri() },
      settings: { database: 'test_vectors' },
    });

    const indexesB = await runtimeB.listIndexes();
    expect(indexesB.find((i) => i.name === 'iso-a')).toBeUndefined();
  });

  // ── Dimension validation ────────────────────────────────────────────

  it('rejects upsert/query with mismatched dimensions', async () => {
    const handle = await runtime.createIndex({ name: 'dim-check', dimension: 2 });
    await expect(
      runtime.upsertVectors(handle, [{ id: 'd1', values: [1, 2, 3] }]),
    ).rejects.toThrow(/dimension mismatch/i);
    await expect(
      runtime.queryVectors(handle, { vector: [1, 2, 3], topK: 1 }),
    ).rejects.toThrow(/dimension mismatch/i);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles empty upsert/delete gracefully', async () => {
    const h = await runtime.createIndex({ name: 'empty-ops', dimension: 2 });
    await expect(runtime.upsertVectors(h, [])).resolves.toBeUndefined();
    await expect(runtime.deleteVectors(h, [])).resolves.toBeUndefined();
  });

  // ── Pagination ──────────────────────────────────────────────────────

  it('paginates listVectors and returns the true top-K on query', async () => {
    const h = await runtime.createIndex({ name: 'bulk-topk', dimension: 2, metric: 'dot' });
    const items = Array.from({ length: 150 }, (_, i) => ({ id: `bulk-${i}`, values: [i, 1] }));
    await runtime.upsertVectors(h, items);

    const result = await runtime.queryVectors(h, { vector: [1, 0], topK: 5 });
    expect(result.matches.map((m) => m.id)).toEqual([
      'bulk-149',
      'bulk-148',
      'bulk-147',
      'bulk-146',
      'bulk-145',
    ]);

    const page1 = await runtime.listVectors(h, { limit: 100 });
    expect(page1.items).toHaveLength(100);
    expect(page1.total).toBe(150);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await runtime.listVectors(h, { limit: 100, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(50);
    expect(page2.nextCursor).toBeUndefined();
  });
});

describe.skipIf(MONGO_AVAILABLE)('MongoCommunityVectorProviderContract', () => {
  it.skip('mongodb-memory-server not installed — skipping', () => {});
});
