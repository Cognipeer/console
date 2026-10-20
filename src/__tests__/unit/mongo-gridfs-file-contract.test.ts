/**
 * Unit tests — MongoDB GridFS File Provider Contract (mongodb-memory-server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { MongoGridFsFileProviderContract } from '@/lib/providers/contracts/mongoGridFsFiles.contract';
import type { FileProviderRuntime } from '@/lib/providers/domains/file';
import { isStorageInvalidKeyError } from '@/lib/providers/contracts/storageLimits';
import { isTransientStorageError } from '@/lib/services/files/fileService';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';

function deployment(overrides: Record<string, string>) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}

const MONGO_AVAILABLE: boolean = (() => {
  try {
    createRequire(import.meta.url).resolve('mongodb-memory-server');
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(MONGO_AVAILABLE)('MongoGridFsFileProviderContract', () => {
  let server: { getUri(): string; stop(): Promise<boolean> };
  let runtime: FileProviderRuntime;
  let other: FileProviderRuntime;
  const original = getConfigSource();

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    server = await MongoMemoryServer.create();
    // The test server is on loopback: a self-hosted install, where an in-network database is what this driver is for.
    deployment({ DEPLOYMENT_MODE: 'onprem' });
    const base = { credentials: { uri: server.getUri() }, settings: { database: 'test_files' } };
    runtime = await MongoGridFsFileProviderContract.createRuntime({ tenantId: 't1', providerKey: 'p', ...base });
    other = await MongoGridFsFileProviderContract.createRuntime({ tenantId: 't2', providerKey: 'p', ...base });
  });

  afterAll(async () => {
    setConfigSource(original);
    await server?.stop();
  });

  it('declares the file domain', () => {
    expect(MongoGridFsFileProviderContract.id).toBe('mongodb-gridfs-files');
    expect(MongoGridFsFileProviderContract.domains).toContain('file');
  });

  it('round-trips content, type and metadata', async () => {
    const data = Buffer.from('hello gridfs');
    const { handle } = await runtime.uploadFile({
      key: 'docs/a.txt', name: 'a.txt', contentType: 'text/plain', data, metadata: { src: 'x' },
    });
    expect(handle.key).toBe('docs/a.txt');
    const dl = await runtime.downloadFile('docs/a.txt');
    expect(dl.data.toString()).toBe('hello gridfs');
    expect(dl.contentType).toBe('text/plain');
    expect(dl.metadata).toEqual({ src: 'x' });
    expect((await runtime.getFileMetadata('docs/a.txt'))?.size).toBe(data.length);
  });

  it('overwrites a key instead of keeping revisions', async () => {
    await runtime.uploadFile({ key: 'o.txt', name: 'o', data: Buffer.from('one') });
    await runtime.uploadFile({ key: 'o.txt', name: 'o', data: Buffer.from('two') });
    expect((await runtime.downloadFile('o.txt')).data.toString()).toBe('two');
    const listed = await runtime.listFiles({ prefix: 'o.txt' });
    expect(listed.items).toHaveLength(1);
  });

  it('lists with prefix and cursor pagination', async () => {
    for (const k of ['p/1', 'p/2', 'p/3']) {
      await runtime.uploadFile({ key: k, name: k, data: Buffer.from(k) });
    }
    const first = await runtime.listFiles({ prefix: 'p', limit: 2 });
    expect(first.items.map((i) => i.key)).toEqual(['p/1', 'p/2']);
    expect(first.nextCursor).toBe('p/2');
    const second = await runtime.listFiles({ prefix: 'p', limit: 2, cursor: first.nextCursor });
    expect(second.items.map((i) => i.key)).toEqual(['p/3']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('reads the prefix as text with its trailing slash dropped: a folder name also lists the names that merely start with it', async () => {
    for (const k of ['dir/a.txt', 'dir-other/c.txt', 'dirx.txt', 'other/z.txt']) {
      await runtime.uploadFile({ key: k, name: k, data: Buffer.from(k) });
    }
    const keys = async (prefix: string) => (await runtime.listFiles({ prefix })).items.map((i) => i.key);
    expect(await keys('dir/')).toEqual(['dir-other/c.txt', 'dir/a.txt', 'dirx.txt']);
    expect(await keys('dir')).toEqual(['dir-other/c.txt', 'dir/a.txt', 'dirx.txt']);
  });

  it('deletes files and returns null metadata afterwards', async () => {
    await runtime.uploadFile({ key: 'd.txt', name: 'd', data: Buffer.from('x') });
    await runtime.deleteFile('d.txt');
    expect(await runtime.getFileMetadata('d.txt')).toBeNull();
    await expect(runtime.downloadFile('d.txt')).rejects.toThrow(/not found/i);
  });

  it('reports a missing key as a 404, which is no storage outage', async () => {
    await expect(runtime.downloadFile('never-uploaded.txt')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('isolates tenants', async () => {
    await runtime.uploadFile({ key: 'iso.txt', name: 'iso', data: Buffer.from('x') });
    expect(await other.getFileMetadata('iso.txt')).toBeNull();
    expect((await other.listFiles()).items.find((i) => i.key === 'iso.txt')).toBeUndefined();
  });

  it('rejects empty keys and cannot escape the tenant prefix', async () => {
    await expect(runtime.downloadFile('/')).rejects.toThrow(/Invalid file key/);
    await other.uploadFile({ key: 'x', name: 'x', data: Buffer.from('secret') });
    await expect(runtime.downloadFile('../../t2/p/x')).rejects.toThrow(/not found/i);
  });

  it('makes a key for an upload without one: a readable stem with no dash at either end, and the extension', async () => {
    const make = async (name: string) => (await runtime.uploadFile({ name, data: Buffer.from('x') })).handle.key;
    expect(await make('report.pdf')).toMatch(/^report-\d+-[0-9a-f]{8}\.pdf$/);
    expect(await make('(final).pdf')).toMatch(/^final-\d+-[0-9a-f]{8}\.pdf$/);
    expect(await make('日本語.txt')).toMatch(/^file-\d+-[0-9a-f]{8}\.txt$/);
    expect(await make('-lead.txt')).toMatch(/^lead-\d+-[0-9a-f]{8}\.txt$/);
  });

  it('refuses a key it cannot store with the typed, non-retryable error: the caller\'s to change, no outage', async () => {
    const error = await runtime.uploadFile({ key: '///', name: 'x', data: Buffer.from('x') }).then(() => null, (reason: unknown) => reason);
    expect(isStorageInvalidKeyError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'invalid_key', statusCode: 400, retryable: false, message: 'Invalid file key provided.' });
    expect(isTransientStorageError(error)).toBe(false);
  });

  it('refuses a key with an unpaired surrogate instead of storing it under a name of U+FFFD', async () => {
    const key = 'docs/a\ud800b.txt';
    const expected = { code: 'invalid_key', statusCode: 400, retryable: false, message: /^Invalid file key provided: it holds a character that has no UTF-8 form/ };
    await expect(runtime.uploadFile({ key, name: 'x', data: Buffer.from('x') })).rejects.toMatchObject(expected);
    await expect(runtime.downloadFile(key)).rejects.toMatchObject(expected);
    await expect(runtime.getFileMetadata(key)).rejects.toMatchObject(expected);
    await expect(runtime.listFiles({ prefix: key })).rejects.toMatchObject(expected);
  });

  describe('on SaaS', () => {
    it('does not connect to a database a tenant names when it is on a private network', async () => {
      deployment({ DEPLOYMENT_MODE: 'saas' });
      try {
        await expect(MongoGridFsFileProviderContract.createRuntime({
          tenantId: 't1', providerKey: 'p', credentials: { uri: server.getUri() }, settings: {},
        })).rejects.toBeInstanceOf(ProviderEndpointError);
      } finally {
        deployment({ DEPLOYMENT_MODE: 'onprem' });
      }
    });

    it("keeps using the application's own connection when the URI is left empty", async () => {
      deployment({ DEPLOYMENT_MODE: 'saas', DB_PROVIDER: 'mongodb', MONGODB_URI: server.getUri() });
      try {
        const own = await MongoGridFsFileProviderContract.createRuntime({
          tenantId: 't3', providerKey: 'p', credentials: {}, settings: { database: 'test_files' },
        });
        await own.uploadFile({ key: 'own.txt', name: 'own', data: Buffer.from('app connection') });
        expect((await own.downloadFile('own.txt')).data.toString()).toBe('app connection');
      } finally {
        deployment({ DEPLOYMENT_MODE: 'onprem' });
      }
    });
  });
});
