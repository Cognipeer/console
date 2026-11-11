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
import { sanitizeBlobKey } from '@/lib/providers/contracts/azure/blobKeys';
import {
  MANAGED_STORAGE_DRIVERS,
  backendIdentifiers,
  getManagedStorageRuntime,
  loadStorageProvider,
  managedIndexName,
  scopeStorageSettings,
  tenantStorageToken,
  withoutBackendIdentifiers,
  isConnectionLevelFailure,
  wrapNameScopedVectorRuntime,
  wrapPostgresVectorRuntime,
  wrapSearchVectorRuntime,
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
    expect(scopeStorageSettings('azure-blob-files', { container: 'c', accountName: 'acct' }, token)).toEqual({ container: 'c', accountName: 'acct', prefix: 'tabc' });
    expect(scopeStorageSettings('azure-blob-files', { container: 'c', prefix: '/tenants/' }, token)).toEqual({ container: 'c', prefix: 'tenants/tabc' });
    expect(scopeStorageSettings('sqlite-vector', { basePath: '/srv/vec' }, token)).toEqual({ basePath: path.join('/srv/vec', 'tabc') });
    const fallback = scopeStorageSettings('sqlite-vector', {}, token);
    expect(String(fallback?.basePath)).toMatch(/vectors[/\\]tabc$/);
  });

  it('answers null for any driver that is not root-scoped', () => {
    for (const driver of ['aws-s3-vectors', 'azure-ai-search', 'system-default', 'mongo-gridfs', 'unknown']) {
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

describe('an azure-blob-files runtime with a connection-string credential', () => {
  it('scrubs the account and host that exist only inside the credential from tenant-visible errors', async () => {
    h.records.set('platform-files', platformRecord('platform-files', 'file'));
    h.connection = {
      driver: 'azure-blob-files',
      settings: { container: 'c1' },
      credentials: { connectionString: 'DefaultEndpointsProtocol=https;AccountName=csacct;AccountKey=TOPSECRETKEY==;EndpointSuffix=core.windows.net' },
    };
    const create = vi.spyOn(providerRegistry, 'createRuntime').mockResolvedValue({
      downloadFile: async () => { throw new Error('connect ENOTFOUND csacct.blob.core.windows.net'); },
    } as never);
    try {
      const loaded = await loadStorageProvider('file', { tenantDbName: 'db', tenantId: 'tenant-az', providerKey: 'platform-files' });
      const runtime = await getManagedStorageRuntime<FileProviderRuntime>('file', loaded as any, { tenantId: 'tenant-az' });
      const error = await runtime.downloadFile('k').catch((e: Error) => e);
      expect((error as Error).message).toBe('This provider is not available right now.');
      expect(String((error as Error).message)).not.toContain('csacct');
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
      ['platform-files', 'file', 'mongo-gridfs'],
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
      file: ['local-filesystem', 'aws-s3-files', 's3-compatible-files', 'azure-blob-files'],
      vector: ['sqlite-vector', 'aws-s3-vectors', 'azure-ai-search', 'postgres'],
    });
  });

  it('serves azure-blob-files from the tenant\'s blob prefix', async () => {
    h.records.set('platform-files', platformRecord('platform-files', 'file'));
    h.connection = { driver: 'azure-blob-files', settings: { container: 'c1', prefix: 'tenants' }, credentials: { accountKey: 'k' } };
    const loaded = await loadStorageProvider('file', context('platform-files'));
    expect(loaded.managed?.settings).toEqual({ container: 'c1', prefix: `tenants/${tenantStorageToken('t1')}` });
  });

  it('serves azure-ai-search with its endpoint setting unchanged, and refuses it without one', async () => {
    h.records.set('platform-vector', platformRecord('platform-vector', 'vector'));
    const settings = { foundryProjectEndpoint: 'https://search.example.net', serviceVersion: '2023-11-01' };
    h.connection = { driver: 'azure-ai-search', settings, credentials: { apiKey: 'k' } };
    expect((await loadStorageProvider('vector', context('platform-vector'))).managed?.settings).toEqual(settings);
    for (const bad of [undefined, '', '   ', 5, null]) {
      h.connection = { driver: 'azure-ai-search', settings: { foundryProjectEndpoint: bad }, credentials: {} };
      await expect(loadStorageProvider('vector', context('platform-vector'))).rejects.toThrow('This provider is not available right now.');
    }
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

describe('blob keys cannot leave the tenant folder', () => {
  it('rejects dot segments and keeps percent-encoding, doubled and leading slashes inside the folder as literal names', () => {
    for (const bad of ['..', '.', 'a/../b', '../a', '\\..\\x', 'a/./b']) expect(() => sanitizeBlobKey(bad), bad).toThrow();
    // Percent-encoded dots are not decoded by the driver (the SDK encodes the name, so "%2e" is sent as "%252e").
    expect(sanitizeBlobKey('%2e%2e/x')).toBe('%2e%2e/x');
    expect(sanitizeBlobKey('a%2F..%2Fb')).toBe('a%2F..%2Fb');
    expect(sanitizeBlobKey('//a///b//')).toBe('a/b');
    expect(sanitizeBlobKey('a\\b')).toBe('a/b');
  });
});

describe('the search vector runtime', () => {
  const token = tenantStorageToken('tenant-a');
  const other = tenantStorageToken('tenant-b');
  const own = `${token}-docs-11111111`;
  const rich = { provider: 'azure-ai-search', endpoint: 'https://search.example.net', algoName: 'x-hnsw', profileName: 'x-profile', filterSchema: 'kv-v1', contentSchema: 'text-v1' };
  const handle = (externalId: string, metadata: Record<string, unknown> = {}): VectorIndexHandle =>
    ({ externalId, name: 'docs', dimension: 3, metric: 'cosine', metadata });
  const baseInner = (over: Partial<VectorProviderRuntime> = {}): VectorProviderRuntime => ({
    createIndex: async (input) => handle(input.name, rich),
    deleteIndex: async () => undefined,
    listIndexes: async () => [],
    upsertVectors: async () => undefined,
    queryVectors: async () => ({ matches: [] }),
    deleteVectors: async () => undefined,
    listVectors: async () => ({ items: [] }),
    ...over,
  });

  it('names the index with the token, which is a valid index name, and returns the tenant name with markers only', async () => {
    const created: string[] = [];
    const inner = baseInner({ createIndex: async (input) => { created.push(input.name); return handle(input.name, rich); } });
    const result = await wrapSearchVectorRuntime(inner, token).createIndex({ name: 'Docs', dimension: 3 });
    expect(created[0]).toMatch(new RegExp(`^${token}-docs-[0-9a-f]{8}$`));
    expect(created[0]).toMatch(/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/);
    // the driver derives "<name>-hnsw" and "<name>-profile": still valid names at the longest index name
    const longest = managedIndexName(token, 'x'.repeat(200));
    expect(longest.length).toBeLessThanOrEqual(63);
    for (const derived of [`${longest}-hnsw`, `${longest}-profile`]) expect(derived).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
    expect(result).toMatchObject({ externalId: created[0], name: 'Docs' });
    expect(result.metadata).toEqual({ filterSchema: 'kv-v1', contentSchema: 'text-v1' });
  });

  it('refuses and removes a created index whose name is not the one asked for', async () => {
    const deleted: string[] = [];
    const inner = baseInner({
      createIndex: async () => handle(`${other}-docs-22222222`),
      deleteIndex: async ({ externalId }) => { deleted.push(externalId); },
    });
    await expect(wrapSearchVectorRuntime(inner, token).createIndex({ name: 'docs', dimension: 3 })).rejects.toBeInstanceOf(ManagedProviderError);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(new RegExp(`^${token}-docs-`));
  });

  it('lists only the tenant\'s indexes, with the markers and nothing else', async () => {
    const inner = baseInner({
      listIndexes: async () => [
        handle(own, rich), handle(`${other}-docs-22222222`), handle('operator-index'), handle(`${token}-Docs-1`), handle(`${token}x`),
      ],
    });
    const list = await wrapSearchVectorRuntime(inner, token).listIndexes();
    expect(list.map((i) => i.externalId)).toEqual([own]);
    expect(list[0].metadata).toEqual({ filterSchema: 'kv-v1', contentSchema: 'text-v1' });
  });

  it('hands the driver a rebuilt handle: markers always set, endpoint and derived names dropped, even when no metadata was stored', async () => {
    const seen: unknown[] = [];
    const inner = baseInner({
      upsertVectors: async (h0) => { seen.push(h0); },
      queryVectors: async (h0) => { seen.push(h0); return { matches: [] }; },
      deleteVectors: async (h0) => { seen.push(h0); },
      listVectors: async (h0) => { seen.push(h0); return { items: [] }; },
    });
    const runtime = wrapSearchVectorRuntime(inner, token);
    const h1 = handle(own, { ...rich, contentSchema: 5 });
    await runtime.upsertVectors(h1, []);
    await runtime.queryVectors(h1, { topK: 1, vector: [1] });
    await runtime.deleteVectors(h1, ['a']);
    await runtime.listVectors(h1);
    // platform index records keep no handle metadata: a handle without any still reaches the driver with both markers
    const bare = { externalId: own, name: 'docs', dimension: 3, metric: 'cosine' } as VectorIndexHandle;
    await runtime.queryVectors(bare, { topK: 1, vector: [1] });
    for (const item of seen) expect((item as VectorIndexHandle).metadata).toEqual({ filterSchema: 'kv-v1', contentSchema: 'text-v1' });
    expect(seen).toHaveLength(5);
  });

  it('refuses any handle or id that is not the tenant\'s index name', async () => {
    const touched: string[] = [];
    const inner = baseInner({
      upsertVectors: async () => { touched.push('u'); },
      queryVectors: async () => { touched.push('q'); return { matches: [] }; },
      deleteVectors: async () => { touched.push('d'); },
      listVectors: async () => { touched.push('l'); return { items: [] }; },
      deleteIndex: async () => { touched.push('i'); },
      existingVectorIds: async () => { touched.push('e'); return []; },
      existingVectors: async () => { touched.push('x'); return []; },
    });
    const runtime = wrapSearchVectorRuntime(inner, token);
    for (const externalId of [
      `${other}-docs-22222222`, 'operator-index', own.toUpperCase(), `${token}-x/../y`, `${token}-x%2Fy`, `${token}-%2e%2e`,
      '..', `${token}-`, `${token}`, `${token}-a_b`, `${token}-docs-\u0000`, '', `${token}-docs-1-`,
    ]) {
      await expect(runtime.upsertVectors(handle(externalId), [])).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.queryVectors(handle(externalId), { topK: 1, vector: [1] })).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.deleteVectors(handle(externalId), ['a'])).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.listVectors(handle(externalId))).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.deleteIndex({ externalId })).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.existingVectorIds!(handle(externalId), ['a'])).rejects.toBeInstanceOf(ManagedProviderError);
      await expect(runtime.existingVectors!(handle(externalId), ['a'])).rejects.toBeInstanceOf(ManagedProviderError);
    }
    expect(touched).toEqual([]);
  });

  it('passes existingVectorIds through for the tenant\'s index, offers it only when the driver has it, and closes', async () => {
    const seen: string[] = [];
    let closed = 0;
    const inner = baseInner({
      existingVectorIds: async (h0, ids) => { seen.push(h0.externalId); return ids.slice(0, 1); },
      close: async () => { closed += 1; },
    });
    const runtime = wrapSearchVectorRuntime(inner, token);
    expect(await runtime.existingVectorIds!(handle(own), ['a', 'b'])).toEqual(['a']);
    expect(seen).toEqual([own]);
    await runtime.close?.();
    expect(closed).toBe(1);
    expect(wrapSearchVectorRuntime(baseInner(), token).existingVectorIds).toBeUndefined();
  });

  it('passes existingVectors through with a rebuilt handle for the tenant\'s index, and offers it only when the driver has it', async () => {
    const seen: VectorIndexHandle[] = [];
    const inner = baseInner({ existingVectors: (async (h0: VectorIndexHandle) => { seen.push(h0); return []; }) as never });
    const runtime = wrapSearchVectorRuntime(inner, token);
    await runtime.existingVectors!(handle(own, rich), ['a']);
    expect(seen).toHaveLength(1);
    expect(seen[0].externalId).toBe(own);
    expect(seen[0].metadata).toEqual({ filterSchema: 'kv-v1', contentSchema: 'text-v1' });
    expect(wrapSearchVectorRuntime(baseInner(), token).existingVectors).toBeUndefined();
  });

  it('still refuses writes on a cleanup-only route and wraps the runtime getManagedStorageRuntime builds', async () => {
    h.records.set('platform-vector', platformRecord('platform-vector', 'vector'));
    h.connection = { driver: 'azure-ai-search', settings: { foundryProjectEndpoint: 'https://search.example.net' }, credentials: { apiKey: 'k' } };
    const calls: string[] = [];
    const create = vi.spyOn(providerRegistry, 'createRuntime').mockResolvedValue(baseInner({
      createIndex: async (input) => { calls.push('create'); return handle(input.name, rich); },
      upsertVectors: async () => { calls.push('upsert'); },
      listIndexes: async () => [handle(own, rich), handle('operator-index')],
    }) as never);
    try {
      const context = { tenantDbName: 'db', tenantId: 'tenant-cleanup', providerKey: 'platform-vector' };
      const loaded = await loadStorageProvider('vector', context);
      const own2 = (await getManagedStorageRuntime<VectorProviderRuntime>('vector', loaded as any, { tenantId: context.tenantId }));
      expect((await own2.listIndexes()).map((i) => i.externalId)).toEqual([]);
      const cleanup = await getManagedStorageRuntime<VectorProviderRuntime>('vector', { ...loaded, managed: { ...loaded.managed!, cleanupOnly: true } } as any, { tenantId: context.tenantId });
      await expect(cleanup.createIndex({ name: 'x', dimension: 3 })).rejects.toThrow('This provider is not available right now.');
      await expect(cleanup.upsertVectors(handle(`${loaded.managed!.token}-x-11111111`), [])).rejects.toThrow('This provider is not available right now.');
      expect(calls).toEqual([]);
    } finally {
      create.mockRestore();
    }
  });
});

describe('postgres connection failures', () => {
  it('refuses messages that carry a resolved address or a connection-level code', async () => {
    const runtime = withoutBackendIdentifiers({
      async a() { throw new Error('connect ECONNREFUSED 10.1.2.3:5432'); },
      async b() { throw new Error('no pg_hba.conf entry for host "10.1.2.3", user "x"'); },
      async c() { throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }); },
      async d() { throw Object.assign(new Error('password authentication failed'), { code: '28P01' }); },
      async e() { throw new Error('duplicate key'); },
    }, ['db.internal.example'], 'vector', isConnectionLevelFailure);
    for (const call of [runtime.a(), runtime.b(), runtime.c(), runtime.d()]) {
      await expect(call).rejects.toMatchObject({ message: 'This provider is not available right now.' });
    }
    await expect(runtime.e()).rejects.toMatchObject({ message: 'duplicate key' });
  });
});

describe('backendIdentifiers of the Azure drivers', () => {
  const token = tenantStorageToken('tenant-a');

  it('names the container, the account, the derived blob host and the endpoint for the account key, SAS and Entra methods', () => {
    const ids = backendIdentifiers({ token, settings: { container: 'ops-container', accountName: 'opsaccount', prefix: `files/${token}`, endpoint: 'https://custom.blob.example.net:10000/opsaccount' } }, { accountKey: 'SECRETKEY123' });
    expect(ids).toEqual(expect.arrayContaining(['ops-container', 'opsaccount', 'opsaccount.blob.core.windows.net', 'custom.blob.example.net:10000', 'custom.blob.example.net', 'files']));
    expect(ids.join('|')).not.toContain('SECRETKEY123');
  });

  it('derives the account and host from a connection string without returning the credential', () => {
    const connectionString = 'DefaultEndpointsProtocol=https;AccountName=csaccount;AccountKey=TOPSECRETKEY==;EndpointSuffix=core.example.cloud';
    const ids = backendIdentifiers({ token, settings: { container: 'ops-container' } }, { connectionString });
    expect(ids).toEqual(expect.arrayContaining(['csaccount', 'csaccount.blob.core.example.cloud']));
    expect(ids.join('|')).not.toContain('TOPSECRETKEY');
    const viaEndpoint = backendIdentifiers({ token, settings: {} }, { connectionString: 'BlobEndpoint=https://x.blob.example.net/;SharedAccessSignature=sv=1&sig=SIGSECRET' });
    expect(viaEndpoint).toEqual(expect.arrayContaining(['x.blob.example.net']));
    expect(viaEndpoint.join('|')).not.toContain('SIGSECRET');
  });

  it('names the search endpoint (raw value, host and hostname)', () => {
    const ids = backendIdentifiers({ token, settings: { foundryProjectEndpoint: 'https://ops-search.search.example.net:8443' } });
    expect(ids).toEqual(expect.arrayContaining(['https://ops-search.search.example.net:8443', 'ops-search.search.example.net:8443', 'ops-search.search.example.net']));
  });
});

describe('postgres as platform vector storage', () => {
  const token = tenantStorageToken('tenant-a');

  it('is in the vector allowlist only', () => {
    expect(MANAGED_STORAGE_DRIVERS.vector).toContain('postgres');
    expect(MANAGED_STORAGE_DRIVERS.file).not.toContain('postgres');
  });

  it('scopes the schema with the token, forces the layout and drops the table name', () => {
    expect(scopeStorageSettings('postgres', { host: 'h', tableName: 'shared', indexLayout: 'shared-table' }, token))
      .toEqual({ host: 'h', schema: token, indexLayout: 'table-per-index' });
    expect(scopeStorageSettings('postgres', { schema: 'platform_vec' }, token))
      .toEqual({ schema: `platform_vec_${token}`, indexLayout: 'table-per-index' });
    expect(scopeStorageSettings('postgres', { schema: '  ' }, token)?.schema).toBe(token);
    expect(`platform_vec_${token}`.length).toBeLessThanOrEqual(63);
  });

  it('fails closed on a bad schema base', () => {
    for (const schema of ['Public', 'a-b', '1x', 'x"y', 'a'.repeat(42), 'a.b', 5]) {
      expect(scopeStorageSettings('postgres', { schema }, token)).toBeNull();
    }
  });

  describe('the wrapper', () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const inner = (): VectorProviderRuntime => {
      const rec = (method: string, result?: unknown) => async (...args: any[]) => { calls.push({ method, args }); return result as any; };
      return {
        createIndex: rec('createIndex', { externalId: 'v_docs_0123abcd', name: 'docs', dimension: 3, metric: 'cosine', metadata: { tableName: 'x', provider: 'postgres' } }),
        deleteIndex: rec('deleteIndex'),
        listIndexes: rec('listIndexes', [
          { externalId: 'v_docs_0123abcd', name: 'docs', dimension: 3, metric: 'cosine', metadata: { a: 1 } },
          { externalId: 'legacy_table', name: 'x', dimension: 3, metric: 'cosine' },
        ]),
        upsertVectors: rec('upsertVectors'),
        queryVectors: rec('queryVectors', { matches: [] }),
        deleteVectors: rec('deleteVectors'),
        existingVectorIds: rec('existingVectorIds', []),
        existingVectors: rec('existingVectors', []),
        listVectors: rec('listVectors', { items: [] }),
      };
    };
    const hnd = (externalId: string, metadata?: Record<string, unknown>): VectorIndexHandle =>
      ({ externalId, name: 'docs', dimension: 3, metric: 'cosine', metadata });
    beforeEach(() => { calls.length = 0; });

    it('rebuilds every handle without metadata', async () => {
      const w = wrapPostgresVectorRuntime(inner());
      const evil = hnd('v_docs_0123abcd', { tableName: 'other', schema: 'x' });
      await w.upsertVectors(evil, []);
      await w.queryVectors(evil, { topK: 1, vector: [1] });
      await w.deleteVectors(evil, ['a']);
      await w.existingVectorIds!(evil, ['a']);
      await w.existingVectors!(evil, ['a']);
      await w.listVectors(evil);
      expect(calls).toHaveLength(6);
      for (const call of calls) {
        expect(call.args[0]).toEqual({ externalId: 'v_docs_0123abcd', name: 'docs', dimension: 3, metric: 'cosine' });
      }
    });

    it('refuses an externalId that is not a valid index table', async () => {
      const w = wrapPostgresVectorRuntime(inner());
      for (const externalId of ['x"; drop table y', 'other.v_a_0123abcd', 'V_A_0123abcd', 'vectors']) {
        const bad = hnd(externalId);
        await expect(w.upsertVectors(bad, [])).rejects.toBeInstanceOf(ManagedProviderError);
        await expect(w.queryVectors(bad, { topK: 1, vector: [1] })).rejects.toBeInstanceOf(ManagedProviderError);
        await expect(w.deleteVectors(bad, [])).rejects.toBeInstanceOf(ManagedProviderError);
        await expect(w.existingVectorIds!(bad, [])).rejects.toBeInstanceOf(ManagedProviderError);
        await expect(w.existingVectors!(bad, [])).rejects.toBeInstanceOf(ManagedProviderError);
        await expect(w.listVectors(bad)).rejects.toBeInstanceOf(ManagedProviderError);
        await expect(w.deleteIndex({ externalId })).rejects.toBeInstanceOf(ManagedProviderError);
      }
      expect(calls).toHaveLength(0);
    });

    it('createIndex carries no metadata into the driver and hands none back; listIndexes keeps valid tables only', async () => {
      const w = wrapPostgresVectorRuntime(inner());
      const out = await w.createIndex({ name: 'docs', dimension: 3, metadata: { tableName: 'evil' } });
      expect(calls[0].args[0]).toEqual({ name: 'docs', dimension: 3 });
      expect(out.metadata).toEqual({});
      const listed = await w.listIndexes();
      expect(listed.map((i) => i.externalId)).toEqual(['v_docs_0123abcd']);
      expect(listed[0].metadata).toEqual({});
    });

    it('refuses and does not return a created index with an invalid table name', async () => {
      const bad = { ...inner(), createIndex: async () => hnd('vectors') };
      await expect(wrapPostgresVectorRuntime(bad).createIndex({ name: 'x', dimension: 3 })).rejects.toBeInstanceOf(ManagedProviderError);
    });
  });

  describe('backendIdentifiers', () => {
    it('names host, database and user from settings and credentials, never the password', () => {
      const ids = backendIdentifiers(
        { token, settings: { host: 'pg.internal.example', database: 'platformdb', user: 'svc_vec', schema: token } },
        { host: 'creds.example', database: 'cdb', user: 'cuser', password: 'HUNTER2PASS' },
      );
      expect(ids).toEqual(expect.arrayContaining(['pg.internal.example', 'platformdb', 'svc_vec', 'creds.example', 'cdb', 'cuser']));
      expect(ids.join('|')).not.toContain('HUNTER2PASS');
    });

    it('parses a postgres connection string and coexists with the Azure ones', () => {
      const ids = backendIdentifiers(
        { token, settings: {} },
        { connectionString: 'postgresql://app%40svc:S3CRETPW@db.example.net:6543/vecdb?sslmode=require' },
      );
      expect(ids).toEqual(expect.arrayContaining(['db.example.net:6543', 'db.example.net', 'vecdb', 'app@svc']));
      expect(ids.join('|')).not.toContain('S3CRETPW');
      const azure = backendIdentifiers({ token, settings: {} }, { connectionString: 'AccountName=csaccount;AccountKey=K==' });
      expect(azure).toContain('csaccount');
    });
  });
});
