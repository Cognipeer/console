/**
 * A download is handed back as one Buffer, so the disk driver and the GridFS driver refuse an object that is larger
 * than the server reads into memory at once (`maxStorageDownloadBytes`) instead of reading it to the end: an object
 * put in the folder by another tool can be of any size, and "Import from storage" registers it as it is.
 *
 * The ceiling is made small here (1 MiB). The S3 and Azure Blob drivers are held to the same ceiling in their own
 * tests (`s3-compatible-files-download-ceiling`, `azure-blob-support`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, promises as fsPromises, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { LocalFileProviderContract } from '@/lib/providers/contracts/localFile.contract';
import { MongoGridFsFileProviderContract } from '@/lib/providers/contracts/mongoGridFsFiles.contract';
import type { FileProviderRuntime } from '@/lib/providers/domains/file';

vi.mock('@/lib/providers/contracts/storageLimits', () => {
  class StorageObjectTooLargeError extends Error {
    readonly code = 'object_too_large';

    readonly retryable = false;

    constructor(limitBytes: number) {
      super(`The object is larger than the ${Math.round(limitBytes / (1024 * 1024))} MB this server reads into memory at once.`);
      this.name = 'StorageObjectTooLargeError';
    }
  }
  return {
    maxStorageDownloadBytes: () => 1024 * 1024,
    StorageObjectTooLargeError,
    isStorageObjectTooLargeError: (error: unknown) => error instanceof StorageObjectTooLargeError,
  };
});

const MIB = 1024 * 1024;
const TOO_LARGE = 'The object is larger than the 1 MB this server reads into memory at once.';

async function failureOf(run: () => Promise<unknown>): Promise<Error & { code?: string; retryable?: boolean }> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to fail');
}

describe('the disk driver', () => {
  let dir: string;
  let runtime: FileProviderRuntime;

  const put = (key: string, content: Buffer | string) => {
    const target = path.join(dir, 'tenant-1', 'disk', ...key.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'local-ceiling-'));
    runtime = await LocalFileProviderContract.createRuntime({ tenantId: 'tenant-1', providerKey: 'disk', credentials: {}, settings: { basePath: dir } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an object up to the ceiling', async () => {
    const data = Buffer.alloc(MIB, 'a');
    put('docs/exact.bin', data);

    const result = await runtime.downloadFile('docs/exact.bin');

    expect(result.data.equals(data)).toBe(true);
    expect(result.size).toBe(MIB);
  });

  it('refuses an object over the ceiling without reading it, with a sentence that is safe to show', async () => {
    // A sparse file: it takes no room on the disk.
    const target = put('docs/huge.bin', '');
    truncateSync(target, MIB + 1);
    const read = vi.spyOn(fsPromises, 'readFile');

    const error = await failureOf(() => runtime.downloadFile('docs/huge.bin'));

    expect(error).toMatchObject({ name: 'StorageObjectTooLargeError', code: 'object_too_large', retryable: false, message: TOO_LARGE });
    expect(error.message).not.toContain(dir);
    expect(read).not.toHaveBeenCalled();
  });

  it('still reports an object that is not there as missing', async () => {
    const error = await failureOf(() => runtime.downloadFile('docs/nowhere.bin'));

    expect(error).toMatchObject({ code: 'ENOENT' });
  });
});

const MONGO_AVAILABLE: boolean = (() => {
  try {
    createRequire(import.meta.url).resolve('mongodb-memory-server');
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(MONGO_AVAILABLE)('the GridFS driver', () => {
  let server: { getUri(): string; stop(): Promise<boolean> };
  let runtime: FileProviderRuntime;
  const original = getConfigSource();
  const DATABASE = 'ceiling_files';
  const BUCKET = 'ceil';

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    server = await MongoMemoryServer.create();
    // The test server is on loopback: a self-hosted install, where an in-network database is what this driver is for.
    setConfigSource({ get: (k: string) => ({ DEPLOYMENT_MODE: 'onprem' } as Record<string, string>)[k] ?? process.env[k] } as ConfigSource);
    runtime = await MongoGridFsFileProviderContract.createRuntime({
      tenantId: 't1',
      providerKey: 'p',
      credentials: { uri: server.getUri() },
      settings: { database: DATABASE, bucketName: BUCKET },
    });
  });

  afterAll(async () => {
    setConfigSource(original);
    await server?.stop();
  });

  it('reads an object up to the ceiling', async () => {
    const data = Buffer.alloc(MIB, 'g');
    await runtime.uploadFile({ key: 'exact.bin', name: 'exact.bin', data });

    const result = await runtime.downloadFile('exact.bin');

    expect(result.data.equals(data)).toBe(true);
    expect(result.size).toBe(MIB);
  });

  it('refuses an object whose size is over the ceiling, with a sentence that is safe to show', async () => {
    await runtime.uploadFile({ key: 'huge.bin', name: 'huge.bin', data: Buffer.alloc(MIB + 1, 'g') });

    const error = await failureOf(() => runtime.downloadFile('huge.bin'));

    expect(error).toMatchObject({ name: 'StorageObjectTooLargeError', code: 'object_too_large', retryable: false, message: TOO_LARGE });
  });

  it('does not hand back an object whose file document understates what is stored: the read fails, it does not run on', async () => {
    await runtime.uploadFile({ key: 'liar.bin', name: 'liar.bin', data: Buffer.alloc(MIB + 1, 'g') });
    // The document is the writer's claim: make it understate what is really stored.
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(server.getUri());
    try {
      await client.connect();
      const result = await client.db(DATABASE).collection(`${BUCKET}.files`).updateMany({ filename: { $regex: 'liar\\.bin$' } }, { $set: { length: 10 } });
      expect(result.modifiedCount).toBe(1);
    } finally {
      await client.close();
    }

    await expect(runtime.downloadFile('liar.bin')).rejects.toThrow();
  });

  it('still reports an object that is not there as missing', async () => {
    const error = await failureOf(() => runtime.downloadFile('nowhere.bin'));

    expect(error).toMatchObject({ statusCode: 404 });
  });
});
