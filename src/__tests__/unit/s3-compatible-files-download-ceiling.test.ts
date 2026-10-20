/**
 * A download is returned as one Buffer, so an object far larger than anything the console accepts is refused instead
 * of being read to the end. The ceiling is made small here (1 MiB) to exercise both ways it can be hit: the store
 * announces the size up front, or it streams without saying (chunked) and the reader stops at the limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import { isS3OperationError, type S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import type { S3FileRuntime } from '@/lib/providers/contracts/s3/s3FileRuntime';
import { startFakeS3, type FakeS3, type FakeS3Options } from '../helpers/fakeS3Server';

vi.mock('@/lib/providers/contracts/storageLimits', () => ({ maxStorageDownloadBytes: () => 1024 * 1024 }));

const MIB = 1024 * 1024;
const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-secret-secret' };
const original = getConfigSource();
const servers: FakeS3[] = [];
const runtimes: S3FileRuntime[] = [];

beforeEach(() => {
  setConfigSource({ get: (key: string) => ({ DEPLOYMENT_MODE: 'onprem' } as Record<string, string>)[key] ?? process.env[key] } as ConfigSource);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setConfigSource(original);
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const server of servers.splice(0)) await server.close();
});

async function storeWith(object: Buffer, options: FakeS3Options = {}): Promise<{ server: FakeS3; runtime: S3FileRuntime }> {
  const server = await startFakeS3({ buckets: ['bkt3'], ...options });
  servers.push(server);
  server.seed('bkt3', 'tenant1/minio-main/big.bin', object, { contentType: 'application/octet-stream' });
  const runtime = (await S3CompatibleFileProviderContract.createRuntime({
    tenantId: 'tenant1',
    providerKey: 'minio-main',
    credentials,
    settings: { endpoint: server.url, bucket: 'bkt3' },
  })) as S3FileRuntime;
  runtimes.push(runtime);
  return { server, runtime };
}

async function failureOf(run: () => Promise<unknown>): Promise<S3OperationError> {
  try {
    await run();
  } catch (error) {
    expect(isS3OperationError(error), error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toBe(true);
    return error as S3OperationError;
  }
  throw new Error('expected the call to fail');
}

describe('the download ceiling', () => {
  it('reads an object up to the ceiling', async () => {
    const data = Buffer.alloc(MIB, 'a');
    const { runtime } = await storeWith(data);
    const result = await runtime.downloadFile('big.bin');
    expect(result.data.equals(data)).toBe(true);
    expect(result.size).toBe(MIB);
  });

  it('refuses an object whose announced size is over the ceiling, without reading it', async () => {
    const { runtime } = await storeWith(Buffer.alloc(MIB + 1, 'a'));
    const error = await failureOf(() => runtime.downloadFile('big.bin'));
    expect(error).toMatchObject({ code: 'object_too_large', retryable: false });
    expect(error.statusCode).toBeUndefined();
    expect(error.message).toBe('The object is larger than the 1 MB this server reads into memory at once.');
  });

  it('does not read a byte of the body when the announced size is over the ceiling: the stream is let go', async () => {
    const { runtime } = await storeWith(Buffer.from('x'));
    const destroy = vi.fn();
    const unread = () => { throw new Error('the body of an object over the ceiling must not be read'); };
    const body = { destroy, [Symbol.asyncIterator]: unread, transformToByteArray: unread, arrayBuffer: unread };
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ ContentLength: MIB + 1, Body: body } as never);

    const error = await failureOf(() => runtime.downloadFile('big.bin'));

    expect(error).toMatchObject({ code: 'object_too_large', retryable: false });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('stops a stream that does not announce its size once it passes the ceiling', async () => {
    const { runtime } = await storeWith(Buffer.alloc(3 * MIB, 'a'), { noContentLength: true });
    const error = await failureOf(() => runtime.downloadFile('big.bin'));
    expect(error).toMatchObject({ code: 'object_too_large', retryable: false });
  });

  it('reads a stream that does not announce its size when it fits', async () => {
    const data = Buffer.from('chunked and small');
    const { runtime } = await storeWith(data, { noContentLength: true });
    const result = await runtime.downloadFile('big.bin');
    expect(result.data.equals(data)).toBe(true);
    expect(result.size).toBe(data.length);
  });

  it('does not use the wording the file routes read as a missing file', async () => {
    const { runtime } = await storeWith(Buffer.alloc(MIB + 1, 'a'));
    const error = await failureOf(() => runtime.downloadFile('big.bin'));
    expect(error.message).not.toMatch(/not found|does not exist/i);
  });

  it('keeps the connection usable after refusing one object', async () => {
    const { server, runtime } = await storeWith(Buffer.alloc(3 * MIB, 'a'), { noContentLength: true });
    server.seed('bkt3', 'tenant1/minio-main/small.txt', 'small');
    await failureOf(() => runtime.downloadFile('big.bin'));
    await expect(runtime.downloadFile('small.txt')).resolves.toMatchObject({ size: 5 });
    await expect(runtime.listFiles()).resolves.toMatchObject({ items: expect.any(Array) });
  });
});

describe('a bound the caller states', () => {
  // A caller that reads objects of its own, which the upload limit never applied to (a sandbox volume), says how much
  // it can hold. The ceiling above is made 1 MiB in this file.
  it('replaces the ceiling: an object over it is read when the caller allows it', async () => {
    const data = Buffer.alloc(2 * MIB, 'a');
    const { runtime } = await storeWith(data);

    expect(await failureOf(() => runtime.downloadFile('big.bin'))).toMatchObject({ code: 'object_too_large' });
    const result = await runtime.downloadFile('big.bin', { maxBytes: 4 * MIB });

    expect(result.data.equals(data)).toBe(true);
    expect(result.size).toBe(2 * MIB);
  });

  it('refuses an object over the bound, although the ceiling would let it through, without reading it', async () => {
    const { runtime } = await storeWith(Buffer.from('x'));
    const destroy = vi.fn();
    const unread = () => { throw new Error('the body of an object over the bound must not be read'); };
    const body = { destroy, [Symbol.asyncIterator]: unread, transformToByteArray: unread, arrayBuffer: unread };
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ ContentLength: 3 * MIB, Body: body } as never);

    const error = await failureOf(() => runtime.downloadFile('big.bin', { maxBytes: 2 * MIB }));

    expect(error).toMatchObject({ code: 'object_too_large', retryable: false });
    expect(error.message).toBe('The object is larger than the 2 MB this server reads into memory at once.');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('reads an object that is exactly the bound, and refuses one byte more', async () => {
    const data = Buffer.alloc(MIB / 2, 'e');
    const { server, runtime } = await storeWith(data);
    server.seed('bkt3', 'tenant1/minio-main/over.bin', Buffer.alloc(MIB / 2 + 1, 'o'));

    expect((await runtime.downloadFile('big.bin', { maxBytes: MIB / 2 })).data.equals(data)).toBe(true);
    expect(await failureOf(() => runtime.downloadFile('over.bin', { maxBytes: MIB / 2 }))).toMatchObject({ code: 'object_too_large' });
  });

  it('stops a stream that does not announce its size at the bound, whichever side of the ceiling it is on', async () => {
    const { runtime } = await storeWith(Buffer.alloc(3 * MIB, 'a'), { noContentLength: true });

    expect(await failureOf(() => runtime.downloadFile('big.bin', { maxBytes: 2 * MIB }))).toMatchObject({ code: 'object_too_large' });
    expect((await runtime.downloadFile('big.bin', { maxBytes: 4 * MIB })).data.length).toBe(3 * MIB);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -5],
    ['NaN', Number.NaN],
    ['text', '4194304'],
  ])('ignores a bound that is %s: the ceiling applies', async (_label, maxBytes) => {
    const { runtime } = await storeWith(Buffer.alloc(2 * MIB, 'a'));

    const error = await failureOf(() => runtime.downloadFile('big.bin', { maxBytes } as never));

    expect(error).toMatchObject({ code: 'object_too_large' });
    expect(error.message).toBe('The object is larger than the 1 MB this server reads into memory at once.');
  });
});

describe('a body that is not a stream', () => {
  // Bodies a client library may hand over already read, or only readable whole; the ceiling holds for each.
  const bodies: Array<[string, (size: number) => unknown]> = [
    ['a Buffer', (size) => Buffer.alloc(size, 'a')],
    ['a Uint8Array', (size) => new Uint8Array(size).fill(97)],
    ['a string', (size) => 'a'.repeat(size)],
    ['a body with transformToByteArray', (size) => ({ transformToByteArray: async () => new Uint8Array(size).fill(97) })],
    ['a body with arrayBuffer', (size) => ({ arrayBuffer: async () => new ArrayBuffer(size) })],
  ];

  it.each(bodies)('refuses %s that is over the ceiling', async (_name, make) => {
    const { runtime } = await storeWith(Buffer.from('x'));
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ Body: make(MIB + 1) } as never);

    const error = await failureOf(() => runtime.downloadFile('big.bin'));

    expect(error).toMatchObject({ code: 'object_too_large', retryable: false });
  });

  it.each(bodies)('reads %s that is exactly the ceiling', async (_name, make) => {
    const { runtime } = await storeWith(Buffer.from('x'));
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ Body: make(MIB) } as never);

    const result = await runtime.downloadFile('big.bin');

    expect(result.data.length).toBe(MIB);
  });
});
