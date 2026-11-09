/**
 * Managed storage: a platform file or vector provider is served by the host's one live route, and core confines the
 * tenant whatever connection the host returns (root-scoped drivers get the tenant's folder, the name-scoped vector
 * driver only reaches the tenant's indexes, any other driver is refused).
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  records: new Map<string, any>(),
  calls: [] as Array<{ key?: string; options?: any }>,
  connection: null as any,
}));

vi.mock('@/lib/core/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock('@/lib/services/providers/providerService', async () => {
  const { ManagedProviderError } = await import('@/lib/services/providers/managedProviderErrors');
  const { isManagedProviderRecord } = await import('@/enterprise/managed-credits');
  return {
    loadProviderRuntimeData: async (_db: string, ref: { key?: string }, options?: any) => {
      h.calls.push({ key: ref.key, options });
      const record = h.records.get(String(ref.key));
      if (!record) throw new Error(`Provider configuration "${ref.key}" not found.`);
      if (!isManagedProviderRecord(record)) return { record, credentials: { own: true } };
      if (!options?.managedConnectionId) throw new ManagedProviderError('This provider is not available right now.');
      const connection = h.connection;
      if (!connection) throw new ManagedProviderError('This provider is not available right now.');
      return {
        record,
        credentials: connection.credentials,
        managedConnection: { id: options.managedConnectionId, driver: connection.driver, settings: connection.settings },
      };
    },
  };
});

import { registerManagedCreditsHost, resetManagedCreditsHostForTests, type ManagedRouteQuery } from '@/enterprise/managed-credits';
import { ManagedProviderError } from '@/lib/services/providers/managedProviderErrors';
import type { FileProviderRuntime } from '@/lib/providers/domains/file';
import type { VectorIndexHandle, VectorProviderRuntime } from '@/lib/providers/domains/vector';
import { providerRegistry } from '@/lib/providers/registry';
import {
  MANAGED_STORAGE_DRIVERS,
  backendIdentifiers,
  getManagedStorageRuntime,
  loadStorageProvider,
  managedIndexName,
  scopeStorageSettings,
  tenantStorageToken,
  withoutBackendIdentifiers,
  wrapNameScopedVectorRuntime,
} from '@/lib/services/storage/managedStorage';

const platformRecord = (key: string, type: 'file' | 'vector'): any => ({
  _id: `id-${key}`, tenantId: 't1', key, type, driver: 'platform-virtual', settings: {}, status: 'active',
  platform: true, metadata: { platform: true },
});
const ownRecord = (key: string, type: 'file' | 'vector', driver: string): any => ({
  _id: `id-${key}`, tenantId: 't1', key, type, driver, settings: { basePath: '/tenant/own' }, status: 'active',
});

let routes: Record<string, string[]> = {};

beforeEach(() => {
  h.records.clear();
  h.calls.length = 0;
  h.connection = null;
  routes = { 'platform-files:file': ['files-backend'], 'platform-vector:vector': ['vector-backend'] };
  registerManagedCreditsHost({
    isManagedProvider: (ref) => ref?.key === 'platform-files' || ref?.key === 'platform-vector' || ref?.platform === true,
    reserve: async () => { throw new Error('never reserved for storage'); },
    listRoutes: (query: ManagedRouteQuery) => (routes[`${query.providerKey}:${query.kind}`] ?? [])
      .map((connectionId) => ({ id: `${connectionId}:${query.kind}`, connectionId, driver: 'x' })),
    resolveConnection: () => null,
  });
});

afterEach(() => {
  resetManagedCreditsHostForTests();
});

describe('tenantStorageToken', () => {
  it('is stable, the same length for every tenant, and neither the id nor the slug', () => {
    const a = tenantStorageToken('65f0c0ffee0000000000aaaa');
    expect(a).toMatch(/^t[0-9a-f]{16}$/);
    expect(tenantStorageToken('65f0c0ffee0000000000aaaa')).toBe(a);
    expect(tenantStorageToken('65f0c0ffee0000000000aaab')).not.toBe(a);
    expect(tenantStorageToken('acme')).toHaveLength(a.length);
    expect(a).not.toContain('65f0c0ffee');
  });
});

describe('scopeStorageSettings', () => {
  const token = 'tabc';
  it('roots each root-scoped driver in the tenant folder and keeps every other setting', () => {
    expect(scopeStorageSettings('local-filesystem', { basePath: '/srv/files' }, token)).toEqual({ basePath: '/srv/files', subdirectory: 'tabc' });
    expect(scopeStorageSettings('local-filesystem', { subdirectory: '/platform/' }, token)).toEqual({ subdirectory: 'platform/tabc' });
    expect(scopeStorageSettings('aws-s3-files', { bucket: 'b', region: 'r' }, token)).toEqual({ bucket: 'b', region: 'r', prefix: 'tabc' });
    expect(scopeStorageSettings('aws-s3-files', { bucket: 'b', prefix: '/tenants/' }, token)).toEqual({ bucket: 'b', prefix: 'tenants/tabc' });
    expect(scopeStorageSettings('s3-compatible-files', { endpoint: 'e', prefix: 'x' }, token)).toEqual({ endpoint: 'e', prefix: 'x/tabc' });
    expect(scopeStorageSettings('sqlite-vector', { basePath: '/srv/vec' }, token)).toEqual({ basePath: path.join('/srv/vec', 'tabc') });
    const fallback = scopeStorageSettings('sqlite-vector', {}, token);
    expect(String(fallback?.basePath)).toMatch(/vectors[/\\]tabc$/);
  });

  it('answers null for any driver that is not root-scoped', () => {
    for (const driver of ['aws-s3-vectors', 'system-default', 'azure-blob-files', 'mongo-gridfs', 'unknown']) {
      expect(scopeStorageSettings(driver, { basePath: '/x' }, token)).toBeNull();
    }
  });
});

describe('managedIndexName', () => {
  const token = tenantStorageToken('tenant-a');
  it('names the index with the token, a slug of the name and the random part, within 63 lowercase characters', () => {
    expect(managedIndexName(token, 'Product Docs', 'abcd1234')).toBe(`${token}-product-docs-abcd1234`);
    const long = managedIndexName(token, 'A'.repeat(200), 'abcd1234');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^t[0-9a-f]{16}-a+-abcd1234$/);
    for (const name of ['', '   ', 'Ünïcödé ✓', '---', '../../etc']) {
      const physical = managedIndexName(token, name, 'abcd1234');
      expect(physical).toMatch(/^t[0-9a-f]{16}-[a-z0-9-]+-abcd1234$/);
      expect(physical).not.toMatch(/--|\.\./);
      expect(physical.length).toBeLessThanOrEqual(63);
    }
    expect(managedIndexName(token, '', 'abcd1234')).toBe(`${token}-index-abcd1234`);
  });

  it('differs between two indexes with the same name', () => {
    expect(managedIndexName(token, 'docs')).not.toBe(managedIndexName(token, 'docs'));
  });
});

describe('the name-scoped vector runtime', () => {
  const token = tenantStorageToken('tenant-a');
  const other = tenantStorageToken('tenant-b');
  const arn = (bucket: string, name: string) => `arn:aws:s3vectors:eu-central-1:123456789012:bucket/${bucket}/index/${name}`;
  const handle = (externalId: string, metadata: Record<string, unknown> = {}): VectorIndexHandle =>
    ({ externalId, name: 'docs', dimension: 3, metric: 'cosine', metadata });

  function fakeInner() {
    const seen: Array<{ op: string; externalId?: string; metadata?: unknown; name?: string }> = [];
    const inner: VectorProviderRuntime = {
      createIndex: async (input) => { seen.push({ op: 'create', name: input.name }); return { ...handle(arn('platform-vectors', input.name), { indexArn: arn('platform-vectors', input.name), bucket: 'platform-vectors' }), name: input.name }; },
      deleteIndex: async ({ externalId }) => { seen.push({ op: 'deleteIndex', externalId }); },
      listIndexes: async () => [
        handle(arn('platform-vectors', `${token}-docs-11111111`), { indexName: `${token}-docs-11111111` }),
        handle(arn('platform-vectors', `${other}-docs-22222222`)),
        handle(arn('elsewhere', `${token}-docs-33333333`)),
      ],
      upsertVectors: async (h0) => { seen.push({ op: 'upsert', externalId: h0.externalId, metadata: h0.metadata }); },
      queryVectors: async (h0) => { seen.push({ op: 'query', externalId: h0.externalId, metadata: h0.metadata }); return { matches: [] }; },
      deleteVectors: async (h0) => { seen.push({ op: 'deleteVectors', externalId: h0.externalId }); },
      listVectors: async (h0) => { seen.push({ op: 'list', externalId: h0.externalId }); return { items: [] }; },
    };
    return { inner, seen };
  }

  it('creates indexes under a tenant name and hands back the tenant name with no backend metadata', async () => {
    const { inner, seen } = fakeInner();
    const runtime = wrapNameScopedVectorRuntime(inner, token, 'platform-vectors');
    const created = await runtime.createIndex({ name: 'Docs', dimension: 3 });
    expect(seen[0].name).toMatch(new RegExp(`^${token}-docs-[0-9a-f]{8}$`));
    expect(created.name).toBe('Docs');
    expect(created.externalId).toBe(arn('platform-vectors', String(seen[0].name)));
    expect(created.metadata).toEqual({});
  });

  it('refuses a created handle that is not the index it asked for', async () => {
    const { inner } = fakeInner();
    inner.createIndex = async () => handle(arn('platform-vectors', `${other}-docs-22222222`));
    await expect(wrapNameScopedVectorRuntime(inner, token, 'platform-vectors').createIndex({ name: 'docs', dimension: 3 }))
      .rejects.toBeInstanceOf(ManagedProviderError);
  });

  it('lists only the tenant\'s indexes in the configured bucket', async () => {
    const { inner } = fakeInner();
    const list = await wrapNameScopedVectorRuntime(inner, token, 'platform-vectors').listIndexes();
    expect(list.map((i) => i.externalId)).toEqual([arn('platform-vectors', `${token}-docs-11111111`)]);
    expect(list[0].metadata).toEqual({});
  });

  it('reaches the tenant\'s own index, with the metadata identifiers the driver would prefer dropped', async () => {
    const { inner, seen } = fakeInner();
    const runtime = wrapNameScopedVectorRuntime(inner, token, 'platform-vectors');
    const own = arn('platform-vectors', `${token}-docs-11111111`);
    // A stored handle whose metadata points at another tenant's index still reaches only the verified ARN.
    const tampered = handle(own, { indexArn: arn('platform-vectors', `${other}-docs-22222222`), indexName: `${other}-docs-22222222`, keep: 1 });
    await runtime.upsertVectors(tampered, []);
    await runtime.queryVectors(tampered, { topK: 1, vector: [0, 0, 1] });
    await runtime.deleteVectors(tampered, ['a']);
    await runtime.listVectors(tampered);
    await runtime.deleteIndex({ externalId: own });
    expect(seen.map((s) => [s.op, s.externalId])).toEqual([
      ['upsert', own], ['query', own], ['deleteVectors', own], ['list', own], ['deleteIndex', own],
    ]);
    expect(seen[0].metadata).toEqual({ keep: 1 });
  });

  it('refuses another tenant\'s index, another bucket, a bare name and anything that is not an index ARN', async () => {
    const { inner, seen } = fakeInner();
    const runtime = wrapNameScopedVectorRuntime(inner, token, 'platform-vectors');
    for (const externalId of [
      arn('platform-vectors', `${other}-docs-22222222`),
      arn('elsewhere', `${token}-docs-33333333`),
      `${token}-docs-11111111`,
      `arn:aws:s3vectors:eu-central-1:123456789012:bucket/platform-vectors/index/${token}-docs/../x`,
      `arn:aws:s3:::platform-vectors/${token}-docs`,
      '',
    ]) {
      await expect(runtime.upsertVectors(handle(externalId), [])).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.queryVectors(handle(externalId), { topK: 1, vector: [1] })).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.deleteVectors(handle(externalId), ['a'])).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.listVectors(handle(externalId))).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.deleteIndex({ externalId })).rejects.toBeInstanceOf(ManagedProviderError);
    }
    expect(seen).toEqual([]);
  });
});

describe('the name-scoped vector runtime: created index and existing ids', () => {
  const token = tenantStorageToken('tenant-a');
  const arn = (bucket: string, name: string) => `arn:aws:s3vectors:eu-central-1:123456789012:bucket/${bucket}/index/${name}`;
  const handle = (externalId: string): VectorIndexHandle => ({ externalId, name: 'docs', dimension: 3, metric: 'cosine', metadata: {} });
  const baseInner = (over: Partial<VectorProviderRuntime>): VectorProviderRuntime => ({
    createIndex: async () => { throw new Error('unused'); },
    deleteIndex: async () => undefined,
    listIndexes: async () => [],
    upsertVectors: async () => undefined,
    queryVectors: async () => ({ matches: [] }),
    deleteVectors: async () => undefined,
    listVectors: async () => ({ items: [] }),
    ...over,
  });

  it('removes an index whose handle came back as the bare physical name, then refuses (no orphan, no bare-name handle)', async () => {
    const deleted: string[] = [];
    let physical = '';
    const inner = baseInner({
      createIndex: async (input) => { physical = input.name; return handle(input.name); },
      deleteIndex: async ({ externalId }) => { deleted.push(externalId); },
    });
    await expect(wrapNameScopedVectorRuntime(inner, token, 'vb').createIndex({ name: 'docs', dimension: 3 }))
      .rejects.toBeInstanceOf(ManagedProviderError);
    expect(deleted).toEqual([physical]);
  });

  it('does not delete anything for a handle that is not the generated name', async () => {
    const deleted: string[] = [];
    const inner = baseInner({
      createIndex: async () => handle(`${token}-other-00000000`),
      deleteIndex: async ({ externalId }) => { deleted.push(externalId); },
    });
    await expect(wrapNameScopedVectorRuntime(inner, token, 'vb').createIndex({ name: 'docs', dimension: 3 }))
      .rejects.toBeInstanceOf(ManagedProviderError);
    expect(deleted).toEqual([]);
  });

  it('passes existingVectorIds through with the same ownership check, and offers it only when the driver has it', async () => {
    const seen: string[] = [];
    const inner = baseInner({ existingVectorIds: async (h0, ids) => { seen.push(h0.externalId); return ids.slice(0, 1); } });
    const runtime = wrapNameScopedVectorRuntime(inner, token, 'vb');
    const own = arn('vb', `${token}-docs-11111111`);
    expect(await runtime.existingVectorIds!(handle(own), ['a', 'b'])).toEqual(['a']);
    expect(seen).toEqual([own]);
    await expect(runtime.existingVectorIds!(handle(arn('vb', 'tother-docs-22222222')), ['a'])).rejects.toBeInstanceOf(ManagedProviderError);
    expect(wrapNameScopedVectorRuntime(baseInner({}), token, 'vb').existingVectorIds).toBeUndefined();
  });
});

describe('error messages of a platform storage runtime', () => {
  const token = tenantStorageToken('tenant-a');
  const settings = { bucket: 'ops-bucket', endpoint: 'https://s3.internal.example:9000', prefix: `tenants/${token}`, basePath: '/srv/ops-data' };
  const identifiers = backendIdentifiers({ settings, token });

  it('lists the backend settings, the token and any ARN, with and without the tenant token', () => {
    expect(identifiers).toEqual(expect.arrayContaining([
      token, 'arn:aws:', 'ops-bucket', 's3.internal.example:9000', 's3.internal.example', 'tenants', '/srv/ops-data',
    ]));
  });

  it('replaces a message that names the backend with the generic one', async () => {
    const runtime = withoutBackendIdentifiers({
      async a() { throw new Error('The specified bucket ops-bucket does not exist'); },
      async b() { throw new Error('ENOENT: no such file /srv/ops-data/x/y'); },
      async c() { throw new Error(`access denied for arn:aws:s3vectors:eu:1:bucket/x/index/y`); },
      async d() { throw new Error(`key ${token}/docs missing`); },
      async e() { throw new Error('connect ECONNREFUSED s3.internal.example:9000'); },
      f() { throw new Error('sync failure at ops-bucket'); },
    }, identifiers, 'file');
    for (const call of [runtime.a(), runtime.b(), runtime.c(), runtime.d(), runtime.e()]) {
      await expect(call).rejects.toMatchObject({ message: 'This provider is not available right now.' });
      await expect(call).rejects.toBeInstanceOf(ManagedProviderError);
    }
    expect(() => runtime.f()).toThrow('This provider is not available right now.');
  });

  it('leaves a message without an identifier untouched and keeps only a 4xx status of the original', async () => {
    const plain = Object.assign(new Error('file not found'), { status: 404 });
    const runtime = withoutBackendIdentifiers({
      async missing() { throw plain; },
      async conflict() { throw Object.assign(new Error('Conflict at ops-bucket'), { status: 409 }); },
      async broken() { throw Object.assign(new Error('Boom at ops-bucket'), { status: 503 }); },
      async fine() { return 'ok'; },
      close() { return 'closed'; },
    }, identifiers, 'file');
    await expect(runtime.missing()).rejects.toBe(plain);
    await expect(runtime.conflict()).rejects.toMatchObject({ status: 409, message: 'This provider is not available right now.' });
    await expect(runtime.broken()).rejects.toMatchObject({ status: 400, message: 'This provider is not available right now.' });
    expect(await runtime.fine()).toBe('ok');
    expect(runtime.close()).toBe('closed');
  });

  it('applies to the runtime getManagedStorageRuntime returns (a file runtime here)', async () => {
    h.records.set('platform-files', platformRecord('platform-files', 'file'));
    h.connection = { driver: 'aws-s3-files', settings: { bucket: 'ops-bucket-xyz', region: 'r' }, credentials: {} };
    const create = vi.spyOn(providerRegistry, 'createRuntime').mockResolvedValue({
      downloadFile: async () => { throw new Error('NoSuchBucket: ops-bucket-xyz'); },
    } as never);
    try {
      const loaded = await loadStorageProvider('file', { tenantDbName: 'db', tenantId: 'tenant-sanitize', providerKey: 'platform-files' });
      const runtime = await getManagedStorageRuntime<FileProviderRuntime>('file', loaded as any, { tenantId: 'tenant-sanitize' });
      await expect(runtime.downloadFile('k')).rejects.toThrow('This provider is not available right now.');
    } finally {
      create.mockRestore();
    }
  });
});

describe('a platform vector route with a bucket ARN', () => {
  it('is refused: the driver would prefer the ARN to the bucket name that was checked', async () => {
    h.records.set('platform-vector', platformRecord('platform-vector', 'vector'));
    const context = { tenantDbName: 'db', tenantId: 't1', providerKey: 'platform-vector' };
    for (const arn of ['arn:aws:s3vectors:eu:1:bucket/other', 'x']) {
      h.connection = { driver: 'aws-s3-vectors', settings: { vectorBucketName: 'vb', vectorBucketArn: arn }, credentials: {} };
      await expect(loadStorageProvider('vector', context)).rejects.toThrow('This provider is not available right now.');
    }
    h.connection = { driver: 'aws-s3-vectors', settings: { vectorBucketName: 'vb', vectorBucketArn: '' }, credentials: {} };
    expect((await loadStorageProvider('vector', context)).managed?.driver).toBe('aws-s3-vectors');
  });
});

describe('loadStorageProvider', () => {
  const context = (providerKey: string) => ({ tenantDbName: 'tenant_db', tenantId: 't1', providerKey, projectId: 'p1' });

  it('loads the tenant\'s own provider as before (no route asked for, its own driver and credentials)', async () => {
    h.records.set('mine', ownRecord('mine', 'file', 'local-filesystem'));
    const loaded = await loadStorageProvider('file', context('mine'));
    expect(loaded.managed).toBeUndefined();
    expect(loaded.credentials).toEqual({ own: true });
    expect(h.calls[0].options).toEqual({ allowManaged: true });
  });

  it('serves a platform record from the first live route with the tenant folder applied', async () => {
    routes['platform-files:file'] = ['files-backend', 'second-backend'];
    h.records.set('platform-files', platformRecord('platform-files', 'file'));
    h.connection = { driver: 'aws-s3-files', settings: { bucket: 'b', prefix: 'tenants' }, credentials: { accessKeyId: 'k' } };
    const loaded = await loadStorageProvider('file', context('platform-files'));
    expect(h.calls[0].options).toEqual({ allowManaged: true, managedConnectionId: 'files-backend' });
    expect(loaded.managed).toEqual({
      connectionId: 'files-backend', driver: 'aws-s3-files', token: tenantStorageToken('t1'),
      settings: { bucket: 'b', prefix: `tenants/${tenantStorageToken('t1')}` },
    });
    expect(loaded.credentials).toEqual({ accessKeyId: 'k' });
  });

  it('refuses a platform record with no live route', async () => {
    routes = {};
    h.records.set('platform-files', platformRecord('platform-files', 'file'));
    await expect(loadStorageProvider('file', context('platform-files'))).rejects.toThrow('This provider is not available right now.');
  });

  it('refuses a route whose driver core cannot confine, and a driver of the other kind (generic message)', async () => {
    h.records.set('platform-files', platformRecord('platform-files', 'file'));
    h.records.set('platform-vector', platformRecord('platform-vector', 'vector'));
    for (const [key, kind, driver] of [
      ['platform-files', 'file', 'azure-blob-files'],
      ['platform-files', 'file', 'sqlite-vector'],
      ['platform-vector', 'vector', 'system-default'],
      ['platform-vector', 'vector', 'local-filesystem'],
    ] as const) {
      h.connection = { driver, settings: { basePath: '/x', vectorBucketName: 'b' }, credentials: {} };
      const error = await loadStorageProvider(kind, context(key)).catch((e) => e);
      expect(error).toBeInstanceOf(ManagedProviderError);
      expect(error.message).toBe('This provider is not available right now.');
    }
  });

  it('the name-scoped vector driver needs its bucket; its settings are kept as they are', async () => {
    h.records.set('platform-vector', platformRecord('platform-vector', 'vector'));
    h.connection = { driver: 'aws-s3-vectors', settings: { region: 'r' }, credentials: {} };
    await expect(loadStorageProvider('vector', context('platform-vector'))).rejects.toBeInstanceOf(ManagedProviderError);
    h.connection = { driver: 'aws-s3-vectors', settings: { region: 'r', vectorBucketName: 'vb' }, credentials: {} };
    expect((await loadStorageProvider('vector', context('platform-vector'))).managed?.settings).toEqual({ region: 'r', vectorBucketName: 'vb' });
  });

  it('allows exactly the drivers it can confine', () => {
    expect(MANAGED_STORAGE_DRIVERS).toEqual({
      file: ['local-filesystem', 'aws-s3-files', 's3-compatible-files'],
      vector: ['sqlite-vector', 'aws-s3-vectors'],
    });
  });
});

describe('getManagedStorageRuntime with the real local file driver', () => {
  let base = '';
  beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), 'managed-storage-')); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it('writes each tenant under its own folder below the backend root, never next to another tenant', async () => {
    h.records.set('platform-files', platformRecord('platform-files', 'file'));
    h.connection = { driver: 'local-filesystem', settings: { basePath: base }, credentials: {} };
    const runtimes: FileProviderRuntime[] = [];
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      const loaded = await loadStorageProvider('file', { tenantDbName: 'db', tenantId, providerKey: 'platform-files' });
      const runtime = await getManagedStorageRuntime<FileProviderRuntime>('file', loaded as any, { tenantId });
      await runtime.uploadFile({ key: 'docs/a.txt', name: 'a.txt', data: Buffer.from(`hello ${tenantId}`), contentType: 'text/plain' });
      runtimes.push(runtime);
    }
    const top = (await readdir(base)).sort();
    expect(top).toEqual([tenantStorageToken('tenant-a'), tenantStorageToken('tenant-b')].sort());
    expect(await readdir(path.join(base, tenantStorageToken('tenant-a')))).toEqual(['tenant-a']);
    expect(await readdir(path.join(base, tenantStorageToken('tenant-a'), 'tenant-a'))).toEqual(['platform-files']);
    // The same key reaches each tenant's own object only.
    expect(String((await runtimes[0].downloadFile('docs/a.txt')).data)).toBe('hello tenant-a');
    expect(String((await runtimes[1].downloadFile('docs/a.txt')).data)).toBe('hello tenant-b');
    // A key that tries to climb out of the tenant root is refused by the driver.
    await expect(runtimes[1].downloadFile(`../../${tenantStorageToken('tenant-a')}/tenant-a/platform-files/docs/a.txt`)).rejects.toThrow();
  });
});
