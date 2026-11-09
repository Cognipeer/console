/**
 * The vector service on a platform provider: a fake host names the one route (the real `sqlite-vector` driver in a
 * temp folder), core confines each tenant to its own folder, an index is created -> filled -> queried -> deleted,
 * nothing existing can be attached, and what is stored is metered against the plan storage (platform providers only).
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as any,
  connection: null as any,
  storage: {
    assertStorageStock: vi.fn(async (_input: unknown) => undefined),
    noteStoredBytes: vi.fn(),
  },
}));

vi.mock('@/lib/core/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: async () => undefined }));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: () => ({}) }));
vi.mock('@/lib/limits/storage', () => ({
  assertStorageStock: (input: unknown) => h.storage.assertStorageStock(input),
  noteStoredBytes: (...args: unknown[]) => h.storage.noteStoredBytes(...args),
}));
vi.mock('@/lib/services/providers/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/providers/providerService')>();
  const { ManagedProviderError } = await import('@/lib/services/providers/managedProviderErrors');
  const { isManagedProviderRecord } = await import('@/enterprise/managed-credits');
  const record = async (tenantDbName: string, tenantId: string, key: string) => {
    await h.db.switchToTenant(tenantDbName);
    return h.db.findProviderByKey(tenantId, key);
  };
  return {
    ...actual,
    getProviderConfigByKey: async (tenantDbName: string, tenantId: string, key: string) => {
      const found = await record(tenantDbName, tenantId, key);
      if (!found) return null;
      const { credentialsEnc, ...rest } = found;
      return { ...rest, platform: Boolean(found.platform), hasCredentials: Boolean(credentialsEnc) };
    },
    loadProviderRuntimeData: async (tenantDbName: string, ref: { tenantId: string; key: string }, options?: any) => {
      const found = await record(tenantDbName, ref.tenantId, ref.key);
      if (!found) throw new Error(`Provider configuration "${ref.key}" not found.`);
      if (!isManagedProviderRecord(found)) return { record: found, credentials: {} };
      if (!options?.managedConnectionId || !h.connection) throw new ManagedProviderError('This provider is not available right now.');
      return {
        record: found,
        credentials: {},
        managedConnection: { id: options.managedConnectionId, driver: h.connection.driver, settings: h.connection.settings },
      };
    },
  };
});

import { registerManagedCreditsHost, resetManagedCreditsHostForTests } from '@/enterprise/managed-credits';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { providerRegistry } from '@/lib/providers';
import { getManagedStorageRuntime, loadStorageProvider, tenantStorageToken } from '@/lib/services/storage/managedStorage';
import {
  VectorAttachNotAvailableError,
  createVectorIndex,
  deleteVectorIndex,
  deleteVectors,
  estimateUpsertBytes,
  getVectorIndex,
  getVectorIndexCount,
  listProjectVectorIndexes,
  listVectorIndexes,
  listVectorProviders,
  queryVectorIndex,
  updateVectorIndex,
  upsertVectors,
} from '@/lib/services/vector/vectorService';

const PLATFORM_KEY = 'platform-vector';
const OWN_KEY = 'own-vector';
const PROJECT = 'proj-1';

interface TestTenant {
  id: string;
  dbName: string;
}

let root: string;
let backendDir: string;
let ownDir: string;
let sqlite: SQLiteProvider;
let a: TestTenant;
let b: TestTenant;

async function newTenant(name: string): Promise<TestTenant> {
  const slug = `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const dbName = `tenant_${slug}`;
  const tenant = await sqlite.createTenant({ companyName: name, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
  await sqlite.switchToTenant(dbName);
  const base = { tenantId: String(tenant._id), projectIds: [PROJECT], type: 'vector' as const, status: 'active' as const, credentialsEnc: '', createdBy: 'system' };
  await sqlite.createProvider({ ...base, key: PLATFORM_KEY, driver: 'platform-virtual', label: 'Platform Vector', platform: true, settings: {} });
  await sqlite.createProvider({ ...base, key: OWN_KEY, driver: 'sqlite-vector', label: 'Own Vector', settings: { basePath: ownDir } });
  return { id: String(tenant._id), dbName };
}

const create = (t: TestTenant, name = 'docs', providerKey = PLATFORM_KEY, extra: Record<string, unknown> = {}) =>
  createVectorIndex(t.dbName, t.id, PROJECT, { providerKey, name, dimension: 3, metric: 'cosine', createdBy: 'u1', ...extra });
const vec = (id: string, values = [1, 0, 0], metadata?: Record<string, unknown>) => ({ id, values, metadata });
const upsert = (t: TestTenant, indexKey: string, vectors: ReturnType<typeof vec>[], providerKey = PLATFORM_KEY) =>
  upsertVectors(t.dbName, t.id, PROJECT, { providerKey, indexKey, vectors, updatedBy: 'u1' });
const stored = async (t: TestTenant, indexKey: string, providerKey = PLATFORM_KEY) => {
  await sqlite.switchToTenant(t.dbName);
  return sqlite.findVectorIndexByKey(providerKey, indexKey, PROJECT);
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'platform-vector-'));
  backendDir = path.join(root, 'backend');
  ownDir = path.join(root, 'own');
  sqlite = new SQLiteProvider(path.join(root, 'db'), 'platform_vector_main');
  await sqlite.connect();
  h.db = sqlite;
  a = await newTenant('acme');
  b = await newTenant('beta');
});

afterAll(async () => {
  await sqlite.disconnect();
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  h.connection = { driver: 'sqlite-vector', settings: { basePath: backendDir } };
  h.storage.assertStorageStock.mockReset();
  h.storage.assertStorageStock.mockResolvedValue(undefined);
  h.storage.noteStoredBytes.mockReset();
  registerManagedCreditsHost({
    isManagedProvider: (ref) => ref?.key === PLATFORM_KEY || ref?.platform === true,
    reserve: async () => { throw new Error('storage is never reserved'); },
    listRoutes: (query) => (query.providerKey === PLATFORM_KEY && query.kind === 'vector'
      ? [{ id: 'route-1', connectionId: 'conn-1', driver: 'sqlite-vector' }]
      : []),
    resolveConnection: () => null,
  });
  return () => resetManagedCreditsHostForTests();
});

describe('a platform vector provider: create -> upsert -> query -> delete', () => {
  it('runs the whole life of an index inside the tenant folder of the route', async () => {
    const index = await create(a, 'life');
    expect(index.key).toBe('life');
    await upsert(a, 'life', [vec('v1', [1, 0, 0], { topic: 'x' }), vec('v2', [0, 1, 0])]);

    const result = await queryVectorIndex(a.dbName, a.id, PROJECT, {
      providerKey: PLATFORM_KEY, indexKey: 'life', query: { vector: [1, 0, 0], topK: 2 },
    });
    expect(result.matches.map((match) => match.id)).toEqual(['v1', 'v2']);

    await deleteVectors(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'life', ids: ['v1'] });
    const after = await queryVectorIndex(a.dbName, a.id, PROJECT, {
      providerKey: PLATFORM_KEY, indexKey: 'life', query: { vector: [1, 0, 0], topK: 5 },
    });
    expect(after.matches.map((match) => match.id)).toEqual(['v2']);

    await deleteVectorIndex(a.dbName, a.id, PROJECT, PLATFORM_KEY, 'life');
    expect(await listVectorIndexes(a.dbName, a.id, PROJECT, PLATFORM_KEY)).toEqual([]);

    // The data landed under the tenant's token folder of the backend root, in the tenant's own folder below it.
    const token = tenantStorageToken(a.id);
    const files = await readdir(path.join(backendDir, token, a.id));
    expect(files).toContain(`${PLATFORM_KEY}-vectors.sqlite`);
  });

  it('keeps a second tenant out: it sees nothing, and its files are separate', async () => {
    await create(a, 'private');
    await upsert(a, 'private', [vec('secret')]);

    expect(await listVectorIndexes(b.dbName, b.id, PROJECT, PLATFORM_KEY)).toEqual([]);
    await expect(queryVectorIndex(b.dbName, b.id, PROJECT, {
      providerKey: PLATFORM_KEY, indexKey: 'private', query: { vector: [1, 0, 0], topK: 3 },
    })).rejects.toThrow(/not found/);

    // The same name on the other tenant is another index in another file.
    await create(b, 'private');
    const own = await queryVectorIndex(b.dbName, b.id, PROJECT, {
      providerKey: PLATFORM_KEY, indexKey: 'private', query: { vector: [1, 0, 0], topK: 3 },
    });
    expect(own.matches).toEqual([]);

    const tokenA = tenantStorageToken(a.id);
    const tokenB = tenantStorageToken(b.id);
    expect(tokenA).not.toBe(tokenB);
    expect(await readdir(path.join(backendDir, tokenA, a.id))).toContain(`${PLATFORM_KEY}-vectors.sqlite`);
    expect(await readdir(path.join(backendDir, tokenB, b.id))).toContain(`${PLATFORM_KEY}-vectors.sqlite`);
    // Nothing of one tenant is below the other's folder.
    expect(await readdir(path.join(backendDir, tokenA))).toEqual([a.id]);
    expect(await readdir(path.join(backendDir, tokenB))).toEqual([b.id]);
  });
});

describe('what a view of a platform provider shows', () => {
  it('gives the provider only functional capability keys and nothing that names the backend', async () => {
    const providers = await listVectorProviders(a.dbName, a.id, PROJECT, {});
    const platform = providers.find((provider) => provider.key === PLATFORM_KEY)!;
    expect(platform.platform).toBe(true);
    expect(platform.settings).toEqual({});
    const keys = Object.keys(platform.driverCapabilities ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(['vector.filterOperators', 'vector.filterRaw', 'vector.supportsHybrid', 'vector.metrics']).toContain(key);
    }
    expect(JSON.stringify(platform)).not.toMatch(/sqlite|basePath|local/i);
    // The tenant's own provider keeps every capability its driver declares.
    const own = providers.find((provider) => provider.key === OWN_KEY)!;
    expect(Object.keys(own.driverCapabilities ?? {})).toEqual(expect.arrayContaining(['local', 'builtin']));
  });

  it('never returns externalId or backend metadata for an index of a platform provider', async () => {
    const created = await create(a, 'views', PLATFORM_KEY, { metadata: { description: 'mine' } });
    expect(created).not.toHaveProperty('externalId');
    expect(created.metadata).toEqual({ description: 'mine' });

    const listed = await listVectorIndexes(a.dbName, a.id, PROJECT, PLATFORM_KEY);
    for (const index of listed) expect(index).not.toHaveProperty('externalId');
    const projectWide = await listProjectVectorIndexes(a.dbName, PROJECT);
    for (const index of projectWide.filter((item) => item.providerKey === PLATFORM_KEY)) expect(index).not.toHaveProperty('externalId');
    const { index, provider } = await getVectorIndex(a.dbName, a.id, PROJECT, PLATFORM_KEY, 'views');
    expect(index).not.toHaveProperty('externalId');
    expect(provider.platform).toBe(true);
    const renamed = await updateVectorIndex(a.dbName, a.id, PROJECT, PLATFORM_KEY, 'views', { name: 'Renamed', updatedBy: 'u1' });
    expect(renamed).not.toHaveProperty('externalId');
    expect(renamed.name).toBe('Renamed');

    // The record keeps the provider's identifier (server side only), and an update never changes it.
    const record = await stored(a, 'views');
    expect(record?.externalId).toBeTruthy();
    const before = record!.externalId;
    await updateVectorIndex(a.dbName, a.id, PROJECT, PLATFORM_KEY, 'views', {
      name: 'Again', metadata: { externalId: 'other', storedBytes: 9 }, updatedBy: 'u1',
      externalId: 'forged', storedBytes: 1e9,
    } as never);
    const after = await stored(a, 'views');
    expect(after?.externalId).toBe(before);
    expect(after?.storedBytes ?? 0).toBe(0);
  });

  it('keeps showing everything for an index on the tenant\'s own provider', async () => {
    const created = await create(a, 'own-view', OWN_KEY);
    expect(created.externalId).toBeTruthy();
  });
});

describe('attaching an existing index', () => {
  it('is refused on a platform provider: 409 attach_not_available, before anything is created', async () => {
    const error = await create(a, 'existing', PLATFORM_KEY, { createInProvider: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VectorAttachNotAvailableError);
    expect(error).toMatchObject({
      status: 409,
      code: 'attach_not_available',
      message: 'Attaching an existing index is not available on this provider.',
    });
    expect(await listVectorIndexes(a.dbName, a.id, PROJECT, PLATFORM_KEY).then((rows) => rows.filter((row) => row.name === 'existing'))).toEqual([]);
  });

  it('still works on the tenant\'s own provider', async () => {
    await create(a, 'attach-me', OWN_KEY);
    const runtime = await providerRegistry.createRuntime<any>('sqlite-vector', {
      tenantId: a.id, providerKey: OWN_KEY, credentials: {}, settings: { basePath: ownDir },
    });
    expect((await runtime.listIndexes()).some((item: { name: string }) => item.name === 'attach-me')).toBe(true);
    const error = await create(a, 'missing', OWN_KEY, { createInProvider: false }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(VectorAttachNotAvailableError);
  });
});

describe('metering what a platform provider stores', () => {
  it('estimates dimension * 4 + the id and the metadata as JSON, per vector', () => {
    const items = [vec('ab', [1, 2, 3], { k: 'é' }), vec('c', [1, 2, 3])];
    const expected = (3 * 4 + 2 + Buffer.byteLength('{"k":"é"}')) + (3 * 4 + 1 + Buffer.byteLength('{}'));
    expect(estimateUpsertBytes(3, items)).toBe(expected);
  });

  it('asks the plan before the provider is called, then counts the estimate on the index and in the cache', async () => {
    await create(a, 'meter');
    const items = [vec('m1', [1, 0, 0], { n: 1 }), vec('m2', [0, 1, 0])];
    const estimate = estimateUpsertBytes(3, items);

    let storedAtCheck: number | undefined;
    h.storage.assertStorageStock.mockImplementationOnce(async () => {
      // Nothing is written yet when the plan is asked.
      storedAtCheck = (await stored(a, 'meter'))?.storedBytes ?? 0;
      const result = await queryVectorIndex(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'meter', query: { vector: [1, 0, 0], topK: 5 } });
      expect(result.matches).toEqual([]);
    });
    await upsert(a, 'meter', items);

    expect(h.storage.assertStorageStock).toHaveBeenCalledTimes(1);
    expect(h.storage.assertStorageStock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: a.id, incomingBytes: estimate }));
    expect(storedAtCheck).toBe(0);
    expect(await stored(a, 'meter')).toMatchObject({ storedBytes: estimate, storedVectors: 2 });
    expect(h.storage.noteStoredBytes).toHaveBeenCalledWith(a.id, estimate);
  });

  it('refuses an upsert the plan refuses: nothing is stored or counted', async () => {
    await create(a, 'full');
    h.storage.assertStorageStock.mockRejectedValueOnce(new Error('storage is full'));
    await expect(upsert(a, 'full', [vec('x')])).rejects.toThrow('storage is full');
    expect(await stored(a, 'full')).not.toMatchObject({ storedBytes: expect.any(Number) });
    expect(h.storage.noteStoredBytes).not.toHaveBeenCalled();
    const result = await queryVectorIndex(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'full', query: { vector: [1, 0, 0], topK: 5 } });
    expect(result.matches).toEqual([]);
  });

  it('takes the average of the index off when vectors are deleted, and the rest off when the index goes', async () => {
    await create(a, 'shrink');
    const items = [vec('s1', [1, 0, 0], { pad: 'aaaa' }), vec('s2', [0, 1, 0], { pad: 'aaaa' }), vec('s3', [0, 0, 1], { pad: 'aaaa' }), vec('s4', [1, 1, 0], { pad: 'aaaa' })];
    const estimate = estimateUpsertBytes(3, items);
    await upsert(a, 'shrink', items);
    h.storage.noteStoredBytes.mockClear();

    await deleteVectors(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'shrink', ids: ['s1'] });
    const afterOne = await stored(a, 'shrink');
    const average = Math.round(estimate / 4);
    expect(afterOne).toMatchObject({ storedVectors: 3, storedBytes: estimate - average });
    expect(h.storage.noteStoredBytes).toHaveBeenCalledWith(a.id, -average);
    expect(h.storage.assertStorageStock).toHaveBeenCalledTimes(1);

    h.storage.noteStoredBytes.mockClear();
    await deleteVectorIndex(a.dbName, a.id, PROJECT, PLATFORM_KEY, 'shrink');
    expect(h.storage.noteStoredBytes).toHaveBeenCalledWith(a.id, -(estimate - average));
  });

  it('scales both numbers down when the live count is below what was counted (reconcile), never up', async () => {
    await create(a, 'reconcile');
    const items = [vec('r1'), vec('r2', [0, 1, 0]), vec('r3', [0, 0, 1]), vec('r4', [1, 1, 0])];
    const estimate = estimateUpsertBytes(3, items);
    await upsert(a, 'reconcile', items);

    // Two vectors leave the store some other way than through the service.
    const record = await stored(a, 'reconcile');
    const token = tenantStorageToken(a.id);
    const runtime = await providerRegistry.createRuntime<any>('sqlite-vector', {
      tenantId: a.id, providerKey: PLATFORM_KEY, credentials: {}, settings: { basePath: path.join(backendDir, token) },
    });
    await runtime.deleteVectors({ externalId: record!.externalId, name: 'reconcile', dimension: 3, metric: 'cosine' }, ['r1', 'r2']);
    h.storage.noteStoredBytes.mockClear();

    expect(await getVectorIndexCount(a.dbName, a.id, PROJECT, PLATFORM_KEY, 'reconcile')).toBe(2);
    const scaled = await stored(a, 'reconcile');
    expect(scaled).toMatchObject({ storedVectors: 2, storedBytes: Math.round(estimate / 2) });
    expect(h.storage.noteStoredBytes).toHaveBeenCalledWith(a.id, Math.round(estimate / 2) - estimate);

    // A count that agrees changes nothing.
    h.storage.noteStoredBytes.mockClear();
    await getVectorIndexCount(a.dbName, a.id, PROJECT, PLATFORM_KEY, 'reconcile');
    expect(await stored(a, 'reconcile')).toMatchObject({ storedVectors: 2, storedBytes: Math.round(estimate / 2) });
    expect(h.storage.noteStoredBytes).not.toHaveBeenCalled();
  });

  it('never meters the tenant\'s own provider', async () => {
    await create(a, 'unmetered', OWN_KEY);
    await upsert(a, 'unmetered', [vec('u1'), vec('u2', [0, 1, 0])], OWN_KEY);
    await deleteVectors(a.dbName, a.id, PROJECT, { providerKey: OWN_KEY, indexKey: 'unmetered', ids: ['u1'] });
    await getVectorIndexCount(a.dbName, a.id, PROJECT, OWN_KEY, 'unmetered');
    await deleteVectorIndex(a.dbName, a.id, PROJECT, OWN_KEY, 'unmetered');
    expect(h.storage.assertStorageStock).not.toHaveBeenCalled();
    expect(h.storage.noteStoredBytes).not.toHaveBeenCalled();
  });
});

/** The pooled runtime the service uses for the tenant (the same object: the pool keys on tenant, provider and route). */
async function pooledRuntime(t: TestTenant): Promise<any> {
  const loaded = await loadStorageProvider('vector', { tenantDbName: t.dbName, tenantId: t.id, providerKey: PLATFORM_KEY, projectId: PROJECT });
  return getManagedStorageRuntime<any>('vector', loaded as any, { tenantId: t.id, projectId: PROJECT });
}

describe('metering deletes and re-upserts against what exists', () => {
  const pad = { pad: 'aaaa' };

  it('does not take anything off for made-up ids, nor for a repeated id more than once', async () => {
    await create(a, 'del-exist');
    const items = [vec('d1', [1, 0, 0], pad), vec('d2', [0, 1, 0], pad), vec('d3', [0, 0, 1], pad), vec('d4', [1, 1, 0], pad)];
    const estimate = estimateUpsertBytes(3, items);
    await upsert(a, 'del-exist', items);
    h.storage.noteStoredBytes.mockClear();

    const del = (ids: string[]) => deleteVectors(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'del-exist', ids });
    await del(['ghost-1', 'ghost-2', 'ghost-3', 'ghost-4']);
    expect(await stored(a, 'del-exist')).toMatchObject({ storedVectors: 4, storedBytes: estimate });
    expect(h.storage.noteStoredBytes).not.toHaveBeenCalled();

    await del(['d1', 'd1', 'd1', 'ghost-1']);
    const average = Math.round(estimate / 4);
    expect(await stored(a, 'del-exist')).toMatchObject({ storedVectors: 3, storedBytes: estimate - average });
    expect(h.storage.noteStoredBytes).toHaveBeenCalledWith(a.id, -average);
    // The vector is gone from the store, the rest is still there.
    const left = await queryVectorIndex(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'del-exist', query: { vector: [1, 0, 0], topK: 10 } });
    expect(left.matches.map((match) => match.id).sort()).toEqual(['d2', 'd3', 'd4']);
  });

  it('does not take anything off when the provider cannot say which ids exist, but still deletes', async () => {
    await create(a, 'del-blind');
    const items = [vec('b1'), vec('b2', [0, 1, 0])];
    const estimate = estimateUpsertBytes(3, items);
    await upsert(a, 'del-blind', items);
    const runtime = await pooledRuntime(a);
    const lookup = runtime.existingVectorIds;
    runtime.existingVectorIds = undefined;
    try {
      await deleteVectors(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'del-blind', ids: ['b1'] });
    } finally {
      runtime.existingVectorIds = lookup;
    }
    expect(await stored(a, 'del-blind')).toMatchObject({ storedVectors: 2, storedBytes: estimate });
    const left = await queryVectorIndex(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'del-blind', query: { vector: [1, 0, 0], topK: 10 } });
    expect(left.matches.map((match) => match.id)).toEqual(['b2']);
  });

  it('counts a re-upserted id by the size difference only and adds no vector', async () => {
    await create(a, 're-up');
    const first = [vec('u1', [1, 0, 0], pad), vec('u2', [0, 1, 0], pad)];
    const estimate = estimateUpsertBytes(3, first);
    await upsert(a, 're-up', first);
    const average = Math.round(estimate / 2);
    h.storage.noteStoredBytes.mockClear();

    const bigger = vec('u1', [1, 0, 0], { pad: 'a'.repeat(100) });
    await upsert(a, 're-up', [bigger]);
    const grown = estimateUpsertBytes(3, [bigger]) - average;
    expect(await stored(a, 're-up')).toMatchObject({ storedVectors: 2, storedBytes: estimate + grown });
    expect(h.storage.noteStoredBytes).toHaveBeenCalledWith(a.id, grown);
    // The plan is asked for the full estimate, as for a new id.
    expect(h.storage.assertStorageStock).toHaveBeenLastCalledWith(expect.objectContaining({ incomingBytes: estimateUpsertBytes(3, [bigger]) }));

    // A smaller replacement shrinks the meter, which never goes below 0.
    for (let i = 0; i < 4; i += 1) await upsert(a, 're-up', [vec('u2', [0, 1, 0])]);
    const record = await stored(a, 're-up');
    expect(record?.storedVectors).toBe(2);
    expect(record?.storedBytes ?? -1).toBeGreaterThanOrEqual(0);
  });

  it('mixes new and replaced ids, and takes the last item of an id repeated in one request', async () => {
    await create(a, 're-mix');
    await upsert(a, 're-mix', [vec('x1', [1, 0, 0], pad)]);
    const before = await stored(a, 're-mix');
    const average = before!.storedBytes!;

    const items = [vec('x1', [1, 0, 0], pad), vec('x2', [0, 1, 0], pad), vec('x2', [0, 0, 1], { pad: 'bbbbbbbb' })];
    await upsert(a, 're-mix', items);
    const kept = [vec('x1', [1, 0, 0], pad), vec('x2', [0, 0, 1], { pad: 'bbbbbbbb' })];
    const expected = average + (estimateUpsertBytes(3, [kept[0]]) - average) + estimateUpsertBytes(3, [kept[1]]);
    expect(await stored(a, 're-mix')).toMatchObject({ storedVectors: 2, storedBytes: expected });
    const result = await queryVectorIndex(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 're-mix', query: { vector: [0, 0, 1], topK: 5 } });
    expect(result.matches[0].id).toBe('x2');
    expect(result.matches).toHaveLength(2);
  });
});

describe('what a query on a platform provider returns besides matches', () => {
  it('keeps only the allowlisted notes of usage, and leaves the tenant\'s own provider as it is', async () => {
    await create(a, 'usage');
    await create(a, 'usage-own', OWN_KEY);
    const leaky = {
      matches: [],
      usage: {
        hybrid: false, hybridMode: 'dense', hybridUnavailable: 'driver', resultCount: 0,
        index: 'arn:aws:s3vectors:eu-central-1:123456789012:bucket/ops/index/x', provider: 'aws-s3-vectors', providerKey: 'conn-1',
      },
    };
    const runtime = await pooledRuntime(a);
    const original = runtime.queryVectors;
    runtime.queryVectors = async () => leaky;
    try {
      const result = await queryVectorIndex(a.dbName, a.id, PROJECT, { providerKey: PLATFORM_KEY, indexKey: 'usage', query: { vector: [1, 0, 0], topK: 1 } });
      expect(result.usage).toEqual({ hybrid: false, hybridMode: 'dense', hybridUnavailable: 'driver', resultCount: 0 });
      expect(JSON.stringify(result)).not.toMatch(/arn:aws|providerKey|aws-s3-vectors/);
    } finally {
      runtime.queryVectors = original;
    }
    const own = await queryVectorIndex(a.dbName, a.id, PROJECT, { providerKey: OWN_KEY, indexKey: 'usage-own', query: { vector: [1, 0, 0], topK: 1 } });
    expect(own.matches).toEqual([]);
  });
});

describe('a platform route that cannot serve', () => {
  it('refuses with the generic message when the host names no live route', async () => {
    resetManagedCreditsHostForTests();
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref?.key === PLATFORM_KEY,
      reserve: async () => { throw new Error('never'); },
      listRoutes: () => [],
      resolveConnection: () => null,
    });
    await expect(create(a, 'down')).rejects.toThrow('This provider is not available right now.');
  });
});
