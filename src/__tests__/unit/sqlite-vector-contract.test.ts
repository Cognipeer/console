/**
 * Unit tests — SQLite Vector Provider Contract
 *
 * Tests the sqlite-vector provider contract with a real in-memory-like
 * SQLite database (temp directory). No external services needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteVectorProviderContract } from '@/lib/providers/contracts/sqliteVector.contract';
import type { VectorProviderRuntime } from '@/lib/providers/domains/vector';

const TENANT_ID = 'test-tenant-1';
const PROVIDER_KEY = 'test-vec-provider';

let tmpDir: string;
let runtime: VectorProviderRuntime;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cgate-vec-test-'));

  runtime = await SqliteVectorProviderContract.createRuntime({
    tenantId: TENANT_ID,
    providerKey: PROVIDER_KEY,
    credentials: {} as Record<string, never>,
    settings: { basePath: tmpDir },
  });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Contract shape ──────────────────────────────────────────────────────────

describe('SqliteVectorProviderContract shape', () => {
  it('has the correct id and version', () => {
    expect(SqliteVectorProviderContract.id).toBe('sqlite-vector');
    expect(SqliteVectorProviderContract.version).toBe('1.0.0');
  });

  it('declares vector domain', () => {
    expect(SqliteVectorProviderContract.domains).toContain('vector');
  });

  it('has display config', () => {
    expect(SqliteVectorProviderContract.display.label).toBeTruthy();
    expect(SqliteVectorProviderContract.display.description).toBeTruthy();
  });

  it('has form schema with basePath field', () => {
    const fields = SqliteVectorProviderContract.form.sections.flatMap(
      (s) => s.fields,
    );
    const basePathField = fields.find((f) => f.name === 'basePath');
    expect(basePathField).toBeDefined();
    expect(basePathField!.scope).toBe('settings');
    expect(basePathField!.required).toBe(true);
  });

  it('declares capabilities', () => {
    expect(SqliteVectorProviderContract.capabilities?.supportsUpsert).toBe(true);
    expect(SqliteVectorProviderContract.capabilities?.supportsQuery).toBe(true);
    expect(SqliteVectorProviderContract.capabilities?.local).toBe(true);
  });
});

// ── Index CRUD ──────────────────────────────────────────────────────────────

describe('Index operations', () => {
  it('creates an index and returns a handle', async () => {
    const handle = await runtime.createIndex({
      name: 'test-index',
      dimension: 3,
      metric: 'cosine',
    });

    expect(handle.externalId).toBeTruthy();
    expect(handle.name).toBe('test-index');
    expect(handle.dimension).toBe(3);
    expect(handle.metric).toBe('cosine');
  });

  it('lists indexes', async () => {
    const indexes = await runtime.listIndexes();
    expect(indexes.length).toBeGreaterThanOrEqual(1);
    const found = indexes.find((i) => i.name === 'test-index');
    expect(found).toBeDefined();
  });

  it('creates an index with metadata', async () => {
    const handle = await runtime.createIndex({
      name: 'with-meta',
      dimension: 4,
      metric: 'dot',
      metadata: { env: 'test', version: 2 },
    });

    expect(handle.metadata).toEqual({ env: 'test', version: 2 });

    const indexes = await runtime.listIndexes();
    const found = indexes.find((i) => i.name === 'with-meta');
    expect(found?.metadata).toEqual({ env: 'test', version: 2 });
  });

  it('deletes an index', async () => {
    const handle = await runtime.createIndex({
      name: 'to-delete',
      dimension: 2,
    });

    await runtime.deleteIndex({ externalId: handle.externalId });

    const indexes = await runtime.listIndexes();
    const found = indexes.find((i) => i.name === 'to-delete');
    expect(found).toBeUndefined();
  });
});

// ── Vector operations ─────────────────────────────────────────────────────

describe('Vector upsert and query', () => {
  let handle: Awaited<ReturnType<typeof runtime.createIndex>>;

  beforeAll(async () => {
    handle = await runtime.createIndex({
      name: 'query-test',
      dimension: 3,
      metric: 'cosine',
    });

    await runtime.upsertVectors(handle, [
      { id: 'v1', values: [1, 0, 0], metadata: { label: 'x-axis' } },
      { id: 'v2', values: [0, 1, 0], metadata: { label: 'y-axis' } },
      { id: 'v3', values: [0, 0, 1], metadata: { label: 'z-axis' } },
      { id: 'v4', values: [0.7071, 0.7071, 0], metadata: { label: 'xy-diagonal' } },
    ]);
  });

  it('returns top-K results sorted by cosine similarity', async () => {
    const result = await runtime.queryVectors(handle, {
      vector: [1, 0, 0],
      topK: 2,
    });

    expect(result.matches).toHaveLength(2);
    // v1 should be the best match (exact)
    expect(result.matches[0].id).toBe('v1');
    expect(result.matches[0].score).toBeCloseTo(1.0, 4);
    // v4 (xy-diagonal) should be second
    expect(result.matches[1].id).toBe('v4');
    expect(result.matches[1].score).toBeGreaterThan(0.5);
  });

  it('includes metadata in query results', async () => {
    const result = await runtime.queryVectors(handle, {
      vector: [0, 1, 0],
      topK: 1,
    });

    expect(result.matches[0].id).toBe('v2');
    expect(result.matches[0].metadata).toEqual({ label: 'y-axis' });
  });

  it('reports usage with candidate count', async () => {
    const result = await runtime.queryVectors(handle, {
      vector: [0, 0, 1],
      topK: 10,
    });

    expect(result.usage).toBeDefined();
    expect(result.usage?.candidateCount).toBe(4);
    // topK > total vectors → returns all
    expect(result.matches).toHaveLength(4);
  });

  it('upserts (updates) existing vectors', async () => {
    await runtime.upsertVectors(handle, [
      { id: 'v1', values: [0, 0, 1], metadata: { label: 'updated-to-z' } },
    ]);

    const result = await runtime.queryVectors(handle, {
      vector: [0, 0, 1],
      topK: 1,
    });

    expect(result.matches[0].id).toBe('v1');
    expect(result.matches[0].metadata).toEqual({ label: 'updated-to-z' });
    expect(result.matches[0].score).toBeCloseTo(1.0, 4);
  });

  it('deletes vectors by id', async () => {
    await runtime.deleteVectors(handle, ['v1']);

    const result = await runtime.queryVectors(handle, {
      vector: [1, 0, 0],
      topK: 10,
    });

    const ids = result.matches.map((m) => m.id);
    expect(ids).not.toContain('v1');
    expect(result.matches).toHaveLength(3);
  });
});

// ── Dimension validation ──────────────────────────────────────────────────

describe('Dimension validation', () => {
  let handle: Awaited<ReturnType<typeof runtime.createIndex>>;

  beforeAll(async () => {
    handle = await runtime.createIndex({
      name: 'dim-check',
      dimension: 2,
      metric: 'euclidean',
    });
  });

  it('rejects upsert with wrong dimension', async () => {
    await expect(
      runtime.upsertVectors(handle, [{ id: 'd1', values: [1, 2, 3] }]),
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it('rejects query with wrong dimension', async () => {
    await expect(
      runtime.queryVectors(handle, { vector: [1, 2, 3], topK: 1 }),
    ).rejects.toThrow(/dimension mismatch/i);
  });
});

// ── Metric variants ─────────────────────────────────────────────────────

describe('Metric variants', () => {
  it('dot product scoring', async () => {
    const h = await runtime.createIndex({
      name: 'dot-test',
      dimension: 2,
      metric: 'dot',
    });

    await runtime.upsertVectors(h, [
      { id: 'a', values: [3, 4] },
      { id: 'b', values: [1, 0] },
    ]);

    const result = await runtime.queryVectors(h, {
      vector: [1, 0],
      topK: 2,
    });

    // dot(a, [1,0]) = 3; dot(b, [1,0]) = 1
    expect(result.matches[0].id).toBe('a');
    expect(result.matches[0].score).toBeCloseTo(3, 4);
    expect(result.matches[1].id).toBe('b');
    expect(result.matches[1].score).toBeCloseTo(1, 4);
  });

  it('euclidean scoring (inverse distance)', async () => {
    const h = await runtime.createIndex({
      name: 'euc-test',
      dimension: 2,
      metric: 'euclidean',
    });

    await runtime.upsertVectors(h, [
      { id: 'near', values: [1.1, 0] },
      { id: 'far', values: [10, 10] },
    ]);

    const result = await runtime.queryVectors(h, {
      vector: [1, 0],
      topK: 2,
    });

    // "near" should have higher score (closer)
    expect(result.matches[0].id).toBe('near');
    expect(result.matches[0].score).toBeGreaterThan(result.matches[1].score);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('handles empty upsert gracefully', async () => {
    const h = await runtime.createIndex({ name: 'empty-upsert', dimension: 2 });
    await expect(runtime.upsertVectors(h, [])).resolves.toBeUndefined();
  });

  it('handles empty deleteVectors gracefully', async () => {
    const h = await runtime.createIndex({ name: 'empty-delete', dimension: 2 });
    await expect(runtime.deleteVectors(h, [])).resolves.toBeUndefined();
  });

  it('deleting a non-existent index is a no-op', async () => {
    await expect(
      runtime.deleteIndex({ externalId: 'nonexistent-id' }),
    ).resolves.toBeUndefined();
  });

  it('deleting non-existent vector ids is a no-op', async () => {
    const h = await runtime.createIndex({ name: 'del-noop', dimension: 2 });
    await expect(
      runtime.deleteVectors(h, ['no-such-id1', 'no-such-id2']),
    ).resolves.toBeUndefined();
  });

  it('cascade deletes vectors when index is deleted', async () => {
    const h = await runtime.createIndex({ name: 'cascade-test', dimension: 2 });
    await runtime.upsertVectors(h, [
      { id: 'c1', values: [1, 0] },
      { id: 'c2', values: [0, 1] },
    ]);

    await runtime.deleteIndex({ externalId: h.externalId });

    // Creating same name again should work without conflicts
    const h2 = await runtime.createIndex({ name: 'cascade-test', dimension: 2 });
    const result = await runtime.queryVectors(h2, { vector: [1, 0], topK: 10 });
    expect(result.matches).toHaveLength(0);
  });
});
