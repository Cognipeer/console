/**
 * Integration - the Azure Blob file provider against a real Azurite emulator.
 *
 * Skipped unless AZURITE_BLOB_ENDPOINT is set, for example
 *
 *   npx azurite-blob --blobHost 127.0.0.1 --blobPort 10000 --location /tmp/azurite --disableProductStyleUrl &
 *   AZURITE_BLOB_ENDPOINT=http://127.0.0.1:10000/devstoreaccount1 npx vitest run azure-blob-azurite
 *
 * (or the container image `mcr.microsoft.com/azure-storage/azurite`, started with `azurite-blob --blobHost 0.0.0.0`).
 * The account and key below are Azurite's public development credentials, not secrets. The emulator is plain
 * http on a loopback address, so every test runs as a self-hosted deployment.
 */
import { createHash } from 'node:crypto';
import * as sdk from '@azure/storage-blob';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { AzureBlobFileProviderContract } from '@/lib/providers/contracts/azureBlobFiles.contract';
import { AzureBlobError, isAzureBlobError } from '@/lib/providers/contracts/azure/blobErrors';
import type { FileConnectionCheck, FileProviderRuntime } from '@/lib/providers/domains/file';
import { ProviderSettingsError } from '@/lib/providers/errors';

const ENDPOINT = process.env.AZURITE_BLOB_ENDPOINT ?? '';
const ACCOUNT = 'devstoreaccount1';
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

const warnings: unknown[][] = [];
const logger = { debug() {}, info() {}, warn: (...args: unknown[]) => { warnings.push(args); }, error() {} };

const original = getConfigSource();
function mode(overrides: Record<string, string>) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}

const run = `it${Date.now().toString(36)}`;
let seq = 0;
const usedContainers: string[] = [];
function freshContainer(): string {
  seq += 1;
  const name = `${run}-${seq}`;
  usedContainers.push(name);
  return name;
}

type Runtime = FileProviderRuntime & { close(): void; checkConnection(options?: { signal?: AbortSignal; write?: boolean }): Promise<FileConnectionCheck> };

const closers: Array<() => void> = [];
async function runtimeFor(overrides: { tenantId?: string; container?: string; credentials?: Record<string, unknown>; settings?: Record<string, unknown> } = {}): Promise<Runtime> {
  const runtime = await AzureBlobFileProviderContract.createRuntime({
    tenantId: overrides.tenantId ?? 't1',
    providerKey: 'prov',
    logger,
    credentials: { accountKey: KEY, ...(overrides.credentials ?? {}) },
    settings: {
      accountName: ACCOUNT,
      endpoint: ENDPOINT,
      container: overrides.container ?? freshContainer(),
      authMethod: 'accountKey',
      createContainer: true,
      ...(overrides.settings ?? {}),
    },
  }) as Runtime;
  closers.push(() => runtime.close());
  return runtime;
}

describe.runIf(Boolean(ENDPOINT))('Azure Blob file provider against Azurite', () => {
  const keyed = new sdk.StorageSharedKeyCredential(ACCOUNT, KEY);
  const service = () => new sdk.BlobServiceClient(ENDPOINT, keyed);
  async function blobNamesIn(container: string): Promise<string[]> {
    const names: string[] = [];
    for await (const blob of service().getContainerClient(container).listBlobsFlat()) names.push(blob.name);
    return names;
  }

  beforeAll(() => { mode({ DEPLOYMENT_MODE: 'onprem' }); });
  beforeEach(() => { mode({ DEPLOYMENT_MODE: 'onprem' }); });
  afterEach(() => {
    setConfigSource(original);
    for (const close of closers.splice(0)) close();
  });
  afterAll(async () => {
    await Promise.all(usedContainers.map((name) => service().getContainerClient(name).deleteIfExists().catch(() => undefined)));
    setConfigSource(original);
  });

  describe('account key', () => {
    it('round-trips bytes, content type, caller metadata of any shape, checksum and a quoted etag', async () => {
      const rt = await runtimeFor();
      const data = Buffer.from('hello azure');
      const meta = { 'doc-id': 'x1', nested: { a: [1, 2, { b: null }] }, n: 42, 'ünï': 'çödé', text: 'line1\nline2' };
      const { handle } = await rt.uploadFile({ key: 'docs/a.txt', name: 'a.txt', contentType: 'text/plain', data, metadata: meta });
      expect(handle).toMatchObject({ key: 'docs/a.txt', size: 11, checksum: createHash('sha256').update(data).digest('hex') });
      expect(handle.etag).toMatch(/^"0x/);
      expect(handle.lastModified).toBeInstanceOf(Date);
      const downloaded = await rt.downloadFile('docs/a.txt');
      expect(downloaded.data.toString()).toBe('hello azure');
      expect(downloaded).toMatchObject({ contentType: 'text/plain', size: 11, metadata: meta, etag: handle.etag });
    });

    it('keeps non-ASCII file names and awkward keys (an S3 header cannot carry these names)', async () => {
      const rt = await runtimeFor();
      const name = 'Şirket Raporu – 日本語 😀.pdf';
      const key = 'raporlar/Şirket Raporu #1 (50%) ?x=1&y=2+3.pdf';
      expect((await rt.uploadFile({ key, name, contentType: 'application/pdf', data: Buffer.from('%PDF') })).handle.key).toBe(key);
      expect(await rt.getFileMetadata(key)).toMatchObject({ key, name, contentType: 'application/pdf' });
      expect((await rt.downloadFile(key)).data.toString()).toBe('%PDF');
      expect((await rt.listFiles({ prefix: 'raporlar/' })).items.map((item) => [item.key, item.name])).toEqual([[key, name]]);
    });

    it('stores an empty file and a 5 MB file', async () => {
      const rt = await runtimeFor();
      await rt.uploadFile({ key: 'empty.bin', name: 'empty.bin', data: Buffer.alloc(0) });
      expect((await rt.downloadFile('empty.bin')).data.length).toBe(0);
      const big = Buffer.alloc(5 * 1024 * 1024, 7);
      const { handle } = await rt.uploadFile({ key: 'big.bin', name: 'big.bin', data: big });
      const downloaded = await rt.downloadFile('big.bin');
      expect(downloaded.data.length).toBe(big.length);
      expect(createHash('sha256').update(downloaded.data).digest('hex')).toBe(handle.checksum);
    });

    it('serves parallel requests on the one client', async () => {
      const rt = await runtimeFor();
      const keys = Array.from({ length: 12 }, (_, i) => `par/${i}.txt`);
      await Promise.all(keys.map((key) => rt.uploadFile({ key, name: key, data: Buffer.from(key) })));
      const bodies = await Promise.all(keys.map(async (key) => (await rt.downloadFile(key)).data.toString()));
      expect(bodies).toEqual(keys);
      expect((await rt.listFiles({ prefix: 'par/', limit: 100 })).items).toHaveLength(12);
    });

    it('overwrites in place and reports the new size', async () => {
      const rt = await runtimeFor();
      await rt.uploadFile({ key: 'o.txt', name: 'o', data: Buffer.from('one') });
      await rt.uploadFile({ key: 'o.txt', name: 'o', data: Buffer.from('two!') });
      expect((await rt.downloadFile('o.txt')).data.toString()).toBe('two!');
      expect((await rt.getFileMetadata('o.txt'))?.size).toBe(4);
    });

    it('lists by prefix with an opaque cursor, relative keys and per-item details', async () => {
      const rt = await runtimeFor();
      for (const k of ['p/1.txt', 'p/2.txt', 'p/3.txt', 'p/4.txt', 'p/5.txt', 'q/1.txt']) await rt.uploadFile({ key: k, name: k, data: Buffer.from(k) });
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await rt.listFiles({ prefix: 'p/', limit: 2, cursor });
        seen.push(...page.items.map((i) => i.key));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen).toEqual(['p/1.txt', 'p/2.txt', 'p/3.txt', 'p/4.txt', 'p/5.txt']);
      expect(pages).toBe(3);
      const first = (await rt.listFiles({ prefix: 'p/1', limit: 5 })).items[0];
      expect(first).toMatchObject({ name: 'p/1.txt', size: 7, checksum: createHash('sha256').update('p/1.txt').digest('hex') });
      expect(first.etag).toMatch(/^"/);
      expect((await rt.listFiles()).items.every((i) => !i.key.startsWith('t1/'))).toBe(true);
      expect((await rt.listFiles({ prefix: 'nothing/here/' })).items).toEqual([]);
    });

    it('sends an overridden API version as part of the signed request (the emulator checks the Shared Key signature over x-ms-version)', async () => {
      const rt = await runtimeFor({ settings: { apiVersion: '2023-11-03' } });
      await rt.uploadFile({ key: 'v.txt', name: 'v.txt', data: Buffer.from('versioned') });
      expect((await rt.downloadFile('v.txt')).data.toString()).toBe('versioned');
      expect((await rt.listFiles()).items.map((item) => item.key)).toEqual(['v.txt']);
      expect((await rt.getFileMetadata('v.txt'))?.size).toBe(9);
    });

    it('delete is idempotent; a missing blob is null for metadata and "File not found" (404) for download', async () => {
      const rt = await runtimeFor();
      await rt.uploadFile({ key: 'd.txt', name: 'd', data: Buffer.from('x') });
      await rt.deleteFile('d.txt');
      await rt.deleteFile('d.txt');
      expect(await rt.getFileMetadata('d.txt')).toBeNull();
      await expect(rt.downloadFile('d.txt')).rejects.toMatchObject({ message: 'File not found: d.txt', statusCode: 404 });
    });
  });

  describe('isolation and key rules', () => {
    it('another tenant in the same container cannot reach a blob by any spelling of the key', async () => {
      const container = freshContainer();
      const t1 = await runtimeFor({ tenantId: 'tenantA', container });
      const t2 = await runtimeFor({ tenantId: 'tenantB', container });
      await t2.uploadFile({ key: 'secret.txt', name: 's', data: Buffer.from('b-secret') });
      for (const probe of ['../tenantB/prov/secret.txt', 'x/../../../tenantB/prov/secret.txt', '..', '.', './secret.txt', 'a/./b', '\\..\\tenantB\\prov\\secret.txt', 'a/../b']) {
        await expect(t1.downloadFile(probe), probe).rejects.toThrow(/Invalid file key/);
      }
      expect(await t1.getFileMetadata('secret.txt')).toBeNull();
      expect((await t1.listFiles()).items).toEqual([]);
      expect(await blobNamesIn(container)).toEqual(['tenantB/prov/secret.txt']);
    });

    it('rejects control characters, lone surrogates and over-long names before any request', async () => {
      const rt = await runtimeFor();
      for (const key of ['bad\u0001.txt', 'bad\uD800.txt', 'x'.repeat(1030)]) {
        await expect(rt.uploadFile({ key, name: 'x', data: Buffer.from('x') })).rejects.toThrow(/Invalid file key/);
      }
      await expect(rt.downloadFile('/')).rejects.toThrow(/Invalid file key/);
    });

    it('drops caller metadata that does not fit (with a warning) and still stores the file', async () => {
      const rt = await runtimeFor();
      warnings.length = 0;
      const huge = { blob: 'x'.repeat(20_000) };
      const { handle } = await rt.uploadFile({ key: 'huge-meta.txt', name: 'h', data: Buffer.from('h'), metadata: huge });
      expect(handle.metadata).toEqual(huge);
      expect((await rt.downloadFile('huge-meta.txt')).metadata).toBeUndefined();
      expect(warnings.some((w) => String(w[0]).includes('metadata not stored'))).toBe(true);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await rt.uploadFile({ key: 'circ.txt', name: 'c', data: Buffer.from('c'), metadata: circular });
      expect((await rt.downloadFile('circ.txt')).metadata).toBeUndefined();
    });

    it('does not list ADLS Gen2 directory marker blobs as files', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container });
      await rt.uploadFile({ key: 'real.txt', name: 'real', data: Buffer.from('r') });
      await service().getContainerClient(container).getBlockBlobClient('t1/prov/dir').upload('', 0, { metadata: { hdi_isfolder: 'true' } });
      expect((await rt.listFiles()).items.map((i) => i.key)).toEqual(['real.txt']);
    });

    it('lists blobs another tool wrote under the provider prefix, with the name taken from the key', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container });
      await service().getContainerClient(container).createIfNotExists();
      await service().getContainerClient(container).getBlockBlobClient('t1/prov/imported/report.csv').upload('a,b', 3, { blobHTTPHeaders: { blobContentType: 'text/csv' } });
      const [item] = (await rt.listFiles({ prefix: 'imported/' })).items;
      expect(item).toMatchObject({ key: 'imported/report.csv', name: 'report.csv', size: 3, contentType: 'text/csv' });
      expect(item.checksum).toBeUndefined();
      expect((await rt.downloadFile('imported/report.csv')).data.toString()).toBe('a,b');
    });
  });

  describe('containers', () => {
    it('without "create container" a missing container is a configuration error, never "File not found"', async () => {
      const container = freshContainer();
      const strict = await runtimeFor({ container, settings: { createContainer: false } });
      const error = await strict.uploadFile({ key: 'a.txt', name: 'a', data: Buffer.from('a') }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ code: 'ContainerNotFound', statusCode: 404 });
      expect(error.message).not.toMatch(/not found|does not exist/i);
      expect(error.message).toContain(container);
      for (const call of [() => strict.downloadFile('a.txt'), () => strict.getFileMetadata('a.txt'), () => strict.listFiles({ limit: 1 })]) {
        await expect(call()).rejects.toMatchObject({ code: 'ContainerNotFound' });
      }
      await expect(strict.deleteFile('a.txt')).rejects.toMatchObject({ code: 'ContainerNotFound' });
    });

    it('with "create container" a container that is not there yet is an empty store, and the first upload creates it', async () => {
      const container = freshContainer();
      const lenient = await runtimeFor({ container, settings: { createContainer: true } });
      expect((await lenient.listFiles({ limit: 1 })).items).toEqual([]);
      expect(await lenient.getFileMetadata('a.txt')).toBeNull();
      await expect(lenient.downloadFile('a.txt')).rejects.toMatchObject({ message: 'File not found: a.txt' });
      await lenient.deleteFile('a.txt');
      await Promise.all([1, 2, 3].map((i) => lenient.uploadFile({ key: `c${i}.txt`, name: 'c', data: Buffer.from('c') })));
      expect((await lenient.listFiles()).items).toHaveLength(3);
    });

    it('creates the container again when it was deleted behind the provider\'s back', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container });
      await rt.uploadFile({ key: 'first.txt', name: 'first', data: Buffer.from('1') });
      await service().getContainerClient(container).delete();
      await rt.uploadFile({ key: 'second.txt', name: 'second', data: Buffer.from('2') });
      expect((await rt.listFiles()).items.map((item) => item.key)).toEqual(['second.txt']);
    });
  });

  describe('SAS', () => {
    const sasContainer = `${run}-sas`;
    usedContainers.push(sasContainer);
    const sasFor = (permissions: string, expiresInMs = 3_600_000) => sdk.generateBlobSASQueryParameters({
      containerName: sasContainer,
      permissions: sdk.ContainerSASPermissions.parse(permissions),
      startsOn: new Date(Date.now() - 60_000),
      expiresOn: new Date(Date.now() + expiresInMs),
    }, keyed).toString();
    const sasRuntime = (token: string) => runtimeFor({ container: sasContainer, credentials: { accountKey: undefined, sasToken: token }, settings: { authMethod: 'sas', createContainer: false } });
    beforeAll(async () => { await service().getContainerClient(sasContainer).createIfNotExists(); });

    it('a container SAS runs the full cycle, as a token, with a leading "?" or as a full URL', async () => {
      for (const form of [sasFor('racwdl'), `?${sasFor('racwdl')}`, `${ENDPOINT}/${sasContainer}?${sasFor('racwdl')}`]) {
        const rt = await sasRuntime(form);
        await rt.uploadFile({ key: 'sas/a.txt', name: 'a', data: Buffer.from('via sas') });
        expect((await rt.downloadFile('sas/a.txt')).data.toString()).toBe('via sas');
        expect((await rt.listFiles({ prefix: 'sas/' })).items).toHaveLength(1);
        await rt.deleteFile('sas/a.txt');
      }
    });

    it('a read-only SAS fails an upload with a 403 and a permission message that carries no signature', async () => {
      const token = sasFor('rl');
      const rt = await sasRuntime(token);
      const error = await rt.uploadFile({ key: 'x.txt', name: 'x', data: Buffer.from('x') }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ statusCode: 403, code: 'AuthorizationPermissionMismatch' });
      expect(error.message).toMatch(/permission/);
      expect(error.message).not.toContain(new URLSearchParams(token).get('sig')!);
      expect(Object.keys(error)).not.toContain('request');
    });

    it('an expired SAS is refused before any request, naming the field and without the signature', async () => {
      const token = sasFor('racwdl', -60_000);
      const error = await sasRuntime(token).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderSettingsError);
      expect(error.field).toBe('sasToken');
      expect(error.message).toMatch(/expired/);
      expect(error.message).not.toContain(new URLSearchParams(token).get('sig')!);
    });

    it('a SAS that is not valid yet is a rejected credential from the service, without the signature', async () => {
      const token = sdk.generateBlobSASQueryParameters({
        containerName: sasContainer,
        permissions: sdk.ContainerSASPermissions.parse('racwdl'),
        startsOn: new Date(Date.now() + 3_600_000),
        expiresOn: new Date(Date.now() + 7_200_000),
      }, keyed).toString();
      const rt = await sasRuntime(token);
      const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.statusCode).toBe(403);
      expect(error.message).not.toContain(new URLSearchParams(token).get('sig')!);
    });

    it('an account SAS works too', async () => {
      const token = sdk.generateAccountSASQueryParameters({
        permissions: sdk.AccountSASPermissions.parse('rwdlacx'),
        services: sdk.AccountSASServices.parse('b').toString(),
        resourceTypes: sdk.AccountSASResourceTypes.parse('sco').toString(),
        startsOn: new Date(Date.now() - 60_000),
        expiresOn: new Date(Date.now() + 3_600_000),
      }, keyed).toString();
      const rt = await runtimeFor({ credentials: { accountKey: undefined, sasToken: token }, settings: { authMethod: 'sas', createContainer: true } });
      await rt.uploadFile({ key: 'acct-sas.txt', name: 'a', data: Buffer.from('acct') });
      expect((await rt.downloadFile('acct-sas.txt')).data.toString()).toBe('acct');
    });
  });

  describe('connection string and authentication method', () => {
    it('a connection string with BlobEndpoint works', async () => {
      const connectionString = `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};BlobEndpoint=${ENDPOINT};`;
      const rt = await runtimeFor({ credentials: { accountKey: undefined, connectionString }, settings: { authMethod: 'connectionString', accountName: undefined, endpoint: undefined } });
      await rt.uploadFile({ key: 'cs.txt', name: 'cs', data: Buffer.from('cs') });
      expect((await rt.downloadFile('cs.txt')).data.toString()).toBe('cs');
    });

    it('ignores stored credentials of another method, infers the method from a single credential, refuses ambiguity', async () => {
      const stale = await runtimeFor({ credentials: { sasToken: 'sv=junk&sig=junk&se=2000-01-01T00:00:00Z' }, settings: { authMethod: 'accountKey' } });
      await stale.uploadFile({ key: 'stale.txt', name: 's', data: Buffer.from('s') });
      const inferred = await runtimeFor({ settings: { authMethod: undefined } });
      await inferred.uploadFile({ key: 'inferred.txt', name: 'i', data: Buffer.from('i') });
      await expect(runtimeFor({ credentials: { sasToken: 'sv=2022-11-02&sig=abc&se=2099-01-01T00:00:00Z' }, settings: { authMethod: undefined } })).rejects.toThrow(/choose the authentication method/);
      await expect(runtimeFor({ credentials: { accountKey: undefined }, settings: { authMethod: undefined } })).rejects.toBeInstanceOf(ProviderSettingsError);
    });
  });

  describe('failures', () => {
    it('a wrong account key is a 403 with a hint, not the raw response', async () => {
      const bad = await runtimeFor({ credentials: { accountKey: Buffer.from('z'.repeat(48)).toString('base64') } });
      const error = await bad.uploadFile({ key: 'x.txt', name: 'x', data: Buffer.from('x') }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(isAzureBlobError(error)).toBe(true);
      expect(error.statusCode).toBe(403);
      expect(error.retryable).toBe(false);
      expect(error.message).not.toMatch(/RequestId|Time:|<\?xml/);
      await expect(bad.listFiles({ limit: 1 })).rejects.toMatchObject({ statusCode: 403 });
      await expect(bad.getFileMetadata('x.txt')).rejects.toMatchObject({ statusCode: 403 });
    });

    it('an endpoint that refuses connections or does not resolve gives a readable error', async () => {
      const refused = await runtimeFor({ settings: { endpoint: 'http://127.0.0.1:1/devstoreaccount1' } });
      await expect(refused.listFiles({ limit: 1 })).rejects.toThrow(/Could not reach 127\.0\.0\.1 \(ECONNREFUSED\)/);
      const unresolvable = await runtimeFor({ settings: { endpoint: 'http://no-such-host.invalid/devstoreaccount1' } });
      await expect(unresolvable.listFiles({ limit: 1 })).rejects.toThrow(/could not be resolved/);
    });

    it('no error ever contains the account key', async () => {
      const other = Buffer.from('q'.repeat(48)).toString('base64');
      for (const attempt of [
        () => runtimeFor({ settings: { container: 'BAD NAME' } }),
        () => runtimeFor({ credentials: { accountKey: 'short' } }),
        async () => (await runtimeFor({ credentials: { accountKey: other } })).listFiles({ limit: 1 }),
      ]) {
        const error = await attempt().then(() => undefined, (e) => e as Error);
        expect(error).toBeDefined();
        expect(error!.message).not.toContain(KEY);
        expect(error!.message).not.toContain(other);
      }
    });
  });

  describe('Test connection', () => {
    const steps = (result: FileConnectionCheck) => result.steps?.map((s) => [s.step, s.ok]);

    it('lists, writes, reads back and deletes, and leaves nothing behind', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container });
      const result = await rt.checkConnection();
      expect(result).toMatchObject({ ok: true, message: `Connected to container "${container}".` });
      expect(steps(result)).toEqual([['list', true], ['write', true], ['read', true], ['delete', true]]);
      expect(await blobNamesIn(container)).toEqual([]);
    });

    it('runs again and again against the same container', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container });
      for (let round = 0; round < 3; round += 1) expect((await rt.checkConnection()).ok).toBe(true);
      expect(await blobNamesIn(container)).toEqual([]);
    });

    it('lists only when asked not to write', async () => {
      const container = freshContainer();
      await service().getContainerClient(container).createIfNotExists();
      const rt = await runtimeFor({ container });
      const result = await rt.checkConnection({ write: false });
      expect(result).toMatchObject({ ok: true, message: `Connected to container "${container}" (listing only).` });
      expect(steps(result)).toEqual([['list', true]]);
    });

    it('creates a missing container through the write when the provider is set to create it', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container, settings: { createContainer: true } });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(true);
      expect(result.steps?.[0]).toMatchObject({ step: 'list', ok: true, message: 'The container is created on the first upload.' });
      expect(await service().getContainerClient(container).exists()).toBe(true);
    });

    it('names a missing container when the provider is not set to create it, and does not create it', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container, settings: { createContainer: false } });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', false]]);
      expect(result.message).toContain(container);
      expect(result.message).not.toMatch(/not found|does not exist/i);
      expect(await service().getContainerClient(container).exists()).toBe(false);
    });

    it('a container SAS without the list permission reports the list as failed and still tries write, read and delete', async () => {
      const container = freshContainer();
      const containerClient = service().getContainerClient(container);
      await containerClient.createIfNotExists();
      const token = sdk.generateBlobSASQueryParameters({
        containerName: container,
        permissions: sdk.ContainerSASPermissions.parse('racwd'),
        startsOn: new Date(Date.now() - 60_000),
        expiresOn: new Date(Date.now() + 3_600_000),
      }, keyed).toString();
      const rt = await runtimeFor({ container, credentials: { accountKey: undefined, sasToken: token }, settings: { authMethod: 'sas', createContainer: false } });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', false], ['write', true], ['read', true], ['delete', true]]);
      expect(result.message).toMatch(/Writing, reading and deleting still work\.$/);
      expect(result.message).not.toContain(new URLSearchParams(token).get('sig')!);
      expect(await blobNamesIn(container)).toEqual([]);
    });

    it('a wrong key fails at the first step and carries no secret', async () => {
      const other = Buffer.from('w'.repeat(48)).toString('base64');
      const rt = await runtimeFor({ credentials: { accountKey: other } });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', false]]);
      expect(JSON.stringify(result)).not.toContain(other);
      expect(JSON.stringify(result)).not.toContain(KEY);
    });

    it('an endpoint that refuses connections is reported, not thrown', async () => {
      const rt = await runtimeFor({ settings: { endpoint: 'http://127.0.0.1:1/devstoreaccount1' } });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Could not reach 127\.0\.0\.1 \(ECONNREFUSED\)/);
    });

    it('stops when the caller\'s signal has already fired', async () => {
      const container = freshContainer();
      const rt = await runtimeFor({ container });
      const result = await rt.checkConnection({ signal: AbortSignal.abort() });
      expect(result.ok).toBe(false);
      expect(await service().getContainerClient(container).exists()).toBe(false);
    });
  });

  describe('settings', () => {
    const settingsFor = (overrides: Record<string, unknown> = {}) => ({ accountName: ACCOUNT, endpoint: ENDPOINT, container: 'files', authMethod: 'accountKey', ...overrides });

    it('validateSettings accepts the emulator on a self-hosted deployment and refuses it on the hosted one', async () => {
      await expect(Promise.resolve(AzureBlobFileProviderContract.validateSettings!({ credentials: { accountKey: KEY }, settings: settingsFor(), isOnPrem: true }))).resolves.toBeUndefined();
      mode({ DEPLOYMENT_MODE: 'saas' });
      const error = await Promise.resolve(AzureBlobFileProviderContract.validateSettings!({ credentials: { accountKey: KEY }, settings: settingsFor(), isOnPrem: false })).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderSettingsError);
      expect(error.field).toBe('endpoint');
    });

    it('describeStorageLocation names the folder the provider writes into', () => {
      const where = AzureBlobFileProviderContract.describeStorageLocation!({ settings: settingsFor({ prefix: 'archive' }), tenantId: 't1', providerKey: 'prov' });
      expect(where).toBe(`${ENDPOINT}/files/archive/t1/prov/`);
    });
  });
});
