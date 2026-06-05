/**
 * Contract tests — DummyVector Provider (end-to-end, in-memory)
 *
 * The DummyVector provider is a fully in-memory implementation — no external
 * service needed. These tests exercise the complete VectorProviderRuntime
 * contract: createIndex → upsertVectors → queryVectors → deleteVectors → deleteIndex.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DummyVectorProviderContract } from '@/lib/providers/contracts/dummyVector.contract';
import type { VectorProviderRuntime } from '@/lib/providers/domains/vector';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTEXT = {
  tenantId: 'tenant-test',
  tenantSlug: 'test',
  providerKey: 'dummy-vector-test',
  credentials: { apiKey: 'dummy-key' },
  settings: { defaultDimension: 3 },
};

const DIMENSION = 3;

function makeVectors(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `vec-${i}`,
    values: Array.from({ length: DIMENSION }, () => Math.random()),
    metadata: { source: 'test', index: i },
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DummyVectorProvider — runtime contract', () => {
  let runtime: VectorProviderRuntime;

  beforeEach(async () => {
    runtime = (await DummyVectorProviderContract.createRuntime(
      CONTEXT,
    )) as VectorProviderRuntime;
  });

  describe('createIndex', () => {
    it('returns a handle with correct shape', async () => {
      const handle = await runtime.createIndex({
        name: 'my-index',
        dimension: DIMENSION,
        metric: 'cosine',
      });

      expect(typeof handle.externalId).toBe('string');
      expect(handle.externalId.length).toBeGreaterThan(0);
      expect(handle.name).toBe('my-index');
      expect(handle.dimension).toBe(DIMENSION);
      expect(handle.metric).toBe('cosine');
    });

    it('defaults metric to cosine when not provided', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      expect(handle.metric).toBe('cosine');
    });

    it('accepts optional metadata', async () => {
      const handle = await runtime.createIndex({
        name: 'idx',
        dimension: DIMENSION,
        metadata: { env: 'test' },
      });
      expect(handle.metadata).toEqual({ env: 'test' });
    });

    it('each call produces a unique externalId', async () => {
      const a = await runtime.createIndex({ name: 'a', dimension: DIMENSION });
      const b = await runtime.createIndex({ name: 'b', dimension: DIMENSION });
      expect(a.externalId).not.toBe(b.externalId);
    });
  });

  describe('listIndexes', () => {
    it('starts empty', async () => {
      const indexes = await runtime.listIndexes();
      expect(indexes).toEqual([]);
    });

    it('reflects created indexes', async () => {
      await runtime.createIndex({ name: 'idx-1', dimension: DIMENSION });
      await runtime.createIndex({ name: 'idx-2', dimension: DIMENSION });
      const indexes = await runtime.listIndexes();
      expect(indexes.length).toBe(2);
    });
  });

  describe('upsertVectors', () => {
    it('does not throw for valid items', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      const items = makeVectors(5);
      await expect(runtime.upsertVectors(handle, items)).resolves.toBeUndefined();
    });

    it('allows upserting an empty array', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      await expect(runtime.upsertVectors(handle, [])).resolves.toBeUndefined();
    });
  });

  describe('queryVectors', () => {
    it('returns a result object with matches array', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      await runtime.upsertVectors(handle, makeVectors(3));

      const result = await runtime.queryVectors(handle, {
        topK: 2,
        vector: [0.1, 0.2, 0.3],
      });

      expect(Array.isArray(result.matches)).toBe(true);
      expect(result.matches.length).toBeLessThanOrEqual(2);
    });

    it('each match has id and score', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      await runtime.upsertVectors(handle, makeVectors(3));

      const result = await runtime.queryVectors(handle, {
        topK: 3,
        vector: [0.1, 0.2, 0.3],
      });

      result.matches.forEach((match) => {
        expect(typeof match.id).toBe('string');
        expect(typeof match.score).toBe('number');
        expect(match.score).toBeGreaterThanOrEqual(0);
      });
    });

    it('respects topK limit', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      await runtime.upsertVectors(handle, makeVectors(10));

      const result = await runtime.queryVectors(handle, {
        topK: 3,
        vector: [0.1, 0.2, 0.3],
      });

      expect(result.matches.length).toBeLessThanOrEqual(3);
    });
  });

  describe('deleteVectors', () => {
    it('does not throw when deleting existing ids', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      await runtime.upsertVectors(handle, makeVectors(3));
      await expect(
        runtime.deleteVectors(handle, ['vec-0', 'vec-1']),
      ).resolves.toBeUndefined();
    });

    it('does not throw when deleting non-existent ids', async () => {
      const handle = await runtime.createIndex({ name: 'idx', dimension: DIMENSION });
      await expect(
        runtime.deleteVectors(handle, ['ghost-id']),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteIndex', () => {
    it('removes the index from the list', async () => {
      const handle = await runtime.createIndex({ name: 'to-be-deleted', dimension: DIMENSION });
      expect((await runtime.listIndexes()).length).toBe(1);

      await runtime.deleteIndex({ externalId: handle.externalId });
      expect((await runtime.listIndexes()).length).toBe(0);
    });

    it('does not throw when deleting a non-existent index', async () => {
      await expect(
        runtime.deleteIndex({ externalId: 'ghost-id' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('Full CRUD lifecycle', () => {
    it('create → upsert → query → delete is complete and consistent', async () => {
      // Create
      const handle = await runtime.createIndex({
        name: 'lifecycle',
        dimension: DIMENSION,
        metric: 'dot',
      });

      // Upsert
      const items = makeVectors(5);
      await runtime.upsertVectors(handle, items);

      // Query
      const result = await runtime.queryVectors(handle, {
        topK: 5,
        vector: [1, 0, 0],
      });
      expect(result.matches.length).toBeGreaterThan(0);

      // Delete specific vectors
      await runtime.deleteVectors(handle, ['vec-0', 'vec-1']);

      // Delete index
      await runtime.deleteIndex({ externalId: handle.externalId });
      const remaining = await runtime.listIndexes();
      expect(remaining.find((i) => i.externalId === handle.externalId)).toBeUndefined();
    });
  });
});
