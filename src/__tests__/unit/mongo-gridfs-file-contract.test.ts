/**
 * Unit tests — MongoDB GridFS File Provider Contract (mongodb-memory-server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { MongoGridFsFileProviderContract } from '@/lib/providers/contracts/mongoGridFsFiles.contract';
import type { FileProviderRuntime } from '@/lib/providers/domains/file';

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

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    server = await MongoMemoryServer.create();
    const base = { credentials: { uri: server.getUri() }, settings: { database: 'test_files' } };
    runtime = await MongoGridFsFileProviderContract.createRuntime({ tenantId: 't1', providerKey: 'p', ...base });
    other = await MongoGridFsFileProviderContract.createRuntime({ tenantId: 't2', providerKey: 'p', ...base });
  });

  afterAll(async () => {
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

  it('deletes files and returns null metadata afterwards', async () => {
    await runtime.uploadFile({ key: 'd.txt', name: 'd', data: Buffer.from('x') });
    await runtime.deleteFile('d.txt');
    expect(await runtime.getFileMetadata('d.txt')).toBeNull();
    await expect(runtime.downloadFile('d.txt')).rejects.toThrow(/not found/i);
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
});
