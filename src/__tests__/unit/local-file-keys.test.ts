/**
 * The built-in disk provider and the keys it is given:
 *
 *  - a key it cannot store (empty, text with no UTF-8 form, a name longer than the file system takes) is refused with
 *    the same typed, non-retryable error the other drivers throw, so it is the caller's 400 and no sign of an outage;
 *  - a name the console generates for a very long file name is one the file system takes, with its sidecar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalFileProviderContract } from '@/lib/providers/contracts/localFile.contract';
import { isStorageInvalidKeyError, StorageInvalidKeyError } from '@/lib/providers/contracts/storageLimits';
import type { FileProviderRuntime } from '@/lib/providers';
import { generateFileRelativeKey, isTransientStorageError } from '@/lib/services/files/fileService';
import { describeFailure, isCuratedStorageError, isInvalidKeyError } from '@/lib/services/files/errors';

let dir: string;
let runtime: FileProviderRuntime;

const TENANT = 'tenant-1';
const PROVIDER = 'disk';
const data = Buffer.from('content');
const upload = (key: string) => runtime.uploadFile({ key, name: 'f.txt', data });
const filesUnder = () => readdirSync(path.join(dir, TENANT, PROVIDER), { recursive: true }).map(String).sort();

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'local-keys-'));
  runtime = await LocalFileProviderContract.createRuntime({
    tenantId: TENANT,
    providerKey: PROVIDER,
    credentials: {},
    settings: { basePath: dir },
  } as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a key the disk provider refuses', () => {
  it.each([
    ['an empty key', ''],
    ['a key of slashes', '///'],
    ['a key of backslashes', '\\\\'],
  ])('refuses %s with the typed error', async (_label, key) => {
    const error = await upload(key).then(() => null, (reason: unknown) => reason);
    expect(isStorageInvalidKeyError(error)).toBe(true);
    expect(error).toBeInstanceOf(StorageInvalidKeyError);
    expect(error).toMatchObject({ code: 'invalid_key', statusCode: 400, retryable: false, message: 'Invalid file key provided.' });
    expect(filesUnder()).toEqual([]);
  });

  it('refuses a key with an unpaired surrogate on every call, instead of storing it under a name of U+FFFD', async () => {
    const key = 'docs/a\ud800b.txt';
    const expected = { code: 'invalid_key', statusCode: 400, retryable: false, message: /^Invalid file key provided: it holds a character that has no UTF-8 form/ };
    await expect(upload(key)).rejects.toMatchObject(expected);
    await expect(runtime.downloadFile(key)).rejects.toMatchObject(expected);
    await expect(runtime.deleteFile(key)).rejects.toMatchObject(expected);
    await expect(runtime.getFileMetadata(key)).rejects.toMatchObject(expected);
    await expect(runtime.listFiles({ prefix: key })).rejects.toMatchObject(expected);
    expect(filesUnder()).toEqual([]);
  });

  it('stores two keys that differ only in a surrogate pair as two files', async () => {
    await upload('emoji-😀.txt');
    await upload('emoji-😁.txt');
    expect(filesUnder().filter((name) => !name.endsWith('.meta.json'))).toHaveLength(2);
  });

  it('refuses a name longer than the file system takes (400 for the caller), and leaves nothing behind', async () => {
    const error = await upload(`folder/${'n'.repeat(300)}.txt`).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(StorageInvalidKeyError);
    expect(error).toMatchObject({ code: 'invalid_key', statusCode: 400, retryable: false });
    expect((error as Error).message).toMatch(/^Invalid file key provided: a part of the name is longer than the file system allows/);
    expect(filesUnder().filter((name) => !name.endsWith('folder'))).toEqual([]);
  });

  it('refuses a name that fits but whose sidecar does not, and removes the file it had written', async () => {
    // 250 bytes is a name; the `.meta.json` beside it makes 260.
    const key = `${'m'.repeat(246)}.txt`;
    await expect(upload(key)).rejects.toBeInstanceOf(StorageInvalidKeyError);
    expect(filesUnder()).toEqual([]);
  });

  it('is a refusal of the caller, not a failure of the disk: it is worded for people and does not trip the breaker', async () => {
    const error = await upload('').then(() => null, (reason: unknown) => reason);
    expect(isInvalidKeyError(error)).toBe(true);
    expect(isCuratedStorageError(error)).toBe(true);
    expect(isTransientStorageError(error)).toBe(false);
    expect(describeFailure(error)).toBe('Invalid file key provided.');
  });
});

describe('a listing prefix', () => {
  const keysOf = async (prefix: string) => (await runtime.listFiles({ prefix })).items.map((item) => item.key).filter((key) => !key.endsWith('.meta.json'));

  it('names a folder: its files at any depth, and nothing for a name that is not a folder', async () => {
    for (const key of ['dir/a.txt', 'dir/deep/b.txt', 'dir-other/c.txt', 'dirx.txt']) await upload(key);

    expect(await keysOf('dir')).toEqual(['dir/a.txt', 'dir/deep/b.txt']);
    expect(await keysOf('dir/')).toEqual(['dir/a.txt', 'dir/deep/b.txt']);
    expect(await keysOf('di')).toEqual([]);
  });
});

describe('a name the console generates for a long file name', () => {
  it('is stored, with its sidecar, and read back', async () => {
    const key = generateFileRelativeKey(`${'q'.repeat(250)}.pdf`);
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(200);

    const { handle } = await upload(key);
    expect(handle.key).toBe(key);
    expect((await runtime.downloadFile(key)).data.toString()).toBe('content');
  });

  it('is stored when the extension is long and not ASCII', async () => {
    const key = generateFileRelativeKey(`report.${'日'.repeat(60)}`);
    const { handle } = await upload(`folder/${key}`);
    expect(handle.key).toBe(`folder/${key}`);
    expect((await runtime.downloadFile(`folder/${key}`)).data.toString()).toBe('content');
  });
});
