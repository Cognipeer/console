/**
 * Unit tests - the Azure Blob file provider contract against an in-memory stand-in for the SDK
 * (helpers/fakeAzureBlobSdk.ts): layout and isolation, the round trip, listing, missing things, failures,
 * the network policy, the TLS agents, `validateSettings`, `describeStorageLocation` and "Test connection".
 * No network and no emulator.
 */
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { missingRequiredFields, partitionProviderValues } from '@/components/providers/providerFormModel';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { AzureBlobFileProviderContract } from '@/lib/providers/contracts/azureBlobFiles.contract';
import { AzureBlobError, isAzureBlobError } from '@/lib/providers/contracts/azure/blobErrors';
import type { AzureBlobCredentials, AzureBlobSettings } from '@/lib/providers/contracts/azure/blobConfig';
import type { FileConnectionCheck, FileProviderRuntime } from '@/lib/providers/domains/file';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { fakeSdkModule, resetFake, restError, state } from '../helpers/fakeAzureBlobSdk';

// The SDK is imported lazily: the factory runs on the first runtime, never when the contract is loaded.
const sdkLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@azure/storage-blob', () => {
  sdkLoads.count += 1;
  return fakeSdkModule;
});

// The endpoint guard resolves host names; the tests must not depend on real DNS (a made-up account name has no
// record). Storage and sign-in hosts resolve to a public address, one name to a private one, the rest to nothing.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (/\.blob\.core\.(windows\.net|usgovcloudapi\.net)$/.test(host) || /^login\.microsoftonline\.(com|us)$/.test(host)) {
      return [{ address: '20.60.1.1', family: 4 }];
    }
    if (host === 'storage.internal.example') return [{ address: '10.1.2.3', family: 4 }];
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }),
}));

const original = getConfigSource();
function mode(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
afterEach(() => setConfigSource(original));

const KEY = Buffer.alloc(64, 3).toString('base64');
const SAS_SIG = 'ab%2Bcdefgh%3D';
const SAS = `sv=2022-11-02&sr=c&sp=racwdl&se=2099-01-01T00:00:00Z&sig=${SAS_SIG}`;
const CLIENT = '66666666-7777-8888-9999-000000000000';
const MIB = 1024 * 1024;

const logs: unknown[][] = [];
const logger = {
  debug() {},
  info: (...a: unknown[]) => { logs.push(a); },
  warn: (...a: unknown[]) => { logs.push(a); },
  error: (...a: unknown[]) => { logs.push(a); },
};

type Runtime = FileProviderRuntime & {
  close(): void;
  checkConnection(options?: { signal?: AbortSignal; write?: boolean }): Promise<FileConnectionCheck>;
};

const contract = AzureBlobFileProviderContract;

async function create(
  settings: Record<string, unknown> = {},
  credentials: Record<string, unknown> = { accountKey: KEY },
  tenantId = 't1',
): Promise<Runtime> {
  return await contract.createRuntime({
    tenantId,
    providerKey: 'prov',
    logger,
    credentials: credentials as AzureBlobCredentials,
    settings: { accountName: 'acctname1', container: 'files', authMethod: 'accountKey', createContainer: true, ...settings } as AzureBlobSettings,
  }) as Runtime;
}

beforeEach(() => {
  resetFake();
  logs.length = 0;
  mode({ DEPLOYMENT_MODE: 'saas' });
});

const CONTAINER_URL = 'https://acctname1.blob.core.windows.net/files';
function blobNames(url = CONTAINER_URL): string[] {
  return [...(state.containers.get(url)?.keys() ?? [])].sort();
}

/** The agents the provider installs, with the properties Node sets on them but does not type. */
type AgentLike = { protocol?: string; options: Record<string, unknown>; destroy(): void };
type Policy = { create(next: { sendRequest(r: unknown): Promise<unknown> }): { sendRequest(r: unknown): Promise<unknown> } };
/** What the request policies the provider added do to a request: the header they set and the agent they hand it. */
async function requestAfterPolicies(clientIndex = 0): Promise<{ headers: Map<string, string>; agent?: AgentLike }> {
  const request: { headers: Map<string, string>; agent?: AgentLike } = { headers: new Map() };
  for (const factory of state.clients[clientIndex].pipeline.factories as Policy[]) {
    await factory.create({ sendRequest: async (r) => r }).sendRequest(request);
  }
  return request;
}

function settingsError(error: unknown, field: string): void {
  expect(error).toBeInstanceOf(ProviderSettingsError);
  expect((error as ProviderSettingsError).field).toBe(field);
}

describe('AzureBlobFileProviderContract (SDK faked)', () => {
  it('loads the SDK on the first runtime and not before', async () => {
    expect(sdkLoads.count).toBe(0);
    contract.describeStorageLocation?.({ settings: { container: 'files' }, tenantId: 't1', providerKey: 'prov' });
    await contract.validateSettings?.({ credentials: { accountKey: KEY }, settings: { accountName: 'acctname1', container: 'files' }, isOnPrem: false });
    expect(sdkLoads.count).toBe(0);
    await create();
    await create();
    expect(sdkLoads.count).toBe(1);
  });

  it('imports the SDK for its types everywhere except the one lazy import', () => {
    const directory = join(process.cwd(), 'src/lib/providers/contracts');
    const files = [
      ...readdirSync(join(directory, 'azure')).map((name) => join(directory, 'azure', name)),
      join(directory, 'azureBlobFiles.contract.ts'),
    ];
    let lazyImports = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^.*['"]@azure\/storage-blob['"].*$/gm)) {
        const line = match[0];
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        if (/typeof import\(\s*'@azure\/storage-blob'\s*\)/.test(line)) continue;
        if (/\bimport\(\s*'@azure\/storage-blob'\s*\)/.test(line)) {
          lazyImports += 1;
          continue;
        }
        expect(line, `${file}: ${line}`).toMatch(/^\s*import type\b/);
      }
    }
    expect(lazyImports).toBe(1);
  });

  describe('contract shape', () => {
    it('is wired for the file domain', () => {
      expect(contract.id).toBe('azure-blob-files');
      expect(contract.version).toBe('1.0.0');
      expect(contract.domains).toEqual(['file']);
      expect(contract.display.label).toBe('Azure Blob Storage');
      expect(contract.capabilities).toMatchObject({ supportsMarkdownConversion: true, supportsBulkListing: true, local: false, shared: true });
    });

    it('keeps secrets in the credentials and nothing else there', () => {
      const fields = contract.form.sections.flatMap((s) => s.fields);
      expect(fields.filter((f) => f.type === 'password').every((f) => f.scope === 'credentials')).toBe(true);
      expect(fields.filter((f) => f.scope === 'credentials').map((f) => f.name).sort()).toEqual(['accountKey', 'clientSecret', 'connectionString', 'sasToken']);
      expect(fields.filter((f) => !f.scope || f.scope !== 'credentials').every((f) => f.scope === 'settings')).toBe(true);
      expect(new Set(fields.map((f) => f.name)).size).toBe(fields.length);
    });

    it('offers the four methods, shows only the fields of the chosen one and requires only the container always', () => {
      const fields = contract.form.sections.flatMap((s) => s.fields);
      const method = fields.find((f) => f.name === 'authMethod')!;
      expect(method).toMatchObject({ type: 'select', defaultValue: 'accountKey', scope: 'settings' });
      expect(method.options?.map((o) => o.value)).toEqual(['accountKey', 'sas', 'connectionString', 'entra']);
      for (const field of fields.filter((f) => f.visibleWhen)) {
        expect(field.visibleWhen?.field).toBe('authMethod');
        expect(method.options?.map((o) => o.value)).toEqual(expect.arrayContaining([field.visibleWhen!.equals as string]));
      }
      const alwaysRequired = fields.filter((f) => f.required && !f.visibleWhen).map((f) => f.name);
      expect(alwaysRequired).toEqual(['container']);

      const missing = (values: Record<string, unknown>) => missingRequiredFields(contract.form, values).map((f) => f.name);
      expect(missing({})).toEqual(['container', 'accountKey']);
      expect(missing({ container: 'files', authMethod: 'sas' })).toEqual(['sasToken']);
      expect(missing({ container: 'files', authMethod: 'connectionString' })).toEqual(['connectionString']);
      expect(missing({ container: 'files', authMethod: 'entra' })).toEqual(['entraTenantId', 'clientId', 'clientSecret']);
      expect(missing({ container: 'files', authMethod: 'sas', sasToken: SAS })).toEqual([]);
    });

    it('submits nothing for the fields of a method that is not chosen', () => {
      const buckets = partitionProviderValues(contract.form, {
        container: 'files',
        authMethod: 'sas',
        sasToken: SAS,
        accountKey: KEY,
        clientSecret: 'left-over-secret',
        entraTenantId: 'left-over',
        authorityHost: 'https://login.example',
      });
      expect(Object.keys(buckets.credentials)).toEqual(['sasToken']);
      expect(buckets.settings).toEqual({ container: 'files', authMethod: 'sas' });
    });
  });

  describe('layout and isolation', () => {
    it('stores under <prefix>/<tenant>/<provider>/<key> in the configured container', async () => {
      const a = await create({ prefix: '/cognipeer/files/' });
      await a.uploadFile({ key: 'docs/a.txt', name: 'a.txt', data: Buffer.from('a') });
      expect(blobNames()).toEqual(['cognipeer/files/t1/prov/docs/a.txt']);
      expect((await a.listFiles()).items.map((i) => i.key)).toEqual(['docs/a.txt']);
      const noPrefix = await create({}, undefined, 't2');
      await noPrefix.uploadFile({ key: 'x', name: 'x', data: Buffer.from('x') });
      expect(blobNames()).toContain('t2/prov/x');
    });

    it('never lets a key leave its prefix, and a tenant sees only its own blobs', async () => {
      const t1 = await create({}, undefined, 'tenantA');
      const t2 = await create({}, undefined, 'tenantB');
      await t2.uploadFile({ key: 'secret.txt', name: 's', data: Buffer.from('b') });
      for (const probe of ['../tenantB/prov/secret.txt', 'a/../../tenantB/prov/secret.txt', '.', '..', 'a/./b', '\\..\\x']) {
        await expect(t1.downloadFile(probe)).rejects.toThrow(/Invalid file key/);
        await expect(t1.getFileMetadata(probe)).rejects.toThrow(/Invalid file key/);
        await expect(t1.deleteFile(probe)).rejects.toThrow(/Invalid file key/);
        await expect(t1.listFiles({ prefix: probe })).rejects.toThrow(/Invalid file key/);
        await expect(t1.uploadFile({ key: probe, name: 'x', data: Buffer.from('x') })).rejects.toThrow(/Invalid file key/);
      }
      expect(await t1.getFileMetadata('secret.txt')).toBeNull();
      expect((await t1.listFiles()).items).toEqual([]);
      // a rejected key never reaches the service
      expect(state.calls.filter((c) => c === 'download')).toEqual([]);
    });

    it('refuses a key that is rejected for what it holds, with an error that is not retried', async () => {
      const rt = await create();
      for (const key of ['bad\u0001.txt', 'bad\uD800.txt', 'x'.repeat(1030)]) {
        const error = await rt.uploadFile({ key, name: 'x', data: Buffer.from('x') }).catch((e) => e);
        expect(isAzureBlobError(error), key).toBe(true);
        expect(error).toMatchObject({ statusCode: 400, retryable: false });
      }
      expect(state.calls).toEqual([]);
    });

    it('rejects a configured prefix that climbs', async () => {
      settingsError(await create({ prefix: 'a/../b' }).catch((e) => e), 'prefix');
    });

    it('generates a key when the caller gives none', async () => {
      const rt = await create();
      const { handle } = await rt.uploadFile({ name: 'Şirket Raporu.pdf', data: Buffer.from('p') });
      expect(handle.key).toMatch(/^[a-z0-9_-]+-\d+-[a-f0-9]{8}\.pdf$/);
      expect(blobNames()).toEqual([`t1/prov/${handle.key}`]);
    });
  });

  describe('round trip', () => {
    it('keeps bytes, content type, caller metadata (any shape), checksum and a quoted etag', async () => {
      const rt = await create();
      const meta = { 'doc-id': 'x', nested: { a: [1, null] }, ünï: 'çödé' };
      const { handle } = await rt.uploadFile({ key: 'a.txt', name: 'Şirket Raporu 日本語.txt', contentType: 'text/plain', data: Buffer.from('hello'), metadata: meta });
      expect(handle.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(handle.etag).toMatch(/^"/);
      expect(handle.lastModified).toBeInstanceOf(Date);
      const dl = await rt.downloadFile('a.txt');
      expect(dl.data.toString()).toBe('hello');
      expect(dl.contentType).toBe('text/plain');
      expect(dl.size).toBe(5);
      expect(dl.metadata).toEqual(meta);
      expect(dl.etag).toBe(handle.etag);
      const head = await rt.getFileMetadata('a.txt');
      expect(head).toMatchObject({ key: 'a.txt', name: 'Şirket Raporu 日本語.txt', size: 5, checksum: handle.checksum, contentType: 'text/plain' });
      expect(head?.etag).toBe(handle.etag);
      expect(head?.metadata).toEqual(meta);
    });

    it('sends only metadata the service accepts (ASCII values, identifier names, < 8 KiB)', async () => {
      const rt = await create();
      // the fake throws exactly where Azure / Node would
      await rt.uploadFile({ key: 'm.txt', name: 'ğüşiöç - 😀.pdf', data: Buffer.from('m'), metadata: { 'x-y.z': 'é日本', long: 'l'.repeat(3000) } });
      expect((await rt.downloadFile('m.txt')).metadata).toMatchObject({ 'x-y.z': 'é日本' });
    });

    it('drops caller metadata that cannot fit and says so, instead of failing the upload', async () => {
      const rt = await create();
      const { handle } = await rt.uploadFile({ key: 'big.txt', name: 'b', data: Buffer.from('b'), metadata: { blob: 'x'.repeat(30_000) } });
      expect(handle.metadata).toEqual({ blob: 'x'.repeat(30_000) });
      expect((await rt.downloadFile('big.txt')).metadata).toBeUndefined();
      expect(logs.some((l) => String(l[0]).includes('metadata not stored'))).toBe(true);
      expect(JSON.stringify(logs)).not.toContain('xxxxxxxx');
    });

    it('drops a content type the HTTP layer would refuse instead of failing the upload', async () => {
      const rt = await create();
      const { handle } = await rt.uploadFile({ key: 'ct', name: 'ct', data: Buffer.from('c'), contentType: 'text/\r\nX-Extra: 1' });
      expect(handle.contentType).toBeUndefined();
      expect((await rt.downloadFile('ct')).contentType).toBe('application/octet-stream');
      const ok = await rt.uploadFile({ key: 'ct2', name: 'ct2', data: Buffer.from('c'), contentType: 'application/pdf' });
      expect(ok.handle.contentType).toBe('application/pdf');
    });

    it('keeps long names of astral characters (emoji) from breaking the upload', async () => {
      const rt = await create();
      const name = `${'😀'.repeat(300)}.png`;
      await expect(rt.uploadFile({ key: 'emoji', name, data: Buffer.from('e') })).resolves.toBeDefined();
      const head = await rt.getFileMetadata('emoji');
      expect(Array.from(head!.name).length).toBe(255);
    });

    it('falls back to the last segment of the key when the blob carries no name', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'a/b/c.txt', name: 'c', data: Buffer.from('c') });
      state.containers.get(CONTAINER_URL)!.get('t1/prov/a/b/c.txt')!.metadata = {};
      expect((await rt.getFileMetadata('a/b/c.txt'))?.name).toBe('c.txt');
    });

    it('overwrites in place', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'o', name: 'o', data: Buffer.from('one') });
      await rt.uploadFile({ key: 'o', name: 'o', data: Buffer.from('twotwo') });
      expect((await rt.downloadFile('o')).data.toString()).toBe('twotwo');
      expect((await rt.getFileMetadata('o'))?.size).toBe(6);
    });

    it('stores an empty file', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'empty', name: 'empty', data: Buffer.alloc(0) });
      const dl = await rt.downloadFile('empty');
      expect(dl.data.length).toBe(0);
      expect(dl.size).toBe(0);
    });
  });

  describe('downloads are bounded', () => {
    it('refuses an object that announces more than the ceiling without reading it', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'big', name: 'big', data: Buffer.from('b') });
      state.download = { contentLength: 150 * MIB };
      const error = await rt.downloadFile('big').catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ code: 'ObjectTooLarge', retryable: false });
      expect(error.message).toContain('100 MB');
      expect(error.message).not.toMatch(/not found|does not exist/i);
    });

    it('stops reading a body that grows past the ceiling although it announced nothing', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'stream', name: 'stream', data: Buffer.from('s') });
      const chunk = Buffer.alloc(MIB, 1);
      let produced = 0;
      state.download = {
        contentLength: null,
        chunks: function* () {
          for (let i = 0; i < 300; i += 1) {
            produced += 1;
            yield chunk;
          }
        },
      };
      await expect(rt.downloadFile('stream')).rejects.toMatchObject({ code: 'ObjectTooLarge' });
      expect(produced).toBeLessThan(200);
    });

    it('reads a body that is exactly the ceiling although it announced nothing', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'exact', name: 'exact', data: Buffer.from('e') });
      const chunk = Buffer.alloc(10 * MIB, 2);
      state.download = { contentLength: null, chunks: () => Array.from({ length: 10 }, () => chunk) };
      const result = await rt.downloadFile('exact');
      expect(result.data.length).toBe(100 * MIB);
      expect(result.size).toBe(100 * MIB);
    });

    it('raises the ceiling with the upload limit', async () => {
      mode({ DEPLOYMENT_MODE: 'saas', FILE_UPLOAD_MAX_MB: '200' });
      const rt = await create();
      await rt.uploadFile({ key: 'big', name: 'big', data: Buffer.from('b') });
      state.download = { contentLength: 300 * MIB, chunks: () => [Buffer.from('abc')] };
      // 300 MiB is under twice the 200 MB limit: it is read (and then found shorter than announced)
      const error = await rt.downloadFile('big').catch((e) => e);
      expect(error.code).not.toBe('ObjectTooLarge');
      expect(error.message).toMatch(/download failed/);
    });

    describe('a bound the caller states', () => {
      // A caller that reads objects of its own, which the upload limit never applied to (a sandbox volume), says how
      // much it can hold. The server-wide ceiling is 100 MB here.
      it('replaces the ceiling: an object over it is let through when the caller allows it', async () => {
        const rt = await create();
        await rt.uploadFile({ key: 'big', name: 'big', data: Buffer.from('b') });
        state.download = { contentLength: 150 * MIB, chunks: () => [Buffer.from('abc')] };

        expect(await rt.downloadFile('big').catch((e) => e)).toMatchObject({ code: 'ObjectTooLarge' });
        // 150 MiB is under the bound: the object is read (and then found shorter than announced)
        const error = await rt.downloadFile('big', { maxBytes: 200 * MIB }).catch((e) => e);
        expect(error.code).not.toBe('ObjectTooLarge');
        expect(error.message).toMatch(/download failed/);
      });

      it('refuses an object over the bound, although the ceiling would let it through, without reading it', async () => {
        const rt = await create();
        await rt.uploadFile({ key: 'mid', name: 'mid', data: Buffer.from('m') });
        let produced = 0;
        state.download = { contentLength: 5 * MIB, chunks: function* () { produced += 1; yield Buffer.alloc(MIB); } };

        const error = await rt.downloadFile('mid', { maxBytes: 4 * MIB }).catch((e) => e);

        expect(error).toBeInstanceOf(AzureBlobError);
        expect(error).toMatchObject({ code: 'ObjectTooLarge', retryable: false });
        expect(error.message).toBe('This file is larger than the 4 MB this server loads into memory at once.');
        expect(produced).toBe(0);
      });

      // The sizes are small on purpose: were the bound ignored, the call would hand back what it read, and a failed
      // assertion prints it.
      it('stops a body that announced nothing once it passes the bound', async () => {
        const rt = await create();
        await rt.uploadFile({ key: 'stream', name: 'stream', data: Buffer.from('s') });
        const chunk = Buffer.alloc(1024, 1);
        let produced = 0;
        state.download = {
          contentLength: null,
          chunks: function* () {
            for (let i = 0; i < 50; i += 1) {
              produced += 1;
              yield chunk;
            }
          },
        };

        const error = await rt.downloadFile('stream', { maxBytes: 3 * 1024 }).then(() => undefined, (e) => e);

        expect(error).toMatchObject({ code: 'ObjectTooLarge' });
        expect(produced).toBeLessThan(10);
      });

      it('reads an object that is exactly the bound, and refuses one byte more', async () => {
        const rt = await create();
        await rt.uploadFile({ key: 'exact', name: 'exact', data: Buffer.from('e') });
        state.download = { contentLength: null, chunks: () => [Buffer.alloc(1024, 2), Buffer.alloc(1024, 3)] };

        expect((await rt.downloadFile('exact', { maxBytes: 2048 })).data.length).toBe(2048);
        const error = await rt.downloadFile('exact', { maxBytes: 2047 }).then(() => undefined, (e) => e);
        expect(error).toMatchObject({ code: 'ObjectTooLarge' });
      });

      it.each([
        ['zero', 0],
        ['a negative number', -5],
        ['NaN', Number.NaN],
        ['text', '4194304'],
      ])('ignores a bound that is %s: the ceiling applies', async (_label, maxBytes) => {
        const rt = await create();
        await rt.uploadFile({ key: 'big', name: 'big', data: Buffer.from('b') });
        state.download = { contentLength: 150 * MIB };

        const error = await rt.downloadFile('big', { maxBytes } as never).catch((e) => e);

        expect(error).toMatchObject({ code: 'ObjectTooLarge' });
        expect(error.message).toContain('100 MB');
      });
    });

    it('does not hand back a body that is shorter than announced', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'short', name: 'short', data: Buffer.from('s') });
      state.download = { contentLength: 10, chunks: () => [Buffer.from('12345')] };
      const error = await rt.downloadFile('short').catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.message).toContain('Incomplete download: got 5 of 10 bytes');
      expect(error.retryable).toBe(true);
    });
  });

  describe('a download whose connection drops', () => {
    const payload = Buffer.from('0123456789'.repeat(100)); // 1000 bytes

    async function seeded(): Promise<Runtime> {
      const rt = await create();
      await rt.uploadFile({ key: 'big.bin', name: 'big.bin', data: payload });
      state.downloads.length = 0;
      return rt;
    }

    it('asks for the rest of the object under the version it started with, and hands back the whole of it', async () => {
      const rt = await seeded();
      state.cutDownload = { afterBytes: 400, times: 1 };
      const result = await rt.downloadFile('big.bin');
      expect(result.data.equals(payload)).toBe(true);
      expect(result.size).toBe(1000);
      const etag = [...state.containers.get(CONTAINER_URL)!.values()][0].etag;
      // the SDK's own continuation is off (it does not run for a dropped connection), so the driver does it
      expect(state.downloads).toEqual([
        { offset: 0, count: undefined, ifMatch: undefined, maxRetryRequests: 0 },
        { offset: 400, count: 600, ifMatch: etag, maxRetryRequests: 0 },
      ]);
    });

    it('continues again when the rest is cut off too, up to two times', async () => {
      const rt = await seeded();
      state.cutDownload = { afterBytes: 400, times: 2 };
      expect((await rt.downloadFile('big.bin')).data.equals(payload)).toBe(true);
      expect(state.downloads.map((d) => [d.offset, d.count])).toEqual([[0, undefined], [400, 600], [800, 200]]);
    });

    it('recognises a reset reported with a Node code and the SDK\'s own "received less data" error', async () => {
      for (const error of [
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }),
        new Error('Data corruption failure: received less data than required. Received data offset: 99, data needed offset: 999, retries: 0, max retries: 0'),
      ]) {
        const rt = await seeded();
        state.cutDownload = { afterBytes: 250, times: 1, error };
        expect((await rt.downloadFile('big.bin')).data.equals(payload)).toBe(true);
        expect(state.downloads).toHaveLength(2);
      }
    });

    it('gives up after two continuations, and says the connection was interrupted rather than that nothing answered', async () => {
      const rt = await seeded();
      state.cutDownload = { afterBytes: 100, times: 9 };
      const error = await rt.downloadFile('big.bin').catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.message).toBe('The connection to Azure Blob Storage was interrupted (download).');
      expect(error.retryable).toBe(true);
      expect(state.downloads).toHaveLength(3);
    });

    it('does not continue a download the caller gave up on, and says what it always said for a time limit', async () => {
      const rt = await seeded();
      const controller = new AbortController();
      state.cutDownload = { afterBytes: 100, times: 1, onCut: () => controller.abort() };
      const result = await rt.checkConnection({ signal: controller.signal });
      expect(result.steps?.find((step) => step.step === 'read')?.message).toBe('Azure Blob Storage did not answer in time (download).');
      expect(state.downloads).toHaveLength(1);
    });

    it('does not continue a failure that is not a lost connection', async () => {
      const rt = await seeded();
      state.cutDownload = { afterBytes: 100, times: 1, error: new Error('Something else went wrong') };
      const error = await rt.downloadFile('big.bin').catch((e) => e);
      expect(error.message).toBe('Azure Blob Storage download failed with an unknown error: Something else went wrong.');
      expect(state.downloads).toHaveLength(1);
    });

    it('takes a download whose connection was reported lost after the last byte as complete', async () => {
      const rt = await seeded();
      state.cutDownload = { afterBytes: 1000, times: 1 };
      const result = await rt.downloadFile('big.bin');
      expect(result.data.equals(payload)).toBe(true);
      expect(state.downloads).toHaveLength(1);
    });

    it('does not ask for the rest of an object it has no version of', async () => {
      const rt = await seeded();
      ([...state.containers.get(CONTAINER_URL)!.values()][0] as { etag?: string }).etag = undefined;
      state.cutDownload = { afterBytes: 400, times: 1 };
      const error = await rt.downloadFile('big.bin').catch((e) => e);
      expect(error.message).toBe('The connection to Azure Blob Storage was interrupted (download).');
      expect(state.downloads).toHaveLength(1);
    });

    it('does not guess at a body that ended short without an error: that is reported as incomplete', async () => {
      const rt = await seeded();
      state.download = { contentLength: 1000, chunks: () => [payload.subarray(0, 300)] };
      const error = await rt.downloadFile('big.bin').catch((e) => e);
      expect(error.message).toContain('Incomplete download: got 300 of 1000 bytes');
      expect(state.downloads).toHaveLength(1);
    });

    it('reports a file that was replaced while it was being continued, and lets the caller try again', async () => {
      const rt = await seeded();
      state.cutDownload = {
        afterBytes: 100,
        times: 1,
        onCut: () => { for (const blob of state.containers.get(CONTAINER_URL)!.values()) blob.etag = '"0x8DREPLACED"'; },
      };
      const error = await rt.downloadFile('big.bin').catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ code: 'BlobChangedDuringDownload', retryable: true });
      expect(error.message).toBe('The file changed while it was being downloaded; try again.');
      expect(error.message).not.toMatch(/not found|does not exist/i);
    });

    it('lets a failure of the continuation request speak for itself', async () => {
      const rt = await seeded();
      state.cutDownload = { afterBytes: 100, times: 1 };
      state.onCall.set('download', () => {
        if (state.downloads.length === 1) state.failNext.set('download', restError(503, 'ServerBusy', 'busy'));
      });
      const error = await rt.downloadFile('big.bin').catch((e) => e);
      expect(error.message).toBe('Azure Blob Storage is busy or timing out (ServerBusy); try again.');
      expect(error.statusCode).toBe(503);
    });

    it('is the same for the read step of Test connection, which then finds the object intact', async () => {
      const rt = await create();
      state.cutDownload = { afterBytes: 10, times: 1 };
      const result = await rt.checkConnection();
      expect(result).toMatchObject({ ok: true });
      expect(state.downloads).toHaveLength(2);
    });
  });

  describe('listing', () => {
    it('pages with an opaque cursor and relative keys', async () => {
      const rt = await create();
      for (const k of ['p/1', 'p/2', 'p/3', 'p/4', 'p/5', 'q/1']) await rt.uploadFile({ key: k, name: k, data: Buffer.from(k) });
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await rt.listFiles({ prefix: 'p/', limit: 2, cursor });
        seen.push(...page.items.map((i) => i.key));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
      expect(seen).toEqual(['p/1', 'p/2', 'p/3', 'p/4', 'p/5']);
      expect(pages).toBe(3);
      expect(state.lists.every((l) => l.maxPageSize === 2 && l.includeMetadata === true && l.prefix === 't1/prov/p/')).toBe(true);
    });

    it('reads a trailing slash as the folder and no slash as a name prefix', async () => {
      const rt = await create();
      for (const k of ['p/1', 'pp/2', 'p-x']) await rt.uploadFile({ key: k, name: k, data: Buffer.from(k) });
      expect((await rt.listFiles({ prefix: 'p/' })).items.map((i) => i.key)).toEqual(['p/1']);
      expect((await rt.listFiles({ prefix: 'p' })).items.map((i) => i.key)).toEqual(['p-x', 'p/1', 'pp/2']);
      expect((await rt.listFiles({ prefix: '/p//' })).items.map((i) => i.key)).toEqual(['p/1']);
    });

    it('keeps the page size within what the service allows', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') });
      await rt.listFiles({ limit: 0 });
      await rt.listFiles({ limit: 1_000_000 });
      await rt.listFiles();
      expect(state.lists.map((l) => l.maxPageSize)).toEqual([1, 5000, 50]);
    });

    it('follows empty pages that still carry a continuation token', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'later', name: 'later', data: Buffer.from('l') });
      state.emptyListPages = 3;
      expect((await rt.listFiles({ limit: 5 })).items.map((i) => i.key)).toEqual(['later']);
    });

    it('gives up on a listing that stays empty and hands the cursor back', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'later', name: 'later', data: Buffer.from('l') });
      state.emptyListPages = 100;
      const page = await rt.listFiles({ limit: 5 });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toMatch(/^empty-/);
      expect(state.calls.filter((c) => c === 'list')).toHaveLength(8);
    });

    it('hides ADLS directory markers and normalises the etag to its quoted form', async () => {
      const rt = await create();
      const { handle } = await rt.uploadFile({ key: 'f.txt', name: 'f', data: Buffer.from('f') });
      state.containers.get(CONTAINER_URL)!.set('t1/prov/dir', { data: Buffer.alloc(0), metadata: { hdi_isfolder: 'true' }, etag: '"0x1"', lastModified: new Date() });
      const items = (await rt.listFiles()).items;
      expect(items.map((i) => i.key)).toEqual(['f.txt']);
      expect(items[0].etag).toBe(handle.etag);
    });

    it('lists the details a handle needs, from the blob itself', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'd/n.txt', name: 'Şirket.txt', contentType: 'text/plain', data: Buffer.from('12345'), metadata: { a: 1 } });
      const [item] = (await rt.listFiles()).items;
      expect(item).toMatchObject({ key: 'd/n.txt', name: 'Şirket.txt', size: 5, contentType: 'text/plain', metadata: { a: 1 } });
      expect(item.checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('missing things', () => {
    it('a missing blob is null for metadata, "File not found" (404) for download, silent for delete', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'present', name: 'present', data: Buffer.from('p') }); // makes the container exist
      expect(await rt.getFileMetadata('nope')).toBeNull();
      await expect(rt.downloadFile('nope')).rejects.toMatchObject({ message: 'File not found: nope', statusCode: 404, retryable: false });
      await expect(rt.deleteFile('nope')).resolves.toBeUndefined();
    });

    it('a missing container is a configuration error, not "File not found"', async () => {
      const rt = await create({ createContainer: false });
      for (const call of [
        () => rt.downloadFile('a'),
        () => rt.getFileMetadata('a'),
        () => rt.listFiles({ limit: 1 }),
        () => rt.deleteFile('a'),
        () => rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }),
      ]) {
        const error = await call().catch((e) => e);
        expect(error).toBeInstanceOf(AzureBlobError);
        expect(error).toMatchObject({ statusCode: 404, code: 'ContainerNotFound', retryable: false });
        expect(error.message).toContain('files');
        expect(error.message).not.toMatch(/not found|does not exist/i);
      }
      expect(state.calls).not.toContain('createContainer');
    });

    it('with "create container" on, a container that does not exist yet is simply an empty store', async () => {
      const rt = await create({ createContainer: true });
      expect((await rt.listFiles({ limit: 1 })).items).toEqual([]);
      expect(await rt.getFileMetadata('a')).toBeNull();
      await expect(rt.downloadFile('a')).rejects.toMatchObject({ message: 'File not found: a', statusCode: 404 });
      await expect(rt.deleteFile('a')).resolves.toBeUndefined();
      expect(blobNames()).toEqual([]);
      expect(state.containers.size).toBe(0);
      await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') });
      expect(blobNames()).toEqual(['t1/prov/a']);
    });

    it('an account-level 404 (ResourceNotFound) is never reported as a missing file', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'present', name: 'p', data: Buffer.from('p') });
      state.failNext.set('head', restError(404, 'ResourceNotFound'));
      state.failNext.set('download', restError(404, 'ResourceNotFound'));
      const head = await rt.getFileMetadata('x').catch((e) => e);
      const download = await rt.downloadFile('x').catch((e) => e);
      for (const error of [head, download]) {
        expect(error).toBeInstanceOf(AzureBlobError);
        expect(error.message).not.toMatch(/^File not found/);
        expect(error.statusCode).toBe(404);
        expect(error.code).toBe('ResourceNotFound');
      }
    });

    it('names the step that failed when the container cannot be created, and retries it next time', async () => {
      const rt = await create({ createContainer: true });
      state.failNext.set('createContainer', restError(403, 'AuthorizationPermissionMismatch', 'This request is not authorized to perform this operation using this permission.'));
      const error = await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ statusCode: 403, code: 'AuthorizationPermissionMismatch' });
      expect(error.message).toContain('create the container');
      await expect(rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') })).resolves.toBeDefined();
      expect(blobNames()).toEqual(['t1/prov/a']);
    });

    it('creates the container once for concurrent first uploads, and again if it is deleted later', async () => {
      const rt = await create({ createContainer: true });
      await Promise.all([1, 2, 3, 4, 5].map((i) => rt.uploadFile({ key: `c${i}`, name: 'c', data: Buffer.from('c') })));
      expect(state.calls.filter((c) => c === 'createContainer')).toHaveLength(1);
      expect(blobNames()).toHaveLength(5);
      state.containers.clear();
      await rt.uploadFile({ key: 'again', name: 'a', data: Buffer.from('a') });
      expect(state.calls.filter((c) => c === 'createContainer')).toHaveLength(2);
      expect(blobNames()).toEqual(['t1/prov/again']);
    });

    it('does not create a container that exists', async () => {
      state.containers.set(CONTAINER_URL, new Map());
      const rt = await create({ createContainer: true });
      await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') });
      expect(state.calls).not.toContain('createContainer');
    });
  });

  describe('failures', () => {
    it('turns SDK errors into AzureBlobError with a status and an actionable sentence', async () => {
      const rt = await create();
      state.failNext.set('upload', restError(403, 'AuthorizationPermissionMismatch', 'This request is not authorized to perform this operation using this permission.\nRequestId:abc\nTime:now'));
      const error = await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('AuthorizationPermissionMismatch');
      expect(error.message).toContain('acctname1/files');
      expect(error.message).not.toMatch(/RequestId|Time:/);
      expect(Object.keys(error)).not.toContain('request');
    });

    it('carries the request id the service sent, for support', async () => {
      const rt = await create();
      state.failNext.set('upload', Object.assign(restError(500, 'InternalError', 'boom'), { details: { errorCode: 'InternalError', 'x-ms-request-id': 'req-123' } }));
      expect(await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e.requestId)).toBe('req-123');
    });

    it('declares what the resilience layer should retry: outages and throttling, not rejections', async () => {
      const rt = await create();
      const attempt = async (failure: unknown) => {
        state.failNext.set('upload', failure);
        return (await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e)) as AzureBlobError;
      };
      expect(await attempt(restError(503, 'ServerBusy', 'busy'))).toMatchObject({ statusCode: 503, retryable: true });
      expect(await attempt(restError(429, 'ServerBusy', 'slow down'))).toMatchObject({ statusCode: 429, retryable: true });
      expect(await attempt(restError(403, 'AuthenticationFailed', 'no'))).toMatchObject({ statusCode: 403, retryable: false });
      expect(await attempt(restError(400, 'InvalidMetadata', 'no'))).toMatchObject({ statusCode: 400, retryable: false });
      const reset = await attempt(Object.assign(new Error('connect ECONNRESET'), { name: 'RestError', code: 'ECONNRESET' }));
      expect(reset.statusCode).toBeUndefined();
      expect(reset.message).toMatch(/ECONNRESET/);
      expect(reset.retryable).toBe(true);
      const untrusted = await attempt(Object.assign(new Error('self-signed certificate'), { name: 'RestError', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }));
      expect(untrusted.retryable).toBe(false);
      expect(untrusted.message).toContain('CA certificate');
      const refused = await attempt(Object.assign(new Error('Refusing outbound request to private/loopback host: acctname1.blob.core.windows.net'), { name: 'RestError', code: 'REQUEST_SEND_ERROR' }));
      expect(refused.retryable).toBe(false);
      expect(refused.message).toBe('acctname1.blob.core.windows.net resolves to a private or loopback address, which this deployment does not allow.');
    });

    it('fails with a sentence even when something that is not an error is thrown', async () => {
      const rt = await create();
      state.failNext.set('upload', 42);
      const error = await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.message).toBe('Azure Blob Storage upload failed with an unknown error.');
    });

    it('never puts a credential into a message, whatever the SDK put into its own', async () => {
      const sas = await create({ authMethod: 'sas', createContainer: false }, { sasToken: SAS });
      state.containers.set(CONTAINER_URL, new Map());
      state.failNext.set('upload', Object.assign(new Error(`PUT https://acctname1.blob.core.windows.net/files/x?${SAS} failed`), { name: 'RestError', code: 'REQUEST_SEND_ERROR' }));
      const sasError = await sas.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e);
      expect(sasError.message).not.toContain('ab+cdefgh=');
      expect(sasError.message).not.toContain(SAS_SIG);
      expect(sasError.message).not.toContain('sig=ab');

      const keyed = await create();
      state.containers.get(CONTAINER_URL)!.clear();
      state.failNext.set('download', Object.assign(new Error(`bad header Authorization: SharedKey acctname1:${KEY}`), { name: 'RestError', code: 'REQUEST_SEND_ERROR' }));
      const keyError = await keyed.downloadFile('a').catch((e) => e);
      expect(keyError.message).not.toContain(KEY);
      expect(JSON.stringify(logs)).not.toContain(KEY);
      expect(JSON.stringify(logs)).not.toContain(SAS_SIG);
    });
  });

  describe('deadlines', () => {
    it('gives every call its own abort signal, and the caller one that also stops it', async () => {
      const rt = await create();
      await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') });
      await rt.downloadFile('a');
      await rt.getFileMetadata('a');
      await rt.listFiles();
      await rt.deleteFile('a');
      for (const kind of ['upload', 'download', 'head', 'list', 'delete', 'createContainer']) {
        const signal = state.signals.get(kind);
        expect(signal, kind).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted, kind).toBe(false);
      }
    });

    it('sets the budget just inside the caller attempt timeout, with a floor, and a shorter one for listings', async () => {
      const spy = vi.spyOn(AbortSignal, 'timeout');
      const budgets = async (env: Record<string, string>) => {
        mode({ DEPLOYMENT_MODE: 'saas', ...env });
        state.containers.set(CONTAINER_URL, new Map());
        spy.mockClear();
        const rt = await create();
        await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') });
        await rt.listFiles();
        await rt.getFileMetadata('a');
        return spy.mock.calls.map((c) => c[0]);
      };
      try {
        expect(await budgets({})).toEqual([118_000, 30_000, 30_000]);
        expect(await budgets({ GATEWAY_REQUEST_TIMEOUT_MS: '20000' })).toEqual([18_000, 18_000, 18_000]);
        expect(await budgets({ GATEWAY_REQUEST_TIMEOUT_MS: '3000' })).toEqual([5_000, 5_000, 5_000]);
        expect(await budgets({ GATEWAY_REQUEST_TIMEOUT_MS: '0' })).toEqual([600_000, 30_000, 30_000]);
      } finally {
        spy.mockRestore();
      }
    });

    it('turns a call that outlives its deadline into a retryable timeout without carrying request details', async () => {
      const rt = await create();
      state.containers.set(CONTAINER_URL, new Map());
      state.delayMs = 60_000;
      const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
      try {
        const error = await rt.downloadFile('a').catch((e) => e);
        expect(error).toBeInstanceOf(AzureBlobError);
        expect(error.message).toBe('Azure Blob Storage did not answer in time (download).');
        expect(error.retryable).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('endpoint policy', () => {
    it('SaaS: no private, loopback or metadata addresses, over https or plain http', async () => {
      for (const endpoint of ['https://127.0.0.1/acctname1', 'https://169.254.169.254/acctname1', 'https://[::1]/acctname1', 'https://localhost/acctname1', 'https://x.internal/acctname1', 'https://storage.internal.example/acctname1', 'http://127.0.0.1:10000/acctname1', 'http://169.254.169.254/acctname1']) {
        const error = await create({ endpoint }).catch((e) => e);
        // The setting it is about, in the words every provider endpoint check uses: no host, URL or range in them.
        expect(error, endpoint).toBeInstanceOf(ProviderEndpointError);
        expect(error).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint', retryable: false });
        expect(error.message).toBe('Provider endpoint "endpoint" is not allowed: private network addresses are reachable only through networks the operator has opened for this organization');
      }
      await expect(create({ endpoint: 'http://93.184.216.34/acctname1' })).resolves.toBeDefined();
      await expect(create({ endpoint: 'https://93.184.216.34/acctname1' })).resolves.toBeDefined();
    });

    it('SaaS: a host that does not resolve is answered as the setting it is about, and stays retryable: it is no policy refusal', async () => {
      const error = await create({ endpoint: 'https://acctname1.blob.example.invalid' }).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderEndpointError);
      expect(error).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint', retryable: true });
      expect(error.message).toBe('Provider endpoint "endpoint" is not allowed: Could not resolve host: acctname1.blob.example.invalid');
    });

    it('SaaS: the loopback refusal comes from createRuntime, before the SDK or any socket', async () => {
      await create({ endpoint: 'https://127.0.0.1/acctname1' }).catch(() => undefined);
      expect(state.clients).toEqual([]);
      expect(state.calls).toEqual([]);
    });

    it('on-prem: plaintext and private endpoints (Azurite, Azure Stack) work unless the operator blocks them', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await expect(create({ endpoint: 'http://127.0.0.1:10000/acctname1' })).resolves.toBeDefined();
      await expect(create({ endpoint: 'https://storage.internal.example/acctname1' })).resolves.toBeDefined();
      mode({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
      await expect(create({ endpoint: 'http://127.0.0.1:10000/acctname1' })).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint', retryable: false });
      mode({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '127.0.0.1' });
      await expect(create({ endpoint: 'http://127.0.0.1:10000/acctname1' })).resolves.toBeDefined();
    });

    it('vets the Microsoft Entra authority too: it is a place the secret is sent to', async () => {
      const entra = { authMethod: 'entra', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT };
      const secret = { clientSecret: 'super-secret-value' };
      const saas = await create({ ...entra, authorityHost: 'https://127.0.0.1' }, secret).catch((e) => e);
      expect(saas).toBeInstanceOf(ProviderEndpointError);
      expect(saas.field).toBe('authorityHost');
      expect(saas.message).not.toContain('super-secret-value');
      await expect(create({ ...entra, authorityHost: 'https://login.internal.example' }, secret)).rejects.toBeInstanceOf(ProviderEndpointError);
      await expect(create(entra, secret)).resolves.toBeDefined();
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await expect(create({ ...entra, authorityHost: 'https://127.0.0.1' }, secret)).resolves.toBeDefined();
    });
  });

  describe('the socket agent', () => {
    it('SaaS: a guarded agent carries the traffic, with a lookup that checks the address a socket is about to dial', async () => {
      const rt = await create();
      expect(state.clients[0].pipeline.factories).toHaveLength(1);
      const request = await requestAfterPolicies();
      const agent = request.agent!;
      expect(agent).toBeDefined();
      expect(agent.options).toMatchObject({ keepAlive: true });
      expect(typeof (agent.options as { lookup?: unknown }).lookup).toBe('function');
      rt.close();
    });

    it('on-prem default: no agent, so the SDK keeps its own and with it HTTP(S)_PROXY', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await create();
      expect(state.clients[0].pipeline.factories).toHaveLength(0);
    });

    it('on-prem with the private-network block: a guarded agent of the endpoint\'s protocol', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
      await create({ endpoint: 'http://93.184.216.34:10000/acctname1' });
      const request = await requestAfterPolicies();
      expect(request.agent).toBeDefined();
      expect(request.agent!.protocol).toBe('http:');
      expect(typeof (request.agent!.options as { lookup?: unknown }).lookup).toBe('function');
    });

    it('a version override alone needs the request policy, and carries no agent where none is needed', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await create({ apiVersion: '2023-11-03' });
      expect(state.clients[0].pipeline.factories).toHaveLength(1);
      const request = await requestAfterPolicies();
      expect(request.headers.get('x-ms-version')).toBe('2023-11-03');
      expect(request.agent).toBeUndefined();
    });

    it('a CA certificate is trusted through the agent, and only on top of the default trust', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await create({ caCertificate: tls.rootCertificates[0] });
      const request = await requestAfterPolicies();
      const options = request.agent!.options as { secureContext?: unknown; ca?: unknown; rejectUnauthorized?: boolean; lookup?: unknown };
      expect(options.secureContext).toBeDefined();
      expect(options.rejectUnauthorized).toBeUndefined();
      expect(options.lookup).toBeUndefined();
    });

    it('skipping verification works on any deployment, and only for the boolean true', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await create({ allowInsecureTls: true });
      expect(((await requestAfterPolicies(0)).agent!.options as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(false);
      await create({ allowInsecureTls: 'false' });
      expect(state.clients[1].pipeline.factories).toHaveLength(0);
      mode({ DEPLOYMENT_MODE: 'saas' });
      await create({ allowInsecureTls: true });
      const saas = (await requestAfterPolicies(2)).agent!;
      expect((saas.options as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(false);
      // the network policy stays on: the same agent still checks every address it connects to
      expect(typeof saas.options.lookup).toBe('function');
    });

    it('a CA certificate that does not parse is refused when the runtime is built', async () => {
      settingsError(await create({ caCertificate: 'not a certificate' }).catch((e) => e), 'caCertificate');
    });

    it('close() destroys the agent it created, and is safe to call twice or without one', async () => {
      const rt = await create();
      const agent = (await requestAfterPolicies()).agent!;
      const destroy = vi.spyOn(agent, 'destroy');
      rt.close();
      rt.close();
      expect(destroy).toHaveBeenCalled();
      mode({ DEPLOYMENT_MODE: 'onprem' });
      const plain = await create();
      expect(() => plain.close()).not.toThrow();
    });

    it('does not leave an agent behind when the runtime cannot be built', async () => {
      const destroy = vi.spyOn(http.Agent.prototype, 'destroy');
      const pipeline = vi.spyOn(fakeSdkModule, 'newPipeline').mockImplementation(() => {
        throw new Error('pipeline failed');
      });
      try {
        await expect(create()).rejects.toThrow('pipeline failed');
        // a SaaS runtime guards its connections, so it had agents by then: they are closed again
        expect(destroy.mock.contexts.some((agent) => agent instanceof https.Agent)).toBe(true);
      } finally {
        pipeline.mockRestore();
        destroy.mockRestore();
      }
    });
  });

  describe('authentication', () => {
    it('account key: shared-key credential, plain container URL', async () => {
      await create();
      expect(state.clients[0].url).toBe(CONTAINER_URL);
      expect(state.clients[0].pipeline.credential).toBeInstanceOf(fakeSdkModule.StorageSharedKeyCredential);
      expect(state.clients[0].pipeline.credential).toMatchObject({ accountName: 'acctname1', accountKey: KEY });
    });

    it('SAS: anonymous credential, token appended to the container URL exactly as issued', async () => {
      await create({ authMethod: 'sas' }, { sasToken: `?${SAS}` });
      expect(state.clients[0].url).toBe(`${CONTAINER_URL}?${SAS}`);
      expect(state.clients[0].pipeline.credential).toBeInstanceOf(fakeSdkModule.AnonymousCredential);
      // a pasted SAS URL gives its query only: the account still comes from the settings
      await create({ authMethod: 'sas' }, { sasToken: `https://acctname1.blob.core.windows.net/files?${SAS}` });
      expect(state.clients[1].url).toBe(`${CONTAINER_URL}?${SAS}`);
      settingsError(await create({ authMethod: 'sas', accountName: undefined }, { sasToken: SAS }).catch((e) => e), 'accountName');
    });

    it('SAS: works on a custom domain without an account name', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await create({ authMethod: 'sas', accountName: undefined, endpoint: 'https://files.example.com' }, { sasToken: SAS });
      expect(state.clients[0].url).toBe(`https://files.example.com/files?${SAS}`);
    });

    it('connection string: endpoint and key come from the string, which is validated', async () => {
      await create({ authMethod: 'connectionString', accountName: undefined }, { connectionString: `DefaultEndpointsProtocol=https;AccountName=acctname1;AccountKey=${KEY};EndpointSuffix=core.windows.net` });
      expect(state.clients[0].url).toBe(CONTAINER_URL);
      expect(state.clients[0].pipeline.credential).toBeInstanceOf(fakeSdkModule.StorageSharedKeyCredential);
      settingsError(await create({ authMethod: 'connectionString', accountName: undefined }, { connectionString: `AccountName=other.example/x#;AccountKey=${KEY}` }).catch((e) => e), 'connectionString');
    });

    it('connection string: UseDevelopmentStorage is refused with a pointer to the explicit endpoint', async () => {
      const error = await create({ authMethod: 'connectionString', accountName: undefined }, { connectionString: 'UseDevelopmentStorage=true' }).catch((e) => e);
      settingsError(error, 'connectionString');
      expect(error.message).toContain('BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1');
    });

    it('connection string: a BlobEndpoint on a private address is refused on SaaS', async () => {
      const connectionString = `AccountName=acctname1;AccountKey=${KEY};BlobEndpoint=https://storage.internal.example/acctname1`;
      const error = await create({ authMethod: 'connectionString', accountName: undefined }, { connectionString }).catch((e) => e);
      // The endpoint came out of the connection string, so that is the setting the person is sent to.
      expect(error).toBeInstanceOf(ProviderEndpointError);
      expect(error).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'connectionString', retryable: false });
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain('storage.internal.example');
    });

    it('Entra: token credential, https only, the sovereign suffix picks the sovereign authority', async () => {
      const settings = { authMethod: 'entra', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT };
      await create(settings, { clientSecret: 'super-secret-value' });
      expect(typeof (state.clients[0].pipeline.credential as { getToken: unknown }).getToken).toBe('function');
      expect(state.clients[0].url).toBe(CONTAINER_URL);
      settingsError(await create({ ...settings, clientId: 'nope' }, { clientSecret: 'super-secret-value' }).catch((e) => e), 'clientId');
      mode({ DEPLOYMENT_MODE: 'onprem' });
      settingsError(await create({ ...settings, endpoint: 'http://127.0.0.1:10000/acctname1' }, { clientSecret: 'super-secret-value' }).catch((e) => e), 'endpoint');
    });

    it('Entra: the token request goes through the guarded fetch, with the sovereign authority where the endpoint is sovereign', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }));
      try {
        await create({ authMethod: 'entra', entraTenantId: CLIENT, clientId: CLIENT, endpoint: 'https://acctname1.blob.core.usgovcloudapi.net' }, { clientSecret: 'super-secret-value' });
        const credential = state.clients[0].pipeline.credential as { getToken(): Promise<{ token: string }> };
        expect((await credential.getToken()).token).toBe('tok');
        const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
        expect(String(url)).toBe(`https://login.microsoftonline.us/${CLIENT}/oauth2/v2.0/token`);
        expect(init.redirect).toBe('manual');
        expect(init.method).toBe('POST');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('error and log text never carries a credential', async () => {
      const secrets = [KEY, 'super-secret-value'];
      const attempts: Array<() => Promise<unknown>> = [
        () => create({ container: 'BAD NAME' }),
        () => create({ authMethod: 'entra' }, { clientSecret: 'super-secret-value' }),
        () => create({ authMethod: 'sas' }, { sasToken: 'sv=1' }),
        () => create({ endpoint: 'https://127.0.0.1/acctname1' }),
        () => create({ authMethod: 'entra', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT, authorityHost: 'https://127.0.0.1' }, { clientSecret: 'super-secret-value' }),
      ];
      for (const attempt of attempts) {
        const error = await attempt().catch((e) => e);
        for (const secret of secrets) expect(String((error as Error | undefined)?.message)).not.toContain(secret);
      }
      expect(JSON.stringify(logs)).not.toContain(KEY);
    });
  });

  describe('validateSettings', () => {
    const base = { credentials: { accountKey: KEY } as AzureBlobCredentials, settings: { accountName: 'acctname1', container: 'files' } as AzureBlobSettings };
    const check = (overrides: { credentials?: Partial<AzureBlobCredentials>; settings?: Partial<AzureBlobSettings> | Record<string, unknown>; isOnPrem?: boolean } = {}) =>
      Promise.resolve(contract.validateSettings!({
        credentials: { ...base.credentials, ...(overrides.credentials ?? {}) },
        settings: { ...base.settings, ...(overrides.settings ?? {}) } as AzureBlobSettings,
        isOnPrem: overrides.isOnPrem ?? false,
      }));

    it('accepts a working configuration of each method', async () => {
      await expect(check()).resolves.toBeUndefined();
      await expect(check({ credentials: { accountKey: undefined, sasToken: SAS }, settings: { authMethod: 'sas' } })).resolves.toBeUndefined();
      await expect(check({ credentials: { accountKey: undefined, connectionString: `AccountName=acctname1;AccountKey=${KEY}` }, settings: { authMethod: 'connectionString', accountName: undefined } })).resolves.toBeUndefined();
      await expect(check({ credentials: { accountKey: undefined, clientSecret: 'super-secret-value' }, settings: { authMethod: 'entra', entraTenantId: CLIENT, clientId: CLIENT } })).resolves.toBeUndefined();
      expect(state.calls).toEqual([]);
      expect(state.clients).toEqual([]);
    });

    it('names the field of the first problem', async () => {
      const cases: Array<[Parameters<typeof check>[0], string]> = [
        [{ settings: { container: undefined } }, 'container'],
        [{ settings: { container: 'Bad Name' } }, 'container'],
        [{ settings: { accountName: 'x' } }, 'accountName'],
        [{ settings: { prefix: 'a/../b' } }, 'prefix'],
        [{ settings: { apiVersion: 'soon' } }, 'apiVersion'],
        [{ settings: { authMethod: 'kerberos' } }, 'authMethod'],
        [{ settings: { createContainer: 'yes' } }, 'createContainer'],
        [{ settings: { allowInsecureTls: 'false' } }, 'allowInsecureTls'],
        [{ settings: { caCertificate: 'not a certificate' } }, 'caCertificate'],
        [{ credentials: { accountKey: 'short' } }, 'accountKey'],
        [{ credentials: { accountKey: undefined } }, 'authMethod'],
        [{ credentials: { accountKey: undefined }, settings: { authMethod: 'sas' } }, 'sasToken'],
        [{ credentials: { accountKey: undefined, sasToken: 'sv=1' }, settings: { authMethod: 'sas' } }, 'sasToken'],
        [{ credentials: { accountKey: undefined }, settings: { authMethod: 'entra' } }, 'entraTenantId'],
        [{ credentials: { accountKey: undefined, connectionString: 'UseDevelopmentStorage=true' }, settings: { authMethod: 'connectionString' } }, 'connectionString'],
      ];
      for (const [overrides, field] of cases) {
        settingsError(await check(overrides).catch((e) => e), field);
      }
    });

    it('allows plain http and skipping verification on any deployment; Microsoft Entra sign-in still needs https', async () => {
      mode({ DEPLOYMENT_MODE: 'saas' });
      await expect(check({ settings: { endpoint: 'http://93.184.216.34:10000/acctname1' } })).resolves.toBeUndefined();
      await expect(check({ settings: { allowInsecureTls: true } })).resolves.toBeUndefined();
      // plain http does not open a loopback address on SaaS
      const loopback = await check({ settings: { endpoint: 'http://127.0.0.1:10000/acctname1' } }).catch((e) => e);
      expect(loopback).toBeInstanceOf(ProviderEndpointError);
      const entra = { credentials: { accountKey: undefined, clientSecret: 'super-secret-value' }, settings: { authMethod: 'entra', entraTenantId: CLIENT, clientId: CLIENT, endpoint: 'http://93.184.216.34/acctname1' } };
      const entraHttp = await check(entra).catch((e) => e);
      settingsError(entraHttp, 'endpoint');
      expect(entraHttp.message).toBe('Microsoft Entra authentication needs an https endpoint.');
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await expect(check({ settings: { endpoint: 'http://127.0.0.1:10000/acctname1' }, isOnPrem: true })).resolves.toBeUndefined();
      await expect(check({ settings: { allowInsecureTls: true }, isOnPrem: true })).resolves.toBeUndefined();
      settingsError(await check({ ...entra, isOnPrem: true }).catch((e) => e), 'endpoint');
    });

    it('SaaS refuses a private or loopback endpoint, wherever the endpoint was typed', async () => {
      mode({ DEPLOYMENT_MODE: 'saas' });
      for (const endpoint of ['https://127.0.0.1/acctname1', 'https://localhost', 'https://storage.internal.example', 'storage.internal.example']) {
        const error = await check({ settings: { endpoint, accountName: 'acctname1' } }).catch((e) => e);
        expect(error, endpoint).toBeInstanceOf(ProviderEndpointError);
        expect(error.field).toBe('endpoint');
        expect(error.code).toBe('provider_endpoint_not_allowed');
      }
      const viaString = await check({
        credentials: { accountKey: undefined, connectionString: `AccountName=acctname1;AccountKey=${KEY};BlobEndpoint=https://127.0.0.1/acctname1` },
        settings: { authMethod: 'connectionString', accountName: undefined },
      }).catch((e) => e);
      expect(viaString).toBeInstanceOf(ProviderEndpointError);
      expect(viaString.field).toBe('connectionString');
      expect(viaString.message).not.toContain(KEY);
    });

    it('on-prem allows them unless the operator blocks private networks', async () => {
      mode({ DEPLOYMENT_MODE: 'onprem' });
      await expect(check({ settings: { endpoint: 'http://127.0.0.1:10000/acctname1' }, isOnPrem: true })).resolves.toBeUndefined();
      mode({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
      await expect(check({ settings: { endpoint: 'http://127.0.0.1:10000/acctname1' }, isOnPrem: true })).rejects.toBeInstanceOf(ProviderEndpointError);
      mode({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '127.0.0.1' });
      await expect(check({ settings: { endpoint: 'http://127.0.0.1:10000/acctname1' }, isOnPrem: true })).resolves.toBeUndefined();
    });

    it('vets the Microsoft Entra authority, given or implied', async () => {
      const entra = { credentials: { accountKey: undefined, clientSecret: 'super-secret-value' }, settings: { authMethod: 'entra', entraTenantId: CLIENT, clientId: CLIENT } };
      mode({ DEPLOYMENT_MODE: 'saas' });
      const error = await check({ ...entra, settings: { ...entra.settings, authorityHost: 'https://127.0.0.1' } }).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderEndpointError);
      expect(error.field).toBe('authorityHost');
      await expect(check({ ...entra, settings: { ...entra.settings, authorityHost: 'https://login.internal.example' } })).rejects.toBeInstanceOf(ProviderEndpointError);
      await expect(check(entra)).resolves.toBeUndefined();
      await expect(check({ ...entra, settings: { ...entra.settings, endpoint: 'https://acctname1.blob.core.usgovcloudapi.net' } })).resolves.toBeUndefined();
    });
  });

  describe('describeStorageLocation', () => {
    const describe_ = (settings: Record<string, unknown>) =>
      contract.describeStorageLocation!({ settings: settings as AzureBlobSettings, tenantId: 't1', providerKey: 'prov' });

    it('names the container and the provider\'s own prefix, from the settings alone', () => {
      expect(describe_({ accountName: 'acctname1', container: 'files' })).toBe('https://acctname1.blob.core.windows.net/files/t1/prov/');
      expect(describe_({ accountName: 'acctname1', container: 'files', prefix: '/archive/console/' })).toBe('https://acctname1.blob.core.windows.net/files/archive/console/t1/prov/');
      expect(describe_({ endpoint: 'http://127.0.0.1:10000/devstoreaccount1', container: 'files' })).toBe('http://127.0.0.1:10000/devstoreaccount1/files/t1/prov/');
      expect(describe_({ container: 'files' })).toBe('files/t1/prov/');
    });

    it('is null when the settings do not say where the files are', () => {
      expect(describe_({})).toBeNull();
      expect(describe_({ container: 'files', prefix: '../x' })).toBeNull();
    });

    it('does not need the SDK, the network or a credential', () => {
      const text = describe_({ accountName: 'acctname1', container: 'files', accountKey: KEY, sasToken: SAS });
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('sig=');
      expect(state.clients).toEqual([]);
      expect(state.calls).toEqual([]);
    });

    it('agrees with where the runtime really writes', async () => {
      const rt = await create({ prefix: 'archive' }, undefined, 'tenant9');
      const { handle } = await rt.uploadFile({ key: 'x.txt', name: 'x', data: Buffer.from('x') });
      const location = describe_({ accountName: 'acctname1', container: 'files', prefix: 'archive' });
      const expected = `${location!.replace('https://acctname1.blob.core.windows.net/files/', '').replace('t1/', 'tenant9/')}${handle.key}`;
      expect(blobNames()).toEqual([expected]);
    });
  });

  describe('checkConnection', () => {
    const steps = (result: FileConnectionCheck) => result.steps?.map((s) => [s.step, s.ok]);

    it('lists, writes, reads back and deletes, and leaves nothing behind', async () => {
      const rt = await create();
      const result = await rt.checkConnection();
      expect(result).toMatchObject({ ok: true, message: 'Connected to container "files".' });
      expect(steps(result)).toEqual([['list', true], ['write', true], ['read', true], ['delete', true]]);
      expect(state.lists[0]).toMatchObject({ prefix: 't1/prov/', maxPageSize: 1, includeMetadata: false });
      expect(state.written).toHaveLength(1);
      expect(state.written[0]).toMatch(/^t1\/prov\/\.cognipeer-connection-test\/[0-9a-f-]{36}\.txt$/);
      expect(blobNames()).toEqual([]);
      expect(state.calls.slice(0, 2)).toEqual(['list', 'upload']);
    });

    it('proves the name and metadata channel with characters a header cannot carry', async () => {
      const rt = await create();
      state.onCall.set('delete', () => {
        const blob = [...state.containers.get(CONTAINER_URL)!.values()][0];
        expect(blob.metadata.cp_name).toBeDefined();
        expect(decodeURIComponent(blob.metadata.cp_name)).toBe('Bağlantı testi 接続テスト.txt');
        expect(blob.metadata.cp_meta).toMatch(/^b64u:/);
        expect(blob.contentType).toBe('text/plain');
      });
      expect((await rt.checkConnection()).ok).toBe(true);
    });

    it('stays inside the provider\'s own prefix', async () => {
      const rt = await create({ prefix: 'archive' });
      await rt.checkConnection();
      expect(state.written[0].startsWith('archive/t1/prov/.cognipeer-connection-test/')).toBe(true);
      expect(state.lists[0].prefix).toBe('archive/t1/prov/');
    });

    it('lists only when asked not to write', async () => {
      state.containers.set(CONTAINER_URL, new Map());
      const rt = await create();
      const result = await rt.checkConnection({ write: false });
      expect(result).toMatchObject({ ok: true, message: 'Connected to container "files" (listing only).' });
      expect(steps(result)).toEqual([['list', true]]);
      expect(state.calls).toEqual(['list']);
    });

    it('a container that is not there yet is created by the write when the provider is set to create it', async () => {
      const rt = await create({ createContainer: true });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(true);
      expect(result.steps?.[0]).toMatchObject({ step: 'list', ok: true, message: 'The container is created on the first upload.' });
      expect(state.calls.filter((c) => c === 'createContainer')).toHaveLength(1);
      expect(state.containers.has(CONTAINER_URL)).toBe(true);
    });

    it('does not create it when only listing', async () => {
      const rt = await create({ createContainer: true });
      const result = await rt.checkConnection({ write: false });
      expect(result.ok).toBe(true);
      expect(result.message).toBe('Connected to storage account "acctname1"; the container "files" is created on the first upload.');
      expect(state.containers.size).toBe(0);
    });

    it('a container that is not there is the configuration problem it is, and nothing is written', async () => {
      const rt = await create({ createContainer: false });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toBe('The container "files" is missing in storage account "acctname1". Create it or enable "Create container if missing".');
      expect(steps(result)).toEqual([['list', false]]);
      expect(state.calls).toEqual(['list']);
    });

    it('does not create a container that exists, nor ask for one', async () => {
      state.containers.set(CONTAINER_URL, new Map());
      const rt = await create({ createContainer: false });
      expect((await rt.checkConnection()).ok).toBe(true);
      expect(state.calls).not.toContain('createContainer');
    });

    it('a SAS without the list permission reports the list and still tries to write, read and delete', async () => {
      state.containers.set(CONTAINER_URL, new Map());
      const rt = await create({ authMethod: 'sas', createContainer: false }, { sasToken: SAS });
      state.failNext.set('list', restError(403, 'AuthorizationPermissionMismatch', 'This request is not authorized to perform this operation using this permission.'));
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', false], ['write', true], ['read', true], ['delete', true]]);
      expect(result.steps?.[0].message).toContain('l (list)');
      expect(result.message).toContain('Writing, reading and deleting still work.');
      expect(result.message).not.toContain(SAS_SIG);
      expect(blobNames()).toEqual([]);
    });

    it('stops at a list that failed for any other reason', async () => {
      const rt = await create();
      for (const failure of [
        restError(403, 'AuthenticationFailed', 'denied'),
        restError(403, 'KeyBasedAuthenticationNotPermitted', 'off'),
        restError(503, 'ServerBusy', 'busy'),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { name: 'RestError', code: 'ECONNREFUSED' }),
      ]) {
        state.calls.length = 0;
        state.failNext.set('list', failure);
        const result = await rt.checkConnection();
        expect(result.ok).toBe(false);
        expect(steps(result)).toEqual([['list', false]]);
        expect(state.calls).toEqual(['list']);
      }
    });

    it('says in the words of the service what is wrong with the credentials', async () => {
      const rt = await create();
      state.failNext.set('list', restError(403, 'KeyBasedAuthenticationNotPermitted', 'Key based authentication is not permitted on this storage account.'));
      expect((await rt.checkConnection()).message).toBe('Key-based access is turned off for this storage account. Use a SAS token or Microsoft Entra ID.');
    });

    it('reports a failed write and does not go on to read or delete', async () => {
      const rt = await create();
      state.failNext.set('upload', restError(403, 'AuthorizationPermissionMismatch', 'not authorized'));
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', true], ['write', false]]);
      expect(result.steps?.[1].message).toContain('"upload"');
      expect(state.calls).not.toContain('download');
      expect(state.calls).not.toContain('delete');
    });

    it('reports a body that came back different, still deletes the object, and names the step', async () => {
      const rt = await create();
      state.download = { chunks: () => [Buffer.from('somebody else wrote this')], contentLength: null };
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', true], ['write', true], ['read', false], ['delete', true]]);
      expect(result.steps?.[2].message).toBe('The test object came back with different content than was written.');
      expect(blobNames()).toEqual([]);
    });

    it('reports a name or metadata that did not survive the round trip', async () => {
      const rt = await create();
      state.onCall.set('head', () => {
        for (const blob of state.containers.get(CONTAINER_URL)!.values()) blob.metadata = { cp_name: 'plain.txt' };
      });
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(result.steps?.find((s) => s.step === 'read')?.message).toBe('The file name of the test object did not survive the round trip.');
      expect(steps(result)?.at(-1)).toEqual(['delete', true]);
    });

    it('passes when only the delete failed, and says what is missing and which test file stays behind', async () => {
      const rt = await create();
      state.failNext.set('delete', restError(403, 'AuthorizationPermissionMismatch', 'no delete'));
      const result = await rt.checkConnection();
      // writing and reading work, so the connection does; the failed step and the message carry the rest
      expect(result.ok).toBe(true);
      expect(steps(result)).toEqual([['list', true], ['write', true], ['read', true], ['delete', false]]);
      expect(result.message).toMatch(/^Connected to container "files"\. Removing the test file failed\. /);
      expect(result.message).toContain('d (delete)');
      const left = blobNames();
      expect(left).toHaveLength(1);
      const relative = left[0].slice('t1/prov/'.length);
      expect(relative).toMatch(/^\.cognipeer-connection-test\/[0-9a-f-]{36}\.txt$/);
      expect(result.steps?.[3].message).toMatch(/\.$/);
      expect(result.steps?.[3].message).toContain(`The test file "${relative}" stays in the container.`);
      expect(result.message).toContain(`The test file "${relative}" stays in the container.`);
      expect(result.message).not.toMatch(/\.\./);
    });

    it('still fails when something besides the delete failed', async () => {
      state.containers.set(CONTAINER_URL, new Map());
      const rt = await create({ authMethod: 'sas', createContainer: false }, { sasToken: SAS });
      // a SAS with neither list nor delete: the list is a gap and the test goes on, but the check is not a pass
      state.failNext.set('list', restError(403, 'AuthorizationPermissionMismatch', 'no list'));
      state.failNext.set('delete', restError(403, 'AuthorizationPermissionMismatch', 'no delete'));
      const result = await rt.checkConnection();
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', false], ['write', true], ['read', true], ['delete', false]]);
      expect(result.message).toContain('l (list)');
      expect(result.message).not.toContain('Writing, reading and deleting still work.');
      expect(result.message).not.toContain(SAS_SIG);
    });

    it('never throws, whatever it is thrown at', async () => {
      const rt = await create();
      for (const failure of [42, 'text', {}, new Error('plain'), Object.assign(new Error('x'), { statusCode: 500 })]) {
        state.failNext.set('list', failure);
        const result = await rt.checkConnection();
        expect(result.ok).toBe(false);
        expect(typeof result.message).toBe('string');
        expect(result.steps?.[0]).toMatchObject({ step: 'list', ok: false });
      }
    });

    it('never puts a credential into a step or a message', async () => {
      const rt = await create({ authMethod: 'sas', createContainer: false }, { sasToken: SAS });
      state.containers.set(CONTAINER_URL, new Map());
      state.failNext.set('list', Object.assign(new Error(`GET https://acctname1.blob.core.windows.net/files?${SAS} failed`), { name: 'RestError', code: 'REQUEST_SEND_ERROR' }));
      const result = await rt.checkConnection();
      expect(JSON.stringify(result)).not.toContain(SAS_SIG);
      expect(JSON.stringify(result)).not.toContain('ab+cdefgh=');
      expect(JSON.stringify(logs)).not.toContain(SAS_SIG);
    });

    it('stops when the caller\'s time limit has passed', async () => {
      const rt = await create();
      const controller = new AbortController();
      controller.abort();
      const result = await rt.checkConnection({ signal: controller.signal });
      expect(result).toMatchObject({ ok: false, message: 'The connection test was cancelled.', steps: [] });
      expect(state.calls).toEqual([]);
    });

    it('stops at the caller\'s time limit in the middle, and still removes the object it wrote', async () => {
      const rt = await create();
      const controller = new AbortController();
      state.onCall.set('download', () => controller.abort());
      const result = await rt.checkConnection({ signal: controller.signal });
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', true], ['write', true], ['read', false], ['delete', false]]);
      expect(result.steps?.[2].message).toBe('Azure Blob Storage did not answer in time (download).');
      // the delete that the time limit cut short is cleaned up afterwards: nothing is claimed to stay behind
      expect(result.steps?.[3].message).not.toContain('stays in the container');
      expect(blobNames()).toEqual([]);
    });

    it('is not a pass when the caller\'s time limit cut the delete short, and the test file is still removed', async () => {
      const rt = await create();
      const controller = new AbortController();
      state.onCall.set('delete', () => controller.abort());
      const result = await rt.checkConnection({ signal: controller.signal });
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', true], ['write', true], ['read', true], ['delete', false]]);
      expect(result.steps?.[3].message).not.toContain('stays in the container');
      expect(blobNames()).toEqual([]);
    });

    it('a stalled service ends the check at the caller\'s limit', async () => {
      const rt = await create();
      state.containers.set(CONTAINER_URL, new Map());
      state.delayMs = 60_000;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      const result = await rt.checkConnection({ signal: controller.signal });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.ok).toBe(false);
      expect(steps(result)).toEqual([['list', false]]);
    });
  });

  describe('credentials that stop working, and text that carries them', () => {
    const entraSettings = { authMethod: 'entra', endpoint: 'https://acctname1.blob.core.windows.net', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT, createContainer: false };

    it('names the expiry of a SAS that ran out while the runtime was cached, where an emulator only says "refused"', async () => {
      const rt = await create({ authMethod: 'sas', createContainer: false }, { sasToken: SAS });
      state.containers.set(CONTAINER_URL, new Map());
      expect((await rt.listFiles()).items).toEqual([]);
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
      try {
        state.failNext.set('list', restError(403, 'AuthorizationFailure', 'This request is not authorized to perform this operation.'));
        const error = await rt.listFiles().catch((e) => e);
        expect(error).toBeInstanceOf(AzureBlobError);
        expect(error.message).toBe('Azure rejected the SAS token: it expired on 2099-01-01T00:00:00.000Z. Create a new one and replace it in the provider settings.');
        expect(error).toMatchObject({ statusCode: 403, retryable: false });
        expect(error.message).not.toContain(SAS_SIG);
        // the same through the service's own code
        state.failNext.set('list', restError(403, 'AuthenticationFailed', 'Server failed to authenticate the request.'));
        expect((await rt.listFiles().catch((e) => e)).message).toContain('it expired on 2099-01-01T00:00:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does the same for a SAS inside a connection string, and says when one has not started yet', async () => {
      const token = 'sv=2022-11-02&sr=c&sp=racwdl&st=2098-01-01T00:00:00Z&se=2099-01-01T00:00:00Z&sig=ab%2Bcdefgh%3D';
      const rt = await create({ authMethod: 'sas', createContainer: false }, { sasToken: token });
      state.containers.set(CONTAINER_URL, new Map());
      state.failNext.set('list', restError(403, 'AuthorizationFailure', 'not authorized'));
      const early = await rt.listFiles().catch((e) => e);
      expect(early.message).toBe('Azure rejected the SAS token: it is not valid before 2098-01-01T00:00:00.000Z. Check the start time of the SAS and the clock of this server.');

      const viaString = await create(
        { authMethod: 'connectionString', createContainer: false },
        { connectionString: `BlobEndpoint=https://acctname1.blob.core.windows.net;SharedAccessSignature=${token}` },
      );
      state.failNext.set('list', restError(403, 'AuthorizationFailure', 'not authorized'));
      expect((await viaString.listFiles().catch((e) => e)).message).toContain('it is not valid before 2098-01-01T00:00:00.000Z');
    });

    it('keeps the firewall sentence for a SAS that is inside its window, and for every other kind of credential', async () => {
      const rt = await create({ authMethod: 'sas', createContainer: false }, { sasToken: SAS });
      state.containers.set(CONTAINER_URL, new Map());
      state.failNext.set('list', restError(403, 'AuthorizationFailure', 'not authorized'));
      expect((await rt.listFiles().catch((e) => e)).message).toMatch(/firewall/);
      const keyed = await create({ createContainer: false });
      state.containers.set(CONTAINER_URL, new Map());
      state.failNext.set('list', restError(403, 'AuthorizationFailure', 'not authorized'));
      expect((await keyed.listFiles().catch((e) => e)).message).toMatch(/firewall/);
    });

    it('tells what to check for the kind of credential that was sent when the service gives no detail', async () => {
      const cases: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
        [{ createContainer: false }, { accountKey: KEY }, /^Azure rejected the credentials \(AuthenticationFailed\): check the account name and key\.$/],
        [{ authMethod: 'sas', createContainer: false }, { sasToken: SAS }, /^Azure rejected the credentials \(AuthenticationFailed\): check the SAS signature and validity window\.$/],
        [entraSettings, { clientSecret: 'a-client-secret-value' }, /^Azure rejected the credentials \(AuthenticationFailed\): the Microsoft Entra token was not accepted; check the authority host, the tenant ID and the clock of this server\.$/],
      ];
      for (const [settings, credentials, expected] of cases) {
        const rt = await create(settings, credentials);
        state.containers.set(CONTAINER_URL, new Map());
        state.failNext.set('list', restError(403, 'AuthenticationFailed', 'Server failed to authenticate the request.'));
        expect((await rt.listFiles().catch((e) => e)).message).toMatch(expected);
      }
    });

    it('points at the configured API version when the service rejects a header', async () => {
      const rt = await create({ apiVersion: '2099-01-01' });
      state.failNext.set('upload', restError(400, 'InvalidHeaderValue', 'The value for one of the HTTP headers is not in the correct format.'));
      const error = await rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e);
      expect(error.message).toBe('The service rejected a request header (The value for one of the HTTP headers is not in the correct format). If it names the API version, this service may not support 2099-01-01: change or clear "API version" in the provider settings.');
      const plain = await create();
      state.failNext.set('upload', restError(400, 'InvalidHeaderValue', 'The value for one of the HTTP headers is not in the correct format.'));
      expect((await plain.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }).catch((e) => e)).message).toContain('set "API version" in the provider settings');
    });

    it('takes the client secret out of an error that already is one of ours, whoever echoed it', async () => {
      const secret = 'Cl13nt~Secret-value-1234';
      const rt = await create(entraSettings, { clientSecret: secret });
      state.containers.set(CONTAINER_URL, new Map());
      const echoed = () => new AzureBlobError(`Microsoft Entra rejected the service principal (invalid_client): Bad credentials ${secret} for ${CLIENT} (${encodeURIComponent(secret)})`, { statusCode: 401, code: 'EntraTokenRequestFailed' });
      state.failNext.set('list', echoed());
      const error = await rt.listFiles().catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ statusCode: 401, code: 'EntraTokenRequestFailed', retryable: false });
      expect(error.message).toBe(`Microsoft Entra rejected the service principal (invalid_client): Bad credentials [redacted] for ${CLIENT} ([redacted])`);

      state.failNext.set('list', echoed());
      const check = await rt.checkConnection();
      expect(JSON.stringify(check)).not.toContain('Cl13nt');
      expect(JSON.stringify(check)).not.toContain(encodeURIComponent(secret));
      expect(check.steps?.[0].message).toContain('[redacted]');
      expect(JSON.stringify(logs)).not.toContain('Cl13nt');
    });

    it('leaves an error of ours without a credential in it as it is (same object)', async () => {
      const rt = await create();
      const failure = new AzureBlobError('The container is unavailable.', { statusCode: 503, code: 'ServerBusy' });
      state.containers.set(CONTAINER_URL, new Map());
      state.failNext.set('list', failure);
      expect(await rt.listFiles().catch((e) => e)).toBe(failure);
    });
  });
});
